// Lyrics for radio tracks: a sidecar file next to the audio (.lrc synced, .srt, .txt/.lyrics plain) or lyrics held in the file's own tags.
// They are drawn onto the audio picture as subtitles (libass), under the cover art and above the waveform.
import fs from 'node:fs';
import path from 'node:path';
import { cfg } from './config.js';
import { run } from './media.js';

const SIDECAR = ['.lrc', '.srt', '.txt', '.lyrics'];
const MAX_LINE = 90;

export function decode(buf) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^﻿/, ''); } catch { return new TextDecoder('windows-1252').decode(buf); }
}

const clean = (s) => String(s).replace(/<\d+:\d+(?:[.:]\d+)?>/g, '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_LINE);
const stamp = (m, s, f) => Number(m) * 60 + Number(s) + (f ? Number(`0.${f}`) : 0);

/** [mm:ss.xx]text (several stamps per line allowed, [offset:+ms] honoured) -> sorted [{ t, text }] */
export function parseLrc(text) {
  const lines = [];
  let offset = 0;
  for (const raw of String(text).split(/\r?\n/)) {
    const o = /^\s*\[offset:\s*([+-]?\d+)\s*\]/i.exec(raw);
    if (o) { offset = Number(o[1]) / 1000; continue; }
    const stamps = [];
    let rest = raw;
    for (let m; (m = /^\s*\[(\d+):(\d{1,2})(?:[.:](\d{1,3}))?\]/.exec(rest)); ) { stamps.push(stamp(m[1], m[2], m[3])); rest = rest.slice(m[0].length); }
    if (!stamps.length) continue;
    for (const t of stamps) lines.push({ t: Math.max(0, t - offset), text: clean(rest) });
  }
  return lines.sort((a, b) => a.t - b.t);
}

/** SubRip -> [{ t, end, text }] */
export function parseSrt(text) {
  const out = [];
  for (const block of String(text).split(/\r?\n\r?\n+/)) {
    const m = /(\d+):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d+):(\d{2}):(\d{2})[,.](\d{1,3})\s*\r?\n([\s\S]*)/.exec(block);
    if (!m) continue;
    out.push({ t: Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(`0.${m[4]}`), end: Number(m[5]) * 3600 + Number(m[6]) * 60 + Number(m[7]) + Number(`0.${m[8]}`), text: clean(m[9]) });
  }
  return out.sort((a, b) => a.t - b.t);
}

/** Unsynced text -> pages of up to 5 lines (stanzas; long stanzas are split). */
export function parsePlain(text) {
  const pages = [];
  for (const stanza of String(text).split(/\r?\n\s*\r?\n/)) {
    const lines = stanza.split(/\r?\n/).map((l) => l.replace(/^\s*\[[^\]]*\]\s*$/, '').trim()).filter(Boolean).map((l) => l.slice(0, MAX_LINE));
    for (let i = 0; i < lines.length; i += 5) pages.push(lines.slice(i, i + 5));
  }
  return pages;
}

/** Any lyric text -> { synced: [{t,end?,text}] } | { pages: [[line]] } | null */
export function parseLyrics(text, hint = '') {
  const t = String(text || '').trim();
  if (!t) return null;
  const stamped = (t.match(/^\s*\[\d+:\d{1,2}(?:[.:]\d{1,3})?\]/gm) || []).length;
  if (hint === '.srt' || /-->/.test(t)) { const s = parseSrt(t); if (s.length >= 2) return { synced: s }; }
  if (hint === '.lrc' || stamped >= 3) { const s = parseLrc(t); if (s.length >= 2) return { synced: s }; }
  const pages = parsePlain(t.replace(/^\s*\[\d+:\d{1,2}(?:[.:]\d{1,3})?\]/gm, ''));
  return pages.length ? { pages } : null;
}

const memo = new Map(); // file -> parsed lyrics or null (kept briefly: a track is planned several times)
const TAG_KEYS = ['lyrics', 'unsyncedlyrics', 'syncedlyrics', 'unsynced lyrics', 'lyrics-eng'];

/** Look beside the audio file, then in its tags. Never throws. */
export async function findLyrics(file, { tags = true } = {}) {
  if (memo.has(file)) return memo.get(file);
  let found = null;
  try {
    const dir = path.dirname(file), base = path.parse(file).name.toLowerCase();
    const names = fs.readdirSync(dir);
    for (const ext of SIDECAR) {
      const hit = names.find((n) => n.toLowerCase() === base + ext);
      if (!hit) continue;
      const full = path.join(dir, hit);
      if (fs.statSync(full).size > 200_000) continue;
      found = parseLyrics(decode(fs.readFileSync(full)), ext);
      if (found) break;
    }
    if (!found && tags) {
      const r = await run(cfg.ffprobe, ['-v', 'error', '-show_entries', 'format_tags', '-of', 'json', file], { timeout: 15000 });
      if (r.code === 0) {
        const tg = {};
        for (const [k, v] of Object.entries(JSON.parse(r.out).format?.tags || {})) tg[k.toLowerCase()] = String(v);
        const key = Object.keys(tg).find((k) => TAG_KEYS.includes(k) || k.startsWith('lyrics'));
        if (key) found = parseLyrics(tg[key]);
      }
    }
  } catch { found = null; }
  if (memo.size > 300) memo.delete(memo.keys().next().value);
  memo.set(file, found);
  return found;
}

const hms = (s) => {
  const t = Math.max(0, s), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
  return `${h}:${String(m).padStart(2, '0')}:${sec.toFixed(2).padStart(5, '0')}`;
};
const esc = (s) => String(s).replace(/\\/g, '＼').replace(/[{}]/g, '').replace(/\r?\n/g, '\\N');

/** Family name libass should ask for, derived from the font file configured for captions. */
export function fontFamily(file) {
  const b = path.basename(file).toLowerCase();
  if (b.includes('dejavu')) return 'DejaVu Sans';
  if (b.startsWith('arial')) return 'Arial';
  return path.parse(file).name.replace(/[-_](bold|regular|bd)$/i, '');
}

/**
 * An ASS script for the stretch of the track being played: `offset` seconds into a track of `total` seconds, for `dur` seconds.
 * Event times are relative to the start of what is encoded. Layout: x from `tx`, between y=0.50H and the waveform.
 */
export function buildAss(lyr, { offset, dur, total, W, H, tx, font }) {
  const big = Math.round(H * 0.05), small = Math.round(H * 0.036), page = Math.round(H * 0.042);
  const y0 = Math.round(H * 0.5), y1 = Math.round(H * 0.5 + big * 2.35);
  const style = (n, size, col, bold) => `Style: ${n},${font},${size},${col},&H000000FF,&H00000000,&H64000000,${bold},0,0,0,100,100,0,0,1,2,1,7,${tx},${Math.round(W * 0.04)},0,1`;
  const head = `[Script Info]\nScriptType: v4.00+\nPlayResX: ${W}\nPlayResY: ${H}\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\n` +
    'Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding\n' +
    `${style('Cur', big, '&H00FFFFFF', 1)}\n${style('Nxt', small, '&H00D8B4AA', 0)}\n${style('Page', page, '&H00FFFFFF', 0)}\n\n[Events]\nFormat: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text\n`;
  const ev = [];
  const add = (a, b, st, y, text) => {
    const s = Math.max(0, a - offset), e = Math.min(dur, b - offset);
    if (e - s < 0.05 || !text) return;
    ev.push(`Dialogue: 0,${hms(s)},${hms(e)},${st},,0,0,0,,{\\an7\\pos(${tx},${y})\\fad(200,150)}${esc(text)}`);
  };
  if (lyr.synced) {
    const L = lyr.synced;
    L.forEach((l, i) => {
      const end = l.end ?? (L[i + 1] ? L[i + 1].t : l.t + 6);
      const stop = Math.min(end, l.t + 12); // a long instrumental gap clears the screen rather than leaving a stale line
      add(l.t, stop, 'Cur', y0, l.text);
      const nx = L.slice(i + 1).find((x) => x.text);
      if (nx && l.text && !l.end) add(l.t, stop, 'Nxt', y1, nx.text);
    });
  } else if (lyr.pages?.length) {
    // unsynced: the pages are spread over the song by length (an estimate; time-stamped .lrc files are exact)
    const weights = lyr.pages.map((p) => p.join(' ').length + 20), sum = weights.reduce((a, b) => a + b, 0);
    const from = Math.min(6, total * 0.05), span = Math.max(10, total - from - Math.min(10, total * 0.08));
    let t = from;
    lyr.pages.forEach((p, i) => { const d = (weights[i] / sum) * span; add(t, t + d, 'Page', y0, p.join('\n')); t += d; });
  }
  return head + ev.join('\n') + '\n';
}
