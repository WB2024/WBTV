import fs from 'node:fs/promises';
import path from 'node:path';
import { parseNfo } from './nfo.js';
import { tx } from './db.js';
import { cfg } from './config.js';
import crypto from 'node:crypto';
import { probe, probeTags, run } from './media.js';
import { syncIptvLibrary } from './iptv.js';
import { isRemote, scanMediaServer } from './mediaserver.js';

const VIDEO = new Set(['.mkv', '.mp4', '.avi', '.m4v', '.mov', '.wmv', '.ts', '.m2ts', '.mpg', '.mpeg', '.flv', '.webm', '.divx', '.vob', '.ogm']);
const EXTRA_FILE = /(^|[-_. ])(trailer|sample|featurette|behindthescenes|deleted|interview|clip)\.[^.]+$/i;
const EXTRA_DIR = /^(extras?|featurettes?|trailers?|samples?|behind the scenes|deleted scenes|interviews|scenes|@eadir|#recycle|\..*)$/i;
const SEASON_DIR = /^(season|series|specials?|s)\s*\d*/i;
const IMG = ['.jpg', '.jpeg', '.png', '.webp'];

/**
 * Which of the files that were not seen this scan should really be removed from the database?
 * An offline share (or an empty mount point) looks exactly like "every file was deleted", and believing it wipes the library and its
 * schedule. So: nothing under a folder we failed to read is ever removed, and when nearly everything seems to have vanished we keep it all
 * until a second scan agrees. Returns the paths that are safe to remove.
 */
export function safeRemovals(db, lib, gone, total, seenCount, unreadable) {
  const under = (p) => unreadable.some((d) => p === d || p.startsWith(d + path.sep) || p.startsWith(d + '/'));
  const candidates = gone.filter((p) => !under(p));
  const key = `scanguard_${lib.id}`;
  const suspicious = total > 0 && (seenCount === 0 || (total >= 20 && candidates.length > total * 0.5));
  if (!suspicious) { db.prepare('DELETE FROM settings WHERE key=?').run(key); return candidates; }
  const prev = Number(db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value) || 0;
  if (prev && Date.now() - prev < 6 * 3600 * 1000) { db.prepare('DELETE FROM settings WHERE key=?').run(key); return candidates; } // two scans in a row agree
  db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(key, String(Date.now()));
  console.error(`[scan] "${lib.name}": ${candidates.length} of ${total} known files look gone (is the share offline?); keeping them until the next scan confirms`);
  return [];
}

class Pool {
  constructor(n) { this.n = n; this.active = 0; this.q = []; }
  run(fn) {
    return new Promise((res, rej) => { this.q.push({ fn, res, rej }); this.pump(); });
  }
  pump() {
    while (this.active < this.n && this.q.length) {
      const { fn, res, rej } = this.q.shift();
      this.active++;
      fn().then(res, rej).finally(() => { this.active--; this.pump(); });
    }
  }
}

const cleanName = (s) => s.replace(/\s*[[(]\d{4}[\])]\s*$/, '').replace(/[._]+/g, ' ').trim();
const yearOf = (s) => { const m = s.match(/[[(](\d{4})[\])]\s*$/); return m ? Number(m[1]) : null; };
const j = (v) => JSON.stringify(v || []);

function pickArt(names, base, kind) {
  // names: Map(lowercase -> actual)
  const tries = kind === 'episode'
    ? IMG.flatMap((e) => [`${base}-thumb${e}`, `${base}${e}`])
    : IMG.flatMap((e) => [`${base}-poster${e}`, `poster${e}`, `folder${e}`, `${base}${e}`, `cover${e}`]);
  for (const t of tries) { const hit = names.get(t.toLowerCase()); if (hit) return hit; }
  return null;
}

export async function scanLibrary(db, lib, progress) {
  if (isRemote(lib.path)) return scanMediaServer(db, lib, progress, { safeRemovals }); // a library that lives in Jellyfin / Emby
  if (lib.type.startsWith('ads')) return scanAdsLibrary(db, lib, progress);
  if (lib.type === 'iptv') return syncIptvLibrary(db, lib, progress);
  if (lib.type === 'radio' || TALK[lib.type]) return scanRadio(db, lib, progress);
  const io = new Pool(cfg.scanConcurrency);
  const readdir = (d) => io.run(() => fs.readdir(d, { withFileTypes: true }));
  const stat = (p) => io.run(() => fs.stat(p)).catch(() => null);
  const read = (p) => io.run(() => fs.readFile(p, 'utf8')).catch(() => null);

  const existing = new Map();
  for (const r of db.prepare('SELECT path,mtime,size,nfo_mtime FROM items WHERE library_id=?').all(lib.id)) existing.set(r.path, r);
  const seen = new Set();
  const unreadable = []; // folders we could not list this scan: what is under them is not "gone", just unknown
  let batch = [];

  const upsertItem = db.prepare(`INSERT INTO items
    (library_id,show_id,kind,path,title,plot,year,season,episode,aired,rating,mpaa,runtime,probed,studios,genres,actors,poster,mtime,size,nfo_mtime,artist,album)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(path) DO UPDATE SET show_id=excluded.show_id,kind=excluded.kind,title=excluded.title,plot=excluded.plot,year=excluded.year,
      season=excluded.season,episode=excluded.episode,aired=excluded.aired,rating=excluded.rating,mpaa=excluded.mpaa,
      runtime=excluded.runtime,probed=excluded.probed,studios=excluded.studios,genres=excluded.genres,actors=excluded.actors,
      poster=excluded.poster,mtime=excluded.mtime,size=excluded.size,nfo_mtime=excluded.nfo_mtime,artist=excluded.artist,album=excluded.album`);
  const flush = () => {
    if (!batch.length) return;
    const b = batch; batch = [];
    tx(db, () => { for (const r of b) upsertItem.run(...r); });
  };
  const queue = (r) => { batch.push(r.map((v) => (v === undefined ? null : v))); progress.changed++; if (batch.length >= 400) flush(); };

  const selShow = db.prepare('SELECT id,title,plot,year,rating,mpaa,studios,genres,poster FROM shows WHERE path=?');
  const insShow = db.prepare('INSERT INTO shows(library_id,path,title,plot,year,rating,mpaa,studios,genres,poster) VALUES(?,?,?,?,?,?,?,?,?,?)');
  const updShow = db.prepare('UPDATE shows SET title=?,plot=?,year=?,rating=?,mpaa=?,studios=?,genres=?,poster=? WHERE id=?');

  async function loadShow(dir, names) {
    const nfoName = names.get('tvshow.nfo');
    const nfo = nfoName ? parseNfo((await read(path.join(dir, nfoName))) || '') : null;
    const poster = pickArt(names, 'poster', 'show');
    const row = [
      nfo?.title || cleanName(path.basename(dir)), nfo?.plot || '', nfo?.year ?? yearOf(path.basename(dir)),
      nfo?.rating ?? null, nfo?.mpaa || '', j(nfo?.studios), j(nfo?.genres), poster ? path.join(dir, poster) : null,
    ];
    const ex = selShow.get(dir);
    if (ex) {
      // a changed tvshow.nfo (studio, genre...) alters the channels even when no episode file changed, so it counts as a change
      const now = [ex.title, ex.plot, ex.year, ex.rating, ex.mpaa, ex.studios, ex.genres, ex.poster];
      if (row.some((v, i) => (v ?? null) !== (now[i] ?? null))) progress.changed++;
      updShow.run(...row, ex.id);
      return { id: ex.id, nfo };
    }
    progress.changed++;
    const r = insShow.run(lib.id, dir, ...row);
    return { id: Number(r.lastInsertRowid), nfo };
  }

  async function handleVideo(dir, file, names, ctx) {
    const full = path.join(dir, file);
    progress.files++;
    seen.add(full);
    const base = path.parse(file).name;
    let nfoName = names.get(`${base}.nfo`.toLowerCase());
    if (!nfoName && lib.type === 'movies' && ctx.videoCount === 1) nfoName = names.get('movie.nfo');
    const [st, nst] = await Promise.all([stat(full), nfoName ? stat(path.join(dir, nfoName)) : null]);
    if (!st) return;
    const ex = existing.get(full);
    if (ex && ex.mtime === st.mtimeMs && ex.size === st.size && (ex.nfo_mtime || null) === (nst ? nst.mtimeMs : null)) return;

    const nfo = nfoName ? parseNfo((await read(path.join(dir, nfoName))) || '') : null;
    const art = pickArt(names, base, lib.type === 'tv' ? 'episode' : 'movie');
    const poster = art ? path.join(dir, art) : null;
    let runtime = nfo?.durationSec || 0, probed = runtime ? 1 : 0;
    if (!runtime && nfo?.runtimeSec) runtime = nfo.runtimeSec; // provisional, ffprobe will correct it

    if (lib.type === 'music') {
      // music video: NFO first, else "Artist - Title" from the file name
      const m = base.match(/^(.+?)\s+-\s+(.+)$/);
      const artist = nfo?.artist || (m ? m[1].trim() : path.basename(dir));
      const title = nfo?.title || (m ? m[2].trim() : cleanName(base));
      queue([lib.id, null, 'musicvideo', full, title, nfo?.plot || '', nfo?.year, null, null, nfo?.aired || '', nfo?.rating ?? null, nfo?.mpaa || '',
        runtime, probed, j(nfo?.studios), j(nfo?.genres), j([]), poster, st.mtimeMs, st.size, nst ? nst.mtimeMs : null, artist, nfo?.album || '']);
    } else if (lib.type === 'movies') {
      const folder = ctx.videoCount === 1 ? path.basename(dir) : base;
      queue([lib.id, null, 'movie', full, nfo?.title || cleanName(folder), nfo?.plot || '', nfo?.year ?? yearOf(folder), null, null,
        nfo?.aired || '', nfo?.rating ?? null, nfo?.mpaa || '', runtime, probed, j(nfo?.studios), j(nfo?.genres), j(nfo?.actors),
        poster, st.mtimeMs, st.size, nst ? nst.mtimeMs : null, null, null]);
    } else {
      let season = nfo?.season, episode = nfo?.episode;
      const m = base.match(/S(\d{1,3})\s*E(\d{1,3})/i) || base.match(/\b(\d{1,2})x(\d{2,3})\b/i);
      if (m && (season == null || season < 0)) { season = Number(m[1]); episode = Number(m[2]); }
      let title = nfo?.title;
      if (!title) title = base.replace(/^.*?S\d+\s*E\d+\s*[-. ]*/i, '').replace(/\[.*?\]|\(.*?\)/g, '').replace(/[._]+/g, ' ').trim() || base;
      queue([lib.id, ctx.show.id, 'episode', full, title, nfo?.plot || '', nfo?.year, season ?? null, episode ?? null,
        nfo?.aired || '', nfo?.rating ?? null, nfo?.mpaa || '', runtime, probed, j(nfo?.studios), j(nfo?.genres), j(nfo?.actors),
        poster, st.mtimeMs, st.size, nst ? nst.mtimeMs : null, null, null]);
    }
  }

  async function visit(dir, show) {
    let entries;
    try { entries = await readdir(dir); } catch { unreadable.push(dir); return; }
    progress.dirs++;
    const names = new Map(entries.filter((e) => e.isFile()).map((e) => [e.name.toLowerCase(), e.name]));
    if (lib.type === 'tv' && names.has('tvshow.nfo')) show = await loadShow(dir, names);

    const videos = entries.filter((e) => e.isFile() && VIDEO.has(path.extname(e.name).toLowerCase()) && !EXTRA_FILE.test(e.name));
    if (videos.length) {
      let ctx = { videoCount: videos.length, show };
      if (lib.type === 'tv' && !show) {
        const root = SEASON_DIR.test(path.basename(dir)) ? path.dirname(dir) : dir;
        const rootNames = root === dir ? names : new Map((await readdir(root).catch(() => [])).filter((e) => e.isFile()).map((e) => [e.name.toLowerCase(), e.name]));
        ctx = { videoCount: videos.length, show: await loadShow(root, rootNames) };
      }
      await Promise.all(videos.map((v) => handleVideo(dir, v.name, names, ctx)));
    }
    const subs = entries.filter((e) => e.isDirectory() && !EXTRA_DIR.test(e.name));
    await Promise.all(subs.map((d) => visit(path.join(dir, d.name), show)));
  }

  await visit(lib.path, null);
  flush();

  // remove vanished files (only reached if the walk completed)
  const gone = safeRemovals(db, lib, [...existing.keys()].filter((p) => !seen.has(p)), existing.size, seen.size, unreadable);
  progress.removed = (progress.removed || 0) + gone.length;
  if (gone.length) {
    const del = db.prepare('DELETE FROM items WHERE path=?');
    tx(db, () => { for (const p of gone) del.run(p); });
  }
  db.prepare('DELETE FROM shows WHERE library_id=? AND id NOT IN (SELECT DISTINCT show_id FROM items WHERE show_id IS NOT NULL)').run(lib.id);
  db.prepare('UPDATE libraries SET last_scan=? WHERE id=?').run(Date.now(), lib.id);
}

const AUDIO = new Set(['.mp3', '.flac', '.m4a', '.aac', '.ogg', '.opus', '.wav', '.wma', '.m4b']);
const COVERS = ['cover', 'folder', 'front', 'album', 'albumart'];

/** What a spoken-word library holds: the label shown on screen, and the genre we give its items. */
export const TALK = {
  talk_interviews: { label: 'Interview', channel: 'Radio Interviews' },
  talk_podcasts: { label: 'Podcast', channel: 'Podcasts' },
  talk_audiobooks: { label: 'Audiobook', channel: 'Audiobooks' },
};

/** Audiobooks and many music files carry their cover inside the file: pull it out once (cached by file identity). */
async function embeddedCover(file, st, key = `${file}|${st.size}|${st.mtimeMs}`) {
  const dir = path.join(cfg.configDir, 'covers');
  const out = path.join(dir, crypto.createHash('md5').update(key).digest('hex') + '.jpg');
  try { await fs.access(out); return out; } catch { /* not extracted yet */ }
  await fs.mkdir(dir, { recursive: true });
  const r = await run(cfg.ffmpeg, ['-nostdin', '-v', 'error', '-y', '-i', file, '-an', '-map', '0:v:0?', '-frames:v', '1', '-vf', 'scale=-2:600', out], { timeout: 30000 });
  if (r.code !== 0) return null;
  return fs.access(out).then(() => out, () => null);
}

/** A sane year from the tags (some files carry DATE=0001-01-01), falling back to a "[1985] Album" folder name. */
export function yearFromTags(t, dir = '') {
  for (const k of [t.date, t.year, t.originalyear, t.originaldate, t.creation_time]) {
    const y = parseInt(String(k || '').slice(0, 4), 10);
    if (y >= 1900 && y <= 2100) return y;
  }
  const m = path.basename(dir).match(/^[[(](\d{4})[\])]/);
  return m && m[1] >= 1900 ? Number(m[1]) : null;
}

const tidy = (s) => String(s || '').replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();
const num = (s) => { const n = parseInt(String(s || '').split('/')[0], 10); return Number.isFinite(n) ? n : null; };

/**
 * Radio libraries: audio files, tags read with ffprobe (only for new/changed files, 8 at a time).
 * Music radio items are 'track'. Spoken-word libraries (interviews, podcasts, audiobooks) produce 'talk' items:
 * the show or book is the album, the host or author is the artist, and the track number keeps chapters in order.
 */
async function scanRadio(db, lib, progress) {
  // self-heal: an earlier parser took the track number of "14 - Artist. Title" for the artist; re-read those few rows
  db.prepare("UPDATE items SET mtime=0 WHERE library_id=? AND kind='track' AND artist GLOB '[0-9]*' AND artist NOT GLOB '*[^0-9]*'").run(lib.id);
  db.prepare("UPDATE items SET mtime=0 WHERE library_id=? AND kind IN ('track','talk') AND year IS NOT NULL AND year<1900").run(lib.id); // junk dates such as 0001-01-01
  const talk = TALK[lib.type] || null;
  const kind = talk ? 'talk' : 'track';
  const existing = new Map(db.prepare('SELECT path,mtime,size FROM items WHERE library_id=?').all(lib.id).map((r) => [r.path, r]));
  const seen = new Set();
  const unreadable = [];
  const probes = new Pool(8);
  const ins = db.prepare(`INSERT INTO items (library_id,kind,path,title,year,runtime,probed,genres,actors,poster,mtime,size,artist,album,studios,plot,season,episode,aired)
    VALUES (?,?,?,?,?,?,1,?,'[]',?,?,?,?,?,'[]',?,?,?,?) ON CONFLICT(path) DO UPDATE SET kind=excluded.kind,title=excluded.title,year=excluded.year,runtime=excluded.runtime,
    genres=excluded.genres,poster=excluded.poster,mtime=excluded.mtime,size=excluded.size,artist=excluded.artist,album=excluded.album,plot=excluded.plot,
    season=excluded.season,episode=excluded.episode,aired=excluded.aired`);
  let batch = [];
  const flush = () => { if (!batch.length) return; const b = batch; batch = []; tx(db, () => { for (const r of b) ins.run(...r); }); };
  const albumArt = new Map();
  const skipDir = talk ? /^(@eadir|#recycle|\..*)$/i : EXTRA_DIR; // an "Interviews" folder is exactly what a talk library is made of

  async function visit(dir, depth) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { unreadable.push(dir); return; }
    progress.dirs++;
    const names = new Map(entries.filter((e) => e.isFile()).map((e) => [e.name.toLowerCase(), e.name]));
    const cover = COVERS.flatMap((c) => IMG.map((x) => c + x)).map((n) => names.get(n)).find(Boolean);
    await Promise.all(entries.filter((e) => e.isFile() && AUDIO.has(path.extname(e.name).toLowerCase())).map(async (e) => {
      const full = path.join(dir, e.name);
      seen.add(full); progress.files++;
      const st = await fs.stat(full).catch(() => null);
      if (!st) return;
      const ex = existing.get(full);
      if (ex && ex.mtime === st.mtimeMs && ex.size === st.size) return;
      const info = await probes.run(() => probeTags(full));
      if (!info || !(info.duration > 0)) return;
      const t = info.tags;
      const base = path.parse(e.name).name;
      const m = base.match(/^(?:\d+[\s.-]+)?(.+?)\s+-\s+(.+)$/);
      const year = yearFromTags(t, dir) ?? NaN;
      progress.changed++;
      // music: one extraction per album folder (its tracks share the picture); talk: per file (episodes and books differ)
      let cov = cover ? path.join(dir, cover) : null;
      if (!cov && talk) cov = await probes.run(() => embeddedCover(full, st));
      else if (!cov) { if (!albumArt.has(dir)) albumArt.set(dir, probes.run(() => embeddedCover(full, st, 'album|' + dir))); cov = await albumArt.get(dir); }
      if (!talk) {
        batch.push([lib.id, kind, full, t.title || (m ? m[2].trim() : base.replace(/^\d+[\s.-]+/, '')), Number.isFinite(year) ? year : null, info.duration,
          j(t.genre ? t.genre.split(/[;/]/).map((g) => g.trim()).filter(Boolean) : []), cov, st.mtimeMs, st.size,
          t.artist || t.album_artist || (m && !/^\d+$/.test(m[1].trim()) ? m[1].trim() : ''), t.album || '', '', null, null, null]);
      } else {
        // the folder names are the fallback for the show / book / host / author
        const parent = tidy(path.basename(dir)), grand = tidy(path.basename(path.dirname(dir)));
        const atRoot = path.resolve(dir) === path.resolve(lib.path);
        const book = t.album || (atRoot ? '' : parent);
        const who = t.artist || t.album_artist || t.author || t.composer || (lib.type === 'talk_audiobooks' && !atRoot && path.resolve(path.dirname(dir)) !== path.resolve(lib.path) ? grand : '');
        const plain = tidy(base.replace(/^\d+[\s.-]+/, '').replace(/^\d{4}-\d{2}-\d{2}[\s.-]*/, ''));
        const aired = (t.date || t.creation_time || '').slice(0, 10) || (/^\d{4}-\d{2}-\d{2}/.exec(base) || [''])[0];
        const plot = String(t.description || t.comment || t.synopsis || t.lyrics || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1200);
        batch.push([lib.id, kind, full, t.title || plain || base, Number.isFinite(year) ? year : null, info.duration,
          j([talk.label]), cov, st.mtimeMs, st.size, who, book, plot, num(t.disc), num(t.track), aired || null]);
      }
      if (batch.length >= 300) flush();
    }));
    await Promise.all(entries.filter((e) => e.isDirectory() && !skipDir.test(e.name)).map((d) => visit(path.join(dir, d.name), depth + 1)));
  }
  await visit(lib.path, 0);
  flush();
  const gone = safeRemovals(db, lib, [...existing.keys()].filter((p) => !seen.has(p)), existing.size, seen.size, unreadable);
  if (gone.length) { const del = db.prepare('DELETE FROM items WHERE path=?'); tx(db, () => { for (const p of gone) del.run(p); }); progress.removed = (progress.removed || 0) + gone.length; }
  if (!talk) await backfillCovers(db, lib);
  db.prepare('UPDATE libraries SET last_scan=? WHERE id=?').run(Date.now(), lib.id);
}

/**
 * Tracks scanned before covers were read have no picture. Look once per album folder (a few hundred folders per scan, so a big
 * library fills in over a day without a burst of work): the first track's embedded art goes to every track of that folder.
 * A folder with no art is marked with '' so it is not tried again.
 */
async function backfillCovers(db, lib, maxDirs = 400) {
  const rows = db.prepare('SELECT id,path FROM items WHERE library_id=? AND poster IS NULL ORDER BY path').all(lib.id);
  if (!rows.length) return;
  const byDir = new Map();
  for (const r of rows) { const d = path.dirname(r.path); (byDir.get(d) || byDir.set(d, []).get(d)).push(r); }
  const set = db.prepare('UPDATE items SET poster=? WHERE id=?');
  let n = 0;
  for (const [dir, list] of byDir) {
    if (n++ >= maxDirs) break;
    const st = await fs.stat(list[0].path).catch(() => null);
    const cov = st ? await embeddedCover(list[0].path, st, 'album|' + dir) : null;
    tx(db, () => { for (const r of list) set.run(cov || '', r.id); });
  }
}

async function scanAdsLibrary(db, lib, progress) {
  const kind = { ads_tv: 'tv', ads_movies: 'movie', ads_idents: 'ident' }[lib.type] || 'all';
  db.prepare('UPDATE ads SET kind=? WHERE library_id=?').run(kind, lib.id);
  const files = [];
  const unreadable = [];
  async function walk(d) {
    let es; try { es = await fs.readdir(d, { withFileTypes: true }); } catch { unreadable.push(d); return; }
    for (const e of es) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (VIDEO.has(path.extname(e.name).toLowerCase())) files.push(p);
    }
  }
  await walk(lib.path);
  progress.files = files.length;
  const known = new Map(db.prepare('SELECT source,id FROM ads WHERE library_id=?').all(lib.id).map((r) => [r.source, r.id]));
  const knownTotal = known.size;
  const ins = db.prepare("INSERT INTO ads(title,source,file,duration,status,library_id,kind) VALUES(?,?,?,?,?,?,?)");
  let i = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (i < files.length) {
      const f = files[i++];
      if (known.has(f)) { known.delete(f); continue; }
      const p = await probe(f);
      try { ins.run(path.parse(f).name, f, f, p?.duration || 0, p ? 'ready' : 'error', lib.id, kind); progress.changed++; } catch { /* dup */ }
    }
  }));
  const removable = new Set(safeRemovals(db, lib, [...known.keys()], knownTotal, files.length, unreadable));
  for (const [source, id] of known) {
    if (!removable.has(source)) continue;
    db.prepare('UPDATE blocks SET ad_id=NULL WHERE ad_id=?').run(id);
    db.prepare('DELETE FROM ads WHERE id=?').run(id);
  }
  db.prepare('UPDATE libraries SET last_scan=? WHERE id=?').run(Date.now(), lib.id);
}
