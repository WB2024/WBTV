import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, daypartWeight, guessAdYear, eraWeight, programmeYear } from '../src/daypart.js';
import { signOffEnd } from '../src/scheduler.js';

const at = (h, m = 0, day = 1) => new Date(2026, 0, 4 + day, h, m).getTime() / 1000; // 2026-01-05 is a Monday; day 6 = Saturday

test('cartoons suit Saturday morning and not late at night', () => {
  const kids = classify(['Animation', 'Family'], 'TV-Y7');
  assert.ok(daypartWeight(kids, at(9, 0, 6)) > 5);
  assert.ok(daypartWeight(kids, at(23, 30)) < 0.2);
});

test('mature and horror content is kept for late evening', () => {
  const horror = classify(['Horror'], 'R');
  assert.ok(daypartWeight(horror, at(14, 0)) < 0.05);
  assert.ok(daypartWeight(horror, at(23, 30)) > 8);
});

test('unknown metadata stays neutral and weights are bounded', () => {
  const none = classify([], '');
  assert.equal(daypartWeight(none, at(12)), 1);
  for (const h of [0, 6, 12, 18, 23]) {
    const w = daypartWeight(classify(['Horror', 'Animation'], 'TV-MA'), at(h));
    assert.ok(w >= 0.02 && w <= 30);
  }
});

test('ad years are read from titles and folders', () => {
  assert.equal(guessAdYear('Coca-Cola advert 1994'), 1994);
  assert.equal(guessAdYear('/mnt/ads/1990s/choc.mp4'), 1995);
  assert.equal(guessAdYear('/mnt/ads/80s/crisps.mp4'), 1985);
  assert.equal(guessAdYear('/config/ads/12345.mp4'), null);
  assert.equal(guessAdYear('Walkers crisps'), null);
});

test('adverts from the same era are strongly preferred; unknown ones are neutral', () => {
  assert.ok(eraWeight(1994, 1996) > eraWeight(2012, 1996) * 10);
  assert.equal(eraWeight(null, 1996), 1);
  assert.equal(eraWeight(1994, null), 1);
});

test('programme year falls back to the air date, then the show', () => {
  assert.equal(programmeYear({ year: 1999 }), 1999);
  assert.equal(programmeYear({ aired: '1987-03-02' }), 1987);
  assert.equal(programmeYear({ show_year: 2004 }), 2004);
  assert.equal(programmeYear({}), null);
});

test('closedown window (also overnight) returns when it ends', () => {
  const s = { signOffEnabled: true, signOffFrom: '03:00', signOffTo: '05:00' };
  assert.equal(signOffEnd(s, at(2, 59)), null);
  assert.equal(signOffEnd(s, at(3, 0)), at(5, 0));
  assert.equal(signOffEnd(s, at(4, 30)), at(5, 0));
  assert.equal(signOffEnd(s, at(5, 0)), null);
  const night = { signOffEnabled: true, signOffFrom: '23:30', signOffTo: '05:00' };
  assert.equal(signOffEnd(night, at(23, 45)), at(5, 0, 2));
  assert.equal(signOffEnd(night, at(1, 0, 2)), at(5, 0, 2));
  assert.equal(signOffEnd({ ...s, signOffEnabled: false }, at(4)), null);
});
