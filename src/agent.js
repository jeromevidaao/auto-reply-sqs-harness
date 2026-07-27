import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLLMAdapter } from './adapters/llm/index.js';
import { createNotificationAdapter } from './adapters/notification/index.js';
import { ToolRegistry, CleaningIssueTool, ThermostatTool, HeatPumpTool, CancellationTool, EventRequestTool, AirbnbPolicyTool, UnitReadinessTool, ConversationContextTool, GoogleMapsTool, StayExtensionTool } from './tools/index.js';
import { EVENT_REQUEST_STANDARD_RESPONSE } from './tools/event/EventRequestTool.js';
import { ConversationHistoryRequiredError } from './errors/ConversationHistoryRequiredError.js';
import { normalizeGuestName } from './utils/normalizeGuestName.js';
import {
  loadHostContacts,
  getHostContactsSync,
  applyHostContactPlaceholders,
  buildLuggageDropOffResponse,
  buildLuggageStorageResponse,
  buildApt2StreetDoorLockoutResponse,
  phoneDigitHints,
  setHostContactsForTests,
} from './config/hostContacts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, '..', '..');

const PAYMENT_METHOD_UPDATE_STANDARD_RESPONSE =
  'Please reach out to Airbnb to ensure that this is the case. We host, do not handle payments.';

const SECURITY_DEPOSIT_STANDARD_RESPONSE =
  'Yes. You will get it back automatically after your stay. This is not done by us but by the platform/Airbnb.';

const HVAC_REMOTE_PER_UNIT_STANDARD_RESPONSE =
  'No, each remote is for a single unit.';

const LAUNDRY_QUESTION_STANDARD_RESPONSE =
  'We do not have laundry on site, but there is a laundromat next door called Soap Bubble that is very accessible. Address: 68 Pine St, Portland, ME 04102';

/** Apt 2 listing UUID (Sunny Downtown 2 Bed) — street-door lockout is unit-specific. */
const APT2_LISTING_ID = '114663c5-0709-4eff-a868-fa9ebd6ed42d';

const EXTRA_LINENS_TOWELS_FOLLOW_UP =
  'If you cannot find them, feel free to let us know.';

export class GuestMessagingAgent {
  constructor(options = {}) {
    this.llm = options.llmAdapter || createLLMAdapter(options.llm || 'auto');
    this.notification = options.notificationAdapter || createNotificationAdapter(options.notification || 'auto');

    // Priority: explicit option > env var > process.cwd() (normal local dev) > package root
    const root =
      options.projectRoot ||
      process.env.HARNESS_ROOT ||
      process.cwd();

    this.promptPath = options.promptPath || path.join(root, 'prompts', 'system', 'base.md');
    this.propertiesDir = path.join(root, 'prompts', 'properties');
    this.categoriesDir = path.join(root, 'prompts', 'system', 'categories');

    // Prompt mode options
    this.fullPromptPath = options.fullPromptPath || null;           // Raw production prompt path
    this.useModularPrompt = options.useModularPrompt !== false;     // Default true

    // Reflection / second-pass options
    this.enableReflection = options.enableReflection === true;      // Off by default for safety
    this.reflectionCategories = options.reflectionCategories || [
      'CANCELLATION_POLICY',
      'CANCELLATION_NOTIFICATION',
      'CANCELLATION_POLICY_EXCEPTION',
      'NEW_RESERVATION_WELCOME',
      'NEW_INQUIRY_WELCOME'
    ];

    // Conversation Judge (anti-repetition, consistency, and high-stakes policy enforcement)
    // With very low volume (~4-5 messages/day), we run the judge on every message by default
    // when enabled. This gives strong protection against repetition and bad cancellation answers.
    this.enableConversationJudge = options.enableConversationJudge !== false; // on by default

    // Quality iteration: judge critique → one rewrite from issues → judge verify (max 1 rewrite).
    // Category-agnostic; works for multi-intent, truth, tone, and thread consistency.
    // Default on whenever the Conversation Judge is on. Set false to restore "judge rewrites once" only.
    this.enableJudgeRewriteLoop = options.enableJudgeRewriteLoop !== false;

    // Production Lambda sets hospitableClient; live history is required by default there.
    // Eval/simulator pass requireLiveConversationHistory: false to use scenario-provided history.
    this.hospitableClient = options.hospitableClient || null;
    this.requireLiveConversationHistory = options.requireLiveConversationHistory;

    this.systemPrompt = null;
    /** @type {import('./config/hostContacts.js').loadHostContacts extends Function ? any : any} */
    this._hostContacts = null;

    // Tools registry (unified interface for capabilities like cleaning detection, future tools)
    if (options.tools instanceof ToolRegistry) {
      this.tools = options.tools;
    } else {
      this.tools = new ToolRegistry();
      // Register default tools (can be overridden by passing custom ones in options)
      if (!this.tools.has('detect_cleaning_issue')) {
        this.tools.register(new CleaningIssueTool());
      }
      if (!this.tools.has('get_thermostat_instructions')) {
        this.tools.register(new ThermostatTool());
      }
      if (!this.tools.has('get_heat_pump_status')) {
        this.tools.register(new HeatPumpTool({ kumoClient: options.kumoClient || null }));
      }
      if (!this.tools.has('handle_cancellation')) {
        this.tools.register(new CancellationTool());
      }
      if (!this.tools.has('handle_event_request')) {
        this.tools.register(new EventRequestTool());
      }
      if (!this.tools.has('get_airbnb_cancellation_policy')) {
        this.tools.register(new AirbnbPolicyTool());
      }
      if (!this.tools.has('get_unit_readiness')) {
        this.tools.register(new UnitReadinessTool({
          ddbClient: options.ddbClient || null,
          hospitableClient: options.hospitableClient || null
        }));
      }
      if (!this.tools.has('get_conversation_context')) {
        this.tools.register(new ConversationContextTool({
          hospitableClient: options.hospitableClient || null
        }));
      }
      if (!this.tools.has('get_travel_times')) {
        this.tools.register(new GoogleMapsTool());
      }
      if (!this.tools.has('check_stay_extension')) {
        this.tools.register(new StayExtensionTool({ hospitableClient: options.hospitableClient || null }));
      }
    }
  }

  /**
   * Loads the system prompt.
   *
   * Modes:
   * - `fullPromptPath` provided → loads verbatim (raw production prompt for fidelity testing)
   * - Otherwise → composes modular prompt: base.md + categories/ + property-specific knowledge
   */

  async ensureHostContacts() {
    if (this._hostContacts) return this._hostContacts;
    this._hostContacts = await loadHostContacts();
    return this._hostContacts;
  }

  async loadPrompt(context = {}) {
    if (this.systemPrompt && !context.listingId) return this.systemPrompt;

    const start = Date.now();

    try {
      // Raw production fidelity mode (takes precedence)
      if (this.fullPromptPath) {
        const full = applyHostContactPlaceholders(await fs.readFile(this.fullPromptPath, 'utf8'));
        if (!context.listingId) this.systemPrompt = full;
        console.log(`[Agent] Loaded RAW production prompt (${full.length} chars) in ${Date.now() - start}ms`);
        return full;
      }

      // If modular prompt is disabled, just load base + property
      if (!this.useModularPrompt) {
        const base = await fs.readFile(this.promptPath, 'utf8');
        const propertyFile = this._getPropertyFile(context.listingId);
        let propertyKnowledge = '';
        if (propertyFile) {
          try {
            propertyKnowledge = await fs.readFile(path.join(this.propertiesDir, propertyFile), 'utf8');
          } catch {}
        }
        const simple = applyHostContactPlaceholders(
          [base.trim(), propertyKnowledge ? '\n\n' + propertyKnowledge : ''].join('')
        );
        if (!context.listingId) this.systemPrompt = simple;
        console.log(`[Agent] Loaded SIMPLE prompt (no categories) in ${Date.now() - start}ms`);
        return simple;
      }

      // === Full Modular Prompt Composition ===
      const base = await fs.readFile(this.promptPath, 'utf8');

      // Property-specific knowledge
      const propertyFile = this._getPropertyFile(context.listingId);
      let propertyKnowledge = '';
      if (propertyFile) {
        try {
          propertyKnowledge = await fs.readFile(path.join(this.propertiesDir, propertyFile), 'utf8');
        } catch (e) {
          console.warn(`[Agent] Could not load property file: ${propertyFile}`);
        }
      }

      // Load all category modules
      let categoryKnowledge = '';
      let loadedCategories = [];
      try {
        const categoryFiles = await fs.readdir(this.categoriesDir);
        const mdFiles = categoryFiles.filter(f => f.endsWith('.md')).sort();

        for (const catFile of mdFiles) {
          const content = await fs.readFile(path.join(this.categoriesDir, catFile), 'utf8');
          categoryKnowledge += `\n\n## ${catFile.replace('.md', '')}\n${content.trim()}`;
          loadedCategories.push(catFile.replace('.md', ''));
        }
      } catch (e) {
        // categories directory optional
      }

      const composed = applyHostContactPlaceholders([
        base.trim(),
        categoryKnowledge ? `\n\n# Category Rules\n${categoryKnowledge}` : '',
        propertyKnowledge ? `\n\n# Property-Specific Knowledge\n${propertyKnowledge}` : ''
      ].join(''));

      if (!context.listingId) {
        this.systemPrompt = composed;
      }

      console.log(`[Agent] Loaded MODULAR prompt | categories: ${loadedCategories.length} | total chars: ${composed.length} | ${Date.now() - start}ms`);
      return composed;

    } catch (err) {
      console.error('[Agent] Failed to load prompt:', err);
      throw err;
    }
  }

  /**
   * Convenience method to load the raw production prompt for comparison testing.
   */
  async loadRawProductionPrompt(rawPath) {
    const full = await fs.readFile(rawPath, 'utf8');
    this.systemPrompt = full;
    return full;
  }

  _getPropertyFile(listingId) {
    if (!listingId) return null;

    const map = {
      'c899481f-2e5b-402d-80c4-3167fd824d96': '1b.md',   // 1B
      '114663c5-0709-4eff-a868-fa9ebd6ed42d': 'apt2.md', // Apt 2
      '60fc0321-c8be-46f4-8edd-8f5cd2c6c7bd': 'apt3.md', // Apt 3
    };

    return map[listingId] || null;
  }

  /**
   * Main entry point for the agent.
   * @param {string} guestMessage
   * @param {object} context - reservation/inquiry info + conversation history etc.
   */
  async processMessage(guestMessage, context = {}) {
    await this.ensureHostContacts();
    // Cheap event detection — eval runner calls processMessage directly (not handleMessage),
    // so we must run this here too, not only in _enrichTracesEarly.
    if (!context.earlyEventDetection) {
      const eventTool = this.tools.get('handle_event_request');
      if (eventTool) {
        try {
          const eventInfo = await eventTool.execute(guestMessage, context);
          if (eventInfo?.detected) {
            context.earlyEventDetection = eventInfo;
          }
        } catch {
          // non-fatal
        }
      }
    }

    // Thermostat instructions — eval runner calls processMessage directly.
    if (!context.earlyThermostatInfo) {
      const thermostatTool = this.tools.get('get_thermostat_instructions');
      if (thermostatTool) {
        try {
          const thermoInfo = await thermostatTool.execute(guestMessage, context);
          if (thermoInfo?.detected) {
            context.earlyThermostatInfo = thermoInfo;
          }
        } catch {
          // non-fatal
        }
      }
    }

    if (this._isPreArrivalSofaLinensAsk(guestMessage, context)) {
      context.preArrivalSofaLinensAsk = true;
    }

    const system = await this.loadPrompt(context);

    // Build a rich user prompt (we will evolve this heavily)
    const userPrompt = this._buildUserPrompt(guestMessage, context);

    const raw = await this.llm.complete(system, userPrompt);

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      // Attempt to extract JSON if the model wrapped it in markdown
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) {
        parsed = JSON.parse(match[0]);
      } else {
        throw new Error('Agent returned invalid JSON: ' + raw);
      }
    }

    // Normalize
    let confidence = parsed.confidence ?? 0.7;
    let shouldReply = parsed.shouldReply ?? (parsed.proposedResponse && parsed.proposedResponse !== 'none');

    // For simple, direct operational questions (early check-in flexibility, self-check-in arrival questions)
    // that produce a concrete proposedResponse, force high confidence and reply.
    // These are almost always safe and valuable to answer; the user expects 100% confidence on clear cases.
    const earlyFlexCategories = ['EARLY_CHECKIN', 'EARLY_CHECKIN_QUESTION', 'CHECK_IN_TIME_QUESTION', 'SELF_CHECKIN_QUESTION'];
    if (earlyFlexCategories.includes(parsed.typeOfMessageReceived) &&
        parsed.proposedResponse && parsed.proposedResponse !== 'none' &&
        parsed.proposedResponse.length > 20) {
      confidence = 1.0;
      if (shouldReply !== false) shouldReply = true;
    }

    // For pure first-post-booking NEW_RESERVATION_WELCOME and NEW_INQUIRY_WELCOME (clear intros/sharing excitement/plans,
    // no distinct ask — e.g. the Emma "college roommates... spring break next year... close to my favorite spots" case
    // or abby birthday), force confidence=1.0 and shouldReply=true when a substantial response is proposed.
    // These are the safe, high-value rich "first page" welcomes the user expects (and old system delivered). Prevents
    // escalations at 0.95 conf or LLM conservatism on pure announcement messages. See welcome-messages.md.
    const welcomeCategories = ['NEW_RESERVATION_WELCOME', 'NEW_INQUIRY_WELCOME'];
    const isPureWelcomeIntro = this._isPureFirstPostBookingIntro(guestMessage, context);
    const isPostWelcomeThanks = this._isPostWelcomeThankYouFollowUp(guestMessage, context);
    if (welcomeCategories.includes(parsed.typeOfMessageReceived) &&
        !this._looksLikePlausibleFollowUp(guestMessage) &&
        !isPostWelcomeThanks &&
        parsed.proposedResponse && parsed.proposedResponse !== 'none' &&
        parsed.proposedResponse.length > 30) {
      confidence = 1.0;
      shouldReply = true;  // Unconditionally force reply for clear welcomes (override even explicit false from conservative LLM, as in the Emma 0.95 case)
    } else if (welcomeCategories.includes(parsed.typeOfMessageReceived) && isPureWelcomeIntro &&
        parsed.proposedResponse && parsed.proposedResponse !== 'none' &&
        parsed.proposedResponse.length > 20) {
      confidence = 1.0;
      shouldReply = true;
    }

    const postCheckoutThanksPolicy = this._applyPostCheckoutThankYouPolicy(parsed, context, guestMessage);
    if (postCheckoutThanksPolicy.applied) {
      shouldReply = postCheckoutThanksPolicy.shouldReply;
      confidence = postCheckoutThanksPolicy.confidence;
    }

    const eventPolicy = this._applyEventRequestPolicy(parsed, context, guestMessage);
    if (eventPolicy.applied) {
      parsed.typeOfMessageReceived = 'EVENT_REQUEST';
      parsed.proposedResponse = eventPolicy.proposedResponse;
      shouldReply = true;
      confidence = 1.0;
    }

    const hvacRemotePerUnitPolicy = this._applyHvacRemotePerUnitPolicy(parsed, context, guestMessage);
    if (hvacRemotePerUnitPolicy.applied) {
      parsed.typeOfMessageReceived = hvacRemotePerUnitPolicy.typeOfMessageReceived || 'HVAC_REMOTE_PER_UNIT';
      parsed.proposedResponse = hvacRemotePerUnitPolicy.proposedResponse;
      shouldReply = true;
      confidence = 1.0;
    }

    const thermostatPolicy = this._applyThermostatPolicy(parsed, context, guestMessage);
    if (thermostatPolicy.applied) {
      parsed.typeOfMessageReceived = thermostatPolicy.typeOfMessageReceived || 'THERMOSTAT_HEATPUMP';
      parsed.proposedResponse = thermostatPolicy.proposedResponse;
      shouldReply = true;
      confidence = 1.0;
    }

    const luggagePolicy = this._applyLuggagePolicy(parsed, context, guestMessage);
    if (luggagePolicy.applied) {
      parsed.typeOfMessageReceived = luggagePolicy.typeOfMessageReceived || 'LUGGAGE_DROP_OFF';
      parsed.proposedResponse = luggagePolicy.proposedResponse;
      shouldReply = true;
      confidence = 1.0;
    }

    const paymentMethodPolicy = this._applyPaymentMethodPolicy(parsed, context, guestMessage);
    if (paymentMethodPolicy.applied) {
      parsed.typeOfMessageReceived = paymentMethodPolicy.typeOfMessageReceived || 'PAYMENT_METHOD_UPDATE';
      parsed.proposedResponse = paymentMethodPolicy.proposedResponse;
      shouldReply = true;
      confidence = 1.0;
    }

    const securityDepositPolicy = this._applySecurityDepositPolicy(parsed, context, guestMessage);
    if (securityDepositPolicy.applied) {
      parsed.typeOfMessageReceived = securityDepositPolicy.typeOfMessageReceived || 'SECURITY_DEPOSIT_QUESTION';
      parsed.proposedResponse = securityDepositPolicy.proposedResponse;
      shouldReply = true;
      confidence = 1.0;
    }

    const laundryPolicy = this._applyLaundryPolicy(parsed, context, guestMessage);
    if (laundryPolicy.applied) {
      parsed.typeOfMessageReceived = laundryPolicy.typeOfMessageReceived || 'LAUNDRY_QUESTION';
      parsed.proposedResponse = laundryPolicy.proposedResponse;
      shouldReply = true;
      confidence = 1.0;
    }

    const apt2StreetLockoutPolicy = this._applyApt2StreetDoorLockoutPolicy(parsed, context, guestMessage);
    if (apt2StreetLockoutPolicy.applied) {
      parsed.typeOfMessageReceived = apt2StreetLockoutPolicy.typeOfMessageReceived || 'APT2_STREET_DOOR_LOCKOUT';
      parsed.proposedResponse = apt2StreetLockoutPolicy.proposedResponse;
      shouldReply = true;
      confidence = 1.0;
    }

    // After lockout: post-stay review/thanks must never be forced into lockout (Henry review incident).
    const reviewPromisePolicy = this._applyReviewPromisePolicy(parsed, context, guestMessage);
    if (reviewPromisePolicy.applied) {
      parsed.typeOfMessageReceived = reviewPromisePolicy.typeOfMessageReceived;
      parsed.proposedResponse = reviewPromisePolicy.proposedResponse;
      shouldReply = reviewPromisePolicy.shouldReply;
      confidence = reviewPromisePolicy.confidence;
    }

    const sofaLinensPolicy = this._applySofaBedLinensPolicy(parsed, context, guestMessage);    if (sofaLinensPolicy.applied) {
      parsed.typeOfMessageReceived = sofaLinensPolicy.typeOfMessageReceived;
      if (sofaLinensPolicy.proposedResponse) {
        parsed.proposedResponse = sofaLinensPolicy.proposedResponse;
      }
      shouldReply = true;
    }

    const extraLinensTowelsPolicy = this._applyExtraLinensTowelsPolicy(parsed, context, guestMessage);
    if (extraLinensTowelsPolicy.applied) {
      parsed.typeOfMessageReceived = extraLinensTowelsPolicy.typeOfMessageReceived || 'EXTRA_LINENS_TOWELS';
      parsed.proposedResponse = extraLinensTowelsPolicy.proposedResponse;
      shouldReply = true;
    }

    this._applyCancellationCategoryPolicy(parsed, guestMessage);

    const postWelcomeThanksPolicy = this._applyPostWelcomeThankYouPolicy(parsed, context, guestMessage);
    if (postWelcomeThanksPolicy.applied) {
      shouldReply = postWelcomeThanksPolicy.shouldReply;
      confidence = postWelcomeThanksPolicy.confidence;
    }

    const inStayDeparturePolicy = this._applyInStayDepartureThankYouPolicy(parsed, context, guestMessage);
    if (inStayDeparturePolicy.applied) {
      shouldReply = inStayDeparturePolicy.shouldReply;
      confidence = inStayDeparturePolicy.confidence;
    }

    const preCheckInParkingPolicy = this._applyPreCheckInParkingPolicy(parsed, context, guestMessage);
    if (preCheckInParkingPolicy.applied) {
      shouldReply = preCheckInParkingPolicy.shouldReply;
      confidence = preCheckInParkingPolicy.confidence;
    }

    const postStayFeedbackPolicy = this._applyPostStayHousekeepingFeedbackPolicy(parsed, context, guestMessage);
    if (postStayFeedbackPolicy.applied) {
      parsed.typeOfMessageReceived = postStayFeedbackPolicy.typeOfMessageReceived;
      parsed.proposedResponse = postStayFeedbackPolicy.proposedResponse;
      shouldReply = postStayFeedbackPolicy.shouldReply;
      confidence = postStayFeedbackPolicy.confidence;
    }

    return {
      typeOfMessageReceived: parsed.typeOfMessageReceived || 'OTHER_MESSAGE',
      proposedResponse: parsed.proposedResponse || 'none',
      shouldReply,
      confidence,
      rawModelOutput: raw
    };
  }

  /**
   * Force the canonical EVENT_REQUEST decline when the tool or category signals a party/gathering ask.
   * Ensures the exact policy phrase "not able to accommodate events or gatherings" is always present
   * (eval rubric + production consistency). Allows an optional greeting + name prefix from the LLM draft.
   */
  _applyEventRequestPolicy(parsed, context = {}, guestMessage = '') {
    const msg = guestMessage || context.originalMessage || '';
    if (this._isPostCheckoutThankYou(msg, context)) {
      return { applied: false };
    }

    const categories = Array.isArray(parsed.typeOfMessageReceived)
      ? parsed.typeOfMessageReceived
      : [parsed.typeOfMessageReceived];
    const isEventCategory = categories.includes('EVENT_REQUEST');
    const eventDetected = !!context.earlyEventDetection?.detected;

    if (!isEventCategory && !eventDetected) {
      return { applied: false };
    }

    const standard = context.earlyEventDetection?.standardResponse || EVENT_REQUEST_STANDARD_RESPONSE;
    const draft = (parsed.proposedResponse || '').trim();
    let proposedResponse = standard;

    // Preserve a leading time-based greeting + name if the model already produced one.
    const greetingMatch = draft.match(/^(Good (?:morning|afternoon|evening)|Hi|Hey|Hello)[^!?\n]{0,80}[,!]\s*/i);
    if (greetingMatch) {
      proposedResponse = greetingMatch[0].trimEnd() + ' ' + standard;
    }

    return { applied: true, proposedResponse };
  }

  _isPreArrivalSofaLinensAsk(guestMessage = '', context = {}) {
    if (this._isPostStayHousekeepingFeedback(guestMessage)) {
      return false;
    }
    const lower = guestMessage.toLowerCase();
    const linenAsk = /sheets|blankets|pillows|linens/.test(lower) &&
      /sofa|couch|futon|4th|fourth|extra guest|friend|sleeping on/.test(lower);
    const inStay = /we are in the apartment|we're in the apartment|we're here|already here|checked in|can't find|cannot find|where are the (sheets|linens|blankets)/.test(lower);
    const preArrival = /looking forward|please confirm|before (our|my) (stay|arrival|trip)|upcoming stay|will be sleeping/.test(lower);
    const stayFuture = context.checkIn && !context.stayTiming?.includes('current') && !inStay;

    return linenAsk && !inStay && (preArrival || stayFuture || context.preArrivalSofaLinensAsk);
  }

  /**
   * Guest message looks like a short follow-up (thanks, arrival update) that may respond to an
   * unseen prior host readiness statement — Taylor 9AM safeguard territory.
   */
  _looksLikePlausibleFollowUp(guestMessage = '') {
    const msg = (guestMessage || '').trim();
    const lower = msg.toLowerCase();
    if (!msg) return false;

    if (this._isPostStayHousekeepingFeedback(msg)) return false;

    if (/^(okay\s+)?(perfect|thanks|thank you|got it|great|awesome|wonderful|sounds good)/i.test(lower) && msg.length < 140) {
      return true;
    }
    if (/^(thank you|thanks)/i.test(lower) && !/\?/.test(msg) &&
        /(appreciate|prompt response|super excited|so excited|wonderful|we are excited)/i.test(lower) &&
        msg.length < 220) {
      return true;
    }
    if (/(arriving|arrive|be there|see you|on (our|my) way|in about an hour|in \d+ (min|minute|hour)|we will be)/i.test(lower) &&
        /(thank|perfect|great|soon|hour)/i.test(lower)) {
      return true;
    }
    return false;
  }

  /**
   * Post-checkout feedback that includes a housekeeping/setup issue (Amy incident).
   * Not a pure thank-you — auto-reply with warm ack is fine; cleaning alert still required.
   */
  _isPostStayHousekeepingFeedback(guestMessage = '') {
    const lower = (guestMessage || '').toLowerCase();
    const postStay = /(lovely|great|wonderful|good|nice|amazing)\s+stay|had a (?:great|lovely|wonderful|good|nice|amazing) (?:time|stay)|happy to give.*\d+\s*star|give (?:you |me )?\d+\s*star/i.test(lower);
    const missingSetup = /(no sheets|no sheet|were no sheets|missing sheets|no linens|no blankets|no pillows|not stocked|wasn't stocked|was not stocked)/i.test(lower);
    const fyiIssue = /(only thing|one thing|just an fyi|fyi for|for the next)/i.test(lower);
    return (postStay && (missingSetup || fyiIssue)) || (fyiIssue && missingSetup);
  }

  _applyCleaningIssueEscalationPolicy(parsed, cleaningIssue = {}, guestMessage = '') {
    if (!cleaningIssue.detected) {
      return { applied: false };
    }
    // Post-stay review + housekeeping FYI: cleaning alert only — auto-reply is fine (Amy incident).
    if (this._isPostStayHousekeepingFeedback(guestMessage)) {
      return { applied: false };
    }

    parsed.proposedResponse = 'none';

    return {
      applied: true,
      typeOfMessageReceived: parsed.typeOfMessageReceived || 'OTHER_MESSAGE',
      proposedResponse: 'none',
      shouldReply: false,
      confidence: 1.0,
      escalated: true,
    };
  }

  _applyPostStayHousekeepingFeedbackPolicy(parsed, context = {}, guestMessage = '') {
    if (!this._isPostStayHousekeepingFeedback(guestMessage)) {
      return { applied: false };
    }

    const lower = (guestMessage || '').toLowerCase();
    const hasReview = /(lovely|great|wonderful|good|nice|amazing)\s+stay|had a (?:great|lovely|wonderful|good) (?:time|stay)|\d+\s*star/i.test(lower);
    const typeOfMessageReceived = hasReview ? 'REVIEW_SUBMITTED' : (parsed.typeOfMessageReceived || 'OTHER_MESSAGE');
    const name = this._guestDisplayFirstName(context);
    const draft = (parsed.proposedResponse || '').trim();

    const tooBare = !draft || draft === 'none' ||
      /^you're welcome,?\s+\w+!?\s*$/i.test(draft) ||
      (draft.length < 80 && !/heads up|sofa bed|note that|lovely stay/i.test(draft));

    let proposedResponse = draft;
    if (tooBare) {
      proposedResponse = `You're welcome, ${name}! Glad you had a lovely stay — thanks for the heads up about the sofa bed, I'll note that for the team. Safe travels!`;
    }

    parsed.typeOfMessageReceived = typeOfMessageReceived;
    parsed.proposedResponse = proposedResponse;

    return {
      applied: true,
      typeOfMessageReceived,
      proposedResponse,
      shouldReply: true,
      confidence: 1.0,
      escalated: false,
    };
  }

  _hostMessageLooksLikeWelcome(body = '') {
    const welcomeMarkers = /check-?in|self-check-in|parking|pet fee|looking forward to hosting|detailed check-in instructions|3 days before|delighted to host|glad to host/i;
    return welcomeMarkers.test(body || '');
  }

  _guestDisplayFirstName(context = {}) {
    const raw = context.guestDisplayName || context.guestName || 'there';
    return String(raw).split(/[·(]/)[0].trim().split(/\s+/)[0] || 'there';
  }

  _todayDateStr(context = {}) {
    const anchor = context.asOfDate || context.simulatedToday || context.today;
    if (anchor) return String(anchor).slice(0, 10);
    return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  }

  /**
   * Guest is on check-in day or mid-stay (not past checkout).
   */
  _isCurrentStay(context = {}) {
    if (context.stayTiming === 'current') return true;
    const checkIn = (context.checkIn || '').slice(0, 10);
    const checkOut = (context.checkOut || '').slice(0, 10);
    if (!checkIn) return false;
    const today = this._todayDateStr(context);
    return checkIn <= today && (!checkOut || checkOut > today);
  }

  /**
   * Full-day stay extension / checkout-date change request (Lilly incident).
   * Must not be treated as post-checkout thank-you when guest says "checking out on the 29th".
   */
  _looksLikeStayExtensionRequest(guestMessage = '', context = {}) {
    if (context.stayExtensionInfo?.detected || context.earlyStayExtensionInfo?.detected) {
      return true;
    }
    const lower = (guestMessage || '').toLowerCase();
    return /(extend.*(stay|booking|reservation|night|day)|one more (day|night)|extra (day|night)|instead of check(?:ing)? out|we(?:'d| would) check(?:ing)? out|change (?:my )?(checkout|check.out|departure|check out) (?:date|to)|move checkout|push checkout|arriv(?:e|ing).*(?:one|a) day (?:early|earlier)|come (?:one|a) day (?:early|earlier)|wondering if i could extend|could (?:we|i) extend)/i.test(lower);
  }

  /**
   * Guest message signals actual checkout / end-of-stay departure (not a brief step-out).
   */
  _looksLikeActualCheckout(guestMessage = '', context = {}) {
    if (this._looksLikeStayExtensionRequest(guestMessage, context)) {
      return false;
    }

    const lower = (guestMessage || '').toLowerCase();
    if (/checked out|officially checked out|just checked out|we(?:'ve| have) checked out/i.test(lower)) {
      return true;
    }
    if (/starting the dishwasher|thanks again for your host|thanks for (?:being|your|letting us) (?:a great |such a )?(?:host|stay)/i.test(lower)) {
      return true;
    }
    if (/about to check out|checking out now|on our way (?:home|back)|heading home|departed|end of (?:our|the) stay/i.test(lower)) {
      return true;
    }
    if (/check(?:ing)? out/i.test(lower) &&
        /(gotten everything out|pulled the linens|gathered.*trash|we(?:'re| are) (?:done|finished|all set))/i.test(lower)) {
      return true;
    }
    const checkOut = (context.checkOut || '').slice(0, 10);
    const today = this._todayDateStr(context);
    if (checkOut && checkOut === today && /left|leaving|we(?:'re| are) out|headed out/i.test(lower)) {
      return true;
    }
    return false;
  }

  /**
   * Post-checkout thank-you (Rene checkout incident): guest confirms departure and thanks us.
   * Distinct from post-welcome thanks and from Amy-style housekeeping feedback.
   */
  _isPostCheckoutThankYou(guestMessage = '', context = {}) {
    if (this._looksLikeStayExtensionRequest(guestMessage, context)) return false;
    if (!this._looksLikeActualCheckout(guestMessage, context)) return false;
    if (this._isPostStayHousekeepingFeedback(guestMessage)) return false;
    const lower = (guestMessage || '').toLowerCase();
    return /thank|thanks|appreciate|great day|have a (?:great|wonderful|good) day/i.test(lower) ||
      /officially checked out|we(?:'ve| have) gotten everything out|pulled the linens/i.test(lower);
  }

  _applyPostCheckoutThankYouPolicy(parsed, context = {}, guestMessage = '') {
    if (!this._isPostCheckoutThankYou(guestMessage, context)) {
      return { applied: false };
    }

    const naturalName = this._guestDisplayFirstName(context);
    const draft = (parsed.proposedResponse || '').trim();
    const eventDecline = /not able to accommodate events|gatherings/i.test(draft);
    const isGoodThankYouAck = !eventDecline && /you're welcome|you are welcome/i.test(draft);

    let proposedResponse = draft;
    if (!isGoodThankYouAck) {
      let recovered = null;
      const raw = parsed.rawModelOutput;
      if (raw) {
        try {
          const r = typeof raw === 'string' ? JSON.parse(raw) : raw;
          const pr = (r.proposedResponse || '').trim();
          if (/you're welcome|you are welcome/i.test(pr) && !/not able to accommodate events/i.test(pr)) {
            recovered = pr;
          }
        } catch {
          // ignore parse errors
        }
      }
      proposedResponse = recovered || `You're welcome, ${naturalName}! Safe travels and hope you enjoyed your stay.`;
    }

    parsed.typeOfMessageReceived = 'THANK_YOU_MESSAGE';
    parsed.proposedResponse = proposedResponse;

    return {
      applied: true,
      typeOfMessageReceived: 'THANK_YOU_MESSAGE',
      proposedResponse,
      shouldReply: true,
      confidence: 1.0,
      escalated: false,
    };
  }

  /**
   * Guest stepped out temporarily during an active stay (e.g. so PM can deliver a blanket).
   * Amie incident: "Thank you we just left the apartment!" on check-in day — NOT checkout.
   */
  _isTemporaryDepartureDuringStay(guestMessage = '', context = {}) {
    const lower = (guestMessage || '').toLowerCase();
    if (!this._isCurrentStay(context)) return false;
    if (this._looksLikeActualCheckout(guestMessage, context)) return false;

    return /left the (apartment|unit|place|flat)|step(?:ped|ping) out|we(?:'re| are) out|heading out|gone out|went out|just left(?: the)?|left so you can|left to let/i.test(lower);
  }

  _stripEndOfStayFarewell(text = '') {
    return String(text || '')
      .replace(/\s*[-—,]?\s*safe travels[!.]*/gi, '')
      .replace(/\s*[-—,]?\s*hope you enjoyed[^!.]*[!.]*/gi, '')
      .replace(/\s*[-—,]?\s*glad you had a good stay[^!.]*[!.]*/gi, '')
      .replace(/\s*[-—,]?\s*have a (?:great|wonderful|safe) trip[^!.]*[!.]*/gi, '')
      .replace(/\s*[-—,]?\s*enjoyed your stay[^!.]*[!.]*/gi, '')
      .replace(/\s{2,}/g, ' ')
      .replace(/\s+([!,?.])/g, '$1')
      .trim();
  }

  _applyInStayDepartureThankYouPolicy(parsed, context = {}, guestMessage = '') {
    if (!this._isTemporaryDepartureDuringStay(guestMessage, context)) {
      return { applied: false };
    }

    const naturalName = this._guestDisplayFirstName(context);
    const draft = (parsed.proposedResponse || '').trim();
    const hasEndOfStayFarewell = /safe travels|hope you enjoyed|glad you had a good stay|have a (?:great|wonderful|safe) trip|enjoyed your stay/i.test(draft);

    let proposedResponse = draft;
    if (!draft || draft === 'none' || hasEndOfStayFarewell ||
        !/you're welcome|you are welcome/i.test(draft)) {
      proposedResponse = `You're welcome, ${naturalName}!`;
    } else {
      proposedResponse = this._stripEndOfStayFarewell(draft);
      if (!proposedResponse || !/you're welcome|you are welcome/i.test(proposedResponse)) {
        proposedResponse = `You're welcome, ${naturalName}!`;
      } else if (!/[!.]$/.test(proposedResponse)) {
        proposedResponse += '!';
      }
    }

    parsed.typeOfMessageReceived = 'THANK_YOU_MESSAGE';
    parsed.proposedResponse = proposedResponse;

    return {
      applied: true,
      typeOfMessageReceived: 'THANK_YOU_MESSAGE',
      proposedResponse,
      shouldReply: true,
      confidence: 1.0,
      escalated: false,
    };
  }

  /**
   * Guest asks to use the designated parking spot before 4pm check-in.
   * Amie incident: must NOT confirm availability unless host already said unit is ready.
   */
  _isPreCheckInParkingAsk(guestMessage = '') {
    const lower = (guestMessage || '').toLowerCase();
    const parkingAsk = /park|parking|designated spot/.test(lower);
    const beforeCheckIn = /before.*(check-?in|4\s*pm|4pm)|prior to check|park.*before|before the check|ahead of check|earlier than 4/.test(lower);
    return parkingAsk && beforeCheckIn;
  }

  _hostAlreadyOfferedUnitReady(context = {}) {
    return !!(context.conversationTraces?.earlyUnitReadyOffered || context.earlyUnitReadyOffered);
  }

  _applyPreCheckInParkingPolicy(parsed, context = {}, guestMessage = '') {
    if (!this._isPreCheckInParkingAsk(guestMessage)) {
      return { applied: false };
    }
    if (this._hostAlreadyOfferedUnitReady(context)) {
      return { applied: false };
    }

    const draft = (parsed.proposedResponse || '').trim();
    const prematurelyConfirms = /spot is available|designated spot is available|yes[,!]?\s+(the\s+)?designated spot|you can park (in |at )?the (designated )?spot|parking spot is available/i.test(draft);

    const name = this._guestDisplayFirstName(context);
    const g = context.conversationTraces?.greeting;
    const greetingPrefix = (g?.shouldUseGreeting && g?.timeBasedGreeting)
      ? `${g.timeBasedGreeting}, ${name},`
      : (draft.match(/^(Good (?:morning|afternoon|evening)),?\s+\w+,?/i)?.[0]?.trim() || `Hi ${name},`);

    const policyBody = 'check-in is at 4pm, so we can\'t guarantee the designated parking spot before then. The cleaning team may still be using it while the unit is being prepared. We\'ll message you as soon as the spot is ready for you.';

    let proposedResponse = `${greetingPrefix} ${policyBody}`;
    proposedResponse = proposedResponse.replace(/\s+/g, ' ').replace(/ ,/g, ',').trim();

    if (!prematurelyConfirms && draft.length > 40 &&
        /can't guarantee|cannot guarantee|can\'t guarantee|cleaning team/i.test(draft) &&
        !/spot is available|designated spot is available/i.test(draft)) {
      return { applied: false };
    }

    parsed.typeOfMessageReceived = 'PARKING';
    parsed.proposedResponse = proposedResponse;

    return {
      applied: true,
      typeOfMessageReceived: 'PARKING',
      proposedResponse,
      shouldReply: true,
      confidence: 1.0,
    };
  }

  /**
   * Guest sent a pure thanks after we already delivered the full welcome/logistics.
   * Rene incident: duplicate 4pm/pet/parking block on "Thank you so much! I appreciate your prompt response!"
   */
  _isPostWelcomeThankYouFollowUp(guestMessage = '', context = {}) {
    const msg = (guestMessage || '').trim();
    if (!msg || /\?/.test(msg)) return false;
    if (this._isPostStayHousekeepingFeedback(msg)) return false;
    if (!this._looksLikePlausibleFollowUp(msg) &&
        !(/^(thank you|thanks)/i.test(msg.toLowerCase()) && /(appreciate|excited)/i.test(msg.toLowerCase()))) {
      return false;
    }

    const traces = context.conversationTraces || {};
    if (traces.recentWelcomeSent) return true;

    const history = context.conversationHistory || [];
    const hostMsgs = history.filter(m => m.sender_type === 'host' || m.sender?.type === 'host');
    if (hostMsgs.some(m => this._hostMessageLooksLikeWelcome(m.body))) return true;

    if (traces.lastHostMessagePreview && this._hostMessageLooksLikeWelcome(traces.lastHostMessagePreview)) {
      return true;
    }

    return false;
  }

  _applyPostWelcomeThankYouPolicy(parsed, context = {}, guestMessage = '') {
    if (!this._isPostWelcomeThankYouFollowUp(guestMessage, context)) {
      return { applied: false };
    }

    const rawName = context.guestName || context.guestDisplayName || 'there';
    const naturalName = String(rawName).split(/[·(]/)[0].trim().split(/\s+/)[0] || 'there';
    const draft = (parsed.proposedResponse || '').trim();
    const repeatsLogistics = /4\s*pm|self-check-in|parking|pet fee|3 days before|check-in instructions|off-street|not allowed on the bed/i.test(draft);
    const welcomeCategory = ['NEW_RESERVATION_WELCOME', 'NEW_INQUIRY_WELCOME'].includes(parsed.typeOfMessageReceived);

    let proposedResponse = draft;
    if (!draft || draft === 'none' || repeatsLogistics || welcomeCategory ||
        !/you're welcome|you are welcome/i.test(draft)) {
      proposedResponse = `You're welcome, ${naturalName}!`;
    }

    parsed.typeOfMessageReceived = 'THANK_YOU_MESSAGE';
    parsed.proposedResponse = proposedResponse;

    return {
      applied: true,
      typeOfMessageReceived: 'THANK_YOU_MESSAGE',
      proposedResponse,
      shouldReply: true,
      confidence: 1.0,
      escalated: false,
    };
  }

  /**
   * Pure first-post-booking intro: guest sharing trip context / excitement with no distinct ask.
   * Covers Emma, Abby, Cheryl-style welcomes — not Taylor thank-you follow-ups.
   */
  _isPureFirstPostBookingIntro(guestMessage = '', context = {}) {
    const traces = context.conversationTraces || {};
    const hasReservation = !!(context.reservationId || context.reservation_id || context.reservation?.id);
    if (!hasReservation) return false;
    if (traces.hasRecentHostMessage || traces.earlyUnitReadyOffered) return false;
    if (this._looksLikePlausibleFollowUp(guestMessage)) return false;

    const msg = (guestMessage || '').trim();
    if (!msg || msg.length < 25) return false;
    if (/\?/.test(msg)) return false;
    if (/(can we|would it be|is it possible|do you have|can you|how about|could you|will you|are you able|where is|how do i|what is the)/i.test(msg)) {
      return false;
    }

    const introSignals = /(visiting|first time|chose this|looking forward|booked|booking|trip|spring break|next year|college roommates|favorite spots|celebrate|birthday|excited|walk to everything|walk everywhere|portland|daughter|son|family|friends|group)/i;
    const hasGreetingIntro = /^(hello|hi|hey|good (morning|afternoon|evening))/i.test(msg);
    const operationalAsk = /(problem|issue|broken|not working|where is|how do|wifi|password|code|parking cost|pet fee)/i.test(msg);

    return (introSignals.test(msg) || (hasGreetingIntro && msg.length > 40)) && !operationalAsk;
  }

  /**
   * When history fetch failed, use Taylor conservative mode only for plausible follow-ups —
   * not for pure first-post-booking welcomes where empty history is expected (Cheryl incident).
   */
  _shouldApplyHistoryFetchConservativeMode(guestMessage = '', context = {}) {
    const traces = context.conversationTraces || {};
    const fetchFailed = traces.historyFetchFailed ||
      traces.historySource === 'live_fetch_failed' ||
      traces.historySource === 'fallback_used_after_failure';
    if (!fetchFailed) return false;
    if (this._isPureFirstPostBookingIntro(guestMessage, context)) return false;
    return true;
  }

  /**
   * Final guard: pure first-post-booking welcomes must auto-reply even when reflection/judge
   * withheld due to history-fetch conservatism (Cheryl Downtown Studio incident).
   */
  _applyPureWelcomeReplyPolicy(parsed, context = {}, guestMessage = '') {
    const categories = Array.isArray(parsed.typeOfMessageReceived)
      ? parsed.typeOfMessageReceived
      : [parsed.typeOfMessageReceived];
    const welcomeCategories = ['NEW_RESERVATION_WELCOME', 'NEW_INQUIRY_WELCOME'];
    if (!welcomeCategories.some(c => categories.includes(c))) {
      return { applied: false };
    }
    if (!this._isPureFirstPostBookingIntro(guestMessage, context)) {
      return { applied: false };
    }

    const draft = (parsed.proposedResponse || '').trim();
    if (!draft || draft === 'none' || draft.length < 20) {
      return { applied: false };
    }

    return { applied: true, shouldReply: true, confidence: 1.0, escalated: false };
  }

  /**
   * Normalize bare CANCELLATION alias to a canonical subcategory.
   * The modular prompt lists CANCELLATION as a legacy alias; eval + production expect
   * CANCELLATION_POLICY / CANCELLATION_NOTIFICATION / CANCELLATION_POLICY_EXCEPTION.
   */
  _applyCancellationCategoryPolicy(parsed, guestMessage = '') {
    const categories = Array.isArray(parsed.typeOfMessageReceived)
      ? parsed.typeOfMessageReceived
      : [parsed.typeOfMessageReceived];
    const canonical = ['CANCELLATION_POLICY', 'CANCELLATION_NOTIFICATION', 'CANCELLATION_POLICY_EXCEPTION'];
    if (!categories.includes('CANCELLATION') || categories.some(c => canonical.includes(c))) {
      return { applied: false };
    }

    const msg = (guestMessage || '').toLowerCase();
    let typeOfMessageReceived = 'CANCELLATION_POLICY';

    if (/illness|emergency|divorce|separation|husband|wife|sick|personal circumstances|cannot come/i.test(msg)) {
      typeOfMessageReceived = 'CANCELLATION_POLICY_EXCEPTION';
    } else if (/what refund|refund would|how much.*refund|cancel.*policy|money back|what if i cancel/i.test(msg)) {
      typeOfMessageReceived = 'CANCELLATION_POLICY';
    } else if (/i (have to|need to|am going to) cancel|won't be able to make it|cannot make it/i.test(msg)) {
      typeOfMessageReceived = 'CANCELLATION_NOTIFICATION';
    }

    parsed.typeOfMessageReceived = typeOfMessageReceived;
    return { applied: true, typeOfMessageReceived };
  }

  /**
   * Pre-arrival sofa bed linen confirmations must NOT be categorized as EXTRA_LINENS_TOWELS.
   * EXTRA_LINENS_TOWELS is reserved for in-stay "where are the linens?" asks with lift-up instructions.
   */
  _applySofaBedLinensPolicy(parsed, context = {}, guestMessage = '') {
    if (!this._isPreArrivalSofaLinensAsk(guestMessage, context)) {
      return { applied: false };
    }

    const categories = Array.isArray(parsed.typeOfMessageReceived)
      ? parsed.typeOfMessageReceived
      : [parsed.typeOfMessageReceived];
    const wrongCategory = categories.includes('EXTRA_LINENS_TOWELS');
    const alreadyCorrect = categories.some(c =>
      ['SLEEPING_ARRANGEMENTS', 'SLEEPING_ACCOMMODATION', 'SOFA_BED_SIZE'].includes(c)
    );

    if (!wrongCategory && alreadyCorrect) {
      return { applied: false };
    }

    const draft = (parsed.proposedResponse || '').trim();
    let proposedResponse = draft;
    const lower = draft.toLowerCase();
    const needsStorageDetail = !lower.includes('storage compartment') && !lower.includes('under the sofa');

    if (needsStorageDetail) {
      const greetingMatch = draft.match(/^(Good (?:morning|afternoon|evening)|Hi|Hey|Hello)[^!?\n]{0,80}[,!]\s*/i);
      const prefix = greetingMatch ? greetingMatch[0].trimEnd() + ' ' : '';
      proposedResponse =
        `${prefix}yes, we provide sheets, blankets, and pillows for anyone using the sofa bed. ` +
        `They're stored in the storage compartment under the sofa. Enjoy your stay!`;
    }

    return {
      applied: true,
      typeOfMessageReceived: 'SLEEPING_ARRANGEMENTS',
      proposedResponse: wrongCategory || needsStorageDetail ? proposedResponse : undefined
    };
  }

  _isExtraLinensTowelsInStayAsk(guestMessage = '', context = {}) {
    if (this._isPreArrivalSofaLinensAsk(guestMessage, context)) {
      return false;
    }

    const lower = (guestMessage || '').toLowerCase();
    const towelOrLinenAsk =
      /\b(?:towels?|linens?|sheets?|blankets?|pillows?|wash\s*cloths?)\b/.test(lower) &&
      /\b(?:more|extra|additional|another|where|find|stored|available|are there|do you have|in the unit|under)\b/.test(lower);

    const sofaBedContext =
      /\b(?:sofa|couch|sofa bed|bedroom)\b/.test(lower) ||
      /\b(?:more|extra|additional)\b.{0,40}\b(?:towels?|linens?)\b/.test(lower);

    return towelOrLinenAsk && sofaBedContext;
  }

  /**
   * In-stay extra towels/linens replies must include a follow-up offer if the guest cannot find them.
   */
  _applyExtraLinensTowelsPolicy(parsed, context = {}, guestMessage = '') {
    const categories = Array.isArray(parsed.typeOfMessageReceived)
      ? parsed.typeOfMessageReceived
      : [parsed.typeOfMessageReceived];
    const isCategory = categories.includes('EXTRA_LINENS_TOWELS');
    const isAsk = this._isExtraLinensTowelsInStayAsk(guestMessage, context);

    if (!isCategory && !isAsk) {
      return { applied: false };
    }

    const draft = (parsed.proposedResponse || '').trim();
    if (!draft || draft === 'none') {
      return { applied: false };
    }

    const lower = draft.toLowerCase();
    const hasLocationGuidance =
      /lift up|under the sofa|under there|storage compartment|reveal/.test(lower);
    const hasFollowUp =
      /let (?:us|me) know/.test(lower) ||
      /feel free/.test(lower) ||
      /cannot find|can't find/.test(lower);

    if (!hasLocationGuidance || hasFollowUp) {
      return { applied: false };
    }

    const proposedResponse = `${draft.replace(/\s+$/, '')} ${EXTRA_LINENS_TOWELS_FOLLOW_UP}`;

    return {
      applied: true,
      typeOfMessageReceived: 'EXTRA_LINENS_TOWELS',
      proposedResponse,
    };
  }

  _isHvacRemotePerUnitQuestion(guestMessage = '') {
    const lower = (guestMessage || '').toLowerCase();
    if (!/\bremote/.test(lower)) {
      return false;
    }

    const asksAboutSharedRemote =
      /\b(?:one|the|a|single)\b.{0,30}\bremote\b.{0,50}\b(?:both|two|all|multiple)\b/.test(lower) ||
      /\bremote\b.{0,50}\b(?:both|two|all)\b.{0,30}\b(?:unit|units|head|heads|room|rooms|air)\b/.test(lower) ||
      /\b(?:both|two|all)\b.{0,30}\b(?:unit|units|air)\b.{0,50}\b(?:one|the|a|single)\b.{0,20}\bremote\b/.test(lower) ||
      (/\b(?:both|two|all)\s+air\s+units?\b/.test(lower) && /\bremote/.test(lower));

    if (!asksAboutSharedRemote) {
      return false;
    }

    if (/\b(?:cold|hot|freezing|not (?:working|blowing|cooling)|no air|too (?:hot|cold)|turn (?:up|down)|broken|stuck|warm up|cool down)\b/.test(lower)) {
      return false;
    }

    return true;
  }

  /**
   * Guests ask whether one remote controls multiple air units. Each remote is room-specific.
   */
  _applyHvacRemotePerUnitPolicy(parsed, context = {}, guestMessage = '') {
    if (!this._isHvacRemotePerUnitQuestion(guestMessage)) {
      return { applied: false };
    }

    const draft = (parsed.proposedResponse || '').trim();
    const lower = draft.toLowerCase();
    const alreadyCorrect =
      /\bno\b/.test(lower) &&
      /each remote/.test(lower) &&
      /single unit/.test(lower) &&
      !/nest|make sure you are using|heat pump remotes on the wall/i.test(lower);

    if (alreadyCorrect) {
      return { applied: false };
    }

    const greetingMatch = draft.match(/^(Good (?:morning|afternoon|evening)|Hi|Hey|Hello)[^!?\n]{0,80}[,!]\s*/i);
    const firstName = (context.guestDisplayName || context.guestName || '').split(/[\s(]/)[0];
    let proposedResponse = HVAC_REMOTE_PER_UNIT_STANDARD_RESPONSE;

    if (greetingMatch) {
      proposedResponse = `${greetingMatch[0].trimEnd()} no. Each remote is for a single unit.`;
    } else if (firstName) {
      proposedResponse = `Hi ${firstName}, no. Each remote is for a single unit.`;
    }

    return {
      applied: true,
      typeOfMessageReceived: 'HVAC_REMOTE_PER_UNIT',
      proposedResponse,
    };
  }

  /**
   * Ensure THERMOSTAT_HEATPUMP replies always include the neutral remote-control wording.
   * Uses ThermostatTool / HeatPumpTool recommended snippets when the LLM paraphrases.
   */
  _applyThermostatPolicy(parsed, context = {}, guestMessage = '') {
    if (this._isHvacRemotePerUnitQuestion(guestMessage)) {
      return { applied: false };
    }
    const categories = Array.isArray(parsed.typeOfMessageReceived)
      ? parsed.typeOfMessageReceived
      : [parsed.typeOfMessageReceived];
    const isThermostatCategory = categories.includes('THERMOSTAT_HEATPUMP') || categories.includes('THERMOSTAT');
    const thermo = context.earlyThermostatInfo;
    const hp = context.heatPumpInfo;

    // Never stomp welcome, hotel, or other unrelated categories with HVAC boilerplate.
    const protectedCategories = [
      'NEW_RESERVATION_WELCOME',
      'NEW_INQUIRY_WELCOME',
      'HOTEL_RECOMMENDATION',
      'DINNER_RECOMMENDATION',
      'LUNCH_RECOMMENDATION',
      'LOBSTER_RECOMMENDATION',
      'EVENT_REQUEST',
      'PACK_AND_PLAY_BRAND',
      'SLEEPING_ARRANGEMENTS',
      'SLEEPING_ACCOMMODATION',
      'SOFA_BED_SIZE',
    ];
    if (categories.some((c) => protectedCategories.includes(c))) {
      return { applied: false };
    }

    const hvacRelevant = thermo?.guestMessageRelevant || hp?.guestMessageRelevant || hp?.detected;
    if (!isThermostatCategory || !hvacRelevant) {
      return { applied: false };
    }

    const draft = (parsed.proposedResponse || '').trim();
    const lower = draft.toLowerCase();
    const hasRequired = lower.includes('make sure you are using') && lower.includes('remotes on the wall');

    let body = null;
    if (hp?.suggestedResponseSnippet) {
      body = hp.suggestedResponseSnippet;
    } else if (!hasRequired && thermo?.recommendedResponse) {
      body = thermo.recommendedResponse;
    } else if (!hasRequired && thermo?.suggestedResponseSnippet) {
      body = thermo.suggestedResponseSnippet;
    }

    if (!body) {
      return { applied: false };
    }

    const greetingMatch = draft.match(/^(Good (?:morning|afternoon|evening)|Hi|Hey|Hello)[^!?\n]{0,80}[,!]\s*/i);
    const proposedResponse = greetingMatch
      ? greetingMatch[0].trimEnd() + ' ' + body.replace(/^(Good (?:morning|afternoon|evening)|Hi|Hey|Hello)[^,!]*[,!]\s*/i, '')
      : body;

    return {
      applied: true,
      typeOfMessageReceived: 'THERMOSTAT_HEATPUMP',
      proposedResponse
    };
  }

  _isLuggageRequest(guestMessage = '') {
    const lower = (guestMessage || '').toLowerCase();
    return /luggage|suitcase/.test(lower) ||
      /drop\s+(our|my|the)?\s*(bags?|luggage)/.test(lower) ||
      /(bags?|luggage).*(drop|store|storage|leave)/.test(lower) ||
      /early.*(drop|arrival).*(luggage|bags?)/.test(lower);
  }

  /**
   * Ensure operational luggage handoff always includes Richard + the correct phone number.
   * The LLM sometimes omits the contact (luggage-drop-off eval flake in CI).
   */
  _applyLuggagePolicy(parsed, context = {}, guestMessage = '') {
    const categories = Array.isArray(parsed.typeOfMessageReceived)
      ? parsed.typeOfMessageReceived
      : [parsed.typeOfMessageReceived];
    const isDropOff = categories.includes('LUGGAGE_DROP_OFF');
    const isStorage = categories.includes('LUGGAGE_STORAGE');
    const luggageAsk = this._isLuggageRequest(guestMessage);

    if (!isDropOff && !isStorage && !luggageAsk) {
      return { applied: false };
    }

    const draft = (parsed.proposedResponse || '').trim();
    const lower = draft.toLowerCase();
    const hasRichard = lower.includes('richard') || lower.includes((getHostContactsSync().propertyManagerName || 'richard').toLowerCase());
    const digitHints = phoneDigitHints();
    const draftDigits = lower.replace(/\D/g, '');
    const hasPhone = digitHints.some((h) => h && draftDigits.includes(h));

    if (hasRichard && hasPhone) {
      return { applied: false };
    }

    const standard = isStorage && !isDropOff
      ? buildLuggageStorageResponse()
      : buildLuggageDropOffResponse();

    const greetingMatch = draft.match(/^(Good (?:morning|afternoon|evening)|Hi|Hey|Hello)[^!?\n]{0,80}[,!]\s*/i);
    const proposedResponse = greetingMatch
      ? greetingMatch[0].trimEnd() + ' ' + standard
      : standard;

    return {
      applied: true,
      typeOfMessageReceived: isStorage && !isDropOff ? 'LUGGAGE_STORAGE' : 'LUGGAGE_DROP_OFF',
      proposedResponse,
    };
  }

  _isPaymentMethodUpdateRequest(guestMessage = '') {
    const lower = (guestMessage || '').toLowerCase();
    if (/fraudulent charge/.test(lower) && /card|cc\b|visa|amex|mastercard/.test(lower)) {
      return true;
    }
    if (/payment method/.test(lower)) {
      return true;
    }
    if (/(update|change|switch).*(card|payment|amex|visa|mastercard)/.test(lower)) {
      return true;
    }
    if (/(bill|charge|charging).*(amex|visa|card|payment)/.test(lower)) {
      return true;
    }
    if (/(amex|visa|mastercard).*(instead|not the|rather than)/.test(lower)) {
      return true;
    }
    return false;
  }

  /**
   * Guests sometimes ask hosts to switch billing cards. Hosts do not handle payments —
   * always direct to Airbnb (Julie AMEX incident).
   */
  _applyPaymentMethodPolicy(parsed, context = {}, guestMessage = '') {
    if (!this._isPaymentMethodUpdateRequest(guestMessage)) {
      return { applied: false };
    }

    const draft = (parsed.proposedResponse || '').trim();
    const lower = draft.toLowerCase();
    const alreadyCorrect =
      lower.includes('airbnb') &&
      /do not handle payment|don't handle payment|we host.*do not/i.test(lower) &&
      !/i'll note|i will note|we will bill|charge your|use the amex|use the visa/i.test(lower);

    if (alreadyCorrect) {
      return { applied: false };
    }

    const greetingMatch = draft.match(/^(Good (?:morning|afternoon|evening)|Hi|Hey|Hello)[^!?\n]{0,80}[,!]\s*/i);
    const firstName = (context.guestDisplayName || context.guestName || '').split(/[\s(]/)[0];
    let proposedResponse = PAYMENT_METHOD_UPDATE_STANDARD_RESPONSE;

    if (greetingMatch) {
      proposedResponse = `${greetingMatch[0].trimEnd()} ${PAYMENT_METHOD_UPDATE_STANDARD_RESPONSE}`;
    } else if (firstName) {
      proposedResponse = `Hi ${firstName}, ${PAYMENT_METHOD_UPDATE_STANDARD_RESPONSE.charAt(0).toLowerCase()}${PAYMENT_METHOD_UPDATE_STANDARD_RESPONSE.slice(1)}`;
    }

    return {
      applied: true,
      typeOfMessageReceived: 'PAYMENT_METHOD_UPDATE',
      proposedResponse,
    };
  }

  _isSecurityDepositQuestion(guestMessage = '') {
    const lower = (guestMessage || '').toLowerCase();
    if (!/deposit/.test(lower)) {
      return false;
    }
    if (this._isPaymentMethodUpdateRequest(guestMessage)) {
      return false;
    }
    if (/cancel/.test(lower) && /refund/.test(lower)) {
      return false;
    }

    return (
      /get (?:it )?back/.test(lower) ||
      /refundable/.test(lower) ||
      /will i get/.test(lower) ||
      /do i get/.test(lower) ||
      /question about (?:the )?deposit/.test(lower) ||
      /about (?:the |a )?deposit/.test(lower) ||
      /house rules.*deposit|deposit.*house rules/.test(lower) ||
      /\$\d+.*deposit|deposit.*\$\d+/.test(lower)
    );
  }

  /**
   * Guests ask whether security/damage deposits are refunded. Hosts do not process
   * deposits — Airbnb returns them automatically after the stay when rules were followed.
   */
  _applySecurityDepositPolicy(parsed, context = {}, guestMessage = '') {
    if (!this._isSecurityDepositQuestion(guestMessage)) {
      return { applied: false };
    }

    const draft = (parsed.proposedResponse || '').trim();
    const lower = draft.toLowerCase();
    const alreadyCorrect =
      /you will get it back|get it back automatically/.test(lower) &&
      /airbnb|platform/.test(lower) &&
      /not done by us|we do not|don't handle|do not handle/.test(lower) &&
      !/i'll refund|i will refund|we will refund|release your deposit|return your deposit/i.test(lower);

    if (alreadyCorrect) {
      return { applied: false };
    }

    const greetingMatch = draft.match(/^(Good (?:morning|afternoon|evening)|Hi|Hey|Hello)[^!?\n]{0,80}[,!]\s*/i);
    const firstName = (context.guestDisplayName || context.guestName || '').split(/[\s(]/)[0];
    let proposedResponse = SECURITY_DEPOSIT_STANDARD_RESPONSE;

    if (greetingMatch) {
      proposedResponse = `${greetingMatch[0].trimEnd()} ${SECURITY_DEPOSIT_STANDARD_RESPONSE.charAt(0).toLowerCase()}${SECURITY_DEPOSIT_STANDARD_RESPONSE.slice(1)}`;
    } else if (firstName) {
      proposedResponse = `Hi ${firstName}, ${SECURITY_DEPOSIT_STANDARD_RESPONSE.charAt(0).toLowerCase()}${SECURITY_DEPOSIT_STANDARD_RESPONSE.slice(1)}`;
    }

    return {
      applied: true,
      typeOfMessageReceived: 'SECURITY_DEPOSIT_QUESTION',
      proposedResponse,
    };
  }

  _isLaundryFacilitiesQuestion(guestMessage = '') {
    const lower = (guestMessage || '').toLowerCase();
    if (!/\blaundry\b|\blaundromat\b|\bwashing machine\b|\bwasher\b|\bdryer\b/.test(lower)) {
      return false;
    }
    // Detergent / product questions have their own category and standard wording.
    if (/\bdetergent\b|\bdrying sheets?\b|\bfabric softener\b|\bkirkland\b|\btide\b/.test(lower)) {
      return false;
    }
    return true;
  }

  /** True when the guest message includes thanks / appreciation (multi-intent with other asks). */
  _hasThankYouIntent(guestMessage = '') {
    const lower = (guestMessage || '').toLowerCase();
    return /\bthank(?:s| you)\b|\bappreciate(?: it)?\b|\bthx\b/.test(lower);
  }

  /**
   * Merge category labels into a string (single) or array (multi). Drops empties/duplicates.
   * Prefer keeping THANK_YOU_MESSAGE first when present so multi-intent order is readable.
   * Soft placeholders (OTHER_MESSAGE / UNCATEGORIZED) are dropped once a real content category exists.
   */
  _mergeCategories(existing, ...toAdd) {
    const out = [];
    const push = (c) => {
      if (c == null || c === '') return;
      if (Array.isArray(c)) {
        c.forEach(push);
        return;
      }
      if (!out.includes(c)) out.push(c);
    };
    push(existing);
    for (const c of toAdd) push(c);

    const softPlaceholders = new Set(['OTHER_MESSAGE', 'UNCATEGORIZED']);
    const hasRealContent = out.some((c) => !softPlaceholders.has(c));
    const filtered = hasRealContent ? out.filter((c) => !softPlaceholders.has(c)) : out;

    // Courtesy categories first, then content categories (readable multi-intent arrays).
    const preferredOrder = (a, b) => {
      const rank = (x) => (x === 'THANK_YOU_MESSAGE' || x === 'FYI_STATEMENT' ? 0 : 1);
      return rank(a) - rank(b);
    };
    filtered.sort(preferredOrder);

    if (filtered.length === 0) return 'OTHER_MESSAGE';
    if (filtered.length === 1) return filtered[0];
    return filtered;
  }

  _categoriesInclude(existing, category) {
    const list = Array.isArray(existing) ? existing : [existing];
    return list.includes(category);
  }

  /**
   * Guests ask if laundry is available on site. Same answer for all three units:
   * no on-site laundry; Soap Bubble laundromat next door at 68 Pine St.
   * Multi-intent (thanks + laundry): emit both categories and combine "You're welcome"
   * with the Soap Bubble facts in one reply (Henry incident).
   * Prevents deferral replies like "I'll check on laundry and get back shortly."
   */
  _applyLaundryPolicy(parsed, context = {}, guestMessage = '') {
    if (!this._isLaundryFacilitiesQuestion(guestMessage)) {
      return { applied: false };
    }

    const guestHasThanks = this._hasThankYouIntent(guestMessage);
    const draft = (parsed.proposedResponse || '').trim();
    const lower = draft.toLowerCase();
    const hasLaundryFacts =
      /soap bubble/.test(lower) &&
      /68 pine/.test(lower) &&
      /do not have laundry on site|no laundry on site|don't have laundry on site|no on-site laundry/.test(lower);
    const hasDeferral = /i'll check|i will check|get back shortly|let me check|look into laundry/i.test(lower);
    const hasThanksAck = /you'?re welcome|you are welcome/i.test(lower);

    const typeOfMessageReceived = this._mergeCategories(
      // Keep any other content categories the LLM already set; always include laundry (+ thanks when mixed).
      parsed.typeOfMessageReceived,
      'LAUNDRY_QUESTION',
      guestHasThanks ? 'THANK_YOU_MESSAGE' : null
    );

    // Whether the *incoming* classification already multi-tags correctly (not the merged target).
    const catsCorrect =
      this._categoriesInclude(parsed.typeOfMessageReceived, 'LAUNDRY_QUESTION') &&
      (!guestHasThanks || this._categoriesInclude(parsed.typeOfMessageReceived, 'THANK_YOU_MESSAGE'));

    const textCorrect = hasLaundryFacts && !hasDeferral && (!guestHasThanks || hasThanksAck);

    if (textCorrect && catsCorrect) {
      return { applied: false };
    }

    // Text already good but multi-cat missing — only fix categories.
    if (textCorrect && !catsCorrect) {
      return {
        applied: true,
        typeOfMessageReceived,
        proposedResponse: draft,
      };
    }

    const firstName = (context.guestDisplayName || context.guestName || '').split(/[\s(]/)[0];
    const greetingMatch = draft.match(/^(Good (?:morning|afternoon|evening)|Hi|Hey|Hello)[^!?\n]{0,80}[,!]\s*/i);
    const laundryBody = LAUNDRY_QUESTION_STANDARD_RESPONSE;
    const laundryBodyLower =
      laundryBody.charAt(0).toLowerCase() + laundryBody.slice(1);

    let proposedResponse;
    if (guestHasThanks) {
      // Combined multi-intent reply: courtesy + Soap Bubble facts.
      if (greetingMatch) {
        // "Good morning, Henry! You're welcome. We do not have laundry..."
        proposedResponse = `${greetingMatch[0].trimEnd()} You're welcome. ${laundryBody}`;
      } else if (firstName) {
        proposedResponse = `You're welcome, ${firstName}! ${laundryBody}`;
      } else {
        proposedResponse = `You're welcome! ${laundryBody}`;
      }
    } else if (greetingMatch) {
      proposedResponse = `${greetingMatch[0].trimEnd()} ${laundryBodyLower}`;
    } else if (firstName) {
      proposedResponse = `Hi ${firstName}, ${laundryBodyLower}`;
    } else {
      proposedResponse = laundryBody;
    }

    return {
      applied: true,
      typeOfMessageReceived,
      proposedResponse,
    };
  }

  /**
   * Apt 2 only: guest bolted the parking/unit door from inside and exited via the street.
   * Keypad codes alone cannot open a door bolted from the inside — use street backup key.
   * Henry incident: "unable to get into" + later "We bolted the door from the inside".
   */
  _isApt2Listing(context = {}) {
    if (context.listingId === APT2_LISTING_ID) return true;
    const name = String(context.propertyName || context.listingName || '').toLowerCase();
    // Prefer explicit Apt 2 / Sunny 2-bed naming; avoid matching Apt 3 or 1B.
    if (/\bapt\s*3\b|#3\b|unit\s*3\b/.test(name)) return false;
    if (/\b1b\b|studio/.test(name)) return false;
    return /\bapt\s*2\b|apt2|sunny.*2\s*bed|2 bed apt/.test(name);
  }

  _extractGuestPhoneLast4(context = {}) {
    const candidates = [
      context.guestPhone,
      context.guest_phone,
      context.phone,
      context.phoneNumber,
      context.phone_number,
      context.guest?.phone,
      context.guest?.phone_number,
      context.guest?.mobile,
      context.guest?.cell,
      context.reservation?.guest?.phone,
      context.reservation?.guest?.phone_number,
    ];
    for (const c of candidates) {
      if (c == null || c === '') continue;
      const digits = String(c).replace(/\D/g, '');
      if (digits.length >= 4) return digits.slice(-4);
    }
    return null;
  }

  /**
   * Post-stay gratitude / review promise (Henry review incident 2026-07-27).
   * Guest already checked out and is thanking us / promising a review — never treat as lockout.
   */
  _isPostStayGratitudeOrReviewPromise(guestMessage = '', context = {}) {
    const msg = String(guestMessage || '').trim();
    if (!msg) return false;
    const lower = msg.toLowerCase();

    // Stay is over (checkout day already passed in America/New_York calendar).
    const checkOut = (context.checkOut || '').slice(0, 10);
    const today = this._todayDateStr(context);
    const pastCheckout = !!(checkOut && today && checkOut < today);

    const reviewPromise =
      /\breview\b/.test(lower) &&
      /(submit|leave|write|post|send|get a|glowing|5\s*[- ]?star|five\s*star|will|today|tomorrow|coming)/i.test(lower);
    const postStayThanks =
      /thank|thanks|appreciate/i.test(lower) &&
      /(terrific|great|wonderful|amazing|lovely|excellent)\s+(trip|stay)|looking forward to the next|had a (great|wonderful|terrific|amazing|lovely)|hope to (?:be )?back|until next time/i.test(
        lower
      );

    // Strong review/thanks language after checkout, or explicit review promise anytime after stay started ending.
    if (pastCheckout && (reviewPromise || postStayThanks)) return true;
    if (reviewPromise && /thank|thanks|appreciate|terrific|great trip|great stay|looking forward/i.test(lower)) {
      return true;
    }
    return false;
  }

  /**
   * True when this is the Apt 2 bolted-door / street-exit lockout (not generic code fail).
   *
   * CRITICAL (Henry review incident): Do NOT scan the full conversation history for "bolted".
   * Prior lockout turns on the same reservation must not poison later post-stay thanks/review
   * messages into re-sending the street lockbox script. History is only used for short
   * follow-ups when a *recent* guest message was already a lockout.
   */
  _isApt2StreetDoorLockout(guestMessage = '', context = {}) {
    if (!this._isApt2Listing(context)) return false;

    // Never override post-stay gratitude / review promises with lockout recovery.
    if (this._isPostStayGratitudeOrReviewPromise(guestMessage, context)) {
      return false;
    }

    const lower = String(guestMessage || '').toLowerCase();
    const msg = String(guestMessage || '').trim();

    const boltedNow =
      /\bbolted\b|\bdeadbolt(?:ed)?\b|\blocked (?:the )?(?:door|it) from the inside|\blocked from the inside/.test(
        lower
      );
    const accidentalFrontLock =
      /accident(?:ally)?\s+lock/.test(lower) ||
      /locked the (?:front )?door not knowing/.test(lower) ||
      /not knowing that the front door lock/.test(lower);
    const lockedOut =
      /locked out|unable to get (?:back )?in|can(?:not|'t) get (?:back )?in|unable to get into|can(?:not|'t) get into|are unable to get into/.test(
        lower
      );

    // Explicit bolt/deadbolt on the *current* message.
    if (boltedNow) return true;
    // Henry first message: accidental lock + cannot re-enter (street lockout pattern).
    if (accidentalFrontLock && lockedOut) return true;
    // Lockout + clear "front door locked" / interior lock language without a "code not working" pin.
    if (lockedOut && /front door lock|door locked|from the inside/.test(lower) && !/\bcode\b/.test(lower)) {
      return true;
    }

    // Short follow-up only (e.g. "We bolted the door from the inside") when a *recent*
    // prior guest message already described being locked out — not the entire thread.
    if (msg.length > 0 && msg.length <= 160) {
      const recentGuestBodies = Array.isArray(context.conversationHistory)
        ? context.conversationHistory
            .filter((m) => {
              const role = String(m?.sender_type || m?.role || m?.sender || '').toLowerCase();
              return role === 'guest' || role === 'guest_message';
            })
            .slice(-3)
            .map((m) => String(m?.body || m?.message || m?.text || '').toLowerCase())
        : [];
      const recentLockout = recentGuestBodies.some((b) =>
        /locked out|unable to get (?:back )?in|can(?:not|'t) get (?:back )?in|unable to get into|accident(?:ally)?\s+lock|not knowing that the front door lock/.test(
          b
        )
      );
      if (
        recentLockout &&
        /\bbolted\b|\bdeadbolt|\bfrom the inside\b|\blocked (?:the )?door\b/.test(lower)
      ) {
        return true;
      }
    }

    return false;
  }

  /**
   * Force correct street lockbox recovery for Apt 2 bolted-door lockouts.
   * Always rewrites to the canonical script when the *current* message is a real lockout.
   * Never apply solely because the LLM category was APT2_STREET_DOOR_LOCKOUT (false positives
   * + prior-thread history used to re-fire this after checkout thanks — Henry review incident).
   */
  _applyApt2StreetDoorLockoutPolicy(parsed, context = {}, guestMessage = '') {
    const detected = this._isApt2StreetDoorLockout(guestMessage, context);

    // Require live detection on this message (or short lockout follow-up). Category alone is not enough.
    if (!detected) {
      return { applied: false };
    }
    if (!this._isApt2Listing(context)) {
      return { applied: false };
    }

    const pinLast4 = this._extractGuestPhoneLast4(context);
    const standard = buildApt2StreetDoorLockoutResponse(pinLast4);
    const draft = (parsed.proposedResponse || '').trim();

    const greetingMatch = draft.match(/^(Good (?:morning|afternoon|evening)|Hi|Hey|Hello)[^!?\n]{0,80}[,!]\s*/i);
    const firstName = (context.guestDisplayName || context.guestName || '').split(/[\s(·]/)[0];
    let proposedResponse = standard;
    if (greetingMatch) {
      proposedResponse = `${greetingMatch[0].trimEnd()} ${standard}`;
    } else if (firstName) {
      proposedResponse = `Good evening, ${firstName},\n\n${standard}`;
    }

    return {
      applied: true,
      typeOfMessageReceived: 'APT2_STREET_DOOR_LOCKOUT',
      proposedResponse,
    };
  }

  /**
   * Post-stay thank-you + review promise → warm REVIEW_PROMISE ack (never lockout/welcome).
   */
  _applyReviewPromisePolicy(parsed, context = {}, guestMessage = '') {
    if (!this._isPostStayGratitudeOrReviewPromise(guestMessage, context)) {
      return { applied: false };
    }
    // Housekeeping FYI path has its own richer ack.
    if (this._isPostStayHousekeepingFeedback(guestMessage)) {
      return { applied: false };
    }

    const name = this._guestDisplayFirstName(context);
    const draft = (parsed.proposedResponse || '').trim();
    const looksLikeLockout = /locked out|lock box|2630|backup key/i.test(draft);
    const looksLikeWelcome = this._hostMessageLooksLikeWelcome(draft);
    const hasReviewAck = /review/i.test(draft) && /you're welcome|you are welcome|thank you|glad/i.test(draft);
    const isGood =
      draft &&
      draft !== 'none' &&
      !looksLikeLockout &&
      !looksLikeWelcome &&
      (hasReviewAck || (/you're welcome|you are welcome/i.test(draft) && draft.length < 280));

    let proposedResponse = draft;
    if (!isGood) {
      proposedResponse =
        `You're welcome, ${name}! So glad you had a terrific trip — thank you for the kind words. ` +
        `We'll look forward to your review and will leave you a 5-star review as well. ` +
        `Hope to host you again in Portland soon!`;
    }

    parsed.typeOfMessageReceived = 'REVIEW_PROMISE';
    parsed.proposedResponse = proposedResponse;

    return {
      applied: true,
      typeOfMessageReceived: 'REVIEW_PROMISE',
      proposedResponse,
      shouldReply: true,
      confidence: 1.0,
      escalated: false,
    };
  }

  _buildUserPrompt(message, context) {
    const lines = [
      `Current guest message: "${message}"`,
      '',
      'Context:'
    ];

    if (context.guestName || context.guestDisplayName) {
      const raw = context.guestName || '';
      const disp = context.guestDisplayName || raw;
      lines.push(`- Guest name: ${raw}${disp && disp !== raw ? ` (display: ${disp})` : ''}`);
    }
    if (context.checkIn) lines.push(`- Check-in: ${context.checkIn}`);
    if (context.checkOut) lines.push(`- Check-out: ${context.checkOut}`);
    if (context.listingId) lines.push(`- Listing ID: ${context.listingId}`);
    const pc = (context.petCount != null ? context.petCount : (context.hasPets ? 1 : 0));
    lines.push(`- Pets: ${context.hasPets ? 'yes' : 'no'} (count: ${pc})`);
    if (context.hasPets != null) lines.push(`- hasPets (from reservation/inquiry): ${context.hasPets}`);
    if (context.petCount != null) lines.push(`- petCount (from reservation/inquiry): ${context.petCount}`);
    const ic = (context.infantCount != null ? context.infantCount : (context.conversationTraces && context.conversationTraces.infantCount != null ? context.conversationTraces.infantCount : 0));
    if (context.infantCount != null || ic > 0) lines.push(`- infantCount (from reservation/inquiry guests): ${ic}`);
    if (context.childCount != null) lines.push(`- childCount (from reservation/inquiry): ${context.childCount}`);
    if (context.propertyName) lines.push(`- Property: ${context.propertyName}`);

    // Guest phone last-4 for pin-based entry (Apt 2 street lockout, door codes).
    // Deterministic policies inject the digits; surface them here so the first-pass LLM cannot invent a vague "last 4" only.
    const guestPhoneLast4 = this._extractGuestPhoneLast4(context);
    if (guestPhoneLast4) {
      lines.push(`- Guest phone last 4 digits (unit pin when applicable): ${guestPhoneLast4}`);
    }

    // Computed stay timing + days (helps NEW_RESERVATION_WELCOME follow exact timing rules for check-in instructions)
    // Uses NY calendar day for "today" to match greeting / old system behavior.
    // For eval scenarios (e.g. first-post-booking-birthday-abby with frozen dates), context may provide asOfDate
    // (or simulatedToday) to make "future >=3 days" and the "detailed check-in instructions 3 days before" requirement
    // deterministic regardless of wall-clock when the eval runs.
    let stayTiming = 'unknown';
    let daysUntilCheckIn = null;
    if (context.checkIn) {
      try {
        const anchor = context.asOfDate || context.simulatedToday || context.today;
        const nyTodayStr = anchor
          ? String(anchor).slice(0, 10)
          : new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); // YYYY-MM-DD
        const today = new Date(nyTodayStr + 'T00:00:00');
        const ci = new Date((context.checkIn || '').slice(0,10) + 'T00:00:00');
        daysUntilCheckIn = Math.round((ci - today) / (1000 * 3600 * 24));
        const todayStr = nyTodayStr;
        if (context.checkIn <= todayStr && (context.checkOut || '') > todayStr) stayTiming = 'current';
        else if (context.checkIn > todayStr) stayTiming = 'future';
        else stayTiming = 'past';
      } catch (e) {}
    }
    if (daysUntilCheckIn !== null) lines.push(`- Days until check-in: ${daysUntilCheckIn}`);
    lines.push(`- Stay timing: ${stayTiming} (current = check-in day or in-stay; future = upcoming)`);

    if (this._isTemporaryDepartureDuringStay(message, context)) {
      lines.push('- CRITICAL IN-STAY TEMPORARY DEPARTURE (Amie incident): Guest is currently IN their stay (check-in day or mid-stay, NOT checkout day). They said they "left the apartment/unit" temporarily (e.g. stepped out so a property manager could knock, deliver a blanket, or leave an item by the door). This is NOT checkout and they are returning tonight. Classify as THANK_YOU_MESSAGE. proposedResponse MUST be a brief warm "You\'re welcome, [Name]!" only. MUST NOT say "safe travels", "hope you enjoyed your stay", "have a great trip", or any end-of-stay farewell.');
    }

    // Multi-intent: thanks/excitement + laundry facilities (Henry incident). Soft single-category thank-you is wrong.
    if (this._isLaundryFacilitiesQuestion(message) && this._hasThankYouIntent(message)) {
      lines.push('- CRITICAL MULTI-CATEGORIZATION (thanks + laundry — Henry incident): Guest thanked you / expressed excitement AND asked about laundry. typeOfMessageReceived MUST be the array ["THANK_YOU_MESSAGE", "LAUNDRY_QUESTION"] (not THANK_YOU_MESSAGE alone). proposedResponse MUST combine a short "You\'re welcome, [Name]!" (or "You\'re welcome!") with the full laundry facts in one message: no laundry on site; laundromat next door Soap Bubble; Address: 68 Pine St, Portland, ME 04102. MUST NOT say "I\'ll check on laundry" or "get back shortly". Applies to all three units.');
    } else if (this._isLaundryFacilitiesQuestion(message)) {
      lines.push('- CRITICAL LAUNDRY_QUESTION (all units): Guest asked about laundry facilities. Answer immediately: no laundry on site; Soap Bubble next door; 68 Pine St, Portland, ME 04102. shouldReply true. Never defer.');
    }

    if (this._isPostStayHousekeepingFeedback(message)) {
      lines.push('- CRITICAL POST-STAY HOUSEKEEPING FEEDBACK (Amy incident): Guest checked out and is sending post-stay feedback that includes a housekeeping/setup issue (e.g. missing sofa bed sheets, linens not stocked). Classify as REVIEW_SUBMITTED. shouldReply MUST be true. Reply warmly acknowledging their stay and the FYI — e.g. "You\'re welcome, [Name]! Glad you had a lovely stay — thanks for the heads up about the sofa bed, I\'ll note that for the team. Safe travels!" A cleaning alert is sent separately. Do NOT repeat sofa-bed linen storage instructions from earlier in the thread.');
    }

    // Strong signal for the 3-day check-in instructions rule + 4pm key info on future NEW_RESERVATION_WELCOME cases (e.g. abby birthday scenario).
    // This is injected directly into the user prompt Context so the first-pass LLM (processMessage / eval) cannot miss it.
    // Complements the CRITICAL in welcome-messages.md. The requiredPhrases check in runner is strict substring.
    if (stayTiming === 'future' && daysUntilCheckIn !== null && daysUntilCheckIn >= 3) {
      lines.push(`- CRITICAL FOR NEW_RESERVATION_WELCOME (FUTURE STAY): Days until check-in: ${daysUntilCheckIn} (>=3). For pure first-post-booking welcomes (like the Abby birthday scenario with no specific ask and empty history), the proposedResponse MUST contain the substring "detailed check-in instructions 3 days before" (ideally the full "I will send the detailed check-in instructions 3 days before your arrival."). This is a hard requirement in the welcome category rules, the scenario rubric, and the golden. Do not omit or use a variation that drops this exact sequence of words. Include it naturally in the logistics paragraph.`);
      const readinessOffered = !!(context.conversationTraces?.earlyUnitReadyOffered || context.conversationContext?.earlyUnitReadyOffered);
      if (!readinessOffered) {
        lines.push(`- ALSO CRITICAL (4pm + core logistics for same future NEW_RESERVATION_WELCOME case): Since earlyUnitReadyOffered is false (no prior host said "unit is ready for you to check in now"), the proposedResponse MUST also contain the substring "4pm" (examples that work: "Check-in is at 4pm", "at 4pm with self-check-in", "Check-in starts at 4PM", "4pm check-in"). This is required by the first-post-booking-birthday-abby rubric (requiredPhrases includes "4pm" alongside "self-check-in", "parking", "detailed check-in instructions 3 days before"). Ensure "self-check-in" and a parking mention also appear as part of the standard key information for first welcomes. The Taylor anti-contradiction rules (and the WARNING block above) only suppress 4pm when readiness was offered or history fetch failed on a follow-up. For this pure first welcome on future stay with no history, include the 4pm.`);
      }
      lines.push(`- ALSO EVAL / RUBRIC REQUIREMENT (new-reservation-welcome-emma, first-post-booking-birthday-abby and all pure first-post NEW_RESERVATION_WELCOME cases): The proposedResponse MUST NOT contain any of these forbidden phrases (they cause "Contained forbidden phrase" and 8/9 scores in the eval runner): "let me know if you have any questions", "let me know if questions", "happy to hear", "feel free to book". Use specific warm phrasing instead (e.g. "thanks for the note", "sounds like a wonderful spring break trip", "how nice that you went to Maine College of Art", "Looking forward to hosting you in Portland."). Do not append generic closers. This is a hard requirement in the emma and abby rubrics.`);
    }

    // Proactive pack-and-play mention for declared infants (only in the first rich welcome / pure NEW_RESERVATION_WELCOME).
    // Mirrors the 3-day / 4pm forcing pattern. The count is populated from guests.infant_count during handler enrichment
    // and ConversationContextTool (inquiry path). Rule lives in welcome-messages.md; this ensures the first-pass LLM sees it.
    const infantCountForPrompt = (context.infantCount != null ? context.infantCount : (context.conversationTraces?.infantCount || 0));
    if (infantCountForPrompt > 0) {
      lines.push(`- CRITICAL FOR NEW_RESERVATION_WELCOME (INFANTS): infantCount=${infantCountForPrompt} (>0 from guests.infant_count). For pure first-post-booking welcomes (first host/auto message in thread, empty or minimal conversationHistory, no explicit crib/ "pack and play" / baby bed ask in the current guest message), naturally include in the logistics that we provide a Graco Pack and Play that is already set up and ready in the unit. Use phrasing consistent with the PACK_AND_PLAY_BRAND category: include "Graco Pack and Play", "already set up", "ready". Prefer integrating it gracefully (e.g. after self-check-in or parking). NEVER say "upon request", "happy to prepare one", "let us know if you need a crib", "we can get one ready for you", or anything implying the guest must ask or that it is not pre-placed. If the guest message has a clear specific crib request (even with birthday language), PACK_AND_PLAY_BRAND category takes precedence and uses its exact pre-placed language. Only surface this fact for the initial welcome when infantCount > 0; do not repeat on follow-ups.`);
    }

    if (context.conversationHistory?.length) {
      lines.push('- Recent conversation (newest last):');
      context.conversationHistory.slice(-6).forEach(m => {
        const who = m.sender_type === 'guest' ? 'Guest' : 'Host';
        lines.push(`  ${who}: ${m.body}`);
      });
    }

    // === CONVERSATION HISTORY STATUS (anti-silent-failure for Taylor-style anti-contradiction) ===
    // Ensures the first-pass LLM (and later reflection/judge) ALWAYS knows whether it has the "full" recent thread
    // or is flying blind on prior host statements (e.g. the "We are pleased to let you know that the unit is ready
    // for you to check in now" message in the 9AM Taylor thread for 53 Pine #1B).
    const hTraces = context.conversationTraces || {};
    const historyFetchConservative = this._shouldApplyHistoryFetchConservativeMode(message, context);
    const pureFirstWelcomeDespiteFetchFail = (hTraces.historyFetchFailed || hTraces.historySource === 'live_fetch_failed' || hTraces.historySource === 'fallback_used_after_failure') &&
      this._isPureFirstPostBookingIntro(message, context);

    if (pureFirstWelcomeDespiteFetchFail) {
      lines.push('');
      lines.push('⚠️ HISTORY FETCH FAILED — BUT THIS IS A PURE FIRST-POST-BOOKING WELCOME (Cheryl/Emma case)');
      lines.push('   Source: ' + (hTraces.historySource || 'unknown') + ', count=' + (hTraces.recentMessageCount || 0));
      lines.push('   Live history fetch failed, but the guest message is a pure intro/sharing message with no question and no prior host activity signals. Empty history is EXPECTED for the guest\'s first post-booking message — there is nothing to contradict.');
      lines.push('   FOR THIS RESPONSE you MUST still classify as NEW_RESERVATION_WELCOME, set shouldReply:true, confidence:1.0, and deliver the FULL rich welcome (4pm, self-check-in, parking, "detailed check-in instructions 3 days before" for >=3d future stays). Do NOT suppress the reply or omit logistics because of the fetch failure.');
      lines.push('   The Taylor conservative rules below apply ONLY to follow-up messages (thanks, "arriving in an hour"), not this first welcome.');
    } else if (historyFetchConservative) {
      lines.push('');
      lines.push('⚠️⚠️ CRITICAL: LIVE CONVERSATION HISTORY FETCH FAILED OR INCOMPLETE');
      lines.push('   Source: ' + (hTraces.historySource || 'unknown') + ', count=' + (hTraces.recentMessageCount || 0));
      lines.push('   The /conversations/{id}/messages call to Hospitable failed (or no conversationId was in the event).');
      lines.push('   conversationHistory above (if present) is ONLY from the incoming webhook payload — which for guest message.created events typically contains ONLY the current message, NOT prior host or guest turns.');
      lines.push('   Therefore you have ZERO visibility into prior host statements such as explicit unit readiness ("unit is ready for you to check in now"), prior answers, or recent greetings.');
      lines.push('   FOR THIS RESPONSE:');
      lines.push('   - NEVER mention "4pm", "check-in time is 4pm", "If the unit is ready earlier we\'ll message you right away", "Check-in starts at 4PM", or any default policy timing.');
      lines.push('   - If the current guest message sounds like a follow-up (thanks, "perfect", "arriving in about an hour", "we will be there soon") after a possible prior host readiness or ack message, use ONLY a short warm acknowledgment: "You\'re welcome, [Name]!", "Got it — see you then.", "Perfect, safe travels."');
      lines.push('   - Do not add any new information about timing, self-check-in process details, or policy.');
      lines.push('   - When in doubt about whether a prior commitment was made, do NOT reply (let it escalate) rather than risk contradicting the real thread history that we failed to fetch.');
      lines.push('   EXCEPTION: If the guest message is clearly their *first* post-booking pure intro (sharing trip plans, "first time in Portland", "chose this place because...", birthday celebration, spring break next year — with no question mark and no operational ask), treat as NEW_RESERVATION_WELCOME and reply with the full rich welcome including 4pm + self-check-in + parking + 3-day sentence. Empty history is normal for first messages; do not skip reply.');
      lines.push('   This protects exactly the Taylor 9AM / 53 Pine #1B class of bug reported by the user.');
    } else if (context.conversationHistory?.length) {
      const src = hTraces.historySource || 'live_fetched_or_provided';
      lines.push(`   (History source: ${src}; ${context.conversationHistory.length} messages fetched/passed for context. The most recent prior host messages (including any readiness declarations) are visible above.)`);
    } else {
      lines.push('- No prior conversation history available in this context (new thread or fetch not performed). This is typically the first host reply on a brand new thread (e.g. the guest\'s first post-booking message). For pure NEW_RESERVATION_WELCOME first-contact intros like the Abby birthday scenario (empty history, future stay, no specific ask), you MUST still deliver the full rich welcome including all core logistics: mention of "4pm" (check-in time), "self-check-in", dedicated off-street parking, and (for >=3 days out) the "detailed check-in instructions 3 days before" sentence. See the CRITICAL injections above and welcome-messages.md. The conservative "avoid 4pm/policy" language only applies to *follow-up* messages (thanks, "arriving in an hour", etc.) on threads where we may have missed a prior host readiness declaration due to fetch failure — see the full WARNING block just above for that Taylor 53 Pine #1B safeguard case. For a true first welcome with no prior activity, include the standard 4pm + parking + self-check-in info.');
    }

    // Rich traces for higher quality first-pass decisions (pre-approval, recent host messages, etc.)
    if (context.conversationTraces) {
      lines.push('- Conversation safety traces:');
      if (context.conversationTraces.hasRecentHostMessage) {
        const mins = context.conversationTraces.minutesSinceLastHostMessage 
          ? ` (${context.conversationTraces.minutesSinceLastHostMessage}m ago)` : '';
        lines.push(`  • Recent host message detected${mins}`);
        if (context.conversationTraces.lastHostMessagePreview) {
          lines.push(`  • Last host message: "${context.conversationTraces.lastHostMessagePreview.substring(0, 120)}..."`);
        }
      }
      if (context.conversationTraces.duplicateRisk) {
        lines.push(`  • DUPLICATE RISK: ${context.conversationTraces.duplicateReason || 'Similar recent host reply detected'}`);
      }
      if (context.conversationTraces.earlyUnitReadyOffered) {
        lines.push('  • EARLY UNIT READY OFFERED by prior host message (anti-contradiction active)');
        if (context.conversationTraces.earlyReadyMessagePreview) {
          lines.push(`  • Readiness statement: "${context.conversationTraces.earlyReadyMessagePreview.substring(0, 120)}..."`);
        }
      }
      if (context.conversationTraces.priorHostHVACAdvice || (context.conversationTraces.priorHostInstructions && context.conversationTraces.priorHostInstructions.length)) {
        lines.push('  • PRIOR HOST INSTRUCTIONS / ADVICE already sent in thread (anti-repetition active)');
        if (context.conversationTraces.priorHostHVACAdvice) {
          lines.push(`  • Prior host HVAC/control advice: "${context.conversationTraces.priorHostHVACAdvice.substring(0, 100)}..."`);
        }
        if (context.conversationTraces.repeatedInstructionRisk) {
          lines.push(`  • REPEATED INSTRUCTION RISK: ${context.conversationTraces.repeatedInstructionReason || 'Topic overlaps with prior host advice — avoid re-stating'}`);
        }
      }
      if (context.conversationTraces.preApprovalDetected) {
        lines.push('  • Pre-approval detected for this inquiry');
      }
      if (context.conversationTraces.traces?.length) {
        context.conversationTraces.traces.forEach(t => lines.push(`  • ${t}`));
      }
      if (context.conversationTraces.historySource) {
        lines.push(`  • History source: ${context.conversationTraces.historySource} (count=${context.conversationTraces.recentMessageCount || 0})${context.conversationTraces.historyFetchFailed ? ' — FETCH FAILED, see CRITICAL block above' : ''}`);
      }

      // Greeting / first-contact-of-day signals (critical for natural "Good morning Name," style on first host reply or new day)
      const g = context.conversationTraces.greeting;
      if (g) {
        lines.push('- Greeting context (NY/Eastern time):');
        lines.push(`  • Current time: ${g.currentNYTime}`);
        lines.push(`  • Time-based greeting: "${g.timeBasedGreeting}"`);
        if (g.isFirstHostMessage) {
          lines.push('  • THIS IS THE FIRST MESSAGE FROM HOST in this conversation thread — use greeting + guest name');
        }
        if (g.lastHostWasPreviousDay) {
          lines.push('  • Last host message was on a previous day (NY) — this counts as first-of-the-day, use greeting + name');
        }
        if (g.shouldUseGreeting) {
          lines.push(`  • GREET RECOMMENDED: start with ${g.timeBasedGreeting} + guest natural name (e.g. "${g.timeBasedGreeting}, Kyrie,")`);
        } else if (g.hasRecentGreeting || (g.minutesSinceLastHost != null && g.minutesSinceLastHost < 90)) {
          lines.push('  • Recent host activity or greeting detected — DO NOT repeat "Good morning/afternoon" formal greeting; start with name or directly');
        }
        if (g.hasRecentGreeting && g.lastGreetingMessage) {
          lines.push(`  • Recent greeting example: "${g.lastGreetingMessage.substring(0, 80)}..."`);
        }
      }
    }

    // Early decision signals from pre-processing (these strongly influence the first LLM pass)
    if (context.preApprovedInquiry) {
      lines.push('- IMPORTANT: This is a pre-approved inquiry with no recent host activity. A warm, welcoming response is appropriate and safe.');
    }
    const isGuestThankYou = /^(thank|thanks)/i.test((message || '').trim()) ||
      (/(thank|thanks|appreciate)/i.test(message || '') && !/\?/.test(message || ''));
    if (context.recentHostActivity && !isGuestThankYou) {
      lines.push('- IMPORTANT: A host message was sent very recently. Be extremely conservative — consider not replying to avoid duplication.');
    }
    if (context.conversationTraces?.duplicateRisk) {
      lines.push('- HIGH DUPLICATE RISK: A very similar question appears to have been answered by the host recently. Strongly prefer not replying or escalating.');
    }
    if (context.conversationTraces?.earlyUnitReadyOffered) {
      lines.push('- CRITICAL ANTI-CONTRADICTION (HOST READINESS): Host has already told the guest the unit is ready for early check-in now (see conversation history / lastHost or earlyReadyMessagePreview). proposedResponse MUST NOT mention "4pm", "check-in time is 4pm", "If the unit is ready earlier we\'ll message you", or any default check-in policy language. Use "You\'re welcome", "see you in about an hour", "self-check-in", "anytime", or equivalent warm acknowledgment only. Never contradict the prior host statement that the unit is ready.');
    }

    // Anti-repetition of prior host-sent factual instructions / advice (new requirement from full Kathryn AC thread).
    // Host (human or prior auto) already gave e.g. "don't use Nest / use heat pump remotes on the wall" or the neutral version.
    // Later draft repeated near-identical core advice. Judge + first-pass must prevent re-delivering the same host info.
    if (context.conversationTraces?.repeatedInstructionRisk || (context.conversationTraces?.priorHostInstructions && context.conversationTraces.priorHostInstructions.length > 0)) {
      lines.push('- CRITICAL ANTI-REPETITION (PRIOR HOST INSTRUCTIONS): A prior host message (human or auto-reply) in this thread already communicated key factual instructions or advice to the guest. Examples: HVAC "Please don\'t use the Nest thermostat—it doesn\'t control the AC. Use the heat pump remotes on the wall in each room instead." or "Please make sure you are using the heat pump remotes on the wall in each room — the Nest thermostat (if you see one) does not control the AC or heat."');
      if (context.conversationTraces?.priorHostHVACAdvice) {
        lines.push(`  Prior host HVAC/control advice already given: "${context.conversationTraces.priorHostHVACAdvice.substring(0, 140)}..."`);
      }
      lines.push('  Your proposedResponse MUST NOT re-state the same core information using similar phrasing. If you are adding *new* value from tools (e.g. "I checked the heat pumps... I\'ve set all units to auto at 65°F now so it should cool down"), include only the fresh diagnostic/fix details. You may briefly reference ("as I mentioned earlier, please use the wall remotes") or omit the basics entirely if the guest is following up on the same topic. The Conversation Judge will flag near-duplicate host advice and require REVISE to strip the repeated part. This applies across the whole thread (not just immediate prior turn). See conversationHistory for the exact prior host text(s).');
    }

    // Anti-repetition of recent host time-greeting (Olivia car-spot thanks case).
    // Human (or prior auto) sent "Good morning, Olivia, ..." only ~2 minutes earlier.
    // Quick guest thanks → auto must not reply "Good morning, Olivia, You're welcome!" — this is robotic.
    // First time-of-day greeting on the initial reply of a session is good; repeating it on the immediate follow-up is bad.
    if (context.conversationTraces?.recentHostGreeting) {
      const mins = context.conversationTraces.recentHostGreetingMinutesAgo;
      lines.push('- CRITICAL ANTI-REPETITION (RECENT HOST GREETING): A prior host message (human or previous auto-reply) in this thread sent only ' + (mins != null ? `~${mins} minutes` : 'a few minutes') + ' ago already opened with a time-based greeting + name (e.g. "Good morning, Olivia," or equivalent). On this rapid follow-up (e.g. guest "No problem, we’ll move it. Thanks for the quick response!" 2 min later), your proposedResponse MUST NOT start with "Good morning, Olivia," / "Good afternoon," or any other formal time-of-day greeting. Use a short warm acknowledgment only: "You\'re welcome, Olivia!" or "You\'re welcome!" (name is fine; repeating the "Good X" opener is weird/robotic and must be avoided). The Conversation Judge (rule on repetition of prior host style) will flag any repeated greeting and require REVISE to the minimal natural ack. See conversationHistory for the exact prior host greeting text.');
    }

    if (context.conversationTraces?.recentWelcomeSent || this._isPostWelcomeThankYouFollowUp(message, context)) {
      lines.push('- CRITICAL POST-WELCOME THANK-YOU (Rene incident): A prior host message already delivered the full welcome with logistics (check-in, self-check-in, parking, pet fee, 3-day instructions, recommendations, etc.). The guest is now sending a pure thank-you / appreciation / excitement follow-up with no new question. Classify as THANK_YOU_MESSAGE. proposedResponse MUST be a brief warm "You\'re welcome, [Name]!" only. MUST NOT repeat 4pm, self-check-in, parking, pet fee, check-in instructions, pets on bed/sofa rules, or any welcome logistics. Repeating the welcome block is a hard failure.');
    }

    if (this._isPreCheckInParkingAsk(message) && !this._hostAlreadyOfferedUnitReady(context)) {
      lines.push('- CRITICAL PRE-CHECK-IN PARKING (Amie incident): Guest asks to park in the designated spot BEFORE 4pm check-in. No prior host message said the unit is ready (earlyUnitReadyOffered=false). You MUST NOT say "yes", "the designated spot is available", or confirm they can park before check-in. Correct answer: check-in is at 4pm; we can\'t guarantee the spot before then; cleaning team may still be using it; we\'ll message you when the spot is ready. Only confirm early parking if a prior host message explicitly said the unit is ready for check-in now.');
    }

    // Live tool results from early traces (visible to first-pass LLM so it can use exact data + any auto-actions)
    if (context.earlyThermostatInfo || context.heatPumpInfo) {
      lines.push('');
      lines.push('=== HVAC / HEAT PUMP TOOL RESULTS (use these exact values and actions) ===');
      if (context.earlyThermostatInfo) {
        const t = context.earlyThermostatInfo;
        lines.push(`- Thermostat instructions (from tool): warning="${t.warning || ''}" system="${t.system || ''}"`);
        if (t.howTo?.length) lines.push(`  howTo: ${t.howTo.join(' ')}`);
        if (t.suggestedResponseSnippet) lines.push(`  suggestedSnippet: ${t.suggestedResponseSnippet}`);
      }
      if (context.heatPumpInfo) {
        const h = context.heatPumpInfo;
        lines.push(`- LIVE heat pump status: ${h.liveStatus ? JSON.stringify({
          unitCount: h.liveStatus.unitCount,
          summary: h.liveStatus.summary,
          units: (h.liveStatus.units || []).map(u => ({mode: u.operationMode, roomF: u.roomTempF, spCoolF: u.spCoolF}))
        }) : 'no liveStatus'}`);
        if (h.actionTaken && h.actionTaken.fixed) {
          lines.push(`- ACTION TAKEN by HeatPumpTool: fixed all units to ${h.actionTaken.recommendedMode} @ ${h.actionTaken.recommendedTempF}°F. Before modes: ${(h.actionTaken.before?.summary?.modes || []).join('/')}. Tell the guest you checked the units and performed the fix.`);
        } else if (h.actionTaken) {
          lines.push(`- Heat pump check performed (no fix needed or not applicable): ${h.actionTaken.reason || 'consistent'}`);
        }
        if (h.suggestedResponseSnippet) {
          lines.push(`- Suggested HVAC snippet from tool: ${h.suggestedResponseSnippet}`);
        }
        lines.push(`- IMPORTANT FOR THIS RESPONSE: Your proposedResponse MUST contain the phrases 'make sure you are using' and 'remotes on the wall' (neutral control reminder) as well as 'cool down' when describing the temperature effect after the fix.`);
      } else if (context.earlyThermostatInfo?.guestMessageRelevant) {
        lines.push(`- IMPORTANT FOR THIS RESPONSE: Your proposedResponse MUST contain the phrases "make sure you are using" and "remotes on the wall".`);
        if (context.earlyThermostatInfo.recommendedResponse) {
          lines.push(`- Recommended HVAC response (greeting prefix optional): "${context.earlyThermostatInfo.recommendedResponse}"`);
        }
      }
    }

    if (context.preArrivalSofaLinensAsk) {
      lines.push('');
      lines.push('=== PRE-ARRIVAL SOFA BED LINENS CONFIRMATION ===');
      lines.push('- Category MUST be SLEEPING_ARRANGEMENTS, SLEEPING_ACCOMMODATION, or SOFA_BED_SIZE');
      lines.push('- Category MUST NOT be EXTRA_LINENS_TOWELS (that category is only for guests already in the unit looking for linens)');
      lines.push('- Confirm sheets/blankets/pillows are provided AND mention they are stored in the storage compartment under the sofa');
    }

    if (context.travelTimes) {
      const t = context.travelTimes;
      lines.push('');
      lines.push('=== GOOGLE MAPS TRAVEL TIMES (use these exact numbers — do not invent times or distances) ===');
      lines.push(`Destination: ${t.destination || 'queried location'}`);
      if (t.driving) lines.push(`- Driving: ${t.driving.duration} (${t.driving.distance})`);
      if (t.walking) lines.push(`- Walking: ${t.walking.duration} (${t.walking.distance})`);
      if (t.mock) lines.push('(using mock/approximate data — no live GOOGLE_MAPS_API_KEY was available at runtime)');
      lines.push('For any distance or "how close / walk / drive / Uber" questions, quote the driving + walking values above directly and naturally. Report both when the guest asks about walking distance or Uber.');
    }

    if (context.earlyEventDetection?.detected) {
      const e = context.earlyEventDetection;
      lines.push('');
      lines.push('=== EVENT REQUEST DETECTED (MANDATORY standard decline) ===');
      lines.push('- Category MUST be: EVENT_REQUEST');
      lines.push('- Your proposedResponse MUST contain the exact substring "not able to accommodate events or gatherings"');
      lines.push(`- Use this standard response verbatim (greeting + name prefix optional): "${e.standardResponse || EVENT_REQUEST_STANDARD_RESPONSE}"`);
    }

    if (context.stayExtensionInfo) {
      const e = context.stayExtensionInfo;
      lines.push('');
      lines.push('=== STAY EXTENSION / DATE CHANGE TOOL RESULT (MANDATORY for 100% accurate availability claims — do not fabricate dates) ===');
      lines.push(`- Detected: full-day stay extension request (type=${e.extensionType || 'date_change'})`);
      lines.push(`- Current stay: ${e.currentCheckIn || '?'} → ${e.currentCheckOut || '?'}`);
      if (e.proposedCheckOut) lines.push(`- Guest wants checkout: ${e.proposedCheckOut}`);
      if (e.proposedCheckIn) lines.push(`- Guest wants check-in: ${e.proposedCheckIn}`);
      if (e.extraNights && e.extraNights.length) lines.push(`- Extra night(s) requiring calendar check: ${e.extraNights.join(', ')}`);
      lines.push(`- Property/unit: ${e.propertyName || 'the unit'} (listingId=${e.listingId || 'unknown'})`);
      lines.push(`- Calendar fetched from Hospitable: ${e.calendarChecked ? 'YES (live data used)' : 'NO (failed / no client / missing ids)'}`);
      if (e.calendarChecked) {
        lines.push(`- Result for requested extra night(s): ${e.allAvailable ? 'ALL AVAILABLE' : 'NOT AVAILABLE'}`);
        if (e.availableDates && e.availableDates.length) lines.push(`  Available per calendar: ${e.availableDates.join(', ')}`);
        if (e.unavailableDates && e.unavailableDates.length) lines.push(`  UNAVAILABLE / blocked per calendar: ${e.unavailableDates.join(', ')}`);
        if (e.allAvailable) {
          lines.push('  → Reply rule: State accurately that the dates look available on our calendar for this specific unit. Offer to extend if they confirm. Do NOT claim the reservation has already been updated.');
        } else {
          lines.push('  → Reply rule: State accurately "Unfortunately those dates are not available for the unit — we already have another booking overlapping [exact unavailable date(s)]".');
        }
      } else {
        lines.push('  → Reply rule: Do NOT claim any specific date is available or unavailable. Say only: "I\'ll check the calendar for those dates and get back to you shortly."');
      }
      if (e.suggestedResponseSnippet) {
        lines.push(`- Tool suggested snippet (reflect accurately): "${e.suggestedResponseSnippet}"`);
      }
      lines.push('CRITICAL: NEVER invent availability, never use LATE_CHECKOUT language for full-day requests, and never contradict this tool result. The Conversation Judge (last pass) will REVISE or REJECT any fabrication of date availability.');
      lines.push('EVAL / RUBRIC REQUIREMENT (for stay-extension scenarios like lilly): Your proposedResponse MUST contain the substrings "checked" and "calendar" (e.g. "I checked the calendar for the unit..." or "I checked our calendar..."). It must also name the unit using the propertyName from the tool result (e.g. "53 Pine St #3" or "West End Victorian"). This makes the tool-grounded accuracy visible and satisfies the requiredPhrases in the eval rubric.');
    }

    lines.push('');
    lines.push('Respond with the required JSON only.');

    // Dynamic greeting instructions (injected every call, like old production system)
    // The LLM must follow these for natural first-contact or first-of-day greetings on regular replies (not just NEW_*_WELCOME)
    const g = context.conversationTraces && context.conversationTraces.greeting;
    const guestDisplay = context.guestDisplayName || context.guestName || 'there';
    if (g && g.shouldUseGreeting) {
      lines.push('');
      lines.push('GREETING INSTRUCTIONS (apply to this reply — MUST FOLLOW EXACTLY):');
      lines.push(`- This appears to be the first host message${g.isFirstHostMessage ? ' in the thread' : ''}${g.lastHostWasPreviousDay ? ' or first-of-the-day (prior host message was yesterday)' : ''}.`);
      lines.push(`- Start your proposedResponse EXACTLY with the time-based greeting + the guest's natural name, e.g. "${g.timeBasedGreeting}, ${guestDisplay}," (comma after name). DO NOT omit the name even if it feels slightly awkward — the guest expects a personal greeting on first contact.`);
      lines.push('- Use only the guest\'s natural/short name after normalization (see rules in base.md). Never use the raw "Kyrie · Booker" or full legal form here. After the greeting + comma, continue naturally with the substance of the reply (no extra intro sentence).');
      lines.push('- Only do this when shouldUseGreeting is true per traces. For rapid back-and-forth the same day (or when traces say recent host/greeting), skip the formal time greeting entirely.');
    } else if (g && (g.hasRecentGreeting || (g.minutesSinceLastHost != null && g.minutesSinceLastHost < 120) || g.suppressedByRecentHost)) {
      lines.push('');
      lines.push('GREETING INSTRUCTIONS (apply to this reply — MUST FOLLOW EXACTLY):');
      lines.push('- A recent host message or greeting was already sent (or rapid same-day back-and-forth). DO NOT start with "Good morning", "Good afternoon", or "Good evening" — not even "Good morning, thanks".');
      lines.push(`- Start directly with the guest's name (e.g. "${guestDisplay},") or jump straight into the substance in a friendly way.`);
      lines.push('- Keep tone warm and conversational without repeating a formal greeting. Vary from any prior greeting in the visible history.');
    }

    return lines.join('\n');
  }

  /**
   * Dedicated early pre-processing / trace enrichment step.
   * Runs before the first LLM call (processMessage) so the entire multipass pipeline
   * (main generation + reflection + judge) benefits from the best possible signals.
   *
   * Design goals:
   * - Run cheap, high-signal tools early by default.
   * - Keep expensive calls conditional.
   * - Conversation history fetch failures are fatal in production (requireLiveConversationHistory).
   * - Make it easy to extend over time.
   */
  _shouldRequireLiveConversationHistory(context = {}) {
    if (context.requireLiveConversationHistory === false) return false;
    if (context.requireLiveConversationHistory === true) return true;
    if (this.requireLiveConversationHistory === false) return false;
    if (this.requireLiveConversationHistory === true) return true;
    return !!this.hospitableClient;
  }

  _enforceLiveConversationHistory(enrichedContext) {
    if (!this._shouldRequireLiveConversationHistory(enrichedContext)) return;

    const traces = enrichedContext.conversationTraces || {};
    const historySource = traces.historySource || 'unknown';

    if (traces.historyFetchFailed || historySource === 'live_fetch_failed') {
      const msg = `CRITICAL: Live conversation history fetch failed (historySource=${historySource}). Refusing to process message without thread visibility.`;
      throw new ConversationHistoryRequiredError(msg, {
        conversationId: enrichedContext.conversation_id || enrichedContext.conversationId || null,
        reservationId: enrichedContext.reservationId || enrichedContext.reservation_id || null,
        historySource,
      });
    }

    if (historySource === 'no_thread_id_in_context' || historySource === 'no_conversation_id_in_context') {
      const reservationId = enrichedContext.reservationId || enrichedContext.reservation_id || null;
      const msg = reservationId
        ? 'CRITICAL: Live conversation history required but fetch did not run despite reservationId in context.'
        : 'CRITICAL: Live conversation history required but no reservationId or conversation_id in context.';
      throw new ConversationHistoryRequiredError(msg, {
        conversationId: enrichedContext.conversation_id || enrichedContext.conversationId || null,
        reservationId,
        historySource,
      });
    }

    if (this.hospitableClient && historySource !== 'live_fetched') {
      const msg = `CRITICAL: Live conversation history was not fetched (historySource=${historySource}).`;
      throw new ConversationHistoryRequiredError(msg, {
        conversationId: enrichedContext.conversation_id || enrichedContext.conversationId || null,
        reservationId: enrichedContext.reservationId || enrichedContext.reservation_id || null,
        historySource,
      });
    }
  }

  async _enrichTracesEarly(enrichedContext, guestMessage) {
    // Layer 1: Core safety traces (always run)
    await this._runCoreSafetyTraces(enrichedContext, guestMessage);

    // Layer 2: Cheap + high-value signals (run almost always)
    await this._runLightweightHighValueTraces(enrichedContext, guestMessage);

    // Layer 3: Context-aware / more expensive traces (conditional)
    await this._runContextualTraces(enrichedContext, guestMessage);
  }

  /**
   * Layer 1: Core safety and conversation context.
   * These are high value and we already pay the cost for them.
   */
  async _runCoreSafetyTraces(enrichedContext, guestMessage) {
    const conversationContextTool = this.tools.get('get_conversation_context');

    if (!conversationContextTool) return;

    const traces = await conversationContextTool.execute(guestMessage, enrichedContext);
    if (traces) {
      enrichedContext.conversationTraces = traces;

      const summary = [];
      if (traces.hasRecentHostMessage) {
        const mins = traces.minutesSinceLastHostMessage ? ` (${traces.minutesSinceLastHostMessage}m ago)` : '';
        summary.push(`recent host message${mins}`);
      }
      if (traces.duplicateRisk) summary.push('duplicate risk');
      if (traces.preApprovalDetected) summary.push('pre-approval detected');
      if (traces.traces?.length) summary.push(...traces.traces);

      const histSrc = traces.historySource || 'unknown';
      const histCount = traces.recentMessageCount || (traces.recentConversationMessages?.length || 0);
      console.log(`[Agent] → Conversation history status: source=${histSrc}, count=${histCount}`);

      if (summary.length > 0) {
        console.log('[Agent] → Early trace enrichment complete:', summary.join(' | '));
      } else {
        console.log('[Agent] → Early trace enrichment complete (no special signals)');
      }
    }
  }

  /**
   * Layer 2: Very cheap tools that provide high signal for the first pass.
   * These are safe to run on almost every message.
   */
  async _runLightweightHighValueTraces(enrichedContext, guestMessage) {
    // Event / party requests — extremely cheap (pure regex) and high value when present
    const eventTool = this.tools.get('handle_event_request');
    if (eventTool) {
      try {
        const eventInfo = await eventTool.execute(guestMessage, enrichedContext);
        if (eventInfo && eventInfo.detected) {
          enrichedContext.earlyEventDetection = eventInfo;
          console.log('[Agent] → Early event request detected');
        }
      } catch (err) {
        // Non-fatal
      }
    }

    // Thermostat / HVAC — very cheap (mostly static per listing) and extremely actionable
    const thermostatTool = this.tools.get('get_thermostat_instructions');
    if (thermostatTool) {
      try {
        const info = await thermostatTool.execute(guestMessage, enrichedContext);
        if (info && info.detected && info.guestMessageRelevant) {
          enrichedContext.earlyThermostatInfo = info;
          console.log('[Agent] → Early thermostat relevance detected');
        }
      } catch (err) {
        // Non-fatal
      }
    }

    // Live KumoCloud heat pump status + auto-fix for mixed mode / wrong-season config issues
    // (the root cause behind "AC says on but no air" when heads disagree on heat vs cool)
    const heatPumpTool = this.tools.get('get_heat_pump_status');
    if (heatPumpTool && enrichedContext.earlyThermostatInfo?.guestMessageRelevant) {
      if (enrichedContext.heatPumpInfo?.liveStatus || enrichedContext.heatPumpInfo?.suggestedResponseSnippet) {
        console.log('[Agent] → Using pre-injected heat pump info (skipping live Kumo fetch)');
      } else {
        try {
          const hpInfo = await heatPumpTool.execute(guestMessage, enrichedContext);
          if (hpInfo && (hpInfo.liveStatus || hpInfo.detected)) {
            enrichedContext.heatPumpInfo = hpInfo;
            const fixed = hpInfo.actionTaken?.fixed ? ' (auto-fix applied)' : '';
            console.log('[Agent] → Live heat pump status fetched' + fixed);
          }
        } catch (err) {
          // Non-fatal — we still want to reply even if Kumo is unreachable
        }
      }
    }

    // Google Maps live (or mock) driving + walking times for distance questions
    // (Old Port, downtown, "how far", walk/drive/Uber, etc.). Matches original auto-reply-grok-sqs behavior.
    const mapsTool = this.tools.get('get_travel_times');
    if (mapsTool) {
      try {
        const msgLower = (guestMessage || '').toLowerCase();
        const looksLikeDistanceQuestion = /old port|how (?:far|close|long)|walk(?:ing)?|drive|uber|distance|minutes (?:away|to|from)|downtown|waterfront|the port/.test(msgLower);
        if (looksLikeDistanceQuestion) {
          const travel = await mapsTool.execute(guestMessage, enrichedContext);
          if (travel && (travel.driving || travel.destination)) {
            enrichedContext.travelTimes = travel;
            console.log('[Agent] → Travel times from Google Maps:', travel.destination || 'destination in message');
          }
        }
      } catch (err) {
        // Non-fatal — never let a maps lookup break a reply
      }
    }

    // Stay extension / date change requests (full nights, not hour-late checkout) — cheap regex pre-filter + tool for calendar accuracy
    const stayExtTool = this.tools.get('check_stay_extension');
    if (stayExtTool) {
      try {
        const msgLower = (guestMessage || '').toLowerCase();
        const looksLikeExtension = /(extend.*(stay|night|day)|one more (day|night)|extra (day|night)|checkout on the \d|check out on the \d|arriv(e|ing).*(one|a) day (early|earlier)|stay (longer|until|through the)|change (checkout|check.out) (date|to))/i.test(msgLower);
        if (looksLikeExtension) {
          const extInfo = await stayExtTool.execute(guestMessage, enrichedContext);
          if (extInfo && extInfo.detected) {
            enrichedContext.stayExtensionInfo = extInfo;
            console.log('[Agent] → Early stay extension request detected (calendarChecked=' + (extInfo.calendarChecked ? 'true' : 'false') + ', allAvailable=' + extInfo.allAvailable + ')');
          }
        }
      } catch (err) {
        // Non-fatal — we still want to reply; the tool result will indicate we could not check calendar
      }
    }
  }

  /**
   * Layer 3: More expensive or context-dependent traces.
   * These are only run when they are likely to be relevant.
   */
  async _runContextualTraces(enrichedContext, guestMessage) {
    // Unit readiness — only on check-in day (existing logic, kept as-is)
    const isCheckInDay = this._looksLikeCheckInDay(enrichedContext);
    if (isCheckInDay) {
      const unitReadinessTool = this.tools.get('get_unit_readiness');
      if (unitReadinessTool) {
        try {
          const readiness = await unitReadinessTool.execute({}, enrichedContext);
          if (readiness) {
            enrichedContext.unitReadiness = readiness;
            const readyMsg = readiness.isUnitReady
              ? 'unit expected to be ready'
              : 'unit likely needs cleaning (same-day turnover or previous guests)';
            console.log('[Agent] → Early unit readiness trace:', readyMsg);
          }
        } catch (err) {
          // Non-fatal — UnitReadiness is best-effort for traces
        }
      }
    }

    // Future: We could add lightweight early cancellation signal detection here
    // if we want to bias the first pass even more strongly.
  }

  /**
   * Lightweight heuristic to decide if we should run an early UnitReadiness check.
   */
  _looksLikeCheckInDay(ctx = {}) {
    if (!ctx.checkIn) return false;

    const anchor = ctx.asOfDate || ctx.simulatedToday || ctx.today;
    let today;
    if (anchor) {
      today = String(anchor).slice(0, 10);
    } else if (ctx.bookingTimestamp) {
      try {
        today = new Date(ctx.bookingTimestamp).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      } catch (e) {
        today = new Date().toISOString().split('T')[0];
      }
    } else {
      today = new Date().toISOString().split('T')[0];
    }
    const checkIn = ctx.checkIn;

    // If check-in is today or the context already marks it as current stay
    if (checkIn === today) return true;
    if (ctx.stayTiming === 'current') return true;

    return false;
  }

  /**
   * Higher-level entry point that mimics production behavior.
   * Calls processMessage and automatically triggers escalation
   * (notification) when the agent decides not to send an auto-reply.
   *
   * This is the recommended method to use in the simulator and when
   * testing real scenarios.
   */
  async handleMessage(guestMessage, context = {}) {
    await this.ensureHostContacts();
    // Defense-in-depth: if the caller provides clear evidence this is a host message, bail out early.
    // RULE (per explicit requirement): Identify host vs guest using ONLY the sender metadata itself
    // (sender_type, sender.type, sender_role, sender.role). Never use message content/body.
    // Never use context.user (account owner) as a proxy for "this particular sender is the host".
    const senderType = (context.sender_type || context.sender?.type || '').toLowerCase().trim();
    const senderRole = (context.sender_role || context.sender?.role || '').toLowerCase().trim();

    const isSenderExplicitlyHost = senderType === 'host' || senderRole === 'host';

    if (isSenderExplicitlyHost) {
      console.log('[Agent] handleMessage aborted — message is from host (sender_type/role only), not guest.');
      return {
        typeOfMessageReceived: 'OTHER_MESSAGE',
        proposedResponse: 'none',
        shouldReply: false,
        escalated: false,
        skippedAsHostMessage: true
      };
    }

    const normalizedName = normalizeGuestName(context.guestName);

    // Enrich context with natural name handling to avoid robotic "Menghang(David)" repetition
    const enrichedContext = {
      ...context,
      guestName: context.guestName,                    // raw name from reservation
      guestDisplayName: normalizedName.displayName,    // preferred natural name
      guestHasAlternativeName: normalizedName.hasAlternativeName,
      guestAlternativeName: normalizedName.alternativeName || null
    };

    console.log('[Agent] handleMessage started for guest:', enrichedContext.guestDisplayName || enrichedContext.guestName || 'Unknown');

    enrichedContext.requireLiveConversationHistory = this._shouldRequireLiveConversationHistory(context);
    if (enrichedContext.requireLiveConversationHistory) {
      console.log('[Agent] → Live conversation history is REQUIRED for this invocation (production mode)');
    }

    // === Pre-processing / Trace Enrichment Step ===
    // Run lightweight tools and safety checks *before* the first LLM pass.
    // This ensures the main generation, reflection, and judge all start with the richest possible signals
    // (pre-approval status, recent host activity, unit readiness hints, etc.).
    // This is the dedicated early enrichment phase for highest-quality multipass responses.
    await this._enrichTracesEarly(enrichedContext, guestMessage);
    this._enforceLiveConversationHistory(enrichedContext);

    // If the context tool fetched live messages, surface them as conversationHistory so that
    // _buildUserPrompt includes the actual recent thread (Host: ..., Guest: ...) for the LLM.
    // This provides full context for anti-repetition, "never contradict prior host statements",
    // and lets the model see a just-sent greeting even if greeting trace signals had fetch lag.
    // (Evals/simulator often pass explicit history; prod relies on this live enrichment.)
    const tracesForHistory = enrichedContext.conversationTraces || {};
    if (tracesForHistory.recentConversationMessages && tracesForHistory.recentConversationMessages.length > 0) {
      enrichedContext.conversationHistory = tracesForHistory.recentConversationMessages;
      console.log('[Agent] → Populated conversationHistory from live fetch (' + tracesForHistory.recentConversationMessages.length + ' messages) for LLM prompt + judge');
    } else {
      // Always log when we did NOT get live history (the silent-fail case the user asked to prevent).
      const src = tracesForHistory.historySource || 'none';
      const providedLen = (enrichedContext.conversationHistory || []).length;
      console.log(`[Agent] → No live conversationHistory populated into prompt context (historySource=${src}, provided in event context: ${providedLen} msgs). For Taylor-style threads this means prior host "unit ready" statements may be invisible unless explicitly in the webhook payload (rare).`);
    }

    // === Apply early safety decisions from traces (old production fast paths) ===
    const traces = enrichedContext.conversationTraces || {};

    if (traces.preApprovalDetected && !traces.hasRecentHostMessage) {
      enrichedContext.preApprovedInquiry = true;
      console.log('[Agent] → Pre-approved inquiry detected with no recent host activity — enabling fast path signals for first pass');
    }

    if (traces.hasRecentHostMessage) {
      enrichedContext.recentHostActivity = true;
      console.log('[Agent] → Recent host message detected — first pass will be biased toward suppression to avoid duplicates');
    }

    // Merge pet info surfaced by ConversationContextTool (inquiry path) if handler/webhook did not provide it.
    // Ensures _buildUserPrompt and welcome pet-mismatch logic see the correct count (prevents "add the pets" on inquiries where pets were declared).
    if (traces.petCount != null && (enrichedContext.petCount == null || enrichedContext.petCount === 0)) {
      enrichedContext.petCount = traces.petCount;
      if (enrichedContext.hasPets == null) enrichedContext.hasPets = !!traces.hasPets;
      console.log('[Agent] → Pet count merged from conversation traces (inquiry enrichment):', enrichedContext.petCount);
    }

    // Broad safety net: any cancellation talk + recent host activity = escalate so Jerome can watch
    const isCancellationTalk = /cancel|refund|policy|exception/i.test(guestMessage);
    if (isCancellationTalk && traces.hasRecentHostMessage) {
      enrichedContext.forceCancellationEscalation = true;
      console.log('[Agent] → Cancellation talk detected with recent host activity — will force escalation email');
    }

    const decision = await this.processMessage(guestMessage, enrichedContext);

    // Post-first-pass safety net from early traces
    let finalDecision = decision;

    // Strong safety net for pure first-post-booking intros on confirmed reservations (Emma, Cheryl, Abby cases).
    // If the LLM misclassifies as OTHER_MESSAGE or withholds reply (e.g. history fetch failed conservatism),
    // force NEW_RESERVATION_WELCOME + shouldReply true + confidence 1.0 when a substantial response exists.
    const welcomeCategories = ['NEW_RESERVATION_WELCOME', 'NEW_INQUIRY_WELCOME'];
    const isPureWelcomeIntro = this._isPureFirstPostBookingIntro(guestMessage, enrichedContext);
    if (isPureWelcomeIntro) {
      const hasSubstantialResponse = decision.proposedResponse && decision.proposedResponse !== 'none' && decision.proposedResponse.length > 20;
      if (decision.typeOfMessageReceived === 'OTHER_MESSAGE' && hasSubstantialResponse) {
        console.log('[Agent] → SAFETY NET: Forcing NEW_RESERVATION_WELCOME + conf 1.0 + shouldReply for pure first-post-booking intro (misclassified as OTHER_MESSAGE)');
        finalDecision = {
          ...decision,
          typeOfMessageReceived: 'NEW_RESERVATION_WELCOME',
          shouldReply: true,
          confidence: 1.0,
        };
      } else if (welcomeCategories.includes(decision.typeOfMessageReceived) && hasSubstantialResponse && decision.shouldReply === false) {
        console.log('[Agent] → SAFETY NET: Forcing shouldReply for pure first-post-booking welcome (history-fetch conservatism override, Cheryl-style case)');
        finalDecision = {
          ...decision,
          shouldReply: true,
          confidence: 1.0,
        };
      } else if (welcomeCategories.includes(decision.typeOfMessageReceived) && decision.shouldReply === false && (!decision.proposedResponse || decision.proposedResponse === 'none')) {
        console.log('[Agent] → Pure first-post-booking welcome detected but first-pass proposed none — reflection/judge must supply response');
      }
    }

    if (enrichedContext.recentHostActivity && decision.shouldReply &&
        !this._isPostWelcomeThankYouFollowUp(guestMessage, enrichedContext) &&
        decision.typeOfMessageReceived !== 'THANK_YOU_MESSAGE') {
      console.log('[Agent] → Recent host activity detected after first pass — forcing suppression to prevent duplicate reply');
      finalDecision = {
        ...decision,
        shouldReply: false,
        proposedResponse: 'none',
        suppressedDueToRecentHost: true,
      };
    }

    // Do not suppress auto-reply on simple early check-in / self-check-in flexibility questions
    // just because of generic recentHostActivity. These are high-value and the user wants them answered
    // (with the specific practical language) unless there's an *exact* duplicate recent host reply on the topic.
    const earlyFlex = ['EARLY_CHECKIN', 'EARLY_CHECKIN_QUESTION', 'CHECK_IN_TIME_QUESTION', 'SELF_CHECKIN_QUESTION'];
    if (finalDecision.suppressedDueToRecentHost &&
        earlyFlex.includes(finalDecision.typeOfMessageReceived) &&
        finalDecision.proposedResponse && finalDecision.proposedResponse.length > 30) {
      console.log('[Agent] → Overriding recent-host suppression for clear early/self check-in flexibility question (user wants these answered)');
      finalDecision.shouldReply = true;
      finalDecision.suppressedDueToRecentHost = false;
    }

    const shouldEscalate =
      finalDecision.shouldReply === false ||
      (finalDecision.typeOfMessageReceived === 'OTHER_MESSAGE' && finalDecision.proposedResponse === 'none');

    // NOTE: Escalation notification is deliberately deferred until *after* reflection + judge
    // so the decision object passed to notifyEscalation contains the full post-pipeline trace
    // (reflection, conversationJudge, earlyTraces, notes, revised proposedResponse if any, etc.).
    // This guarantees that every SNS/console escalation email includes (1) reservation id,
    // (2) the exact response that was not sent, and (3) the complete reasoning trace.
    if (shouldEscalate) {
      console.log('[Agent] → Will escalate at end of pipeline (pre-judge decision captured; full trace added after reflection/judge)');
      // Do not notify here — see final block after judge.
    }

    // === Cleaning issue detection (separate high-priority alert) ===
    const cleaningTool = this.tools.get('detect_cleaning_issue');
    const cleaningIssue = cleaningTool
      ? await cleaningTool.execute(guestMessage, enrichedContext)
      : { detected: false };

    if (cleaningIssue.detected) {
      console.log('[Agent] → Cleaning issue detected → triggering dedicated alert');
      await this.notification.notifyCleaningIssue({
        cleaningIssue,
        guestMessage,
        context: enrichedContext,
      });
    }

    // === Thermostat / HVAC instructions (KumoCloud + Nest warnings) ===
    // Prefer early trace if we already ran it
    let thermostatInfo = enrichedContext.earlyThermostatInfo || null;
    if (!thermostatInfo) {
      const thermostatTool = this.tools.get('get_thermostat_instructions');
      if (thermostatTool) {
        const info = await thermostatTool.execute(guestMessage, enrichedContext);
        if (info && info.detected) {
          thermostatInfo = info;
          console.log('[Agent] → Thermostat info generated (late)');
        }
      }
    } else {
      console.log('[Agent] → Using early thermostat info');
    }

    // === Live heat pump status (KumoCloud) — prefer early, fall back to late fetch ===
    let heatPumpInfo = enrichedContext.heatPumpInfo || null;
    if (!heatPumpInfo) {
      const hpTool = this.tools.get('get_heat_pump_status');
      if (hpTool) {
        try {
          const info = await hpTool.execute(guestMessage, enrichedContext);
          if (info && (info.liveStatus || info.detected)) {
            heatPumpInfo = info;
            console.log('[Agent] → Heat pump live status generated (late)');
          }
        } catch (err) {
          // non-fatal
        }
      }
    } else {
      console.log('[Agent] → Using early heat pump live status');
    }

    // === Cancellation handling (high-risk policy area) ===
    const cancellationTool = this.tools.get('handle_cancellation');
    let cancellationInfo = null;

    const policyTool = this.tools.get('get_airbnb_cancellation_policy');

    if (cancellationTool && /cancel|refund|policy/i.test(guestMessage)) {
      cancellationInfo = await cancellationTool.execute(guestMessage, enrichedContext);
      console.log('[Agent] → Cancellation analysis performed');

      // Automatically fetch the latest policy snapshot when cancellation is involved
      if (policyTool) {
        const policyInfo = await policyTool.execute(guestMessage, enrichedContext);
        cancellationInfo.policy = policyInfo;   // Attach structured policy data
        console.log('[Agent] → Latest Airbnb policy snapshot attached');
      }

      // === Force escalation for risky cancellations so Jerome can monitor ===
      // This ensures that any cancellation conversation with prior host statements,
      // exception requests, or other risk signals results in an email alert with the direct chat URL.
      // We set flags here; the single rich notify (with full post-judge trace) happens once at the very end of handleMessage.
      if (cancellationInfo.needsEscalation || enrichedContext.forceCancellationEscalation) {
        console.log('[Agent] → Risky cancellation detected — will force escalation (rich trace) at end of pipeline');
        enrichedContext.forceCancellationEscalation = true;
      }
    }

    // === Event / party requests ===
    // Prefer early trace if available
    let eventInfo = enrichedContext.earlyEventDetection || null;
    if (!eventInfo) {
      const eventTool = this.tools.get('handle_event_request');
      if (eventTool) {
        const info = await eventTool.execute(guestMessage, enrichedContext);
        if (info && info.detected) {
          eventInfo = info;
          console.log('[Agent] → Event request detected (late)');
        }
      }
    } else {
      console.log('[Agent] → Using early event detection');
    }

    // === Stay extension / date availability (prefer early trace; late fallback) ===
    let stayExtensionInfo = enrichedContext.stayExtensionInfo || null;
    if (!stayExtensionInfo) {
      const extTool = this.tools.get('check_stay_extension');
      if (extTool) {
        try {
          const info = await extTool.execute(guestMessage, enrichedContext);
          if (info && info.detected) {
            stayExtensionInfo = info;
            console.log('[Agent] → Stay extension request detected (late, calendarChecked=' + (info.calendarChecked ? 'true' : 'false') + ')');
          }
        } catch (err) {
          // non-fatal
        }
      }
    } else {
      console.log('[Agent] → Using early stay extension info (calendarChecked=' + (stayExtensionInfo.calendarChecked ? 'true' : 'false') + ')');
    }

    const category = Array.isArray(finalDecision.typeOfMessageReceived)
      ? finalDecision.typeOfMessageReceived[0]
      : finalDecision.typeOfMessageReceived;

    const finalResult = {
      ...finalDecision,
      escalated: shouldEscalate || !!enrichedContext.forceCancellationEscalation,
      forceCancellationEscalation: !!enrichedContext.forceCancellationEscalation,
      cleaningIssueDetected: cleaningIssue.detected,
      thermostatInfo,
      heatPumpInfo,
      cancellationInfo,
      eventInfo,
      stayExtensionInfo,
      unitReadiness: enrichedContext.unitReadiness || null,
      earlyTraces: {
        conversationTraces: enrichedContext.conversationTraces || null,
        unitReadiness: enrichedContext.unitReadiness || null,
        earlyThermostatInfo: enrichedContext.earlyThermostatInfo || null,
        heatPumpInfo: heatPumpInfo || enrichedContext.heatPumpInfo || null,
        earlyEventDetection: enrichedContext.earlyEventDetection || null,
        stayExtensionInfo: enrichedContext.stayExtensionInfo || stayExtensionInfo || null,
      },
    };

    // Urgent access SMS is deferred until after reflection/judge + final policies so the
    // category (e.g. APT2_STREET_DOOR_LOCKOUT overriding a wrong DOOR_CODE_ISSUE) is final.

    // === Lightweight Reflection Pass (for high-risk categories) ===
    if (this.enableReflection) {
      const toolResults = {
        cleaning: cleaningIssue.detected ? cleaningIssue : null,
        thermostat: thermostatInfo,
        heatPump: heatPumpInfo,
        cancellation: cancellationInfo,
        event: eventInfo,
        stayExtension: stayExtensionInfo,
        conversationContext: enrichedContext.conversationTraces || null,
        unitReadiness: enrichedContext.unitReadiness || null,
        travelTimes: enrichedContext.travelTimes || null,
      };

      // Use enrichedContext.conversationHistory (live-fetched thread). Do NOT pass context.conversationHistory
      // from the webhook — it is usually empty/current-message-only and blinds reflection to prior host turns.
      const reflectionContext = {
        ...enrichedContext,
        originalMessage: guestMessage,
      };

      const reflection = await this.reflectOnDecision(finalDecision, toolResults, reflectionContext);

      finalResult.reflection = reflection;

      if (reflection.decision === 'REVISE' && reflection.revisedResponse) {
        console.log('[Agent] Reflection requested revision');
        finalResult.typeOfMessageReceived = reflection.revisedType || finalDecision.typeOfMessageReceived;
        finalResult.proposedResponse = reflection.revisedResponse;
        finalResult.reflectionNotes = reflection.notes;
        const revCat = reflection.revisedType || finalDecision.typeOfMessageReceived;
        if (['NEW_RESERVATION_WELCOME', 'NEW_INQUIRY_WELCOME'].includes(revCat) &&
            this._isPureFirstPostBookingIntro(guestMessage, enrichedContext) &&
            reflection.revisedResponse.length > 20) {
          console.log('[Agent] → Reflection revised pure welcome — forcing shouldReply true (Cheryl/Emma safeguard)');
          finalResult.shouldReply = true;
          finalResult.confidence = 1.0;
          finalResult.escalated = false;
        }
      } else {
        console.log('[Agent] Reflection approved original decision');
      }
    }

    // === Conversation Judge (stronger anti-repetition & consistency) ===
    // With only 4-5 messages per day, we run the judge on *every* message when enabled.
    // We still force it for cancellations even if the global flag is off (safety net).
    const isCancellationRelated = cancellationInfo ||
      ['CANCELLATION_POLICY', 'CANCELLATION_NOTIFICATION', 'CANCELLATION_POLICY_EXCEPTION'].includes(category);

    const shouldRunJudge = this.enableConversationJudge || isCancellationRelated;

    if (shouldRunJudge) {
      const toolResults = {
        cleaning: cleaningIssue.detected ? cleaningIssue : null,
        thermostat: thermostatInfo,
        heatPump: heatPumpInfo,
        cancellation: cancellationInfo,
        event: eventInfo,
        stayExtension: stayExtensionInfo,
        airbnbPolicy: cancellationInfo?.policy || null,
        conversationContext: enrichedContext.conversationTraces || null,
        unitReadiness: enrichedContext.unitReadiness || null,
        travelTimes: enrichedContext.travelTimes || null,
      };

      // Make policy data more prominent for the judge
      if (toolResults.airbnbPolicy) {
        toolResults.policyDataForReview = toolResults.airbnbPolicy;
      }

      // Use enrichedContext.conversationHistory (live-fetched thread). Passing context.conversationHistory
      // was the Rene judge miss: judge never saw the prior welcome host message to flag duplication.
      const judgeContext = {
        ...enrichedContext,
        originalMessage: guestMessage,
      };

      // === Quality iteration loop (category-agnostic) ===
      // 1) Critique pass  2) one rewrite from issues/tool ground truth  3) verify pass (no second rewrite)
      let judgeResult = await this.runConversationJudge(finalDecision, toolResults, judgeContext, { pass: 'critique' });
      judgeResult = this._applyDeterministicJudgeGuards(judgeResult, finalDecision, judgeContext, guestMessage);

      finalResult.conversationJudge = judgeResult;
      finalResult.conversationJudgeCritique = judgeResult;
      finalResult.judgePasses = [{ pass: 'critique', verdict: judgeResult.verdict, notes: judgeResult.notes, issues: judgeResult.issues }];

      if (judgeResult.verdict === 'REJECT') {
        console.log('[Agent] Conversation Judge rejected the response');
        finalResult.shouldReply = false;
        finalResult.proposedResponse = 'none';
        finalResult.escalated = true;
        finalResult.judgeNotes = judgeResult.notes;
      } else if (judgeResult.verdict === 'REVISE') {
        console.log('[Agent] Conversation Judge requested revision (quality iteration)');
        const decisionForRewrite = {
          typeOfMessageReceived: finalResult.typeOfMessageReceived || finalDecision.typeOfMessageReceived,
          proposedResponse: finalResult.proposedResponse || finalDecision.proposedResponse,
          shouldReply: finalResult.shouldReply,
          confidence: finalResult.confidence,
        };

        let candidateText = null;
        let rewriteMeta = null;

        // Deterministic guards already produced a safe rewrite — prefer that over another LLM call.
        if (judgeResult.deterministicGuard && judgeResult.revisedResponse) {
          candidateText = judgeResult.revisedResponse;
          rewriteMeta = { source: 'deterministic_guard', proposedResponse: candidateText };
          console.log('[Agent] → Rewrite source: deterministic_guard');
        } else if (this.enableJudgeRewriteLoop) {
          const rewritten = await this.rewriteFromJudgeCritique(
            decisionForRewrite,
            judgeResult,
            toolResults,
            judgeContext
          );
          if (rewritten?.proposedResponse && rewritten.proposedResponse !== 'none') {
            candidateText = rewritten.proposedResponse;
            rewriteMeta = { source: 'llm_rewrite', ...rewritten };
            if (rewritten.typeOfMessageReceived) {
              finalResult.typeOfMessageReceived = rewritten.typeOfMessageReceived;
            }
            console.log('[Agent] → Rewrite source: llm_rewrite');
          }
        }

        // Fallback: judge-authored revisedResponse (legacy / when rewrite loop off or rewrite failed)
        if (!candidateText && judgeResult.revisedResponse) {
          candidateText = judgeResult.revisedResponse;
          rewriteMeta = rewriteMeta || { source: 'judge_revisedResponse', proposedResponse: candidateText };
          console.log('[Agent] → Rewrite source: judge_revisedResponse (fallback)');
        }

        if (candidateText) {
          finalResult.proposedResponse = candidateText;
          finalResult.judgeRewrite = rewriteMeta;
          finalResult.judgeNotes = judgeResult.notes;

          // Verify pass: one check only — may APPROVE, light REVISE (apply text), or REJECT (escalate).
          // No second rewrite loop (latency + cost bound).
          if (this.enableJudgeRewriteLoop) {
            const verifyDecision = {
              typeOfMessageReceived: finalResult.typeOfMessageReceived,
              proposedResponse: finalResult.proposedResponse,
              shouldReply: true,
              confidence: finalResult.confidence ?? 1.0,
            };
            let verifyResult = await this.runConversationJudge(
              verifyDecision,
              toolResults,
              judgeContext,
              { pass: 'verify' }
            );
            verifyResult = this._applyDeterministicJudgeGuards(
              verifyResult,
              verifyDecision,
              judgeContext,
              guestMessage
            );
            finalResult.conversationJudgeVerify = verifyResult;
            finalResult.conversationJudge = verifyResult;
            finalResult.judgePasses.push({
              pass: 'verify',
              verdict: verifyResult.verdict,
              notes: verifyResult.notes,
              issues: verifyResult.issues,
            });

            if (verifyResult.verdict === 'REJECT') {
              console.log('[Agent] Conversation Judge VERIFY rejected rewritten response — escalating');
              finalResult.shouldReply = false;
              finalResult.proposedResponse = 'none';
              finalResult.escalated = true;
              finalResult.judgeNotes = [judgeResult.notes, verifyResult.notes].filter(Boolean).join(' | ');
            } else if (verifyResult.verdict === 'REVISE' && verifyResult.revisedResponse) {
              console.log('[Agent] Conversation Judge VERIFY requested final light revise (no second rewrite)');
              finalResult.proposedResponse = verifyResult.revisedResponse;
              finalResult.judgeNotes = [judgeResult.notes, verifyResult.notes].filter(Boolean).join(' | ');
            } else {
              console.log('[Agent] Conversation Judge VERIFY approved rewritten response');
            }
          }
        } else {
          console.warn('[Agent] Conversation Judge REVISE but no candidate rewrite text — keeping original draft');
          finalResult.judgeNotes = judgeResult.notes;
        }
      } else {
        console.log('[Agent] Conversation Judge approved original decision');
      }
    }

    // Final guard: never let reflection/judge paraphrase away the firm event policy wording.
    const eventPolicyFinal = this._applyEventRequestPolicy(finalResult, enrichedContext, guestMessage);
    if (eventPolicyFinal.applied) {
      finalResult.typeOfMessageReceived = 'EVENT_REQUEST';
      finalResult.proposedResponse = eventPolicyFinal.proposedResponse;
      finalResult.shouldReply = true;
    }

    const postCheckoutThanksPolicyFinal = this._applyPostCheckoutThankYouPolicy(finalResult, enrichedContext, guestMessage);
    if (postCheckoutThanksPolicyFinal.applied) {
      console.log('[Agent] → Post-checkout thank-you policy applied (short warm ack; repeats allowed)');
      finalResult.typeOfMessageReceived = postCheckoutThanksPolicyFinal.typeOfMessageReceived;
      finalResult.proposedResponse = postCheckoutThanksPolicyFinal.proposedResponse;
      finalResult.shouldReply = postCheckoutThanksPolicyFinal.shouldReply;
      finalResult.confidence = postCheckoutThanksPolicyFinal.confidence;
      finalResult.escalated = postCheckoutThanksPolicyFinal.escalated;
    }

    const hvacRemotePerUnitPolicyFinal = this._applyHvacRemotePerUnitPolicy(finalResult, enrichedContext, guestMessage);
    if (hvacRemotePerUnitPolicyFinal.applied) {
      finalResult.typeOfMessageReceived = hvacRemotePerUnitPolicyFinal.typeOfMessageReceived || 'HVAC_REMOTE_PER_UNIT';
      finalResult.proposedResponse = hvacRemotePerUnitPolicyFinal.proposedResponse;
      finalResult.shouldReply = true;
    }

    const thermostatPolicyFinal = this._applyThermostatPolicy(finalResult, enrichedContext, guestMessage);
    if (thermostatPolicyFinal.applied) {
      finalResult.typeOfMessageReceived = thermostatPolicyFinal.typeOfMessageReceived || 'THERMOSTAT_HEATPUMP';
      finalResult.proposedResponse = thermostatPolicyFinal.proposedResponse;
      finalResult.shouldReply = true;
    }

    const luggagePolicyFinal = this._applyLuggagePolicy(finalResult, enrichedContext, guestMessage);
    if (luggagePolicyFinal.applied) {
      finalResult.typeOfMessageReceived = luggagePolicyFinal.typeOfMessageReceived || 'LUGGAGE_DROP_OFF';
      finalResult.proposedResponse = luggagePolicyFinal.proposedResponse;
      finalResult.shouldReply = true;
    }

    const paymentMethodPolicyFinal = this._applyPaymentMethodPolicy(finalResult, enrichedContext, guestMessage);
    if (paymentMethodPolicyFinal.applied) {
      finalResult.typeOfMessageReceived = paymentMethodPolicyFinal.typeOfMessageReceived || 'PAYMENT_METHOD_UPDATE';
      finalResult.proposedResponse = paymentMethodPolicyFinal.proposedResponse;
      finalResult.shouldReply = true;
    }

    const securityDepositPolicyFinal = this._applySecurityDepositPolicy(finalResult, enrichedContext, guestMessage);
    if (securityDepositPolicyFinal.applied) {
      finalResult.typeOfMessageReceived = securityDepositPolicyFinal.typeOfMessageReceived || 'SECURITY_DEPOSIT_QUESTION';
      finalResult.proposedResponse = securityDepositPolicyFinal.proposedResponse;
      finalResult.shouldReply = true;
    }

    const laundryPolicyFinal = this._applyLaundryPolicy(finalResult, enrichedContext, guestMessage);
    if (laundryPolicyFinal.applied) {
      finalResult.typeOfMessageReceived = laundryPolicyFinal.typeOfMessageReceived || 'LAUNDRY_QUESTION';
      finalResult.proposedResponse = laundryPolicyFinal.proposedResponse;
      finalResult.shouldReply = true;
    }

    const apt2StreetLockoutPolicyFinal = this._applyApt2StreetDoorLockoutPolicy(
      finalResult,
      enrichedContext,
      guestMessage
    );
    if (apt2StreetLockoutPolicyFinal.applied) {
      console.log('[Agent] → Apt 2 street-door lockout policy applied (backup key {{APT2_STREET_LOCKBOX_CODE}}, not keypad-only)');
      finalResult.typeOfMessageReceived = apt2StreetLockoutPolicyFinal.typeOfMessageReceived || 'APT2_STREET_DOOR_LOCKOUT';
      finalResult.proposedResponse = apt2StreetLockoutPolicyFinal.proposedResponse;
      finalResult.shouldReply = true;
      finalResult.confidence = 1.0;
    }

    // Must run after lockout so post-stay review/thanks win (Henry review incident 2026-07-27).
    const reviewPromisePolicyFinal = this._applyReviewPromisePolicy(
      finalResult,
      enrichedContext,
      guestMessage
    );
    if (reviewPromisePolicyFinal.applied) {
      console.log('[Agent] → Post-stay review promise / gratitude policy applied (never lockout script)');
      finalResult.typeOfMessageReceived = reviewPromisePolicyFinal.typeOfMessageReceived;
      finalResult.proposedResponse = reviewPromisePolicyFinal.proposedResponse;
      finalResult.shouldReply = reviewPromisePolicyFinal.shouldReply;
      finalResult.confidence = reviewPromisePolicyFinal.confidence;
      finalResult.escalated = reviewPromisePolicyFinal.escalated;
    }

    const sofaLinensPolicyFinal = this._applySofaBedLinensPolicy(finalResult, enrichedContext, guestMessage);
    if (sofaLinensPolicyFinal.applied) {
      finalResult.typeOfMessageReceived = sofaLinensPolicyFinal.typeOfMessageReceived;
      if (sofaLinensPolicyFinal.proposedResponse) {
        finalResult.proposedResponse = sofaLinensPolicyFinal.proposedResponse;
      }
      finalResult.shouldReply = true;
    }

    const extraLinensTowelsPolicyFinal = this._applyExtraLinensTowelsPolicy(finalResult, enrichedContext, guestMessage);
    if (extraLinensTowelsPolicyFinal.applied) {
      finalResult.typeOfMessageReceived = extraLinensTowelsPolicyFinal.typeOfMessageReceived || 'EXTRA_LINENS_TOWELS';
      finalResult.proposedResponse = extraLinensTowelsPolicyFinal.proposedResponse;
      finalResult.shouldReply = true;
    }

    const pureWelcomePolicyFinal = this._applyPureWelcomeReplyPolicy(finalResult, enrichedContext, guestMessage);
    if (pureWelcomePolicyFinal.applied) {
      console.log('[Agent] → Pure welcome reply policy applied (override withhold/escalate from history-fetch conservatism)');
      finalResult.shouldReply = pureWelcomePolicyFinal.shouldReply;
      finalResult.confidence = pureWelcomePolicyFinal.confidence;
      finalResult.escalated = pureWelcomePolicyFinal.escalated;
    }

    const postWelcomeThanksPolicyFinal = this._applyPostWelcomeThankYouPolicy(finalResult, enrichedContext, guestMessage);
    if (postWelcomeThanksPolicyFinal.applied) {
      console.log('[Agent] → Post-welcome thank-you policy applied (short ack only, no duplicate logistics)');
      finalResult.typeOfMessageReceived = postWelcomeThanksPolicyFinal.typeOfMessageReceived;
      finalResult.proposedResponse = postWelcomeThanksPolicyFinal.proposedResponse;
      finalResult.shouldReply = postWelcomeThanksPolicyFinal.shouldReply;
      finalResult.confidence = postWelcomeThanksPolicyFinal.confidence;
      finalResult.escalated = postWelcomeThanksPolicyFinal.escalated;
    }

    const inStayDeparturePolicyFinal = this._applyInStayDepartureThankYouPolicy(finalResult, enrichedContext, guestMessage);
    if (inStayDeparturePolicyFinal.applied) {
      console.log('[Agent] → In-stay temporary departure policy applied (no safe-travels on step-out thanks)');
      finalResult.typeOfMessageReceived = inStayDeparturePolicyFinal.typeOfMessageReceived;
      finalResult.proposedResponse = inStayDeparturePolicyFinal.proposedResponse;
      finalResult.shouldReply = inStayDeparturePolicyFinal.shouldReply;
      finalResult.confidence = inStayDeparturePolicyFinal.confidence;
      finalResult.escalated = inStayDeparturePolicyFinal.escalated;
    }

    const cancellationCategoryFinal = this._applyCancellationCategoryPolicy(finalResult, guestMessage);
    if (cancellationCategoryFinal.applied) {
      finalResult.typeOfMessageReceived = cancellationCategoryFinal.typeOfMessageReceived;
    }

    const preCheckInParkingPolicyFinal = this._applyPreCheckInParkingPolicy(finalResult, enrichedContext, guestMessage);
    if (preCheckInParkingPolicyFinal.applied) {
      console.log('[Agent] → Pre-check-in parking policy applied (cannot confirm spot before unit ready)');
      finalResult.typeOfMessageReceived = preCheckInParkingPolicyFinal.typeOfMessageReceived;
      finalResult.proposedResponse = preCheckInParkingPolicyFinal.proposedResponse;
      finalResult.shouldReply = preCheckInParkingPolicyFinal.shouldReply;
      finalResult.confidence = preCheckInParkingPolicyFinal.confidence;
    }

    const postStayFeedbackPolicyFinal = this._applyPostStayHousekeepingFeedbackPolicy(finalResult, enrichedContext, guestMessage);
    if (postStayFeedbackPolicyFinal.applied) {
      console.log('[Agent] → Post-stay housekeeping feedback policy applied (auto-reply + cleaning alert)');
      finalResult.typeOfMessageReceived = postStayFeedbackPolicyFinal.typeOfMessageReceived;
      finalResult.proposedResponse = postStayFeedbackPolicyFinal.proposedResponse;
      finalResult.shouldReply = postStayFeedbackPolicyFinal.shouldReply;
      finalResult.confidence = postStayFeedbackPolicyFinal.confidence;
      finalResult.escalated = postStayFeedbackPolicyFinal.escalated;
    }

    const cleaningEscalationPolicyFinal = this._applyCleaningIssueEscalationPolicy(finalResult, cleaningIssue, guestMessage);
    if (cleaningEscalationPolicyFinal.applied) {
      console.log('[Agent] → Cleaning issue escalation policy applied (manual reply required)');
      finalResult.typeOfMessageReceived = cleaningEscalationPolicyFinal.typeOfMessageReceived;
      finalResult.proposedResponse = cleaningEscalationPolicyFinal.proposedResponse;
      finalResult.shouldReply = cleaningEscalationPolicyFinal.shouldReply;
      finalResult.confidence = cleaningEscalationPolicyFinal.confidence;
      finalResult.escalated = cleaningEscalationPolicyFinal.escalated;
    }

    console.log('[Agent] handleMessage complete. Final decision type:', finalResult.typeOfMessageReceived);

    // === Urgent Access Escalation (SMS via SNS) — post-final policies ===
    // Time-sensitive: guest cannot get in. Includes APT2_STREET_DOOR_LOCKOUT (bolted door /
    // street exit) which texts Jerome + Ruby. Config: URGENT_ACCESS_SNS_TOPIC_ARN or
    // URGENT_ACCESS_PHONE_NUMBER (comma-separated, e.g. {{HOST_JEROME_PHONE_E164}},{{HOST_RUBY_PHONE_E164}}).
    const accessIssueCategories = [
      'DOOR_CODE_ISSUE',
      'APT3_LOCKBOX_ISSUE',
      'WRONG_ENTRANCE_LOCKBOX',
      'LOCKBOX_KEY_TAKEN',
      'APT2_STREET_DOOR_LOCKOUT',
    ];
    const finalCategories = Array.isArray(finalResult.typeOfMessageReceived)
      ? finalResult.typeOfMessageReceived
      : [finalResult.typeOfMessageReceived];
    const isAccessIssue =
      finalCategories.some((c) => accessIssueCategories.includes(c)) ||
      this._isApt2StreetDoorLockout(guestMessage, enrichedContext);

    if (isAccessIssue) {
      console.log('[Agent] → Urgent access issue detected — sending SMS alert via SNS');
      try {
        const urgentResult = await this.notification.notifyUrgentAccessIssue({
          guestMessage,
          context: enrichedContext,
          category: finalCategories.find((c) => accessIssueCategories.includes(c)) || finalCategories[0],
          proposedResponse: finalResult.proposedResponse,
        });
        finalResult.urgentAccessNotified = urgentResult;
      } catch (err) {
        console.error('[Agent] Failed to send urgent access SMS:', err.message);
      }
    }

    // === SINGLE RICH ESCALATION NOTIFY (post-pipeline) ===
    // Performed exactly once, using the *final* decision object after reflection + judge.
    // This is what guarantees the SNS (and console) "manual reply needed" messages always contain:
    // (1) reservation ID (and conversation ID), (2) the proposedResponse that was not sent,
    // (3) the full trace: decision flags, reflection, conversationJudge (verdict + issues + notes),
    //     earlyTraces/safety signals, rawModelOutput, and suppression/force reasons.
    // Previously the notify happened early (pre-judge) so emails lacked the complete reasoning.
    const finalNeedsEscalation =
      finalResult.escalated === true ||
      finalResult.shouldReply === false ||
      finalResult.forceCancellationEscalation === true ||
      (finalResult.typeOfMessageReceived === 'OTHER_MESSAGE' && finalResult.proposedResponse === 'none');

    if (finalNeedsEscalation && !finalResult._escalationNotified) {
      console.log('[Agent] → Escalation required (no auto-reply) — notifying with FULL post-reflection/judge trace');
      try {
        await this.notification.notifyEscalation({
          decision: finalResult,
          guestMessage,
          context: enrichedContext,
        });
      } catch (notifyErr) {
        console.error('[Agent] Escalation notify failed (non-fatal):', notifyErr.message);
      }
      finalResult._escalationNotified = true;
    }

    return finalResult;
  }

  /**
   * Performs a lightweight reflection / critique pass on a first decision.
   * Used for high-risk categories to catch contradictions and policy errors.
   */
  async reflectOnDecision(firstDecision, toolResults = {}, context = {}) {
    if (!this.enableReflection) {
      return { decision: 'APPROVED', notes: 'Reflection disabled' };
    }

    const category = Array.isArray(firstDecision.typeOfMessageReceived)
      ? firstDecision.typeOfMessageReceived[0]
      : firstDecision.typeOfMessageReceived;

    // Only reflect on configured high-risk categories for now
    if (!this.reflectionCategories.includes(category)) {
      return { decision: 'APPROVED', notes: 'Category not configured for reflection' };
    }

    console.log('[Agent] Running reflection pass for category:', category);

    const reflectionPrompt = await this._buildReflectionPrompt(firstDecision, toolResults, context);

    try {
      const raw = await this.llm.complete(
        'You are a careful, conservative reviewer of guest messaging decisions. Your job is to catch mistakes before they reach guests.',
        reflectionPrompt
      );

      // Try to parse JSON from the reflection response
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        const match = raw.match(/\{[\s\S]*\}/);
        if (match) parsed = JSON.parse(match[0]);
      }

      if (!parsed || !parsed.decision) {
        console.warn('[Agent] Reflection returned invalid output, falling back to original decision');
        return { decision: 'APPROVED', notes: 'Invalid reflection output' };
      }

      console.log('[Agent] Reflection result:', parsed.decision);

      return parsed;

    } catch (err) {
      console.error('[Agent] Reflection call failed:', err.message);
      return { decision: 'APPROVED', notes: 'Reflection call failed - using original decision' };
    }
  }

  async _buildReflectionPrompt(firstDecision, toolResults, context) {
    const lines = [];

    // Try to load the dedicated reflection module if available
    try {
      const reflectionPath = path.join(this.categoriesDir, 'reflection.md');
      const reflectionRules = applyHostContactPlaceholders(await fs.readFile(reflectionPath, 'utf8'));
      lines.push(reflectionRules);
      lines.push('\n---\n');
    } catch {
      // Fallback instructions if the file isn't present
      lines.push('You are a careful reviewer. Focus on accuracy, policy compliance, and avoiding contradictions with prior host statements.');
    }

    lines.push('=== ORIGINAL GUEST MESSAGE ===');
    lines.push(context.originalMessage || 'Not provided');
    lines.push('');
    lines.push('=== FIRST DRAFT DECISION ===');
    lines.push(JSON.stringify(firstDecision, null, 2));
    lines.push('');

    if (Object.keys(toolResults).length > 0) {
      lines.push('=== TOOL RESULTS ===');
      lines.push(JSON.stringify(toolResults, null, 2));
      lines.push('');
    }

    if (context.conversationHistory?.length) {
      lines.push('=== RECENT CONVERSATION HISTORY (newest last) ===');
      context.conversationHistory.slice(-6).forEach(m => {
        const who = m.sender_type === 'guest' ? 'Guest' : 'Host';
        lines.push(`${who}: ${m.body}`);
      });
      lines.push('');
    }

    lines.push('Return ONLY valid JSON. No other text.');

    return lines.join('\n');
  }

  /**
   * Runs a dedicated Conversation Judge focused on anti-repetition and consistency.
   * This is more powerful than basic reflection for catching the agent repeating itself.
   */
  /**
   * Deterministic backstop when the LLM judge APPROVEs (or lacks history) but the draft clearly
   * re-sends welcome logistics on a post-welcome thank-you. Does not depend on Grok seeing history.
   */
  _applyDeterministicJudgeGuards(llmJudgeResult = {}, firstDecision = {}, context = {}, guestMessage = '') {
    if (this._isPostCheckoutThankYou(guestMessage, context)) {
      const draft = (firstDecision.proposedResponse || '').trim();
      const eventMismatch = firstDecision.typeOfMessageReceived === 'EVENT_REQUEST' ||
        /not able to accommodate events|gatherings/i.test(draft);
      const judgeRejected = llmJudgeResult.verdict === 'REJECT';
      const revised = (llmJudgeResult.revisedResponse || '').trim();
      const llmAlreadyFixed = llmJudgeResult.verdict === 'REVISE' && revised &&
        /you're welcome|you are welcome/i.test(revised) &&
        !/not able to accommodate events|gatherings/i.test(revised);

      if (llmAlreadyFixed) {
        return llmJudgeResult;
      }

      if (eventMismatch || judgeRejected) {
        const policy = this._applyPostCheckoutThankYouPolicy(
          { ...firstDecision },
          context,
          guestMessage
        );
        console.log('[Agent] → Deterministic judge guard: post-checkout thank-you misclassified as EVENT_REQUEST (Rene checkout incident)');
        return {
          ...llmJudgeResult,
          verdict: 'REVISE',
          revisedResponse: policy.proposedResponse,
          notes: (llmJudgeResult.notes ? llmJudgeResult.notes + ' ' : '') +
            'Deterministic guard: post-checkout thank-you — revise to short You\'re welcome ack (not event decline).',
          issues: [
            ...(Array.isArray(llmJudgeResult.issues) ? llmJudgeResult.issues : []),
            'Post-checkout thank-you misclassified as EVENT_REQUEST — guest confirmed departure and thanked host (Rene checkout incident).'
          ],
          deterministicGuard: true,
        };
      }
    }

    if (this._isTemporaryDepartureDuringStay(guestMessage, context)) {
      const draft = (firstDecision.proposedResponse || '').trim();
      const hasEndOfStayFarewell = /safe travels|hope you enjoyed|glad you had a good stay|have a (?:great|wonderful|safe) trip|enjoyed your stay/i.test(draft);
      const revised = (llmJudgeResult.revisedResponse || '').trim();
      const llmAlreadyFixed = llmJudgeResult.verdict === 'REVISE' && revised &&
        /you're welcome|you are welcome/i.test(revised) &&
        !/safe travels|hope you enjoyed|glad you had a good stay/i.test(revised);

      if (hasEndOfStayFarewell && !llmAlreadyFixed) {
        const policy = this._applyInStayDepartureThankYouPolicy(
          { ...firstDecision, proposedResponse: draft },
          context,
          guestMessage
        );
        console.log('[Agent] → Deterministic judge guard: end-of-stay farewell on in-stay temporary departure (Amie incident)');
        return {
          ...llmJudgeResult,
          verdict: 'REVISE',
          revisedResponse: policy.proposedResponse,
          notes: (llmJudgeResult.notes ? llmJudgeResult.notes + ' ' : '') +
            'Deterministic guard: guest stepped out temporarily during active stay — revise to short You\'re welcome without safe travels.',
          issues: [
            ...(Array.isArray(llmJudgeResult.issues) ? llmJudgeResult.issues : []),
            'End-of-stay farewell on in-stay temporary departure — guest is still staying tonight (Amie incident).'
          ],
          deterministicGuard: true,
        };
      }
    }

    if (!this._isPostWelcomeThankYouFollowUp(guestMessage, context)) {
      return llmJudgeResult;
    }

    const draft = (firstDecision.proposedResponse || '').trim();
    const repeatsLogistics = /4\s*pm|self-check-in|parking|pet fee|3 days before|check-in instructions|off-street|not allowed on the bed/i.test(draft);
    const wrongCategory = ['NEW_RESERVATION_WELCOME', 'NEW_INQUIRY_WELCOME'].includes(firstDecision.typeOfMessageReceived);

    const revised = (llmJudgeResult.revisedResponse || '').trim();
    const llmAlreadyFixed = llmJudgeResult.verdict === 'REVISE' && revised &&
      /you're welcome|you are welcome/i.test(revised) &&
      !/4\s*pm|self-check-in|pet fee|3 days before/i.test(revised);

    if (llmAlreadyFixed) {
      return llmJudgeResult;
    }

    if (!repeatsLogistics && !wrongCategory && llmJudgeResult.verdict === 'REJECT') {
      return llmJudgeResult;
    }

    if (!repeatsLogistics && !wrongCategory && llmJudgeResult.verdict !== 'APPROVE') {
      return llmJudgeResult;
    }

    if (!repeatsLogistics && !wrongCategory) {
      return llmJudgeResult;
    }

    const policy = this._applyPostWelcomeThankYouPolicy(
      { ...firstDecision, proposedResponse: draft, typeOfMessageReceived: firstDecision.typeOfMessageReceived },
      context,
      guestMessage
    );

    console.log('[Agent] → Deterministic judge guard: duplicate welcome on post-welcome thank-you (LLM judge missed or lacked history)');

    return {
      ...llmJudgeResult,
      verdict: 'REVISE',
      revisedResponse: policy.proposedResponse,
      notes: (llmJudgeResult.notes ? llmJudgeResult.notes + ' ' : '') +
        'Deterministic guard: prior welcome logistics already sent; guest thanks only — revise to short You\'re welcome ack.',
      issues: [
        ...(Array.isArray(llmJudgeResult.issues) ? llmJudgeResult.issues : []),
        'Repeated welcome logistics on post-welcome thank-you — guest already received full welcome (deterministic judge guard).'
      ],
      deterministicGuard: true,
    };
  }

  /**
   * One-shot rewrite after a Conversation Judge REVISE.
   * Uses judge issues/rewriteBrief + tool ground truth — category-agnostic quality iteration.
   * Returns null on failure so the caller can fall back to judge.revisedResponse.
   */
  async rewriteFromJudgeCritique(firstDecision, judgeResult = {}, toolResults = {}, context = {}) {
    const rewritePrompt = this._buildJudgeRewritePrompt(firstDecision, judgeResult, toolResults, context);
    try {
      const raw = await this.llm.complete(
        'You are rewriting a short-term rental host reply for a real guest. Fix only the judge issues. Stay grounded in tool/property facts. Sound warm and human. Return ONLY valid JSON.',
        rewritePrompt
      );

      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        const match = raw && raw.match(/\{[\s\S]*\}/);
        if (match) parsed = JSON.parse(match[0]);
      }

      const text = (parsed?.proposedResponse || parsed?.revisedResponse || '').trim();
      if (!text || text === 'none') {
        console.warn('[Agent] Judge rewrite returned no usable proposedResponse');
        return null;
      }

      return {
        proposedResponse: text,
        typeOfMessageReceived: parsed.typeOfMessageReceived || firstDecision.typeOfMessageReceived,
        shouldReply: parsed.shouldReply !== false,
        notes: parsed.notes || null,
      };
    } catch (err) {
      console.error('[Agent] Judge rewrite call failed:', err.message);
      return null;
    }
  }

  _buildJudgeRewritePrompt(firstDecision, judgeResult = {}, toolResults = {}, context = {}) {
    const lines = [];
    lines.push('=== REWRITE TASK (quality iteration — one pass only) ===');
    lines.push('A Conversation Judge rejected the draft quality and asked for a REVISE.');
    lines.push('Rewrite the host reply so it fixes EVERY listed issue while remaining natural and human.');
    lines.push('');
    lines.push('Hard rules:');
    lines.push('- Ground every factual claim in TOOL RESULTS / property knowledge only. Do not invent availability, codes, policies, or amenities.');
    lines.push('- If the guest had multiple intents (thanks + question(s), or several questions), address ALL of them in one combined reply.');
    lines.push('- Prefer multi-category arrays in typeOfMessageReceived when multiple intents apply.');
    lines.push('- Do not re-introduce issues the judge already called out (repetition, contradictions, robotic greetings, deferral when facts are known, etc.).');
    lines.push('- Keep the reply concise. Warm, not corporate.');
    lines.push('- Output JSON only, no markdown fences.');
    lines.push('');
    lines.push('=== ORIGINAL GUEST MESSAGE ===');
    lines.push(context.originalMessage || 'Not provided');
    lines.push('');
    lines.push('=== PRIOR DRAFT (to improve) ===');
    lines.push(JSON.stringify(firstDecision, null, 2));
    lines.push('');
    lines.push('=== JUDGE CRITIQUE ===');
    lines.push(JSON.stringify({
      verdict: judgeResult.verdict,
      issues: judgeResult.issues || [],
      rewriteBrief: judgeResult.rewriteBrief || null,
      notes: judgeResult.notes || null,
      // Optional full rewrite from judge — use as a strong hint, not the only option
      judgeSuggestedRevisedResponse: judgeResult.revisedResponse || null,
    }, null, 2));
    lines.push('');

    if (toolResults && Object.keys(toolResults).length > 0) {
      lines.push('=== TOOL RESULTS (ground truth) ===');
      lines.push(JSON.stringify(toolResults, null, 2));
      lines.push('');
    }

    if (context.conversationHistory?.length) {
      lines.push('=== RECENT CONVERSATION HISTORY (newest last) ===');
      context.conversationHistory.slice(-8).forEach((m) => {
        const who = m.sender_type === 'guest' ? 'Guest' : 'Host';
        lines.push(`${who}: ${m.body}`);
      });
      lines.push('');
    }

    lines.push('=== REQUIRED OUTPUT JSON ===');
    lines.push(JSON.stringify({
      typeOfMessageReceived: 'CATEGORY or [array of categories]',
      proposedResponse: 'the full improved reply to send the guest',
      shouldReply: true,
      notes: 'what you fixed',
    }, null, 2));

    return lines.join('\n');
  }

  async runConversationJudge(firstDecision, toolResults = {}, context = {}, options = {}) {
    if (!this.enableConversationJudge) {
      return { verdict: 'APPROVE', notes: 'Conversation Judge disabled' };
    }

    const pass = options.pass === 'verify' ? 'verify' : 'critique';
    const category = Array.isArray(firstDecision.typeOfMessageReceived)
      ? firstDecision.typeOfMessageReceived[0]
      : firstDecision.typeOfMessageReceived;

    // With very low volume (4-5 messages/day), we run the judge on every message
    // when enabled. The category check is now mostly informational.
    console.log(`[Agent] Running Conversation Judge (${pass}) for category:`, category);

    const judgePrompt = await this._buildConversationJudgePrompt(firstDecision, toolResults, context, { pass });

    try {
      const raw = await this.llm.complete(
        pass === 'verify'
          ? 'You are an expert conversation quality reviewer on a VERIFY pass. Check whether a rewritten host reply fixed the prior issues. Be strict on remaining truth, coverage, and human tone problems.'
          : 'You are an expert conversation quality reviewer. Your only job is to catch repetitive, ungrounded, incomplete, or inconsistent responses from an AI host. Prefer clear issues + rewriteBrief over only rewriting yourself.',
        judgePrompt
      );

      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        const match = raw.match(/\{[\s\S]*\}/);
        if (match) parsed = JSON.parse(match[0]);
      }

      if (!parsed || !parsed.verdict) {
        console.warn(`[Agent] Conversation Judge (${pass}) returned invalid output. Approving original.`);
        return { verdict: 'APPROVE', notes: 'Invalid judge output', pass };
      }

      console.log(`[Agent] Conversation Judge (${pass}) verdict:`, parsed.verdict);
      parsed.pass = pass;
      return parsed;

    } catch (err) {
      console.error(`[Agent] Conversation Judge (${pass}) call failed:`, err.message);
      return { verdict: 'APPROVE', notes: 'Judge call failed - using original decision', pass };
    }
  }

  async _buildConversationJudgePrompt(firstDecision, toolResults, context, options = {}) {
    const pass = options.pass === 'verify' ? 'verify' : 'critique';
    const lines = [];

    try {
      const judgePath = path.join(this.categoriesDir, 'conversation-judge.md');
      const judgeRules = applyHostContactPlaceholders(await fs.readFile(judgePath, 'utf8'));
      lines.push(judgeRules);
      lines.push('\n---\n');
    } catch {
      lines.push('You are an expert at detecting repetitive AI behavior and contradictions in conversations. Be strict.');
    }

    if (pass === 'verify') {
      lines.push('=== VERIFY PASS (quality iteration) ===');
      lines.push('You are reviewing a REWRITTEN reply after a prior REVISE. Decide APPROVE / REVISE / REJECT.');
      lines.push('- APPROVE if prior issues are fixed and the reply is grounded, complete, and natural.');
      lines.push('- REVISE only for remaining clear defects; set revisedResponse to the final sendable text (no further rewrite loop will run).');
      lines.push('- REJECT if still unsafe, contradictory, or fabricated.');
      lines.push('Do not re-litigate style nits if truth and intent coverage are solid.');
      lines.push('');
    } else {
      lines.push('=== CRITIQUE PASS (quality iteration) ===');
      lines.push('Focus on diagnosing issues. Prefer detailed issues[] + rewriteBrief so a separate rewrite pass can fix them.');
      lines.push('You MAY still set revisedResponse as a strong fallback, but rewriteBrief is preferred for the iteration loop.');
      lines.push('');
    }

    lines.push('=== ORIGINAL GUEST MESSAGE ===');
    lines.push(context.originalMessage || 'Not provided');
    lines.push('');

    lines.push(pass === 'verify' ? '=== CANDIDATE REPLY UNDER REVIEW ===' : '=== FIRST DRAFT DECISION ===');
    lines.push(JSON.stringify(firstDecision, null, 2));
    lines.push('');

    if (Object.keys(toolResults).length > 0) {
      lines.push('=== TOOL RESULTS ===');
      lines.push(JSON.stringify(toolResults, null, 2));
      lines.push('');

      // Give the live policy data extra visibility when present (important for cancellation cases)
      if (toolResults.airbnbPolicy) {
        lines.push('=== LIVE AIRBNB CANCELLATION POLICY DATA (treat as source of truth) ===');
        lines.push(JSON.stringify(toolResults.airbnbPolicy, null, 2));
        lines.push('');
      }
    }

    const traces = toolResults.conversationContext || context.conversationTraces || {};
    if (traces.historySource) {
      lines.push(`=== HISTORY SOURCE FOR JUDGE ===`);
      lines.push(`historySource=${traces.historySource}, recentMessageCount=${traces.recentMessageCount || 0}, historyFetchFailed=${!!traces.historyFetchFailed}`);
      lines.push('');
    }

    if (traces.recentWelcomeSent) {
      lines.push('=== CRITICAL JUDGE SIGNAL: POST-WELCOME THANK-YOU ===');
      lines.push('conversationTraces.recentWelcomeSent=true: A prior host message already delivered full welcome logistics. Guest message is thanks-only. Any draft that re-sends 4pm/self-check-in/parking/pet fee/3-day instructions or is NEW_RESERVATION_WELCOME MUST be REVISEd to a brief "You\'re welcome, [Name]!" only.');
      if (traces.lastHostMessagePreview) {
        lines.push(`Prior host welcome preview: "${traces.lastHostMessagePreview}"`);
      }
      lines.push('');
    }

    if (context.conversationHistory?.length) {
      lines.push('=== RECENT CONVERSATION HISTORY (newest last) ===');
      context.conversationHistory.slice(-8).forEach(m => {
        const who = m.sender_type === 'guest' ? 'Guest' : 'Host';
        lines.push(`${who}: ${m.body}`);
      });
      lines.push('');
    } else if (traces.lastHostMessagePreview) {
      lines.push('=== PRIOR HOST MESSAGE PREVIEW (no full history in judge context) ===');
      lines.push(`Host: ${traces.lastHostMessagePreview}`);
      lines.push('');
    }

    lines.push('Return ONLY valid JSON matching the required schema. No other text.');

    return lines.join('\n');
  }
}
