import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLrc, parseSrt, parsePlain, parseLyrics, buildAss, fontFamily, decode } from '../src/lyrics.js';
import { yearFromTags } from '../src/scanner.js';

test('lrc: several stamps per line, offset, metadata ignored, word tags stripped', () => {
  const l = parseLrc('[ar:Someone]\n[offset:+500]\n[00:10.00]First <00:10.50>line\n[00:20.5][00:40.00]Chorus\n[01:02]Last\n');
  assert.deepEqual(l.map((x) => [x.t, x.text]), [[9.5, 'First line'], [20, 'Chorus'], [39.5, 'Chorus'], [61.5, 'Last']]);
});

test('srt parses times and strips tags', () => {
  const l = parseSrt('1\n00:00:01,000 --> 00:00:03,500\n<i>Hello</i>\n\n2\n00:00:04,000 --> 00:00:06,000\nWorld\n');
  assert.deepEqual(l.map((x) => [x.t, x.end, x.text]), [[1, 3.5, 'Hello'], [4, 6, 'World']]);
});

test('plain text becomes pages of at most five lines, section headers dropped', () => {
  const p = parsePlain('[Verse 1]\nl1\nl2\n\nl3\nl4\nl5\nl6\nl7\nl8\n');
  assert.deepEqual(p.map((x) => x.length), [2, 5, 1]);
  assert.ok(!p.flat().some((x) => x.startsWith('[')));
});

test('parseLyrics detects synced text inside a .txt, and falls back to pages', () => {
  assert.ok(parseLyrics('[00:01.00]a\n[00:05.00]b\n[00:09.00]c', '.txt').synced);
  assert.ok(parseLyrics('just words\nmore words').pages);
  assert.equal(parseLyrics('   '), null);
});

test('ass: times are relative to the start of the encoded slice and clamped', () => {
  const lyr = { synced: [{ t: 10, text: 'one' }, { t: 20, text: 'two' }, { t: 30, text: 'three' }] };
  const ass = buildAss(lyr, { offset: 25, dur: 20, total: 100, W: 1280, H: 720, tx: 400, font: 'Arial' });
  const cur = ass.split('\n').filter((x) => x.startsWith('Dialogue') && x.includes(',Cur,'));
  assert.equal(cur.length, 2); // "one" ended before the slice began
  assert.ok(cur[0].includes('0:00:00.00,0:00:05.00') && cur[0].includes('two'));
  assert.ok(cur[1].includes('0:00:05.00,0:00:11.00') && cur[1].includes('three'));
});

test('ass: plain pages cover the song and text is escaped', () => {
  const ass = buildAss({ pages: [['a {b}', 'c'], ['d']] }, { offset: 0, dur: 100, total: 100, W: 1280, H: 720, tx: 100, font: 'Arial' });
  assert.ok(ass.includes('a b\\Nc'));
  assert.equal(ass.split('\n').filter((x) => x.startsWith('Dialogue')).length, 2);
});

test('font family guesses and encoding fallback', () => {
  assert.equal(fontFamily('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'), 'DejaVu Sans');
  assert.equal(fontFamily('arialbd.ttf'), 'Arial');
  assert.equal(decode(Buffer.from([0x63, 0x61, 0x66, 0xe9])), 'café'); // latin-1 file
});

test('year from tags ignores junk dates and falls back to the album folder', () => {
  assert.equal(yearFromTags({ date: '0001-01-01', originalyear: '1985' }, '/m/x'), 1985);
  assert.equal(yearFromTags({ date: '1999-05-01' }, '/m/x'), 1999);
  assert.equal(yearFromTags({ date: '0001-01-01' }, '/m/[1985] Hounds of Love'), 1985);
  assert.equal(yearFromTags({}, '/m/Album'), null);
});
