// Hardware video encoding (optional). Filters stay on the CPU (scaling, captions); only the final H.264 encode moves to the GPU.
// Every choice is verified with a real test encode first, and we fall back to software x264 if it fails.
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { cfg } from './config.js';

const DRI = process.env.WBTV_VAAPI_DEVICE || '/dev/dri/renderD128';

/** What the broadcaster should use right now. `active` is 'software' | 'vaapi' | 'nvenc'. */
export const hw = { requested: 'auto', active: 'software', note: 'not checked yet', device: DRI };

const KEYFRAMES = ['-force_key_frames', 'expr:gte(t,n_forced*4)'];

export function videoCodec(seg, preset = cfg.preset) {
  switch (hw.active) {
    case 'vaapi':
      return ['-c:v', 'h264_vaapi', '-b:v', '3500k', '-maxrate', '5M', '-bufsize', '10M', '-profile:v', 'main', '-g', '100', ...KEYFRAMES];
    case 'nvenc':
      return ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', String(cfg.crf + 1), '-b:v', '0', '-maxrate', '5M', '-bufsize', '10M',
        '-profile:v', 'main', '-g', '100', '-forced-idr', '1', ...KEYFRAMES];
    default:
      return ['-c:v', 'libx264', '-preset', preset, '-crf', String(cfg.crf), '-maxrate', '5M', '-bufsize', '10M', '-profile:v', 'main',
        '-g', '100', '-keyint_min', '100', '-sc_threshold', '0', '-force_key_frames', `expr:gte(t,n_forced*${seg})`];
  }
}
/** Filter text appended after the last CPU filter so frames reach the encoder in the right form. */
export const videoTail = () => (hw.active === 'vaapi' ? ',format=nv12,hwupload' : '');
/** Global ffmpeg args that must come before the inputs. */
export const globalArgs = () => (hw.active === 'vaapi' ? ['-vaapi_device', hw.device] : []);

function testEncode(pre, vf, codec) {
  return new Promise((resolve) => {
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', ...pre, '-f', 'lavfi', '-i', 'color=c=black:s=1280x720:r=25:d=1', '-vf', vf, '-frames:v', '10', ...codec, '-f', 'null', '-'];
    const p = spawn(cfg.ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err = (err + d).slice(-400)));
    const t = setTimeout(() => p.kill('SIGKILL'), 15000);
    p.on('error', (e) => { err += String(e); });
    p.on('close', (code) => { clearTimeout(t); resolve(code === 0 ? '' : (err.trim().split('\n').pop() || 'failed')); });
  });
}

const tests = {
  vaapi: async () => {
    if (!fs.existsSync(hw.device)) return `no GPU device at ${hw.device} (pass /dev/dri into the container)`;
    return testEncode(['-vaapi_device', hw.device], 'format=nv12,hwupload', ['-c:v', 'h264_vaapi']);
  },
  nvenc: async () => {
    if (!fs.existsSync('/dev/nvidiactl')) return 'no NVIDIA device (needs the NVIDIA container runtime)';
    return testEncode([], 'format=yuv420p', ['-c:v', 'h264_nvenc']);
  },
};

/** Choose an encoder. mode: 'auto' | 'none' | 'vaapi' | 'nvenc'. */
export async function detectHw(mode = 'auto') {
  mode = process.env.WBTV_HWACCEL || mode || 'auto';
  hw.requested = mode;
  if (mode === 'none') { Object.assign(hw, { active: 'software', note: 'Hardware encoding is switched off.' }); return hw; }
  const order = mode === 'auto' ? ['vaapi', 'nvenc'] : [mode];
  const fails = [];
  for (const m of order) {
    if (!tests[m]) continue;
    const err = await tests[m]();
    if (!err) { Object.assign(hw, { active: m, note: `Using ${m === 'vaapi' ? 'VAAPI (Intel/AMD GPU)' : 'NVIDIA NVENC'}.` }); console.log(`[hw] encoder: ${m}`); return hw; }
    fails.push(`${m}: ${err}`);
  }
  Object.assign(hw, { active: 'software', note: mode === 'auto' ? 'No usable GPU found, using the CPU (x264).' : `${fails.join('; ')}. Using the CPU (x264).` });
  console.log(`[hw] encoder: software (${fails.join('; ') || 'no GPU'})`);
  return hw;
}
