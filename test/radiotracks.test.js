import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, setSettings } from '../src/db.js';
import { inferChannels, songKey } from '../src/channels.js';

test('one song on several releases is one key; a live version or remix is a different song', () => {
  assert.equal(songKey('The Smiths', 'How Soon Is Now? (2011 Remaster)'), songKey('The Smiths', 'How Soon Is Now?'));
  assert.notEqual(songKey('A', 'Song'), songKey('A', 'Song (Live)'));
  assert.notEqual(songKey('A', 'Song'), songKey('A', 'Song (Remix)'));
});

test('radio: a repeated song is played once, junk and hour-long tracks are left out, sub-genres fold into one station', () => {
  const db = openDb(fs.mkdtempSync(path.join(os.tmpdir(), 'wbtv-radio-')));
  setSettings(db, { minChannelMinutes: 1 });
  const lib = Number(db.prepare("INSERT INTO libraries(name,path,type) VALUES('Music','/m','radio')").run().lastInsertRowid);
  const t = (title, genre, runtime, year, artist = 'Band') => db.prepare(`INSERT INTO items(library_id,kind,path,title,runtime,probed,studios,genres,actors,artist,year) VALUES (?,'track',?,?,?,1,'[]',?,'[]',?,?)`)
    .run(lib, `/m/${title}-${year}.mp3`, title, runtime, JSON.stringify([genre]), artist, year);
  for (let i = 0; i < 20; i++) t(`Song ${i}`, i % 2 ? 'Classic Rock' : 'Hard Rock', 200, 1990);
  t('Song 1 (2011 Remaster)', 'Classic Rock', 200, 2011); // same song again
  t('Skit', 'Rock', 12, 1991); t('Eight hour mix', 'Rock', 8 * 3600, 1992);
  inferChannels(db);
  const ch = db.prepare("SELECT key, item_count FROM channels WHERE kind='radio' AND key LIKE 'radio:genre:%' AND item_count>0").all();
  assert.deepEqual(ch.map((c) => c.key), ['radio:genre:rock box']);
  assert.equal(ch[0].item_count, 20);
});
