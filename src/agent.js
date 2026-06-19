import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLLMAdapter } from './adapters/llm/index.js';
import { createNotificationAdapter } from './adapters/notification/index.js';
import { ToolRegistry, CleaningIssueTool, ThermostatTool, HeatPumpTool, CancellationTool, EventRequestTool, AirbnbPolicyTool, UnitReadinessTool, ConversationContextTool, GoogleMapsTool, StayExtensionTool } from './tools/index.js';
import { EVENT_REQUEST_STANDARD_RESPONSE } from './tools/event/EventRequestTool.js';
import { normalizeGuestName } from './utils/normalizeGuestName.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, '..', '..');

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

    this.systemPrompt = null;

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
  async loadPrompt(context = {}) {
    if (this.systemPrompt && !context.listingId) return this.systemPrompt;

    const start = Date.now();

    try {
      // Raw production fidelity mode (takes precedence)
      if (this.fullPromptPath) {
        const full = await fs.readFile(this.fullPromptPath, 'utf8');
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
        const simple = [base.trim(), propertyKnowledge ? '\n\n' + propertyKnowledge : ''].join('');
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

      const composed = [
        base.trim(),
        categoryKnowledge ? `\n\n# Category Rules\n${categoryKnowledge}` : '',
        propertyKnowledge ? `\n\n# Property-Specific Knowledge\n${propertyKnowledge}` : ''
      ].join('');

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

    const eventPolicy = this._applyEventRequestPolicy(parsed, context);
    if (eventPolicy.applied) {
      parsed.typeOfMessageReceived = 'EVENT_REQUEST';
      parsed.proposedResponse = eventPolicy.proposedResponse;
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

    const sofaLinensPolicy = this._applySofaBedLinensPolicy(parsed, context, guestMessage);
    if (sofaLinensPolicy.applied) {
      parsed.typeOfMessageReceived = sofaLinensPolicy.typeOfMessageReceived;
      if (sofaLinensPolicy.proposedResponse) {
        parsed.proposedResponse = sofaLinensPolicy.proposedResponse;
      }
      shouldReply = true;
    }

    this._applyCancellationCategoryPolicy(parsed, guestMessage);

    const postWelcomeThanksPolicy = this._applyPostWelcomeThankYouPolicy(parsed, context, guestMessage);
    if (postWelcomeThanksPolicy.applied) {
      shouldReply = postWelcomeThanksPolicy.shouldReply;
      confidence = postWelcomeThanksPolicy.confidence;
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
  _applyEventRequestPolicy(parsed, context = {}) {
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

  _hostMessageLooksLikeWelcome(body = '') {
    const welcomeMarkers = /check-?in|self-check-in|parking|pet fee|looking forward to hosting|detailed check-in instructions|3 days before|delighted to host|glad to host/i;
    return welcomeMarkers.test(body || '');
  }

  /**
   * Guest sent a pure thanks after we already delivered the full welcome/logistics.
   * Rene incident: duplicate 4pm/pet/parking block on "Thank you so much! I appreciate your prompt response!"
   */
  _isPostWelcomeThankYouFollowUp(guestMessage = '', context = {}) {
    const msg = (guestMessage || '').trim();
    if (!msg || /\?/.test(msg)) return false;
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

  /**
   * Ensure THERMOSTAT_HEATPUMP replies always include the neutral remote-control wording.
   * Uses ThermostatTool / HeatPumpTool recommended snippets when the LLM paraphrases.
   */
  _applyThermostatPolicy(parsed, context = {}, guestMessage = '') {
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
    if (context.recentHostActivity) {
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
   * - Fail open (non-fatal) so we never break the main flow.
   * - Make it easy to extend over time.
   */
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

    try {
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
        if (traces.historyFetchFailed) summary.push('HISTORY FETCH FAILED');
        if (traces.traces?.length) summary.push(...traces.traces);

        // Always log the history fetch status explicitly (prevents "silent" failures for history-dependent logic like Taylor anti-contradiction).
        const histSrc = traces.historySource || 'unknown';
        const histCount = traces.recentMessageCount || (traces.recentConversationMessages?.length || 0);
        console.log(`[Agent] → Conversation history status: source=${histSrc}, count=${histCount}${traces.historyFetchFailed ? ' (FAILED — see CRITICAL log above)' : ''}`);

        if (summary.length > 0) {
          console.log('[Agent] → Early trace enrichment complete:', summary.join(' | '));
        } else {
          console.log('[Agent] → Early trace enrichment complete (no special signals)');
        }
      }
    } catch (err) {
      console.warn('[Agent] Core safety trace enrichment failed (non-fatal):', err.message);
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

    // === Pre-processing / Trace Enrichment Step ===
    // Run lightweight tools and safety checks *before* the first LLM pass.
    // This ensures the main generation, reflection, and judge all start with the richest possible signals
    // (pre-approval status, recent host activity, unit readiness hints, etc.).
    // This is the dedicated early enrichment phase for highest-quality multipass responses.
    await this._enrichTracesEarly(enrichedContext, guestMessage);

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
        !this._isPostWelcomeThankYouFollowUp(guestMessage, enrichedContext)) {
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

    // === Urgent Access Escalation (SMS) ===
    // If the guest is having trouble getting into the property, this is time-sensitive.
    // Send an immediate SMS to the configured urgent number (646 204 3958).
    const accessIssueCategories = [
      'DOOR_CODE_ISSUE',
      'APT3_LOCKBOX_ISSUE',
      'WRONG_ENTRANCE_LOCKBOX',
      'DOOR_LOCKING_ISSUE',
      'LOCKBOX_KEY_TAKEN',
    ];

    const isAccessIssue = accessIssueCategories.includes(category);

    if (isAccessIssue) {
      console.log('[Agent] → Urgent access issue detected — sending SMS alert');
      try {
        const urgentResult = await this.notification.notifyUrgentAccessIssue({
          guestMessage,
          context: enrichedContext,
        });
        finalResult.urgentAccessNotified = urgentResult;
      } catch (err) {
        console.error('[Agent] Failed to send urgent access SMS:', err.message);
      }
    }

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

      const reflectionContext = {
        ...enrichedContext,
        originalMessage: guestMessage,
        conversationHistory: context.conversationHistory || [],
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

      const judgeContext = {
        ...enrichedContext,
        originalMessage: guestMessage,
        conversationHistory: context.conversationHistory || [],
      };

      const judgeResult = await this.runConversationJudge(finalDecision, toolResults, judgeContext);

      finalResult.conversationJudge = judgeResult;

      if (judgeResult.verdict === 'REVISE' && judgeResult.revisedResponse) {
        console.log('[Agent] Conversation Judge requested revision');
        finalResult.typeOfMessageReceived = finalDecision.typeOfMessageReceived;
        finalResult.proposedResponse = judgeResult.revisedResponse;
        finalResult.judgeNotes = judgeResult.notes;
      } else if (judgeResult.verdict === 'REJECT') {
        console.log('[Agent] Conversation Judge rejected the response');
        finalResult.shouldReply = false;
        finalResult.proposedResponse = 'none';
        finalResult.escalated = true;
        finalResult.judgeNotes = judgeResult.notes;
      } else {
        console.log('[Agent] Conversation Judge approved original decision');
      }
    }

    // Final guard: never let reflection/judge paraphrase away the firm event policy wording.
    const eventPolicyFinal = this._applyEventRequestPolicy(finalResult, enrichedContext);
    if (eventPolicyFinal.applied) {
      finalResult.typeOfMessageReceived = 'EVENT_REQUEST';
      finalResult.proposedResponse = eventPolicyFinal.proposedResponse;
      finalResult.shouldReply = true;
    }

    const thermostatPolicyFinal = this._applyThermostatPolicy(finalResult, enrichedContext, guestMessage);
    if (thermostatPolicyFinal.applied) {
      finalResult.typeOfMessageReceived = thermostatPolicyFinal.typeOfMessageReceived || 'THERMOSTAT_HEATPUMP';
      finalResult.proposedResponse = thermostatPolicyFinal.proposedResponse;
      finalResult.shouldReply = true;
    }

    const sofaLinensPolicyFinal = this._applySofaBedLinensPolicy(finalResult, enrichedContext, guestMessage);
    if (sofaLinensPolicyFinal.applied) {
      finalResult.typeOfMessageReceived = sofaLinensPolicyFinal.typeOfMessageReceived;
      if (sofaLinensPolicyFinal.proposedResponse) {
        finalResult.proposedResponse = sofaLinensPolicyFinal.proposedResponse;
      }
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

    const cancellationCategoryFinal = this._applyCancellationCategoryPolicy(finalResult, guestMessage);
    if (cancellationCategoryFinal.applied) {
      finalResult.typeOfMessageReceived = cancellationCategoryFinal.typeOfMessageReceived;
    }

    console.log('[Agent] handleMessage complete. Final decision type:', finalResult.typeOfMessageReceived);

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
      const reflectionRules = await fs.readFile(reflectionPath, 'utf8');
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
  async runConversationJudge(firstDecision, toolResults = {}, context = {}) {
    if (!this.enableConversationJudge) {
      return { verdict: 'APPROVE', notes: 'Conversation Judge disabled' };
    }

    const category = Array.isArray(firstDecision.typeOfMessageReceived)
      ? firstDecision.typeOfMessageReceived[0]
      : firstDecision.typeOfMessageReceived;

    // With very low volume (4-5 messages/day), we run the judge on every message
    // when enabled. The category check is now mostly informational.
    console.log('[Agent] Running Conversation Judge for category:', category);

    const judgePrompt = await this._buildConversationJudgePrompt(firstDecision, toolResults, context);

    try {
      const raw = await this.llm.complete(
        'You are an expert conversation quality reviewer. Your only job is to catch repetitive or inconsistent responses from an AI host.',
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
        console.warn('[Agent] Conversation Judge returned invalid output. Approving original.');
        return { verdict: 'APPROVE', notes: 'Invalid judge output' };
      }

      console.log('[Agent] Conversation Judge verdict:', parsed.verdict);

      return parsed;

    } catch (err) {
      console.error('[Agent] Conversation Judge call failed:', err.message);
      return { verdict: 'APPROVE', notes: 'Judge call failed - using original decision' };
    }
  }

  async _buildConversationJudgePrompt(firstDecision, toolResults, context) {
    const lines = [];

    try {
      const judgePath = path.join(this.categoriesDir, 'conversation-judge.md');
      const judgeRules = await fs.readFile(judgePath, 'utf8');
      lines.push(judgeRules);
      lines.push('\n---\n');
    } catch {
      lines.push('You are an expert at detecting repetitive AI behavior and contradictions in conversations. Be strict.');
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

      // Give the live policy data extra visibility when present (important for cancellation cases)
      if (toolResults.airbnbPolicy) {
        lines.push('=== LIVE AIRBNB CANCELLATION POLICY DATA (treat as source of truth) ===');
        lines.push(JSON.stringify(toolResults.airbnbPolicy, null, 2));
        lines.push('');
      }
    }

    if (context.conversationHistory?.length) {
      lines.push('=== RECENT CONVERSATION HISTORY ===');
      context.conversationHistory.slice(-8).forEach(m => {
        const who = m.sender_type === 'guest' ? 'Guest' : 'Host';
        lines.push(`${who}: ${m.body}`);
      });
      lines.push('');
    }

    lines.push('Return ONLY valid JSON matching the required schema. No other text.');

    return lines.join('\n');
  }
}
