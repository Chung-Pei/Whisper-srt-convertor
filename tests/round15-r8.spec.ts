// tests/round15-r8.spec.ts — v24 r8：記憶體與穩定度、人聲分離（UVR）優化
//   R8-01  UVR 分塊就地分離（inPlace）與一般版逐位元相同（正式設定與小設定、含接縫與尾端）
//   R8-02  mixToMono 就地降混：與舊版演算法逐位元相同，回傳第 0 聲道本身（不另配陣列）
//   R8-03  預設是否試 WebGPU：低記憶體等級＋medium／large 不試；某模型 GPU 失敗後本次工作階段不再試（以模型區分）
//   R8-04  Whisper：WebGPU 建 session 失敗 → 終止 Worker、建新 Worker 以 WASM 重載，辨識照常完成
//   R8-05  人聲分離在載入 Whisper 模型之前執行（首個檔案的記憶體峰值不疊加）
//   R8-06  UVR WebGPU：建 session 失敗／推論失敗／與 WASM 結果不一致 → 改回 WASM，結果與純 WASM 相同；一致時沿用 GPU
//   R8-07  UVR：讀不出長度且檔案大於「長度上限 × 128 kbps」→ 略過，不解碼、不建 Worker
// 全部離線：函式庫、ORT、模型皆為替身（page.route）。真實瀏覽器 WebGPU 硬體未在此驗證。
import { test, expect, type Page } from '@playwright/test';
import { createHash } from 'crypto';
import { newCtx, openWithHook, exposeInternals, installScriptedWorker, buildSegments, BASE_URL } from './harness';
import { SAMPLE_AUDIO, setToggles, recognize } from './helpers';

const MODEL_URL = 'https://huggingface.co/fudan-generative-ai/hallo/resolve/main/audio_separator/Kim_Vocal_2.onnx';
const ORT_URL = '**/onnxruntime-web@1.30.0/dist/ort.all.min.js';
const FAKE_MODEL = Buffer.alloc(4096, 7);
const USE_FAKE_MODEL = `UVR_MODEL_BYTES = ${FAKE_MODEL.length}; UVR_MODEL_SHA256 = '${createHash('sha256').update(FAKE_MODEL).digest('hex')}'`;

function makeWav(seconds: number, rate = 44100): Buffer {
  const n = Math.round(seconds * rate), data = Buffer.alloc(n * 4);
  for (let j = 0; j < n; j++) {
    data.writeInt16LE(Math.round((0.5 * Math.sin(2 * Math.PI * 440 * j / rate)) * 32767), j * 4);
    data.writeInt16LE(Math.round((0.4 * Math.sin(2 * Math.PI * 523.25 * j / rate)) * 32767), j * 4 + 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); h.writeUInt16LE(2, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 4, 28);
  h.writeUInt16LE(4, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

// ── R8-01／R8-02：純函式 ─────────────────────────────────────────────
test.describe('r8：純函式', () => {
  test.setTimeout(180_000);

  test('R8-01 UVR separate(inPlace) 與一般版逐位元相同；輸出寫回輸入陣列', async ({ browser }) => {
    const page = await openWithHook(await newCtx(browser), ['uvrCreateDsp'], 'new');
    const r = await page.evaluate(async () => {
      const T = (window as any).__t, out: any[] = [];
      const model = async (x: Float32Array) => { const o = new Float32Array(x.length); for (let k = 0; k < x.length; k++) o[k] = x[k] * 0.5 + 0.01 * Math.tanh(x[k]); return o; };
      for (const [cfg, lens] of [[[7680, 1024, 3072, 256], [1000, 253440, 253441, 600000]], [[64, 8, 30, 40], [5, 100, 301, 1000]]] as any) {
        const dsp = T.uvrCreateDsp(...cfg);
        for (const n of lens) {
          const L = new Float32Array(n), R = new Float32Array(n); let seed = 7;
          for (let i = 0; i < n; i++) { seed = (seed * 1103515245 + 12345) >>> 0; L[i] = Math.sin(i * 0.01) + (seed / 4294967296 - 0.5) * 0.3; R[i] = Math.cos(i * 0.013) * 0.5; }
          const a = await dsp.separate(L.slice(), R.slice(), model, null);
          const L2 = L.slice(), R2 = R.slice();
          const b = await dsp.separate(L2, R2, model, null, { inPlace: true });
          let diff = 0; for (let i = 0; i < n; i++) if (a.left[i] !== b.left[i] || a.right[i] !== b.right[i]) diff++;
          out.push({ n, diff, same: b.left === L2 && b.right === R2, rms: a.rmsIn === b.rmsIn && a.rmsOut === b.rmsOut, count: a.count === b.count });
        }
      }
      return out;
    });
    for (const x of r) { expect(x, JSON.stringify(x)).toEqual({ n: x.n, diff: 0, same: true, rms: true, count: true }); }
  });

  test('R8-02 mixToMono 就地降混：與舊演算法逐位元相同、回傳第 0 聲道本身；單聲道原樣回傳', async ({ browser }) => {
    const page = await openWithHook(await newCtx(browser), ['mixToMono'], 'new');
    const r = await page.evaluate(() => {
      const T = (window as any).__t, res: any[] = [];
      for (const nCh of [1, 2, 3, 6]) {
        const n = 4097, buf = new AudioBuffer({ length: n, numberOfChannels: nCh, sampleRate: 16000 });
        for (let c = 0; c < nCh; c++) { const d = buf.getChannelData(c); for (let i = 0; i < n; i++) d[i] = Math.sin(i * 0.37 * (c + 1)) * 0.3 + c * 1e-3; }
        const ref = new Float32Array(n);                     // 舊版：另配陣列、從 0 累加
        for (let c = 0; c < nCh; c++) { const d = buf.getChannelData(c); for (let i = 0; i < n; i++) ref[i] += d[i]; }
        for (let i = 0; i < n; i++) ref[i] /= nCh;
        const m = T.mixToMono(buf);
        let diff = 0; for (let i = 0; i < n; i++) if (m[i] !== ref[i]) diff++;
        res.push({ nCh, diff, isCh0: m === buf.getChannelData(0) });
      }
      return res;
    });
    for (const x of r) expect(x, JSON.stringify(x)).toEqual({ nCh: x.nCh, diff: 0, isCh0: true });
  });
});

// ── R8-03：WebGPU 預設政策 ────────────────────────────────────────────
test('R8-03 預設是否試 WebGPU：低記憶體＋medium／large 不試；GPU 失敗過的模型本次不再試（其他模型不受影響）', async ({ browser }) => {
  const res: any = {};
  for (const mem of [8, 2]) {
    const ctx = await newCtx(browser);
    await ctx.addInitScript((m) => {
      Object.defineProperty(navigator, 'deviceMemory', { get: () => m, configurable: true });
      Object.defineProperty(navigator, 'gpu', { get: () => ({ requestAdapter: async () => ({}) }), configurable: true });
    }, mem);
    const page = await openWithHook(ctx, ['buildLoadModelPayload', 'markGpuFailed', 'detectMemoryTier'], 'new');
    res[mem] = await page.evaluate(() => {
      const T = (window as any).__t, p = (id: string) => T.buildLoadModelPayload(id, 'q8').preferGpu;
      const before = { tier: T.detectMemoryTier().tier, base: p('Xenova/whisper-base'), medium: p('Xenova/whisper-medium'), large: p('onnx-community/whisper-large-v3-turbo') };
      T.markGpuFailed('Xenova/whisper-base', 'test');
      T.markGpuFailed('Xenova/whisper-base', 'test');        // 第二次不重複記錄
      const after = { base: p('Xenova/whisper-base'), small: p('Xenova/whisper-small'), explicit: T.buildLoadModelPayload('Xenova/whisper-base', 'q8', { preferGpu: true }).preferGpu };
      const logs = (document.getElementById('logBox')!.textContent || '').split('在 WebGPU 上失敗').length - 1;
      return { before, after, logs };
    });
    await ctx.close();
  }
  expect(res[8].before).toEqual({ tier: 'standard', base: true, medium: true, large: true });
  expect(res[2].before).toEqual({ tier: 'low', base: true, medium: false, large: false });
  for (const m of [8, 2]) { expect(res[m].after).toEqual({ base: false, small: true, explicit: true }); expect(res[m].logs).toBe(1); }
});

// ── R8-04：Whisper WebGPU 建 session 失敗 → 新 Worker＋WASM ────────────────
test('R8-04 Whisper：WebGPU 建 session 失敗 → 終止該 Worker、建新 Worker 以 WASM 重載；辨識完成', async ({ page }) => {
  test.setTimeout(120_000);
  const stubLib = `
    try { Object.defineProperty(WorkerNavigator.prototype, 'gpu', { get: () => ({ requestAdapter: async () => ({}) }), configurable: true }); } catch (_) {}
    export const env = {};
    export const ModelRegistry = { get_available_dtypes: async () => ['fp32', 'q8', 'q4'] };
    export async function pipeline(task, id, opts) {
      if (opts.device === 'webgpu') throw new Error('fake webgpu session failed');
      const fn = async () => ({ chunks: [{ text: '測試', timestamp: [0, 1] }] });
      fn.dispose = async () => {};
      return fn;
    }`;
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'gpu', { get: () => ({ requestAdapter: async () => ({}) }), configurable: true });
    const w = window as any; w.__loads = []; w.__workers = []; w.__backend = [];
    const RealWorker = window.Worker;
    w.Worker = class extends RealWorker {
      constructor(u: any, o: any) {
        super(u, o); const rec = { terminated: false }; w.__workers.push(rec);
        const t = this.terminate.bind(this); this.terminate = () => { rec.terminated = true; t(); };
        this.addEventListener('message', (e: any) => { if (e.data?.type === 'BACKEND') w.__backend.push(e.data.payload.backend); });
      }
      postMessage(m: any, tr?: any) { if (m?.type === 'LOAD_MODEL') w.__loads.push({ worker: w.__workers.length, preferGpu: m.payload.preferGpu }); return tr ? super.postMessage(m, tr) : super.postMessage(m); }
    };
  });
  for (const re of [/cdn\.jsdelivr\.net\/npm\/@huggingface\/transformers@[^/]+\/dist\/transformers\.min\.js/, /unpkg\.com\/@huggingface\/transformers@[^/]+\/dist\/transformers\.min\.js/]) {
    await page.route(re, (r) => r.fulfill({ contentType: 'application/javascript', body: stubLib }));
  }
  await page.route('**/opencc-js@*/dist/umd/cn2t.js', (r) => r.fulfill({ contentType: 'application/javascript', body: 'window.OpenCC = { Converter: () => (t) => t };' }));
  await recognize(page);
  await setToggles(page, [], ['tog_vad', 'tog_uvr', 'tog_diarization']);
  await page.locator('#fileInput').setInputFiles(SAMPLE_AUDIO);
  await page.locator('#startBtn').click();
  await expect(page.locator('.batch-item.done')).toHaveCount(1, { timeout: 90_000 });
  const r = await page.evaluate(() => ({ loads: (window as any).__loads, workers: (window as any).__workers, backend: (window as any).__backend, log: document.getElementById('logBox')!.textContent }));
  expect(r.loads).toEqual([{ worker: 1, preferGpu: true }, { worker: 2, preferGpu: false }]);
  expect(r.workers[0].terminated).toBe(true);                 // 失敗的 Worker 被終止（唯一能釋放其記憶體的方法）
  expect(r.workers.length).toBe(2);
  expect(r.backend).toEqual(['webgpu', 'wasm']);
  expect(r.log).toContain('fake webgpu session failed');
  expect(r.log).toContain('在 WebGPU 上失敗');
  expect(await page.locator('#statModel').textContent()).toBe('CPU');
});

// ── 共用：UVR 替身 ORT ───────────────────────────────────────────────
type GpuMode = 'none' | 'ok' | 'create-fail' | 'run-fail' | 'mismatch';
const fakeOrt = (gpu: GpuMode) => `
${gpu === 'none' ? '' : "try { Object.defineProperty(WorkerNavigator.prototype, 'gpu', { get: () => ({}), configurable: true }); } catch (_) {}"}
self.__sessions = [];
self.ort = { env: { wasm: {} },
  Tensor: class { constructor(t, d, dims) { this.type = t; this.data = d; this.dims = dims; } dispose() {} },
  InferenceSession: { create: async (model, opts) => {
    const ep = opts.executionProviders[0]; self.__sessions.push(ep);
    if (ep === 'webgpu' && ${JSON.stringify(gpu)} === 'create-fail') throw new Error('fake gpu create failed');
    return { inputNames: ['input'], outputNames: ['output'], release: async () => {}, run: async (feeds) => {
      if (ep === 'webgpu' && ${JSON.stringify(gpu)} === 'run-fail') throw new Error('fake gpu run failed');
      const k = ep === 'webgpu' && ${JSON.stringify(gpu)} === 'mismatch' ? 0.4 : 0.5;
      const t = feeds.input, out = new Float32Array(t.data.length);
      for (let i = 0; i < out.length; i++) out[i] = t.data[i] * k;
      return { output: new self.ort.Tensor('float32', out, t.dims.slice()) };
    } }; } } };
`;

async function setupUvr(page: Page, gpu: GpuMode) {
  const hits = { model: 0 };
  await page.addInitScript(() => Object.defineProperty(navigator, 'deviceMemory', { get: () => 8, configurable: true }));
  // 'none'：明確移除 navigator.gpu（新版 headless Chromium 本身可能就有 navigator.gpu）
  if (gpu === 'none') await page.addInitScript(() => Object.defineProperty(navigator, 'gpu', { get: () => undefined, configurable: true }));
  else await page.addInitScript(() => Object.defineProperty(navigator, 'gpu', { get: () => ({ requestAdapter: async () => ({}) }), configurable: true }));
  await page.addInitScript((c) => { (window as any).__USE_FAKE = c; }, USE_FAKE_MODEL);
  await page.addInitScript(() => {      // 旁聽 UVR Worker 的 SEPARATE 結果中的 backend
    const Prev = window.Worker as any; (window as any).__uvr = [];
    (window as any).Worker = function (u: any, o: any) {
      const w = new Prev(u, o);
      if (o && o.name === 'uvr') w.addEventListener('message', (e: any) => { if (e.data?.type === 'READY' || e.data?.type === 'DONE') (window as any).__uvr.push({ type: e.data.type, backend: e.data.payload?.backend, reason: e.data.payload?.gpuFallbackReason ?? null }); });
      return w;
    };
  });
  await page.route(ORT_URL, (r) => r.fulfill({ contentType: 'application/javascript', body: fakeOrt(gpu) }));
  await page.route(MODEL_URL, (r) => { hits.model++; return r.fulfill({ status: 200, contentType: 'application/octet-stream', headers: { 'access-control-allow-origin': '*' }, body: FAKE_MODEL }); });
  await exposeInternals(page, ['runVocalSeparation', 'detectMemoryTier'], 'new');
  await page.goto(BASE_URL); await page.waitForFunction(() => !!(window as any).__t);
  return hits;
}

// ── R8-05：人聲分離在 Whisper 載入之前 ─────────────────────────────────
test('R8-05 開啟人聲分離：UVR Worker 在 Whisper Worker 建立（載入模型）之前就已建立並結束', async ({ browser }) => {
  test.setTimeout(180_000);
  const ctx = await newCtx(browser); const page = await ctx.newPage();
  await page.addInitScript(() => { (window as any).__RealWorker = window.Worker; });
  const segs = await buildSegments(ctx, { segments: 2, linesPerSegment: 3, charsPerLine: 14, termRate: 0.1, seed: 3 });
  await installScriptedWorker(page, { segments: segs });
  await page.addInitScript(() => {
    const Fake = window.Worker as any, Real = (window as any).__RealWorker, w = window as any; w.__order = [];
    w.Worker = class { constructor(u: any, o: any) {
      if (o && o.name === 'uvr') { const r = new Real(u, o); w.__order.push('uvr:new'); const t = r.terminate.bind(r); r.terminate = () => { w.__order.push('uvr:end'); t(); }; return r; }
      w.__order.push('whisper:new'); return new Fake(u, o);
    } };
  });
  await setupUvr(page, 'none');
  await page.evaluate(() => (window as any).__t.evalIn((window as any).__USE_FAKE));
  await page.locator('.model-btn[data-model="Xenova/whisper-base"]').click();
  await setToggles(page, ['tog_uvr'], ['tog_vad']);
  await page.locator('#fileInput').setInputFiles({ name: 'lecture.wav', mimeType: 'audio/wav', buffer: makeWav(14) });
  await page.locator('#startBtn').click();
  await expect(page.locator('.batch-item.done')).toHaveCount(1, { timeout: 120_000 });
  const order: string[] = await page.evaluate(() => (window as any).__order);
  expect(order.slice(0, 3), order.join(',')).toEqual(['uvr:new', 'uvr:end', 'whisper:new']);
  expect(await page.locator('#logBox').textContent()).toContain('人聲分離完成');
});

// ── R8-06：UVR WebGPU 與 WASM 後備 ──────────────────────────────────────
test.describe('r8：UVR WebGPU', () => {
  test.setTimeout(180_000);
  const cases: { gpu: GpuMode; backend: string; sessions: string[]; failed: boolean }[] = [
    { gpu: 'none',        backend: 'wasm',   sessions: ['wasm'],                   failed: false },
    { gpu: 'ok',          backend: 'webgpu', sessions: ['webgpu', 'wasm'],         failed: false },   // 第二個 wasm＝第一段比對用
    { gpu: 'create-fail', backend: 'wasm',   sessions: ['webgpu', 'wasm'],         failed: true },
    { gpu: 'run-fail',    backend: 'wasm',   sessions: ['webgpu', 'wasm'],         failed: true },
    { gpu: 'mismatch',    backend: 'wasm',   sessions: ['webgpu', 'wasm', 'wasm'], failed: true },
  ];
  for (const c of cases) {
    test(`R8-06 ${c.gpu}：後端 ${c.backend}、人聲＝輸入×0.5（與純 WASM 相同）`, async ({ browser }) => {
      const ctx = await newCtx(browser); const page = await ctx.newPage();
      await setupUvr(page, c.gpu);
      const b64 = makeWav(8).toString('base64');
      const r: any = await page.evaluate(async (b64) => {
        const T = (window as any).__t; T.evalIn((window as any).__USE_FAKE);
        const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
        const res = await T.runVocalSeparation(new File([bytes], 'a.wav', { type: 'audio/wav' }));
        const log = document.getElementById('logBox')!.textContent || '';
        if (!res) return { ok: false, log };
        const v = new DataView(await res.wavBlob.arrayBuffer()); let e = 0;
        for (let i = 9000; i < 300000; i += 101) e = Math.max(e, Math.abs(v.getInt16(44 + i * 4, true) / 32768 - 0.25 * Math.sin(2 * Math.PI * 440 * i / 44100)));
        return { ok: true, e, log, uvr: (window as any).__uvr };
      }, b64);
      expect(r.ok, r.log).toBe(true);
      expect(r.e).toBeLessThan(3e-3);
      const done = r.uvr.find((x: any) => x.type === 'DONE');
      expect(done.backend).toBe(c.backend);
      expect(r.log).toContain(c.gpu === 'ok' ? '人聲分離後端：⚡ WebGPU' : c.gpu === 'run-fail' || c.gpu === 'mismatch' ? '人聲分離後端：⚡ WebGPU' : '人聲分離後端：CPU（WASM）');
      expect(r.log.includes('Kim_Vocal_2.onnx 在 WebGPU 上失敗')).toBe(c.failed);
      if (c.gpu === 'mismatch') expect(r.log).toContain('SNR');
    });
  }
});

// ── R8-07：讀不出長度的大檔 ─────────────────────────────────────────────
test('R8-07 UVR：讀不出長度且檔案 > 長度上限×128 kbps → 略過；不下載模型、不建 Worker', async ({ browser }) => {
  const ctx = await newCtx(browser); const page = await ctx.newPage();
  const hits = await setupUvr(page, 'none');
  const r = await page.evaluate(async () => {
    const T = (window as any).__t;
    T.evalIn('probeMediaDuration = async () => NaN');
    const big = await T.runVocalSeparation(new File([new Uint8Array(20 * 1024 * 1024)], 'x.m4a'));
    return { big, log: document.getElementById('logBox')!.textContent || '', limit: T.evalIn('UVR_MAX_UNKNOWN_BYTES') };
  });
  expect(r.big).toBeNull();
  expect(r.limit).toBe(1200 * 16000);
  expect(r.log).toContain('無法判斷長度且檔案過大');
  expect(hits.model).toBe(0);
});
