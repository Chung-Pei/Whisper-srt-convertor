// tests/round11-memory.spec.ts — v24：記憶體穩定性（M0 清除 Worker 偵測、M1 解碼、M2 分級、M3 錯誤驅動降級）
import { test, expect, type Page } from '@playwright/test';
import { recognize, setToggles } from './helpers';
import { newCtx, openWithHook, ensureMedia, exposeInternals, OLD_HTML, ROOT_HTML, readPageHtml, BASE_URL as BASE_URL_ } from './harness';
import { TONES, AMP, AM_HZ } from './fixtures/signal.mjs';

// ══ 單一來源守門 ═════════════════════════════════════════════════════════════
test.describe('單一來源守門', () => {
  test('TX-01 checkSingleSources：目前的 index.html 通過；v23.2 基準檔違規（證明守門有鑑別力）', async () => {
    const mod: any = await import('../scripts/check-consistency.mjs');
    const now = mod.checkSingleSources({ indexPath: ROOT_HTML });
    expect(now.errors, now.errors.join('\n')).toEqual([]);
    const old = mod.checkSingleSources({ indexPath: OLD_HTML });
    expect(old.ok).toBe(false);
    expect(old.errors.length).toBeGreaterThanOrEqual(8);
  });
});

// ══ M0 ═══════════════════════════════════════════════════════════════════════
test.describe('M0：Worker 內不再有記憶體偵測', () => {
  test('TM-01 守門腳本：目前的 index.html 通過；v23.2 基準檔被判定違規（證明守門有鑑別力）', async () => {
    const mod: any = await import('../scripts/check-consistency.mjs');
    const now = mod.checkNoWorkerMemoryApi({ indexPath: ROOT_HTML });
    expect(now.errors, now.errors.join('\n')).toEqual([]);
    const old = mod.checkNoWorkerMemoryApi({ indexPath: OLD_HTML });
    expect(old.ok).toBe(false);
    expect(old.errors.join('\n')).toContain('MEMORY_PRESSURE');
    expect(old.errors.join('\n')).toContain('storage.estimate');
  });

  // 真實 blob Worker＋替身函式庫（沿用 round9 的作法）；在 Worker 腳本前插入前導，使 Worker 內 storage.estimate 回報使用率 90%
  async function runUnderFakeQuota(page: Page, usagePct: number) {
    await page.addInitScript((usage) => {
      const w = window as any;
      w.__posted = []; w.__got = [];
      Object.defineProperty(navigator, 'gpu', { get: () => undefined });            // 走 wasm 分支
      const PRELUDE = `Object.defineProperty(self.navigator, 'storage', { configurable: true, value: { estimate: async () => ({ usage: ${usage}, quota: 100 }) } });\n`;
      const RealBlob = Blob;
      w.Blob = class extends RealBlob {
        constructor(parts?: any[], opts?: any) {
          if (opts?.type === 'application/javascript' && String(parts?.[0]).includes('RUN_CHUNK')) parts = [PRELUDE, ...parts!];
          super(parts, opts);
        }
      };
      const RealWorker = Worker;
      w.Worker = class extends RealWorker {
        constructor(u: any, o: any) { super(u, o); this.addEventListener('message', (e: any) => w.__got.push(e.data?.type)); }
        postMessage(m: any, t?: any) { w.__posted.push(m?.type); return super.postMessage(m, t); }
      };
    }, usagePct);
    const stub = `export const env = {}; export const ModelRegistry = { get_available_dtypes: async () => ['fp32','fp16','q8','q4'] };
      export async function pipeline() { const fn = async () => ({ chunks: [{ text: 'x', timestamp: [0, 1] }] }); fn.dispose = async () => {}; return fn; }`;
    await page.route(/cdn\.jsdelivr\.net\/npm\/@huggingface\/transformers@[^/]+\/dist\/transformers\.min\.js/, (r) => r.fulfill({ contentType: 'application/javascript', body: stub }));
    await page.route(/unpkg\.com\/@huggingface\/transformers@[^/]+\/dist\/transformers\.min\.js/, (r) => r.fulfill({ contentType: 'application/javascript', body: stub }));
    await page.route('**/opencc-js@*/dist/umd/cn2t.js', (r) => r.fulfill({ contentType: 'application/javascript', body: 'window.OpenCC = { Converter: () => (t) => t };' }));
    await recognize(page);
    await setToggles(page, [], ['tog_vad']);
    // 需要 ≥ 2 個切片：Worker 的儲存比例是非同步更新，第一個切片讀到的永遠是初始值 0
    await page.locator('#fileInput').setInputFiles(ensureMedia(['mono16k-60s.wav'])[0]);
    await page.locator('#startBtn').click();
    await expect(page.locator('.batch-item.done')).toHaveCount(1, { timeout: 120_000 });
    return page.evaluate(() => ({
      loads: (window as any).__posted.filter((t: string) => t === 'LOAD_MODEL').length,
      pressure: (window as any).__got.filter((t: string) => t === 'MEMORY_PRESSURE' || t === 'DEGRADE_STRATEGY').length,
    }));
  }

  test('TM-02 Worker 內偽造儲存配額使用率 90%：沒有壓力訊息、模型只載入 1 次（v23.2 會誤報並重載）', async ({ browser }) => {
    const ctx = await newCtx(browser);
    const r = await runUnderFakeQuota(await ctx.newPage(), 90);
    expect(r).toEqual({ loads: 1, pressure: 0 });
  });
});

// ══ M1：單一 16 kHz 解碼路徑 ═══════════════════════════════════════════════════

const M1_NAMES = ['decodeAudio', 'decodeToMono16k', 'applyPeakNormalization', 'applyPeakNormalizationInPlace'];
const FX = '/tests/fixtures/generated/';

/** 頁面內分析：以 Hann 窗＋直接 DFT 求音調振幅（相對解析式真值）與帶外洩漏。對延遲不敏感。 */
function analyzeInPage(mono: Float32Array, p: { tones: number[]; amp: number; am: number }) {
  const N = 8192, off = 100000, rate = 16000, probes = [700, 1700, 3200, 5500, 7000];
  const hann = (i: number) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
  const truth = (i: number) => { const t = (off + i) / rate; let v = 0; for (const f of p.tones) v += p.amp * Math.sin(2 * Math.PI * f * t); return v * (0.6 + 0.4 * Math.sin(2 * Math.PI * p.am * t)); };
  const mag = (get: (i: number) => number, f: number) => { let re = 0, im = 0; for (let i = 0; i < N; i++) { const w = (2 * Math.PI * f * i) / rate, x = get(i) * hann(i); re += x * Math.cos(w); im -= x * Math.sin(w); } return Math.hypot(re, im); };
  const X = (i: number) => mono[off + i];
  const toneErr: Record<number, number> = {};
  for (const f of p.tones) toneErr[f] = 20 * Math.log10(mag(X, f) / mag(truth, f));
  const tonePow = p.tones.reduce((s, f) => s + mag(X, f) ** 2, 0);
  const leak: Record<number, number> = {};
  for (const f of probes) leak[f] = 10 * Math.log10(mag(X, f) ** 2 / tonePow);
  return { len: mono.length, maxToneErrDb: Math.max(...Object.values(toneErr).map(Math.abs)), maxLeakDb: Math.max(...Object.values(leak)) };
}

async function decodeFixture(page: Page, name: string) {
  await page.evaluate(() => { const d = document.getElementById('tog_diarization') as HTMLInputElement | null; if (d) d.checked = false; });
  return page.evaluate(async ({ url, params, fnSrc }) => {
    const T = (window as any).__t;
    (document.getElementById('tog_normalize') as HTMLInputElement).checked = false;   // v23.2 預設開啟；比較重取樣品質必須關閉
    const blob = await (await fetch(url)).blob();
    const { audio } = await T.decodeAudio(new File([blob], 'x.wav'));
    const analyze = new Function('return ' + fnSrc)();
    return { ...analyze(audio, params), isF32: audio instanceof Float32Array, log: document.getElementById('logBox')!.textContent };
  }, { url: FX + name, params: { tones: TONES, amp: AMP, am: AM_HZ }, fnSrc: analyzeInPage.toString() });
}

test.describe('M1：解碼品質與後備路徑', () => {
  test.setTimeout(240_000);
  test.beforeAll(() => { ensureMedia(['mono16k-60s.wav', 'mono48k-60s.wav', 'st44k-60s.wav']); });

  for (const name of ['st44k-60s.wav', 'mono48k-60s.wav', 'mono16k-60s.wav']) {
    test(`TM-03a 解碼品質（正規化關閉）：${name} → 16 kHz 單聲道；長度差 ≤ 1 樣本、音調振幅誤差 ≤ 0.3 dB、帶外洩漏 ≤ −60 dB`, async ({ browser }) => {
      const page = await openWithHook(await newCtx(browser), M1_NAMES, 'new');
      const r = await decodeFixture(page, name);
      expect(r.isF32).toBe(true);
      expect(Math.abs(r.len - 960000)).toBeLessThanOrEqual(1);
      expect(r.maxToneErrDb).toBeLessThanOrEqual(0.3);
      expect(r.maxLeakDb).toBeLessThanOrEqual(-60);
    });
  }

  test('TM-03b 就地正規化與 v23.2 逐位元相同（含靜音不動）；且不另配陣列（回傳同一個物件）', async ({ browser }) => {
    const ctx = await newCtx(browser);
    const mk = () => { let s = 7; const r = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296; const a = new Float32Array(100000); for (let i = 0; i < a.length; i++) a[i] = (r() - 0.5) * 0.8; const q = new Float32Array(1000).fill(0.0004); return { a, q }; };
    const run = async (which: 'old' | 'new') => {
      const p = await openWithHook(ctx, M1_NAMES, which);
      try {
        return await p.evaluate((src) => {
          const T = (window as any).__t; const { a, q } = (new Function('return ' + src)())();
          const f = T.applyPeakNormalizationInPlace ?? T.applyPeakNormalization;
          const b = a.slice(), qq = q.slice(); const rb = f(b), rq = f(qq);
          return { same: rb === b, sameQ: rq === qq, out: Array.from(rb as Float32Array), outQ: Array.from(rq as Float32Array) };
        }, mk.toString());
      } finally { await p.close(); }
    };
    const o = await run('old'), n = await run('new');
    expect(n.out).toEqual(o.out);
    expect(n.outQ).toEqual(o.outQ);
    expect(n.same && n.sameQ).toBe(true);          // 新版：就地；舊版回傳新陣列（o.same === false）
    expect(o.same).toBe(false);
  });

  for (const variant of ['ignore-sampleRate', 'throw-on-option'] as const) {
    test(`TM-04 後備路徑（${variant}）：AudioContext 不支援 16 kHz 選項 → 離線重取樣，仍輸出 16 kHz 單聲道（長度差 ≤ 1、振幅誤差 ≤ 0.5 dB）`, async ({ browser }) => {
      const ctx = await newCtx(browser);
      const page = await ctx.newPage();
      await page.addInitScript((v) => {
        const Real = window.AudioContext;
        (window as any).AudioContext = class extends Real {
          constructor(o?: any) { if (o && v === 'throw-on-option') throw new DOMException('unsupported', 'NotSupportedError'); super(); }
        };
      }, variant);
      const { exposeInternals } = await import('./harness');
      await exposeInternals(page, M1_NAMES, 'new');
      await page.goto(BASE_URL_);
      await page.waitForFunction(() => !!(window as any).__t);
      const r = await decodeFixture(page, 'st44k-60s.wav');
      expect(r.log).toContain('重取樣：');
      expect(Math.abs(r.len - 960000)).toBeLessThanOrEqual(1);
      expect(r.maxToneErrDb).toBeLessThanOrEqual(0.5);
    });
  }

  test('TM-04c IDB 儲存失敗（>50 MB 檔）：降級使用記憶體模式、輸出為 Float32Array；日誌沒有「重新解碼」（該分支為死碼，已刪）', async ({ browser }) => {
    ensureMedia(['st44k-10min.wav']);
    const ctx = await newCtx(browser);
    const page = await ctx.newPage();
    await page.addInitScript(() => { IDBObjectStore.prototype.put = function () { throw new Error('forced IDB failure'); }; });
    const { exposeInternals } = await import('./harness');
    await exposeInternals(page, M1_NAMES, 'new');
    await page.goto(BASE_URL_);
    await page.waitForFunction(() => !!(window as any).__t);
    const r = await decodeFixture(page, 'st44k-10min.wav');
    expect(r.isF32).toBe(true);
    expect(r.len).toBe(9600000);
    expect(r.log).toContain('IndexedDB 儲存失敗');
    expect(r.log).not.toContain('重新解碼');
  });
});

// ══ M2：靜態分級與 dtype 預算 ═════════════════════════════════════════════════
const M2_NAMES = ['detectMemoryTier', 'isIOSFamily', 'TIER_BUDGET_MB', '_dtypeFallback', 'getAvailableMemoryMB'];
const UA = {
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Mobile/15E148 Safari/604.1',
  ipad: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Safari/605.1.15',
  desktopSafari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Safari/605.1.15',
  firefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0',
  chrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36',
};

test.describe('M2：記憶體分級', () => {
  test('TM-06 detectMemoryTier 表驅動（iPhone／iPad／deviceMemory 各值／桌面 Safari／Firefox）', async ({ browser }) => {
    const page = await openWithHook(await newCtx(browser), M2_NAMES, 'new');
    const rows: [string, any, string, string][] = [
      ['iPhone', { userAgent: UA.iphone, platform: 'iPhone', maxTouchPoints: 5 }, 'low', 'ios'],
      ['iPadOS（偽裝成 Mac）', { userAgent: UA.ipad, platform: 'MacIntel', maxTouchPoints: 5 }, 'low', 'ios'],
      ['桌面 Safari（Mac，無觸控）', { userAgent: UA.desktopSafari, platform: 'MacIntel', maxTouchPoints: 0 }, 'standard', 'default'],
      ['Firefox（無 deviceMemory）', { userAgent: UA.firefox, platform: 'Win32', maxTouchPoints: 0 }, 'standard', 'default'],
      ['Chrome deviceMemory 0.5', { userAgent: UA.chrome, platform: 'Win32', deviceMemory: 0.5 }, 'low', 'deviceMemory'],
      ['Chrome deviceMemory 2', { userAgent: UA.chrome, platform: 'Win32', deviceMemory: 2 }, 'low', 'deviceMemory'],
      ['Chrome deviceMemory 4', { userAgent: UA.chrome, platform: 'Win32', deviceMemory: 4 }, 'low', 'deviceMemory'],
      ['Chrome deviceMemory 8', { userAgent: UA.chrome, platform: 'Win32', deviceMemory: 8 }, 'standard', 'deviceMemory'],
    ];
    const got = await page.evaluate((rows) => rows.map(([, nav]: any) => (window as any).__t.detectMemoryTier(nav)), rows);
    rows.forEach(([name, , tier, source], i) => expect(got[i], name).toEqual({ tier, source }));
  });

  test('TM-07 dtype 預期表：可用記憶體＝分級預算（low 1024／無 performance.memory 的 standard 預算；spec 原為 2048，v24 補修降為 1536，dtype 表不變）；Chromium standard 與 v23.2 相同', async ({ browser }) => {
    const page = await openWithHook(await newCtx(browser), M2_NAMES, 'new');
    const models = ['Xenova/whisper-base', 'Xenova/whisper-small', 'Xenova/whisper-medium', 'onnx-community/whisper-large-v3-turbo', 'unknown/model'];
    const run = (env: { ua: string; platform: string; touch: number; dm?: number; mem?: { lim: number; used: number } | null }) =>
      page.evaluate(({ env, models }) => {
        const def = (o: any, k: string, v: any) => Object.defineProperty(o, k, { configurable: true, get: () => v });
        def(navigator, 'userAgent', env.ua); def(navigator, 'platform', env.platform); def(navigator, 'maxTouchPoints', env.touch); def(navigator, 'deviceMemory', env.dm);
        def(performance, 'memory', env.mem ? { jsHeapSizeLimit: env.mem.lim * 1048576, usedJSHeapSize: env.mem.used * 1048576, totalJSHeapSize: 0 } : undefined);
        return models.map((m: string) => (window as any).__t._dtypeFallback(m));
      }, { env, models });
    // 欄位：base(145) small(460) medium(1500) large(1600) unknown(500)
    expect(await run({ ua: UA.chrome, platform: 'Win32', touch: 0, dm: 4, mem: { lim: 4096, used: 100 } })).toEqual(['fp32', 'q4', 'q4', 'q4', 'q4']);   // low（可用 3996 → 上限 1024）
    expect(await run({ ua: UA.chrome, platform: 'Win32', touch: 0, dm: 8, mem: { lim: 4096, used: 1096 } })).toEqual(['fp32', 'fp32', 'q4', 'q4', 'fp32']);   // standard Chromium：可用 3000，與 v23.2 公式輸出相同
    expect(await run({ ua: UA.firefox, platform: 'Win32', touch: 0, dm: undefined, mem: null })).toEqual(['fp32', 'q8', 'q4', 'q4', 'q8']);                    // 無 performance.memory：standard 預算（1536；spec 原為 2048，dtype 表相同）
    expect(await run({ ua: UA.iphone, platform: 'iPhone', touch: 5, dm: undefined, mem: null })).toEqual(['fp32', 'q4', 'q4', 'q4', 'q4']);                   // iOS：low 預算 1024
  });

  for (const [label, env, expectVisible] of [
    ['low（iOS）', { ua: UA.iphone, platform: 'iPhone', touch: 5, dm: undefined }, { base: false, small: false, medium: true, large: true, lowText: true }],
    ['standard（Chrome 8 GB）', { ua: UA.chrome, platform: 'Win32', touch: 0, dm: 8 }, { base: false, small: false, medium: false, large: true, lowText: false }],
  ] as const) {
    test(`TM-08 警告框（${label}）`, async ({ browser }) => {
      const ctx = await newCtx(browser); const page = await ctx.newPage();
      await page.addInitScript((env) => {
        const def = (o: any, k: string, v: any) => Object.defineProperty(o, k, { configurable: true, get: () => v });
        def(navigator, 'userAgent', env.ua); def(navigator, 'platform', env.platform); def(navigator, 'maxTouchPoints', env.touch); def(navigator, 'deviceMemory', env.dm);
        def(navigator, 'gpu', undefined);
      }, env);
      await page.goto(BASE_URL_);
      const state = async (model: string) => {
        await page.locator(`.model-btn[data-model="${model}"]`).click();
        return page.evaluate(() => ({ box: getComputedStyle(document.getElementById('ramWarn')!).display !== 'none', low: getComputedStyle(document.getElementById('ramWarnLow')!).display !== 'none' }));
      };
      expect((await state('Xenova/whisper-base')).box).toBe(expectVisible.base);
      expect((await state('Xenova/whisper-small')).box).toBe(expectVisible.small);
      const med = await state('Xenova/whisper-medium');
      expect(med.box).toBe(expectVisible.medium); expect(med.low).toBe(expectVisible.lowText && expectVisible.medium);
      const big = await state('onnx-community/whisper-large-v3-turbo');
      expect(big.box).toBe(expectVisible.large); expect(big.low).toBe(expectVisible.lowText);
    });
  }
});

// ══ M3：錯誤驅動降級（假 Whisper Worker 依編排回覆；其餘流程為真實主程式）════════════════
import { installScriptedWorker, buildSegments, type Rule } from './harness';
import { downloadText } from './helpers';

async function runM3(browser: any, opts: { rules?: Rule[]; backend?: 'webgpu'; media?: string; timeoutMs?: number; gpu?: boolean; expectFail?: boolean; which?: 'old' | 'new' }) {
  const ctx = await newCtx(browser);
  const segs = await buildSegments(ctx, { segments: 3, linesPerSegment: 3, charsPerLine: 12, termRate: 0.2, seed: 3 });
  const page = await ctx.newPage();
  await installScriptedWorker(page, { segments: segs, rules: opts.rules, backend: opts.backend });
  // 固定環境：deviceMemory 8（standard 分級），預設模型 base → 首次載入 fp32，才有「更輕」的空間
  await page.addInitScript(() => Object.defineProperty(navigator, 'deviceMemory', { configurable: true, get: () => 8 }));
  if (opts.gpu) await page.addInitScript(() => Object.defineProperty(navigator, 'gpu', { configurable: true, get: () => ({}) }));
  await page.route('**/index.html', async (r) => {
    const fs = await import('fs');
    r.fulfill({ contentType: 'text/html; charset=utf-8', body: readPageHtml(opts.which ?? 'new') });
  });
  await page.goto(BASE_URL_);
  await setToggles(page, [], ['tog_vad', 'tog_diarization']);
  const [media] = ensureMedia([opts.media ?? 'mono16k-60s.wav']);
  await page.locator('#fileInput').setInputFiles(media);
  await page.locator('#startBtn').click();
  if (opts.expectFail) await page.locator('.batch-item.error').waitFor({ timeout: 60_000 });
  else await expect(page.locator('.batch-item.done')).toHaveCount(1, { timeout: 90_000 });
  const info = await page.evaluate(() => ({
    log: document.getElementById('logBox')!.textContent || '',
    label: document.querySelector('.batch-item .batch-item-status')?.textContent || '',
    wlog: (window as any).__workerLog as any[],
  }));
  const text = opts.expectFail ? '' : await downloadText(page);
  return { ...info, text, loads: info.wlog.filter((e) => e.type === 'LOAD_MODEL'), runs: info.wlog.filter((e) => e.type === 'RUN_CHUNK'), segs };
}
const seg1Text = (segs: any[]) => segs[1][0].text;

test.describe('M3：錯誤驅動降級', () => {
  test.setTimeout(240_000);
  let clean: { text: string; log: string };
  test.beforeAll(() => { ensureMedia(['mono16k-60s.wav', 'mono16k-10min.wav']); });

  test('TM-09g 無錯誤的正常流程：輸出與 v23.2 逐字相同（重構的安全網）', async ({ browser }) => {
    const o = await runM3(browser, { which: 'old' }), n = await runM3(browser, { which: 'new' });
    expect(n.text).toBe(o.text);
    expect(n.text.length).toBeGreaterThan(50);
    expect(n.loads.length).toBe(1); expect(n.label).toBe('完成');
    clean = { text: n.text, log: n.log };
  });

  test('TM-09a OOM 一次 → 以較輕 dtype 重載並重試成功；輸出等於無錯誤；日誌有原始錯誤文字', async ({ browser }) => {
    const r = await runM3(browser, { rules: [{ segIdx: 1, attempt: 0, reply: { type: 'CHUNK_ERROR', error: 'Array buffer allocation failed' } }] });
    expect(r.text).toBe((await runM3(browser, {})).text);
    expect(r.loads.length).toBe(2);
    const order = ['fp32', 'fp16', 'q8', 'q4'];
    expect(order.indexOf(r.loads[1].dtype)).toBeGreaterThan(order.indexOf(r.loads[0].dtype));
    expect(r.log).toContain('Array buffer allocation failed');
    expect(r.log).toContain('重試成功');
  });

  test('TM-09b 同一段永遠失敗 → 只重試一次、輸出缺該段、結尾摘要與完成標籤', async ({ browser }) => {
    const r = await runM3(browser, { rules: [{ segIdx: 1, reply: { type: 'CHUNK_ERROR', error: 'boom-permanent' } }] });
    expect(r.runs.filter((e) => e.segIdx === 1).length).toBe(2);
    expect(r.text).not.toContain(seg1Text(r.segs));
    expect(r.text).toContain(r.segs[0][0].text); expect(r.text).toContain(r.segs[2][0].text);
    expect(r.label).toBe('完成（1 段跳過）');
    expect(r.log).toMatch(/1 段辨識失敗已跳過：第 2 段（.*起）/);
    expect(r.log).toContain('boom-permanent');
  });

  test('TM-09c 非記憶體類錯誤一次 → 不重載模型，同 Worker 重試成功', async ({ browser }) => {
    const r = await runM3(browser, { rules: [{ segIdx: 1, attempt: 0, reply: { type: 'CHUNK_ERROR', error: 'boom' } }] });
    expect(r.loads.length).toBe(1);
    expect(r.text).toBe((await runM3(browser, {})).text);
  });

  test('TM-09d 逾時（Worker 不回覆）→ 重建 Worker 並重試成功', async ({ browser }) => {
    const ctx = await newCtx(browser);
    const r = await (async () => {
      // 以 evalIn 縮短逾時：需要在頁面載入後、開始辨識前設定；runM3 不支援，故此處手動組裝
      const segs = await buildSegments(ctx, { segments: 3, linesPerSegment: 3, charsPerLine: 12, termRate: 0.2, seed: 3 });
      const page = await ctx.newPage();
      await installScriptedWorker(page, { segments: segs, rules: [{ segIdx: 1, attempt: 0, silent: true }] });
      await exposeInternals(page, [], 'new');
      await page.goto(BASE_URL_);
      await page.waitForFunction(() => !!(window as any).__t);
      await page.evaluate(() => (window as any).__t.evalIn('CHUNK_TIMEOUT_MS = 500'));
      await setToggles(page, [], ['tog_vad', 'tog_diarization']);
      await page.locator('#fileInput').setInputFiles(ensureMedia(['mono16k-60s.wav'])[0]);
      await page.locator('#startBtn').click();
      await expect(page.locator('.batch-item.done')).toHaveCount(1, { timeout: 60_000 });
      return page.evaluate(() => ({ log: document.getElementById('logBox')!.textContent || '', n: (window as any).__nWorkers, wlog: (window as any).__workerLog }));
    })();
    expect(r.n).toBe(2);
    expect(r.log).toContain('推論逾時，重建 Worker');
    expect(r.wlog.filter((e: any) => e.type === 'LOAD_MODEL').length).toBe(2);
  });

  test('TM-09e Worker 未捕捉例外（error 事件）→ 立即失敗並重試，不必等 300 秒逾時', async ({ browser }) => {
    const t0 = Date.now();
    const r = await runM3(browser, { rules: [{ segIdx: 1, attempt: 0, crash: 'Aborted(OOM)' }] });
    expect(Date.now() - t0).toBeLessThan(60_000);
    expect(r.loads.length).toBe(2);
    expect(r.log).toContain('crash');
    expect(r.text).toBe((await runM3(browser, {})).text);
  });

  test('TM-09f WebGPU 後端 device lost → 改用 WASM（preferGpu=false）重載並重試成功', async ({ browser }) => {
    const r = await runM3(browser, { backend: 'webgpu', gpu: true, rules: [{ segIdx: 1, attempt: 0, reply: { type: 'CHUNK_ERROR', error: 'GPUDevice was lost' } }] });
    expect(r.loads[0].preferGpu).toBe(true);
    expect(r.loads[1].preferGpu).toBe(false);
    expect(r.log).toContain('改用 CPU（WASM）');
  });

  test('TM-09h 取消：在等待逾時的重試期間按取消 → 立即停止', async ({ browser }) => {
    const ctx = await newCtx(browser);
    const segs = await buildSegments(ctx, { segments: 3, linesPerSegment: 3, charsPerLine: 12, termRate: 0.2, seed: 3 });
    const page = await ctx.newPage();
    await installScriptedWorker(page, { segments: segs, rules: [{ segIdx: 1, silent: true }] });
    await page.goto(BASE_URL_);
    await setToggles(page, [], ['tog_vad', 'tog_diarization']);
    await page.locator('#fileInput').setInputFiles(ensureMedia(['mono16k-60s.wav'])[0]);
    await page.locator('#startBtn').click();
    await page.waitForFunction(() => ((window as any).__workerLog || []).some((e: any) => e.type === 'RUN_CHUNK' && e.segIdx === 1), null, { timeout: 30_000 });
    const t0 = Date.now();
    await page.locator('#cancelBtn').click();
    await page.locator('#logBox', { hasText: '已取消' }).waitFor({ timeout: 10_000 });
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  test('TM-09i 連續失敗：前 5 段永遠失敗 → 第 4～5 段不再重試，第 5 段後終止並提示改用較小模型', async ({ browser }) => {
    const rules: Rule[] = [0, 1, 2, 3, 4].map((k) => ({ segIdx: k, reply: { type: 'CHUNK_ERROR', error: 'boom-permanent' } }));
    const r = await runM3(browser, { rules, media: 'mono16k-10min.wav', expectFail: true });
    const per = (k: number) => r.runs.filter((e) => e.segIdx === k).length;
    expect([per(0), per(1), per(2), per(3), per(4)]).toEqual([2, 2, 2, 1, 1]);
    expect(r.log).toContain('連續 5 段辨識失敗');
    expect(r.log).toContain('base 或 small');
  });
});
