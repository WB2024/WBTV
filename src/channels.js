import { tx, getSettings } from './db.js';
import { TALK } from './scanner.js';

// ---- naming -------------------------------------------------------------

const TV_GENRE_NAMES = {
  horror: 'The Spooky Channel', comedy: 'Laugh Track', drama: 'Prime Drama', crime: 'Crime Scene',
  mystery: 'Whodunnit TV', 'science fiction': 'Beyond 2000', 'sci-fi': 'Beyond 2000', 'sci-fi & fantasy': 'Beyond 2000',
  fantasy: 'Realm TV', animation: 'Toon Town', family: 'Family Hour', children: 'Tiny Telly', kids: 'Tiny Telly',
  documentary: 'The Learning Zone', reality: 'Reality Check', 'reality-tv': 'Reality Check', action: 'Action Replay',
  adventure: 'Adventure Time', 'action & adventure': 'Action Replay', thriller: 'Edge of Seat TV', suspense: 'Edge of Seat TV',
  romance: 'Heartstrings', war: 'Frontline', 'war & politics': 'Frontline', western: 'Frontier TV', history: 'Time Machine TV',
  music: 'Pop Rewind', musical: 'Stage & Screen', sport: 'Sport Central', sports: 'Sport Central', news: 'Newsroom',
  'talk show': 'Late Night Live', talk: 'Late Night Live', 'game show': 'Quiz Time', soap: 'Soap Central',
  biography: 'Life Stories', 'stand-up': 'Comedy Store', 'stand up': 'Comedy Store', travel: 'Wanderlust TV',
  food: 'Kitchen Table', 'special interest': 'The Odd Channel', 'mini-series': 'Limited Run', indie: 'Indie Airwaves',
  anime: 'Anime Hour',
};
const MOVIE_GENRE_NAMES = {
  horror: 'Fright Night Cinema', comedy: 'Laugh Out Loud Cinema', action: 'Action Max', adventure: 'Adventure Cinema',
  drama: 'Silver Screen', 'science fiction': 'Cinema Galaxy', 'sci-fi': 'Cinema Galaxy', fantasy: 'Fantasy Premiere',
  thriller: 'Midnight Thrillers', crime: 'Crime Cinema', mystery: 'Mystery Matinee', animation: 'Toon Cinema',
  family: 'Family Film Night', documentary: 'Doc Cinema', romance: 'Date Night Movies', war: 'War Room Cinema',
  western: 'Saturday Western', history: 'Epic Cinema', music: 'Music Movies', musical: 'Curtain Call Cinema',
  biography: 'True Stories Cinema', 'tv movie': 'Made For TV',
};
const title = (s) => s.replace(/\b\w/g, (c) => c.toUpperCase());

function genreChannelName(kind, genre) {
  const map = kind === 'movie' ? MOVIE_GENRE_NAMES : TV_GENRE_NAMES;
  return map[genre.toLowerCase()] || `${title(genre)} ${kind === 'movie' ? 'Movies' : 'TV'}`;
}
const MUSIC_NAMES = [
  ['hip', 'Urban Beats'], ['rap', 'Urban Beats'], ['r&b', 'Smooth Grooves'], ['soul', 'Smooth Grooves'], ['funk', 'Smooth Grooves'],
  ['dance', 'Dance Floor'], ['electro', 'Dance Floor'], ['house', 'Dance Floor'], ['techno', 'Dance Floor'], ['trance', 'Dance Floor'],
  ['metal', 'Metal Mayhem'], ['punk', 'Punk Rocks'], ['indie', 'Alt Tracks'], ['alternative', 'Alt Tracks'], ['rock', 'Rock Box'],
  ['pop', 'Pop Videos'], ['country', 'Country Roads'], ['jazz', 'Jazz Lounge'], ['blues', 'Blues Cafe'], ['classical', 'Classical Hall'],
  ['reggae', 'Island Vibes'], ['folk', 'Folk Fire'], ['soundtrack', 'Screen Scores'], ['latin', 'Latin Heat'], ['k-pop', 'K-Pop Zone'],
];
const RADIO_NAMES = {
  'Urban Beats': 'Urban FM', 'Smooth Grooves': 'Smooth FM', 'Dance Floor': 'Dance FM', 'Metal Mayhem': 'Metal FM', 'Punk Rocks': 'Punk FM',
  'Alt Tracks': 'Alt FM', 'Rock Box': 'Rock FM', 'Pop Videos': 'Pop FM', 'Country Roads': 'Country FM', 'Jazz Lounge': 'Jazz FM',
  'Blues Cafe': 'Blues FM', 'Classical Hall': 'Classical FM', 'Island Vibes': 'Reggae FM', 'Folk Fire': 'Folk FM', 'Screen Scores': 'Soundtrack FM',
  'Latin Heat': 'Latin FM', 'K-Pop Zone': 'K-Pop FM',
};
function musicGenreName(kind, genre) {
  const g = genre.toLowerCase();
  const hit = MUSIC_NAMES.find(([k]) => g === k || g.includes(k));
  if (kind === 'music') return hit ? hit[1] : `${title(genre)} Music TV`;
  return hit ? RADIO_NAMES[hit[1]] : `${title(genre)} FM`;
}
function decadeName(d, kind = 'movie') {
  if (kind === 'music') return d < 1970 ? 'Golden Oldies TV' : `${d}s Music TV`;
  if (kind === 'radio') return d < 1970 ? 'Golden Oldies FM' : `${d}s Radio`;
  if (d < 1960) return 'Golden Age Cinema';
  return `${d}s Cinema`;
}

const STUDIO_ALIASES = [
  [/^bbc[\s-]*(1|one)$/i, 'BBC One'], [/^bbc[\s-]*(2|two)$/i, 'BBC Two'], [/^bbc[\s-]*(3|three)$/i, 'BBC Three'],
  [/^bbc[\s-]*(4|four)$/i, 'BBC Four'], [/^itv[\s-]*1?$/i, 'ITV1'], [/^itv[\s-]*2$/i, 'ITV2'],
  [/^channel[\s-]*(4|four)$/i, 'Channel 4'], [/^channel[\s-]*(5|five)$/i, 'Channel 5'], [/^e4$/i, 'E4'],
];
function normStudio(raw) {
  const s = raw.trim().replace(/\s+/g, ' ');
  for (const [re, name] of STUDIO_ALIASES) if (re.test(s)) return { norm: name.toLowerCase(), name };
  const norm = s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return { norm: norm || s.toLowerCase(), name: s };
}
const normGenre = (g) => g.toLowerCase().trim();
/** Sub-genres fold into their family (the same families that give the stations their names); anything unrecognised keeps its own name. */
function radioFamily(g) {
  const l = g.toLowerCase();
  const hit = MUSIC_NAMES.find(([k]) => l === k || l.includes(k));
  return hit ? hit[1].toLowerCase() : normGenre(g);
}
const TAGS = /\s*[\(\[-]\s*(\d{4}\s+)?(digital\s+)?(re-?master(ed)?|mono|stereo|deluxe|bonus track|single version|album version|radio edit)[^)\]]*[\)\]]?\s*$/i;
/** artist + title with the "(2011 Remaster)" style tags removed, so one song on many releases gets one key. A live version or a remix stays distinct. */
export function songKey(artist, title) {
  const t = String(title || '').replace(TAGS, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const a = String(artist || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return t ? `${a}|${t}` : '';
}

// Well-known UK ordering, used to hand out channel numbers where the name matches.
const PREFERRED_NUMBERS = [[/^bbc one$/i, 1], [/^bbc two$/i, 2], [/^itv1$/i, 3], [/^channel 4$/i, 4], [/^channel 5$/i, 5],
  [/^itv2$/i, 6], [/^bbc three$/i, 7], [/^bbc four$/i, 9], [/^e4$/i, 10]];

// ---- inference ----------------------------------------------------------

/**
 * Decide which channels every item belongs to (an item can be on several) and store that in channel_items.
 *  TV:     one channel per studio tag; shows with no qualifying studio fall back to genre channels
 *          (or every show gets genre channels if tvGenreChannelsForAll is on).
 *  Movies: genre channels, plus (optionally) studio channels and decade channels.
 *  Anything left over lands in a catch-all channel.
 */
/**
 * What a spoken-word item belongs to. Podcasts and radio series: the show's folder (the first folder under the library), because the album tag is
 * often a season ("Show - Season 2") and would split one show over many channels. Audiobooks: the book (album tag), else its folder.
 */
export function talkTitle({ path: p, lib_path: base, lib_type: type, album }) {
  const slash = (x) => String(x).replace(/\\/g, '/');
  const root = base ? slash(base).replace(/\/$/, '') + '/' : '';
  const rel = root && p && slash(p).startsWith(root) ? slash(p).slice(root.length) : ''; // a path not under the library (should not happen) has no show folder
  const parts = rel.split('/').filter(Boolean);
  const folder = parts.length > 1 ? parts[0] : '';
  if (type === 'talk_podcasts') return folder || album || '';
  return album || folder || '';
}

/** Spoken-word libraries: one channel per show / book (true), or one station for the whole library (false). Podcasts default to per show. */
export function talkPerTitle(db, libId, libType) {
  const v = db.prepare('SELECT value FROM settings WHERE key=?').get(`talk_per_title_${libId}`)?.value;
  return v === '1' ? true : v === '0' ? false : libType === 'talk_podcasts';
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

export function inferChannels(db) {
  const st = getSettings(db);
  const minSec = st.minChannelMinutes * 60;

  const rows = db.prepare(`
    SELECT i.id, i.kind, i.title AS i_title, i.show_id, i.year, i.runtime, i.studios, i.genres, i.artist, i.album, i.path, i.library_id, l.name AS lib_name, l.type AS lib_type, l.path AS lib_path, l.channel_group AS grp, l.group_mode AS gmode,
      s.studios AS s_studios, s.genres AS s_genres
    FROM items i LEFT JOIN shows s ON s.id = i.show_id LEFT JOIN libraries l ON l.id = i.library_id WHERE i.runtime > 0 AND (i.kind <> 'track' OR i.runtime BETWEEN 45 AND 900) ORDER BY i.year IS NULL, i.year, i.id`).all(); // radio: no clips of a few seconds, no hour-long mixes; the oldest release of a song comes first

  // A "unit" is a whole show (all its episodes stay together) or a single movie.
  const units = new Map();
  const idGrp = new Map(); // item id -> its library's channel group
  const songs = new Set(); // the same song on several releases (album, single, greatest hits, remaster) is played once
  for (const r of rows) {
    if (r.kind === 'track') {
      const k = songKey(r.artist, r.i_title);
      if (k) { if (songs.has(k)) continue; songs.add(k); }
    }
    const solo = r.kind === 'movie' || r.kind === 'musicvideo' || r.kind === 'track' || r.kind === 'talk' || r.kind === 'clip';
    const key = solo ? `m${r.id}` : `s${r.show_id}`;
    const ukind = r.kind === 'movie' ? 'movie' : r.kind === 'musicvideo' ? 'music' : r.kind === 'track' ? 'radio' : r.kind === 'talk' ? 'talk' : r.kind === 'clip' ? 'clip' : 'tv';
    let u = units.get(key);
    if (!u) {
      u = { kind: ukind, ids: [], seconds: 0, year: r.year, studios: new Map(), genres: new Map(), lib: r.library_id, libName: r.lib_name, libType: r.lib_type, album: r.album, title: talkTitle(r),
        grp: String(r.grp || '').trim(), mode: ukind === 'clip' ? 'single' : (r.gmode || 'inferred') }; // clips and interviews are only ever a channel of their own
      units.set(key, u);
    }
    u.ids.push(r.id); u.seconds += r.runtime;
    if (r.grp && String(r.grp).trim()) idGrp.set(r.id, String(r.grp).trim());
    const studios = [...JSON.parse(r.s_studios || '[]'), ...JSON.parse(r.studios || '[]')];
    const genres = [...JSON.parse(r.s_genres || '[]'), ...JSON.parse(r.genres || '[]')];
    for (const s of new Set(studios)) { const n = normStudio(s); if (!u.studios.has(n.norm)) u.studios.set(n.norm, n); }
    for (const g of new Set(genres)) { const n = u.kind === 'radio' ? radioFamily(g) : normGenre(g); if (n) u.genres.set(n, g); } // radio: Indie Rock, Hard Rock and Rock are one Rock station
  }

  // popularity of each tag (total seconds, and film counts for movie studios)
  const secs = { tv: { studio: new Map(), genre: new Map() }, movie: { genre: new Map(), studio: new Map(), decade: new Map() },
    music: { genre: new Map(), decade: new Map() }, radio: { genre: new Map(), decade: new Map() } };
  const films = new Map();
  const bump = (m, k, n) => m.set(k, (m.get(k) || 0) + n);
  for (const u of units.values()) {
    if (u.kind === 'talk' || u.kind === 'clip' || u.mode === 'single') continue; // those get a channel of their own, not genre / decade / studio channels
    if (u.kind === 'tv') for (const k of u.studios.keys()) bump(secs.tv.studio, k, u.seconds);
    for (const k of u.genres.keys()) bump(secs[u.kind].genre, k, u.seconds);
    if (u.kind === 'music' || u.kind === 'radio') { if (u.year) bump(secs[u.kind].decade, Math.floor(u.year / 10) * 10, u.seconds); }
    if (u.kind === 'movie') {
      for (const k of u.studios.keys()) bump(films, k, 1);
      if (u.year) bump(secs.movie.decade, Math.floor(u.year / 10) * 10, u.seconds);
    }
  }

  const assign = new Map(); // channel key -> { kind, name, ids:Set }
  const put = (key, kind, name, ids) => {
    const c = assign.get(key) || { kind, name, ids: new Set() };
    if (c.kind !== kind && key.startsWith('group:') && !['music', 'clips'].includes(c.kind) && !['music', 'clips'].includes(kind)) c.kind = 'tv'; // films and shows in one group: scheduled as TV
    for (const id of ids) c.ids.add(id);
    assign.set(key, c);
  };

  for (const u of units.values()) {
    let placed = false;
    // a channel group: libraries that share a group name become one channel ("Stand Up" = Stand Up Films + Stand Up Shows, Managed + Unmanaged)
    const gname = u.kind === 'talk' ? '' : (u.grp || (u.mode === 'single' ? String(u.libName || '').trim() : ''));
    if (gname && (u.mode === 'single' || u.mode === 'both')) put(`group:${slug(gname)}`, u.kind === 'movie' ? 'movie' : u.kind === 'tv' ? 'tv' : u.kind === 'clip' ? 'clips' : 'music', gname, u.ids);
    if (u.mode === 'single' && u.kind !== 'talk') continue;
    if (u.kind === 'talk') {
      // one channel per show / book when the library is set that way (the default for podcasts), always playing in order and looping;
      // otherwise one station per spoken-word library, named after the library
      const title = String(u.title || '').trim();
      if (title && talkPerTitle(db, u.lib, u.libType)) { put(`radio:talk:${u.lib}:${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60)}`, 'radio', title, u.ids); continue; }
      put(`radio:talk:${u.lib}`, 'radio', (u.libName || '').trim() || TALK[u.libType]?.channel || 'Talk Radio', u.ids);
      continue;
    }
    if (u.kind === 'tv') {
      for (const [k, n] of u.studios) {
        if ((secs.tv.studio.get(k) || 0) >= minSec) { put(`tv:studio:${k}`, 'tv', n.name, u.ids); placed = true; }
      }
      if (st.tvGenreChannelsForAll || !placed) {
        for (const [k, name] of u.genres) {
          if ((secs.tv.genre.get(k) || 0) >= minSec) { put(`tv:genre:${k}`, 'tv', genreChannelName('tv', name), u.ids); placed = true; }
        }
      }
      if (!placed) put('tv:misc', 'tv', 'WBTV Variety', u.ids);
    } else if (u.kind === 'music' || u.kind === 'radio') {
      for (const [k, name] of u.genres) {
        if ((secs[u.kind].genre.get(k) || 0) >= minSec) { put(`${u.kind}:genre:${k}`, u.kind, musicGenreName(u.kind, name), u.ids); placed = true; }
      }
      if (u.year) {
        const d = Math.floor(u.year / 10) * 10;
        const key = d < 1970 ? `${u.kind}:decade:oldies` : `${u.kind}:decade:${d}`;
        if ((secs[u.kind].decade.get(d) || 0) >= minSec || d < 1970) { put(key, u.kind, decadeName(d, u.kind), u.ids); placed = true; }
      }
      if (!placed) put(`${u.kind}:misc`, u.kind, u.kind === 'music' ? 'WBTV Music' : 'WBTV Radio', u.ids);
    } else {
      for (const [k, name] of u.genres) {
        if ((secs.movie.genre.get(k) || 0) >= minSec) { put(`movie:genre:${k}`, 'movie', genreChannelName('movie', name), u.ids); placed = true; }
      }
      if (st.movieStudioChannels) {
        for (const [k, n] of u.studios) {
          if ((films.get(k) || 0) >= st.movieStudioMinFilms) { put(`movie:studio:${k}`, 'movie', n.name, u.ids); placed = true; }
        }
      }
      if (st.movieDecadeChannels && u.year) {
        const d = Math.floor(u.year / 10) * 10;
        const key = d < 1960 ? 'movie:decade:classic' : `movie:decade:${d}`;
        if ((secs.movie.decade.get(d) || 0) >= minSec || d < 1960) { put(key, 'movie', decadeName(d), u.ids); placed = true; }
      }
      if (!placed) put('movie:misc', 'movie', 'WBTV Cinema', u.ids);
    }
  }

  // Different genres can share one themed name (every kind of "jazz" is "Jazz FM"). Keep each channel and its number, but tell them apart:
  // the plainest genre (shortest name, then by key so it is stable) keeps the plain name, the others say which genre they are.
  const genreOf = (key) => /:genre:(.+)$/.exec(key)?.[1] || '';
  const sameName = new Map();
  for (const [key, c] of assign.entries()) {
    const k = `${c.kind}|${c.name.toLowerCase()}`;
    if (!sameName.has(k)) sameName.set(k, []);
    sameName.get(k).push([key, c]);
  }
  for (const group of sameName.values()) {
    if (group.length < 2) continue;
    group.sort(([ka], [kb]) => genreOf(ka).length - genreOf(kb).length || ka.localeCompare(kb));
    group.slice(1).forEach(([key, c]) => { const g = genreOf(key); if (g) c.name += ` (${title(g)})`; });
  }

  // a movie studio that shares its name with a TV channel gets a suffix so they stay distinguishable
  const tvNames = new Set([...assign.values()].filter((c) => c.kind === 'tv').map((c) => c.name.toLowerCase()));
  for (const c of assign.values()) if (c.kind === 'movie' && tvNames.has(c.name.toLowerCase())) c.name += ' Movies';

  tx(db, () => {
    const existing = new Map(db.prepare('SELECT * FROM channels').all().map((c) => [c.key, c]));
    const taken = new Set([...existing.values()].map((c) => c.number).filter((n) => n != null));
    let nextNum = Math.max(10, ...[...taken].filter((n) => n < 300), 0) + 1;
    const BASE = { music: 400, live: 600, radio: 800 };
    const freeFrom = (n) => { while (taken.has(n)) n++; return n; };
    const ins = db.prepare('INSERT INTO channels(key,kind,auto_name,number,enabled,item_count) VALUES(?,?,?,?,1,0)');
    const upd = db.prepare('UPDATE channels SET auto_name=?, item_count=?, kind=?, grp=? WHERE id=?'); // kind too: a group of films and shows is TV, whatever its first library was
    db.exec('DELETE FROM channel_items');
    const link = db.prepare('INSERT OR IGNORE INTO channel_items(channel_id,item_id) VALUES(?,?)');

    const order = [...assign.entries()].sort(([ka, a], [kb, b]) =>
      (a.kind === b.kind ? 0 : a.kind === 'tv' ? -1 : 1) || ka.localeCompare(kb));
    for (const [key, c] of order) {
      let ch = existing.get(key);
      if (!ch) {
        let num = null;
        for (const [re, n] of PREFERRED_NUMBERS) if (re.test(c.name) && !taken.has(n)) num = n;
        if (num == null) { if (BASE[c.kind]) num = freeFrom(BASE[c.kind]); else { nextNum = freeFrom(nextNum); num = nextNum++; } }
        taken.add(num);
        ch = { id: Number(ins.run(key, c.kind, c.name, num).lastInsertRowid) };
      }
      const gc = new Map(); for (const id of c.ids) { const g = idGrp.get(id); if (g) gc.set(g, (gc.get(g) || 0) + 1); }
      const top = [...gc.entries()].sort((a, b) => b[1] - a[1])[0]; // the group most of its programmes belong to
      upd.run(c.name, c.ids.size, c.kind, top && top[1] * 2 >= c.ids.size ? top[0] : null, ch.id);
      for (const id of c.ids) link.run(ch.id, id);
    }
    for (const [key, ch] of existing) if (!assign.has(key) && !key.startsWith('live:')) upd.run(ch.auto_name, 0, ch.kind, null, ch.id); // emptied channels (live ones: syncLiveChannels)
  });
}

/**
 * One channel per live stream (IPTV entries, single HLS streams, YouTube live). They have no schedule, so item_count is just
 * 1 (on air) or 0 (the health check found it dead). Big playlists start switched off, then the first working ones are enabled.
 */
export function syncLiveChannels(db) {
  const CAP = 80;
  const streams = db.prepare('SELECT s.*, (SELECT COUNT(*) FROM live_streams x WHERE x.library_id=s.library_id) AS total FROM live_streams s ORDER BY s.library_id, s.grp, s.name').all();
  tx(db, () => {
    const existing = new Map(db.prepare("SELECT * FROM channels WHERE key LIKE 'live:%'").all().map((c) => [c.key, c]));
    const taken = new Set(db.prepare('SELECT number FROM channels WHERE number IS NOT NULL').all().map((r) => r.number));
    const ins = db.prepare("INSERT INTO channels(key,kind,auto_name,number,enabled,item_count) VALUES(?,'live',?,?,?,?)");
    const upd = db.prepare('UPDATE channels SET auto_name=?, item_count=? WHERE id=?');
    const link = db.prepare('UPDATE live_streams SET channel_id=? WHERE id=?');
    const aliveIds = new Map();
    let n = 600;
    for (const st of streams) {
      const key = `live:${st.id}`;
      const count = st.alive === 0 ? 0 : 1;
      let ch = existing.get(key);
      if (!ch) {
        while (taken.has(n)) n++;
        taken.add(n);
        ch = { id: Number(ins.run(key, st.name, n, st.total <= CAP ? 1 : 0, count).lastInsertRowid) };
      } else upd.run(st.name, count, ch.id);
      link.run(ch.id, st.id);
      if (st.alive === 1) aliveIds.set(st.library_id, [...(aliveIds.get(st.library_id) || []), ch.id]);
    }
    const flag = db.prepare('SELECT 1 FROM settings WHERE key=?');
    for (const [lib, ids] of aliveIds) {
      const total = streams.find((x) => x.library_id === lib)?.total || 0;
      if (total <= CAP || flag.get(`live_autoenabled_${lib}`) || streams.some((x) => x.library_id === lib && x.alive == null)) continue;
      for (const id of ids.slice(0, CAP)) db.prepare('UPDATE channels SET enabled=1 WHERE id=?').run(id);
      db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(`live_autoenabled_${lib}`, '1');
    }
    const keep = new Set(streams.map((x) => `live:${x.id}`));
    // channels whose stream is gone (its playlist was removed or refreshed without it) are deleted, not just hidden: otherwise they pile up
    // in Setup > Channels and keep their channel numbers for ever
    for (const [key, ch] of existing) if (!keep.has(key)) db.prepare('DELETE FROM channels WHERE id=?').run(ch.id);
  });
}
