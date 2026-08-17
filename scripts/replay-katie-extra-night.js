/**
 * Replay Katie's HE cancel + extra-night resubmit through the isolated
 * HomeExchange auto-reply path. Aborts if already pre-approved or if a
 * Nov 3 pre-approval note is already on the thread.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { HomeExchangeClient } from '../src/clients/HomeExchangeClient.js';
import { HospitableClient } from '../src/clients/HospitableClient.js';
import { notifyOwnerAndroid } from '../src/adapters/notification/fcm.js';
import { createDdbBlockStore } from '../src/useCases/homeExchangeBlocks.js';
import { handleHomeExchangeMessage } from '../src/useCases/homeExchange.js';
import { exchangeAlreadyApproved } from '../src/clients/homeExchangeExchange.js';

const CONVERSATION_ID = '95201321';
const HOME_ID = '3285044';
const PROPERTY_ID = '114663c5-0709-4eff-a868-fa9ebd6ed42d';

function textOf(m) {
  return String(m?.content || m?.body || m?.text || '');
}

async function main() {
  const homeExchangeClient = new HomeExchangeClient();
  const hospitableClient = new HospitableClient();
  const ddbClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-1' }));

  const messages = await homeExchangeClient.listMessages(CONVERSATION_ID);
  const last = messages[messages.length - 1] || {};
  const lastText = textOf(last);
  console.log('last_message:', lastText.slice(0, 240));

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

  if (exchangeAlreadyApproved(exchange, conversation)) {
    console.log('ABORT: already pre-approved — not sending again');
    return;
  }
  if (/blocked those dates/i.test(lastText) && /November 3, 2026/i.test(lastText)) {
    console.log('ABORT: Nov 3 pre-approval note already last on thread');
    return;
  }

  const days = await hospitableClient.getPropertyCalendar(
    PROPERTY_ID,
    '2026-10-29',
    '2026-11-04'
  );
  const reservations = await hospitableClient.getPropertyReservations(
    PROPERTY_ID,
    '2026-10-15',
    '2026-11-17'
  );
  console.log(
    'hospitable_days:',
    (days || []).map((d) => ({
      date: d.date,
      available: d.status?.available ?? d.available,
      reason: d.status?.reason,
      source: d.status?.source_type,
    }))
  );
  console.log(
    'hospitable_reservations:',
    (reservations || []).map((r) => ({
      id: r.id,
      check_in: r.check_in,
      check_out: r.check_out,
      status: r.reservation_status?.current?.category || r.status,
      platform: r.platform || r.source,
    }))
  );

  const result = await handleHomeExchangeMessage({
    event: {
      message: 'Just submitted, thank you!',
      context: {
        platform: 'homeexchange',
        isFirstMessage: false,
        conversation_id: CONVERSATION_ID,
        guestName: 'Katie',
        checkIn: '2026-10-29',
        checkOut: '2026-11-03',
        listing: { platform: 'homeexchange', platform_id: HOME_ID },
      },
    },
    hospitableClient,
    ddbClient,
    homeExchangeClient,
    notifyOwner: notifyOwnerAndroid,
    blockStore: createDdbBlockStore(ddbClient),
  });

  console.log('result:', {
    reason: result.reason,
    sent: result.sent,
    sendSkipReason: result.sendSkipReason,
    sendError: result.sendError,
    extraNights: result.extraNights,
    extraNightsOpen: result.extraNightsOpen,
    leftoverNights: result.leftoverNights,
    calendarOpen: result.calendar?.open,
    calendarUnavailable: result.calendar?.unavailable,
    preapprove: result.preapprove,
    proposedResponse: result.proposedResponse,
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
