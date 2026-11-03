// Audio-language and subtitle choice for TV and movies.
//  - the audio track in the preferred language is used when the file has one (not just "the first track")
//  - when the file has no audio in that language (a Japanese show, a foreign film), preferred-language subtitles are burned into the picture
//    (a live stream has no subtitle menu); a "forced" subtitle track (foreign dialogue inside an English film) is burned in too
// Subtitles come from a file beside the video (Movie.en.srt) or from a text track inside it. Embedded tracks are extracted once to the
// config folder in the background (reading a big file over a network share can take a while), so the first airing may be without them.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { cfg } from './config.js';
import { run } from './media.js';
import { fontFamily } from './lyrics.js';

const LANGS = {
  eng: ['en', 'eng', 'english'], fre: ['fr', 'fre', 'fra', 'french'], ger: ['de', 'ger', 'deu', 'german'], spa: ['es', 'spa', 'spanish'],
  ita: ['it', 'ita', 'italian'], jpn: ['ja', 'jpn', 'japanese'], kor: ['ko', 'kor', 'korean'], chi: ['zh', 'chi', 'zho', 'chinese'],
  rus: ['ru', 'rus', 'russian'], por: ['pt', 'por', 'portuguese'], dut: ['nl', 'dut', 'nld', 'dutch'], swe: ['sv', 'swe', 'swedish'],
  nor: ['no', 'nor', 'nob', 'norwegian'], dan: ['da', 'dan', 'danish'], fin: ['fi', 'fin', 'finnish'], pol: ['pl', 'pol', 'polish'],
  tur: ['tr', 'tur', 'turkish'], hin: ['hi', 'hin', 'hindi'], ara: ['ar', 'ara', 'arabic'], wel: ['cy', 'wel', 'cym', 'welsh'],
};
const BY_CODE = new Map();
for (const [canon, codes] of Object.entries(LANGS)) for (const c of codes) BY_CODE.set(c, canon);
export const LANGUAGE_CHOICES = [['eng', 'English'], ['fre', 'French'], ['ger', 'German'], ['spa', 'Spanish'], ['ita', 'Italian'], ['jpn', 'Japanese'], ['kor', 'Korean'], ['chi', 'Chinese'], ['rus', 'Russian'], ['por', 'Portuguese'], ['dut', 'Dutch'], ['wel', 'Welsh']];

/** "en" / "eng" / "English" -> "eng"; unknown or undetermined -> "" */
export function normLang(x) {
  const s = String(x || '').toLowerCase().trim().split(/[-_]/)[0];
  if (!s || s === 'und' || s === 'unk' || s === 'mis') return '';
  return BY_CODE.get(s) || s;
}

const TEXT_SUBS = new Set(['subrip', 'srt', 'ass', 'ssa', 'mov_text', 'webvtt', 'text']);
const SKIP_TITLE = /commentary|director|description|audio desc/i;

/**
 * Which audio track, and which subtitle track (if any) to burn in.
 * info: { audio: [{lang,title,default}], subs: [{lang,title,codec,forced}] }; prefs: { language, subtitleMode: off | foreign | always }
 * -> { audio: 0-based index among audio streams, sub: 0-based index among subtitle streams | null, pref: 'eng' }
 */
export function choose(info, prefs) {
  const pref = normLang(prefs.language) || 'eng';
  const audio = info?.audio || [], subs = info?.subs || [];
  let ai = audio.findIndex((a) => normLang(a.lang) === pref && !SKIP_TITLE.test(a.title || ''));
  if (ai < 0) ai = audio.findIndex((a) => normLang(a.lang) === pref);
  const matched = ai >= 0;
  if (ai < 0) ai = 0;
  const alang = normLang(audio[ai]?.lang);
  const spoken = matched || !alang; // an untagged track is assumed to be fine rather than burning subtitles over it
  let sub = null;
  const mode = prefs.subtitleMode || 'foreign';
  if (mode !== 'off') {
    const ok = (s) => TEXT_SUBS.has(String(s.codec || '').toLowerCase()) && normLang(s.lang) === pref && !SKIP_TITLE.test(s.title || '');
    const full = subs.findIndex((s) => ok(s) && !s.forced && !/sdh|hearing|\bcc\b/i.test(s.title || ''));
    const any = full >= 0 ? full : subs.findIndex((s) => ok(s) && !s.forced);
    const forced = subs.findIndex((s) => ok(s) && s.forced);
    if (mode === 'always') sub = any >= 0 ? any : forced >= 0 ? forced : null;
    else sub = !spoken ? (any >= 0 ? any : forced >= 0 ? forced : null) : (forced >= 0 ? forced : null);
  }
  return { audio: ai, sub: sub === -1 ? null : sub, pref, spoken };
}

// ---- subtitle files ---------------------------------------------------------------------------------------------------------
const dir = () => path.join(cfg.configDir, 'subs');
const key = (s) => crypto.createHash('md5').update(s).digest('hex');
const pending = new Map(); // cache file -> promise (one extraction at a time, never twice for the same file)
let running = 0;

function sidecar(file, pref) {
  try {
    const d = path.dirname(file), base = path.parse(file).name.toLowerCase();
    const names = fs.readdirSync(d);
    const codes = new Set(LANGS[pref] || [pref]);
    const cands = names.filter((n) => /\.(srt|ass|ssa|vtt)$/i.test(n) && n.toLowerCase().startsWith(base)).map((n) => {
      const mid = n.slice(base.length, n.length - path.extname(n).length).toLowerCase().split('.').filter(Boolean);
      return { n, tags: mid };
    });
    const hit = cands.find((c) => c.tags.some((t) => codes.has(t)) && !c.tags.includes('forced') && !c.tags.includes('sdh'))
      || cands.find((c) => c.tags.some((t) => codes.has(t)))
      || cands.find((c) => !c.tags.length); // Movie.srt: the file's own subtitles, taken to be in the preferred language
    return hit ? path.join(d, hit.n) : null;
  } catch { return null; }
}

function convert(args, out) {
  if (pending.has(out)) return null;
  if (running >= 1) return null; // one at a time: reading a whole video file is the expensive part
  running++;
  fs.mkdirSync(dir(), { recursive: true });
  const tmp = `${out}.part.ass`;
  const p = run(cfg.ffmpeg, ['-nostdin', '-v', 'error', '-y', ...args, tmp], { timeout: 15 * 60 * 1000 })
    .then((r) => { try { if (r.code === 0 && fs.existsSync(tmp)) fs.renameSync(tmp, out); else fs.rmSync(tmp, { force: true }); } catch { /* ignore */ } })
    .finally(() => { running--; pending.delete(out); });
  pending.set(out, p);
  return p;
}

/**
 * The ASS file to burn in for this choice, or null when it is not ready yet (an extraction is started and later airings use it).
 * Always a file inside the config folder with a plain name, so nothing in a media path can break a filter string.
 */
export function subtitleFile(file, size, choice, info) {
  try {
    const side = sidecar(file, choice.pref);
    if (side) {
      const out = path.join(dir(), `${key(`${side}|${fs.statSync(side).mtimeMs}`)}.ass`);
      if (fs.existsSync(out)) return out;
      convert(['-i', side], out);
      return null;
    }
    if (choice.sub == null) return null;
    const out = path.join(dir(), `${key(`${file}|${size}|${choice.sub}`)}.ass`);
    if (fs.existsSync(out)) return out;
    convert(['-i', file, '-map', `0:s:${choice.sub}`, '-c:s', 'ass'], out);
    return null;
  } catch { return null; }
}

/** What to do for a piece of content: { audio, subs: path | null }. Never waits for an extraction. */
export function select(file, info, prefs) {
  if (!info || (!info.audio?.length && !info.subs?.length)) return { audio: 0, subs: null };
  const c = choose(info, prefs);
  let subs = null;
  const wanted = (prefs.subtitleMode || 'foreign') !== 'off' && (c.sub != null || !c.spoken || prefs.subtitleMode === 'always');
  if (wanted) subs = subtitleFile(file, info.size || 0, c, info);
  return { audio: c.audio, subs };
}

/** The filter that draws the subtitles. The video was cut with -ss, so its timestamps are shifted to match the subtitle file and back. */
export function subtitleFilter(assFile, offset) {
  const f = String(assFile).split(path.sep).join('/');
  const font = path.dirname(cfg.fontFile).split(path.sep).join('/');
  const style = `FontName=${fontFamily(cfg.fontFile)},FontSize=15,Outline=1.6,Shadow=0.8,MarginV=24,Bold=1`;
  const shift = Math.max(0, offset || 0);
  const pre = shift > 0.05 ? `setpts=PTS+${shift.toFixed(3)}/TB,` : '';
  const post = shift > 0.05 ? `,setpts=PTS-${shift.toFixed(3)}/TB` : '';
  return `${pre}subtitles=filename=${f}:fontsdir=${font}:force_style='${style}'${post}`;
}
