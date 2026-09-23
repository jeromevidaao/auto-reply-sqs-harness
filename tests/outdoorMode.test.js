import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideHvacModeFromOutdoorF,
  OUTDOOR_HEAT_MAX_F,
  buildOutdoorAutoFixSnippet,
} from '../src/tools/hvac/outdoorMode.js';

describe('decideHvacModeFromOutdoorF', () => {
  it('documents ≤62°F → heat (Tracy / Portland ~54°F)', () => {
    assert.equal(OUTDOOR_HEAT_MAX_F, 62);
    assert.equal(decideHvacModeFromOutdoorF(62).mode, 'heat');
    assert.equal(decideHvacModeFromOutdoorF(54).mode, 'heat');
    assert.equal(decideHvacModeFromOutdoorF(12 * 9 / 5 + 32).mode, 'heat');
  });

  it('picks cool above 62°F', () => {
    assert.equal(decideHvacModeFromOutdoorF(62.1).mode, 'cool');
    assert.equal(decideHvacModeFromOutdoorF(78).mode, 'cool');
  });

  it('returns null mode when temp missing', () => {
    assert.equal(decideHvacModeFromOutdoorF(null).mode, null);
    assert.equal(decideHvacModeFromOutdoorF(NaN).mode, null);
  });
});

describe('buildOutdoorAutoFixSnippet', () => {
  it('names bedroom + kitchen on heat for Tracy 1B', () => {
    const s = buildOutdoorAutoFixSnippet({
      guestName: 'Tracy',
      rooms: ['bedroom', 'kitchen'],
      mode: 'heat',
      outdoorTempF: 54,
    });
    assert.match(s, /^Tracy,/);
    assert.match(s, /I (?:fixed|set)/i);
    assert.match(s, /bedroom/);
    assert.match(s, /kitchen/);
    assert.match(s, /\bheat\b/);
    assert.match(s, /54\s*°?F/);
    assert.match(s, /should start working/);
    assert.doesNotMatch(s, /nest/i);
    assert.doesNotMatch(s, /1B|apt\s*#?\s*1/i);
  });
});
