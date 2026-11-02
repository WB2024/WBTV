import fs from 'node:fs';
import { cfg } from './config.js';
import { run } from './media.js';

/**
 * Live sources: M3U/M3U8 channel lists (IPTV), single HLS streams and YouTube live links.
 * Each stream becomes a "live" channel with no schedule - you simply join it.
 */

export const isUrl = (s) => /^https?:\/\//i.test(String(s || '').trim());
export const isYoutube = (u) => /^https?:\/\/(www\.|m\.)?(youtube\.com|youtu\.be)\//i.test(String(u || ''));

/** 'list' = a channel list (#EXTINF entries); 'stream' = a single HLS stream playlist. */
export function classifyPlaylist(text) {
  if (/#EXT-X-(TARGETDURATION|STREAM-INF|MEDIA-SEQUENCE)/.test(text)) return 'stream';
  return 'list';
}

/** Parse an extended M3U channel list. */
export function parseM3u(text) {
  const out = [];
  let cur = null;
  for (const raw of String(text).replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF')) {
      const attrs = {};
      for (const m of line.matchAll(/([\w-]+)="([^"]*)"/g)) attrs[m[1].toLowerCase()] = m[2];
      const rest = line.replace(/([\w-]+)="[^"]*"/g, '');
      const comma = rest.indexOf(',');
      const name = (comma >= 0 ? rest.slice(comma + 1) : '').trim() || attrs['tvg-name'] || '';
      cur = { name, group: attrs['group-title'] || '', logo: attrs['tvg-logo'] || '', tvgId: attrs['tvg-id'] || '' };
    } else if (line.startsWith('#')) {
      continue; // #EXTVLCOPT, #EXTGRP, comments...
    } else if (cur && /^(https?|rtmp|rtsp|udp|rtp):/i.test(line)) {
      out.push({ ...cur, url: line });
      cur = null;
    }
  }
  return out;
}

async function readSource(src) {
  if (isUrl(src)) {
    const r = await fetch(src, { signal: AbortSignal.timeout(45000), headers: { 'User-Agent': 'WBTV/1.0' } });
    if (!r.ok) throw new Error(`HTTP ${r.status} fetching playlist`);
    return await r.text();
  }
  return fs.readFileSync(src, 'utf8');
}

/** Fetch/parse the library's source and mirror it into live_streams. */
export async function syncIptvLibrary(db, lib, progress) {
  let entries;
  if (isYoutube(lib.path)) {
    entries = [{ name: lib.name, url: lib.path, group: 'YouTube', logo: '', tvgId: '', kind: 'youtube' }];
  } else {
    const text = await readSource(lib.path);
    if (isUrl(lib.path) && classifyPlaylist(text) === 'stream') entries = [{ name: lib.name, url: lib.path, group: '', logo: '', tvgId: '', kind: 'hls' }];
    else entries = parseM3u(text).map((e) => ({ ...e, kind: isYoutube(e.url) ? 'youtube' : 'hls' }));
  }
  if (!entries.length) throw new Error('no channels found in that playlist');
  if (progress) progress.files = entries.length;

  const have = new Map(db.prepare('SELECT id,url FROM live_streams WHERE library_id=?').all(lib.id).map((r) => [r.url, r.id]));
  const ins = db.prepare('INSERT INTO live_streams(library_id,name,url,grp,logo,tvg_id,src_kind) VALUES(?,?,?,?,?,?,?)');
  const upd = db.prepare('UPDATE live_streams SET name=?,grp=?,logo=?,tvg_id=? WHERE id=?');
  const seen = new Set();
  db.exec('BEGIN');
  try {
    for (const e of entries) {
      if (seen.has(e.url)) continue;
      seen.add(e.url);
      const id = have.get(e.url);
      if (id) upd.run(e.name || 'Channel', e.group, e.logo, e.tvgId, id);
      else { ins.run(lib.id, e.name || 'Channel', e.url, e.group, e.logo, e.tvgId, e.kind); if (progress) progress.changed++; }
    }
    for (const [url, id] of have) if (!seen.has(url)) db.prepare('DELETE FROM live_streams WHERE id=?').run(id);
    db.prepare('UPDATE libraries SET last_scan=? WHERE id=?').run(Date.now(), lib.id);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

/**
 * yt-dlp turns a YouTube live URL into playable HLS URLs. YouTube serves live video and audio as SEPARATE streams
 * (there is no combined "best" format), so this returns one URL (combined) or two (video, then audio).
 */
export async function resolveYoutube(url) {
  const r = await run(cfg.ytdlp, ['-g', '--no-warnings', '--no-playlist', '--js-runtimes', 'node', '-f', 'bv*[height<=720]+ba/b[height<=720]/b', url], { timeout: 45000 });
  const urls = r.out.split('\n').map((s) => s.trim()).filter((s) => isUrl(s)).slice(0, 2);
  return r.code === 0 && urls.length ? urls : null;
}

const openCache = new Map(); // url -> { at, val }
const FAIL_TTL = 10 * 1000;
const OPEN_TTL = 20 * 60 * 1000; // resolved YouTube links last hours; a short cache makes re-tuning instant
/** A run of this stream failed: do not trust the cached link, but also do not re-resolve it more than once every few seconds. */
export const forgetLive = (url) => openCache.set(url, { at: Date.now(), val: null });

/**
 * Everything needed to play a live stream right now: the playable URL(s) and what they contain.
 * Cached briefly so tuning in again (or the health check followed by tuning in) does not repeat the slow work.
 */
export async function openLive(st, timeoutMs = 20000) {
  const hit = openCache.get(st.url);
  // a failure is remembered briefly too, so a viewer sitting on a dead stream does not make us hammer YouTube / the source every few seconds
  if (hit && Date.now() - hit.at < (hit.val ? OPEN_TTL : FAIL_TTL)) return hit.val;
  const urls = st.src_kind === 'youtube' ? await resolveYoutube(st.url) : [st.url];
  let val = null;
  if (urls) {
    const info = await probeLive(urls[0], timeoutMs);
    if (info) val = { urls, info: urls.length > 1 ? { hasVideo: info.hasVideo, hasAudio: true } : info };
  }
  openCache.set(st.url, { at: Date.now(), val });
  if (openCache.size > 500) openCache.delete(openCache.keys().next().value);
  return val;
}

/** Is the stream actually delivering video or audio right now? */
export async function probeLive(url, timeoutMs = 20000) {
  const args = ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0'];
  if (isUrl(url)) args.unshift('-rw_timeout', '10000000');
  const r = await run(cfg.ffprobe, [...args, url], { timeout: timeoutMs });
  if (r.code !== 0) return null;
  const types = r.out.split('\n').map((s) => s.trim());
  const hasVideo = types.includes('video'), hasAudio = types.includes('audio');
  return hasVideo || hasAudio ? { hasVideo, hasAudio } : null;
}

/** Background health check so dead streams don't clutter the guide. */
export async function checkStreams(db, libraryId = null, onProgress) {
  const rows = db.prepare(`SELECT id,url,src_kind FROM live_streams WHERE alive IS NULL ${libraryId ? 'AND library_id=' + Number(libraryId) : ''}`).all();
  let i = 0, done = 0;
  const upd = db.prepare('UPDATE live_streams SET alive=?, checked=? WHERE id=?');
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (i < rows.length) {
      const r = rows[i++];
      const ok = await openLive(r, 20000);
      upd.run(ok ? 1 : 0, Date.now(), r.id);
      onProgress?.(++done, rows.length);
    }
  }));
  return rows.length;
}
