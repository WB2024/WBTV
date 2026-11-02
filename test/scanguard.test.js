import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { safeRemovals } from '../src/scanner.js';

const fresh = () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');
  return db;
};
const lib = { id: 7, name: 'TV' };
const paths = (n, dir = '/mnt/tv/show') => Array.from({ length: n }, (_, i) => `${dir}/ep${i}.mkv`);

test('a few genuinely deleted files are removed straight away', () => {
  const db = fresh();
  const gone = paths(3);
  assert.deepEqual(safeRemovals(db, lib, gone, 100, 97, []), gone);
});

test('an offline share (nothing seen at all) removes nothing, then a second scan that agrees is believed', () => {
  const db = fresh();
  const all = paths(50);
  assert.deepEqual(safeRemovals(db, lib, all, 50, 0, []), [], 'first scan: keep everything');
  assert.deepEqual(safeRemovals(db, lib, all, 50, 0, []), all, 'second scan agrees: the library really is empty');
});

test('if the share comes back the next scan, the guard resets', () => {
  const db = fresh();
  const all = paths(50);
  assert.deepEqual(safeRemovals(db, lib, all, 50, 0, []), []);
  assert.deepEqual(safeRemovals(db, lib, paths(2), 50, 48, []), paths(2), 'normal scan: small removal goes through');
  assert.deepEqual(safeRemovals(db, lib, all, 50, 0, []), [], 'and a later outage is guarded afresh');
});

test('nothing under a folder that could not be read is removed', () => {
  const db = fresh();
  const gone = [...paths(5, '/mnt/tv/A'), ...paths(5, '/mnt/tv/B')];
  const out = safeRemovals(db, lib, gone, 200, 190, ['/mnt/tv/A']);
  assert.deepEqual(out, paths(5, '/mnt/tv/B'));
  assert.deepEqual(safeRemovals(db, lib, paths(1, '/mnt/tv/AB'), 200, 199, ['/mnt/tv/A']), paths(1, '/mnt/tv/AB'), 'a sibling with a similar name is not protected');
});

test('losing more than half of a sizeable library waits for confirmation', () => {
  const db = fresh();
  const gone = paths(60);
  assert.deepEqual(safeRemovals(db, lib, gone, 100, 40, []), []);
  assert.equal(safeRemovals(db, lib, gone, 100, 40, []).length, 60);
});

test('small libraries can lose files without ceremony', () => {
  const db = fresh();
  assert.deepEqual(safeRemovals(db, lib, paths(3), 4, 1, []), paths(3));
});
