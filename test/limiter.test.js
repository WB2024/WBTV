import test from 'node:test';
import assert from 'node:assert/strict';
import { makeLimiter } from '../src/tts.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('never runs more than the limit at once', async () => {
  const limit = makeLimiter(2);
  let running = 0, peak = 0;
  const job = async () => { running++; peak = Math.max(peak, running); await sleep(20); running--; };
  await Promise.all(Array.from({ length: 8 }, () => limit(job)));
  assert.equal(peak, 2);
});

test('jobs whose channel has gone are skipped without running', async () => {
  const limit = makeLimiter(1);
  let ran = 0;
  let alive = true;
  const slow = limit(async () => { await sleep(30); ran++; });
  const queued = Array.from({ length: 5 }, () => limit(async () => { ran++; }, () => alive).catch((e) => e.message));
  alive = false; // the viewer left while they were still waiting in the queue
  await slow;
  const results = await Promise.all(queued);
  assert.equal(ran, 1, 'only the job that was already running did any work');
  assert.deepEqual(results, ['cancelled', 'cancelled', 'cancelled', 'cancelled', 'cancelled']);
});

test('a failing job frees its slot', async () => {
  const limit = makeLimiter(1);
  await assert.rejects(limit(async () => { throw new Error('boom'); }), /boom/);
  assert.equal(await limit(async () => 'fine'), 'fine');
});
