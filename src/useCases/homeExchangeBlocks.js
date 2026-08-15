/**
 * Persist Hospitable nights we blocked after an HE pre-approval
 * so a scheduled job can free them if the guest never finalizes (~4 days).
 */
import { ScanCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

export const HE_PREAPPROVAL_BLOCKS_TABLE =
  process.env.HE_PREAPPROVAL_BLOCKS_TABLE || 'homeexchangePreapprovalBlocks';

export const HE_PREAPPROVAL_TTL_MS = 4 * 24 * 60 * 60 * 1000;
export const STATUS_PENDING = 'pending_finalization';
export const STATUS_FINALIZED = 'finalized';
export const STATUS_EXPIRED_UNBLOCKED = 'expired_unblocked';

export function preapprovalExpiresAt(approvedAt = new Date(), ttlMs = HE_PREAPPROVAL_TTL_MS) {
  return new Date(new Date(approvedAt).getTime() + ttlMs).toISOString();
}

export function createDdbBlockStore(ddbClient, tableName = HE_PREAPPROVAL_BLOCKS_TABLE) {
  if (!ddbClient || typeof ddbClient.send !== 'function') return null;
  return {
    async put(item) {
      await ddbClient.send(
        new PutCommand({
          TableName: tableName,
          Item: item,
        })
      );
      return item;
    },
    async scanPending() {
      const out = [];
      let ExclusiveStartKey;
      do {
        const page = await ddbClient.send(
          new ScanCommand({
            TableName: tableName,
            ExclusiveStartKey,
            FilterExpression: '#s = :pending',
            ExpressionAttributeNames: { '#s': 'status' },
            ExpressionAttributeValues: { ':pending': STATUS_PENDING },
          })
        );
        out.push(...(page.Items || []));
        ExclusiveStartKey = page.LastEvaluatedKey;
      } while (ExclusiveStartKey);
      return out;
    },
    async updateStatus(exchangeId, status, extra = {}) {
      const names = { '#s': 'status' };
      const values = { ':s': status };
      const sets = ['#s = :s'];
      for (const [k, v] of Object.entries(extra)) {
        names[`#${k}`] = k;
        values[`:${k}`] = v;
        sets.push(`#${k} = :${k}`);
      }
      await ddbClient.send(
        new UpdateCommand({
          TableName: tableName,
          Key: { exchangeId: String(exchangeId) },
          UpdateExpression: `SET ${sets.join(', ')}`,
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
        })
      );
    },
  };
}

export function buildBlockRecord({
  exchangeId,
  conversationId,
  propertyId,
  homeId,
  guestName,
  checkIn,
  checkOut,
  nights,
  now = new Date(),
}) {
  const approvedAt = new Date(now).toISOString();
  return {
    exchangeId: String(exchangeId),
    conversationId: conversationId != null ? String(conversationId) : null,
    propertyId: propertyId || null,
    homeId: homeId != null ? String(homeId) : null,
    guestName: guestName || null,
    checkIn,
    checkOut,
    nights: Array.isArray(nights) ? nights : [],
    approvedAt,
    expiresAt: preapprovalExpiresAt(approvedAt),
    status: STATUS_PENDING,
    createdAt: approvedAt,
  };
}
