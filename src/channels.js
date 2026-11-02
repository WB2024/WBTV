import { tx, getSettings } from './db.js';

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
function decadeName(d) {
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
export function inferChannels(db) {
  const st = getSettings(db);
  const minSec = st.minChannelMinutes * 60;

  const rows = db.prepare(`
    SELECT i.id, i.kind, i.show_id, i.year, i.runtime, i.studios, i.genres, s.studios AS s_studios, s.genres AS s_genres
    FROM items i LEFT JOIN shows s ON s.id = i.show_id WHERE i.runtime > 0`).all();

  // A "unit" is a whole show (all its episodes stay together) or a single movie.
  const units = new Map();
  for (const r of rows) {
    const key = r.kind === 'movie' ? `m${r.id}` : `s${r.show_id}`;
    let u = units.get(key);
    if (!u) {
      u = { kind: r.kind === 'movie' ? 'movie' : 'tv', ids: [], seconds: 0, year: r.year, studios: new Map(), genres: new Map() };
      units.set(key, u);
    }
    u.ids.push(r.id); u.seconds += r.runtime;
    const studios = [...JSON.parse(r.s_studios || '[]'), ...JSON.parse(r.studios || '[]')];
    const genres = [...JSON.parse(r.s_genres || '[]'), ...JSON.parse(r.genres || '[]')];
    for (const s of new Set(studios)) { const n = normStudio(s); if (!u.studios.has(n.norm)) u.studios.set(n.norm, n); }
    for (const g of new Set(genres)) { const n = normGenre(g); if (n) u.genres.set(n, g); }
  }

  // popularity of each tag (total seconds, and film counts for movie studios)
  const secs = { tv: { studio: new Map(), genre: new Map() }, movie: { genre: new Map(), studio: new Map(), decade: new Map() } };
  const films = new Map();
  const bump = (m, k, n) => m.set(k, (m.get(k) || 0) + n);
  for (const u of units.values()) {
    if (u.kind === 'tv') for (const k of u.studios.keys()) bump(secs.tv.studio, k, u.seconds);
    for (const k of u.genres.keys()) bump(secs[u.kind].genre, k, u.seconds);
    if (u.kind === 'movie') {
      for (const k of u.studios.keys()) bump(films, k, 1);
      if (u.year) bump(secs.movie.decade, Math.floor(u.year / 10) * 10, u.seconds);
    }
  }

  const assign = new Map(); // channel key -> { kind, name, ids:Set }
  const put = (key, kind, name, ids) => {
    const c = assign.get(key) || { kind, name, ids: new Set() };
    for (const id of ids) c.ids.add(id);
    assign.set(key, c);
  };

  for (const u of units.values()) {
    let placed = false;
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

  // a movie studio that shares its name with a TV channel gets a suffix so they stay distinguishable
  const tvNames = new Set([...assign.values()].filter((c) => c.kind === 'tv').map((c) => c.name.toLowerCase()));
  for (const c of assign.values()) if (c.kind === 'movie' && tvNames.has(c.name.toLowerCase())) c.name += ' Movies';

  tx(db, () => {
    const existing = new Map(db.prepare('SELECT * FROM channels').all().map((c) => [c.key, c]));
    const taken = new Set([...existing.values()].map((c) => c.number).filter((n) => n != null));
    let nextNum = Math.max(10, ...taken, 0) + 1;
    const ins = db.prepare('INSERT INTO channels(key,kind,auto_name,number,enabled,item_count) VALUES(?,?,?,?,1,0)');
    const upd = db.prepare('UPDATE channels SET auto_name=?, item_count=? WHERE id=?');
    db.exec('DELETE FROM channel_items');
    const link = db.prepare('INSERT OR IGNORE INTO channel_items(channel_id,item_id) VALUES(?,?)');

    const order = [...assign.entries()].sort(([ka, a], [kb, b]) =>
      (a.kind === b.kind ? 0 : a.kind === 'tv' ? -1 : 1) || ka.localeCompare(kb));
    for (const [key, c] of order) {
      let ch = existing.get(key);
      if (!ch) {
        let num = null;
        for (const [re, n] of PREFERRED_NUMBERS) if (re.test(c.name) && !taken.has(n)) num = n;
        if (num == null) num = nextNum++;
        taken.add(num);
        ch = { id: Number(ins.run(key, c.kind, c.name, num).lastInsertRowid) };
      }
      upd.run(c.name, c.ids.size, ch.id);
      for (const id of c.ids) link.run(ch.id, id);
    }
    for (const [key, ch] of existing) if (!assign.has(key)) upd.run(ch.auto_name, 0, ch.id); // emptied channels
  });
}
