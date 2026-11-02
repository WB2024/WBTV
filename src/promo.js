/**
 * "Coming up next on ..." continuity announcements: the script.
 * Pure functions (no I/O) so they can be tested. The text is written when the schedule is planned,
 * from whatever we know about the upcoming programmes, with generic fallbacks when metadata is missing.
 */

import { speakable } from './speech.js';

// Piper (our voices) speaks about 2.07 (Alan) to 2.32 (Jenny) words/second including pauses; stay conservative so the
// slot is always long enough for the speech.
export const WORDS_PER_SECOND = 1.95;
export const LEAD_IN = 0.8;     // silence before the voice starts
export const SEG_GAP = 0.5;     // pause between announcements
export const TAIL = 1.0;        // pause after the last one
export const MIN_SECONDS = 12;

const pickOne = (a) => a[Math.floor(Math.random() * a.length)];
// counted as spoken ("1999" is three words), so the announcement slot is long enough for the real speech
const words = (s) => { const t = speakable(s).trim(); return t ? t.split(/\s+/).length : 0; };

export function cleanText(s) {
  return String(s || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, 'and').replace(/&/g, ' and ')
    .replace(/\[[^\]]*\]/g, ' ')          // [2021] etc
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[“”]/g, '"').replace(/[‘’]/g, "'")
    .replace(/[_*#^~|\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const ABBREV = /\b(Mr|Mrs|Ms|Dr|Jr|Sr|St|Mt|Prof|Capt|Lt|Sgt|vs|etc|No|approx)\./g;
const DANGLING = /[\s,;:–-]+(and|or|but|the|a|an|of|to|with|while|as|in|on|at|for|who|that|which|his|her|their)\.?$/i;
const DOT = '@@DOT@@'; // stands in for the full stop of an abbreviation while we split sentences

/** Take whole sentences up to maxChars (never cut mid-sentence unless even the first is too long). */
export function trimPlot(plot, maxChars) {
  const text = cleanText(plot).replace(/\.{2,}|…/g, '.');
  if (!text || maxChars <= 0) return '';
  // keep "Mr.", "Jr.", initials like "J. R." etc. from being mistaken for the end of a sentence
  const safe = text.replace(ABBREV, '$1' + DOT).replace(/\b([A-Z])\.(?=\s[A-Z])/g, '$1' + DOT);
  const sentences = (safe.match(/[^.!?]+[.!?]+["')\]]*|[^.!?]+$/g) || [safe]).map((x) => x.split(DOT).join('.').trim());
  const tidy = (x) => {
    let y = x;
    while (DANGLING.test(y)) y = y.replace(DANGLING, '');
    return /[.!?]$/.test(y) ? y : y + '.';
  };
  let out = '';
  for (const sent of sentences) {
    const next = (out ? out + ' ' : '') + sent;
    if (next.length > maxChars) break;
    out = next;
  }
  if (!out) {
    // the first sentence alone is too long: cut at a word boundary
    const cut = sentences[0].slice(0, maxChars).replace(/\s+\S*$/, '').replace(/[,;:\-–]+$/, '');
    return cut.length > 20 ? tidy(cut) : '';
  }
  return tidy(out);
}

const GENERIC_EPISODE = /^(episode|ep\.?|part|chapter)\s*\d+$|^s\d+e\d+$/i;

/** What an announcer would call this programme. */
export function spokenTitle(item) {
  const raw = item.kind === 'movie' ? item.title : (item.show_title || item.title);
  return cleanText(raw).replace(/\s*\(\d{4}\)\s*$/, '').replace(/\s*\{[^}]*\}/g, '').trim() || 'the next programme';
}

/** The "what's it about" part, with fallbacks for missing descriptions. */
export function describe(item, maxChars, readPlots = true) {
  const plot = readPlots ? trimPlot(item.plot || (item.kind !== 'movie' ? item.show_plot : ''), maxChars) : '';
  if (plot) return plot;
  const genres = (() => { try { return JSON.parse(item.genres || '[]'); } catch { return []; } })();
  if (item.kind === 'movie') {
    const g = genres[0] ? genres[0].toLowerCase() : '';
    return `A${/^[aeiou]/.test(g) ? 'n' : ''} ${g ? g + ' ' : ''}film${item.year ? ' from ' + item.year : ''}.`;
  }
  const ep = cleanText(item.title);
  if (item.show_title && ep && !GENERIC_EPISODE.test(ep) && ep.toLowerCase() !== item.show_title.toLowerCase()) return `This episode is called ${ep}.`;
  if (item.season != null && item.episode != null && item.season > 0) return `Season ${item.season}, episode ${item.episode}.`;
  return '';
}

const INTRO = [
  (ch, t) => `Up next on ${ch} is ${t}.`,
  (ch, t) => `Coming up next on ${ch}, it's ${t}.`,
  (ch, t) => `Next on ${ch}, ${t}.`,
];
const THEN = [
  (t) => `After that, ${t}.`,
  (t) => `After that is ${t}.`,
  (t) => `Then, it's ${t}.`,
];
const LATER = [
  (ch, t) => `Later on ${ch}, ${t}.`,
  (ch, t) => `And later, ${t}.`,
  (ch, t) => `Also coming up, ${t}.`,
];
const LABELS = ['UP NEXT', 'AFTER THAT', 'LATER', 'LATER'];
const PLOT_CHARS = [280, 150, 0, 0];

export function estimateSeconds(segments, wps = WORDS_PER_SECOND) {
  const w = segments.reduce((n, s) => n + words(s.text), 0);
  return LEAD_IN + w / wps + SEG_GAP * Math.max(0, segments.length - 1) + TAIL;
}

/**
 * Write the announcement for [items...] (first = the very next programme) so it fits in `maxSeconds`.
 * Degrades gracefully: shorter descriptions first, then fewer programmes. Returns null if nothing fits.
 */
export function buildPromo(channelName, items, maxSeconds, { count = 3, readPlots = true, wps = WORDS_PER_SECOND } = {}) {
  const ch = cleanText(channelName) || 'this channel';
  const pool = items.slice(0, Math.max(1, count));
  const intro = pickOne(INTRO), then = pickOne(THEN), later = pickOne(LATER);
  for (let n = pool.length; n >= 1; n--) {
    for (const scale of [1, 0.7, 0.45, 0]) {
      const segments = pool.slice(0, n).map((item, i) => {
        const title = spokenTitle(item);
        const lead = i === 0 ? intro(ch, title) : i === 1 ? then(title) : later(ch, title);
        const desc = describe(item, Math.round(PLOT_CHARS[Math.min(i, 3)] * scale), readPlots && scale > 0);
        return { label: LABELS[Math.min(i, 3)], title, text: desc ? `${lead} ${desc}` : lead, item: item.id };
      });
      const est = estimateSeconds(segments, wps);
      if (est <= maxSeconds) return { segments, est, dur: Math.max(MIN_SECONDS, Math.ceil(est)) };
    }
  }
  return null;
}
