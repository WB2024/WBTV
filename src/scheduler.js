import { tx, getSettings } from './db.js';

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

function makePicker(db, ch, items) {
  const hist = db.prepare('SELECT item_id FROM programmes WHERE channel_id=? ORDER BY start DESC LIMIT 400')
    .all(ch.id).map((r) => r.item_id).reverse();

  if (ch.kind === 'movie') {
    const recent = hist.slice();
    return () => {
      const n = Math.min(Math.floor(items.length / 2), 100);
      const recentSet = new Set(n > 0 ? recent.slice(-n) : []);
      let pool = items.filter((i) => !recentSet.has(i.id));
      if (!pool.length) pool = items;
      const it = pickOne(pool);
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
  return () => {
    const ids = [...shows.keys()];
    const pool = ids.length > 1 ? ids.filter((k) => k !== lastShow) : ids;
    const k = pickOne(pool);
    const eps = shows.get(k);
    const idx = lastIdx.has(k) ? (lastIdx.get(k) + 1) % eps.length : Math.floor(Math.random() * eps.length);
    lastIdx.set(k, idx);
    lastShow = k;
    return eps[idx];
  };
}

export const REEL = 600; // ads longer than this are "reels" (recorded ad breaks): we play a random chunk of one

/** Ad blocks filling `target` seconds. exact=true trims the last piece so the gap closes precisely. */
function fillAds(ads, target, exact, state) {
  const out = [];
  let filled = 0;
  const usedHere = new Set();
  while (exact ? target - filled > 1.5 : filled < target) {
    const remaining = target - filled;
    const free = (a) => !usedHere.has(a.id) && a.id !== state.lastAd;
    let pool = ads.filter((a) => free(a) && (!exact || a.duration <= remaining + 0.01 || a.duration > REEL));
    if (!pool.length && exact) pool = ads.filter(free); // nothing fits: trim one
    if (!pool.length) pool = ads; // tiny ad pools: allow repeats
    const ad = pickOne(pool);
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

function extendChannel(db, ch, settings, ads, now, horizon) {
  let t = db.prepare('SELECT MAX(end) AS m FROM blocks WHERE channel_id=?').get(ch.id).m;
  const floorHist = now - HISTORY_HOURS * 3600;
  if (t == null || t < floorHist) t = Math.floor(floorHist / 300) * 300;
  if (t >= horizon) return;

  const items = db.prepare('SELECT i.id, i.show_id, i.season, i.episode, i.path, i.runtime FROM items i JOIN channel_items ci ON ci.item_id=i.id WHERE ci.channel_id=? AND i.runtime>0').all(ch.id);
  if (!items.length) return;
  const pick = makePicker(db, ch, items);
  const insProg = db.prepare('INSERT INTO programmes(channel_id,item_id,start,end) VALUES(?,?,?,?)');
  const insBlock = db.prepare('INSERT INTO blocks(channel_id,programme_id,kind,item_id,ad_id,in_point,start,end) VALUES(?,?,?,?,?,?,?,?)');
  const useAds = ads.length > 0;
  const align = Math.max(1, settings.alignMinutes) * 60;
  const adState = { lastAd: null };

  tx(db, () => {
    while (t < horizon) {
      const item = pick();
      const D = item.runtime;

      // fill up to the next grid line with adverts so programmes start on the dot
      if (useAds && settings.fillGaps) {
        const gap = Math.ceil(t / align) * align - t;
        if (gap >= 15 && gap < align) {
          for (const { ad, len, inPoint } of fillAds(ads, gap, true, adState)) {
            insBlock.run(ch.id, null, 'ad', null, ad.id, inPoint, t, t + len); t += len;
          }
        }
      }

      // split into segments with ad breaks between
      let cuts = [];
      if (useAds && D >= 15 * 60) {
        const segs = Math.max(2, Math.round(D / (settings.breakEveryMinutes * 60)));
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
          for (const { ad, len: l, inPoint } of fillAds(ads, target, false, adState)) {
            insBlock.run(ch.id, progId, 'ad', null, ad.id, inPoint, t, t + l); t += l;
          }
        }
      }
      db.prepare('UPDATE programmes SET end=? WHERE id=?').run(t, progId);
    }
  });
}

function planContext(db) {
  const settings = getSettings(db);
  const ads = settings.adsEnabled
    ? db.prepare("SELECT id, duration, kind FROM ads WHERE status='ready' AND duration >= 3").all()
    : [];
  return { settings, ads };
}
function extendOne(db, c, ctx, now) {
  const pool = ctx.ads.filter((a) => a.kind === 'all' || a.kind === c.kind); // TV ads on TV channels, trailers on movie channels
  extendChannel(db, c, ctx.settings, pool, now, now + HORIZON_HOURS * 3600);
}
function prune(db, now) {
  const cutoff = now - 3 * 3600;
  db.prepare('DELETE FROM programmes WHERE end < ?').run(cutoff);
  db.prepare('DELETE FROM blocks WHERE end < ?').run(cutoff);
}

/** Synchronous, for ONE channel (used by a broadcaster that finds a hole in its schedule). */
export function ensureChannelSchedule(db, channelId, now = Date.now() / 1000) {
  const c = db.prepare('SELECT id, kind FROM channels WHERE id=? AND enabled=1 AND item_count>0').get(channelId);
  if (c) extendOne(db, c, planContext(db), now);
}

let planning = null;
/** Plans every channel, one at a time, yielding to the event loop in between so the web server stays responsive. */
export function ensureSchedule(db, now = Date.now() / 1000) {
  if (planning) return planning;
  planning = (async () => {
    try {
      const ctx = planContext(db);
      const chans = db.prepare('SELECT id, kind FROM channels WHERE enabled=1 AND item_count>0').all();
      for (const c of chans) {
        extendOne(db, c, ctx, now);
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
  return db.prepare(`SELECT b.*, COALESCE(i.path, a.file) AS file FROM blocks b
    LEFT JOIN items i ON i.id = b.item_id LEFT JOIN ads a ON a.id = b.ad_id
    WHERE b.channel_id=? AND b.start<=? AND b.end>? ORDER BY b.start DESC LIMIT 1`).get(channelId, t, t);
}
