import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  airbnbListingIdFromContext,
  checkInYmdFromContext,
  guestCheckInKey,
  parseGuestCheckInItem,
  lookupGuestCheckIn,
  HOSPITABLE_UUID_TO_AIRBNB,
} from '../src/utils/guestCheckIns.js';
import { GuestMessagingAgent } from '../src/agent.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRootForTests = path.resolve(__dirname, '..');

const APT2_UUID = '114663c5-0709-4eff-a868-fa9ebd6ed42d';
const APT2_AIRBNB = '20150380';

describe('guestCheckIns PIN unlock (no AWS)', () => {
  it('maps Hospitable Apt 2 UUID to Airbnb numeric listing id', () => {
    assert.equal(HOSPITABLE_UUID_TO_AIRBNB[APT2_UUID], APT2_AIRBNB);
    assert.equal(airbnbListingIdFromContext({ listingId: APT2_UUID }), APT2_AIRBNB);
    assert.equal(airbnbListingIdFromContext({ airbnbListingId: APT2_AIRBNB }), APT2_AIRBNB);
  });

  it('builds guestCheckInDetect PK {listingId}_{YYYY-MM-DD}', () => {
    assert.equal(guestCheckInKey(APT2_AIRBNB, '2026-08-21'), '20150380_2026-08-21');
    assert.equal(
      guestCheckInKey(APT2_AIRBNB, '2026-08-21T16:00:00-04:00'),
      '20150380_2026-08-21'
    );
    assert.equal(checkInYmdFromContext({ checkIn: '2026-08-21T16:00:00-04:00' }), '2026-08-21');
  });

  it('parses a real check-in row as guestArrived', () => {
    const parsed = parseGuestCheckInItem({
      checkInKey: '20150380_2026-08-21',
      kind: 'checked_in',
      checkedInAt: '2026-08-21T20:12:00.000Z',
      guestName: 'Michael',
      lockName: 'Apt 2 parking-side',
    });
    assert.equal(parsed.guestArrived, true);
    assert.equal(parsed.checkedInAt, '2026-08-21T20:12:00.000Z');
    assert.equal(parsed.lockName, 'Apt 2 parking-side');
  });

  it('ignores noshow/lockout kinds and missing checkedInAt', () => {
    assert.equal(
      parseGuestCheckInItem({ checkInKey: '20150380_2026-08-21', kind: 'no_show' }).guestArrived,
      false
    );
    assert.equal(
      parseGuestCheckInItem({ checkInKey: '20150380_2026-08-21', kind: 'checked_in' }).guestArrived,
      false
    );
  });

  it('lookupGuestCheckIn uses mocked GetItem (no Dynamo)', async () => {
    const got = await lookupGuestCheckIn({
      airbnbListingId: APT2_AIRBNB,
      checkInYmd: '2026-08-21',
      getItem: async ({ Key }) => {
        assert.equal(Key.checkInKey, '20150380_2026-08-21');
        return {
          Item: {
            checkInKey: Key.checkInKey,
            kind: 'checked_in',
            checkedInAt: '2026-08-21T20:12:00.000Z',
            guestName: 'Michael',
            lockName: 'Apt 2 parking-side',
          },
        };
      },
    });
    assert.equal(got.guestArrived, true);
    assert.equal(got.checkedInAt, '2026-08-21T20:12:00.000Z');
  });

  it('lookupGuestCheckIn fail-open when GetItem throws', async () => {
    const got = await lookupGuestCheckIn({
      context: { listingId: APT2_UUID, checkIn: '2026-08-21' },
      getItem: async () => {
        throw new Error('Dynamo unavailable');
      },
    });
    assert.equal(got.guestArrived, false);
  });
});

describe('Schlage PIN enrich + in-stay crib (no LLM)', () => {
  const michaelCtx = {
    guestName: 'Michael',
    listingId: APT2_UUID,
    propertyName: 'Sunny Downtown 2 Bed Apt, Parking',
    checkIn: '2026-08-21T16:00:00-04:00',
    checkOut: '2026-08-24T10:00:00-04:00',
    asOfDate: '2026-08-21',
  };

  it('enriches guestArrived from guestCheckInsLookup', async () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' },
      guestCheckInsLookup: async () => ({
        guestArrived: true,
        checkedInAt: '2026-08-21T20:12:00.000Z',
        lockName: 'Apt 2 parking-side',
        checkInKey: '20150380_2026-08-21',
      }),
    });
    const ctx = { ...michaelCtx };
    await agent._enrichGuestCheckInFromSchlage(ctx);
    assert.equal(ctx.guestArrived, true);
    assert.equal(ctx.guestArrivedAt, '2026-08-21T20:12:00.000Z');
    assert.equal(agent._guestPhysicallyArrived(ctx), true);
  });

  it('PIN unlock + where-is-crib (no "just entered") still uses Apt 2 closet copy', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' },
    });
    const ctx = { ...michaelCtx, guestArrived: true, guestArrivedAt: '2026-08-21T20:12:00.000Z' };
    const msg = 'Can you please remind me where the crib is located?';
    assert.equal(agent._looksLikeInStayCribLocationAsk(msg, ctx), true);
    const applied = agent._applyInStayCribLocationPolicy(
      {
        typeOfMessageReceived: 'PACK_AND_PLAY_BRAND',
        proposedResponse: 'Michael, the Graco Pack and Play is already set up and ready in the unit for you.',
      },
      ctx,
      msg
    );
    assert.equal(applied.applied, true);
    assert.match(applied.proposedResponse, /closet of the smaller bedroom/i);
    assert.match(applied.proposedResponse, /let us know if you cannot find/i);
    assert.doesNotMatch(applied.proposedResponse, /already set up/i);
  });

  it('does not treat a future guest as arrived without a PIN row', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' },
    });
    const kyrieCtx = {
      guestName: 'Kyrie',
      listingId: APT2_UUID,
      checkIn: '2026-07-10',
      checkOut: '2026-07-13',
      asOfDate: '2026-06-20',
      guestArrived: false,
    };
    assert.equal(
      agent._looksLikeInStayCribLocationAsk(
        'Would it be possible to have a crib available?',
        kyrieCtx
      ),
      false
    );
  });
});
