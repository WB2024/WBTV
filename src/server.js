import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { cfg } from './config.js';
import { openDb, getSettings, setSettings } from './db.js';
import { scanLibrary } from './scanner.js';
import { inferChannels, syncLiveChannels, talkPerTitle } from './channels.js';
import { checkStreams, isUrl } from './iptv.js';
import { discover, forgetSource, normalizeUrl } from './mediaserver.js';
import { subsonicDiscover } from './navidrome.js';
import { registerImvdb } from './imvdb.js';
import { ensureSchedule, ensureChannelSchedule, rescheduleFuture } from './scheduler.js';
import { probePending } from './media.js';
import { Broadcaster } from './broadcaster.js';
import { addAdUrls, processAds, removeAd } from './ads.js';
import { initAuth } from './auth.js';
import { logoFile, saveLogo, removeLogo, MIME } from './logos.js';
import { hw, detectHw } from './hw.js';
import { registerIptvOut } from './iptvout.js';
import { ttsStatus, sample, pruneCache, installVoice, speechQueue, VOICES } from './tts.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const db = openDb(cfg.configDir);
const app = Fastify({ logger: { level: 'warn' } });
const { getToken } = initAuth(app, db);
/** Stream picture size: a lower one costs much less CPU per channel. Applies to streams as they start. */
function applyStreamSize(h) {
  cfg.height = [480, 576, 720].includes(Number(h)) ? Number(h) : 720;
  cfg.width = Math.round((cfg.height * 16) / 9 / 2) * 2;
}
applyStreamSize(getSettings(db).streamHeight);
app.addContentTypeParser(['image/png', 'image/jpeg', 'image/webp'], { parseAs: 'buffer', bodyLimit: 2 * 1024 * 1024 }, (req, body, done) => done(null, body));

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
    const failed = [];
    for (const lib of libs) {
      scan.library = lib.name;
      // a library that cannot be read (unmounted share, permissions) must not stop the others being scanned
      try { await scanLibrary(db, lib, scan); } catch (e) { failed.push(lib.name); console.error(`scan of "${lib.name}" failed:`, e?.message || e); }
    }
    if (failed.length) scan.error = `Could not scan: ${failed.join(', ')}`;
    scan.phase = 'reading durations';
    await probePending(db, (done, total) => { scan.probe = `${done}/${total}`; });
    scan.phase = 'building channels';
    // Channel inference is heavy (over a second of blocked server on a large library), so only redo it when the scan actually
    // found something new or gone; the usual hourly rescan of an unchanged library then costs nothing.
    if (scan.changed > 0 || scan.removed > 0 || !db.prepare('SELECT 1 FROM channels LIMIT 1').get()) inferChannels(db);
    syncLiveChannels(db);
    checkStreams(db).then((n) => { if (n) { syncLiveChannels(db); } }).catch((e) => console.error('stream check failed', e));
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
         (SELECT COUNT(*) FROM ads a WHERE a.library_id=l.id) AS ads FROM libraries l ORDER BY l.id`).all()
  .map((l) => (String(l.type).startsWith('talk_') ? { ...l, perTitle: talkPerTitle(db, l.id, l.type) } : l)));

// ---- media servers (Jellyfin / Emby) as a source of TV and films
const isNavidrome = (b) => b?.kind === 'navidrome';
const findSource = (b) => (isNavidrome(b) ? subsonicDiscover(b.url, b.username, b.password, normalizeUrl) : discover(b?.url, b?.token, b?.userId));
const publicSource = ({ salt, token, ...rest }) => rest; // credentials never go back to the browser
app.post('/api/sources/discover', async (req, reply) => {
  try { return publicSource(await findSource(req.body)); } catch (e) { return reply.code(400).send({ error: e.message }); }
});
app.post('/api/sources', async (req, reply) => {
  try {
    const d = await findSource(req.body);
    const nav = isNavidrome(req.body);
    const kind = nav ? 'navidrome' : /emby/i.test(d.product) ? 'emby' : 'jellyfin';
    db.prepare(`INSERT INTO sources(kind,name,url,token,user_id,salt) VALUES(?,?,?,?,?,?)
      ON CONFLICT(url) DO UPDATE SET kind=excluded.kind,name=excluded.name,token=excluded.token,user_id=excluded.user_id,salt=excluded.salt`)
      .run(kind, d.name, d.url, nav ? d.token : String(req.body.token).trim(), d.userId, nav ? d.salt : null);
    const id = db.prepare('SELECT id FROM sources WHERE url=?').get(d.url).id;
    forgetSource(id);
    return { id, kind, ...publicSource(d) };
  } catch (e) { return reply.code(400).send({ error: e.message }); }
});
app.get('/api/sources', () => db.prepare('SELECT id,kind,name,url,user_id FROM sources ORDER BY id').all()); // never the key
app.delete('/api/sources/:id', async (req) => {
  const id = Number(req.params.id);
  db.prepare("DELETE FROM libraries WHERE substr(path,1,length(?))=?").run(`ms://${id}/`, `ms://${id}/`);
  db.prepare('DELETE FROM sources WHERE id=?').run(id);
  forgetSource(id);
  inferChannels(db); await rescheduleFuture(db);
  return { ok: true };
});

app.post('/api/libraries', async (req, reply) => {
  const { path: p, type, name } = req.body || {};
  if (req.body?.sourceId) { // one view (library) of a Jellyfin / Emby server
    const src = db.prepare('SELECT id,name,kind FROM sources WHERE id=?').get(Number(req.body.sourceId));
    const allowed = src?.kind === 'navidrome' ? ['radio'] : ['tv', 'movies'];
    if (!src || !req.body.viewId || !allowed.includes(type)) return reply.code(400).send({ error: 'choose a server, a library and a type (Jellyfin / Emby: TV shows or Movies; Navidrome: music)' });
    try {
      const r = db.prepare('INSERT INTO libraries(name,path,type) VALUES(?,?,?)').run(name || `${src.name}`, `ms://${src.id}/${String(req.body.viewId).replace(/[^\w-]/g, '')}`, type);
      const id = Number(r.lastInsertRowid);
      runScan([id]);
      return { id };
    } catch (e) {
      if (/UNIQUE/i.test(String(e?.message))) return reply.code(409).send({ error: 'that library is already added' });
      return reply.code(500).send({ error: 'could not add the library: ' + (e?.message || e) });
    }
  }
  if (!['movies', 'tv', 'music', 'clips', 'radio', 'talk_interviews', 'talk_podcasts', 'talk_audiobooks', 'iptv', 'ads', 'ads_tv', 'ads_movies', 'ads_idents'].includes(type)) return reply.code(400).send({ error: 'invalid library type' });
  let real;
  let label;
  if (type === 'iptv') {
    // a playlist / stream / YouTube URL, or a playlist file inside an allowed folder
    const v = String(p || '').trim();
    if (isUrl(v)) { real = v; try { label = new URL(v).hostname; } catch { label = v; } }
    else { real = safePath(v); if (!real || !fs.existsSync(real) || !fs.statSync(real).isFile()) return reply.code(400).send({ error: 'enter an http(s) URL, or a playlist file path' }); label = path.basename(real); }
  } else {
    real = safePath(p);
    if (!real || !fs.existsSync(real) || !fs.statSync(real).isDirectory()) return reply.code(400).send({ error: 'folder not found / not allowed' });
    label = path.basename(real);
  }
  try {
    const r = db.prepare('INSERT INTO libraries(name,path,type) VALUES(?,?,?)').run(name || label, real, type);
    const id = Number(r.lastInsertRowid);
    console.log(`[libraries] added library ${id} "${name || label}" (${type}, ${real})`);
    if (req.body?.group || req.body?.groupMode) { // a channel group given at creation, so no extra channel re-plan is needed
      const mode = ['inferred', 'single', 'both'].includes(req.body.groupMode) ? req.body.groupMode : 'inferred';
      db.prepare('UPDATE libraries SET channel_group=?, group_mode=? WHERE id=?').run(String(req.body.group || '').trim().slice(0, 60) || null, mode, id);
    }
    runScan([id]); // fire and forget
    return { id };
  } catch (e) {
    if (/UNIQUE/i.test(String(e?.message))) return reply.code(409).send({ error: 'that folder is already a library' });
    console.error('adding a library failed:', e);
    return reply.code(500).send({ error: 'could not add the library: ' + (e?.message || e) });
  }
});

// choose how a spoken-word library becomes channels: one per show / book, or one station for the whole library
app.patch('/api/libraries/:id', async (req, reply) => {
  const lib = db.prepare('SELECT id, type FROM libraries WHERE id=?').get(req.params.id);
  if (!lib) return reply.code(404).send({ error: 'no such library' });
  if (req.body?.path !== undefined || req.body?.name !== undefined) { // re-point a library at another folder (its items are kept; the next scan sorts out what moved) or rename it
    if (req.body.name !== undefined && String(req.body.name).trim()) db.prepare('UPDATE libraries SET name=? WHERE id=?').run(String(req.body.name).trim().slice(0, 80), lib.id);
    if (req.body.path !== undefined) {
      const real = safePath(req.body.path);
      if (!real || !fs.existsSync(real) || !fs.statSync(real).isDirectory()) return reply.code(400).send({ error: 'folder not found / not allowed' });
      if (db.prepare('SELECT 1 FROM libraries WHERE path=? AND id<>?').get(real, lib.id)) return reply.code(409).send({ error: 'another library already uses that folder' });
      console.log(`[libraries] library ${lib.id} now points at ${real}`);
      db.prepare('UPDATE libraries SET path=? WHERE id=?').run(real, lib.id);
      runScan([lib.id]);
    }
  }
  if (req.body?.group === undefined && req.body?.groupMode === undefined && req.body?.perTitle === undefined) return { ok: true }; // only a rename / re-point was asked for: done
  if (req.body?.group !== undefined || req.body?.groupMode !== undefined) { // channel group and how it becomes channels
    const mode = req.body.groupMode;
    if (mode !== undefined && !['inferred', 'single', 'both'].includes(mode)) return reply.code(400).send({ error: 'groupMode must be inferred, single or both' });
    if (req.body.group !== undefined) db.prepare('UPDATE libraries SET channel_group=? WHERE id=?').run(String(req.body.group || '').trim().slice(0, 60) || null, lib.id);
    if (mode !== undefined) db.prepare('UPDATE libraries SET group_mode=? WHERE id=?').run(mode, lib.id);
    inferChannels(db); await rescheduleFuture(db);
    return { ok: true };
  }
  if (!String(lib.type).startsWith('talk_')) return reply.code(400).send({ error: 'only podcast, audiobook and interview libraries have this option' });
  if (req.body?.perTitle !== undefined) {
    db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(`talk_per_title_${lib.id}`, req.body.perTitle ? '1' : '0');
    inferChannels(db); await rescheduleFuture(db);
  }
  return { ok: true };
});

app.delete('/api/libraries/:id', async (req) => {
  const gone = db.prepare('SELECT name, path, type FROM libraries WHERE id=?').get(req.params.id);
  console.log(`[libraries] removing library ${req.params.id}${gone ? ` "${gone.name}" (${gone.type}, ${gone.path.replace(/api_key=[^&]+/, 'api_key=***')})` : ' (not found)'}`); // so a removal is never a mystery
  db.prepare('DELETE FROM libraries WHERE id=?').run(req.params.id);
  inferChannels(db);
  syncLiveChannels(db); await rescheduleFuture(db);
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
  return db.prepare(`SELECT ${channelRow} FROM channels ${all ? '' : 'WHERE enabled=1 AND item_count>0'} ORDER BY number, id`).all()
    .map((c) => ({ ...c, logo: !!logoFile(c.id) }));
});

app.get('/api/channels/:id/logo', async (req, reply) => {
  const f = logoFile(req.params.id);
  if (!f) return reply.code(404).send();
  return reply.header('Cache-Control', 'no-cache').type(MIME[path.extname(f).slice(1)]).send(fs.createReadStream(f));
});
app.put('/api/channels/:id/logo', async (req, reply) => {
  if (!db.prepare('SELECT 1 FROM channels WHERE id=?').get(req.params.id)) return reply.code(404).send({ error: 'No such channel' });
  if (!saveLogo(req.params.id, req.body, req.headers['content-type'])) return reply.code(400).send({ error: 'Send a PNG, JPEG or WebP image (max 2 MB)' });
  return { ok: true };
});
app.delete('/api/channels/:id/logo', async (req) => { removeLogo(req.params.id); return { ok: true }; });

// a channel with nothing in it (its library was removed, or a tag was changed) can be deleted; one with content cannot, it would just be rebuilt
app.delete('/api/channels/:id', async (req, reply) => {
  const c = db.prepare('SELECT id, kind, item_count FROM channels WHERE id=?').get(req.params.id);
  if (!c) return reply.code(404).send({ error: 'no such channel' });
  if (c.item_count > 0 || c.kind === 'live') return reply.code(400).send({ error: 'only empty channels can be removed' });
  db.prepare('DELETE FROM channels WHERE id=?').run(c.id);
  return { ok: true };
});
app.delete('/api/channels', async () => { // every empty (non-live) channel
  const r = db.prepare("DELETE FROM channels WHERE item_count=0 AND kind<>'live'").run();
  return { removed: Number(r.changes) };
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

/** Compact guide entry for the TV app: no empty fields, and descriptions only where the app has no other source for them. */
const thin = (o, keepPlot) => {
  const q = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === null || v === '' || v === false || (Array.isArray(v) && !v.length)) continue;
    if (k === 'plot' && !keepPlot) continue;
    q[k] = v;
  }
  return q;
};

app.get('/api/epg', (req) => {
  const slim = req.query.slim === '1';
  const now = Date.now() / 1000;
  const from = Number(req.query.from) || now - 3600;
  const to = Number(req.query.to) || now + 6 * 3600;
  const rows = db.prepare(`
    SELECT p.id, p.channel_id AS ch, p.start, p.end, i.id AS item_id, i.kind, i.title, i.plot, i.season, i.episode, i.year,
           i.genres, i.rating, i.mpaa, i.aired, i.artist, i.album, s.title AS show_title
    FROM programmes p JOIN items i ON i.id=p.item_id JOIN channels c ON c.id=p.channel_id
    LEFT JOIN shows s ON s.id=i.show_id
    WHERE c.enabled=1 AND p.end > ? AND p.start < ? ORDER BY p.channel_id, p.start`).all(from, to);
  const programmes = {};
  const kinds = new Map(db.prepare('SELECT id, kind FROM channels').all().map((c) => [c.id, c.kind]));
  // music / radio guide entries are ~30 minutes of tracks: show the first track and list the next ones
  const tracks = new Map();
  const mrows = rows.filter((r) => ['music', 'radio'].includes(kinds.get(r.ch)) && r.kind !== 'talk');
  if (mrows.length) {
    // every track of the programme with its time: the guide shows what is playing or still to come (not just the first four of the
    // half hour), and the on-screen banner uses the times to follow the track actually being watched
    const q = db.prepare("SELECT i.artist, i.title, b.start, b.end FROM blocks b JOIN items i ON i.id=b.item_id WHERE b.programme_id=? AND b.kind='content' ORDER BY b.start");
    for (const r of mrows) tracks.set(r.id, q.all(r.id));
  }
  for (const r of rows) {
    const entry = {
      id: r.id, item: r.item_id, start: r.start, end: r.end, movie: r.kind === 'movie',
      title: r.kind === 'talk' ? r.title : r.show_title || r.title,
      subtitle: r.kind === 'talk' ? [r.album, r.artist && r.artist !== r.album ? r.artist : ''].filter(Boolean).join(' · ') : r.show_title ? r.title : '',
      ...(tracks.has(r.id) ? (() => {
        const all = tracks.get(r.id);
        const ahead = all.filter((x) => x.end > now);
        const t = (ahead.length ? ahead : all).slice(0, 4);
        const nm = (x) => (x.artist ? `${x.artist} – ${x.title}` : x.title);
        const near = r.end > now - 3600 && r.start < now + 1800; // only programmes around now need per-track times
        return { title: t[0] ? nm(t[0]) : r.title, subtitle: t.slice(1).map(nm).join(' · '), plot: all.map(nm).join('\n'),
          ...(near ? { trk: all.map((x) => [Math.round(x.start), Math.round(x.end), nm(x)]) } : {}) };
      })() : {}),
      season: r.season, episode: r.episode, year: r.year, plot: r.plot, rating: r.rating, mpaa: r.mpaa,
      genres: JSON.parse(r.genres || '[]'),
    };
    // music/radio entries carry a generated track list as their description; everything else the app fetches per programme
    (programmes[r.ch] ||= []).push(slim ? thin(entry, tracks.has(r.id)) : entry);
  }
  // live channels have no schedule: give them rolling two-hour "live" entries so they sit in the guide like everything else
  const live = db.prepare("SELECT c.id, COALESCE(c.name_override, c.auto_name) AS name, s.grp FROM channels c LEFT JOIN live_streams s ON s.channel_id=c.id WHERE c.kind='live' AND c.enabled=1 AND c.item_count>0").all();
  for (const c of live) {
    const list = [];
    for (let t = Math.floor(from / 7200) * 7200; t < to; t += 7200) {
      const e = { id: -(c.id * 1000 + list.length + 1), item: 0, start: t, end: t + 7200, movie: false, title: c.name, subtitle: c.grp || 'Live', season: null, episode: null,
        year: null, plot: 'Live stream. There is no schedule: you join whatever is on right now.', rating: null, mpaa: '', genres: c.grp ? [c.grp] : [] };
      list.push(slim ? thin(e, true) : e);
    }
    programmes[c.id] = list;
  }
  // closedown periods show up as "Off air" so the guide matches what is on screen
  const off = db.prepare("SELECT b.id, b.channel_id AS ch, b.start, b.end FROM blocks b JOIN channels c ON c.id=b.channel_id WHERE b.kind='signoff' AND c.enabled=1 AND b.end > ? AND b.start < ?").all(from, to);
  for (const b of off) {
    const e = { id: -(5000000 + b.id), item: 0, start: b.start, end: b.end, movie: false, title: 'Off air', subtitle: 'Closedown', season: null, episode: null,
      year: null, plot: 'This channel is closed down for the night.', rating: null, mpaa: '', genres: [] };
    (programmes[b.ch] ||= []).push(slim ? thin(e, true) : e);
  }
  for (const k of Object.keys(programmes)) programmes[k].sort((x, y) => x.start - y.start);
  return { now, from, to, programmes };
});

// ---------------------------------------------------------------- live sources (IPTV playlists, streams, YouTube)
const LIVE_PRESETS = [
  { name: 'News channels (iptv-org)', url: 'https://iptv-org.github.io/iptv/categories/news.m3u', note: 'Community list of free public news streams. Hundreds of entries; many are dead, so WBTV health-checks them.' },
  { name: 'UK channels (iptv-org)', url: 'https://iptv-org.github.io/iptv/countries/uk.m3u', note: 'Free public UK streams, including news.' },
  { name: 'Music channels (iptv-org)', url: 'https://iptv-org.github.io/iptv/categories/music.m3u', note: 'Free public music TV and radio streams.' },
  { name: 'Free-TV curated list', url: 'https://raw.githubusercontent.com/Free-TV/IPTV/master/playlist.m3u8', note: 'Curated free-to-air channels from many countries.' },
];
app.get('/api/live/presets', () => LIVE_PRESETS);
app.get('/api/live/summary', () => db.prepare(`SELECT l.id, l.name, l.path,
    COUNT(s.id) AS total, SUM(CASE WHEN s.alive=1 THEN 1 ELSE 0 END) AS alive, SUM(CASE WHEN s.alive=0 THEN 1 ELSE 0 END) AS dead,
    SUM(CASE WHEN s.alive IS NULL THEN 1 ELSE 0 END) AS unchecked,
    SUM(CASE WHEN c.enabled=1 AND c.item_count>0 THEN 1 ELSE 0 END) AS on_air
  FROM libraries l LEFT JOIN live_streams s ON s.library_id=l.id LEFT JOIN channels c ON c.id=s.channel_id WHERE l.type='iptv' GROUP BY l.id`).all());
// re-test streams that were found dead (they come back sometimes)
app.post('/api/live/recheck', async () => {
  db.prepare('UPDATE live_streams SET alive=NULL WHERE alive=0').run();
  checkStreams(db).then(() => syncLiveChannels(db)).catch(() => {});
  return { ok: true };
});
// switch every working stream on/off for one playlist
app.post('/api/live/:lib/enable', async (req) => {
  const on = req.body?.enabled ? 1 : 0;
  const r = db.prepare("UPDATE channels SET enabled=? WHERE id IN (SELECT channel_id FROM live_streams WHERE library_id=? AND alive IS NOT 0)").run(on, req.params.lib);
  return { changed: Number(r.changes) };
});

app.get('/api/items/:id', async (req, reply) => {
  const r = db.prepare(`SELECT i.*, s.title AS show_title, s.plot AS show_plot, s.genres AS show_genres, s.studios AS show_studios
    FROM items i LEFT JOIN shows s ON s.id=i.show_id WHERE i.id=?`).get(req.params.id);
  if (!r) return reply.code(404).send();
  return {
    id: r.id, title: r.title, artist: r.artist, album: r.album, showTitle: r.show_title, plot: r.plot || r.show_plot || '', year: r.year, rating: r.rating, mpaa: r.mpaa,
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
app.get('/api/hw', () => hw);
// What the server is doing right now: handy when something feels slow
app.get('/api/status', () => ({
  version: JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version,
  uptimeSeconds: Math.round(process.uptime()),
  memoryMB: Math.round(process.memoryUsage().rss / 1048576),
  load: os.loadavg().map((n) => Number(n.toFixed(2))),
  cpus: os.cpus().length,
  streamHeight: cfg.height,
  encoder: hw.active,
  scanning: scan.running ? scan.phase : null,
  speechQueue: speechQueue(),
  broadcasters: [...live.values()].filter((b) => !b.stopped).map((b) => ({
    channel: b.id, name: b.chInfo().name, viewers: b.viewers.size, segments: b.segs.length, ageSeconds: Math.round((Date.now() - b.startedAt) / 1000),
  })),
}));
app.put('/api/settings', async (req) => {
  const before = getSettings(db);
  const body = { ...(req.body || {}) };
  if ('promoVoice' in body && !VOICES[body.promoVoice]) delete body.promoVoice;
  if ('streamHeight' in body && ![480, 576, 720].includes(Number(body.streamHeight))) delete body.streamHeight;
  if ('hwEncoder' in body && !['auto', 'none', 'vaapi', 'nvenc'].includes(body.hwEncoder)) delete body.hwEncoder;
  if ('signOffFrom' in body && !/^\d{1,2}:\d{2}$/.test(String(body.signOffFrom))) delete body.signOffFrom;
  if ('signOffTo' in body && !/^\d{1,2}:\d{2}$/.test(String(body.signOffTo))) delete body.signOffTo;
  if ('pauseBufferMinutes' in body) body.pauseBufferMinutes = Math.min(30, Math.max(0, Math.round(Number(body.pauseBufferMinutes) || 0)));
  if ('promoCount' in body) body.promoCount = Math.min(4, Math.max(1, Math.round(Number(body.promoCount) || 3)));
  if ('promoMaxSeconds' in body) body.promoMaxSeconds = Math.min(120, Math.max(15, Math.round(Number(body.promoMaxSeconds) || 60)));
  const after = setSettings(db, body);
  if (before.hwEncoder !== after.hwEncoder) await detectHw(after.hwEncoder);
  if (before.streamHeight !== after.streamHeight) applyStreamSize(after.streamHeight);
  const scanKeys = ['autoScan', 'scanIntervalMinutes', 'scanOnStartup', 'hwEncoder', 'channelBug', 'lyrics', 'streamHeight', 'language', 'subtitleMode']; // these never need a re-plan
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

// ---------------------------------------------------------------- announcements (text-to-speech)
app.get('/api/promo/status', () => ttsStatus());
// download an extra announcer voice into /config/voices (a one-off, started by the user from Settings)
app.post('/api/promo/voices/:id/install', async (req, reply) => {
  const v = VOICES[req.params.id];
  if (!v?.hf) return reply.code(404).send({ error: 'unknown voice' });
  installVoice(req.params.id).catch((e) => console.error('voice install failed:', e.message));
  return { started: true };
});
app.get('/api/promo/sample', async (req, reply) => {
  const voice = VOICES[req.query.voice] ? req.query.voice : 'alan';
  const file = await sample(voice).catch(() => null);
  if (!file) return reply.code(503).send({ error: 'speech engine or voice not installed' });
  return reply.header('Cache-Control', 'no-cache').type('audio/wav').send(fs.createReadStream(file));
});
// what the announcer is going to say next on a channel (handy for checking the script)
app.get('/api/channels/:id/promos', (req) => {
  const now = Date.now() / 1000;
  return db.prepare("SELECT b.start, b.end, p.segments FROM blocks b JOIN promos p ON p.id=b.promo_id WHERE b.channel_id=? AND b.kind='promo' AND b.end>? ORDER BY b.start LIMIT 8")
    .all(req.params.id, now).map((r) => ({ start: r.start, end: r.end, segments: JSON.parse(r.segments).map(({ label, text }) => ({ label, text })) }));
});

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAX_COLD_STARTS = 3; // channels allowed to be spinning up at once; each one is an ffmpeg process that needs a CPU core for a couple of seconds
const coldStarting = () => { let n = 0; for (const b of live.values()) if (!b.stopped && b.segs.length < 2) n++; return n; };

app.get('/live/:id/index.m3u8', async (req, reply) => {
  const id = Number(req.params.id);
  const ch = db.prepare('SELECT id FROM channels WHERE id=? AND enabled=1').get(id);
  if (!ch) return reply.code(404).send();
  let gone = false;
  reply.raw.on('close', () => { gone = true; }); // the player moved on (it cancels the request) or the connection dropped
  let b = live.get(id);
  let created = false;
  if (!b) {
    // Flipping through channels quickly must not start an encoder for every channel on the way: give the viewer a moment to move on,
    // and never let more than a few channels cold-start together (a start-up storm starves every stream, including the one being watched).
    await sleep(250);
    for (let w = 0; w < 60 && !gone && coldStarting() >= MAX_COLD_STARTS && !live.has(id); w++) await sleep(100);
    if (gone) return reply;
    b = live.get(id);
    if (!b) { b = broadcaster(id); created = true; }
  }
  b.touch(req.query.v);
  const t0 = Date.now();
  while (!gone && ((b.ready < 2 && Date.now() - t0 < 9000) || (b.ready < 1 && Date.now() - t0 < 25000))) {
    await sleep(150);
    if (b.stopped) break;
    b.touch(req.query.v); // still here, still waiting: a slow start (a busy server) must not let the idle timer stop the encoder that is starting for us
  }
  if (gone) {
    if (created && b.segs.length < 2) b.leave(req.query.v); // nobody is waiting for this channel any more: do not leave its encoder running
    return reply;
  }
  let pl = b.playlist();
  if (!pl) return reply.code(503).send('stream not ready');
  // players that log in with ?key= do not pass it on to the segments, so add it to each segment line
  if (req.query.key) pl = pl.replace(/^(r\d+_\d+\.ts)$/gm, `$1?key=${encodeURIComponent(req.query.key)}`);
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

registerImvdb(app, { db, authEnabled: () => !!getToken(), runScan });
registerIptvOut(app, db, broadcaster, getToken);

// ---------------------------------------------------------------- static
app.register(fastifyStatic, { root: path.join(root, 'public'), prefix: '/' });
app.register(fastifyStatic, { root: path.join(root, 'node_modules/hls.js/dist'), prefix: '/vendor/', decorateReply: false });

// ---------------------------------------------------------------- boot
fs.mkdirSync(cfg.tmpDir, { recursive: true });
fs.rmSync(path.join(cfg.tmpDir, 'live'), { recursive: true, force: true });
// A stray error in a timer or background task must not take every stream down with it: log it and keep serving.
// (Failing to bind the port is different: that really is fatal, so exit and let Docker restart us.)
process.on('unhandledRejection', (e) => console.error('unhandled rejection (continuing):', e));
process.on('uncaughtException', (e) => console.error('uncaught exception (continuing):', e));
try { await app.listen({ port: cfg.port, host: '0.0.0.0' }); } catch (e) { console.error('cannot listen on port', cfg.port, e); process.exit(1); }
console.log(`WBTV listening on :${cfg.port}`);

detectHw(getSettings(db).hwEncoder).catch((e) => console.error('hw detect failed', e));
ensureSchedule(db).catch((e) => console.error('initial schedule failed', e)); // yields between channels, never blocks the server
setInterval(() => ensureSchedule(db).catch((e) => console.error('schedule tick failed', e)), 10 * 60 * 1000);
processAds(db); // resume any pending ad downloads
pruneCache(); setInterval(pruneCache, 6 * 3600 * 1000);

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
