import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { syncLiveChannels } from '../src/channels.js';

test('channels whose stream has gone are deleted and free their number', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wbtv-live-'));
  const db = openDb(dir);
  try {
    db.prepare("INSERT INTO libraries(id,name,path,type) VALUES(1,'News','http://example.test/list.m3u','iptv')").run();
    const ins = db.prepare("INSERT INTO live_streams(library_id,name,url,src_kind,alive) VALUES(1,?,?,'hls',1)");
    ins.run('Stream A', 'http://example.test/a.m3u8');
    ins.run('Stream B', 'http://example.test/b.m3u8');
    // a leftover from a playlist that has since been removed: a live channel with no stream behind it
    db.prepare("INSERT INTO channels(key,kind,auto_name,number,enabled,item_count) VALUES('live:999','live','Old stream',601,1,1)").run();

    syncLiveChannels(db);

    const keys = db.prepare("SELECT key FROM channels WHERE kind='live' ORDER BY key").all().map((r) => r.key);
    assert.equal(keys.includes('live:999'), false, 'the orphan is gone');
    assert.equal(keys.length, 2, 'both real streams have a channel');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM live_streams WHERE channel_id IS NOT NULL').get().n, 2);
    // running it again changes nothing
    syncLiveChannels(db);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM channels WHERE kind='live'").get().n, 2);
  } finally {
    db.close?.();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
