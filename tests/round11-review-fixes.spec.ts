// tests/round11-review-fixes.spec.ts — V24 最終審查（fresh reviewer）後的修正；每項先紅後綠
import { test, expect } from '@playwright/test';
import { setToggles, downloadText } from './helpers';
import { newCtx, ensureMedia, ROOT_HTML, BASE_URL, installScriptedWorker, buildSegments, type Rule } from './harness';

test.describe('審查修正 I-1：重試時重載模型失敗，不得放棄整個檔案', () => {
  test.setTimeout(180_000);

  test('TM-09j OOM → 重載模型本身失敗：該段跳過並標示、日誌含重載的原始錯誤、其餘段落照常完成、輸出照常產生', async ({ browser }) => {
    const ctx = await newCtx(browser);
    const segs = await buildSegments(ctx, { segments: 3, linesPerSegment: 3, charsPerLine: 12, termRate: 0.2, seed: 3 });
    const page = await ctx.newPage();
    const rules: Rule[] = [{ segIdx: 1, attempt: 0, reply: { type: 'CHUNK_ERROR', error: 'Array buffer allocation failed' } }];
    await installScriptedWorker(page, { segments: segs, rules });
    // 第 2 次 LOAD_MODEL（＝重試前的重載）回 ERROR；第 1 次（首次載入）照常
    await page.addInitScript(() => {
      const w = window as any; w.__loads = 0;
      const Base = w.Worker;
      w.Worker = class extends Base {
        postMessage(msg: any, t?: any) {
          if (msg?.type === 'LOAD_MODEL' && ++w.__loads === 2) {
            setTimeout(() => (this as any).emit({ type: 'ERROR', payload: 'RAW-RELOAD-FAIL allocation failed during reload' }), 3);
            return;
          }
          return super.postMessage(msg, t);
        }
      };
    });
    await page.addInitScript(() => Object.defineProperty(navigator, 'deviceMemory', { configurable: true, get: () => 8 }));
    await page.route('**/index.html', async (r) => {
      const fs = await import('fs');
      r.fulfill({ contentType: 'text/html; charset=utf-8', body: fs.readFileSync(ROOT_HTML, 'utf8') });
    });
    await page.goto(BASE_URL);
    await setToggles(page, [], ['tog_vad', 'tog_diarization']);
    await page.locator('#fileInput').setInputFiles(ensureMedia(['mono16k-60s.wav'])[0]);
    await page.locator('#startBtn').click();
    await expect(page.locator('.batch-item.done')).toHaveCount(1, { timeout: 90_000 });
    const info = await page.evaluate(() => ({
      log: document.getElementById('logBox')!.textContent || '',
      label: document.querySelector('.batch-item .batch-item-status')?.textContent || '',
    }));
    expect(info.label).toContain('1 段跳過');
    expect(info.log).toContain('RAW-RELOAD-FAIL allocation failed during reload');
    const text = await downloadText(page);
    expect(text.length).toBeGreaterThan(50);
  });
});
