import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, setSettings } from '../src/db.js';
import { inferChannels } from '../src/channels.js';

test('radio sub-genres fold into one station, which keeps its name and number on a rebuild', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wbtv-names-'));
  const db = openDb(dir);
  try {
    db.prepare("INSERT INTO libraries(id,name,path,type) VALUES(1,'Radio','/music','radio')").run();
    setSettings(db, { minChannelMinutes: 1 });
    const ins = db.prepare("INSERT INTO items(library_id,kind,path,title,runtime,probed,genres) VALUES(1,'track',?,?,?,1,?)");
    let n = 0;
    for (const g of ['Jazz', 'Acid Jazz', 'Smooth Jazz']) for (let i = 0; i < 3; i++) ins.run(`/music/${g}/${i}.mp3`, `${g} ${i}`, 300, JSON.stringify([g]));

    inferChannels(db);
    const names = () => db.prepare("SELECT COALESCE(name_override,auto_name) n, number FROM channels WHERE item_count>0 ORDER BY number").all();
    const first = names();
    const radio = first.filter((c) => /Jazz/.test(c.n));
    assert.deepEqual(radio.map((c) => c.n), ['Jazz FM'], 'Jazz, Acid Jazz and Smooth Jazz are one station'); // radio sub-genres fold into their family
    assert.equal(db.prepare("SELECT item_count FROM channels WHERE kind='radio' AND item_count>0").get().item_count, 9);

    inferChannels(db); // a rebuild changes neither names nor numbers
    assert.deepEqual(names(), first);
  } finally {
    db.close?.();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
