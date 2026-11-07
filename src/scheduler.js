import { tx, getSettings } from './db.js';
import { buildPromo } from './promo.js';
import { ttsReady, voiceSpeed } from './tts.js';
import { classify, daypartWeight, pickWeighted, guessAdYear, eraWeight, programmeYear } from './daypart.js';

/**
 * The "broadcast" schedule. It is generated ahead of time and *persisted*, so the guide
 * and the live streams always agree and "what played earlier" is real history.
 *
 *   programmes: one row per show/episode/movie airing (what the EPG shows)
 *   blocks:     the playable pieces - content slices and ads - that make up the airing
 */

const HORIZON_HOURS = 14;
const HISTORY_HOURS = 2;
const rand = (a, b) => a + Math.random() * (b - a);
const pickOne = (a) => a[Math.floor(Math.random() * a.length)];

/** Weight of an item (or a show, via its first episode) for airing at time ts; neutral when dayparting is off. */
function weigher(settings) {
  if (!settings.autoDaypart) return () => 1;
  return (it, ts) => {
    it._dp ||= classify([...JSON.parse(it.genres || '[]'), ...JSON.parse(it.show_genres || '[]')], it.mpaa || it.show_mpaa);
    return daypartWeight(it._dp, ts);
  };
}

function makePicker(db, ch, items, settings) {
  const wOf = weigher(settings);
  const hist = db.prepare('SELECT item_id FROM programmes WHERE channel_id=? ORDER BY start DESC LIMIT 400')
    .all(ch.id).map((r) => r.item_id).reverse();

  if (ch.kind === 'movie') {
    const recent = hist.slice();
    return (ts) => {
      const n = Math.min(Math.floor(items.length / 2), 100);
      const recentSet = new Set(n > 0 ? recent.slice(-n) : []);
      let pool = items.filter((i) => !recentSet.has(i.id));
      if (!pool.length) pool = items;
      const it = pickWeighted(pool, (x) => wOf(x, ts));
      recent.push(it.id);
      return it;
    };
  }

  // TV: pick a show at random (never the same twice in a row), then air its next episode in order.
  const shows = new Map();
  for (const it of items) {
    const k = it.show_id ?? 0;
    if (!shows.has(k)) shows.set(k, []);
    shows.get(k).push(it);
  }
  for (const eps of shows.values()) {
    eps.sort((a, b) => (a.season ?? 0) - (b.season ?? 0) || (a.episode ?? 0) - (b.episode ?? 0) || a.path.localeCompare(b.path));
  }
  const lastIdx = new Map();
  let lastShow = null;
  const byId = new Map(items.map((i) => [i.id, i]));
  for (const id of hist) {
    const it = byId.get(id);
    if (!it) continue;
    const k = it.show_id ?? 0;
    lastIdx.set(k, shows.get(k).indexOf(it));
    lastShow = k;
  }
  return (ts) => {
    const ids = [...shows.keys()];
    const pool = ids.length > 1 ? ids.filter((k) => k !== lastShow) : ids;
    const k = pickWeighted(pool, (id) => wOf(shows.get(id)[0], ts));
    const eps = shows.get(k);
    let idx;
    if (k === 0 && eps.length > 1) { // films mixed into a show channel (a channel group): no episode order, so pick one at random and never the one just played
      do idx = Math.floor(Math.random() * eps.length); while (idx === lastIdx.get(0));
    } else idx = lastIdx.has(k) ? (lastIdx.get(k) + 1) % eps.length : Math.floor(Math.random() * eps.length);
    lastIdx.set(k, idx);
    lastShow = k;
    return eps[idx];
  };
}

export const REEL = 600; // ads longer than this are "reels" (recorded ad breaks): we play a random chunk of one

/** Ad blocks filling `target` seconds. exact=true trims the last piece so the gap closes precisely. */
function fillAds(ads, target, exact, state, year = null) {
  const out = [];
  let filled = 0;
  const usedHere = new Set();
  while (exact ? target - filled > 1.5 : filled < target) {
    const remaining = target - filled;
    const free = (a) => !usedHere.has(a.id) && a.id !== state.lastAd;
    let pool = ads.filter((a) => free(a) && (!exact || a.duration <= remaining + 0.01 || a.duration > REEL));
    if (!pool.length && exact) pool = ads.filter(free); // nothing fits: trim one
    if (!pool.length) pool = ads; // tiny ad pools: allow repeats
    const ad = year ? pickWeighted(pool, (a) => eraWeight(a.year, year)) : pickOne(pool);
    let len, inPoint = 0;
    if (ad.duration > REEL) {
      len = Math.min(exact ? remaining : Math.max(30, remaining), ad.duration);
      inPoint = Math.random() * (ad.duration - len);
    } else len = exact ? Math.min(ad.duration, remaining) : ad.duration; // only ever trim, never stretch
    out.push({ ad, len, inPoint });
    filled += len; usedHere.add(ad.id); state.lastAd = ad.id;
    if (out.length > 60) break;
  }
  return out;
}

export const IDENT_SECONDS = 5;

/** How many parts a programme of D seconds is cut into: one ad break roughly every `everyMinutes`. Always finite, whatever the setting. */
export function breakSegments(D, everyMinutes) {
  const every = (Number(everyMinutes) > 0 ? Number(everyMinutes) : 20) * 60;
  return Math.min(40, Math.max(2, Math.round(D / every)));
}

const toMinutes = (hhmm, fallback) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
  return m ? Math.min(23, Number(m[1])) * 60 + Math.min(59, Number(m[2])) : fallback;
};
/** If `t` (unix seconds) falls inside the nightly closedown window, returns when it ends (unix seconds); otherwise null. */
export function signOffEnd(settings, t) {
  if (!settings.signOffEnabled) return null;
  const a = toMinutes(settings.signOffFrom, 180), b = toMinutes(settings.signOffTo, 300);
  if (a === b) return null;
  const d = new Date(t * 1000);
  const m = d.getHours() * 60 + d.getMinutes();
  const inside = a < b ? m >= a && m < b : m >= a || m < b;
  if (!inside) return null;
  const end = new Date(d);
  end.setHours(Math.floor(b / 60), b % 60, 0, 0);
  if (end <= d) end.setDate(end.getDate() + 1);
  return end.getTime() / 1000;
}

function extendChannel(db, ch, settings, ads, now, horizon, idents = []) {
  let t = db.prepare('SELECT MAX(end) AS m FROM blocks WHERE channel_id=?').get(ch.id).m;
  const floorHist = now - HISTORY_HOURS * 3600;
  if (t == null || t < floorHist) t = Math.floor(floorHist / 300) * 300;
  if (t >= horizon) return;

  const items = db.prepare(`SELECT i.id, i.kind, i.show_id, i.season, i.episode, i.path, i.runtime, i.title, i.plot, i.year, i.genres, i.artist, i.album, i.aired, i.mpaa, i.library_id,
      s.title AS show_title, s.plot AS show_plot, s.year AS show_year, s.genres AS show_genres, s.mpaa AS show_mpaa
    FROM items i JOIN channel_items ci ON ci.item_id=i.id LEFT JOIN shows s ON s.id=i.show_id
    WHERE ci.channel_id=? AND i.runtime>0`).all(ch.id);
  if (!items.length) return;
  if (items[0].kind === 'talk') {
    const lib = db.prepare('SELECT type FROM libraries WHERE id=?').get(items[0].library_id);
    return extendTalk(db, ch, items, t, horizon, lib?.type || 'talk_interviews');
  }
  if (ch.kind === 'music' || ch.kind === 'clips' || ch.kind === 'radio') return extendRotation(db, ch, items, t, horizon);
  const pick = makePicker(db, ch, items, settings);

  // "coming up next" announcements need to know the next few programmes, so we plan a few items ahead
  const promoOn = settings.promosEnabled && ttsReady(settings.promoVoice);
  const chName = db.prepare('SELECT COALESCE(name_override, auto_name) AS n FROM channels WHERE id=?').get(ch.id)?.n || 'this channel';
  const lookahead = [];
  const take = () => { while (lookahead.length < (promoOn ? Math.max(1, settings.promoCount) : 1)) lookahead.push(pick(t + lookahead.length * 1800)); return lookahead.shift(); };
  const insPromo = db.prepare('INSERT INTO promos(segments, est) VALUES(?,?)');
  const insPromoBlock = db.prepare("INSERT INTO blocks(channel_id,programme_id,kind,item_id,ad_id,in_point,start,end,promo_id) VALUES(?,NULL,'promo',?,NULL,?,?,?,?)");
  let firstOnChannel = db.prepare('SELECT 1 FROM blocks WHERE channel_id=? LIMIT 1').get(ch.id) == null;
  const insProg = db.prepare('INSERT INTO programmes(channel_id,item_id,start,end) VALUES(?,?,?,?)');
  const insBlock = db.prepare('INSERT INTO blocks(channel_id,programme_id,kind,item_id,ad_id,in_point,start,end) VALUES(?,?,?,?,?,?,?,?)');
  const useAds = ads.length > 0;
  const align = Math.max(1, settings.alignMinutes) * 60;
  const adState = { lastAd: null };

  tx(db, () => {
    while (t < horizon) {
      // nightly closedown: a test card until the window ends, then the first programme of the "morning"
      const off = signOffEnd(settings, t);
      if (off) { insBlock.run(ch.id, null, 'signoff', null, null, 0, t, off); t = off; firstOnChannel = true; continue; }
      const item = take();
      const D = item.runtime;
      const year = settings.eraAds ? programmeYear(item) : null; // adverts from the same era as the programme
      const promoOpts = { count: settings.promoCount, readPlots: settings.promoReadPlots, wps: voiceSpeed(settings.promoVoice) };

      // Between programmes: [adverts to the next grid line] then the "coming up next" slot, so the programme still starts on the dot
      const wantPromo = promoOn && !firstOnChannel;
      // a clip of the user's own (Ads tab > station idents) if there is one, otherwise the generated ident card
      const custom = settings.identsEnabled && !firstOnChannel && idents.length ? idents[Math.floor(Math.random() * idents.length)] : null;
      const identSecs = custom ? custom.duration : IDENT_SECONDS;
      const identLen = settings.identsEnabled && !firstOnChannel ? identSecs : 0;
      let identDone = false;
      const addIdent = () => { insBlock.run(ch.id, null, 'ident', null, custom ? custom.id : null, 0, t, t + identSecs); t += identSecs; identDone = true; };
      const addPromo = (p) => {
        const pid = Number(insPromo.run(JSON.stringify(p.segments), p.est).lastInsertRowid);
        const off = item.runtime > p.dur + 40 ? rand(0.12, 0.55) * (item.runtime - p.dur - 10) : 0; // a clip from inside the next programme
        insPromoBlock.run(ch.id, item.id, off, t, t + p.dur, pid); t += p.dur;
      };
      if (useAds && settings.fillGaps) {
        let gap = Math.ceil(t / align) * align - t;
        if (wantPromo) {
          if (gap < 25) gap += align; // not enough room: use the next grid slot instead of losing the alignment
          const promo = buildPromo(chName, [item, ...lookahead], Math.min(gap, settings.promoMaxSeconds), promoOpts);
          const adLen = gap - (promo ? promo.dur : 0) - identLen;
          if (adLen >= 1.5) {
            for (const { ad, len, inPoint } of fillAds(ads, adLen, true, adState, year)) {
              insBlock.run(ch.id, null, 'ad', null, ad.id, inPoint, t, t + len); t += len;
            }
          }
          if (promo) addPromo(promo);
          if (identLen) addIdent();
        } else if (gap >= 15 && gap < align) {
          for (const { ad, len, inPoint } of fillAds(ads, gap - identLen, true, adState, year)) {
            insBlock.run(ch.id, null, 'ad', null, ad.id, inPoint, t, t + len); t += len;
          }
          if (identLen) addIdent();
        }
      } else if (wantPromo) {
        const promo = buildPromo(chName, [item, ...lookahead], settings.promoMaxSeconds, promoOpts);
        if (promo) addPromo(promo);
      }
      if (identLen && !identDone) addIdent();
      firstOnChannel = false;

      // split into segments with ad breaks between
      let cuts = [];
      if (useAds && D >= 15 * 60) {
        const segs = breakSegments(D, settings.breakEveryMinutes);
        for (let k = 1; k < segs; k++) cuts.push(D * k / segs + rand(-0.06, 0.06) * (D / segs));
      }
      const bounds = [0, ...cuts, D];
      const start = t;
      const progId = Number(insProg.run(ch.id, item.id, start, start).lastInsertRowid);
      for (let s = 0; s < bounds.length - 1; s++) {
        const len = bounds[s + 1] - bounds[s];
        insBlock.run(ch.id, progId, 'content', item.id, null, bounds[s], t, t + len); t += len;
        if (s < bounds.length - 2) {
          const target = settings.breakLengthMinutes * 60 * rand(0.7, 1.2);
          for (const { ad, len: l, inPoint } of fillAds(ads, target, false, adState, year)) {
            insBlock.run(ch.id, progId, 'ad', null, ad.id, inPoint, t, t + l); t += l;
          }
        }
      }
      db.prepare('UPDATE programmes SET end=? WHERE id=?').run(t, progId);
    }
  });
}

const ROTATION = 30 * 60; // music/radio: one guide entry per half hour of non-stop tracks

/**
 * Music video and radio channels play back to back, with no adverts or announcements. Each guide entry is a ~30 minute
 * rotation made of many tracks (one block per track), so the guide stays readable and the stream shows what is playing.
 */
function extendRotation(db, ch, items, t, horizon) {
  items = items.filter((i) => i.runtime >= 1); // a zero-length file would otherwise add thousands of blocks to fill the half hour
  if (!items.length) return;
  const recent = db.prepare("SELECT item_id FROM blocks WHERE channel_id=? AND kind='content' ORDER BY start DESC LIMIT 400").all(ch.id).map((r) => r.item_id).reverse();
  const byId = new Map(items.map((i) => [i.id, i]));
  const insProg = db.prepare('INSERT INTO programmes(channel_id,item_id,start,end) VALUES(?,?,?,?)');
  const insBlock = db.prepare("INSERT INTO blocks(channel_id,programme_id,kind,item_id,ad_id,in_point,start,end) VALUES(?,?,'content',?,NULL,0,?,?)");
  let lastArtist = recent.length ? byId.get(recent[recent.length - 1])?.artist : null;
  const memory = Math.min(Math.floor(items.length / 2), 200);

  const pickTrack = () => {
    const avoid = new Set(memory > 0 ? recent.slice(-memory) : []);
    let pool = items.filter((i) => !avoid.has(i.id));
    if (!pool.length) pool = items;
    let it = pickOne(pool);
    for (let k = 0; k < 6 && it.artist && it.artist === lastArtist && pool.length > 1; k++) it = pickOne(pool); // not the same artist twice in a row
    recent.push(it.id); lastArtist = it.artist;
    return it;
  };

  tx(db, () => {
    while (t < horizon) {
      const start = t;
      let first = null;
      const progId = Number(insProg.run(ch.id, items[0].id, start, start).lastInsertRowid);
      while (t - start < ROTATION) {
        const tr = pickTrack();
        if (!first) first = tr;
        insBlock.run(ch.id, progId, tr.id, t, t + tr.runtime); t += tr.runtime;
      }
      db.prepare('UPDATE programmes SET item_id=?, end=? WHERE id=?').run(first.id, t, progId);
    }
  });
}

const byName = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });

/** Order within one show or book: air date (podcasts), then disc/track number (audiobook chapters), then file name. */
export function episodeOrder(a, b) {
  return (a.aired && b.aired && a.aired !== b.aired ? (a.aired < b.aired ? -1 : 1) : 0)
    || (a.season ?? 0) - (b.season ?? 0) || (a.episode ?? 0) - (b.episode ?? 0) || byName(a.path, b.path);
}

/**
 * Spoken-word stations (interviews, podcasts, audiobooks). Every guide entry is one item, with no adverts or announcements.
 *  - interviews: shuffled, avoiding recent repeats
 *  - podcasts:   rotate between shows; each show's episodes go out in order, oldest first, then start over
 *  - audiobooks: one book at a time, chapters in order; when a book ends, another begins
 * Where a show or book got to is read back from what already aired, so the story carries on after a restart.
 */
export function extendTalk(db, ch, items, t, horizon, mode) {
  const groups = new Map();
  if (mode !== 'talk_interviews') {
    for (const it of items) {
      const k = it.album || it.artist || '';
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(it);
    }
    for (const g of groups.values()) g.sort(episodeOrder);
  }
  const keyOf = (it) => it.album || it.artist || '';
  const byId = new Map(items.map((i) => [i.id, i]));
  const hist = db.prepare('SELECT item_id FROM programmes WHERE channel_id=? ORDER BY start DESC LIMIT 400').all(ch.id).map((r) => r.item_id).reverse();
  const lastIdx = new Map();
  let last = null;
  for (const id of hist) {
    const it = byId.get(id);
    if (!it) continue;
    last = it;
    if (groups.size) lastIdx.set(keyOf(it), groups.get(keyOf(it)).indexOf(it));
  }
  const recent = hist.slice();
  const memory = Math.min(Math.floor(items.length / 2), 100);

  const next = () => {
    if (mode === 'talk_interviews') {
      const avoid = new Set(memory > 0 ? recent.slice(-memory) : []);
      let pool = items.filter((i) => !avoid.has(i.id));
      if (!pool.length) pool = items;
      const it = pickOne(pool);
      recent.push(it.id);
      return it;
    }
    const keys = [...groups.keys()];
    let k;
    if (mode === 'talk_audiobooks' && last) {
      const g = groups.get(keyOf(last));
      const i = g ? g.indexOf(last) : -1;
      if (g && i >= 0 && i < g.length - 1) { last = g[i + 1]; lastIdx.set(keyOf(last), i + 1); return last; } // next chapter of the same book
    }
    const lastKey = last ? keyOf(last) : null;
    const pool = keys.length > 1 ? keys.filter((x) => x !== lastKey) : keys;
    k = pickOne(pool);
    const g = groups.get(k);
    // audiobooks start a new book at chapter one; podcasts continue where that show left off
    const idx = mode === 'talk_audiobooks' ? 0 : lastIdx.has(k) ? (lastIdx.get(k) + 1) % g.length : 0;
    lastIdx.set(k, idx);
    last = g[idx];
    return last;
  };

  const insProg = db.prepare('INSERT INTO programmes(channel_id,item_id,start,end) VALUES(?,?,?,?)');
  const insBlock = db.prepare("INSERT INTO blocks(channel_id,programme_id,kind,item_id,ad_id,in_point,start,end) VALUES(?,?,'content',?,NULL,0,?,?)");
  tx(db, () => {
    while (t < horizon) {
      const it = next();
      const progId = Number(insProg.run(ch.id, it.id, t, t + it.runtime).lastInsertRowid);
      insBlock.run(ch.id, progId, it.id, t, t + it.runtime);
      t += it.runtime;
    }
  });
}

function planContext(db) {
  const settings = getSettings(db);
  const ads = settings.adsEnabled
    ? db.prepare("SELECT id, duration, kind, title, file FROM ads WHERE status='ready' AND duration >= 3").all().map((a) => ({ ...a, year: guessAdYear(`${a.title} ${a.file}`) }))
    : [];
  // the user's own station idents / bumpers (library type "ads_idents"): short clips played before programmes instead of the generated card
  const idents = settings.identsEnabled ? db.prepare("SELECT id, duration FROM ads WHERE status='ready' AND kind='ident' AND duration BETWEEN 1 AND 20").all() : [];
  return { settings, ads, idents };
}
function extendOne(db, c, ctx, now) {
  const pool = ctx.ads.filter((a) => a.kind === 'all' || a.kind === c.kind); // TV ads on TV channels, trailers on movie channels
  extendChannel(db, c, ctx.settings, pool, now, now + HORIZON_HOURS * 3600, ctx.idents);
}
function prune(db, now) {
  const cutoff = now - 3 * 3600;
  db.prepare('DELETE FROM programmes WHERE end < ?').run(cutoff);
  db.prepare('DELETE FROM blocks WHERE end < ?').run(cutoff);
  db.prepare('DELETE FROM promos WHERE id NOT IN (SELECT promo_id FROM blocks WHERE promo_id IS NOT NULL)').run();
}

/** Synchronous, for ONE channel (used by a broadcaster that finds a hole in its schedule). */
export function ensureChannelSchedule(db, channelId, now = Date.now() / 1000) {
  const c = db.prepare("SELECT id, kind FROM channels WHERE id=? AND enabled=1 AND item_count>0 AND kind<>'live'").get(channelId);
  if (c) extendOne(db, c, planContext(db), now);
}

let planning = null;
/** Plans every channel, one at a time, yielding to the event loop in between so the web server stays responsive. */
export function ensureSchedule(db, now = Date.now() / 1000) {
  if (planning) return planning;
  planning = (async () => {
    try {
      const ctx = planContext(db);
      const chans = db.prepare("SELECT id, kind FROM channels WHERE enabled=1 AND item_count>0 AND kind<>'live'").all();
      for (const c of chans) {
        // one channel with odd data must never stop every channel after it from being planned
        try { extendOne(db, c, ctx, now); } catch (e) { console.error(`[plan] channel ${c.id} could not be planned: ${e?.message || e}`); }
        await new Promise((r) => setImmediate(r));
      }
      prune(db, now);
    } finally { planning = null; }
  })();
  return planning;
}

/** Throw away everything that hasn't aired yet and regenerate (after setting/library changes). */
export async function rescheduleFuture(db, now = Date.now() / 1000, channelIds = null) {
  if (planning) await planning; // never delete underneath a running plan
  tx(db, () => {
    const only = channelIds ? ` AND channel_id IN (${channelIds.map(Number).join(',') || 'NULL'})` : '';
    db.prepare('DELETE FROM programmes WHERE start > ?' + only).run(now);
    db.prepare('DELETE FROM blocks WHERE start > ? AND programme_id IS NULL' + only).run(now); // stray ad breaks
  });
  await ensureSchedule(db, now);
}

export function getBlockAt(db, channelId, t) {
  return db.prepare(`SELECT b.*, COALESCE(i.path, a.file) AS file, i.kind AS item_kind, i.title AS m_title, i.artist AS m_artist, i.album AS m_album,
      i.poster AS m_poster, i.runtime AS m_runtime, i.year AS m_year, i.genres AS m_genres FROM blocks b
    LEFT JOIN items i ON i.id = b.item_id LEFT JOIN ads a ON a.id = b.ad_id
    WHERE b.channel_id=? AND b.start<=? AND b.end>? ORDER BY b.start DESC LIMIT 1`).get(channelId, t, t);
}
