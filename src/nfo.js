import { XMLParser } from 'fast-xml-parser';

const ARRAYS = new Set(['studio', 'genre', 'actor', 'tag', 'video', 'audio', 'rating', 'thumb']);
const parser = new XMLParser({
  ignoreAttributes: true, parseTagValue: false, trimValues: true,
  isArray: (name) => ARRAYS.has(name),
});
const arr = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const str = (v) => (v == null ? '' : typeof v === 'object' ? str(v['#text']) : String(v).trim());
const num = (v) => { const n = parseFloat(str(v)); return Number.isFinite(n) ? n : null; };
const list = (v) => [...new Set(arr(v).map(str).filter(Boolean))];

/** Parse a Kodi/Jellyfin/Emby style .nfo. Returns null if unparseable. */
export function parseNfo(text) {
  try {
    const doc = parser.parse(text.replace(/^﻿/, ''));
    const kind = Object.keys(doc).find((k) => k !== '?xml');
    if (!kind) return null;
    const n = doc[kind] || {};
    const vid = arr(n.fileinfo?.streamdetails?.video)[0];
    let rating = num(n.rating);
    if (rating == null) rating = num(arr(n.ratings?.rating)[0]?.value);
    const runtimeMin = num(n.runtime);
    const dateYear = parseInt(str(n.premiered || n.aired || n.releasedate).slice(0, 4), 10);
    return {
      kind,
      title: str(n.title) || str(n.originaltitle),
      plot: str(n.plot) || str(n.outline),
      year: num(n.year) ?? (Number.isFinite(dateYear) ? dateYear : null),
      aired: str(n.aired || n.premiered),
      season: num(n.season),
      episode: num(n.episode),
      showtitle: str(n.showtitle),
      rating,
      mpaa: str(n.mpaa || n.certification),
      studios: list(n.studio),
      genres: list(n.genre),
      actors: arr(n.actor).map((a) => ({ name: str(a?.name), role: str(a?.role) })).filter((a) => a.name).slice(0, 15),
      durationSec: num(vid?.durationinseconds),
      runtimeSec: runtimeMin ? runtimeMin * 60 : null,
    };
  } catch {
    return null;
  }
}
