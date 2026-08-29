/**
 * Replay Nina & John's HE first request (conv 95598827, Apt #2, July 2027,
 * reciprocal / 0 GuestPoints) through the isolated HomeExchange auto-reply
 * path. Sends the GuestPoints-only / dates-closed note. Does not convert
 * the swap and does not call HE manual-decline (reciprocal cannot be declined).
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { HomeExchangeClient } from '../src/clients/HomeExchangeClient.js';
import { HospitableClient } from '../src/clients/HospitableClient.js';
import { notifyOwnerAndroid } from '../src/adapters/notification/fcm.js';
import { handleHomeExchangeMessage } from '../src/useCases/homeExchange.js';
import { alreadySentEquivalent } from '../src/clients/HomeExchangeClient.js';
import { conversationAlreadyDeclined } from '../src/clients/homeExchangeExchange.js';

const CONVERSATION_ID = '95598827';
const HOME_ID = '3285044';

function textOf(m) {
  return String(m?.content || m?.body || m?.text || '');
}

async function main() {
  const homeExchangeClient = new HomeExchangeClient();
  const hospitableClient = new HospitableClient();
  const ddbClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-1' }));

  const messages = await homeExchangeClient.listMessages(CONVERSATION_ID);
  const conversation = await homeExchangeClient.getConversation(CONVERSATION_ID);
  const exchanges = conversation.exchanges || conversation.all_exchanges || [];
  const exchange = exchanges.find((ex) => String(ex?.home?.id) === HOME_ID) || exchanges[0];
  const guestText =
    textOf(
      [...messages].reverse().find((m) => String(m?.type) === '0' || m?.type === 0) ||
        messages[0]
    ) || '';

  console.log('exchange:', {
    id: exchange?.id,
    type: exchange?.type,
    status: exchange?.status,
    accepted: conversation?.accepted,
    start_on: exchange?.start_on,
    end_on: exchange?.end_on,
  });
  console.log('guest_text:', guestText.slice(0, 240));

  const result = await handleHomeExchangeMessage({
    event: {
      queryStringParameters: { act: 'homeexchange_message' },
      body: JSON.stringify({
        action: 'homeexchange.message.created',
        data: {
          body: guestText,
          platform: 'homeexchange',
          source: 'homeexchange',
          conversation_id: CONVERSATION_ID,
          guestName: 'Nina and John',
          checkIn: '2027-07-19',
          checkOut: '2027-07-31',
          isFirstMessage: false,
          messageCount: messages.length,
          exchangeType: exchange?.type ?? 2,
          listing: { platform: 'homeexchange', platform_id: HOME_ID },
        },
      }),
    },
    hospitableClient,
    ddbClient,
    homeExchangeClient,
    notifyOwner: notifyOwnerAndroid,
  });

  console.log('result:', {
    reason: result.reason,
    isFirstMessage: result.isFirstMessage,
    reciprocal: result.reciprocal,
    calendarOpen: result.calendar?.open,
    sent: result.sent,
    sendSkipReason: result.sendSkipReason,
    sendError: result.sendError,
    decline: result.decline,
    proposedResponse: result.proposedResponse,
  });

  const after = await homeExchangeClient.listMessages(CONVERSATION_ID);
  const afterConv = await homeExchangeClient.getConversation(CONVERSATION_ID);
  console.log('thread_has_draft:', alreadySentEquivalent(after, result.proposedResponse));
  console.log('conversation_declined:', conversationAlreadyDeclined(afterConv));
  console.log('accepted:', afterConv?.accepted);
  console.log(
    'exchange_status:',
    (afterConv.exchanges || []).map((ex) => ({
      id: ex.id,
      home: ex.home?.id,
      type: ex.type,
      status: ex.status,
    }))
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
