import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cfg } from './config.js';
import { openDb, getSettings, setSettings } from './db.js';
import { scanLibrary } from './scanner.js';
import { inferChannels } from './channels.js';
import { ensureSchedule, ensureChannelSchedule, rescheduleFuture } from './scheduler.js';
import { probePending } from './media.js';
import { Broadcaster } from './broadcaster.js';
import { addAdUrls, processAds, removeAd } from './ads.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const db = openDb(cfg.configDir);
const app = Fastify({ logger: { level: 'warn' } });

// ---------------------------------------------------------------- scanning
const scan = { running: false, phase: 'idle', library: null, dirs: 0, files: 0, changed: 0, removed: 0, probe: null, started: 0, finished: 0, error: null, auto: false };

const scanQueue = new Set(); // library ids requested while a scan was already running ('all' = everything)
async function runScan(libraryIds, auto = false) {
  if (scan.running) { for (const id of libraryIds || ['all']) scanQueue.add(id); return false; }
  Object.assign(scan, { running: true, phase: 'scanning', dirs: 0, files: 0, changed: 0, removed: 0, probe: null, started: Date.now(), error: null, auto });
  const upcoming = () => new Map(db.prepare('SELECT channel_id AS c, COUNT(*) AS n FROM programmes WHERE end > ? GROUP BY channel_id').all(Date.now() / 1000).map((r) => [r.c, r.n]));
  const before = upcoming();
  try {
    const libs = libraryIds
      ? db.prepare(`SELECT * FROM libraries WHERE id IN (${libraryIds.map(() => '?').join(',')})`).all(...libraryIds)
      : db.prepare('SELECT * FROM libraries').all();
    for (const lib of libs) {
      scan.library = lib.name;
      await scanLibrary(db, lib, scan);
    }
    scan.phase = 'reading durations';
    await probePending(db, (done, total) => { scan.probe = `${done}/${total}`; });
    scan.phase = 'building channels';
    inferChannels(db);
    scan.phase = 'scheduling';
    // New media is picked up as the schedule rolls forward. Only channels that LOST programmes (their media vanished)
    // are re-planned, so a rescan never reshuffles the upcoming guide for everything else.
    const after = upcoming();
    const hurt = [...before].filter(([c, n]) => (after.get(c) || 0) < n).map(([c]) => c);
    await rescheduleFuture(db, Date.now() / 1000, hurt);
  } catch (e) {
    scan.error = String(e?.stack || e);
    console.error('scan failed', e);
  } finally {
    Object.assign(scan, { running: false, phase: 'idle', finished: Date.now() });
  }
  if (scanQueue.size) {
    const next = scanQueue.has('all') ? null : [...scanQueue];
    scanQueue.clear();
    await runScan(next);
  }
  return true;
}

// ---------------------------------------------------------------- libraries
app.get('/api/libraries', () => db.prepare(`
  SELECT l.*, (SELECT COUNT(*) FROM items i WHERE i.library_id=l.id) AS items,
         (SELECT COUNT(*) FROM ads a WHERE a.library_id=l.id) AS ads FROM libraries l ORDER BY l.id`).all());

app.post('/api/libraries', async (req, reply) => {
  const { path: p, type, name } = req.body || {};
  if (!['movies', 'tv', 'ads', 'ads_tv', 'ads_movies'].includes(type)) return reply.code(400).send({ error: 'invalid library type' });
  const real = safePath(p);
  if (!real || !fs.existsSync(real) || !fs.statSync(real).isDirectory()) return reply.code(400).send({ error: 'folder not found / not allowed' });
  try {
    const r = db.prepare('INSERT INTO libraries(name,path,type) VALUES(?,?,?)').run(name || path.basename(real), real, type);
    const id = Number(r.lastInsertRowid);
    runScan([id]); // fire and forget
    return { id };
  } catch { return reply.code(409).send({ error: 'that folder is already a library' }); }
});

app.delete('/api/libraries/:id', async (req) => {
  db.prepare('DELETE FROM libraries WHERE id=?').run(req.params.id);
  inferChannels(db); await rescheduleFuture(db);
  return { ok: true };
});

app.post('/api/scan', async (req) => ({ started: await runScan(req.body?.libraryId ? [req.body.libraryId] : null) }));
app.get('/api/scan', () => {
  const s = getSettings(db);
  const base = Math.max(scan.finished || 0, scan.started || 0);
  return { ...scan, autoScan: s.autoScan, nextAuto: s.autoScan && !scan.running && base ? base + s.scanIntervalMinutes * 60000 : null };
});

// folder browser (restricted to WBTV_BROWSE_ROOTS)
function safePath(p) {
  if (!p) return null;
  const real = path.resolve(p);
  return cfg.browseRoots.some((r) => real === r || real.startsWith(r + path.sep)) ? real : null;
}
app.get('/api/browse', async (req, reply) => {
  if (!req.query.path) return { path: '', parent: null, dirs: cfg.browseRoots.filter((r) => fs.existsSync(r)).map((r) => ({ name: r, path: r })) };
  const real = safePath(req.query.path);
  if (!real) return reply.code(403).send({ error: 'outside allowed roots' });
  try {
    const dirs = fs.readdirSync(real, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('@') && !e.name.startsWith('$'))
      .map((e) => ({ name: e.name, path: path.join(real, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    const parent = safePath(path.dirname(real)) && path.dirname(real) !== real ? path.dirname(real) : '';
    return { path: real, parent, dirs };
  } catch (e) { return reply.code(400).send({ error: String(e.message) }); }
});

// ---------------------------------------------------------------- channels / EPG
const channelRow = `id, key, kind, COALESCE(name_override, auto_name) AS name, auto_name, name_override, number, enabled, item_count`;

app.get('/api/channels', (req) => {
  const all = req.query.all === '1';
  return db.prepare(`SELECT ${channelRow} FROM channels ${all ? '' : 'WHERE enabled=1 AND item_count>0'} ORDER BY number, id`).all();
});

app.patch('/api/channels/:id', async (req) => {
  const { name, number, enabled } = req.body || {};
  const id = req.params.id;
  if (name !== undefined) db.prepare('UPDATE channels SET name_override=? WHERE id=?').run(name && name.trim() ? name.trim() : null, id);
  if (number !== undefined && Number.isInteger(number) && number > 0) {
    db.prepare('UPDATE channels SET number=NULL WHERE number=? AND id<>?').run(number, id); // swap-free: last write wins
    db.prepare('UPDATE channels SET number=? WHERE id=?').run(number, id);
  }
  if (enabled !== undefined) {
    db.prepare('UPDATE channels SET enabled=? WHERE id=?').run(enabled ? 1 : 0, id);
    if (enabled) ensureChannelSchedule(db, Number(id));
  }
  return db.prepare(`SELECT ${channelRow} FROM channels WHERE id=?`).get(id);
});

app.post('/api/channels/rebuild', async () => { inferChannels(db); await rescheduleFuture(db); return { ok: true }; });

app.get('/api/epg', (req) => {
  const now = Date.now() / 1000;
  const from = Number(req.query.from) || now - 3600;
  const to = Number(req.query.to) || now + 6 * 3600;
  const rows = db.prepare(`
    SELECT p.id, p.channel_id AS ch, p.start, p.end, i.id AS item_id, i.kind, i.title, i.plot, i.season, i.episode, i.year,
           i.genres, i.rating, i.mpaa, i.aired, s.title AS show_title
    FROM programmes p JOIN items i ON i.id=p.item_id JOIN channels c ON c.id=p.channel_id
    LEFT JOIN shows s ON s.id=i.show_id
    WHERE c.enabled=1 AND p.end > ? AND p.start < ? ORDER BY p.channel_id, p.start`).all(from, to);
  const programmes = {};
  for (const r of rows) {
    (programmes[r.ch] ||= []).push({
      id: r.id, item: r.item_id, start: r.start, end: r.end, movie: r.kind === 'movie',
      title: r.show_title || r.title, subtitle: r.show_title ? r.title : '',
      season: r.season, episode: r.episode, year: r.year, plot: r.plot, rating: r.rating, mpaa: r.mpaa,
      genres: JSON.parse(r.genres || '[]'),
    });
  }
  return { now, from, to, programmes };
});

app.get('/api/items/:id', async (req, reply) => {
  const r = db.prepare(`SELECT i.*, s.title AS show_title, s.plot AS show_plot, s.genres AS show_genres, s.studios AS show_studios
    FROM items i LEFT JOIN shows s ON s.id=i.show_id WHERE i.id=?`).get(req.params.id);
  if (!r) return reply.code(404).send();
  return {
    id: r.id, title: r.title, showTitle: r.show_title, plot: r.plot || r.show_plot || '', year: r.year, rating: r.rating, mpaa: r.mpaa,
    runtime: r.runtime, season: r.season, episode: r.episode, aired: r.aired, actors: JSON.parse(r.actors || '[]'),
    genres: [...new Set([...JSON.parse(r.genres || '[]'), ...JSON.parse(r.show_genres || '[]')])],
    studios: [...new Set([...JSON.parse(r.studios || '[]'), ...JSON.parse(r.show_studios || '[]')])],
  };
});

app.get('/api/art/:id', async (req, reply) => {
  const r = db.prepare('SELECT i.poster, s.poster AS sp FROM items i LEFT JOIN shows s ON s.id=i.show_id WHERE i.id=?').get(req.params.id);
  const f = [r?.poster, r?.sp].find((p) => p && fs.existsSync(p));
  if (!f) return reply.code(404).send();
  return reply.header('Cache-Control', 'public, max-age=86400').type(`image/${path.extname(f).slice(1).replace('jpg', 'jpeg')}`).send(fs.createReadStream(f));
});

app.get('/api/channels/:id/now', (req) => {
  const now = Date.now() / 1000;
  const cur = db.prepare('SELECT * FROM programmes WHERE channel_id=? AND start<=? AND end>? LIMIT 1').get(req.params.id, now, now);
  return { now, programme: cur || null };
});

// ---------------------------------------------------------------- settings & ads
app.get('/api/settings', () => getSettings(db));
app.put('/api/settings', async (req) => {
  const before = getSettings(db);
  const after = setSettings(db, req.body || {});
  const scanKeys = ['autoScan', 'scanIntervalMinutes', 'scanOnStartup']; // these never need a re-plan
  const plan = (s) => JSON.stringify(Object.entries(s).filter(([k]) => !scanKeys.includes(k)));
  if (plan(before) !== plan(after)) {
    const inferKeys = ['minChannelMinutes', 'tvGenreChannelsForAll', 'movieStudioChannels', 'movieStudioMinFilms', 'movieDecadeChannels'];
    if (inferKeys.some((k) => before[k] !== after[k])) inferChannels(db);
    await rescheduleFuture(db);
  }
  return after;
});

app.get('/api/ads', () => db.prepare('SELECT id,title,source,duration,status,error,library_id,kind FROM ads ORDER BY id DESC').all());
app.post('/api/ads', async (req) => {
  const urls = String(req.body?.urls || '').split(/\s+/);
  const added = addAdUrls(db, urls, req.body?.kind);
  processAds(db, () => { if (getSettings(db).adsEnabled) rescheduleFuture(db).catch(() => {}); });
  return { added };
});
app.delete('/api/ads/:id', async (req) => { removeAd(db, req.params.id); await rescheduleFuture(db); return { ok: true }; });

// ---------------------------------------------------------------- live streams
const live = new Map();
function broadcaster(id) {
  let b = live.get(id);
  if (!b) {
    b = new Broadcaster(db, id, (cid) => live.delete(cid));
    live.set(id, b);
    b.start();
  }
  return b;
}

app.get('/live/:id/index.m3u8', async (req, reply) => {
  const id = Number(req.params.id);
  const ch = db.prepare('SELECT id FROM channels WHERE id=? AND enabled=1').get(id);
  if (!ch) return reply.code(404).send();
  const b = broadcaster(id);
  b.touch(req.query.v);
  const t0 = Date.now();
  while ((b.ready < 3 && Date.now() - t0 < 9000) || (b.ready < 1 && Date.now() - t0 < 25000)) {
    await new Promise((r) => setTimeout(r, 150));
    if (b.stopped) break;
  }
  const pl = b.playlist();
  if (!pl) return reply.code(503).send('stream not ready');
  return reply.header('Cache-Control', 'no-cache').type('application/vnd.apple.mpegurl').send(pl);
});

app.get('/live/:id/:seg', async (req, reply) => {
  const b = live.get(Number(req.params.id));
  if (!b || !/^r\d+_\d+\.ts$/.test(req.params.seg)) return reply.code(404).send();
  const f = path.join(b.dir, req.params.seg);
  if (!fs.existsSync(f)) return reply.code(404).send();
  return reply.header('Cache-Control', 'no-cache').type('video/mp2t').send(fs.createReadStream(f));
});

app.post('/live/:id/stop', async (req) => { live.get(Number(req.params.id))?.leave(req.query.v || req.body?.v); return { ok: true }; });

// ---------------------------------------------------------------- static
app.register(fastifyStatic, { root: path.join(root, 'public'), prefix: '/' });
app.register(fastifyStatic, { root: path.join(root, 'node_modules/hls.js/dist'), prefix: '/vendor/', decorateReply: false });

// ---------------------------------------------------------------- boot
fs.mkdirSync(cfg.tmpDir, { recursive: true });
fs.rmSync(path.join(cfg.tmpDir, 'live'), { recursive: true, force: true });
await app.listen({ port: cfg.port, host: '0.0.0.0' });
console.log(`WBTV listening on :${cfg.port}`);

ensureSchedule(db).catch((e) => console.error('initial schedule failed', e)); // yields between channels, never blocks the server
setInterval(() => ensureSchedule(db).catch((e) => console.error('schedule tick failed', e)), 10 * 60 * 1000);
processAds(db); // resume any pending ad downloads

// ---- periodic rescans (network shares don't give us file-change events, so we poll; scans are incremental)
scan.finished = db.prepare('SELECT MAX(last_scan) AS m FROM libraries').get().m || 0;
const hasLibraries = () => db.prepare('SELECT 1 FROM libraries').get() != null;
setTimeout(() => { if (getSettings(db).scanOnStartup && hasLibraries()) runScan(null, true); }, 20000);
setInterval(() => {
  const s = getSettings(db);
  if (!s.autoScan || scan.running || !hasLibraries()) return;
  if (Date.now() - Math.max(scan.finished, scan.started) >= s.scanIntervalMinutes * 60000) runScan(null, true);
}, 60000);
const shutdown = () => { for (const b of live.values()) b.stop(); process.exit(0); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
