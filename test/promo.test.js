import test from 'node:test';
import assert from 'node:assert/strict';
import { trimPlot, buildPromo, describe, spokenTitle, estimateSeconds } from '../src/promo.js';

const ep = (o = {}) => ({ id: 1, kind: 'episode', title: 'Pilot', show_title: 'Some Show', plot: '', genres: '[]', season: 1, episode: 2, ...o });

test('trimPlot does not split on abbreviations or initials', () => {
  const out = trimPlot("Michael's brother Ken comes to visit and brings his newest girlfriend. While Jr. is in love, chaos follows. Another sentence that is far too long to fit in here.", 150);
  assert.match(out, /While Jr\. is in love, chaos follows\.$/);
  const t = 'Dr. Smith visits St. Louis with J. R. Ewing. Then they leave.';
  assert.equal(trimPlot(t, 70), t);                                              // both sentences fit
  assert.equal(trimPlot(t, 50), 'Dr. Smith visits St. Louis with J. R. Ewing.'); // only the first, not cut at "Dr." or "St."
});

test('trimPlot strips dangling connectors left by truncated descriptions', () => {
  assert.equal(trimPlot('Follow three pals who run scams, mad capers, and...', 200), 'Follow three pals who run scams, mad capers.');
});

test('trimPlot only keeps whole sentences within the limit, and tolerates empty input', () => {
  assert.equal(trimPlot('One short sentence. A second sentence that pushes it over the limit.', 30), 'One short sentence.');
  assert.equal(trimPlot('', 100), '');
  assert.equal(trimPlot('Something.', 0), '');
});

test('describe falls back sensibly when there is no plot', () => {
  assert.equal(describe({ kind: 'movie', genres: '["Horror"]', year: 1999 }, 200), 'A horror film from 1999.');
  assert.equal(describe({ kind: 'movie', genres: '["Action"]' }, 200), 'An action film.');
  assert.equal(describe(ep({ title: 'The Smiths' }), 200), 'This episode is called The Smiths.');
  assert.equal(describe(ep({ title: 'Episode 4' }), 200), 'Season 1, episode 2.');
});

test('spokenTitle uses the show name for episodes and drops the year', () => {
  assert.equal(spokenTitle(ep()), 'Some Show');
  assert.equal(spokenTitle({ kind: 'movie', title: 'Payback (2023)' }), 'Payback');
});

test('buildPromo names the programmes in order and fits the available time', () => {
  const items = [ep({ id: 1, show_title: 'Alpha', plot: 'Alpha plot sentence one. Alpha two.' }), ep({ id: 2, show_title: 'Beta', plot: 'Beta plot.' }), ep({ id: 3, show_title: 'Gamma' })];
  const p = buildPromo('BBC Four', items, 60);
  assert.equal(p.segments.length, 3);
  assert.deepEqual(p.segments.map((s) => s.label), ['UP NEXT', 'AFTER THAT', 'LATER']);
  assert.match(p.segments[0].text, /BBC Four.*Alpha.*Alpha plot sentence one/);
  assert.ok(p.est <= 60 && p.dur >= p.est);
});

test('buildPromo drops detail, then programmes, when the gap is short', () => {
  const long = 'This is a fairly long description that goes on for a while. It has several sentences in it. And yet another one to pad it out nicely.';
  const items = [ep({ id: 1, show_title: 'Alpha', plot: long }), ep({ id: 2, show_title: 'Beta', plot: long }), ep({ id: 3, show_title: 'Gamma', plot: long })];
  const roomy = buildPromo('Ch', items, 60);
  const tight = buildPromo('Ch', items, 16);
  assert.ok(estimateSeconds(tight.segments) <= 16);
  assert.ok(tight.segments.length < roomy.segments.length || estimateSeconds(tight.segments) < estimateSeconds(roomy.segments));
  assert.equal(buildPromo('Ch', items, 3), null); // nothing can fit in 3 seconds
});

test('buildPromo can be told to read titles only', () => {
  const p = buildPromo('Ch', [ep({ show_title: 'Alpha', plot: 'A real plot.' })], 60, { readPlots: false });
  assert.doesNotMatch(p.segments[0].text, /real plot/);
});
