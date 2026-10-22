// tests/round13-uvr.spec.ts — r6：UVR 人聲分離重做（MDX-Net Kim_Vocal_2）
// 規格（已用真實模型驗證）：模型輸入／輸出 [batch, 4, 3072, 256]；n_fft 7680、hop 1024；
// 通道順序 [L 實部, L 虛部, R 實部, R 虛部]；頻率軸取前 3072 格，其餘補零。
// 測試分層：
//   U-01～U-06  純函式（FFT、STFT／iSTFT、分塊、WAV、重取樣），含與 numpy 參考值逐值比對
//   U-07～U-12  真實 Worker＋假 ORT（模型：輸出＝輸入×0.5），驗證訊息協定、transfer、取消與各種失敗 fallback
//   U-13        完整 app 流程（假 Whisper Worker＋真實 UVR Worker）
//   U-14        真實模型（選用：UVR_REAL=1，需要 python3＋onnxruntime＋numpy＋Kim_Vocal_2.onnx）
import { test, expect, type Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { execFileSync, spawn, type ChildProcess } from 'child_process';
import { createHash } from 'crypto';
import { newCtx, openWithHook, exposeInternals, installScriptedWorker, buildSegments, routeRealOrt, REAL_ORT_AVAILABLE, HALF_MODEL_PATH, BASE_URL } from './harness';
import { setToggles } from './helpers';

const NAMES = ['uvrCreateDsp', 'UVR_CFG', 'encodeWavPcm16', 'runVocalSeparation', 'decodeAudio', 'resampleChannels',
  'detectMemoryTier', 'UVR_MODEL_URL', 'UVR_IDB_KEY'];
// 模型來源：Hugging Face 鏡像（fudan-generative-ai/hallo；SHA-256 與 UVR 官方 Kim_Vocal_2.onnx 逐位元相同）。
// 不用 GitHub Release：github.com 與 release-assets.githubusercontent.com 都不回 Access-Control-Allow-Origin，瀏覽器 fetch 必定被 CORS 擋下。
const MODEL_URL = 'https://huggingface.co/fudan-generative-ai/hallo/resolve/main/audio_separator/Kim_Vocal_2.onnx';
const FAKE_MODEL = Buffer.alloc(4096, 7);                                          // 假模型：4 KB
const FAKE_SHA = createHash('sha256').update(FAKE_MODEL).digest('hex');
const USE_FAKE_MODEL = `UVR_MODEL_BYTES = ${FAKE_MODEL.length}; UVR_MODEL_SHA256 = '${FAKE_SHA}'`;   // 以 evalIn 覆寫 let 常數
const ORT_URL = '**/onnxruntime-web@1.30.0/dist/ort.all.min.js';

// 確定性訊號（公式須與 tests/uvr/gen-stft-ref.py 的 sig() 一致）
const SIG_SRC = `window.__sig = (n, rate) => { rate = rate || 44100; const L = new Float32Array(n), R = new Float32Array(n);
  for (let j = 0; j < n; j++) {
    L[j] = 0.5 * Math.sin(2 * Math.PI * 440 * j / rate) + 0.25 * Math.sin(2 * Math.PI * 3000 * j / rate + 0.3);
    R[j] = 0.4 * Math.sin(2 * Math.PI * 523.25 * j / rate) - 0.2 * Math.sin(2 * Math.PI * 7000 * j / rate);
  } return { L, R }; };`;

/** Node 端獨立的 WAV（PCM16、立體聲）產生器：不使用受測程式的編碼器 */
function makeWav(seconds: number, rate = 44100): Buffer {
  const n = Math.round(seconds * rate), data = Buffer.alloc(n * 4);
  for (let j = 0; j < n; j++) {
    const l = 0.5 * Math.sin(2 * Math.PI * 440 * j / rate) + 0.25 * Math.sin(2 * Math.PI * 3000 * j / rate + 0.3);
    const r = 0.4 * Math.sin(2 * Math.PI * 523.25 * j / rate) - 0.2 * Math.sin(2 * Math.PI * 7000 * j / rate);
    data.writeInt16LE(Math.round(l * 32767), j * 4); data.writeInt16LE(Math.round(r * 32767), j * 4 + 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); h.writeUInt16LE(2, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 4, 28);
  h.writeUInt16LE(4, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

type OrtMode = 'half' | 'zeros' | 'nan' | 'fail' | 'slow' | 'badshape';
const fakeOrt = (mode: OrtMode) => `
self.ort = { env: { wasm: {} },
  Tensor: class { constructor(t, d, dims) { this.type = t; this.data = d; this.dims = dims; } dispose() {} },
  InferenceSession: { create: async (model, opts) => {
    ${mode === 'fail' ? "throw new Error('fake create failed');" : ''}
    self.__session = { bytes: model.byteLength, opts };
    return { inputNames: ['input'], outputNames: ['output'], run: async (feeds) => {
      ${mode === 'slow' ? 'await new Promise((r) => setTimeout(r, 500));' : ''}
      const t = feeds.input, out = new Float32Array(t.data.length);
      ${mode === 'zeros' ? '' : mode === 'nan' ? 'out.fill(NaN);' : 'for (let i = 0; i < out.length; i++) out[i] = t.data[i] * 0.5;'}
      return { output: new self.ort.Tensor('float32', out, ${mode === 'badshape' ? '[1, 2, 100, 100]' : 't.dims.slice()'}) };
    } }; } } };`;

async function setup(page: Page, mode: OrtMode = 'half', opts: { fetchStatus?: number } = {}) {
  const hits = { ort: 0, model: 0 };
  await page.addInitScript(SIG_SRC);
  // 測試不可依賴主機 RAM：沙盒／CI 的 Chromium 常回報 deviceMemory ≤ 4 而被判為低記憶體等級（UVR 會合理地略過）。
  // 固定為 8；U-09f 之後以 configurable 重新定義成 2 來測低記憶體路徑。
  await page.addInitScript(() => Object.defineProperty(navigator, 'deviceMemory', { get: () => 8, configurable: true }));
  await page.addInitScript((c) => { (window as any).__USE_FAKE = c; }, USE_FAKE_MODEL);
  await page.addInitScript(() => {   // 記錄名為 'uvr' 的 Worker 的建立與終止（包住當下的 window.Worker，不用繼承）
    const Prev = window.Worker as any; (window as any).__workers = [];
    (window as any).Worker = function (u: any, o: any) {
      const w = new Prev(u, o);
      if (o && o.name === 'uvr') {
        w.__terminated = false; const t = w.terminate.bind(w);
        w.terminate = () => { w.__terminated = true; t(); };
        (window as any).__workers.push(w);
      }
      return w;
    };
  });
  await page.route(ORT_URL, (r) => { hits.ort++; return r.fulfill({ contentType: 'application/javascript', body: fakeOrt(mode) }); });
  await page.route(MODEL_URL, (r) => {
    hits.model++;
    if (opts.fetchStatus && opts.fetchStatus !== 200) return r.fulfill({ status: opts.fetchStatus, body: 'nope', headers: { 'access-control-allow-origin': '*' } });
    return r.fulfill({ status: 200, contentType: 'application/octet-stream', headers: { 'access-control-allow-origin': '*' }, body: FAKE_MODEL });
  });
  return hits;
}

async function openPure(browser: any) {
  const ctx = await newCtx(browser); await ctx.addInitScript(SIG_SRC);
  return openWithHook(ctx, NAMES, 'new');
}

test.describe('r6 UVR：純函式', () => {
  test.setTimeout(180_000);

  test('U-01 混合基數 FFT 與樸素 DFT 一致（含 7680＝2^9×3×5、含質數 7、11 的一般路徑）', async ({ browser }) => {
    const p = await openPure(browser);
    const res = await p.evaluate(() => {
      const T = (window as any).__t, out: any[] = [];
      for (const n of [2, 4, 6, 8, 12, 14, 22, 30, 60, 90, 100, 7680]) {
        const dsp = T.uvrCreateDsp(n, n / 2, Math.min(n / 2 + 1, 5), 8);
        const re = new Float64Array(n), im = new Float64Array(n);
        let s = 12345 + n; const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296) - 0.5;
        for (let i = 0; i < n; i++) { re[i] = rnd(); im[i] = rnd(); }
        const cr = new Float64Array(n), ci = new Float64Array(n);
        for (let i = 0; i < n; i++) { cr[i] = Math.cos(-2 * Math.PI * i / n); ci[i] = Math.sin(-2 * Math.PI * i / n); }
        const er = new Float64Array(n), ei = new Float64Array(n);
        for (let k = 0; k < n; k++) { let sr = 0, si = 0; for (let t = 0; t < n; t++) { const m = (k * t) % n; sr += re[t] * cr[m] - im[t] * ci[m]; si += re[t] * ci[m] + im[t] * cr[m]; } er[k] = sr; ei[k] = si; }
        dsp.fft(re, im);
        let err = 0, mag = 0;
        for (let k = 0; k < n; k++) { err = Math.max(err, Math.abs(re[k] - er[k]), Math.abs(im[k] - ei[k])); mag = Math.max(mag, Math.abs(er[k]), Math.abs(ei[k])); }
        out.push({ n, rel: err / mag });
      }
      return out;
    });
    for (const r of res) expect(r.rel, `n=${r.n}`).toBeLessThan(1e-11);
  });

  test('U-02 STFT→iSTFT 完美重建（小設定全頻帶；正式設定的帶限訊號）', async ({ browser }) => {
    const p = await openPure(browser);
    const r = await p.evaluate(() => {
      const T = (window as any).__t;
      // 小設定：nFft 120、hop 30、dimF＝全部 61 格、dimT 16 → CHUNK 450
      const d = T.uvrCreateDsp(120, 30, 61, 16);
      let s = 7; const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296) - 0.5;
      const L = new Float32Array(d.CHUNK).map(rnd), R = new Float32Array(d.CHUNK).map(rnd);
      const spec = new Float32Array(4 * 61 * 16); d.stft(L, R, spec);
      const oL = new Float32Array(d.CHUNK), oR = new Float32Array(d.CHUNK); d.istft(spec, oL, oR);
      let e1 = 0; for (let i = 0; i < d.CHUNK; i++) e1 = Math.max(e1, Math.abs(oL[i] - L[i]), Math.abs(oR[i] - R[i]));
      // 正式設定
      const C = T.UVR_CFG, D = T.uvrCreateDsp(C.nFft, C.hop, C.dimF, C.dimT);
      const { L: sl, R: sr } = (window as any).__sig(D.CHUNK);
      const sp = new Float32Array(4 * C.dimF * C.dimT); D.stft(sl, sr, sp);
      const ol = new Float32Array(D.CHUNK), or = new Float32Array(D.CHUNK); D.istft(sp, ol, or);
      // 頻帶上限 17.6 kHz：訊號首尾的階躍／折角（反射補齊產生）含高頻，被截掉後邊緣約有 0.02 的誤差（與模型實際行為相同）；
      // 邊界 8192 樣本（> 一個視窗 7680）之外必須接近完美重建。
      let e2 = 0, edge = 0;
      for (let i = 0; i < D.CHUNK; i++) { const d = Math.max(Math.abs(ol[i] - sl[i]), Math.abs(or[i] - sr[i])); if (i >= 8192 && i < D.CHUNK - 8192) e2 = Math.max(e2, d); else edge = Math.max(edge, d); }
      return { e1, e2, edge, chunk: D.CHUNK, gen: D.GEN, trim: D.TRIM };
    });
    expect(r.e1).toBeLessThan(1e-5);
    expect(r.e2).toBeLessThan(1e-5);
    expect(r.edge).toBeLessThan(0.1);         // 邊緣有誤差但不得失控
    expect([r.chunk, r.gen, r.trim]).toEqual([261120, 253440, 3840]);
  });

  test('U-03 STFT 與 numpy 參考值逐值一致（通道順序、反射補齊、視窗、頻格排列）', async ({ browser }) => {
    const ref = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'uvr-stft-ref.json'), 'utf8'));
    const p = await openPure(browser);
    const got = await p.evaluate(({ frames, bins }) => {
      const T = (window as any).__t, C = T.UVR_CFG, D = T.uvrCreateDsp(C.nFft, C.hop, C.dimF, C.dimT);
      const { L, R } = (window as any).__sig(D.CHUNK);
      const sp = new Float32Array(4 * C.dimF * C.dimT); D.stft(L, R, sp);
      return frames.map((t: number) => [0, 1, 2, 3].map((c) => bins.map((k: number) => sp[(c * C.dimF + k) * C.dimT + t])));
    }, { frames: ref.frames, bins: ref.bins });
    let worst = 0;
    ref.values.forEach((fr: number[][], i: number) => fr.forEach((ch, c) => ch.forEach((v, j) => { worst = Math.max(worst, Math.abs(v - got[i][c][j])); })));
    expect(worst).toBeLessThan(2e-3);     // 最大幅度約 876；float32 與 sin() 實作差異
  });

  test('U-04 分塊管線：與 numpy 參考實作逐點一致（含分塊接縫與首尾）；各長度輸出長度、分塊數、內部還原正確', async ({ browser }) => {
    const ref = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'uvr-sep-ref.json'), 'utf8'));
    const p = await openPure(browser);
    const res = await p.evaluate(async (cases: any[]) => {
      const T = (window as any).__t, C = T.UVR_CFG, D = T.uvrCreateDsp(C.nFft, C.hop, C.dimF, C.dimT), out: any[] = [];
      const calls: number[] = [];
      for (const n of [1, 100, D.GEN - 1, D.GEN, D.GEN + 1, 2 * D.GEN + 5]) {
        const { L, R } = (window as any).__sig(n);
        let chunks = 0;
        const r = await D.separate(L, R, async (t: Float32Array) => { chunks++; return t.map((v) => v * 0.5); }, (done: number, total: number) => calls.push(done * 1000 + total));
        // 邊界 8192 之外與 0.5×輸入比對（邊界內受 17.6 kHz 頻帶上限影響，改和 numpy 參考值比對）
        let inner = 0; for (let i = 8192; i < n - 8192; i++) inner = Math.max(inner, Math.abs(r.left[i] - 0.5 * L[i]), Math.abs(r.right[i] - 0.5 * R[i]));
        const c = cases.find((x) => x.n === n);
        let vsRef = c ? 0 : null;
        if (c) c.idx.forEach((i: number, k: number) => { vsRef = Math.max(vsRef as number, Math.abs(r.left[i] - c.left[k]), Math.abs(r.right[i] - c.right[k])); });
        out.push({ n, len: [r.left.length, r.right.length], chunks, expected: Math.max(1, Math.ceil(n / D.GEN)), inner, vsRef, distinct: r.left.buffer !== r.right.buffer, rmsIn: r.rmsIn, rmsOut: r.rmsOut });
      }
      return { out, calls };
    }, ref.cases);
    for (const r of res.out) {
      expect(r.len, `n=${r.n}`).toEqual([r.n, r.n]);
      expect(r.chunks, `n=${r.n}`).toBe(r.expected);
      expect(r.inner, `n=${r.n}`).toBeLessThan(1e-4);
      if (r.vsRef !== null) expect(r.vsRef, `n=${r.n} vs numpy`).toBeLessThan(2e-4);
      expect(r.distinct).toBe(true);
    }
    expect(res.out.filter((r: any) => r.vsRef !== null).length).toBe(4);   // 四組參考案例都有被比對
    const r3 = res.out[3];
    expect(r3.rmsOut / r3.rmsIn).toBeGreaterThan(0.49); expect(r3.rmsOut / r3.rmsIn).toBeLessThan(0.51);
    expect(res.calls.slice(-1)[0] % 1000).toBe(3);   // 最後一次回報的 total＝最後一種長度的分塊數
  });

  test('U-05 WAV 編碼：標頭、交錯、削波、長度', async ({ browser }) => {
    const p = await openPure(browser);
    const r = await p.evaluate(async () => {
      const T = (window as any).__t;
      const blob: Blob = T.encodeWavPcm16(new Float32Array([0, 0.5, -0.5, 2, -2]), new Float32Array([1, -1, 0.25, 0, 0.1]), 44100);
      const b = new DataView(await blob.arrayBuffer());
      const s = (o: number, n: number) => String.fromCharCode(...Array.from({ length: n }, (_, i) => b.getUint8(o + i)));
      return { type: blob.type, size: blob.size, riff: s(0, 4), wave: s(8, 4), fmt: s(12, 4), data: s(36, 4),
        fmtTag: b.getUint16(20, true), ch: b.getUint16(22, true), rate: b.getUint32(24, true), byteRate: b.getUint32(28, true), align: b.getUint16(32, true), bits: b.getUint16(34, true),
        riffSize: b.getUint32(4, true), dataSize: b.getUint32(40, true),
        pcm: Array.from({ length: 10 }, (_, i) => b.getInt16(44 + i * 2, true)) };
    });
    expect(r).toMatchObject({ type: 'audio/wav', size: 44 + 20, riff: 'RIFF', wave: 'WAVE', fmt: 'fmt ', data: 'data', fmtTag: 1, ch: 2, rate: 44100, byteRate: 176400, align: 4, bits: 16, riffSize: 36 + 20, dataSize: 20 });
    expect(r.pcm).toEqual([0, 32767, 16384, -32768, -16384, 8192, 32767, 0, -32768, 3277]);   // 負數乘 32768、正數乘 32767，先削波至 ±1
  });

  test('U-06 resampleChannels：單聲道結果與 v23.2 的 resampleMono 實作逐點相同；立體聲回傳兩個獨立聲道', async ({ browser }) => {
    const p = await openPure(browser);
    const r = await p.evaluate(async () => {
      const T = (window as any).__t, { L, R } = (window as any).__sig(44100);
      const viaMono: Float32Array = (await T.resampleChannels([L], 44100, 16000))[0];   // r7：resampleMono 包裝已移除，單聲道直接走 resampleChannels
      // 舊實作（v23.2）逐字重現
      const targetLen = Math.round(L.length * 16000 / 44100), oc = new OfflineAudioContext(1, targetLen, 16000);
      const buf = oc.createBuffer(1, L.length, 44100); buf.copyToChannel(L, 0);
      const src = oc.createBufferSource(); src.buffer = buf; src.connect(oc.destination); src.start(0);
      const old = (await oc.startRendering()).getChannelData(0).slice();
      let diff = 0; for (let i = 0; i < old.length; i++) diff = Math.max(diff, Math.abs(old[i] - viaMono[i]));
      const st: Float32Array[] = await T.resampleChannels([L, R], 44100, 16000);
      return { lenMono: viaMono.length, lenOld: old.length, diff, stereoLens: st.map((x) => x.length), distinct: st[0].buffer !== st[1].buffer };
    });
    expect(r.lenMono).toBe(r.lenOld);
    expect(r.diff).toBe(0);
    expect(r.stereoLens).toEqual([16000, 16000]);
    expect(r.distinct).toBe(true);
  });
});

test.describe('r6 UVR：真實 Worker＋假 ORT', () => {
  test.setTimeout(240_000);
  const run = (p: Page, b64: string, evalBefore = '') => p.evaluate(async ({ b64, evalBefore }) => {
    const T = (window as any).__t;
    T.evalIn((window as any).__USE_FAKE);
    if (evalBefore) T.evalIn(evalBefore);
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const file = new File([bytes], 'clip.wav', { type: 'audio/wav' });
    const t0 = performance.now();
    try {
      const r = await T.runVocalSeparation(file);
      const logText = document.getElementById('logBox')!.textContent || '';
      if (!r) return { ok: false, logText, workers: (window as any).__workers.map((w: any) => w.__terminated), ms: performance.now() - t0 };
      const wav = new DataView(await r.wavBlob.arrayBuffer());
      const { L, R } = (window as any).__sig(Math.round(3 * 44100));
      let eL = 0, eR = 0;
      const nS = (wav.byteLength - 44) / 4;
      for (let i = 9000; i < Math.min(120000, nS - 8192); i += 97) {   // 前後 8192 樣本受 17.6 kHz 頻帶上限影響，不比
        eL = Math.max(eL, Math.abs(wav.getInt16(44 + i * 4, true) / 32768 - 0.5 * L[i]));
        eR = Math.max(eR, Math.abs(wav.getInt16(44 + i * 4 + 2, true) / 32768 - 0.5 * R[i]));
      }
      let rms = 0; for (let i = 0; i < r.mono16k.length; i++) rms += r.mono16k[i] ** 2;
      return { ok: true, logText, mono16kLen: r.mono16k.length, wavSize: r.wavBlob.size, rate: wav.getUint32(24, true), eL, eR,
        rms: Math.sqrt(rms / r.mono16k.length), workers: (window as any).__workers.map((w: any) => w.__terminated), ms: performance.now() - t0 };
    } catch (e: any) { return { ok: false, threw: e.message, workers: (window as any).__workers.map((w: any) => w.__terminated) }; }
  }, { b64, evalBefore });
  const b64 = (sec: number) => makeWav(sec).toString('base64');

  test('U-07 正常流程：人聲＝模型輸出（×0.5）、回傳 16 kHz 單聲道＋44.1 kHz 立體聲 WAV、Worker 結束後被終止', async ({ browser }) => {
    const ctx = await newCtx(browser); const page = await ctx.newPage();
    const hits = await setup(page);
    await exposeInternals(page, NAMES, 'new');
    await page.goto(BASE_URL); await page.waitForFunction(() => !!(window as any).__t);
    const r: any = await run(page, b64(3));
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.rate).toBe(44100);
    expect(r.wavSize).toBe(44 + 3 * 44100 * 4);
    expect(Math.abs(r.mono16kLen - 48000)).toBeLessThanOrEqual(2);
    expect(r.eL).toBeLessThan(2e-3); expect(r.eR).toBeLessThan(2e-3);
    expect(r.rms).toBeGreaterThan(0.05);
    expect(r.workers).toEqual([true]);               // 只建一個 Worker，結束後已終止
    expect(r.logText).toContain('人聲分離完成');
    expect(hits.model).toBe(1); expect(hits.ort).toBe(1);
  });

  test('U-08 第二次執行不再下載模型（IndexedDB 快取）', async ({ browser }) => {
    const ctx = await newCtx(browser); const page = await ctx.newPage();
    const hits = await setup(page);
    await exposeInternals(page, NAMES, 'new');
    await page.goto(BASE_URL); await page.waitForFunction(() => !!(window as any).__t);
    const a: any = await run(page, b64(2)); const b: any = await run(page, b64(2));
    expect(a.ok && b.ok, JSON.stringify([a, b])).toBe(true);
    expect(hits.model).toBe(1);
    expect(b.logText).toContain('IndexedDB');
  });

  test('U-15a 真實 onnxruntime-web 1.30.0（WASM）＋替身模型：完整流程的人聲＝輸入×0.5', async ({ browser }) => {
    test.skip(!REAL_ORT_AVAILABLE, '需要 npm install（onnxruntime-web 1.30.0）與 tests/fixtures/uvr/half-model.onnx');
    const half = fs.readFileSync(HALF_MODEL_PATH);
    const sha = createHash('sha256').update(half).digest('hex');
    const ctx = await newCtx(browser); const page = await ctx.newPage();
    const hits = await setup(page);                               // 工作階段追蹤＋預設路由；之後註冊的路由優先，覆蓋成真實 ORT 與替身模型
    const served: string[] = [];
    await routeRealOrt(page, served);
    await page.route(MODEL_URL, (r) => { hits.model++; return r.fulfill({ status: 200, contentType: 'application/octet-stream', headers: { 'access-control-allow-origin': '*' }, body: half }); });
    await exposeInternals(page, NAMES, 'new');
    await page.goto(BASE_URL); await page.waitForFunction(() => !!(window as any).__t);
    const r: any = await run(page, b64(3), `UVR_MODEL_BYTES = ${half.length}; UVR_MODEL_SHA256 = '${sha}'`);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.rate).toBe(44100);
    expect(r.wavSize).toBe(44 + 3 * 44100 * 4);
    expect(r.eL).toBeLessThan(2e-3); expect(r.eR).toBeLessThan(2e-3);   // 與 U-07（假 ORT）相同的誤差門檻
    expect(r.workers).toEqual([true]);
    expect(r.logText).toContain('人聲分離完成');
    expect(served.some((f) => f.endsWith('.wasm')), `實際取用：${served.join(', ')}`).toBe(true);   // 證明真的跑了 ORT 的 WASM
    expect(hits.model).toBe(1);
  });

  const fallbackCase = (title: string, mode: OrtMode, opts: { fetchStatus?: number }, evalBefore: string, expectLog: string, extraInit?: (p: Page) => Promise<void>, expectWorkers: number | null = 1, expectDownloads: number | null = null) =>
    test(title, async ({ browser }) => {
      const ctx = await newCtx(browser); const page = await ctx.newPage();
      const hits = await setup(page, mode, opts);
      if (extraInit) await extraInit(page);
      await exposeInternals(page, NAMES, 'new');
      await page.goto(BASE_URL); await page.waitForFunction(() => !!(window as any).__t);
      const r: any = await run(page, b64(3), evalBefore);
      expect(r.threw, JSON.stringify(r)).toBeUndefined();
      expect(r.ok).toBe(false);                      // 回傳 null：呼叫端改用原始音訊
      expect(r.logText).toContain(expectLog);
      expect(r.logText).toContain('改用原始音訊');
      if (expectWorkers !== null) expect(r.workers.length).toBe(expectWorkers);
      if (expectDownloads !== null) expect(hits.model).toBe(expectDownloads);
      expect(r.workers.every((t: boolean) => t)).toBe(true);   // 失敗也不留 Worker
    });

  fallbackCase('U-09a ORT 建立 session 失敗 → 記錄警告並回傳 null', 'fail', {}, '', 'fake create failed');
  fallbackCase('U-09b 模型下載 HTTP 404 → 記錄警告並回傳 null', 'half', { fetchStatus: 404 }, '', '模型下載失敗', undefined, 0, 1);
  fallbackCase('U-09c 模型輸出全為 0（形狀或排列不符時的典型症狀）→ 不得靜默採用，回傳 null', 'zeros', {}, '', '幾乎無聲');
  fallbackCase('U-09d 模型輸出含 NaN → 回傳 null', 'nan', {}, '', '非有限值');
  fallbackCase('U-09e 模型輸出形狀不符 → 回傳 null', 'badshape', {}, '', '形狀');
  fallbackCase('U-09f 低記憶體等級裝置 → 略過（不建立 Worker、不下載）', 'half', {}, '', '低記憶體',
    (p) => p.addInitScript(() => Object.defineProperty(navigator, 'deviceMemory', { get: () => 2, configurable: true })), 0, 0);
  fallbackCase('U-09h 模型 SHA-256 校驗不符 → 拒用、不寫入快取，回傳 null', 'half', {}, "UVR_MODEL_SHA256 = '" + '0'.repeat(64) + "'", '校驗', undefined, 0, 1);
  fallbackCase('U-09i 模型大小與預期不符 → 回傳 null', 'half', {}, 'UVR_MODEL_BYTES = 5000', '大小', undefined, 0, 1);
  fallbackCase('U-09g 音訊長度超過上限 → 略過（不建立 Worker、不下載）', 'half', {}, 'UVR_MAX_SEC = 2', '超過', undefined, 0, 0);

  test('U-09j 校驗失敗的模型不得進快取：改回正確校驗值後必須重新下載', async ({ browser }) => {
    const ctx = await newCtx(browser); const page = await ctx.newPage();
    const hits = await setup(page);
    await exposeInternals(page, NAMES, 'new');
    await page.goto(BASE_URL); await page.waitForFunction(() => !!(window as any).__t);
    const bad: any = await run(page, b64(2), "UVR_MODEL_SHA256 = '" + '0'.repeat(64) + "'");
    const good: any = await run(page, b64(2));
    expect(bad.ok).toBe(false); expect(good.ok, JSON.stringify(good)).toBe(true);
    expect(hits.model).toBe(2);
  });

  test('U-10 取消：辨識中按取消 → 立即 reject CANCELLED、Worker 被終止、不回傳結果', async ({ browser }) => {
    const ctx = await newCtx(browser); const page = await ctx.newPage();
    await setup(page, 'slow');
    await exposeInternals(page, NAMES, 'new');
    await page.goto(BASE_URL); await page.waitForFunction(() => !!(window as any).__t);
    const r = await page.evaluate(async (b64) => {
      const T = (window as any).__t; T.evalIn((window as any).__USE_FAKE);
      const file = new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], 'clip.wav', { type: 'audio/wav' });
      // 第 1 個分塊完成（進度出現）後才取消
      const lbl = document.getElementById('progLabel')!;
      const started = new Promise<void>((res) => new MutationObserver(() => { if ((lbl.textContent || '').includes('1/')) res(); }).observe(lbl, { childList: true, characterData: true, subtree: true }));
      const run = T.runVocalSeparation(file).then(() => 'resolved', (e: any) => e.message);
      await started;
      const t0 = performance.now();
      document.getElementById('cancelBtn')!.click();
      const msg = await run;
      return { msg, cancelMs: performance.now() - t0, terminated: (window as any).__workers.every((w: any) => w.__terminated) };
    }, b64(14));          // 14 秒 → 3 個分塊；每塊假模型 500 ms
    expect(r.msg).toBe('CANCELLED');
    expect(r.cancelMs).toBeLessThan(1000);
    expect(r.terminated).toBe(true);
  });

  test('U-11 進度回報：每個分塊一次，標籤含 done/total 與預估剩餘時間', async ({ browser }) => {
    const ctx = await newCtx(browser); const page = await ctx.newPage();
    await setup(page, 'slow');
    await exposeInternals(page, NAMES, 'new');
    await page.goto(BASE_URL); await page.waitForFunction(() => !!(window as any).__t);
    const labels = await page.evaluate(async (b64) => {
      const T = (window as any).__t; T.evalIn((window as any).__USE_FAKE);
      const file = new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], 'clip.wav', { type: 'audio/wav' });
      const seen: string[] = []; const lbl = document.getElementById('progLabel')!;
      new MutationObserver(() => seen.push(lbl.textContent || '')).observe(lbl, { childList: true, characterData: true, subtree: true });
      await T.runVocalSeparation(file);
      return seen.filter((s) => /\d+\/\d+/.test(s));
    }, b64(14));
    expect(labels.length).toBeGreaterThanOrEqual(3);
    expect(labels[0]).toMatch(/1\/3/);
    expect(labels[labels.length - 1]).toMatch(/3\/3/);
    expect(labels.some((s) => /剩餘/.test(s))).toBe(true);
  });

  test('U-12 decodeAudio(file, mono16k)：使用傳入的人聲音訊，仍套用音訊正規化（與一般流程同一條路徑）', async ({ browser }) => {
    const p = await openPure(browser);
    await setToggles(p, ['tog_normalize'], ['tog_diarization']);
    const r = await p.evaluate(async () => {
      const T = (window as any).__t;
      const given = new Float32Array(16000).map((_, i) => 0.1 * Math.sin(i / 10));
      const file = new File([new Uint8Array(10)], 'x.wav', { type: 'audio/wav' });   // 內容不可被解碼：證明沒有走原本的解碼
      const { audio } = await T.decodeAudio(file, given);
      let peak = 0; for (const v of audio) peak = Math.max(peak, Math.abs(v));
      return { len: audio.length, peak };
    });
    expect(r.len).toBe(16000);
    expect(r.peak).toBeCloseTo(0.8913, 3);
  });
});

test.describe('r6 UVR：完整 app 流程', () => {
  test.setTimeout(240_000);

  test('U-13 開啟「人聲分離」→ 辨識完成；人聲 WAV 下載鈕出現；關閉時不建立 UVR Worker、無下載鈕', async ({ browser }) => {
    for (const on of [true, false]) {
      const ctx = await newCtx(browser); const page = await ctx.newPage();
      await page.addInitScript(() => { (window as any).__RealWorker = window.Worker; });
      const segs = await buildSegments(ctx, { segments: 2, linesPerSegment: 3, charsPerLine: 14, termRate: 0.1, seed: 3 });
      await installScriptedWorker(page, { segments: segs });
      await page.addInitScript(() => {     // 帶 name:'uvr' 的 Worker 走真實實作，其餘維持假 Whisper Worker
        const Fake = window.Worker as any, Real = (window as any).__RealWorker; 
        (window as any).Worker = class { constructor(u: any, o: any) { if (o && o.name === 'uvr') return new Real(u, o); return new Fake(u, o); } };
      });
      const hits = await setup(page);
      await exposeInternals(page, NAMES, 'new');
      await page.goto(BASE_URL); await page.waitForFunction(() => !!(window as any).__t);
      await page.evaluate(() => (window as any).__t.evalIn((window as any).__USE_FAKE));   // 假模型只有 4 KB
      await page.locator('.model-btn[data-model="Xenova/whisper-base"]').click();
      await setToggles(page, on ? ['tog_uvr'] : [], on ? ['tog_vad'] : ['tog_uvr', 'tog_vad']);   // 關 VAD：VAD 也會在主執行緒載入 ort，會混進 hits.ort
      await page.locator('#fileInput').setInputFiles({ name: 'lecture.wav', mimeType: 'audio/wav', buffer: makeWav(14) });
      await page.locator('#startBtn').click();
      await expect(page.locator('.batch-item.done')).toHaveCount(1, { timeout: 120_000 });
      const vocal = page.locator('#dlVocalBtn');
      if (on) {
        await expect(vocal).toBeVisible();
        expect(await vocal.getAttribute('href')).toMatch(/^blob:/);
        expect(await vocal.getAttribute('download')).toBe('lecture_vocals.wav');
        expect(await page.locator('#logBox').textContent()).toContain('人聲分離完成');
        expect(hits.ort).toBe(1);
      } else {
        await expect(vocal).toBeHidden();
        expect(hits.ort).toBe(0); expect(hits.model).toBe(0);
        expect(await page.evaluate(() => (window as any).__workers.length)).toBe(0);
      }
    }
  });
});

// ── U-15 真實模型位元組＋假 ORT（選用；驗證常數與 dist 的 CSP）────────────────────────
// 為什麼：其他測試用 4 KB 假模型並以 evalIn 覆寫 UVR_MODEL_BYTES／UVR_MODEL_SHA256，不會發現這兩個常數本身寫錯。
// 這裡改送「真實的 Kim_Vocal_2.onnx（66,759,214 位元組）」，不覆寫任何常數：大小與 SHA-256 校驗必須原樣通過。
// 同時在 dist（有 CSP）頁面跑：驗證 blob Worker、<video> 讀長度（media-src blob:）、Worker 內 importScripts jsdelivr、下載 huggingface.co 都不違反 CSP。
// 用法：UVR_MODEL_PATH=/path/Kim_Vocal_2.onnx npx playwright test --project=functional tests/round13-uvr.spec.ts -g U-15
const DIST_URL = process.env.WHISPER_DIST_TEST_URL ?? 'http://localhost:8081/index.html';
test.describe('r6 UVR：真實模型位元組＋假 ORT（選用）', () => {
  test.skip(!process.env.UVR_MODEL_PATH, '設定 UVR_MODEL_PATH（Kim_Vocal_2.onnx）才執行');
  test.setTimeout(300_000);
  for (const [label, url] of [['原始碼', BASE_URL], ['dist（CSP）', DIST_URL]] as const) {
    test(`U-15 ${label}：66,759,214 位元組下載＋SHA-256 校驗通過 → 完成、下載鈕出現、零 CSP 違規`, async ({ browser }) => {
      const modelBytes = fs.readFileSync(process.env.UVR_MODEL_PATH!);
      expect(modelBytes.length).toBe(66759214);
      const ctx = await newCtx(browser); const page = await ctx.newPage();
      await page.addInitScript(() => { (window as any).__RealWorker = window.Worker; (window as any).__csp = [];
        document.addEventListener('securitypolicyviolation', (e: any) => (window as any).__csp.push(e.violatedDirective + ' ' + e.blockedURI)); });
      const segs = await buildSegments(ctx, { segments: 2, linesPerSegment: 3, charsPerLine: 14, termRate: 0.1, seed: 3 });
      await installScriptedWorker(page, { segments: segs });
      await page.addInitScript(() => {
        const Fake = window.Worker as any, Real = (window as any).__RealWorker;
        (window as any).Worker = class { constructor(u: any, o: any) { if (o && o.name === 'uvr') return new Real(u, o); return new Fake(u, o); } };
      });
      await page.route(ORT_URL, (r) => r.fulfill({ contentType: 'application/javascript', body: fakeOrt('half') }));
      await page.route(MODEL_URL, (r) => r.fulfill({ status: 200, contentType: 'application/octet-stream', headers: { 'access-control-allow-origin': '*' }, body: modelBytes }));
      await page.goto(url);
      await page.locator('.model-btn[data-model="Xenova/whisper-base"]').click();
      await setToggles(page, ['tog_uvr'], ['tog_vad']);
      await page.locator('#fileInput').setInputFiles({ name: 'lecture.wav', mimeType: 'audio/wav', buffer: makeWav(14) });
      await page.locator('#startBtn').click();
      await expect(page.locator('.batch-item.done')).toHaveCount(1, { timeout: 200_000 });
      await expect(page.locator('#dlVocalBtn')).toBeVisible();
      const log = (await page.locator('#logBox').textContent()) ?? '';
      expect(log).toContain('UVR 模型下載完成，驗證通過');
      expect(log).toContain('人聲分離完成');
      expect(log).not.toContain('人聲分離失敗');
      expect(await page.evaluate(() => (window as any).__csp)).toEqual([]);
    });
  }
});

// ── U-14 真實模型（選用）──────────────────────────────────────────────────────────
// 用法：UVR_REAL=1 UVR_MODEL_PATH=/path/Kim_Vocal_2.onnx npx playwright test --project=functional tests/round13-uvr.spec.ts -g U-14
// 作法：JS 的 Worker 與整條 DSP 管線照常執行，只把 ORT-web 換成「呼叫本機 python onnxruntime」的橋接（tests/uvr/model-bridge.py），
//       所以驗證的是真實模型＋真實 JS 管線；唯一沒被驗證的是 ORT-web 本身。
//       訊號：ffmpeg flite 合成語音＋和弦／節拍背景（0 dB）；通過條件：人聲 SI-SDR 比混音提升 ≥ 15 dB。（JS DSP 與 numpy 參考實作的一致性由 U-03／U-04 逐點驗證。）
test.describe('r6 UVR：真實模型（選用）', () => {
  test.skip(!process.env.UVR_REAL, '設定 UVR_REAL=1 與 UVR_MODEL_PATH 才執行');
  test.setTimeout(900_000);
  let bridge: ChildProcess | null = null;
  test.afterAll(() => { bridge?.kill(); });

  test('U-14 真實 Kim_Vocal_2：語音＋背景音樂 → 人聲 SI-SDR 比混音提升 ≥ 15 dB', async ({ browser }) => {
    const model = process.env.UVR_MODEL_PATH!; expect(fs.existsSync(model)).toBe(true);
    const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'uvr-real-'));
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', "flite=text='The microbiology lecture today covers innate immunity and how the host defends against infection.':voice=slt", '-ar', '44100', '-ac', '1', '-f', 'f32le', path.join(tmp, 'speech.f32')]);
    const port = 18765;
    bridge = spawn('python3', [path.join(__dirname, 'uvr', 'model-bridge.py'), model, String(port)], { stdio: 'inherit' });
    for (let i = 0; i < 60; i++) { try { await fetch(`http://127.0.0.1:${port}/ping`); break; } catch { await new Promise((r) => setTimeout(r, 500)); } }
    const speech = new Float32Array(fs.readFileSync(path.join(tmp, 'speech.f32')).buffer.slice(0));
    const n = speech.length;
    // 背景：和弦（含諧波）＋節拍雜訊，與語音等響度
    const music = new Float32Array(n); let seed = 1;
    const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296) - 0.5;
    for (let i = 0; i < n; i++) { const t = i / 44100; let v = 0; for (const [f, a] of [[220, 1], [277.18, 1], [329.63, 1], [110, 1.5]] as [number, number][]) for (let h = 1; h <= 5; h++) v += a / h * Math.sin(2 * Math.PI * f * h * t); music[i] = v; }
    for (let b = 0; b * 22050 < n; b++) for (let j = 0; j < 3528 && b * 22050 + j < n; j++) music[b * 22050 + j] += 3 * 2 * rnd() * Math.exp(-j / 882);
    const rms = (x: Float32Array) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);
    const g = rms(speech) / rms(music);
    const mix = new Float32Array(n).map((_, i) => speech[i] + music[i] * g);
    // 寫成 16-bit WAV（單聲道 → 立體聲複製）
    const pcm = Buffer.alloc(n * 4);
    for (let i = 0; i < n; i++) { const q = Math.max(-32768, Math.min(32767, Math.round(mix[i] * 32767))); pcm.writeInt16LE(q, i * 4); pcm.writeInt16LE(q, i * 4 + 2); }
    const h = Buffer.alloc(44); h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(2, 22);
    h.writeUInt32LE(44100, 24); h.writeUInt32LE(176400, 28); h.writeUInt16LE(4, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
    const wav = Buffer.concat([h, pcm]);

    const ctx = await newCtx(browser); const page = await ctx.newPage();
    // 瀏覽器 → Playwright 路由 → Node → python 橋接。不讓 Worker 直接跨埠連 127.0.0.1：本沙盒的測試瀏覽器對該連線在送出前就回 ERR_FAILED（橋接伺服器完全沒收到請求；
    // 同環境獨立啟動的 Chromium 則正常），與受測程式無關；同源路由可避開，且 ORT 以外的流程（DSP、Worker、分塊、WAV）一行不動。
    await page.route('**/__uvr_bridge/run', async (route) => {
      const r = await fetch(`http://127.0.0.1:${port}/run`, { method: 'POST', body: route.request().postDataBuffer()! });
      await route.fulfill({ status: r.status, body: Buffer.from(await r.arrayBuffer()), headers: { 'access-control-allow-origin': '*' } });
    });
    await page.route(ORT_URL, (r) => r.fulfill({ contentType: 'application/javascript', body: `
      self.ort = { env: { wasm: {} }, Tensor: class { constructor(t, d, dims) { this.type = t; this.data = d; this.dims = dims; } dispose() {} },
        InferenceSession: { create: async () => ({ inputNames: ['input'], outputNames: ['output'], run: async (feeds) => {
          const t = feeds.input; const res = await fetch('${new URL(BASE_URL).origin}/__uvr_bridge/run', { method: 'POST', body: t.data });
          return { output: new self.ort.Tensor('float32', new Float32Array(await res.arrayBuffer()), t.dims.slice()) }; } }) } };` }));
    await page.route(MODEL_URL, (r) => r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*' }, body: FAKE_MODEL }));
    await page.addInitScript((c) => { (window as any).__USE_FAKE = c; }, USE_FAKE_MODEL);
    await exposeInternals(page, NAMES, 'new');
    await page.goto(BASE_URL); await page.waitForFunction(() => !!(window as any).__t);
    const out = await page.evaluate(async (b64) => {
      const T = (window as any).__t; T.evalIn((window as any).__USE_FAKE);
      const file = new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], 'mix.wav', { type: 'audio/wav' });
      const r = await T.runVocalSeparation(file);
      if (!r) return { L: [] as number[], log: document.getElementById('logBox')!.textContent, failed: true };
      const v = new DataView(await r.wavBlob.arrayBuffer()); const m = (v.byteLength - 44) / 4, L = new Float32Array(m);
      for (let i = 0; i < m; i++) L[i] = v.getInt16(44 + i * 4, true) / 32768;
      return { L: Array.from(L), log: document.getElementById('logBox')!.textContent, failed: false };
    }, wav.toString('base64'));
    expect(out.failed, out.log ?? '').toBeFalsy();
    const vocal = Float32Array.from(out.L);
    const sisdr = (est: Float32Array, ref: Float32Array) => {
      const m1 = est.reduce((a, b) => a + b, 0) / est.length, m2 = ref.reduce((a, b) => a + b, 0) / ref.length;
      let dot = 0, rr = 0; for (let i = 0; i < est.length; i++) { dot += (est[i] - m1) * (ref[i] - m2); rr += (ref[i] - m2) ** 2; }
      const a = dot / rr; let tg = 0, ns = 0; for (let i = 0; i < est.length; i++) { const t = a * (ref[i] - m2), e = est[i] - m1 - t; tg += t * t; ns += e * e; }
      return 10 * Math.log10(tg / ns);
    };
    const before = sisdr(mix, speech), after = sisdr(vocal.subarray(0, n), speech);
    console.log(`U-14 SI-SDR：混音 ${before.toFixed(1)} dB → 人聲 ${after.toFixed(1)} dB（+${(after - before).toFixed(1)}）`);
    expect(after - before).toBeGreaterThan(15);
  });
});
