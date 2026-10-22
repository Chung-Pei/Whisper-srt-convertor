// tests/round11-m3a-rawerror.spec.ts — T-M3a：段落辨識失敗時，原始錯誤文字必須進日誌
// （spec §2.2 E-7／§3.2 M3「先記錄原始錯誤文字，建立真實證據」；M3b 重構後此行為仍須成立，故永久保留）
import { test, expect } from '@playwright/test';
import { setToggles } from './helpers';
import { newCtx, ensureMedia, ROOT_HTML, BASE_URL, installScriptedWorker, buildSegments, type Rule } from './harness';

async function runWithRule(browser: any, rule: Rule) {
  const ctx = await newCtx(browser);
  const segs = await buildSegments(ctx, { segments: 3, linesPerSegment: 3, charsPerLine: 12, termRate: 0.2, seed: 3 });
  const page = await ctx.newPage();
  await installScriptedWorker(page, { segments: segs, rules: [rule] });
  await page.addInitScript(() => Object.defineProperty(navigator, 'deviceMemory', { configurable: true, get: () => 8 }));
  await page.route('**/index.html', async (r) => {
    const fs = await import('fs');
    r.fulfill({ contentType: 'text/html; charset=utf-8', body: fs.readFileSync(ROOT_HTML, 'utf8') });
  });
  await page.goto(BASE_URL);
  await setToggles(page, [], ['tog_vad', 'tog_diarization']);
  const [media] = ensureMedia(['mono16k-60s.wav']);
  await page.locator('#fileInput').setInputFiles(media);
  await page.locator('#startBtn').click();
  await expect(page.locator('.batch-item.done')).toHaveCount(1, { timeout: 90_000 });
  return page.evaluate(() => document.getElementById('logBox')!.textContent || '');
}

test.describe('T-M3a：原始錯誤文字進日誌', () => {
  test.setTimeout(180_000);

  test('TM-09z-1 Worker 回 CHUNK_ERROR：日誌含該段的原始錯誤文字', async ({ browser }) => {
    const log = await runWithRule(browser, { segIdx: 1, reply: { type: 'CHUNK_ERROR', error: 'RAW-CHUNK-ERR array buffer allocation failed' } });
    expect(log).toContain('RAW-CHUNK-ERR array buffer allocation failed');
  });

  test('TM-09z-2 Worker 回 ERROR：日誌含原始錯誤文字', async ({ browser }) => {
    const log = await runWithRule(browser, { segIdx: 1, reply: { type: 'ERROR', payload: 'RAW-WORKER-ERR boom' } });
    expect(log).toContain('RAW-WORKER-ERR boom');
  });
});
