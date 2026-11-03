import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normLang, choose, subtitleFilter } from '../src/streams.js';

const A = (lang, title = '') => ({ lang, title });
const S = (lang, codec = 'subrip', extra = {}) => ({ lang, codec, title: '', forced: false, ...extra });

test('language codes are matched across 2-letter, 3-letter and names', () => {
  assert.equal(normLang('en'), 'eng');
  assert.equal(normLang('eng'), 'eng');
  assert.equal(normLang('English'), 'eng');
  assert.equal(normLang('ja'), 'jpn');
  assert.equal(normLang('und'), '');
  assert.equal(normLang(''), '');
});

test('the audio track in the preferred language wins over the first track', () => {
  const c = choose({ audio: [A('jpn'), A('eng')], subs: [] }, { language: 'eng', subtitleMode: 'foreign' });
  assert.equal(c.audio, 1);
  assert.equal(c.sub, null);
});

test('a commentary track is not chosen when a normal one exists', () => {
  const c = choose({ audio: [A('eng', 'Director commentary'), A('eng')], subs: [] }, { language: 'eng' });
  assert.equal(c.audio, 1);
});

test('no audio in your language: the matching text subtitle is burned in', () => {
  const info = { audio: [A('jpn')], subs: [S('fre'), S('eng', 'hdmv_pgs_subtitle'), S('eng'), S('eng', 'subrip', { title: 'SDH' })] };
  const c = choose(info, { language: 'eng', subtitleMode: 'foreign' });
  assert.equal(c.audio, 0);
  assert.equal(c.sub, 2); // not the bitmap one, not the SDH one, not French
});

test('audio in your language: no subtitles, except a forced track for foreign dialogue', () => {
  const plain = { audio: [A('eng')], subs: [S('eng')] };
  assert.equal(choose(plain, { language: 'eng', subtitleMode: 'foreign' }).sub, null);
  const forced = { audio: [A('eng')], subs: [S('eng'), S('eng', 'subrip', { forced: true })] };
  assert.equal(choose(forced, { language: 'eng', subtitleMode: 'foreign' }).sub, 1);
});

test('modes: off never burns; always burns the full track', () => {
  const info = { audio: [A('jpn')], subs: [S('eng')] };
  assert.equal(choose(info, { language: 'eng', subtitleMode: 'off' }).sub, null);
  const dubbed = { audio: [A('eng')], subs: [S('eng')] };
  assert.equal(choose(dubbed, { language: 'eng', subtitleMode: 'always' }).sub, 0);
});

test('an untagged audio track is assumed fine, so subtitles are not burned over it', () => {
  const c = choose({ audio: [A('')], subs: [S('eng')] }, { language: 'eng', subtitleMode: 'foreign' });
  assert.equal(c.sub, null);
});

test('files without stream information fall back to the first track', () => {
  const c = choose({}, { language: 'eng' });
  assert.equal(c.audio, 0);
  assert.equal(c.sub, null);
});

test('the subtitle filter shifts timestamps for a mid-file start and not for the start', () => {
  const mid = subtitleFilter('/config/subs/abc.ass', 120.5);
  assert.ok(mid.startsWith('setpts=PTS+120.500/TB,subtitles=filename=/config/subs/abc.ass'));
  assert.ok(mid.endsWith(',setpts=PTS-120.500/TB'));
  const start = subtitleFilter('/config/subs/abc.ass', 0);
  assert.ok(start.startsWith('subtitles=filename='));
  assert.ok(!start.includes('setpts'));
});
