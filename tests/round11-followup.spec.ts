// tests/round11-followup.spec.ts — V24 審查後續修正（deferred minors）＋記憶體預算；每項先紅後綠
import { test, expect, type Page } from '@playwright/test';
import { setToggles } from './helpers';
import { newCtx, ensureMedia, BASE_URL, exposeInternals, installScriptedWorker, buildSegments, type Rule } from './harness';

// 主程式是 module：以 exposeInternals 取得內部名稱（__t.<name>）與模組內 eval（__t.evalIn）
async function openApp(page: Page, names: string[] = []) {
  await page.addInitScript(() => Object.defineProperty(navigator, 'deviceMemory', { configurable: true, get: () => 8 }));
  await exposeInternals(page, names);
  await page.goto(BASE_URL);
}

async function scriptedRun(browser: any, opts: { rules: Rule[]; backend?: 'webgpu'; gpu?: boolean; init?: () => void; hooks?: string[]; before?: (page: Page) => Promise<void> }) {
  const ctx = await newCtx(browser);
  const segs = await buildSegments(ctx, { segments: 3, linesPerSegment: 3, charsPerLine: 12, termRate: 0.2, seed: 3 });
  const page = await ctx.newPage();
  await installScriptedWorker(page, { segments: segs, rules: opts.rules, backend: opts.backend });
  if (opts.gpu) await page.addInitScript(() => Object.defineProperty(navigator, 'gpu', { configurable: true, get: () => ({}) }));
  if (opts.init) await page.addInitScript(opts.init);
  await openApp(page, opts.hooks);
  await setToggles(page, [], ['tog_vad', 'tog_diarization']);
  if (opts.before) await opts.before(page);
  await page.locator('#fileInput').setInputFiles(ensureMedia(['mono16k-60s.wav'])[0]);
  await page.locator('#startBtn').click();
  await expect(page.locator('.batch-item.done')).toHaveCount(1, { timeout: 90_000 });
  return page;
}
const logOf = (page: Page) => page.evaluate(() => document.getElementById('logBox')!.textContent || '');

test.describe('後續修正（deferred minors）', () => {
  test.setTimeout(180_000);

  test('TM-09k 重試重載使用「本次工作開始時」的模型，不受辨識中 selectedModel 被改動影響（縱深防禦）', async ({ browser }) => {
    const page = await scriptedRun(browser, {
      rules: [{ segIdx: 1, attempt: 0, reply: { type: 'CHUNK_ERROR', error: 'Array buffer allocation failed' } }],
      init: () => {
        const w = window as any; w.__loadModels = [];
        const Base = w.Worker;
        w.Worker = class extends Base {
          postMessage(msg: any, t?: any) {
            if (msg?.type === 'LOAD_MODEL') w.__loadModels.push(msg.payload.modelId);
            if (msg?.type === 'RUN_CHUNK' && msg.payload.segIdx === 1 && !w.__switched) {
              w.__switched = true;   // selectedModel 在辨識中被改掉（模型按鈕在辨識中已停用，改以內部賦值模擬）
              w.__t.evalIn("selectedModel = 'Xenova/whisper-small'");
            }
            return super.postMessage(msg, t);
          }
        };
      },
    });
    const loads: string[] = await page.evaluate(() => (window as any).__loadModels);
    expect(loads).toEqual(['Xenova/whisper-base', 'Xenova/whisper-base']);
  });

  test('TM-09l WebGPU 失敗改用 WASM 重載後，畫面的後端標示同步更新', async ({ browser }) => {
    const page = await scriptedRun(browser, {
      backend: 'webgpu', gpu: true,
      rules: [{ segIdx: 1, attempt: 0, reply: { type: 'CHUNK_ERROR', error: 'GPUDevice was lost' } }],
      before: async (p) => { await p.locator('.model-btn[data-model="Xenova/whisper-base"]').click(); },   // 點選模型按鈕後才會建立 infoBox 的後端提示列
    });
    const ui = await page.evaluate(() => ({
      stat: document.getElementById('statModel')!.textContent,
      hint: document.querySelector('#infoBox span')?.textContent || '',
    }));
    expect(ui.stat).toBe('CPU');
    expect(ui.hint).toContain('WASM');
  });

  test('TM-09m Worker 異常終止的重載日誌不說「記憶體不足」；OOM 仍說', async ({ browser }) => {
    const crash = await scriptedRun(browser, { rules: [{ segIdx: 1, attempt: 0, crash: 'Worker exploded' }] });
    const logCrash = await logOf(crash);
    expect(logCrash).toContain('Worker 異常終止');
    expect(logCrash).not.toContain('記憶體不足，改用較輕');
    const oom = await scriptedRun(browser, { rules: [{ segIdx: 1, attempt: 0, reply: { type: 'CHUNK_ERROR', error: 'Array buffer allocation failed' } }] });
    expect(await logOf(oom)).toContain('記憶體不足，改用較輕');
  });

  test('TM-09n 後處理日誌的項數取自「實際套用的設定快照」（整個辨識只讀一次設定）', async ({ browser }) => {
    let expectCount = 0;
    const page = await scriptedRun(browser, {
      rules: [], hooks: ['getPostConfig'],
      before: async (p) => {
        await setToggles(p, ['tog_merge', 'tog_period', 'tog_medical'], ['tog_fuzzy', 'tog_hallucination', 'tog_opencc']);
        expectCount = await p.evaluate(() => Object.values((window as any).__t.getPostConfig()).filter((v: any) => v === true).length);
        await p.evaluate(() => (window as any).__t.evalIn(`(() => {
          const orig = getPostConfig; window.__cfgCalls = 0;
          getPostConfig = () => {   // 第 2 次起回傳「全部關閉」：模擬後處理期間使用者改了開關
            window.__cfgCalls++; const c = orig();
            return window.__cfgCalls === 1 ? c : Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v === true ? false : v]));
          };
        })()`));
      },
    });
    expect(expectCount).toBeGreaterThan(0);
    expect(await page.evaluate(() => (window as any).__cfgCalls)).toBe(1);
    expect(await logOf(page)).toContain(`後處理套用（${expectCount} 項）`);
  });
});

test.describe('後續修正：辨識中停用模型按鈕', () => {
  test.setTimeout(120_000);

  test('TM-09r 辨識中所有模型按鈕停用、點擊無效（不換模型、不釋放 Worker）；完成後恢復', async ({ browser }) => {
    const page = await scriptedRun(browser, {
      rules: [],
      init: () => {
        const w = window as any; w.__midRun = null; const Base = w.Worker;
        w.Worker = class extends Base {
          postMessage(msg: any, t?: any) {
            if (msg?.type === 'RUN_CHUNK' && !w.__midRun) {
              const btns = [...document.querySelectorAll('.model-btn')] as HTMLButtonElement[];
              btns.find((b) => b.dataset.model === 'Xenova/whisper-small')!.click();     // 使用者在辨識中點選另一個模型
              w.__midRun = { disabled: btns.map((b) => b.disabled), active: (document.querySelector('.model-btn.active') as HTMLElement).dataset.model };
            }
            return super.postMessage(msg, t);
          }
        };
      },
    });
    const mid = await page.evaluate(() => (window as any).__midRun);
    expect(mid.disabled.length).toBe(5);
    expect(mid.disabled.every(Boolean)).toBe(true);
    expect(mid.active).toBe('Xenova/whisper-base');           // 點擊無效：目前模型不變
    const after = await page.evaluate(() => ({
      disabled: [...document.querySelectorAll('.model-btn')].map((b) => (b as HTMLButtonElement).disabled),
      loads: (window as any).__workerLog.filter((e: any) => e.type === 'LOAD_MODEL').length,
    }));
    expect(after.disabled.some(Boolean)).toBe(false);          // 完成後恢復
    expect(after.loads).toBe(1);                               // 沒有因點擊而重載
  });

  test('TM-09s 取消辨識後模型按鈕恢復可用', async ({ browser }) => {
    const ctx = await newCtx(browser);
    const segs = await buildSegments(ctx, { segments: 3, linesPerSegment: 3, charsPerLine: 12, termRate: 0.2, seed: 3 });
    const page = await ctx.newPage();
    await installScriptedWorker(page, { segments: segs, rules: [{ segIdx: 0, silent: true }] });   // 第 0 段永不回覆 → 一直在辨識中
    await openApp(page);
    await setToggles(page, [], ['tog_vad', 'tog_diarization']);
    await page.locator('#fileInput').setInputFiles(ensureMedia(['mono16k-60s.wav'])[0]);
    await page.locator('#startBtn').click();
    await expect(page.locator('#cancelBtn')).toBeVisible();
    await expect(page.locator('.model-btn').first()).toBeDisabled();
    await page.locator('#cancelBtn').click();
    await expect(page.locator('.model-btn').first()).toBeEnabled({ timeout: 20_000 });
    expect(await page.locator('.model-btn:disabled').count()).toBe(0);
  });
});

test.describe('後續修正：runChunkOnWorker／錯誤分類（單元）', () => {
  test.setTimeout(60_000);

  test('TM-09o 已取消時不送出辨識：直接丟出 CANCELLED、不呼叫 postMessage', async ({ browser }) => {
    const page = await (await newCtx(browser)).newPage();
    await openApp(page, ['runChunkOnWorker']);
    const r = await page.evaluate(async () => {
      const t = (window as any).__t;
      const fake: any = { posts: 0, adds: 0, removes: 0,
        addEventListener() { this.adds++; }, removeEventListener() { this.removes++; }, postMessage() { this.posts++; } };
      t.evalIn('isCancelled = true');
      let err = '';
      try { await t.runChunkOnWorker(fake, { segIdx: 0 }, new Float32Array(10), 1000); } catch (e: any) { err = e.message; }
      t.evalIn('isCancelled = false');
      return { err, posts: fake.posts, adds: fake.adds, removes: fake.removes };
    });
    expect(r.err).toBe('CANCELLED');
    expect(r.posts).toBe(0);
    expect(r.adds).toBe(r.removes);
  });

  test('TM-09p postMessage 同步丟出例外：回報失敗（不丟出）、監聽器與計時器都清除', async ({ browser }) => {
    const page = await (await newCtx(browser)).newPage();
    await openApp(page, ['runChunkOnWorker']);
    const r = await page.evaluate(async () => {
      const t = (window as any).__t;
      const fake: any = { adds: 0, removes: 0,
        addEventListener() { this.adds++; }, removeEventListener() { this.removes++; },
        postMessage() { throw new Error('DataCloneError: boom'); } };
      let res: any = null, err = '';
      try { res = await t.runChunkOnWorker(fake, { segIdx: 0 }, new Float32Array(10), 60_000); } catch (e: any) { err = e.message; }
      return { res, err, adds: fake.adds, removes: fake.removes };
    });
    expect(r.err).toBe('');
    expect(r.res).toMatchObject({ ok: false, kind: 'other' });
    expect(r.res.error).toContain('DataCloneError: boom');
    expect(r.adds).toBe(r.removes);
  });

  test('TM-09q OOM 分類：只認記憶體相關的 RangeError；其他 RangeError 不是 OOM', async ({ browser }) => {
    const page = await (await newCtx(browser)).newPage();
    await openApp(page, ['classifyInferenceError']);
    const out = await page.evaluate(() => {
      const c = (m: string) => (window as any).__t.classifyInferenceError(m);
      return {
        stack: c('RangeError: Maximum call stack size exceeded'),
        time: c('RangeError: Invalid time value'),
        typed: c('RangeError: Invalid typed array length: 4294967296'),
        buf: c('RangeError: Array buffer allocation failed'),
        wasm: c('RangeError: WebAssembly.Memory(): could not allocate memory'),
        plain: c('Aborted(OOM)'),
      };
    });
    expect(out).toEqual({ stack: 'other', time: 'other', typed: 'oom', buf: 'oom', wasm: 'oom', plain: 'oom' });
  });
});

test.describe('後續修正：standard 記憶體預算', () => {
  test.setTimeout(60_000);

  // 無 performance.memory（Firefox／桌面 Safari）時，可用記憶體＝TIER_BUDGET_MB.standard，只用來挑 dtype（_dtypeFallback：預算 < 3×模型大小 → q4；< 5× → q8；否則 fp32）。
  // 可降到的下限：small（460 MB）要維持 q8 → 預算 ≥ 3×460 = 1380；未知模型（500 MB）要維持 q8 → ≥ 1500。低於 1380 時 small 會改 q4（辨識精度下降）。
  test('TM-07b standard 預算低於 spec 原值 2048 MB，且每個現有模型（含未知模型）的 dtype 不變、small 仍為 q8', async ({ browser }) => {
    const page = await (await newCtx(browser)).newPage();
    await page.addInitScript(() => Object.defineProperty(performance, 'memory', { configurable: true, get: () => undefined }));
    await openApp(page, ['TIER_BUDGET_MB', '_dtypeFallback']);
    const r = await page.evaluate(() => {
      const t = (window as any).__t;
      const ids = ['Xenova/whisper-base', 'Xenova/whisper-small', 'Xenova/whisper-medium', 'onnx-community/whisper-large-v3-turbo', 'unknown/model'];
      return { budget: t.TIER_BUDGET_MB.standard, low: t.TIER_BUDGET_MB.low, dtypes: ids.map((id) => t._dtypeFallback(id)) };
    });
    expect(r.budget).toBeLessThan(2048);
    expect(r.budget).toBeGreaterThanOrEqual(1500);
    expect(r.low).toBe(1024);
    expect(r.dtypes).toEqual(['fp32', 'q8', 'q4', 'q4', 'q8']);
  });
});
