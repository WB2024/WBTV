import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { audit } from '../tools/mvtool.mjs';
import { plan, apply, undo, nfoXml } from '../tools/mvfix.mjs';

const OLD_NFO = '<?xml version="1.0"?><musicvideo><plot>Music video by Morrissey performing Boxers.</plot><lockdata>false</lockdata><dateadded>2024-04-02 08:18:34</dateadded><title>Morrissey - Boxers</title><year>20090920</year><artist>Morrissey</artist></musicvideo>';

const tree = (root) => { const out = []; const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out.push(path.relative(root, p).split(path.sep).join('/')); } }; walk(root); return out.sort(); };

const fixture = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wbtv-mv-'));
  const put = (rel, text = 'x') => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
  put('Morrissey/Morrissey - Boxers (Official Video).mp4', 'video-hd');
  put('Morrissey/Morrissey - Boxers (Official Video).nfo', OLD_NFO);
  put('Morrissey/Morrissey - Boxers (Official Video)-poster.jpg', 'pic');
  put('Morrissey/Morrissey - Boxers.avi', 'video-sd');                       // the same song, lower quality
  put('Hole/Hole - 1996 - Gold Dust Woman.mpg', 'v');
  put('Hole/Hole - Gold Dust Woman (Live).mp4', 'live');                      // a different video (live), not a duplicate
  put('Joy Division/Nested/23 Love Will Tear Us Apart.m4v', 'v');
  return root;
};
const q = (file) => ({ score: file.endsWith('.avi') ? 1 : 10, height: 0, bitrate: 0 });

test('a dry run changes nothing', () => {
  const root = fixture();
  const before = tree(root);
  const rows = audit(root).rows;
  const p = plan(rows, root, { quality: q });
  assert.ok(p.moves.length > 0);
  assert.deepEqual(tree(root), before);
});

test('files are renamed, nfo files rewritten with a real year or none, extra copies set aside, live versions kept', () => {
  const root = fixture();
  const p = plan(audit(root).rows, root, { quality: q });
  assert.equal(p.dups.length, 1);
  apply(p, root);
  const t = tree(root).filter((f) => !f.startsWith('.mvtool/'));
  assert.deepEqual(t, [
    '.duplicates/Morrissey/Morrissey - Boxers.avi',
    'Hole/Hole - Gold Dust Woman (Live).mp4', 'Hole/Hole - Gold Dust Woman.mpg', 'Hole/Hole - Gold Dust Woman.nfo', 'Hole/Hole - Gold Dust Woman (Live).nfo',
    'Joy Division/Joy Division - Love Will Tear Us Apart.m4v', 'Joy Division/Joy Division - Love Will Tear Us Apart.nfo',
    'Morrissey/Morrissey - Boxers-poster.jpg', 'Morrissey/Morrissey - Boxers.mp4', 'Morrissey/Morrissey - Boxers.nfo',
  ].sort());
  assert.ok(!fs.existsSync(path.join(root, 'Joy Division/Nested')), 'the emptied folder is gone');
  const nfo = fs.readFileSync(path.join(root, 'Morrissey/Morrissey - Boxers.nfo'), 'utf8');
  assert.match(nfo, /<title>Boxers<\/title>/);
  assert.match(nfo, /<artist>Morrissey<\/artist>/);
  assert.ok(!nfo.includes('20090920'), 'the upload date is not kept as a year');
  assert.match(nfo, /<lockdata>true<\/lockdata>/);
  assert.match(nfo, /<plot>Music video by Morrissey performing Boxers\.<\/plot>/);
  assert.match(fs.readFileSync(path.join(root, 'Hole/Hole - Gold Dust Woman.nfo'), 'utf8'), /<year>1996<\/year>/); // the year in the file name
});

test('undo puts every file and the original .nfo back', () => {
  const root = fixture();
  const before = tree(root);
  const r = apply(plan(audit(root).rows, root, { quality: q }), root);
  assert.notDeepEqual(tree(root).filter((f) => !f.startsWith('.mvtool/')), before);
  undo(r.logFile);
  assert.deepEqual(tree(root).filter((f) => !f.startsWith('.mvtool/')), before);
  assert.equal(fs.readFileSync(path.join(root, 'Morrissey/Morrissey - Boxers (Official Video).nfo'), 'utf8'), OLD_NFO);
});

test('nfo text is escaped and only has a year when there is one', () => {
  const x = nfoXml({ title: 'Rock & Roll <1>', artist: 'AC/DC', year: null, genres: ['Rock - Hard'] }, null);
  assert.match(x, /<title>Rock &amp; Roll &lt;1&gt;<\/title>/);
  assert.ok(!x.includes('<year>'));
  assert.match(x, /<genre>Rock - Hard<\/genre>/);
});

test('a kept copy can take over a name (and poster) that an extra copy currently has', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wbtv-mv-'));
  const put = (rel, text = 'x') => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
  put('Hole/Hole - Gold Dust Woman (ntsc lpcm) [1996].vob', 'dvd'); put('Hole/Hole - Gold Dust Woman (ntsc lpcm) [1996]-poster.jpg', 'p1'); put('Hole/Hole - Gold Dust Woman (ntsc lpcm) [1996].nfo', OLD_NFO);
  put('Hole/Hole - Gold Dust Woman.mp4', 'web'); put('Hole/Hole - Gold Dust Woman-poster.jpg', 'p2'); put('Hole/Hole - Gold Dust Woman.nfo', OLD_NFO);
  const before = tree(root);
  const r = apply(plan(audit(root).rows, root, { quality: (f) => ({ score: f.endsWith('.vob') ? 10 : 1, height: 0, bitrate: 0 }) }), root);
  const now = tree(root).filter((f) => !f.startsWith('.mvtool/'));
  assert.deepEqual(now, ['.duplicates/Hole/Hole - Gold Dust Woman-poster.jpg', '.duplicates/Hole/Hole - Gold Dust Woman.mp4', '.duplicates/Hole/Hole - Gold Dust Woman.nfo',
    'Hole/Hole - Gold Dust Woman-poster.jpg', 'Hole/Hole - Gold Dust Woman.nfo', 'Hole/Hole - Gold Dust Woman.vob'].sort());
  assert.equal(fs.readFileSync(path.join(root, 'Hole/Hole - Gold Dust Woman-poster.jpg'), 'utf8'), 'p1'); // the kept copy's own picture
  undo(r.logFile);
  assert.deepEqual(tree(root).filter((f) => !f.startsWith('.mvtool/')), before);
});

test('an .mp4 and an .mpg of one song share a poster and .nfo: extra copies set aside without touching the shared files, nothing moved twice', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wbtv-mv-'));
  const put = (rel, text = 'x') => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
  put('Hole/Hole - Gold Dust Woman.mp4', 'web'); put('Hole/Hole - Gold Dust Woman.mpg', 'old'); put('Hole/Hole - Gold Dust Woman-poster.jpg', 'p'); put('Hole/Hole - Gold Dust Woman.nfo', OLD_NFO);
  put('Hole/Hole - 1996 - Gold Dust Woman.mpg', 'old2');
  const before = tree(root);
  const p = plan(audit(root).rows, root, { quality: (f) => ({ score: f.endsWith('.mp4') ? 10 : 1, height: 0, bitrate: 0 }) });
  assert.equal(new Set(p.moves.map((m) => m.from)).size, p.moves.length, 'every file is moved at most once');
  const r = apply(p, root);
  const now = tree(root).filter((f) => !f.startsWith('.mvtool/'));
  assert.ok(now.includes('Hole/Hole - Gold Dust Woman.mp4') && now.includes('Hole/Hole - Gold Dust Woman-poster.jpg'));
  assert.ok(now.includes('.duplicates/Hole/Hole - Gold Dust Woman.mpg') && now.includes('.duplicates/Hole/Hole - 1996 - Gold Dust Woman.mpg'));
  undo(r.logFile);
  assert.deepEqual(tree(root).filter((f) => !f.startsWith('.mvtool/')), before);
  assert.ok(!fs.existsSync(path.join(root, '.duplicates')), 'undo leaves no empty folders behind');
});
