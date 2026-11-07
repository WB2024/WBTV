import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wbtv-ms-'));
process.env.WBTV_CONFIG = dir;
const { openDb } = await import('../src/db.js');
const { scanLibrary } = await import('../src/scanner.js');
const { discover, normalizeUrl, resolveMedia, parseRemote, isRemote } = await import('../src/mediaserver.js');

// a tiny Jellyfin: one user, a TV view with one series and three episodes, a movie view with one film
let down = false;
const TICKS = 10_000_000;
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const json = (o, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (down) { res.destroy(); return; }
  if (u.pathname === '/System/Info/Public') return json({ ServerName: 'Test Jelly', ProductName: 'Jellyfin Server', Version: '10.9.0' });
  if (!/Token="goodkey"/.test(req.headers.authorization || '')) return json({}, 401); // Jellyfin 12: only the MediaBrowser Authorization header
  if (u.pathname === '/Users') return json([{ Id: 'u1', Name: 'will', Policy: { IsAdministrator: true } }]);
  if (u.pathname === '/Users/u1/Views') return json({ Items: [{ Id: 'tvview', Name: 'Shows', CollectionType: 'tvshows' }, { Id: 'mview', Name: 'Films', CollectionType: 'movies' }, { Id: 'music', Name: 'Music', CollectionType: 'music' }] });
  if (u.pathname === '/Users/u1/Items') {
    const types = u.searchParams.get('IncludeItemTypes');
    const parent = u.searchParams.get('ParentId');
    let Items = [];
    if (parent === 'tvview' && types === 'Series') Items = [{ Id: 's1', Name: 'Great Show', Overview: 'A show.', ProductionYear: 2010, OfficialRating: 'TV-14', Genres: ['Drama'], Studios: [{ Name: 'BBC One' }] }];
    if (parent === 'tvview' && types === 'Episode') Items = [1, 2, 3].map((n) => ({ Id: `e${n}`, Name: `Ep ${n}`, SeriesId: 's1', ParentIndexNumber: 1, IndexNumber: n, RunTimeTicks: 1800 * TICKS, PremiereDate: `2010-01-0${n}T00:00:00Z`, DateLastSaved: '2024-01-01T00:00:00Z', People: [{ Name: 'Actor', Role: 'Hero', Type: 'Actor' }, { Name: 'Dir', Type: 'Director' }] }));
    if (parent === 'mview' && types === 'Movie') Items = [{ Id: 'm1', Name: 'A Film', ProductionYear: 1999, RunTimeTicks: 5400 * TICKS, Genres: ['Horror'], Studios: [{ Name: 'Warner Bros.' }], OfficialRating: 'R', DateLastSaved: '2024-01-01T00:00:00Z' }, { Id: 'm2', Name: 'No runtime' }];
    return json({ Items, TotalRecordCount: Items.length });
  }
  if (/^\/Items\/[^/]+\/Images\/Primary$/.test(u.pathname)) { res.writeHead(200, { 'content-type': 'image/jpeg' }); return res.end(Buffer.from([0xff, 0xd8, 0xff, 0xd9])); }
  json({}, 404);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `127.0.0.1:${server.address().port}`;
test.after(() => { server.close(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* open database files on Windows: the OS temp folder cleans up */ } });

test('addresses are tidied up', () => {
  assert.equal(normalizeUrl('192.168.1.111:8096'), 'http://192.168.1.111:8096');
  assert.equal(normalizeUrl('https://jelly.example.com/web/index.html#!/home'), 'https://jelly.example.com');
  assert.equal(normalizeUrl(''), '');
});

test('discovery lists the TV and movie libraries and ignores the rest', async () => {
  const d = await discover(url, 'goodkey');
  assert.equal(d.name, 'Test Jelly');
  assert.deepEqual(d.views.map((v) => [v.id, v.type]), [['tvview', 'tv'], ['mview', 'movies']]);
  assert.equal(d.userId, 'u1');
});

test('a wrong key or an unreachable server gives a clear message', async () => {
  await assert.rejects(discover(url, 'nope'), /rejected the API key/);
  await assert.rejects(discover('127.0.0.1:1', 'goodkey'), /could not reach/);
});

const setup = () => {
  const db = openDb(fs.mkdtempSync(path.join(dir, 'db-')));
  const base = `http://${url}`;
  db.prepare('INSERT INTO sources(kind,name,url,token,user_id) VALUES(?,?,?,?,?)').run('jellyfin', 'Test Jelly', base, 'goodkey', 'u1');
  const add = (name, view, type) => db.prepare('INSERT INTO libraries(name,path,type) VALUES(?,?,?)').run(name, `ms://1/${view}`, type).lastInsertRowid;
  return { db, tv: Number(add('Shows', 'tvview', 'tv')), mv: Number(add('Films', 'mview', 'movies')), base };
};
const run = (db, id) => scanLibrary(db, db.prepare('SELECT * FROM libraries WHERE id=?').get(id), { files: 0, changed: 0, dirs: 0 });

test('a TV view becomes shows and episodes, with the studio on the show', async () => {
  const { db, tv } = setup();
  const lib = db.prepare('SELECT * FROM libraries WHERE id=?').get(tv);
  await scanLibrary(db, lib, { files: 0, changed: 0, dirs: 0 });
  const show = db.prepare('SELECT * FROM shows').get();
  assert.equal(show.title, 'Great Show');
  assert.deepEqual(JSON.parse(show.studios), ['BBC One']);
  const eps = db.prepare("SELECT * FROM items WHERE kind='episode' ORDER BY episode").all();
  assert.equal(eps.length, 3);
  assert.equal(eps[0].path, 'ms://1/e1');
  assert.equal(eps[0].runtime, 1800);
  assert.equal(eps[0].season, 1);
  assert.equal(eps[0].aired, '2010-01-01');
  assert.deepEqual(JSON.parse(eps[0].actors), [{ name: 'Actor', role: 'Hero' }]); // the director is not an actor
  assert.ok(fs.existsSync(path.join(dir, 'covers', 'ms_1_s1.jpg')), 'the series picture was downloaded');
  assert.ok(db.prepare('SELECT poster FROM shows').get().poster.endsWith('ms_1_s1.jpg'));
  // a second scan of an unchanged server changes nothing
  const again = { files: 0, changed: 0, dirs: 0 };
  await scanLibrary(db, lib, again);
  assert.equal(again.changed, 0);
});

test('a movie view becomes movies, skipping ones with no runtime', async () => {
  const { db, mv } = setup();
  await run(db, mv);
  const rows = db.prepare("SELECT * FROM items WHERE kind='movie'").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'A Film');
  assert.deepEqual(JSON.parse(rows[0].studios), ['Warner Bros.']);
});

test('a server that is down leaves the library exactly as it was', async () => {
  const { db, tv } = setup();
  await run(db, tv);
  down = true;
  try { await assert.rejects(run(db, tv), /could not reach|did not answer/); } finally { down = false; }
  assert.equal(db.prepare("SELECT COUNT(*) n FROM items WHERE kind='episode'").get().n, 3);
});

test('item paths never contain the key; it is added only when a stream URL is needed', () => {
  const { db, base } = setup();
  assert.ok(isRemote('ms://1/e1'));
  assert.deepEqual(parseRemote('ms://1/e1'), { source: 1, ref: 'e1' });
  const u = resolveMedia(db, 'ms://1/e1');
  assert.equal(u, `${base}/Videos/e1/stream?static=true&MediaSourceId=e1&ApiKey=goodkey&api_key=goodkey`);
  assert.equal(resolveMedia(db, '/mnt/tv/a.mkv'), '/mnt/tv/a.mkv'); // plain files pass through
});
