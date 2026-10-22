// tests/perf-freeze.spec.ts — 長影片後處理：主執行緒停頓、取消延遲、進度、總耗時（v24 對 v23.2，同機同檔）
import { test, expect, type Page } from '@playwright/test';
import { newCtx, openWithHook, exposeInternals, installScriptedWorker, installMonitor, stallReport, buildSegments, ensureMedia, BASE_URL, type Stall } from './harness';
import { setToggles } from './helpers';
import { readPageHtml } from './harness';

// 1 小時檔（約 144 段）的後處理負載以 10 分鐘檔（24 段）× 45 行/段近似：進入後處理約 1,080 行（handoff §1.2(c)：約 1,000 行同量級）
const SEGMENTS = 24, LINES = 45;
const EXTRA_DICT = (n: number) => `(() => { const D = DEFAULT_MEDICAL_DICT.slice(0, ${n}).map(e => ({ raw: e.raw.split('|').map(v => v.slice(0, -1) + '症').join('|'), zh: e.zh.slice(0, -1) + '症', en: e.en + ' X' })); medicalDict.push(...D); return medicalDict.length; })()`;

async function fullRun(browser: any, which: 'old' | 'new', opts: { cancelDuringPost?: boolean } = {}) {
  const ctx = await newCtx(browser);
  const segs = await buildSegments(ctx, { segments: SEGMENTS, linesPerSegment: LINES, charsPerLine: 22, termRate: 0.04, seed: 21 });
  const page = await ctx.newPage();
  await installScriptedWorker(page, { segments: segs });
  await installMonitor(page);
  if (opts.cancelDuringPost && which === 'old') await page.addInitScript(() => {
    document.addEventListener('DOMContentLoaded', () => {
      let clicked = false; const lbl = document.getElementById('progLabel')!;
      new MutationObserver(() => { if (!clicked && (lbl.textContent || '').includes('後處理中')) { clicked = true; document.getElementById('cancelBtn')!.click(); } })
        .observe(lbl, { childList: true, characterData: true, subtree: true });
    });
  });
  await page.route('**/index.html', (r) => r.fulfill({ contentType: 'text/html; charset=utf-8',
    body: (() => { let h = readPageHtml(which); const lo = h.lastIndexOf('<script'); const cb = h.lastIndexOf('</script>', lo);
      return h.slice(0, cb) + '\nwindow.__t={}; __t.evalIn=(s)=>eval(s); __t.createSlicer=(typeof createSlicer!=="undefined")?createSlicer:undefined;\n' + h.slice(cb); })() }));
  await page.goto(BASE_URL);
  await page.waitForFunction(() => !!(window as any).__t);
  const defaultN = await page.evaluate(() => (window as any).__t.evalIn('DEFAULT_MEDICAL_DICT.length'));
  const dictN = await page.evaluate((src) => (window as any).__t.evalIn(src), EXTRA_DICT(100));
  await setToggles(page, ['tog_medical', 'tog_fuzzy'], ['tog_vad', 'tog_diarization']);
  await page.locator('#fileInput').setInputFiles(ensureMedia(['mono16k-10min.wav'])[0]);
  await page.locator('#startBtn').click();
  if (opts.cancelDuringPost) {
    if (which === 'new') {
      await page.waitForFunction(() => { const w = window as any; const done = (w.__workerLog || []).filter((e: any) => e.type === 'REPLY' && e.of === 'CHUNK_DONE').length; return done >= 24 && (document.getElementById('progLabel')?.textContent || '').includes('後處理中'); }, null, { timeout: 120_000, polling: 20 });
      await page.waitForTimeout(150);
      await page.locator('#cancelBtn').click();
    }   // v23.2：同步凍結期間無法輪詢頁面，改由頁內 MutationObserver 在標籤出現「後處理中」的當下點擊（見 inPageCancel）
    // v23.2：後處理是同步工作，取消的 click 要等整段做完才處理，而此時檔案已完成 → 取消被忽略，批次項目變成 done
    const outcome = await Promise.race([
      page.locator('#logBox', { hasText: '已取消' }).waitFor({ timeout: 120_000 }).then(() => 'cancelled'),
      page.locator('.batch-item.done').waitFor({ timeout: 120_000 }).then(() => 'completed'),
    ]);
    const keys = await page.evaluate(async () => {
      const out: string[] = []; const dbs = await indexedDB.databases();
      for (const d of dbs) { const db: IDBDatabase = await new Promise((res, rej) => { const q = indexedDB.open(d.name!); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
        for (const name of Array.from(db.objectStoreNames)) { const ks: any[] = await new Promise((res) => { const q = db.transaction(name).objectStore(name).getAllKeys(); q.onsuccess = () => res(q.result as any[]); q.onerror = () => res([]); }); out.push(...ks.map(String).filter((k) => k.startsWith('task:'))); } db.close(); }
      return out;
    });
    return { dictN, defaultN, stall: await stallReport(page), taskKeys: keys, outcome };
  }
  await expect(page.locator('.batch-item.done')).toHaveCount(1, { timeout: 280_000 });
  return { dictN, defaultN, stall: await stallReport(page), taskKeys: [] as string[], outcome: 'completed' };
}

test.describe('後處理凍結（約 1,080 行、預設詞典＋100 筆、預設後處理全開）', () => {
  test.setTimeout(600_000);

  test('TF-12／14／18 停頓、進度、總耗時：v24 對 v23.2', async ({ browser }) => {
    const o = await fullRun(browser, 'old'), n = await fullRun(browser, 'new');
    console.log('TF-12 v23.2', JSON.stringify(o.stall)); console.log('TF-12 v24', JSON.stringify(n.stall));
    expect(n.dictN).toBe(n.defaultN + 100);   // 預設詞典＋測試額外灌入的 100 筆（不寫死總數：預設詞典會增修）
    // TF-12：後處理視窗內主執行緒最大停頓（rAF 間隔與 longtask 兩種量法）
    expect(n.stall.maxRafGapMs).toBeLessThanOrEqual(100);
    expect(n.stall.maxLongtaskMs).toBeLessThanOrEqual(100);
    expect(o.stall.maxRafGapMs).toBeGreaterThan(1000);              // 對照：v23.2 凍結數秒（證明測試有鑑別力）
    // TF-14：進度標籤更新次數、單調性
    expect(n.stall.progressUpdates).toBeGreaterThanOrEqual(5);
    expect(n.stall.progressMonotonic).toBe(true);
    // TF-18：總耗時（視窗＝最後一次 CHUNK_DONE → 完成）
    const ratio = n.stall.windowMs / o.stall.windowMs;
    console.log(`TF-18 後處理總耗時 v23.2 ${o.stall.windowMs} ms → v24 ${n.stall.windowMs} ms (ratio ${ratio.toFixed(3)})`);
    expect(ratio).toBeLessThan(1.0);
  });

  test('TF-13 取消：後處理中按取消 → v24 ≤ 200 ms 生效且保留斷點；v23.2 的取消被忽略（檔案照常完成）', async ({ browser }) => {
    const n = await fullRun(browser, 'new', { cancelDuringPost: true });
    console.log('TF-13 v24', JSON.stringify(n.stall), n.outcome, n.taskKeys);
    expect(n.outcome).toBe('cancelled');
    expect(n.stall.cancelLatencyMs).toBeLessThanOrEqual(200);
    expect(n.taskKeys.length).toBeGreaterThan(0);
    const o = await fullRun(browser, 'old', { cancelDuringPost: true });
    console.log('TF-13 v23.2', JSON.stringify(o.stall), o.outcome);
    expect(o.outcome).toBe('completed');
  });

  test('TF-16／17 函式層級效益：模糊比對新／舊 ≤ 0.2；精確詞典新／舊 ≤ 0.5', async ({ browser }) => {
    const ctx = await newCtx(browser);
    const segs = await buildSegments(ctx, { segments: 10, linesPerSegment: 60, charsPerLine: 22, termRate: 0.04, seed: 8 });
    const lines = segs.flat().map((c) => c.text).slice(0, 600);
    const run = async (which: 'old' | 'new') => {
      const p = await openWithHook(ctx, ['applyFuzzyMedicalDict', 'applyMedicalDict', 'buildDictMap', 'DEFAULT_MEDICAL_DICT'], which);
      try {
        return await p.evaluate(async ({ lines, extra }) => {
          const T = (window as any).__t; const D = T.DEFAULT_MEDICAL_DICT;
          const dict = [...D, ...D.slice(0, extra).map((e: any) => ({ raw: e.raw.split('|').map((v: string) => v.slice(0, -1) + '症').join('|'), zh: e.zh.slice(0, -1) + '症', en: e.en + ' X' }))];
          const subs = lines.map((t: string, i: number) => ({ index: i + 1, start: i, end: i + 1, text: t }));
          await T.applyFuzzyMedicalDict(subs.slice(0, 10), dict); await T.applyMedicalDict(subs.slice(0, 10), T.buildDictMap(dict));   // 暖機
          let t0 = performance.now(); await T.applyFuzzyMedicalDict(subs, dict); const fuzzy = performance.now() - t0;
          const dm = T.buildDictMap(D); const many = subs.concat(subs).slice(0, 1000);
          t0 = performance.now(); await T.applyMedicalDict(many, dm); const exact = performance.now() - t0;
          return { fuzzy, exact, variants: dm.size };
        }, { lines, extra: 100 });
      } finally { await p.close(); }
    };
    const o = await run('old'), n = await run('new');
    console.log(`TF-16 模糊比對 600 行 v23.2 ${o.fuzzy.toFixed(0)} ms → v24 ${n.fuzzy.toFixed(0)} ms (ratio ${(n.fuzzy / o.fuzzy).toFixed(3)})`);
    console.log(`TF-17 精確詞典 1000 行（${n.variants} variants）v23.2 ${o.exact.toFixed(0)} ms → v24 ${n.exact.toFixed(0)} ms (ratio ${(n.exact / o.exact).toFixed(3)})`);
    expect(n.fuzzy / o.fuzzy).toBeLessThanOrEqual(0.2);
    expect(n.exact / o.exact).toBeLessThanOrEqual(0.5);
  });
});
