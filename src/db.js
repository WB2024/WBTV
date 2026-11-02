import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS libraries (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL, last_scan INTEGER
);
CREATE TABLE IF NOT EXISTS shows (
  id INTEGER PRIMARY KEY, library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  path TEXT NOT NULL UNIQUE, title TEXT, plot TEXT, year INTEGER, rating REAL, mpaa TEXT,
  studios TEXT DEFAULT '[]', genres TEXT DEFAULT '[]', poster TEXT
);
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY, library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  show_id INTEGER REFERENCES shows(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, path TEXT NOT NULL UNIQUE, title TEXT, plot TEXT, year INTEGER,
  season INTEGER, episode INTEGER, aired TEXT, rating REAL, mpaa TEXT,
  runtime REAL DEFAULT 0, probed INTEGER DEFAULT 0,
  studios TEXT DEFAULT '[]', genres TEXT DEFAULT '[]', actors TEXT DEFAULT '[]',
  poster TEXT, mtime REAL, size REAL, nfo_mtime REAL, channel_id INTEGER, artist TEXT, album TEXT
);
CREATE TABLE IF NOT EXISTS live_streams (
  id INTEGER PRIMARY KEY, library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  name TEXT, url TEXT NOT NULL, grp TEXT, logo TEXT, tvg_id TEXT, src_kind TEXT DEFAULT 'hls',
  alive INTEGER, checked REAL, channel_id INTEGER, UNIQUE(library_id, url)
);
CREATE INDEX IF NOT EXISTS idx_items_channel ON items(channel_id);
CREATE INDEX IF NOT EXISTS idx_items_lib ON items(library_id);
CREATE TABLE IF NOT EXISTS channels (
  id INTEGER PRIMARY KEY, key TEXT NOT NULL UNIQUE, kind TEXT NOT NULL,
  auto_name TEXT NOT NULL, name_override TEXT, number INTEGER, enabled INTEGER DEFAULT 1,
  item_count INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS channel_items (
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  PRIMARY KEY (channel_id, item_id)
);
CREATE INDEX IF NOT EXISTS idx_ci_item ON channel_items(item_id);
CREATE TABLE IF NOT EXISTS ads (
  id INTEGER PRIMARY KEY, title TEXT, source TEXT UNIQUE, file TEXT,
  duration REAL DEFAULT 0, status TEXT DEFAULT 'pending', error TEXT, kind TEXT NOT NULL DEFAULT 'all',
  library_id INTEGER REFERENCES libraries(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS programmes (
  id INTEGER PRIMARY KEY, channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE, start REAL NOT NULL, end REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_prog ON programmes(channel_id, start);
CREATE TABLE IF NOT EXISTS blocks (
  id INTEGER PRIMARY KEY, channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  programme_id INTEGER REFERENCES programmes(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, item_id INTEGER REFERENCES items(id) ON DELETE CASCADE,
  ad_id INTEGER REFERENCES ads(id) ON DELETE CASCADE,
  in_point REAL NOT NULL DEFAULT 0, start REAL NOT NULL, end REAL NOT NULL, promo_id INTEGER
);
CREATE TABLE IF NOT EXISTS promos (
  id INTEGER PRIMARY KEY, segments TEXT NOT NULL, est REAL
);
CREATE INDEX IF NOT EXISTS idx_blocks ON blocks(channel_id, start);
CREATE INDEX IF NOT EXISTS idx_blocks_prog ON blocks(programme_id);
CREATE INDEX IF NOT EXISTS idx_blocks_ad ON blocks(ad_id);
CREATE INDEX IF NOT EXISTS idx_blocks_item ON blocks(item_id);
CREATE INDEX IF NOT EXISTS idx_prog_item ON programmes(item_id);
`;

export function openDb(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'wbtv.db'));
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

function migrate(db) {
  // older DBs: libraries.type had a CHECK that only allowed movies/tv/ads
  const lib = db.prepare("SELECT sql FROM sqlite_master WHERE name='libraries'").get();
  if (lib?.sql.includes('CHECK')) {
    db.exec('PRAGMA foreign_keys=OFF; BEGIN;');
    db.exec(`CREATE TABLE libraries_new (id INTEGER PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE, type TEXT NOT NULL, last_scan INTEGER);
      INSERT INTO libraries_new SELECT id,name,path,type,last_scan FROM libraries; DROP TABLE libraries; ALTER TABLE libraries_new RENAME TO libraries;`);
    db.exec('COMMIT; PRAGMA foreign_keys=ON;');
  }
  // older DBs: music/radio metadata on items
  const icols = db.prepare('PRAGMA table_info(items)').all().map((c) => c.name);
  if (!icols.includes('artist')) db.exec('ALTER TABLE items ADD COLUMN artist TEXT');
  if (!icols.includes('album')) db.exec('ALTER TABLE items ADD COLUMN album TEXT');
  // older DBs: blocks.promo_id (announcement slots)
  if (!db.prepare('PRAGMA table_info(blocks)').all().some((c) => c.name === 'promo_id')) db.exec('ALTER TABLE blocks ADD COLUMN promo_id INTEGER');
  // older DBs: ads.kind
  if (!db.prepare('PRAGMA table_info(ads)').all().some((c) => c.name === 'kind')) {
    db.exec("ALTER TABLE ads ADD COLUMN kind TEXT NOT NULL DEFAULT 'all'");
  }
}

export const tx = (db, fn) => {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
};

const DEFAULTS = {
  autoDaypart: true,       // lean towards what suits the time of day (kids after school, horror late, cartoons on Saturday morning)
  eraAds: true,            // prefer adverts from the same era as the programme (needs a year in the ad's title or folder name)
  channelBug: true,        // small channel logo (or name) in the corner of programmes
  identsEnabled: false,    // a short generated station ident before each programme
  signOffEnabled: false,   // "closedown": a test card overnight, like old TV
  signOffFrom: '03:00',
  signOffTo: '05:00',
  streamHeight: Number(process.env.WBTV_HEIGHT || 720), // 480 | 576 | 720: lower = much less CPU per stream
  hwEncoder: 'auto',       // auto | none | vaapi | nvenc (verified with a test encode, falls back to the CPU)
  pauseBufferMinutes: 10,  // how far back you can rewind / how long you can pause live TV (0 = off)
  autoScan: true,          // rescan libraries periodically
  scanIntervalMinutes: 60,
  scanOnStartup: true,
  promosEnabled: true,     // "coming up next" announcements between programmes
  promoVoice: 'alan',
  promoCount: 3,           // how many upcoming programmes to mention
  promoMaxSeconds: 60,
  promoReadPlots: true,
  adsEnabled: false,
  alignMinutes: 5,        // programmes start on this grid when ads are on
  breakEveryMinutes: 20,  // roughly one mid-programme break per N minutes
  breakLengthMinutes: 3,
  fillGaps: true,         // fill the gap up to the next grid line with adverts
  minChannelMinutes: 30,  // a studio/genre needs this much content to become a channel
  tvGenreChannelsForAll: false, // also give every TV show a genre channel, not just studio-less ones
  movieStudioChannels: true,
  movieStudioMinFilms: 5,
  movieDecadeChannels: true,
};
export function getSettings(db) {
  const out = { ...DEFAULTS };
  for (const r of db.prepare('SELECT key,value FROM settings').all()) {
    if (r.key in DEFAULTS) try { out[r.key] = JSON.parse(r.value); } catch { /* ignore */ }
  }
  return out;
}
export function setSettings(db, patch) {
  const st = db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  for (const [k, v] of Object.entries(patch)) if (k in DEFAULTS) st.run(k, JSON.stringify(v));
  return getSettings(db);
}
