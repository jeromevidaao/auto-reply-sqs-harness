/**
 * Hospitable emits message.updated + triggers:["reaction_added"] when a host
 * hearts/thumbs a guest message. Historically the Lambda hard-skipped those
 * to avoid a second "You're welcome" after message.created already replied.
 *
 * Rebecca Simpkin (West End Victorian, 2026-09-12): message.created for her
 * post-stay thank-you NEVER reached guest-messaging-agent-harness. Only the
 * later reaction_added update arrived — hard-skip left her unanswered.
 *
 * Rule: hard-skip reaction_added ONLY when the guest message was already
 * processed (dedup hit for guestmsg:conv:platformId). Otherwise treat the
 * update as guest input so a missed message.created can be recovered.
 */

export function normalizeTriggers(triggers) {
  if (Array.isArray(triggers)) return triggers;
  if (triggers == null || triggers === '') return [];
  return [triggers];
}

export function isReactionAddedUpdate({ action, triggers } = {}) {
  if (action !== 'message.updated') return false;
  return normalizeTriggers(triggers).includes('reaction_added');
}

/**
 * @param {{ action?: string|null, triggers?: any, dedupAlreadyProcessed?: boolean }} opts
 * @returns {boolean} true → Lambda should return skipped without drafting
 */
export function shouldHardSkipReactionAdded({
  action,
  triggers,
  dedupAlreadyProcessed = false,
} = {}) {
  if (!isReactionAddedUpdate({ action, triggers })) return false;
  return !!dedupAlreadyProcessed;
}

/**
 * Prefer Airbnb platform_id (stable across created+updated), else Hospitable numeric id.
 */
export function guestMessagePlatformId(msgContext = {}) {
  if (msgContext.platform_id != null && msgContext.platform_id !== '') {
    return String(msgContext.platform_id);
  }
  const id = msgContext.id;
  if (typeof id === 'number') return String(id);
  if (typeof id === 'string' && id && !id.includes('-')) return id;
  return null;
}

export function guestMessageDedupKey(msgContext = {}) {
  const messagePlatformId = guestMessagePlatformId(msgContext);
  const convForDedup =
    msgContext.conversation_id ||
    msgContext.conversationId ||
    msgContext.reservation_id ||
    msgContext.reservationId ||
    null;
  if (messagePlatformId && convForDedup) {
    return `guestmsg:${convForDedup}:${messagePlatformId}`;
  }
  return null;
}
