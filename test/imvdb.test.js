import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { openDb } from '../src/db.js';
import { registerImvdb, pickSource, haveKeys } from '../src/imvdb.js';

// a tiny IMVDb: Morrissey has 3 videos (one we already own); one has no source, one is YouTube-only, one lists Vimeo and YouTube
let calls = 0, seenKey = '';
const mock = http.createServer((req, res) => {
  calls++;
  const u = new URL(req.url, 'http://x');
  seenKey = req.headers['imvdb-app-key'] || '';
  const json = (o, c = 200) => { res.writeHead(c, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (seenKey !== 'goodkey') return json({ status: false, error: 'Invalid API Key.' }, 403);
  if (u.pathname === '/search/entities') return json({ results: [{ id: 634, name: 'Morrissey', artist_video_count: 3, image: { t: 'x.jpg' } }], total_results: 1 });
  if (u.pathname === '/entity/634') return json({ id: 634, name: 'Morrissey', artist_videos: { total_videos: 3, videos: [
    { id: 11, song_title: 'Suedehead', year: 1988, artists: [{ name: 'Morrissey' }] }, { id: 12, song_title: 'Everyday Is Like Sunday', year: 1988, artists: [{ name: 'Morrissey' }] }, { id: 13, song_title: 'Lost Film', year: 1990, artists: [{ name: 'Morrissey' }] }] } });
  const m = /^\/video\/(\d+)$/.exec(u.pathname);
  if (m) {
    const id = m[1];
    const sources = id === '11' ? [{ source: 'youtube', source_data: 'YT11', is_primary: true }] : id === '12' ? [{ source: 'vimeo', source_data: 99, is_primary: true }, { source: 'youtube', source_data: 'YT12', is_primary: false }] : [];
    const titles = { 11: 'Suedehead', 12: 'Everyday Is Like Sunday', 13: 'Lost Film' };
    return json({ id: Number(id), song_title: titles[id], year: id === '13' ? 1990 : 1988, artists: [{ name: 'Morrissey' }], sources, credits: { crew: [{ position_name: 'Director', entity_name: 'Tim Broad' }] } });
  }
  json({ status: false, error: 'not found' }, 404);
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${mock.server?.address?.().port || mock.address().port}`;
test.after(() => mock.close());

const setup = async ({ auth = true, writable = true, withKey = true } = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wbtv-imvdb-'));
  const mv = path.join(dir, 'Music Video');
  fs.mkdirSync(path.join(mv, 'Morrissey'), { recursive: true });
  if (!writable) fs.chmodSync(mv, 0o555);
  const db = openDb(path.join(dir, 'cfg'));
  db.prepare("INSERT INTO libraries(name,path,type) VALUES('Music Video',?,'music')").run(mv);
  const song = (artist, title, genre, album) => db.prepare(`INSERT INTO items(library_id,kind,path,title,runtime,probed,studios,genres,actors,artist,album,year) VALUES (1,'track',?,?,200,1,'[]',?,'[]',?,?,1988)`).run(`ms://1/${title}`, title, JSON.stringify([genre]), artist, album);
  song('Morrissey', 'Suedehead', 'Rock - Indie', 'Viva Hate'); song('Morrissey', 'Everyday Is Like Sunday', 'Rock - Indie', 'Viva Hate'); song('Hole', 'Doll Parts', 'Rock - Grunge', 'Live Through This');
  // a video we already own
  db.prepare(`INSERT INTO items(library_id,kind,path,title,runtime,probed,studios,genres,actors,artist) VALUES (1,'musicvideo',?,'Everyday Is Like Sunday',200,1,'[]','[]','[]','Morrissey')`).run(path.join(mv, 'Morrissey', 'x.mp4'));
  if (withKey) db.prepare("INSERT INTO settings(key,value) VALUES('imvdb_key','goodkey')").run();
  const app = Fastify();
  let scans = 0;
  const downloads = [];
  const download = async ({ url, dir: d }) => {
    downloads.push(url);
    if (url.includes('FAIL')) throw new Error('Video unavailable');
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'video.mp4'), 'VIDEO'); fs.writeFileSync(path.join(d, 'video.jpg'), 'PIC');
    return { video: path.join(d, 'video.mp4'), thumb: path.join(d, 'video.jpg') };
  };
  const api = registerImvdb(app, { db, authEnabled: () => auth, runScan: () => { scans++; }, download, info: async () => ({}), still: async () => ({ still: false }), base, gapMs: 5 });
  await app.ready();
  const get = async (url) => (await app.inject({ method: 'GET', url })).json();
  const send = async (method, url, payload) => { const r = await app.inject({ method, url, payload }); return { code: r.statusCode, body: r.json() }; };
  const settle = async () => { for (let i = 0; i < 150; i++) { await new Promise((r) => setTimeout(r, 40)); if (!db.prepare("SELECT 1 FROM mv_jobs WHERE status IN ('queued','running')").get()) { await new Promise((r) => setTimeout(r, 120)); return; } } };
  return { app, db, mv, get, send, settle, downloads, scans: () => scans, api };
};

test('status explains what is missing, and nothing works until a password, key and writable folder are in place', async () => {
  const a = await setup({ auth: false, withKey: false });
  const st = await a.get('/api/imvdb/status');
  assert.equal(st.ready, false);
  assert.ok(st.problems.some((p) => /key/i.test(p)) && st.problems.some((p) => /password/i.test(p)));
  assert.equal((await a.send('GET', '/api/imvdb/artists')).code, 400);
  assert.equal((await a.send('PUT', '/api/imvdb/key', { key: 'abcdefgh12' })).code, 400); // no key can be stored without a password on
  assert.ok(!JSON.stringify(st).includes('abcdefgh12'));
});

test('the key is stored, never returned, and checked for shape', async () => {
  const a = await setup({ withKey: false });
  assert.equal((await a.send('PUT', '/api/imvdb/key', { key: 'x y' })).code, 400);
  assert.equal((await a.send('PUT', '/api/imvdb/key', { key: 'goodkey' })).code, 200);
  const st = await a.get('/api/imvdb/status');
  assert.equal(st.keySet, true);
  assert.ok(!JSON.stringify(st).includes('goodkey'));
});

test('artists come from your music library with how many videos you have', async () => {
  const a = await setup();
  const list = await a.get('/api/imvdb/artists');
  const m = list.find((x) => x.name === 'Morrissey');
  assert.deepEqual([m.albums, m.have], [1, 1]);
  assert.ok(list.find((x) => x.name === 'Hole'));
  assert.deepEqual((await a.get('/api/imvdb/artists?q=hol')).map((x) => x.name), ['Hole']);
});

test('search and an artist page mark the videos you already have', async () => {
  const a = await setup();
  const s = await a.get('/api/imvdb/search?q=Morrissey');
  assert.equal(s[0].name, 'Morrissey');
  assert.equal(seenKey, 'goodkey');
  const e = await a.get('/api/imvdb/entity/634?artist=Morrissey');
  assert.deepEqual(e.videos.map((v) => [v.title, v.have]), [['Suedehead', false], ['Everyday Is Like Sunday', true], ['Lost Film', false]]);
});

test('queued videos download into Artist/Artist - Title with an nfo (real year, imvdb id, library genre) and a poster, then the library is rescanned', async () => {
  const a = await setup();
  assert.equal((await a.send('POST', '/api/imvdb/jobs', { artist: 'Morrissey', videos: [{ id: 11, title: 'Suedehead' }, { id: 12, title: 'Everyday Is Like Sunday' }, { id: 13, title: 'Lost Film' }] })).body.queued, 3);
  await a.settle();
  const jobs = await a.get('/api/imvdb/jobs');
  const by = Object.fromEntries(jobs.map((j) => [j.imvdb_id, j]));
  assert.equal(by['11'].status, 'done');
  assert.equal(by['12'].status, 'done'); // already owned: marked done, nothing downloaded
  assert.equal(by['13'].status, 'failed');
  assert.match(by['13'].error, /no YouTube or Vimeo source/);
  assert.deepEqual(a.downloads, ['https://www.youtube.com/watch?v=YT11']);
  const dir = path.join(a.mv, 'Morrissey');
  assert.ok(fs.existsSync(path.join(dir, 'Morrissey - Suedehead.mp4')) && fs.existsSync(path.join(dir, 'Morrissey - Suedehead-poster.jpg')));
  const nfo = fs.readFileSync(path.join(dir, 'Morrissey - Suedehead.nfo'), 'utf8');
  assert.match(nfo, /<year>1988<\/year>/); assert.match(nfo, /<genre>Rock - Indie<\/genre>/); assert.match(nfo, /<uniqueid type="imvdb">11<\/uniqueid>/); assert.match(nfo, /<director>Tim Broad<\/director>/);
  assert.ok(!fs.existsSync(path.join(a.mv, '.mvdl-tmp', '1')), 'the temp folder is cleaned up');
  assert.ok(a.scans() >= 1);
});

test('a failed download can be retried, a queued one cancelled, and finished ones cleared', async () => {
  const a = await setup();
  await a.send('POST', '/api/imvdb/jobs', { artist: 'Morrissey', videos: [{ id: 13, title: 'Lost Film' }] });
  await a.settle();
  const id = (await a.get('/api/imvdb/jobs'))[0].id;
  assert.equal((await a.get('/api/imvdb/jobs'))[0].status, 'failed');
  await a.send('POST', `/api/imvdb/jobs/${id}/retry`);
  await a.settle();
  assert.equal((await a.get('/api/imvdb/jobs'))[0].status, 'failed');
  assert.equal((await a.send('DELETE', '/api/imvdb/jobs')).body.removed, 1);
  assert.deepEqual(await a.get('/api/imvdb/jobs'), []);
});

test('sources: YouTube is preferred, Vimeo is the fallback, none gives nothing', () => {
  assert.equal(pickSource([{ type: 'vimeo', id: '9', primary: true }, { type: 'youtube', id: 'Y', primary: false }]).url, 'https://www.youtube.com/watch?v=Y');
  assert.equal(pickSource([{ type: 'vimeo', id: '9', primary: true }]).url, 'https://vimeo.com/9');
  assert.equal(pickSource([]), null);
});

test('a read-only music video folder is reported, not attempted', async () => {
  if (process.platform === 'win32') return; // permissions bits are not honoured the same way
  const a = await setup({ writable: false });
  const st = await a.get('/api/imvdb/status');
  assert.ok(st.problems.some((p) => /read-only/i.test(p)));
});

test('a download that is a still image with audio, or a lyric / audio upload, is not kept unless you say so', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wbtv-imvdb-'));
  const mv = path.join(dir, 'Music Video');
  fs.mkdirSync(mv, { recursive: true });
  const db = openDb(path.join(dir, 'cfg'));
  db.prepare("INSERT INTO libraries(name,path,type) VALUES('Music Video',?,'music')").run(mv);
  db.prepare("INSERT INTO settings(key,value) VALUES('imvdb_key','goodkey')").run();
  const app = Fastify();
  let isStill = true, upload = {};
  const download = async ({ dir: d }) => { fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'video.mp4'), 'V'); return { video: path.join(d, 'video.mp4'), thumb: null }; };
  registerImvdb(app, { db, authEnabled: () => true, runScan: () => {}, download, info: async () => upload, still: async () => ({ still: isStill }), base, gapMs: 5 });
  await app.ready();
  const get = async (u) => (await app.inject({ method: 'GET', url: u })).json();
  const wait = async () => { for (let i = 0; i < 100; i++) { await new Promise((r) => setTimeout(r, 40)); if (!db.prepare("SELECT 1 FROM mv_jobs WHERE status IN ('queued','running')").get()) { await new Promise((r) => setTimeout(r, 100)); return; } } };
  await app.inject({ method: 'POST', url: '/api/imvdb/jobs', payload: { artist: 'Morrissey', videos: [{ id: 11, title: 'Suedehead' }] } });
  await wait();
  let j = (await get('/api/imvdb/jobs'))[0];
  assert.equal(j.status, 'failed');
  assert.match(j.error, /^Not kept: it looks like a still image/);
  assert.ok(!fs.existsSync(path.join(mv, 'Morrissey', 'Morrissey - Suedehead.mp4')));
  // a lyric upload is stopped before it is even downloaded
  isStill = false; upload = { title: 'Morrissey - Suedehead (Lyrics)' };
  await app.inject({ method: 'POST', url: `/api/imvdb/jobs/${j.id}/retry`, payload: {} });
  await wait();
  j = (await get('/api/imvdb/jobs'))[0];
  assert.match(j.error, /^Not kept: a lyric/);
  // "keep anyway"
  await app.inject({ method: 'POST', url: `/api/imvdb/jobs/${j.id}/retry`, payload: { force: true } });
  await wait();
  j = (await get('/api/imvdb/jobs'))[0];
  assert.equal(j.status, 'done');
  assert.ok(fs.existsSync(path.join(mv, 'Morrissey', 'Morrissey - Suedehead.mp4')));
});
