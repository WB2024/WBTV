// Music-video housekeeping shared by the audit / repair / download commands: turning messy file names into "Artist - Title", deciding whether a
// year in a file is a release year or just a download / upload date, and finding the real year and genre in your own music library.
// Convention (works with WBTV, Jellyfin and Kodi):   <Music Videos>/<Artist>/<Artist> - <Title>.<ext>  +  .nfo  +  -poster.jpg beside it.

const NOW_YEAR = new Date().getFullYear();

/** "Morrissey feat. Pamela Anderson", "MORRISSEY", "Joy Division" -> a comparison key */
export const norm = (s) => String(s || '').toLowerCase()
  .replace(/\(.*?\)|\[.*?\]|\{.*?\}/g, ' ')
  .replace(/\b(official( music)? video|official audio|lyric video|hd|hq|4k|remaster(ed)?|digital|video|feat\.?|ft\.?|featuring)\b/g, ' ')
  .replace(/\b(19|20)\d{2}\b/g, ' ')
  .replace(/[^a-z0-9]+/g, ' ').trim();

const NOISE = [
  /\s*[-–—]\s*youtube(\.flv)?\s*$/i, /\.flv\s*$/i,
  /\s*[([{]\s*(official\s+)?(hd\s+)?(music\s+)?video(\s+hd)?\s*[)\]}]/gi, /\s*[([{]\s*official\s+(hd\s+)?audio\s*[)\]}]/gi, /\s*[([{]\s*(official\s+)?lyrics?(\s+video)?\s*[)\]}]/gi,
  /\s*[([{]\s*(hd|hq|4k|1080p|720p|full hd|60fps)(\s+(upgrade|upscale|remaster(ed)?))?\s*[)\]}]/gi, /\s*[([{]\s*(digital )?remaster(ed)?( version)?( \d{4})?\s*[)\]}]/gi,
  /\s*[([{][^)\]}]*\b(ntsc|pal|lpcm|ac3|dvd|vob|upscale|upgrade|1080p|720p|4k)\b[^)\]}]*[)\]}]/gi, // release-group / encoding tags
  /[.\s]+official(\s+music)?\s+video\.?\s*$/i, /\s*[-–—]\s*clip\s+official\b.*$/i, /\s*[-–—]\s*official(\s+music)?\s+video\s*$/i,
];
const titleCase = (s) => s.toLowerCase().replace(/(^|[\s(\[/-])([a-z])/g, (m, a, b) => a + b.toUpperCase()).replace(/\b(Of|The|And|A|An|In|On|To|For|At|By)\b(?!$)/g, (w, x, i) => (i === 0 ? w : w.toLowerCase()));
const shout = (s) => /[A-Za-z]/.test(s) && s === s.toUpperCase() && s.replace(/[^A-Za-z]/g, '').length > 3;
const COLLAB = /^(.+?)\s+(?:feat\.?|ft\.?|featuring|and|&|with|x|vs\.?)\s+(.+)$/i;

/**
 * Work out artist and title from a file name and the folder it sits in (the folder is the artist).
 * `knownArtists` (optional, a Set of normalised names from your own music library) lets a file whose name says "The Notorious B.I.G. - Title"
 * inside a folder called "Biggie Smalls" be credited to the artist your library actually knows.
 * -> { artist, title, year } where year is only set when the name itself carries one ("Hole - 1996 - Gold Dust Woman", "... [1998]").
 */
export function parseName(base, folder, knownArtists = null) {
  let s = String(base || '').normalize('NFC');
  let year = null;
  s = s.replace(/^(?:19|20)\d{6}[_ -]+/, ''); // yt-dlp "%(upload_date)s_%(title)s"
  for (let i = 0; i < 3; i++) for (const re of NOISE) s = s.replace(re, '');
  const yb = s.match(/\s*[([]((?:19|20)\d{2})[)\]]\s*$/); // a year in brackets at the end: "(1998)" / "[1998]"
  if (yb) { year = Number(yb[1]); s = s.slice(0, yb.index); }
  s = s.replace(/\s+/g, ' ').trim();
  // a leading track number from a compilation / playlist: "23 Love Will Tear Us Apart"
  // (a lone digit with no punctuation is left alone: "1 Step Ahead" is a title; "01 Song", "23 Song" and "1. Song" are track numbers)
  const n = s.match(/^(?:0\d{1,2}|[1-9]\d{1,2}|\d[.)])[.)]?\s+(.{3,})$/);
  if (n && !/^\d+\s*(st|nd|rd|th)\b/i.test(s)) s = n[1];

  let artist = String(folder || '').trim();
  const firstHead = (s.match(/^(.+?)\s*[-–—]\s*.+$/) || [])[1]?.trim() || '';
  const headBase = firstHead.replace(COLLAB, '$1').trim();
  // the file says a different artist than the folder, and your library knows that name but not the folder's
  if (knownArtists && firstHead && norm(headBase) !== norm(artist) && knownArtists.has(norm(headBase)) && !knownArtists.has(norm(artist))) artist = headBase;
  const a = norm(artist);

  // an uploader in front: "RHINO - Morrissey - Title"
  const parts = s.split(/\s+[-–—]\s+/);
  if (parts.length >= 3 && norm(parts[1]) === a && norm(parts[0]) !== a) parts.shift();
  s = parts.join(' - ');
  // the artist in front (also "ARTIST-TITLE" with no spaces, "Artist feat. X - Title", "Artist and X - Title")
  const m = s.match(/^(.+?)\s*[-–—]\s*(.+)$/);
  let feat = '', featWord = 'feat.';
  if (m) {
    const head = m[1].trim();
    const f = head.match(COLLAB);
    if (norm(head) === a || (f && norm(f[1]) === a)) { s = m[2].trim(); if (f && norm(head) !== a) { feat = f[2].trim(); featWord = /^(and|&|with|x|vs)/i.test(head.slice(f[1].length).trim()) ? 'with' : 'feat.'; } }
  }
  // "Artist - 1996 - Title"
  const y = s.match(/^((?:19|20)\d{2})\s*[-–—]\s*(.+)$/);
  if (y) { year = Number(y[1]); s = y[2]; }
  // a trailing repeat of the artist: "Title - Clip - Morrissey - ..."
  s = s.replace(new RegExp(`\\s+[-–—]\\s+${a.split(' ')[0] ? a.split(' ')[0].replace(/[^a-z0-9]/g, '') : '@@'}\\b.*$`, 'i'), '');
  s = s.replace(/\s+/g, ' ').replace(/[\s.\-–—]+$/, '').trim();
  if (shout(s)) s = titleCase(s);
  if (feat) s = `${s} (${featWord} ${shout(feat) ? titleCase(feat) : feat})`;
  return { artist: shout(artist) ? titleCase(artist) : artist, title: s, year };
}

/** A year that could be a release year, or null. Upload dates (20090920) and the year a file was downloaded do not count. */
export function plausibleYear(y, { addedYear = null, mtimeYear = null } = {}) {
  const n = Number(y);
  if (!Number.isInteger(n) || n < 1950 || n > NOW_YEAR) return null;
  return n;
}
/** Is this year probably just when the file was downloaded or added? (same year as the file's own date, and nothing else vouches for it) */
export const looksLikeDownloadYear = (y, { addedYear, mtimeYear } = {}) => y != null && (y === addedYear || y === mtimeYear);

/** "Artist - Title" safe for every file system */
export const fileSafe = (s) => String(s).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').replace(/\s+/g, ' ').replace(/[. ]+$/, '').trim();

/**
 * An index over the music in your own library (WBTV's database, filled from Navidrome or folders), so a video can borrow the
 * real release year and genre of the song it shows.
 * tracks: [{ artist, title, year, genres: [..] }]
 */
export function buildLibraryIndex(tracks) {
  const byKey = new Map(), byArtist = new Map();
  for (const t of tracks) {
    const a = norm(t.artist);
    if (!a) continue;
    (byArtist.get(a) || byArtist.set(a, []).get(a)).push(t);
    const k = `${a}|${norm(t.title)}`;
    (byKey.get(k) || byKey.set(k, []).get(k)).push(t);
  }
  return {
    artists: new Set(byArtist.keys()),
    song(artist, title) {
      const hits = byKey.get(`${norm(artist)}|${norm(title)}`);
      if (!hits?.length) return null;
      const years = hits.map((h) => plausibleYear(h.year)).filter(Boolean).sort((x, y) => x - y);
      const genres = new Map();
      for (const h of hits) for (const g of h.genres || []) genres.set(g, (genres.get(g) || 0) + 1);
      return { year: years[0] ?? null, genres: [...genres.entries()].sort((x, y) => y[1] - x[1]).map(([g]) => g).slice(0, 2), copies: hits.length };
    },
    artist(artist) {
      const t = byArtist.get(norm(artist));
      if (!t?.length) return null;
      const genres = new Map();
      for (const x of t) for (const g of x.genres || []) genres.set(g, (genres.get(g) || 0) + 1);
      return { tracks: t.length, genres: [...genres.entries()].sort((x, y) => y[1] - x[1]).map(([g]) => g).slice(0, 2) };
    },
  };
}

/** Read the few fields we care about from an existing .nfo (kept as text so nothing else in it is lost). */
export function readNfo(xml) {
  const tag = (name) => { const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'i').exec(xml); return m ? m[1].trim() : ''; };
  const all = (name) => [...xml.matchAll(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'gi'))].map((m) => m[1].trim()).filter(Boolean);
  return { title: tag('title'), artist: tag('artist'), album: tag('album'), year: tag('year'), genres: all('genre'), plot: tag('plot'), added: tag('dateadded'), locked: /<lockdata>\s*true/i.test(xml) };
}
