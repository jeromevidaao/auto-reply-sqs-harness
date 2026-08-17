/**
 * Replay Katie's HE finalize / approval-status change through the isolated
 * HomeExchange auto-reply path and send the thank-you-for-confirming note.
 * Aborts if that thank-you is already on the thread.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { HomeExchangeClient } from '../src/clients/HomeExchangeClient.js';
import { notifyOwnerAndroid } from '../src/adapters/notification/fcm.js';
import { handleHomeExchangeMessage } from '../src/useCases/homeExchange.js';
import { alreadySentEquivalent } from '../src/clients/HomeExchangeClient.js';

const CONVERSATION_ID = '95201321';
const HOME_ID = '3285044';

function textOf(m) {
  return String(m?.content || m?.body || m?.text || '');
}

async function main() {
  const homeExchangeClient = new HomeExchangeClient();
  const ddbClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-1' }));

  const messages = await homeExchangeClient.listMessages(CONVERSATION_ID);
  const conversation = await homeExchangeClient.getConversation(CONVERSATION_ID);
  const exchanges = conversation.exchanges || conversation.all_exchanges || [];
  const exchange = exchanges.find((ex) => String(ex?.home?.id) === HOME_ID) || exchanges[0];
  console.log('exchange:', {
    id: exchange?.id,
    status: exchange?.status,
    approved_at: exchange?.approved_at,
    finalized_at: exchange?.finalized_at,
    start_on: exchange?.start_on,
    end_on: exchange?.end_on,
  });
  console.log('last_message:', textOf(messages[messages.length - 1]).slice(0, 240));

  const draft =
    "Thank you for confirming, Katie! We're looking forward to hosting you October 29 – November 3, 2026.";
  if (alreadySentEquivalent(messages, draft)) {
    console.log('ABORT: confirm thank-you already on thread');
    return;
  }

  const result = await handleHomeExchangeMessage({
    event: {
      queryStringParameters: { act: 'homeexchange_approval_status' },
      body: JSON.stringify({
        action: 'homeexchange.exchange.finalized',
        data: {
          body: 'Katie has finalized the exchange',
          platform: 'homeexchange',
          source: 'homeexchange',
          eventType: 'exchange_finalized',
          exchangeStatus: 3,
          conversation_id: CONVERSATION_ID,
          guestName: 'Katie',
          checkIn: '2026-10-29',
          checkOut: '2026-11-03',
          isFirstMessage: false,
          listing: { platform: 'homeexchange', platform_id: HOME_ID },
        },
      }),
    },
    ddbClient,
    homeExchangeClient,
    notifyOwner: notifyOwnerAndroid,
  });

  console.log('result:', {
    reason: result.reason,
    guestFinalized: result.guestFinalized,
    sent: result.sent,
    sendSkipReason: result.sendSkipReason,
    sendError: result.sendError,
    preapproveAttempted: result.preapprove?.attempted,
    proposedResponse: result.proposedResponse,
  });

  const after = await homeExchangeClient.listMessages(CONVERSATION_ID);
  const last = textOf(after[after.length - 1]);
  console.log('thread_last:', last.slice(0, 280));
  if (!/thank you for confirming/i.test(last)) {
    console.error('FAIL: thank-you for confirming is not last on the thread');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
