import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { judgeUpload, looksStill } from '../src/stillcheck.js';

const haveFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

test('uploads that are not music videos are recognised from their metadata', () => {
  assert.match(judgeUpload({ title: 'Morrissey - Suedehead', channel: 'Morrissey - Topic' }), /Topic/);
  assert.match(judgeUpload({ title: 'Suedehead', description: 'Provided to YouTube by Parlophone\n\nSuedehead · Morrissey' }), /auto-generated/);
  assert.match(judgeUpload({ title: 'Morrissey - Viva Hate (Full Album)' }), /full-album/);
  assert.match(judgeUpload({ title: 'Morrissey - Suedehead (Lyrics)' }), /lyric/);
  assert.match(judgeUpload({ title: 'Morrissey - Suedehead (Official Audio)' }), /lyric \/ audio/);
});

test('real music videos pass, even when the title mentions audio or lyrics alongside "official video"', () => {
  assert.equal(judgeUpload({ title: 'Morrissey - Suedehead (Official Music Video)', channel: 'MorrisseyVEVO' }), null);
  assert.equal(judgeUpload({ title: 'Hole - Celebrity Skin (Official Video)' }), null);
  assert.equal(judgeUpload({ title: 'Joy Division - Love Will Tear Us Apart', channel: 'Joy Division' }), null);
  assert.equal(judgeUpload({}), null); // nothing known: not rejected
});

test('a still image with audio is detected, real motion and a different clip are not', { skip: !haveFfmpeg }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wbtv-still-'));
  const ff = (...a) => assert.equal(spawnSync('ffmpeg', ['-v', 'error', '-y', ...a]).status, 0);
  const audio = ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=40'];
  const enc = ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest'];
  // a real video: moving test pattern
  ff('-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25:duration=40', ...audio, ...enc, path.join(dir, 'real.mp4'));
  // "album cover with audio": one picture, held
  ff('-f', 'lavfi', '-i', 'color=c=0x2a6b5f:size=320x180:rate=25:duration=40', ...audio, ...enc, path.join(dir, 'still.mp4'));
  // a slideshow of covers that changes every 10 seconds
  ff('-f', 'lavfi', '-i', 'color=c=red:size=320x180:rate=25:duration=10', '-f', 'lavfi', '-i', 'color=c=green:size=320x180:rate=25:duration=10', '-f', 'lavfi', '-i', 'color=c=blue:size=320x180:rate=25:duration=10',
    '-f', 'lavfi', '-i', 'color=c=yellow:size=320x180:rate=25:duration=10', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=40',
    '-filter_complex', '[0:v][1:v][2:v][3:v]concat=n=4:v=1:a=0[v]', '-map', '[v]', '-map', '4:a', ...enc, path.join(dir, 'slides.mp4'));
  const real = await looksStill(path.join(dir, 'real.mp4'));
  const still = await looksStill(path.join(dir, 'still.mp4'));
  const slides = await looksStill(path.join(dir, 'slides.mp4'));
  assert.equal(real.still, false, `real video: ${JSON.stringify(real)}`);
  assert.equal(still.still, true, `still: ${JSON.stringify(still)}`);
  assert.equal(slides.still, true, `slideshow: ${JSON.stringify(slides)}`);
  assert.ok(real.fraction > 0.5);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a file that cannot be judged is never rejected', async () => {
  const f = path.join(os.tmpdir(), 'wbtv-not-a-video.mp4');
  fs.writeFileSync(f, 'not a video');
  const r = await looksStill(f);
  assert.equal(r.still, false);
  fs.rmSync(f, { force: true });
});
