// tests/preview-panel.spec.ts
//
// Whisper 離線字幕產生器 v22.1 — 字幕即時預覽面板 Playwright 測試
//
// ⚠ 更正（v22.1 稽核時發現前一版本此處註解已過時）：本沙盒環境「無法執行
//   Playwright」的說法並不成立——已於 /opt/pw-browsers/ 實際找到預先安裝的
//   Chromium，並以 --no-sandbox 成功啟動、載入頁面、於真實瀏覽器中呼叫本次
//   修改的函式並比對輸出，詳見隨附稽核報告。真正無法在本沙盒完成的是「本檔案
//   端對端案例 1–9」——這些案例會實際上傳音檔並等待 Whisper 模型下載與推論完
//   成，而模型 CDN（cdn.jsdelivr.net／unpkg.com）不在本沙盒網路白名單內，
//   故仍需於使用者本機或 CI（具備一般網際網路存取）以 `npx playwright test`
//   執行，非本沙盒工具限制所致。
//
// 執行前準備：
//   npm install -D @playwright/test
//   npx playwright install chromium
//   將 index.html 以本機伺服器方式提供（例如 `npx serve .`），
//   並將下方 BASE_URL 改為該網址；或直接使用 file:// 開啟（部分瀏覽器 API
//   如 Service Worker 於 file:// 下可能受限，建議以 http server 方式測試）。
//
// 測試素材：
//   tests/fixtures/sample.mp4（短片，建議 <10 秒，含清楚語音，用於觸發辨識流程）
//   tests/fixtures/sample.mp3（音訊版本，用於驗證 audio 模式占位樣式）

import { test, expect, type Page } from '@playwright/test';
import path from 'path';

const BASE_URL = process.env.WHISPER_TEST_URL ?? 'http://localhost:8080/index.html';
const SAMPLE_VIDEO = path.join(__dirname, 'fixtures', 'sample.mp4');
const SAMPLE_AUDIO = path.join(__dirname, 'fixtures', 'sample.mp3');

/**
 * 共用流程：上傳測試檔案並等待辨識完成，回傳結果列表中對應項目的 id。
 * 為縮短測試時間，建議搭配最小的 base 模型與極短的測試音檔。
 */
async function uploadAndWaitForDone(page: Page, filePath: string) {
  await page.goto(BASE_URL);
  // 選擇最小模型以加速測試（base，~145MB，預設已選中，故此步驟通常可省略）
  await page.locator('.model-btn[data-model="Xenova/whisper-base"]').click();

  const fileInput = page.locator('#fileInput');
  await fileInput.setInputFiles(filePath);

  await page.locator('#startBtn').click();

  // 等待該項目狀態變為「完成」（狀態文字或 icon 皆可，此處以 batch-item.done 為準）
  const doneItem = page.locator('.batch-item.done').first();
  await expect(doneItem).toBeVisible({ timeout: 120_000 });
  const id = await doneItem.getAttribute('data-id');
  if (!id) throw new Error('無法取得已完成項目的 data-id');
  return id;
}

test.describe('字幕即時預覽面板', () => {

  // ── 案例 1：上傳測試音檔 → 等待處理完成 → 結果列表出現「👁 預覽」按鈕 ──
  test('案例1：處理完成後結果列表顯示預覽按鈕', async ({ page }) => {
    const id = await uploadAndWaitForDone(page, SAMPLE_VIDEO);
    const previewBtn = page.locator(`.batch-item-preview-btn[data-id="${id}"]`);
    await expect(previewBtn).toBeVisible();
    await expect(previewBtn).toHaveText(/預覽/);
  });

  // ── 案例 2：點擊按鈕 → 面板展開，video/audio 依 MIME type 正確切換顯示模式 ──
  test('案例2a：video 檔案展開面板時顯示 <video> 且非 audio-mode', async ({ page }) => {
    const id = await uploadAndWaitForDone(page, SAMPLE_VIDEO);
    await page.locator(`.batch-item-preview-btn[data-id="${id}"]`).click();

    const panel = page.locator(`.item-preview-panel[data-id="${id}"]`);
    await expect(panel).toBeVisible();
    await expect(panel.locator('video.preview-media-el')).toBeVisible();
    await expect(panel.locator('.preview-media-wrap')).not.toHaveClass(/audio-mode/);
  });

  test('案例2b：audio 檔案展開面板時顯示純色占位（audio-mode），不做波形視覺化', async ({ page }) => {
    const id = await uploadAndWaitForDone(page, SAMPLE_AUDIO);
    await page.locator(`.batch-item-preview-btn[data-id="${id}"]`).click();

    const panel = page.locator(`.item-preview-panel[data-id="${id}"]`);
    await expect(panel.locator('.preview-media-wrap')).toHaveClass(/audio-mode/);
    await expect(panel.locator('audio.preview-media-el')).toBeVisible();
    // 不應存在任何 canvas/波形相關元素
    await expect(panel.locator('canvas')).toHaveCount(0);
  });

  // ── 案例 3：拖曳字級滑桿 → 讀取疊圖文字 computed font-size，確認即時變化 ──
  test('案例3：字級滑桿即時變更疊圖 font-size', async ({ page }) => {
    const id = await uploadAndWaitForDone(page, SAMPLE_VIDEO);
    await page.locator(`.batch-item-preview-btn[data-id="${id}"]`).click();
    const panel = page.locator(`.item-preview-panel[data-id="${id}"]`);
    const overlay = panel.locator('.preview-overlay');
    const slider = panel.locator('.preview-fontsize-slider');

    await expect(overlay).toHaveCSS('font-size', '24px'); // 預設值
    await slider.fill('40');
    await expect(overlay).toHaveCSS('font-size', '40px');
  });

  // ── 案例 4：拖曳垂直位置滑桿 → 讀取疊圖層 computed bottom，確認即時變化 ──
  test('案例4：垂直位置滑桿即時變更疊圖 bottom', async ({ page }) => {
    const id = await uploadAndWaitForDone(page, SAMPLE_VIDEO);
    await page.locator(`.batch-item-preview-btn[data-id="${id}"]`).click();
    const panel = page.locator(`.item-preview-panel[data-id="${id}"]`);
    const overlay = panel.locator('.preview-overlay');
    const slider = panel.locator('.preview-pos-slider');

    await expect(overlay).toHaveCSS('bottom', '12%'); // 預設 88 -> bottom 100-88=12%
    await slider.fill('50');
    await expect(overlay).toHaveCSS('bottom', '50%'); // 100-50=50%
  });

  // ── 案例 5：切換 #outFormat 為 srt/vtt/ass → 逐一確認限制提示文字依 3.4 節內容正確顯示或隱藏 ──
  test('案例5：切換匯出格式時限制提示文字依規則顯示/隱藏', async ({ page }) => {
    const id = await uploadAndWaitForDone(page, SAMPLE_VIDEO);
    await page.locator(`.batch-item-preview-btn[data-id="${id}"]`).click();
    const panel = page.locator(`.item-preview-panel[data-id="${id}"]`);
    const notice = panel.locator('.preview-format-notice');
    const outFormat = page.locator('#outFormat');

    await outFormat.selectOption('ass');
    await expect(notice).not.toHaveClass(/show/);

    await outFormat.selectOption('vtt');
    await expect(notice).toHaveClass(/show/);
    await expect(notice).toContainText('僅垂直位置會寫入匯出檔案');

    await outFormat.selectOption('srt');
    await expect(notice).toHaveClass(/show/);
    await expect(notice).toContainText('不支援樣式資訊');

    await outFormat.selectOption('txt');
    await expect(notice).toHaveClass(/show/);

    await outFormat.selectOption('md');
    await expect(notice).toHaveClass(/show/);
  });

  // ── 案例 6：播放媒體並跳轉時間點 → 確認疊圖文字依 subs 陣列切換至正確行 ──
  test('案例6：拖動播放進度時疊圖文字同步切換', async ({ page }) => {
    const id = await uploadAndWaitForDone(page, SAMPLE_VIDEO);
    await page.locator(`.batch-item-preview-btn[data-id="${id}"]`).click();
    const panel = page.locator(`.item-preview-panel[data-id="${id}"]`);
    const overlay = panel.locator('.preview-overlay');
    const media = panel.locator('video.preview-media-el, audio.preview-media-el');

    // 跳到接近片頭的時間點，應顯示第一句字幕
    await media.evaluate((el: HTMLMediaElement) => { el.currentTime = 0.5; });
    await media.dispatchEvent('timeupdate');
    const firstText = await overlay.textContent();
    expect(firstText?.trim().length).toBeGreaterThan(0);

    // 跳到較後段時間點，疊圖文字應與前一段不同（假設測試音檔長度 > 3 秒、內容有變化）
    await media.evaluate((el: HTMLMediaElement) => { el.currentTime = Math.min(3, el.duration - 0.1); });
    await media.dispatchEvent('timeupdate');
    const laterText = await overlay.textContent();
    expect(laterText).not.toBe(firstText);
  });

  // ── 案例 7：以 ASS 格式匯出 → 解析輸出檔案，確認 Fontsize/MarginV 數值與滑桿設定一致 ──
  test('案例7：ASS 匯出內容的 Fontsize/MarginV 與滑桿設定一致', async ({ page }) => {
    const id = await uploadAndWaitForDone(page, SAMPLE_VIDEO);
    await page.locator('#outFormat').selectOption('ass');
    await page.locator(`.batch-item-preview-btn[data-id="${id}"]`).click();
    const panel = page.locator(`.item-preview-panel[data-id="${id}"]`);

    await panel.locator('.preview-fontsize-slider').fill('30');
    await panel.locator('.preview-pos-slider').fill('20'); // bottomPct = 80 -> MarginV = round(0.8*720) = 576

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.locator(`.batch-item[data-id="${id}"] a`).click(),
    ]);
    const content = await (await download.createReadStream())?.read();
    const text = content?.toString('utf-8') ?? '';
    const styleLine = text.split('\n').find(l => l.startsWith('Style:')) ?? '';
    const fields = styleLine.split(',');
    expect(fields[2]).toBe('30');            // Fontsize
    expect(fields[fields.length - 2]).toBe('576'); // MarginV
  });

  // ── 案例 8：以 VTT 格式匯出 → 確認 cue 含對應 line 設定，且不含字級資訊 ──
  test('案例8：VTT 匯出內容含 line 設定、不含字級資訊', async ({ page }) => {
    const id = await uploadAndWaitForDone(page, SAMPLE_VIDEO);
    await page.locator('#outFormat').selectOption('vtt');
    await page.locator(`.batch-item-preview-btn[data-id="${id}"]`).click();
    const panel = page.locator(`.item-preview-panel[data-id="${id}"]`);
    await panel.locator('.preview-pos-slider').fill('75');

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.locator(`.batch-item[data-id="${id}"] a`).click(),
    ]);
    const content = await (await download.createReadStream())?.read();
    const text = content?.toString('utf-8') ?? '';
    expect(text).toMatch(/-->.*line:75%/);
    expect(text).not.toMatch(/font-size|Fontsize/i);
  });

  // ── 案例 9：以 SRT 格式匯出 → 確認輸出檔案純文字時間軸，不含任何樣式資訊 ──
  test('案例9：SRT 匯出內容不含任何樣式資訊', async ({ page }) => {
    const id = await uploadAndWaitForDone(page, SAMPLE_VIDEO);
    await page.locator('#outFormat').selectOption('srt');
    await page.locator(`.batch-item-preview-btn[data-id="${id}"]`).click();
    const panel = page.locator(`.item-preview-panel[data-id="${id}"]`);
    await panel.locator('.preview-fontsize-slider').fill('44');
    await panel.locator('.preview-pos-slider').fill('10');

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.locator(`.batch-item[data-id="${id}"] a`).click(),
    ]);
    const content = await (await download.createReadStream())?.read();
    const text = content?.toString('utf-8') ?? '';
    expect(text).toMatch(/^\d+\r?\n\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}/m);
    expect(text).not.toMatch(/line:|Fontsize|MarginV/);
  });

  // ── 回歸測試（步驟 12）：tog_opencc 關閉時，其餘後處理輸出需與 v21 完全一致 ──
  test('回歸：關閉簡繁正規化後不影響其餘後處理結果', async ({ page }) => {
    await page.goto(BASE_URL);
    await page.locator('#tog_opencc').uncheck();
    const id = await uploadAndWaitForDone(page, SAMPLE_VIDEO);
    // 僅驗證流程本身不因關閉 opencc 而出錯；逐字輸出比對需搭配 v21 基準檔另行執行
    await expect(page.locator(`.batch-item[data-id="${id}"]`)).toHaveClass(/done/);
  });
});
