import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLLMAdapter } from './adapters/llm/index.js';
import { createNotificationAdapter } from './adapters/notification/index.js';
import { ToolRegistry, CleaningIssueTool, ThermostatTool, CancellationTool, EventRequestTool, AirbnbPolicyTool, UnitReadinessTool, ConversationContextTool } from './tools/index.js';
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
    return {
      typeOfMessageReceived: parsed.typeOfMessageReceived || 'OTHER_MESSAGE',
      proposedResponse: parsed.proposedResponse || 'none',
      shouldReply: parsed.shouldReply ?? (parsed.proposedResponse && parsed.proposedResponse !== 'none'),
      confidence: parsed.confidence ?? 0.7,
      rawModelOutput: raw
    };
  }

  _buildUserPrompt(message, context) {
    const lines = [
      `Current guest message: "${message}"`,
      '',
      'Context:'
    ];

    if (context.guestName) lines.push(`- Guest name: ${context.guestName}`);
    if (context.checkIn) lines.push(`- Check-in: ${context.checkIn}`);
    if (context.checkOut) lines.push(`- Check-out: ${context.checkOut}`);
    if (context.listingId) lines.push(`- Listing ID: ${context.listingId}`);
    if (context.hasPets) lines.push(`- Pets: ${context.petCount || 'yes'}`);
    if (context.propertyName) lines.push(`- Property: ${context.propertyName}`);

    if (context.conversationHistory?.length) {
      lines.push('- Recent conversation (newest last):');
      context.conversationHistory.slice(-6).forEach(m => {
        const who = m.sender_type === 'guest' ? 'Guest' : 'Host';
        lines.push(`  ${who}: ${m.body}`);
      });
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
      if (context.conversationTraces.preApprovalDetected) {
        lines.push('  • Pre-approval detected for this inquiry');
      }
      if (context.conversationTraces.traces?.length) {
        context.conversationTraces.traces.forEach(t => lines.push(`  • ${t}`));
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

    lines.push('');
    lines.push('Respond with the required JSON only.');

    return lines.join('\n');
  }

  /**
   * Dedicated early pre-processing / trace enrichment step.
   * Runs before the first LLM call (processMessage) so the entire multipass pipeline
   * (main generation + reflection + judge) benefits from the best possible signals.
   *
   * Currently includes:
   * - Conversation safety traces (pre-approval, recent host messages)
   * - (Future) Unit readiness quick check, duplicate prevention signals, etc.
   */
  async _enrichTracesEarly(enrichedContext, guestMessage) {
    const conversationContextTool = this.tools.get('get_conversation_context');

    if (conversationContextTool) {
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
          if (traces.traces?.length) summary.push(...traces.traces);

          if (summary.length > 0) {
            console.log('[Agent] → Early trace enrichment complete:', summary.join(' | '));
          } else {
            console.log('[Agent] → Early trace enrichment complete (no special signals)');
          }
        }
      } catch (err) {
        console.warn('[Agent] Early trace enrichment failed (non-fatal):', err.message);
        // Fail open — we still want the main pass to run
      }
    }

    // === Optional cheap Unit Readiness trace (for check-in day messages) ===
    // This is a "quick peek" — we only do it when it is likely relevant (check-in day)
    // so we don't burn unnecessary Hospitable/DDB calls on every message.
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
  }

  /**
   * Lightweight heuristic to decide if we should run an early UnitReadiness check.
   */
  _looksLikeCheckInDay(ctx = {}) {
    if (!ctx.checkIn) return false;

    const today = new Date().toISOString().split('T')[0];
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
    const senderType = (context.sender_type || context.sender?.type || '').toLowerCase();
    if (senderType && senderType !== 'guest') {
      console.log('[Agent] handleMessage aborted — message is from host, not guest.');
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

    // Broad safety net: any cancellation talk + recent host activity = escalate so Jerome can watch
    const isCancellationTalk = /cancel|refund|policy|exception/i.test(guestMessage);
    if (isCancellationTalk && traces.hasRecentHostMessage) {
      enrichedContext.forceCancellationEscalation = true;
      console.log('[Agent] → Cancellation talk detected with recent host activity — will force escalation email');
    }

    const decision = await this.processMessage(guestMessage, enrichedContext);

    // Post-first-pass safety net from early traces
    let finalDecision = decision;

    if (enrichedContext.recentHostActivity && decision.shouldReply) {
      console.log('[Agent] → Recent host activity detected after first pass — forcing suppression to prevent duplicate reply');
      finalDecision = {
        ...decision,
        shouldReply: false,
        proposedResponse: 'none',
        suppressedDueToRecentHost: true,
      };
    }

    const shouldEscalate =
      finalDecision.shouldReply === false ||
      (finalDecision.typeOfMessageReceived === 'OTHER_MESSAGE' && finalDecision.proposedResponse === 'none');

    if (shouldEscalate) {
      console.log('[Agent] → Escalation required (no auto-reply)');
      await this.notification.notifyEscalation({
        decision: finalDecision,
        guestMessage,
        context: enrichedContext,
      });
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
    const thermostatTool = this.tools.get('get_thermostat_instructions');
    let thermostatInfo = null;
    if (thermostatTool) {
      const info = await thermostatTool.execute(guestMessage, enrichedContext);
      if (info && info.detected) {
        thermostatInfo = info;
        console.log('[Agent] → Thermostat info generated');
      }
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
      if (cancellationInfo.needsEscalation || enrichedContext.forceCancellationEscalation) {
        console.log('[Agent] → Risky cancellation detected — forcing escalation email to jerome.ans@gmail.com');
        await this.notification.notifyEscalation({
          decision: finalDecision,
          guestMessage,
          context: enrichedContext,
        });
      }
    }

    // === Event / party requests ===
    const eventTool = this.tools.get('handle_event_request');
    let eventInfo = null;
    if (eventTool) {
      const info = await eventTool.execute(guestMessage, enrichedContext);
      if (info && info.detected) {
        eventInfo = info;
        console.log('[Agent] → Event request detected');
      }
    }

    const category = Array.isArray(finalDecision.typeOfMessageReceived)
      ? finalDecision.typeOfMessageReceived[0]
      : finalDecision.typeOfMessageReceived;

    const finalResult = {
      ...finalDecision,
      escalated: shouldEscalate,
      cleaningIssueDetected: cleaningIssue.detected,
      thermostatInfo,
      cancellationInfo,
      eventInfo,
      unitReadiness: enrichedContext.unitReadiness || null,
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
        cancellation: cancellationInfo,
        event: eventInfo,
        conversationContext: enrichedContext.conversationTraces || null,
        unitReadiness: enrichedContext.unitReadiness || null,
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
        cancellation: cancellationInfo,
        event: eventInfo,
        airbnbPolicy: cancellationInfo?.policy || null,
        conversationContext: enrichedContext.conversationTraces || null,
        unitReadiness: enrichedContext.unitReadiness || null,
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

    console.log('[Agent] handleMessage complete. Final decision type:', finalResult.typeOfMessageReceived);

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
