import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wbtv-nd-'));
process.env.WBTV_CONFIG = dir;
const { openDb } = await import('../src/db.js');
const { scanLibrary } = await import('../src/scanner.js');
const { inferChannels } = await import('../src/channels.js');
const { normalizeUrl, resolveMedia } = await import('../src/mediaserver.js');
const { subsonicDiscover, fetchLyrics } = await import('../src/navidrome.js');

// a tiny Navidrome: password "secret", one folder, 600 songs on 3 albums (so the 500-per-page paging is exercised)
const PASSWORD = 'secret';
let down = false;
const songs = Array.from({ length: 600 }, (_, i) => ({
  id: `s${i}`, title: `Song ${i}`, artist: i % 2 ? 'Kate Bush' : 'T. Rex', album: `Album ${i % 3}`, year: i % 3 === 0 ? 1971 : 1985, duration: 200 + (i % 50),
  genres: [{ name: i % 2 ? 'Pop' : 'Rock' }], coverArt: `al-${i % 3}`,
}));
songs.push({ id: 'short', title: 'Skit', artist: 'x', album: 'y', duration: 2 }); // too short to schedule
let lastQuery = '';
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (down) { res.destroy(); return; }
  const json = (body) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ 'subsonic-response': { status: 'ok', version: '1.16.1', type: 'navidrome', serverVersion: '0.53.0', ...body } })); };
  const fail = (code, message) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ 'subsonic-response': { status: 'failed', version: '1.16.1', error: { code, message } } })); };
  const ok = crypto.createHash('md5').update(PASSWORD + (u.searchParams.get('s') || '')).digest('hex') === u.searchParams.get('t');
  if (!ok) return fail(40, 'Wrong username or password');
  const m = u.pathname.replace('/rest/', '');
  if (m === 'ping.view') return json({});
  if (m === 'getMusicFolders.view') return json({ musicFolders: { musicFolder: [{ id: 1, name: 'Music' }] } });
  if (m === 'search3.view') {
    lastQuery = u.searchParams.get('query');
    const off = Number(u.searchParams.get('songOffset') || 0), n = Number(u.searchParams.get('songCount') || 20);
    return json({ searchResult3: { song: songs.slice(off, off + n) } });
  }
  if (m === 'getCoverArt.view') { res.writeHead(200, { 'content-type': 'image/jpeg' }); return res.end(Buffer.from([0xff, 0xd8, 0xff, 0xd9])); }
  if (m === 'getLyricsBySongId.view') {
    const id = u.searchParams.get('id');
    if (id === 's1') return json({ lyricsList: { structuredLyrics: [{ synced: true, offset: 0, line: [{ start: 1000, value: 'First line' }, { start: 5500, value: 'Second line' }] }] } });
    if (id === 's2') return json({ lyricsList: { structuredLyrics: [{ synced: false, line: [{ value: 'Plain one' }, { value: 'Plain two' }] }] } });
    return json({ lyricsList: {} });
  }
  res.writeHead(404); res.end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `127.0.0.1:${server.address().port}`;
test.after(() => { server.close(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* open database files on Windows */ } });

test('login problems and a good login are reported clearly', async () => {
  await assert.rejects(subsonicDiscover(url, 'will', 'wrong', normalizeUrl), /wrong username or password/);
  await assert.rejects(subsonicDiscover('127.0.0.1:1', 'will', PASSWORD, normalizeUrl), /could not reach/);
  await assert.rejects(subsonicDiscover(url, '', '', normalizeUrl), /username and password/);
  const d = await subsonicDiscover(url, 'will', PASSWORD, normalizeUrl);
  assert.equal(d.views[0].id, 'all');
  assert.equal(d.views[1].name, 'Music');
  assert.notEqual(d.token, PASSWORD);
  assert.ok(!JSON.stringify(d).includes(PASSWORD), 'the password is not kept anywhere in what comes back');
});

const setup = async () => {
  const db = openDb(fs.mkdtempSync(path.join(dir, 'db-')));
  const d = await subsonicDiscover(url, 'will', PASSWORD, normalizeUrl);
  db.prepare('INSERT INTO sources(kind,name,url,token,user_id,salt) VALUES(?,?,?,?,?,?)').run('navidrome', 'Navidrome', d.url, d.token, d.userId, d.salt);
  const id = Number(db.prepare('INSERT INTO libraries(name,path,type) VALUES(?,?,?)').run('Music', 'ms://1/all', 'radio').lastInsertRowid);
  return { db, id, scan: (p = { files: 0, changed: 0, dirs: 0 }) => scanLibrary(db, db.prepare('SELECT * FROM libraries WHERE id=?').get(id), p).then(() => p) };
};

test('songs become radio tracks, paging through everything, skipping ones too short to schedule', async () => {
  const { db, scan } = await setup();
  const p = await scan();
  const rows = db.prepare("SELECT * FROM items WHERE kind='track'").all();
  assert.equal(rows.length, 600);
  assert.equal(lastQuery, '""'); // the "everything" search
  const r = rows.find((x) => x.path === 'ms://1/s1');
  assert.equal(r.title, 'Song 1');
  assert.equal(r.artist, 'Kate Bush');
  assert.equal(r.album, 'Album 1');
  assert.equal(r.year, 1985);
  assert.equal(r.runtime, 201);
  assert.deepEqual(JSON.parse(r.genres), ['Pop']);
  assert.equal(p.files, 601);
});

test('one cover per album is downloaded and shared by its tracks', async () => {
  const { db, scan } = await setup();
  await scan();
  const covers = fs.readdirSync(path.join(dir, 'covers')).filter((f) => f.startsWith('ms_1_'));
  assert.equal(covers.length, 3);
  const posters = new Set(db.prepare("SELECT poster FROM items WHERE album='Album 0'").all().map((x) => x.poster));
  assert.equal(posters.size, 1);
  assert.ok([...posters][0].endsWith('.jpg'));
});

test('a rescan of an unchanged server changes nothing, and radio channels can be built from the tracks', async () => {
  const { db, scan } = await setup();
  await scan();
  const again = await scan();
  assert.equal(again.changed, 0);
  inferChannels(db);
  const ch = db.prepare("SELECT kind,auto_name FROM channels WHERE kind='radio'").all();
  assert.ok(ch.length > 0, 'at least one radio station');
});

test('a server that is down leaves the library as it was', async () => {
  const { db, scan } = await setup();
  await scan();
  down = true;
  try { await assert.rejects(scan(), /could not reach|did not answer/); } finally { down = false; }
  assert.equal(db.prepare("SELECT COUNT(*) n FROM items WHERE kind='track'").get().n, 600);
});

test('the stream URL carries a token and salt but never the password; item paths carry nothing', async () => {
  const { db } = await setup();
  const u = resolveMedia(db, 'ms://1/s5');
  assert.ok(u.includes('/rest/stream.view?id=s5&format=raw'));
  assert.match(u, /[?&]t=[0-9a-f]{32}/);
  assert.match(u, /[?&]s=[0-9a-f]+/);
  assert.ok(!u.includes(PASSWORD));
  assert.equal(db.prepare("SELECT path FROM items LIMIT 1").get(), undefined);
});

test('lyrics come from the server: synced, plain, or none', async () => {
  const { db } = await setup();
  const src = db.prepare('SELECT * FROM sources WHERE id=1').get();
  const synced = await fetchLyrics(src, 's1');
  assert.deepEqual(synced.synced.map((l) => [l.t, l.text]), [[1, 'First line'], [5.5, 'Second line']]);
  assert.deepEqual(await fetchLyrics(src, 's2'), { text: 'Plain one\nPlain two' });
  assert.equal(await fetchLyrics(src, 's3'), null);
});
