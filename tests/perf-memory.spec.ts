// tests/perf-memory.spec.ts — TM-05：解碼 JS 堆積峰值，v24 對 v23.2（同機、同檔、預設設定＝正規化開啟）
// 需要 --enable-precise-memory-info（perf 專案已設定）。`usedJSHeapSize` 包含 ArrayBuffer 後備儲存（實測：與 handoff 的做法一致）。
import { test, expect } from '@playwright/test';
import { newCtx, openWithHook, ensureMedia } from './harness';

const FX = '/tests/fixtures/generated/';
async function peakMB(browser: any, which: 'old' | 'new', file: string) {
  const page = await openWithHook(await newCtx(browser), ['decodeAudio'], which);
  try {
    return await page.evaluate(async (url) => {
      const T = (window as any).__t;
      (document.getElementById('tog_diarization') as HTMLInputElement | null) && ((document.getElementById('tog_diarization') as HTMLInputElement).checked = false);
      const blob = await (await fetch(url)).blob();
      const f = new File([blob], 'x.wav', { lastModified: 1 });
      await new Promise((r) => setTimeout(r, 300));
      const base = (performance as any).memory.usedJSHeapSize; let peak = base;
      const iv = setInterval(() => { peak = Math.max(peak, (performance as any).memory.usedJSHeapSize); }, 10);
      const t0 = performance.now();
      const { audio } = await T.decodeAudio(f);
      const ms = performance.now() - t0;
      clearInterval(iv); peak = Math.max(peak, (performance as any).memory.usedJSHeapSize);
      return { peakMB: Math.round((peak - base) / 1048576), ms: Math.round(ms), samples: audio.type === 'idb' ? audio.totalSamples : audio.length };
    }, FX + file);
  } finally { await page.close(); }
}

test.describe('TM-05 解碼峰值（新／舊）', () => {
  // 門檻＝實測比值的寬鬆上限：記憶體路徑（<50 MB）實測 0.09～0.18；IDB 分片路徑（>50 MB）多了分片複本，實測 0.30～0.48
  const cases = [['st44k-4min.wav', 3840000, 0.35], ['mono16k-10min.wav', 9600000, 0.35], ['st44k-10min.wav', 9600000, 0.6], ['mono16k-1h.wav', 57600000, 0.5]] as const;
  for (const [name, samples, maxRatio] of cases) {
    test(`${name}`, async ({ browser }) => {
      ensureMedia([name]);
      const o = await peakMB(browser, 'old', name), n = await peakMB(browser, 'new', name);
      const ratio = n.peakMB / Math.max(o.peakMB, 1);
      console.log(`TM-05 ${name}: v23.2 ${o.peakMB} MB (${o.ms} ms) → v24 ${n.peakMB} MB (${n.ms} ms)  ratio=${ratio.toFixed(2)}`);
      expect(n.samples).toBe(o.samples);
      expect(n.samples).toBe(samples);
      expect(ratio).toBeLessThanOrEqual(maxRatio);
    });
  }
});
