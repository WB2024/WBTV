import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { inferChannels, talkPerTitle } from '../src/channels.js';
import { ensureSchedule } from '../src/scheduler.js';

const fresh = () => {
  const db = openDb(fs.mkdtempSync(path.join(os.tmpdir(), 'wbtv-talk-')));
  const lib = (name, type) => Number(db.prepare('INSERT INTO libraries(name,path,type) VALUES(?,?,?)').run(name, `/mnt/${name}`, type).lastInsertRowid);
  const item = (libId, album, n, runtime = 900) => db.prepare(`INSERT INTO items(library_id,kind,path,title,runtime,probed,studios,genres,actors,artist,album,episode)
    VALUES (?,'talk',?,?,?,1,'[]','["x"]','[]','Someone',?,?)`).run(libId, `/mnt/${album}/${n}.mp3`, `${album} - ${n}`, runtime, album, n);
  return { db, lib, item };
};
const radioChannels = (db) => db.prepare("SELECT key, COALESCE(name_override, auto_name) AS name, item_count FROM channels WHERE kind='radio' ORDER BY key").all();

test('podcasts get one channel per show by default, named after the show', () => {
  const { db, lib, item } = fresh();
  const p = lib('Podcasts', 'talk_podcasts');
  for (let n = 1; n <= 3; n++) { item(p, 'Absolutely Mental', n); item(p, 'Happy Place', n); }
  assert.equal(talkPerTitle(db, p, 'talk_podcasts'), true);
  inferChannels(db);
  assert.deepEqual(radioChannels(db).map((c) => [c.name, c.item_count]), [['Absolutely Mental', 3], ['Happy Place', 3]]);
});

test('audiobooks are one station by default, and one channel per book when switched on', () => {
  const { db, lib, item } = fresh();
  const a = lib('Audiobooks', 'talk_audiobooks');
  for (let n = 1; n <= 4; n++) { item(a, 'Book One', n); item(a, 'Book Two', n); }
  assert.equal(talkPerTitle(db, a, 'talk_audiobooks'), false);
  inferChannels(db);
  assert.deepEqual(radioChannels(db).map((c) => [c.name, c.item_count]), [['Audiobooks', 8]]);
  db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(`talk_per_title_${a}`, '1');
  inferChannels(db);
  const live = radioChannels(db).filter((c) => c.item_count > 0);
  assert.deepEqual(live.map((c) => [c.name, c.item_count]), [['Book One', 4], ['Book Two', 4]]);
  assert.equal(radioChannels(db).find((c) => c.name === 'Audiobooks').item_count, 0, 'the old station is left empty, not deleted');
});

test('a per-book channel plays its chapters in order and then loops from chapter one', () => {
  const { db, lib, item } = fresh();
  const a = lib('Audiobooks', 'talk_audiobooks');
  // track numbers deliberately inserted out of order
  for (const n of [5, 2, 9, 1, 7, 3, 8, 4, 6]) item(a, 'Long Book', n, 1800);
  db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(`talk_per_title_${a}`, '1');
  inferChannels(db);
  ensureSchedule(db, Date.now() / 1000);
  const ch = db.prepare("SELECT id FROM channels WHERE kind='radio' AND item_count>0").get().id;
  const seq = db.prepare('SELECT i.episode FROM programmes p JOIN items i ON i.id=p.item_id WHERE p.channel_id=? ORDER BY p.start').all(ch).map((r) => r.episode);
  assert.ok(seq.length > 18, `planned ${seq.length} chapters`); // more than two full passes through the book
  for (let i = 0; i < seq.length; i++) assert.equal(seq[i], (i % 9) + 1, `position ${i}: ${seq.join(',')}`);
});
