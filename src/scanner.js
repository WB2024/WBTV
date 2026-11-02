import fs from 'node:fs/promises';
import path from 'node:path';
import { parseNfo } from './nfo.js';
import { tx } from './db.js';
import { cfg } from './config.js';
import { probe } from './media.js';

const VIDEO = new Set(['.mkv', '.mp4', '.avi', '.m4v', '.mov', '.wmv', '.ts', '.m2ts', '.mpg', '.mpeg', '.flv', '.webm', '.divx', '.vob', '.ogm']);
const EXTRA_FILE = /(^|[-_. ])(trailer|sample|featurette|behindthescenes|deleted|interview|clip)\.[^.]+$/i;
const EXTRA_DIR = /^(extras?|featurettes?|trailers?|samples?|behind the scenes|deleted scenes|interviews|scenes|@eadir|#recycle|\..*)$/i;
const SEASON_DIR = /^(season|series|specials?|s)\s*\d*/i;
const IMG = ['.jpg', '.jpeg', '.png', '.webp'];

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
  if (lib.type.startsWith('ads')) return scanAdsLibrary(db, lib, progress);
  const io = new Pool(cfg.scanConcurrency);
  const readdir = (d) => io.run(() => fs.readdir(d, { withFileTypes: true }));
  const stat = (p) => io.run(() => fs.stat(p)).catch(() => null);
  const read = (p) => io.run(() => fs.readFile(p, 'utf8')).catch(() => null);

  const existing = new Map();
  for (const r of db.prepare('SELECT path,mtime,size,nfo_mtime FROM items WHERE library_id=?').all(lib.id)) existing.set(r.path, r);
  const seen = new Set();
  let batch = [];

  const upsertItem = db.prepare(`INSERT INTO items
    (library_id,show_id,kind,path,title,plot,year,season,episode,aired,rating,mpaa,runtime,probed,studios,genres,actors,poster,mtime,size,nfo_mtime)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(path) DO UPDATE SET show_id=excluded.show_id,kind=excluded.kind,title=excluded.title,plot=excluded.plot,year=excluded.year,
      season=excluded.season,episode=excluded.episode,aired=excluded.aired,rating=excluded.rating,mpaa=excluded.mpaa,
      runtime=excluded.runtime,probed=excluded.probed,studios=excluded.studios,genres=excluded.genres,actors=excluded.actors,
      poster=excluded.poster,mtime=excluded.mtime,size=excluded.size,nfo_mtime=excluded.nfo_mtime`);
  const flush = () => {
    if (!batch.length) return;
    const b = batch; batch = [];
    tx(db, () => { for (const r of b) upsertItem.run(...r); });
  };
  const queue = (r) => { batch.push(r.map((v) => (v === undefined ? null : v))); progress.changed++; if (batch.length >= 400) flush(); };

  const selShow = db.prepare('SELECT id FROM shows WHERE path=?');
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
    if (ex) { updShow.run(...row, ex.id); return { id: ex.id, nfo }; }
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

    if (lib.type === 'movies') {
      const folder = ctx.videoCount === 1 ? path.basename(dir) : base;
      queue([lib.id, null, 'movie', full, nfo?.title || cleanName(folder), nfo?.plot || '', nfo?.year ?? yearOf(folder), null, null,
        nfo?.aired || '', nfo?.rating ?? null, nfo?.mpaa || '', runtime, probed, j(nfo?.studios), j(nfo?.genres), j(nfo?.actors),
        poster, st.mtimeMs, st.size, nst ? nst.mtimeMs : null]);
    } else {
      let season = nfo?.season, episode = nfo?.episode;
      const m = base.match(/S(\d{1,3})\s*E(\d{1,3})/i) || base.match(/\b(\d{1,2})x(\d{2,3})\b/i);
      if (m && (season == null || season < 0)) { season = Number(m[1]); episode = Number(m[2]); }
      let title = nfo?.title;
      if (!title) title = base.replace(/^.*?S\d+\s*E\d+\s*[-. ]*/i, '').replace(/\[.*?\]|\(.*?\)/g, '').replace(/[._]+/g, ' ').trim() || base;
      queue([lib.id, ctx.show.id, 'episode', full, title, nfo?.plot || '', nfo?.year, season ?? null, episode ?? null,
        nfo?.aired || '', nfo?.rating ?? null, nfo?.mpaa || '', runtime, probed, j(nfo?.studios), j(nfo?.genres), j(nfo?.actors),
        poster, st.mtimeMs, st.size, nst ? nst.mtimeMs : null]);
    }
  }

  async function visit(dir, show) {
    let entries;
    try { entries = await readdir(dir); } catch { return; }
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
  const gone = [...existing.keys()].filter((p) => !seen.has(p));
  progress.removed = (progress.removed || 0) + gone.length;
  if (gone.length) {
    const del = db.prepare('DELETE FROM items WHERE path=?');
    tx(db, () => { for (const p of gone) del.run(p); });
  }
  db.prepare('DELETE FROM shows WHERE library_id=? AND id NOT IN (SELECT DISTINCT show_id FROM items WHERE show_id IS NOT NULL)').run(lib.id);
  db.prepare('UPDATE libraries SET last_scan=? WHERE id=?').run(Date.now(), lib.id);
}

async function scanAdsLibrary(db, lib, progress) {
  const kind = { ads_tv: 'tv', ads_movies: 'movie' }[lib.type] || 'all';
  db.prepare('UPDATE ads SET kind=? WHERE library_id=?').run(kind, lib.id);
  const files = [];
  async function walk(d) {
    let es; try { es = await fs.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (VIDEO.has(path.extname(e.name).toLowerCase())) files.push(p);
    }
  }
  await walk(lib.path);
  progress.files = files.length;
  const known = new Map(db.prepare('SELECT source,id FROM ads WHERE library_id=?').all(lib.id).map((r) => [r.source, r.id]));
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
  for (const id of known.values()) {
    db.prepare('UPDATE blocks SET ad_id=NULL WHERE ad_id=?').run(id);
    db.prepare('DELETE FROM ads WHERE id=?').run(id);
  }
  db.prepare('UPDATE libraries SET last_scan=? WHERE id=?').run(Date.now(), lib.id);
}
