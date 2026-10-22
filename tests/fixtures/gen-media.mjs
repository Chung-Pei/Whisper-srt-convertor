// 純 Node 的 WAV 生成器（PCM16、分塊寫入、無外部相依）。
//   node tests/fixtures/gen-media.mjs            # 產生標準集到 tests/fixtures/generated/
//   PERF_HEAVY=1 node tests/fixtures/gen-media.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { signalAt } from './signal.mjs';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'generated');

export function genWav(file, { seconds, rate, channels }) {
  const total = Math.round(seconds * rate), bytes = total * channels * 2;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, 'w');
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + bytes, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(channels, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * channels * 2, 28); h.writeUInt16LE(channels * 2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(bytes, 40); fs.writeSync(fd, h);
  const BLK = 1 << 16;
  for (let s0 = 0; s0 < total; s0 += BLK) {
    const n = Math.min(BLK, total - s0), buf = Buffer.alloc(n * channels * 2);
    for (let i = 0; i < n; i++) {
      const q = Math.max(-32768, Math.min(32767, Math.round(signalAt((s0 + i) / rate) * 32767)));
      for (let c = 0; c < channels; c++) buf.writeInt16LE(q, (i * channels + c) * 2);
    }
    fs.writeSync(fd, buf);
  }
  fs.closeSync(fd);
}

export const STANDARD = {
  'mono16k-60s.wav':   { seconds: 60,   rate: 16000, channels: 1 },
  'mono48k-60s.wav':   { seconds: 60,   rate: 48000, channels: 1 },
  'st44k-60s.wav':     { seconds: 60,   rate: 44100, channels: 2 },
  'st44k-4min.wav':    { seconds: 240,  rate: 44100, channels: 2 },
  'mono16k-10min.wav': { seconds: 600,  rate: 16000, channels: 1 },
  'st44k-10min.wav':   { seconds: 600,  rate: 44100, channels: 2 },
  'mono16k-1h.wav':    { seconds: 3600, rate: 16000, channels: 1 },
};
export const HEAVY = {
  'st44k-30min.wav': { seconds: 1800, rate: 44100, channels: 2 },
  'st44k-1h.wav':    { seconds: 3600, rate: 44100, channels: 2 },
};

export function ensureMedia(names, set = STANDARD) {
  for (const n of names) {
    const f = path.join(OUT, n), spec = { ...STANDARD, ...HEAVY }[n];
    if (!spec) throw new Error('unknown media ' + n);
    if (!fs.existsSync(f)) genWav(f, spec);
  }
  return names.map((n) => path.join(OUT, n));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const sets = process.env.PERF_HEAVY ? { ...STANDARD, ...HEAVY } : STANDARD;
  const names = args.length ? args : Object.keys(sets);
  ensureMedia(names);
  console.log('media ready:', names.join(', '));
}
