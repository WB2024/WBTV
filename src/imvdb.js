// Optional music-video discovery and download using IMVDb (the Internet Music Video Database; https://imvdb.com/developers/api).
// You bring your own app key. WBTV lists the artists in your music library, shows each artist's videos on IMVDb (marking the ones you
// already have), and downloads the ones you pick into  <music video folder>/<Artist>/<Artist> - <Title>.mp4  with a clean .nfo and a poster.
// It only works when (1) a key is set, (2) a WBTV password is on (so nobody else on the network can spend your quota or start downloads),
// and (3) the music video folder is mounted writable: WBTV's media mounts are read-only by default and stay so unless you choose otherwise.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { cfg } from './config.js';
import { norm, fileSafe, buildLibraryIndex } from '../tools/mvlib.mjs';
import { nfoXml } from '../tools/mvfix.mjs';
import { judgeUpload, looksStill } from './stillcheck.js';

const BASE = process.env.IMVDB_BASE || 'https://imvdb.com/api/v1';
const UA = 'WBTV (+https://github.com/WB2024/WBTV)';
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const now = () => Math.floor(Date.now() / 1000);

// ---- key (kept server-side only, never sent to the browser) -----------------------------------------------------------------------
export const getKey = (db) => db.prepare("SELECT value FROM settings WHERE key='imvdb_key'").get()?.value || '';
const setKey = (db, k) => (k ? db.prepare("INSERT INTO settings(key,value) VALUES('imvdb_key',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(k)
  : db.prepare("DELETE FROM settings WHERE key='imvdb_key'").run());

// ---- the IMVDb API ---------------------------------------------------------------------------------------------------------------
async function call(key, p, { base = BASE, timeout = 20000 } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  let r;
  try { r = await fetch(`${base}${p}`, { headers: { 'IMVDB-APP-KEY': key, Accept: 'application/json', 'User-Agent': UA }, signal: ctl.signal }); }
  catch (e) { throw new Error(e?.name === 'AbortError' ? 'IMVDb did not answer in time' : `could not reach IMVDb (${e?.cause?.code || e?.message || e})`); }
  finally { clearTimeout(t); }
  if (r.status === 403 || r.status === 401) {
    const text = await r.text().catch(() => '');
    let reason = '';
    try { reason = JSON.parse(text).error || ''; } catch { /* not the API's own JSON answer */ }
    // the API answers a bad key with JSON; a plain web-server 403 page means the request was blocked before the key was even looked at
    throw new Error(reason ? `IMVDb says: ${reason}` : "IMVDb's web server blocked the request (403) before looking at the key. The app may not be activated yet on imvdb.com, or their server does not accept requests from this network. Check the app's status on your IMVDb developer page, or ask IMVDb support.");
  }
  if (r.status === 429) throw new Error('IMVDb rate limit reached, try again in a minute');
  if (!r.ok) throw new Error(`IMVDb answered ${r.status}`);
  try { return await r.json(); } catch { throw new Error('IMVDb sent something that is not JSON'); }
}

export async function searchEntities(key, q, opt) {
  const j = await call(key, `/search/entities?q=${encodeURIComponent(q)}&per_page=8`, opt);
  return (j.results || []).map((e) => ({ id: String(e.id), name: e.name, videos: Number(e.artist_video_count) || 0, image: e.image?.t || e.image?.b || '' }));
}

/** All of an artist's videos (follows pages if the API returns fewer than the total). */
export async function entityVideos(key, id, opt) {
  const out = new Map();
  let entity = null, total = 0;
  for (let page = 1; page <= 12; page++) {
    const j = await call(key, `/entity/${encodeURIComponent(id)}?include=artist_videos${page > 1 ? `&page=${page}` : ''}`, opt);
    entity ||= { id: String(j.id || id), name: j.name || '' };
    const av = j.artist_videos || {};
    total = Number(av.total_videos ?? j.artist_video_count ?? 0) || total;
    const before = out.size;
    for (const v of av.videos || []) if (v?.id != null) out.set(String(v.id), { id: String(v.id), title: v.song_title || '', year: Number(v.year) || null, artists: (v.artists || []).map((a) => a.name) });
    if (out.size === before || out.size >= total) break; // no new videos on this page, or we have them all
  }
  return { entity, total, videos: [...out.values()] };
}

/** One video with where it can be watched. Accepts both "source_data" (the docs) and "source_slug". */
export async function videoDetail(key, id, opt) {
  const j = await call(key, `/video/${encodeURIComponent(id)}?include=sources,credits`, opt);
  const sources = (j.sources || []).map((s) => ({ type: String(s.source || '').toLowerCase(), id: String(s.source_data ?? s.source_slug ?? ''), primary: !!s.is_primary })).filter((s) => s.id);
  const director = (j.credits?.crew || []).find((c) => /director/i.test(c.position_name || ''))?.entity_name || '';
  return { id: String(j.id || id), title: j.song_title || '', year: Number(j.year) || null, artists: (j.artists || []).map((a) => a.name), sources, director };
}

export function pickSource(sources) {
  const order = ['youtube', 'vimeo'];
  for (const type of order) {
    const hit = sources.filter((s) => s.type === type).sort((a, b) => Number(b.primary) - Number(a.primary))[0];
    if (hit) return { type, id: hit.id, url: type === 'youtube' ? `https://www.youtube.com/watch?v=${hit.id}` : `https://vimeo.com/${hit.id}` };
  }
  return null;
}

// ---- what you have ---------------------------------------------------------------------------------------------------------------
export const haveKeys = (db) => new Set(db.prepare("SELECT artist, title FROM items WHERE kind='musicvideo'").all().map((r) => `${norm(r.artist)}|${slug(r.title)}`));
export const musicLibrary = (db) => db.prepare("SELECT id, name, path FROM libraries WHERE type='music' ORDER BY id LIMIT 1").get() || null;
const writable = (dir) => { try { fs.accessSync(dir, fs.constants.W_OK); return true; } catch { return false; } };

/** Artists in your music library (Navidrome or folders), most albums first, with how many videos of theirs you already have. */
export function libraryArtists(db, q = '', limit = 400) {
  const rows = db.prepare("SELECT artist, COUNT(*) AS tracks, COUNT(DISTINCT album) AS albums FROM items WHERE kind='track' AND artist<>'' GROUP BY artist").all();
  const have = new Map();
  for (const r of db.prepare("SELECT artist, COUNT(*) AS n FROM items WHERE kind='musicvideo' GROUP BY artist").all()) have.set(norm(r.artist), (have.get(norm(r.artist)) || 0) + r.n);
  const needle = norm(q);
  return rows.filter((r) => !needle || norm(r.artist).includes(needle))
    .map((r) => ({ name: r.artist, tracks: r.tracks, albums: r.albums, have: have.get(norm(r.artist)) || 0 }))
    .sort((a, b) => b.albums - a.albums || b.tracks - a.tracks || a.name.localeCompare(b.name)).slice(0, limit);
}

// ---- the download queue ----------------------------------------------------------------------------------------------------------
const cp = (from, to) => { try { const st = fs.statSync(from); fs.chownSync(to, st.uid, st.gid); fs.chmodSync(to, st.mode & 0o777); } catch { /* not allowed here: fine */ } };

/** What YouTube / Vimeo say about an upload, without downloading it. */
export function ytdlpInfo({ url }) {
  return new Promise((resolve) => {
    const p = spawn(cfg.ytdlp, ['-J', '--no-playlist', '--no-warnings', '--js-runtimes', 'node', url], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    p.stdout.on('data', (d) => { if (out.length < 4_000_000) out += d; });
    const timer = setTimeout(() => p.kill('SIGKILL'), 60000);
    p.on('error', () => { clearTimeout(timer); resolve({}); });
    p.on('close', () => { clearTimeout(timer); try { resolve(JSON.parse(out)); } catch { resolve({}); } }); // no information: nothing to judge by, so do not reject
  });
}

/** The real downloader: yt-dlp into a temp folder; returns the video and picture files. */
export function ytdlpDownload({ url, dir }) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(dir, { recursive: true });
    const args = ['--no-playlist', '--no-progress', '--no-warnings', '--js-runtimes', 'node',
      '-f', 'bv*[height<=1080][vcodec^=avc1]+ba[ext=m4a]/bv*[height<=1080]+ba/b[height<=1080]/b', '--merge-output-format', 'mp4',
      '--write-thumbnail', '--convert-thumbnails', 'jpg', '-o', path.join(dir, 'video.%(ext)s'), url];
    const p = spawn(cfg.ytdlp, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    try { os.setPriority(p.pid, 10); } catch { /* best effort: be nice to live streams */ }
    let err = '';
    p.stderr.on('data', (d) => (err = (err + d).slice(-800)));
    const timer = setTimeout(() => p.kill('SIGKILL'), 20 * 60 * 1000);
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => {
      clearTimeout(timer);
      const files = fs.readdirSync(dir);
      const video = files.find((f) => /^video\.(mp4|mkv|webm|m4v)$/i.test(f));
      if (code !== 0 || !video) return reject(new Error((err.trim().split('\n').pop() || `yt-dlp exited with ${code}`).replace(/^ERROR:\s*/i, '').slice(0, 300)));
      resolve({ video: path.join(dir, video), thumb: files.includes('video.jpg') ? path.join(dir, 'video.jpg') : null });
    });
  });
}

/** Save one finished download into the library layout. Returns the final video path. */
export function place({ root, artist, title, year, genres, imvdbId, director }, { video, thumb }) {
  const dir = path.join(root, fileSafe(artist));
  const base = fileSafe(`${artist} - ${title}`);
  const ext = path.extname(video).toLowerCase() || '.mp4';
  const target = path.join(dir, base + ext);
  if (fs.existsSync(target)) throw new Error('already in the library');
  if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); cp(root, dir); }
  fs.copyFileSync(video, target); fs.rmSync(video, { force: true }); cp(dir, target);
  if (thumb && fs.existsSync(thumb)) { const poster = path.join(dir, `${base}-poster.jpg`); fs.copyFileSync(thumb, poster); cp(target, poster); }
  const nfo = path.join(dir, `${base}.nfo`);
  fs.writeFileSync(nfo, nfoXml({ title, artist, year, genres, imvdb: imvdbId, director }, null)); cp(target, nfo);
  return target;
}

export function registerImvdb(app, { db, authEnabled, runScan, download = ytdlpDownload, info = ytdlpInfo, still = looksStill, base = BASE, gapMs = 1500 }) {
  const opt = { base };
  const ready = () => {
    const lib = musicLibrary(db);
    const problems = [];
    if (!getKey(db)) problems.push('Add your IMVDb app key.');
    if (!authEnabled()) problems.push('Turn on a WBTV password first (Settings > Security): this feature downloads files and uses your IMVDb quota, so it must not be open to everyone on your network.');
    if (!lib) problems.push('Add a Music videos library first.');
    else if (!writable(lib.path)) problems.push(`The music video folder (${lib.path}) is read-only inside WBTV. Mount it writable (remove ":ro" on that one volume) to let WBTV save downloads there.`);
    return { ok: !problems.length, problems, lib };
  };
  const gate = (reply) => { const r = ready(); if (!r.ok) { reply.code(400).send({ error: r.problems[0] }); return null; } return r; };

  app.get('/api/imvdb/status', () => { const r = ready(); return { keySet: !!getKey(db), authEnabled: authEnabled(), library: r.lib ? { id: r.lib.id, name: r.lib.name, path: r.lib.path, writable: writable(r.lib.path) } : null, ready: r.ok, problems: r.problems }; });
  app.put('/api/imvdb/key', async (req, reply) => {
    if (!authEnabled()) return reply.code(400).send({ error: 'Turn on a WBTV password first (Settings > Security).' });
    const k = String(req.body?.key || '').trim();
    if (k && !/^[A-Za-z0-9_-]{6,128}$/.test(k)) return reply.code(400).send({ error: 'That does not look like an IMVDb app key.' });
    setKey(db, k);
    return { keySet: !!k };
  });
  app.get('/api/imvdb/artists', (req, reply) => { if (!gate(reply)) return; return libraryArtists(db, String(req.query?.q || '')); });
  app.get('/api/imvdb/search', async (req, reply) => {
    if (!gate(reply)) return;
    try { return await searchEntities(getKey(db), String(req.query?.q || ''), opt); } catch (e) { return reply.code(502).send({ error: e.message }); }
  });
  app.get('/api/imvdb/entity/:id', async (req, reply) => {
    if (!gate(reply)) return;
    try {
      const r = await entityVideos(getKey(db), req.params.id, opt);
      const have = haveKeys(db);
      const jobs = new Map(db.prepare('SELECT imvdb_id, status FROM mv_jobs').all().map((j) => [j.imvdb_id, j.status]));
      const artist = String(req.query?.artist || r.entity.name);
      return { entity: r.entity, total: r.total, videos: r.videos.map((v) => ({ ...v, have: have.has(`${norm(artist)}|${slug(v.title)}`), job: jobs.get(v.id) || null })) };
    } catch (e) { return reply.code(502).send({ error: e.message }); }
  });

  app.post('/api/imvdb/jobs', async (req, reply) => {
    if (!gate(reply)) return;
    const artist = String(req.body?.artist || '').trim();
    const vids = Array.isArray(req.body?.videos) ? req.body.videos.slice(0, 300) : [];
    if (!artist || !vids.length) return reply.code(400).send({ error: 'choose an artist and at least one video' });
    const ins = db.prepare("INSERT INTO mv_jobs(imvdb_id,artist,title,year,status,created,updated) VALUES(?,?,?,?,'queued',?,?) ON CONFLICT(imvdb_id) DO UPDATE SET status='queued', error=NULL, updated=excluded.updated WHERE mv_jobs.status IN ('failed','cancelled')");
    let queued = 0;
    for (const v of vids) { const r = ins.run(String(v.id), artist, String(v.title || '').trim(), Number(v.year) || null, now(), now()); queued += Number(r.changes); }
    kick();
    return { queued };
  });
  app.get('/api/imvdb/jobs', () => db.prepare('SELECT id, imvdb_id, artist, title, year, status, error, updated FROM mv_jobs ORDER BY CASE status WHEN \'running\' THEN 0 WHEN \'queued\' THEN 1 ELSE 2 END, updated DESC LIMIT 300').all());
  // retry; with { force: true } the download is kept even if it looked like a still image or a lyric / audio upload
  app.post('/api/imvdb/jobs/:id/retry', async (req) => { db.prepare("UPDATE mv_jobs SET status='queued', error=NULL, force=?, updated=? WHERE id=? AND status IN ('failed','cancelled')").run(req.body?.force ? 1 : 0, now(), req.params.id); kick(); return { ok: true }; });
  app.post('/api/imvdb/jobs/:id/cancel', async (req) => { db.prepare("UPDATE mv_jobs SET status='cancelled', updated=? WHERE id=? AND status='queued'").run(now(), req.params.id); return { ok: true }; });
  app.delete('/api/imvdb/jobs', async () => ({ removed: Number(db.prepare("DELETE FROM mv_jobs WHERE status IN ('done','failed','cancelled')").run().changes) }));

  // ---- the worker: one download at a time, started on demand and picking up anything left over from before a restart ----------------
  let working = false;
  async function work() {
    if (working) return;
    working = true;
    try {
      db.prepare("UPDATE mv_jobs SET status='queued' WHERE status='running'").run(); // a restart interrupted these
      for (;;) {
        const r = ready();
        const job = r.ok && db.prepare("SELECT * FROM mv_jobs WHERE status='queued' ORDER BY id LIMIT 1").get();
        if (!job) break;
        db.prepare("UPDATE mv_jobs SET status='running', updated=? WHERE id=?").run(now(), job.id);
        const tmp = path.join(r.lib.path, '.mvdl-tmp', String(job.id));
        try {
          const d = await videoDetail(getKey(db), job.imvdb_id, opt);
          const src = pickSource(d.sources);
          if (!src) throw new Error('IMVDb lists no YouTube or Vimeo source for this video');
          const have = haveKeys(db);
          if (have.has(`${norm(job.artist)}|${slug(d.title || job.title)}`)) throw new Error('already in the library');
          if (!job.force) { const why = judgeUpload(await info({ url: src.url })); if (why) throw new Error(`Not kept: ${why}`); }
          const files = await download({ url: src.url, dir: tmp });
          if (!job.force) { const s = await still(files.video); if (s.still) throw new Error('Not kept: it looks like a still image with the audio played over it, not a music video'); }
          const genres = buildLibraryIndex(db.prepare("SELECT artist,title,year,genres FROM items WHERE kind='track' AND artist=?").all(job.artist).map((t) => ({ ...t, genres: JSON.parse(t.genres || '[]') }))).artist(job.artist)?.genres.slice(0, 1) || [];
          const out = place({ root: r.lib.path, artist: job.artist, title: d.title || job.title, year: d.year || job.year, genres, imvdbId: job.imvdb_id, director: d.director }, files);
          db.prepare("UPDATE mv_jobs SET status='done', file=?, error=NULL, updated=? WHERE id=?").run(path.relative(r.lib.path, out), now(), job.id);
        } catch (e) {
          db.prepare("UPDATE mv_jobs SET status=?, error=?, updated=? WHERE id=?").run(/already in the library/.test(e.message) ? 'done' : 'failed', String(e.message).slice(0, 300), now(), job.id);
        } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
        await new Promise((res) => setTimeout(res, gapMs)); // a polite gap between videos
      }
    } finally {
      working = false;
      const lib = musicLibrary(db);
      if (lib && db.prepare("SELECT 1 FROM mv_jobs WHERE status='done' AND updated>?").get(now() - 3600)) runScan?.([lib.id]); // let WBTV pick up what was saved
    }
  }
  function kick() { setImmediate(() => work().catch((e) => console.error('[imvdb] worker:', e?.message || e))); }
  kick(); // resume after a restart
  return { kick };
}
