import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, setSettings } from '../src/db.js';
import { inferChannels } from '../src/channels.js';

const fresh = () => {
  const db = openDb(fs.mkdtempSync(path.join(os.tmpdir(), 'wbtv-grp-')));
  setSettings(db, { minChannelMinutes: 1, movieStudioMinFilms: 1 });
  let n = 0;
  const lib = (name, type, group = null, mode = 'inferred') => Number(db.prepare('INSERT INTO libraries(name,path,type,channel_group,group_mode) VALUES(?,?,?,?,?)').run(name, `/mnt/${name}-${n++}`, type, group, mode).lastInsertRowid);
  const movie = (libId, title, genre = 'Comedy', studio = 'Acme') => db.prepare(`INSERT INTO items(library_id,kind,path,title,runtime,probed,studios,genres,actors,year)
    VALUES (?,'movie',?,?,5400,1,?,?,'[]',1999)`).run(libId, `/mnt/${libId}/${title}.mkv`, title, JSON.stringify([studio]), JSON.stringify([genre]));
  const show = (libId, name, genre = 'Comedy', studio = 'Acme TV') => {
    const sid = Number(db.prepare('INSERT INTO shows(library_id,path,title,studios,genres) VALUES(?,?,?,?,?)').run(libId, `/mnt/${libId}/${name}`, name, JSON.stringify([studio]), JSON.stringify([genre])).lastInsertRowid);
    for (let e = 1; e <= 3; e++) db.prepare(`INSERT INTO items(library_id,show_id,kind,path,title,runtime,probed,studios,genres,actors,season,episode)
      VALUES (?,?,'episode',?,?,1800,1,'[]','[]','[]',1,?)`).run(libId, sid, `/mnt/${libId}/${name}/e${e}.mkv`, `${name} ${e}`, e);
  };
  const clip = (libId, title) => db.prepare(`INSERT INTO items(library_id,kind,path,title,runtime,probed,studios,genres,actors,artist)
    VALUES (?,'clip',?,?,240,1,'[]','[]','[]','')`).run(libId, `/mnt/${libId}/${title}.mp4`, title);
  const channels = () => db.prepare('SELECT key, kind, COALESCE(name_override, auto_name) AS name, item_count FROM channels WHERE item_count>0 ORDER BY key').all();
  return { db, lib, movie, show, clip, channels };
};

test('libraries sharing a group become one channel (films and shows together), and only that when the mode is "one channel"', () => {
  const { lib, movie, show, channels, db } = fresh();
  const films = lib('Stand Up Films', 'movies', 'Stand Up', 'single'), unmanaged = lib('Stand Up Films - Unmanaged', 'movies', 'Stand Up', 'single'), shows = lib('Stand Up Shows', 'tv', 'Stand Up', 'single');
  movie(films, 'Film A'); movie(films, 'Film B'); movie(unmanaged, 'Film C'); show(shows, 'Special Show');
  inferChannels(db);
  assert.deepEqual(channels().map((c) => [c.key, c.name, c.kind, c.item_count]), [['group:stand-up', 'Stand Up', 'tv', 6]]);
});

test('"both" keeps the normal genre and studio channels as well as the group channel', () => {
  const { lib, movie, channels, db } = fresh();
  const l = lib('Live Music Films', 'movies', 'Live Music', 'both');
  movie(l, 'Gig 1', 'Music', 'Studio X'); movie(l, 'Gig 2', 'Music', 'Studio X');
  inferChannels(db);
  const keys = channels().map((c) => c.key);
  assert.ok(keys.includes('group:live-music'));
  assert.ok(keys.some((k) => k.startsWith('movie:genre:')), `genre channel in ${keys}`);
});

test('a library with no group and the default mode behaves exactly as before', () => {
  const { lib, movie, channels, db } = fresh();
  const l = lib('Movies', 'movies');
  movie(l, 'Film A', 'Horror'); movie(l, 'Film B', 'Horror');
  inferChannels(db);
  const keys = channels().map((c) => c.key);
  assert.ok(!keys.some((k) => k.startsWith('group:')));
  assert.ok(keys.some((k) => k.startsWith('movie:genre:horror')));
});

test('a "one channel" library with no group name is named after the library; it stays out of the genre channels', () => {
  const { lib, movie, channels, db } = fresh();
  const a = lib('Documentary Films', 'movies', null, 'single');
  const b = lib('Movies', 'movies');
  movie(a, 'Doc 1', 'Documentary'); movie(a, 'Doc 2', 'Documentary');
  movie(b, 'Film 1', 'Documentary'); movie(b, 'Film 2', 'Documentary'); movie(b, 'Film 3', 'Documentary');
  inferChannels(db);
  const ch = Object.fromEntries(channels().map((c) => [c.key, c]));
  assert.equal(ch['group:documentary-films'].item_count, 2);
  assert.equal(ch['movie:genre:documentary'].item_count, 3, 'the single-channel library does not feed the genre channel');
});

test('clips and interviews form one shuffled channel of their own', () => {
  const { lib, clip, channels, db } = fresh();
  const l = lib('Interviews', 'clips');
  for (const t of ['One', 'Two', 'Three', 'Four']) clip(l, t);
  inferChannels(db);
  assert.deepEqual(channels().map((c) => [c.key, c.name, c.kind, c.item_count]), [['group:interviews', 'Interviews', 'clips', 4]]);
});

test('a mixed films-and-shows group channel actually schedules both, and a clips channel schedules back to back', async () => {
  const { ensureSchedule } = await import('../src/scheduler.js');
  const { lib, movie, show, clip, db } = fresh();
  const films = lib('Music Docs - Films', 'movies', 'Music Docs', 'single'), shows = lib('Music Docs - Shows', 'tv', 'Music Docs', 'single'), c = lib('Clips', 'clips');
  for (const t of ['F1', 'F2', 'F3']) movie(films, t);
  show(shows, 'Show A'); show(shows, 'Show B');
  for (const t of ['c1', 'c2', 'c3', 'c4', 'c5']) clip(c, t);
  inferChannels(db);
  await ensureSchedule(db, Date.now() / 1000);
  const kinds = (key) => db.prepare(`SELECT DISTINCT i.kind FROM programmes p JOIN items i ON i.id=p.item_id JOIN channels ch ON ch.id=p.channel_id WHERE ch.key=?`).all(key).map((r) => r.kind).sort();
  assert.deepEqual(kinds('group:music-docs'), ['episode', 'movie']);
  assert.deepEqual(kinds('group:clips'), ['clip']);
  const n = db.prepare("SELECT COUNT(*) n FROM programmes p JOIN channels ch ON ch.id=p.channel_id WHERE ch.key='group:clips'").get().n;
  assert.ok(n > 10, `clips channel planned ${n} programmes`);
});

test('a group first created from a library of films becomes a TV channel once a library of shows joins it', () => {
  const { lib, movie, show, db } = fresh();
  const films = lib('Stand Up Films', 'movies', 'Stand Up', 'single');
  movie(films, 'Film A');
  inferChannels(db);
  assert.equal(db.prepare("SELECT kind FROM channels WHERE key='group:stand-up'").get().kind, 'movie');
  const shows = lib('Stand Up Shows', 'tv', 'Stand Up', 'single');
  show(shows, 'Special');
  inferChannels(db);
  assert.equal(db.prepare("SELECT kind FROM channels WHERE key='group:stand-up'").get().kind, 'tv');
});

test('a channel remembers the channel group its programmes come from (the guide makes a chip per group)', () => {
  const { lib, movie, channels, db } = fresh();
  const a = lib('Stand Up Films', 'movies', 'Stand Up', 'single'), plain = lib('Films', 'movies');
  movie(a, 'Film A'); movie(plain, 'Film B');
  inferChannels(db);
  const g = (key) => db.prepare('SELECT grp FROM channels WHERE key=?').get(key)?.grp;
  assert.equal(g('group:stand-up'), 'Stand Up');
  assert.equal(g('movie:genre:comedy'), null); // a genre channel made only from ungrouped libraries
  assert.ok(channels().length >= 2);
});
