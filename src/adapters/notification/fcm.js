/**
 * Owner Android FCM (same path as cleaning-to-register / check-for-miss-cleaning).
 *
 * - Project id + service account: SSM /fcm/project-id, /fcm/service-account-json
 * - Device tokens: DynamoDB androidDeviceTokens
 * - Data-only payload so cleaningbutton-android OwnerAlertsMessagingService shows the tray
 *   without app changes (title/body/type in data).
 *
 * FCM data payload max ~4KB — keep bodies short; full agent traces stay in CloudWatch.
 */

import { DynamoDBClient, ScanCommand, DeleteItemCommand } from '@aws-sdk/client-dynamodb';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { GoogleAuth } from 'google-auth-library';
import { WRITE_MAX_ATTEMPTS, withExponentialBackoff } from '../../utils/httpRetry.js';

const REGION = process.env.AWS_REGION || 'us-east-1';
const DEVICE_TOKENS_TABLE = process.env.ANDROID_DEVICE_TOKENS_TABLE || 'androidDeviceTokens';
const SSM_FCM_PROJECT_ID = process.env.FCM_PROJECT_ID_SSM || '/fcm/project-id';
const SSM_FCM_SA_JSON = process.env.FCM_SERVICE_ACCOUNT_SSM || '/fcm/service-account-json';

const ssm = new SSMClient({ region: REGION });
const ddb = new DynamoDBClient({ region: REGION });
const ssmCache = new Map();

async function getSsm(name, { decrypt = false, required = true } = {}) {
  const cacheKey = `${name}:${decrypt ? 'd' : 'p'}`;
  if (ssmCache.has(cacheKey)) return ssmCache.get(cacheKey);
  try {
    const res = await ssm.send(
      new GetParameterCommand({ Name: name, WithDecryption: decrypt })
    );
    const value = res.Parameter?.Value || null;
    if (value != null) ssmCache.set(cacheKey, value);
    return value;
  } catch (err) {
    if (!required) {
      console.warn(`[fcm] SSM ${name} unavailable:`, err.message);
      return null;
    }
    throw err;
  }
}

function isFcmConfigured(projectId, saJson) {
  return !!(
    projectId &&
    String(projectId).trim() &&
    saJson &&
    String(saJson).includes('"private_key"')
  );
}

async function listEnabledDeviceTokens() {
  const tokens = [];
  let ExclusiveStartKey;
  do {
    const page = await ddb.send(
      new ScanCommand({
        TableName: DEVICE_TOKENS_TABLE,
        ExclusiveStartKey,
        ProjectionExpression: '#t, enabled',
        ExpressionAttributeNames: { '#t': 'token' },
      })
    );
    for (const item of page.Items || []) {
      const token = item.token && item.token.S;
      const enabled = item.enabled == null ? true : item.enabled.BOOL !== false;
      if (token && enabled) tokens.push(token);
    }
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return tokens;
}

async function getFcmAccessToken(serviceAccountJson) {
  const credentials = JSON.parse(serviceAccountJson);
  const auth = new GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/firebase.messaging'],
  });
  const client = await auth.getClient();
  const tokenResponse = await client.getAccessToken();
  if (!tokenResponse || !tokenResponse.token) {
    throw new Error('Failed to obtain FCM access token');
  }
  return tokenResponse.token;
}

async function deleteDeviceToken(token) {
  try {
    await ddb.send(
      new DeleteItemCommand({
        TableName: DEVICE_TOKENS_TABLE,
        Key: { token: { S: token } },
      })
    );
    console.log(`[fcm] Removed invalid device token …${token.slice(-8)}`);
  } catch (err) {
    console.error('[fcm] Failed to delete invalid device token:', err.message);
  }
}

/**
 * Truncate for FCM data size (total message must stay under ~4KB).
 */
export function clip(str, max) {
  const s = String(str == null ? '' : str);
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + '…';
}

/**
 * Send data-only FCM to all registered Android tokens.
 *
 * @param {{ type: string, title: string, body: string, data?: Record<string, string> }} opts
 * @returns {Promise<{ ok: boolean, channel: string, successCount?: number, failureCount?: number, reason?: string }>}
 */
export async function notifyOwnerAndroid(opts) {
  const { type, title, body, data = {} } = opts;
  const projectId = await getSsm(SSM_FCM_PROJECT_ID, { required: false });
  const saJson = await getSsm(SSM_FCM_SA_JSON, { decrypt: true, required: false });

  if (!isFcmConfigured(projectId, saJson)) {
    return { ok: false, channel: 'fcm', reason: 'fcm_not_configured' };
  }

  const tokens = await listEnabledDeviceTokens();
  if (!tokens.length) {
    return { ok: false, channel: 'fcm', reason: 'no_device_tokens' };
  }

  const accessToken = await getFcmAccessToken(saJson);
  // FCM data total ~4KB. Most fields stay short; proposedResponse (manual-reply
  // unsent draft) gets a longer budget so Android can prefill the composer.
  const FIELD_CLIP = {
    proposedResponse: 1800,
    draft: 1800,
    guestMessage: 500,
  };
  const payloadData = {
    title: clip(title, 120),
    body: clip(body, 900),
    type: String(type || 'generic'),
    ...Object.fromEntries(
      Object.entries(data).map(([k, v]) => {
        const max = FIELD_CLIP[k] ?? 400;
        return [String(k), clip(v == null ? '' : v, max)];
      })
    ),
  };

  let successCount = 0;
  let failureCount = 0;

  for (const token of tokens) {
    const url = `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`;
    const message = {
      message: {
        token,
        data: payloadData,
        android: { priority: 'HIGH' },
      },
    };

    try {
      await withExponentialBackoff(
        async () => {
          const res = await fetch(url, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(message),
          });
          const text = await res.text();
          if (!res.ok) {
            const err = new Error(`FCM HTTP ${res.status} ${text.slice(0, 200)}`);
            err.response = { status: res.status };
            err.fcmBody = text;
            if (
              res.status === 404 ||
              text.includes('UNREGISTERED') ||
              text.includes('INVALID_ARGUMENT')
            ) {
              err.permanent = true;
            }
            throw err;
          }
          return true;
        },
        { operation: 'fcmSend', kind: 'write', maxAttempts: WRITE_MAX_ATTEMPTS }
      );
      successCount += 1;
      console.log(`[fcm] delivered type=${type} to …${token.slice(-8)}`);
    } catch (err) {
      failureCount += 1;
      const text = err?.fcmBody || '';
      const status = err?.response?.status;
      console.error(`[fcm] send failed …${token.slice(-8)}:`, err.message);
      if (
        status === 404 ||
        text.includes('UNREGISTERED') ||
        text.includes('INVALID_ARGUMENT')
      ) {
        await deleteDeviceToken(token);
      }
    }
  }

  if (successCount >= 1) {
    return {
      ok: true,
      channel: 'fcm',
      successCount,
      failureCount,
    };
  }
  return {
    ok: false,
    channel: 'fcm',
    successCount,
    failureCount,
    reason: 'all_tokens_failed',
  };
}

/**
 * Build a tray-friendly escalation summary (no full agent dump).
 */
export function buildEscalationFcmContent({ decision, guestMessage, context }) {
  const guestName = context.guestDisplayName || context.guestName || 'Guest';
  const property = context.propertyName || context.listingId || 'Unknown property';
  const category = decision?.typeOfMessageReceived || 'OTHER';
  const reservationId =
    context.reservationId ||
    context.reservation_id ||
    context.reservation?.id ||
    context.reservation?.reservation_id ||
    'N/A';
  const conversationId =
    context.conversation_id ||
    context.airbnb_conversation_id ||
    context.conversationId ||
    'N/A';

  let airbnbLink = '';
  if (context.airbnb_message_url) {
    airbnbLink = context.airbnb_message_url;
  } else if (context.conversation_id) {
    airbnbLink = `https://www.airbnb.com/hosting/messages/${context.conversation_id}`;
  } else if (context.airbnb_conversation_id) {
    airbnbLink = `https://www.airbnb.com/hosting/messages/${context.airbnb_conversation_id}`;
  }

  const title = `Manual reply needed — ${guestName}`;
  const bodyParts = [
    property,
    `Category: ${category}`,
    `Res: ${reservationId}`,
    guestMessage ? `Guest: ${clip(guestMessage, 280)}` : '',
    airbnbLink || '',
  ].filter(Boolean);

  const listingId =
    context.listingId ||
    context.listing_id ||
    context.listing?.platform_id ||
    context.listing?.id ||
    '';
  const listingName = context.propertyName || context.listing?.name || '';

  // Unsent auto-reply draft (judge declined to send). Android opens the
  // conversation composer prefilled with this text on notification tap.
  let proposedResponse = '';
  if (decision && typeof decision.proposedResponse === 'string') {
    const p = decision.proposedResponse.trim();
    if (p && p.toLowerCase() !== 'none') {
      proposedResponse = p;
    }
  }

  return {
    type: 'manual_reply_needed',
    title,
    body: bodyParts.join('\n'),
    data: {
      type: 'manual_reply_needed',
      guestName: String(guestName),
      property: String(property),
      category: String(category),
      reservationId: String(reservationId),
      conversationId: String(conversationId),
      airbnbLink: String(airbnbLink || ''),
      listingId: String(listingId || ''),
      listingName: String(listingName || ''),
      confidence: String(decision?.confidence ?? ''),
      // Full-ish draft for composer prefill (clipped further in notifyOwnerAndroid).
      proposedResponse: String(proposedResponse),
      draft: String(proposedResponse),
    },
  };
}
