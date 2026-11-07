// Jellyfin and Emby as a source of TV and films (they share one API), so WBTV can read a library that lives in a media server
// instead of (or as well as) folders. Items are stored as  ms://<sourceId>/<itemId>  and turned into a stream URL (with the API key)
// only at the moment ffmpeg needs it, so no key is ever kept in an item path or sent to the browser.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { cfg } from './config.js';
import { tx } from './db.js';
import { scanNavidrome, streamUrl as navStream, fetchLyrics as navLyrics } from './navidrome.js';

export const isRemote = (p) => typeof p === 'string' && p.startsWith('ms://');
export const parseRemote = (p) => { const m = /^ms:\/\/(\d+)\/(.+)$/.exec(String(p || '')); return m ? { source: Number(m[1]), ref: m[2] } : null; };

/** "192.168.1.111:8096", "http://host:8096/web/index.html" -> "http://host:8096" */
export function normalizeUrl(u) {
  let s = String(u || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
  try { const x = new URL(s); return `${x.protocol}//${x.host}`; } catch { return ''; }
}

/** Jellyfin 12 removed X-Emby-Token and ?api_key=; it wants  Authorization: MediaBrowser Token="..."  (and ?ApiKey= in a URL). Emby still uses the old ones. */
const isEmby = (src) => src.kind === 'emby';
const authHeaders = (src) => (isEmby(src) ? { 'X-Emby-Token': src.token || '' } : { Authorization: `MediaBrowser Client="WBTV", Device="WBTV", DeviceId="wbtv", Version="1", Token="${String(src.token || '').replace(/[^\w.-]/g, '')}"` });
/** ffmpeg cannot be given a header per request here, so a stream URL carries the key in the query: both spellings for Jellyfin (older and 12+), api_key for Emby. */
const keyQuery = (src) => (isEmby(src) ? `api_key=${encodeURIComponent(src.token || '')}` : `ApiKey=${encodeURIComponent(src.token || '')}&api_key=${encodeURIComponent(src.token || '')}`);

async function api(src, pathAndQuery, { timeout = 30000, binary = false } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  let r;
  try {
    r = await fetch(src.url + pathAndQuery, { headers: { ...authHeaders(src), Accept: binary ? '*/*' : 'application/json' }, signal: ctl.signal });
  } catch (e) {
    throw new Error(e?.name === 'AbortError' ? 'the server did not answer in time' : `could not reach ${src.url} (${e?.cause?.code || e?.message || e})`);
  } finally { clearTimeout(t); }
  if (r.status === 401 || r.status === 403) throw new Error('the server rejected the API key');
  if (!r.ok) throw new Error(`the server answered ${r.status}`);
  return binary ? Buffer.from(await r.arrayBuffer()) : r.json();
}

/** Check a URL and key; returns what can be added. */
export async function discover(url, token, userId) {
  const src = { url: normalizeUrl(url), token: String(token || '').trim() };
  if (!src.url) throw new Error('enter the server address, for example 192.168.1.111:8096');
  const info = await api(src, '/System/Info/Public');
  src.kind = /emby/i.test(info.ProductName || '') ? 'emby' : 'jellyfin';
  if (!src.token) throw new Error('enter an API key (Jellyfin: Dashboard > API Keys)');
  const users = (await api(src, '/Users')).map((u) => ({ id: u.Id, name: u.Name, admin: !!u.Policy?.IsAdministrator }));
  if (!users.length) throw new Error('the server has no users');
  const uid = users.find((u) => u.id === userId)?.id || users[0].id;
  const views = (await api(src, `/Users/${uid}/Views`)).Items || [];
  return {
    url: src.url, name: info.ServerName || 'Media server', product: info.ProductName || 'Media server', version: info.Version || '', users, userId: uid,
    views: views.filter((v) => ['movies', 'tvshows', 'musicvideos'].includes(v.CollectionType)).map((v) => ({ id: v.Id, name: v.Name, type: v.CollectionType === 'tvshows' ? 'tv' : v.CollectionType === 'musicvideos' ? 'music' : 'movies' })),
  };
}

// ---- sources ------------------------------------------------------------------------------------------------------------------
const cache = new Map(); // id -> { at, src }
export function getSource(db, id) {
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < 60000) return hit.src;
  const src = db.prepare('SELECT * FROM sources WHERE id=?').get(id) || null;
  cache.set(id, { at: Date.now(), src });
  return src;
}
export const forgetSource = (id) => cache.delete(id);

/** Lyrics held by a media server for an item path (Navidrome): { synced } | { text } | null. */
export async function remoteLyrics(db, p) {
  const r = parseRemote(p);
  const src = r && getSource(db, r.source);
  return src?.kind === 'navidrome' ? navLyrics(src, r.ref) : null;
}

/** The URL ffmpeg should read for an item path (a plain file path is returned as is). */
export function resolveMedia(db, p) {
  const r = parseRemote(p);
  if (!r) return p;
  const src = getSource(db, r.source);
  if (!src) return p; // the source was removed: ffmpeg will fail on it and the broadcaster shows the test card
  if (src.kind === 'navidrome') return navStream(src, r.ref);
  return `${src.url}/Videos/${encodeURIComponent(r.ref)}/stream?static=true&MediaSourceId=${encodeURIComponent(r.ref)}&${keyQuery(src)}`;
}

// ---- scanning -----------------------------------------------------------------------------------------------------------------
const FIELDS = 'Overview,Genres,Studios,People,OfficialRating,CommunityRating,ProductionYear,PremiereDate,RunTimeTicks,DateLastSaved,SeriesId,SeriesName,ParentIndexNumber,IndexNumber,Artists,AlbumArtist,Album';
const covers = () => path.join(cfg.configDir, 'covers');
const coverFile = (srcId, id) => path.join(covers(), `ms_${srcId}_${String(id).replace(/[^\w-]/g, '')}.jpg`);
const jsonArr = (a) => JSON.stringify(a || []);
const secs = (ticks) => (Number(ticks) > 0 ? Number(ticks) / 1e7 : 0);
const hash = (o) => parseInt(crypto.createHash('md5').update(JSON.stringify(o)).digest('hex').slice(0, 7), 16);

async function pages(src, query) {
  const out = [];
  for (let start = 0; ; start += 500) {
    const r = await api(src, `${query}&StartIndex=${start}&Limit=500`, { timeout: 90000 });
    out.push(...(r.Items || []));
    if (!r.Items?.length || out.length >= (r.TotalRecordCount || 0)) break;
  }
  return out;
}

/** Scan one view of a media server into items/shows. Throws (leaving everything as it was) when the server cannot be read. */
export async function scanMediaServer(db, lib, progress, { safeRemovals }) {
  const m = /^ms:\/\/(\d+)\/(.+)$/.exec(lib.path);
  const src = m && db.prepare('SELECT * FROM sources WHERE id=?').get(Number(m[1]));
  if (!src) throw new Error('the media server for this library was removed');
  const view = m[2];
  if (src.kind === 'navidrome') return scanNavidrome(db, lib, src, view, progress, { safeRemovals });
  const uid = src.user_id;
  const base = `/Users/${uid}/Items?ParentId=${encodeURIComponent(view)}&Recursive=true&Fields=${FIELDS}`;
  const tv = lib.type === 'tv', mv = lib.type === 'music'; // mv: a "Music Videos" library
  // read everything first: a server that is down must not look like a library that was emptied
  const series = tv ? await pages(src, base + '&IncludeItemTypes=Series') : [];
  const items = await pages(src, base + `&IncludeItemTypes=${tv ? 'Episode' : mv ? 'MusicVideo' : 'Movie'}`);
  progress.files = items.length;

  const existing = new Map(db.prepare('SELECT path,mtime,size FROM items WHERE library_id=?').all(lib.id).map((r) => [r.path, r]));
  const showIds = new Map();
  const selShow = db.prepare('SELECT id,title,plot,year,rating,mpaa,studios,genres,poster FROM shows WHERE path=?');
  const insShow = db.prepare('INSERT INTO shows(library_id,path,title,plot,year,rating,mpaa,studios,genres,poster) VALUES(?,?,?,?,?,?,?,?,?,?)');
  const updShow = db.prepare('UPDATE shows SET title=?,plot=?,year=?,rating=?,mpaa=?,studios=?,genres=?,poster=? WHERE id=?');
  const poster = (id) => (fs.existsSync(coverFile(src.id, id)) ? coverFile(src.id, id) : null);
  const want = []; // art still to download

  tx(db, () => {
    for (const s of series) {
      const p = `ms://${src.id}/${s.Id}`;
      const row = [s.Name || '', s.Overview || '', s.ProductionYear ?? null, s.CommunityRating ?? null, s.OfficialRating || '', jsonArr((s.Studios || []).map((x) => x.Name)), jsonArr(s.Genres), poster(s.Id)];
      const ex = selShow.get(p);
      if (ex) {
        const now = [ex.title, ex.plot, ex.year, ex.rating, ex.mpaa, ex.studios, ex.genres, ex.poster];
        if (row.some((v, i) => (v ?? null) !== (now[i] ?? null))) progress.changed++;
        updShow.run(...row, ex.id); showIds.set(s.Id, ex.id);
      } else { progress.changed++; showIds.set(s.Id, Number(insShow.run(lib.id, p, ...row).lastInsertRowid)); }
      if (!poster(s.Id)) want.push(s.Id);
    }
  });

  const seen = new Set();
  const upsert = db.prepare(`INSERT INTO items
    (library_id,show_id,kind,path,title,plot,year,season,episode,aired,rating,mpaa,runtime,probed,studios,genres,actors,poster,mtime,size,nfo_mtime,artist,album)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?,?,?,NULL,?,?)
    ON CONFLICT(path) DO UPDATE SET show_id=excluded.show_id,kind=excluded.kind,title=excluded.title,plot=excluded.plot,year=excluded.year,season=excluded.season,
      episode=excluded.episode,aired=excluded.aired,rating=excluded.rating,mpaa=excluded.mpaa,runtime=excluded.runtime,probed=1,studios=excluded.studios,
      genres=excluded.genres,actors=excluded.actors,poster=excluded.poster,mtime=excluded.mtime,size=excluded.size,artist=excluded.artist,album=excluded.album`);
  tx(db, () => {
    for (const it of items) {
      const runtime = secs(it.RunTimeTicks);
      if (!(runtime > 0)) continue; // nothing to schedule
      const p = `ms://${src.id}/${it.Id}`;
      seen.add(p);
      const show = tv ? showIds.get(it.SeriesId) ?? null : null;
      if (tv && show == null) continue; // an episode whose series we could not read
      const meta = {
        title: it.Name || '', plot: it.Overview || '', year: it.ProductionYear ?? null, season: tv ? it.ParentIndexNumber ?? null : null, episode: tv ? it.IndexNumber ?? null : null,
        aired: (it.PremiereDate || '').slice(0, 10) || null, rating: it.CommunityRating ?? null, mpaa: it.OfficialRating || '', studios: (it.Studios || []).map((x) => x.Name), genres: it.Genres || [],
        actors: (it.People || []).filter((x) => !x.Type || x.Type === 'Actor').slice(0, 15).map((x) => ({ name: x.Name, role: x.Role || '' })),
      };
      const artist = mv ? (it.Artists?.[0] || it.AlbumArtist || '') : null, album = mv ? it.Album || '' : null;
      const sig = hash([meta, runtime, artist, album]);
      const mtime = Date.parse(it.DateLastSaved || '') || 0;
      const ex = existing.get(p);
      const art = poster(it.Id);
      if (!art) want.push(it.Id);
      if (ex && ex.mtime === mtime && ex.size === sig) { if (art) db.prepare('UPDATE items SET poster=? WHERE path=?').run(art, p); continue; }
      progress.changed++;
      upsert.run(lib.id, show, tv ? 'episode' : mv ? 'musicvideo' : 'movie', p, meta.title, meta.plot, meta.year, meta.season, meta.episode, meta.aired, meta.rating, meta.mpaa, runtime,
        jsonArr(meta.studios), jsonArr(meta.genres), JSON.stringify(meta.actors), art, mtime, sig, artist, album);
    }
  });

  const gone = safeRemovals(db, lib, [...existing.keys()].filter((p) => !seen.has(p)), existing.size, seen.size, []);
  if (gone.length) { const del = db.prepare('DELETE FROM items WHERE path=?'); tx(db, () => { for (const p of gone) del.run(p); }); progress.removed = (progress.removed || 0) + gone.length; }
  db.prepare('DELETE FROM shows WHERE library_id=? AND id NOT IN (SELECT DISTINCT show_id FROM items WHERE show_id IS NOT NULL)').run(lib.id);
  db.prepare('UPDATE libraries SET last_scan=? WHERE id=?').run(Date.now(), lib.id);
  await fetchArt(db, src, lib, want, tv ? series : []); // bounded: a big library fills in over a few scans
}

/** Pictures: downloaded once into the config folder (a few hundred per scan, so a big library fills in without a burst of requests). */
async function fetchArt(db, src, lib, ids, seriesList, max = 300) {
  fs.mkdirSync(covers(), { recursive: true });
  const todo = [...new Set(ids)].slice(0, max);
  const setItem = db.prepare('UPDATE items SET poster=? WHERE path=? AND library_id=?');
  const setShow = db.prepare('UPDATE shows SET poster=? WHERE path=? AND library_id=?');
  const isSeries = new Set(seriesList.map((s) => s.Id));
  let i = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (i < todo.length) {
      const id = todo[i++];
      try {
        const buf = await api(src, `/Items/${encodeURIComponent(id)}/Images/Primary?maxHeight=450&quality=85`, { binary: true, timeout: 20000 });
        if (!buf.length) continue;
        const f = coverFile(src.id, id);
        fs.writeFileSync(f, buf);
        (isSeries.has(id) ? setShow : setItem).run(f, `ms://${src.id}/${id}`, lib.id);
      } catch { /* no picture for this one; try again on a later scan */ }
    }
  }));
}
