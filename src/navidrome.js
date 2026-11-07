// Navidrome (or any Subsonic / OpenSubsonic server) as a source of music for radio stations.
// Auth is the Subsonic token scheme: t = md5(password + salt). Only the username, the salt and the token are stored, never the password,
// and they are only ever put into URLs at the moment ffmpeg or the API needs them (and are hidden from logs).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { cfg } from './config.js';
import { tx } from './db.js';

const V = '1.16.1';
const enc = encodeURIComponent;
export const makeAuth = (password) => { const salt = crypto.randomBytes(8).toString('hex'); return { salt, token: crypto.createHash('md5').update(String(password) + salt).digest('hex') }; };
const authQuery = (src) => `u=${enc(src.user_id || '')}&t=${src.token || ''}&s=${src.salt || ''}&v=${V}&c=wbtv&f=json`;

async function call(src, method, params = '', { timeout = 30000, binary = false } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  let r;
  try {
    r = await fetch(`${src.url}/rest/${method}?${authQuery(src)}${params ? '&' + params : ''}`, { signal: ctl.signal });
  } catch (e) {
    throw new Error(e?.name === 'AbortError' ? 'the server did not answer in time' : `could not reach ${src.url} (${e?.cause?.code || e?.message || e})`);
  } finally { clearTimeout(t); }
  if (!r.ok) throw new Error(`the server answered ${r.status}`);
  if (binary) {
    if (/json/.test(r.headers.get('content-type') || '')) throw new Error('no picture'); // an error comes back as JSON
    return Buffer.from(await r.arrayBuffer());
  }
  const body = (await r.json())['subsonic-response'];
  if (!body) throw new Error('that does not look like a Subsonic / Navidrome server');
  if (body.status !== 'ok') {
    const code = body.error?.code;
    throw new Error(code === 40 || code === 41 ? 'wrong username or password' : body.error?.message || 'the server returned an error');
  }
  return body;
}

/** Check a server and login; returns what can be added. The password is only used here, to make the token. */
export async function subsonicDiscover(url, username, password, normalize) {
  const base = normalize(url);
  if (!base) throw new Error('enter the server address, for example 192.168.1.110:4534');
  if (!username || !password) throw new Error('enter your Navidrome username and password');
  const { salt, token } = makeAuth(password);
  const src = { url: base, user_id: String(username).trim(), salt, token };
  const ping = await call(src, 'ping.view');
  const folders = (await call(src, 'getMusicFolders.view')).musicFolders?.musicFolder || [];
  return {
    url: base, name: 'Navidrome', product: ping.type ? `${ping.type}` : 'Navidrome', version: ping.serverVersion || ping.version || '', userId: src.user_id, salt, token,
    views: [{ id: 'all', name: 'All music', type: 'radio' }, ...folders.map((f) => ({ id: String(f.id), name: f.name, type: 'radio' }))],
  };
}

export const streamUrl = (src, id) => `${src.url}/rest/stream.view?id=${enc(id)}&format=raw&estimateContentLength=true&${authQuery(src).replace('&f=json', '')}`;

// ---- synced / plain lyrics from the server (OpenSubsonic getLyricsBySongId) -----------------------------------------------------
const lyricMemo = new Map();
/** -> { synced: [{t, text}] } | { text } (plain, for the caller to page) | null */
export async function fetchLyrics(src, id) {
  const k = `${src.id}/${id}`;
  if (lyricMemo.has(k)) return lyricMemo.get(k);
  let out = null;
  try {
    const r = await call(src, 'getLyricsBySongId.view', `id=${enc(id)}`, { timeout: 8000 });
    const list = r.lyricsList?.structuredLyrics || [];
    const synced = list.find((l) => l.synced && l.line?.length);
    const plain = list.find((l) => !l.synced && l.line?.length);
    if (synced) out = { synced: synced.line.map((l) => ({ t: (Number(l.start) || 0) / 1000 - (Number(synced.offset) || 0) / 1000, text: String(l.value || '').replace(/\s+/g, ' ').trim().slice(0, 90) })).sort((a, b) => a.t - b.t) };
    else if (plain) out = { text: plain.line.map((l) => l.value).join('\n') };
  } catch { /* the server has no lyrics endpoint, or none for this song */ }
  if (lyricMemo.size > 300) lyricMemo.delete(lyricMemo.keys().next().value);
  lyricMemo.set(k, out);
  return out;
}

// ---- scanning -----------------------------------------------------------------------------------------------------------------
const covers = () => path.join(cfg.configDir, 'covers');
const coverFile = (srcId, art) => path.join(covers(), `ms_${srcId}_${crypto.createHash('md5').update(String(art)).digest('hex').slice(0, 16)}.jpg`);
const hash = (o) => parseInt(crypto.createHash('md5').update(JSON.stringify(o)).digest('hex').slice(0, 7), 16);

async function allSongs(src, view) {
  const folder = view && view !== 'all' ? `&musicFolderId=${enc(view)}` : '';
  const out = [];
  for (let off = 0; ; off += 500) {
    const r = await call(src, 'search3.view', `query=${enc('""')}&artistCount=0&albumCount=0&songCount=500&songOffset=${off}${folder}`, { timeout: 90000 });
    const page = r.searchResult3?.song || [];
    out.push(...page);
    if (page.length < 500) break;
  }
  if (out.length) return out;
  // a server that ignores the empty search: walk the albums instead (slower: one request per album)
  for (let off = 0; ; off += 500) {
    const r = await call(src, 'getAlbumList2.view', `type=alphabeticalByName&size=500&offset=${off}${folder}`, { timeout: 90000 });
    const albums = r.albumList2?.album || [];
    for (const a of albums) { const d = await call(src, 'getAlbum.view', `id=${enc(a.id)}`, { timeout: 30000 }); out.push(...(d.album?.song || [])); }
    if (albums.length < 500) break;
  }
  return out;
}

/** Scan a Navidrome library into radio tracks. Throws (leaving everything as it was) when the server cannot be read. */
export async function scanNavidrome(db, lib, src, view, progress, { safeRemovals }) {
  const songs = await allSongs(src, view); // read everything first: a server that is down must not look like an emptied library
  progress.files = songs.length;
  const existing = new Map(db.prepare('SELECT path,mtime,size FROM items WHERE library_id=?').all(lib.id).map((r) => [r.path, r]));
  const seen = new Set();
  const want = [];
  const art = (s) => (s.coverArt && fs.existsSync(coverFile(src.id, s.coverArt)) ? coverFile(src.id, s.coverArt) : null);
  const upsert = db.prepare(`INSERT INTO items
    (library_id,show_id,kind,path,title,plot,year,season,episode,aired,rating,mpaa,runtime,probed,studios,genres,actors,poster,mtime,size,nfo_mtime,artist,album)
    VALUES (?,NULL,'track',?,?,'',?,NULL,NULL,NULL,NULL,'',?,1,'[]',?,'[]',?,1,?,NULL,?,?)
    ON CONFLICT(path) DO UPDATE SET title=excluded.title,year=excluded.year,runtime=excluded.runtime,probed=1,genres=excluded.genres,poster=excluded.poster,
      mtime=1,size=excluded.size,artist=excluded.artist,album=excluded.album`);
  const setPoster = db.prepare('UPDATE items SET poster=? WHERE path=?');
  tx(db, () => {
    for (const s of songs) {
      const runtime = Number(s.duration) || 0;
      if (!s.id || runtime < 5) continue;
      const p = `ms://${src.id}/${s.id}`;
      seen.add(p);
      const genres = (s.genres?.length ? s.genres.map((g) => g.name) : String(s.genre || '').split(/[;/]/)).map((g) => String(g).trim()).filter(Boolean);
      const year = Number(s.year) >= 1900 && Number(s.year) <= 2100 ? Number(s.year) : null;
      const meta = [s.title, s.artist || s.displayArtist || '', s.album || '', year, genres, runtime, s.coverArt || ''];
      const sig = hash(meta);
      const picture = art(s);
      if (s.coverArt && !picture) want.push(s.coverArt);
      const ex = existing.get(p);
      if (ex && ex.size === sig) { if (picture) setPoster.run(picture, p); continue; }
      progress.changed++;
      upsert.run(lib.id, p, s.title || path.parse(String(s.path || s.id)).name, year, runtime, JSON.stringify(genres), picture, sig, s.artist || s.displayArtist || '', s.album || '');
    }
  });
  const gone = safeRemovals(db, lib, [...existing.keys()].filter((p) => !seen.has(p)), existing.size, seen.size, []);
  if (gone.length) { const del = db.prepare('DELETE FROM items WHERE path=?'); tx(db, () => { for (const p of gone) del.run(p); }); progress.removed = (progress.removed || 0) + gone.length; }
  db.prepare('UPDATE libraries SET last_scan=? WHERE id=?').run(Date.now(), lib.id);
  await fetchCovers(db, src, lib, songs, [...new Set(want)].slice(0, 300));
}

/** One picture per album, downloaded once (a few hundred per scan) and shared by all of its tracks. */
async function fetchCovers(db, src, lib, songs, ids) {
  if (!ids.length) return;
  fs.mkdirSync(covers(), { recursive: true });
  const pathsFor = new Map(), wanted = new Set(ids); // a Set: a big library has 100,000 songs to check against a few hundred pictures
  for (const s of songs) if (s.coverArt && wanted.has(s.coverArt)) (pathsFor.get(s.coverArt) || pathsFor.set(s.coverArt, []).get(s.coverArt)).push(`ms://${src.id}/${s.id}`);
  const set = db.prepare('UPDATE items SET poster=? WHERE path=? AND library_id=?');
  let i = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (i < ids.length) {
      const id = ids[i++];
      try {
        const buf = await call(src, 'getCoverArt.view', `id=${enc(id)}&size=600`, { binary: true, timeout: 20000 });
        if (!buf.length) continue;
        const f = coverFile(src.id, id);
        fs.writeFileSync(f, buf);
        tx(db, () => { for (const p of pathsFor.get(id) || []) set.run(f, p, lib.id); });
      } catch { /* no picture for this album; try again on a later scan */ }
    }
  }));
}
