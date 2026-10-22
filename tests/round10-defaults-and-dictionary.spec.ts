// tests/round10-defaults-and-dictionary.spec.ts
//
// v23.2（第十輪）的回歸測試。完全離線（假 Whisper Worker、OpenCC 替身）。
//   1. 模糊詞典「相似度門檻」預設值只有單一來源：UI 初始值＝空欄位後備值＝0.75，且確實接到辨識流程
//   2. 內建詞典不再含別稱「衣原體」（台灣用語僅用「砂眼披衣菌」）
//
// 執行方式（測「原始碼」index.html，不含 CSP）：
//   npx serve .      # 另開終端機
//   WHISPER_TEST_URL=http://localhost:3000/index.html npx playwright test tests/round10-defaults-and-dictionary.spec.ts
//
// 說明：applyFuzzyMedicalDict 的「函式預設參數」在正常流程中不會被用到（唯一呼叫端一律傳入設定值），
// 無法以行為測試觸及；它與另兩處共用同一個常數，由 scripts/check-consistency.mjs 的靜態檢查把關。

import { test, expect, type Page } from '@playwright/test';
import { installFakeWhisperWorker, setToggles, recognize, runAndWaitDone, downloadText } from './helpers';

// 「血壓」是一般用語，不是詞典中的標準詞。門檻 0.65 時會被誤改成「高血壓 (Hypertension)」，0.75 不會
//（v23.1 以前 UI 預設 0.65；以 83 句一般／醫學口語掃描 0.55–0.90 的結果見 CHANGELOG 第十輪）。
const BORDERLINE = '請記錄病人的體溫和血壓';

async function runWithThreshold(page: Page, text: string, setThreshold?: (page: Page) => Promise<void>): Promise<string> {
  await installFakeWhisperWorker(page, [{ text, timestamp: [0.5, 3.0] }]);
  await recognize(page);
  await setToggles(page, ['tog_fuzzy'], ['tog_vad', 'tog_medical']);
  if (setThreshold) {
    await page.locator('#postPanelHeader').click();          // 門檻輸入框在摺疊的「後處理」面板內，先像使用者一樣展開
    await expect(page.locator('#p_fuzzy_threshold')).toBeVisible();
    await setThreshold(page);
  }
  await runAndWaitDone(page);
  return downloadText(page);
}

test.describe('修正 1：模糊門檻預設值單一來源', () => {
  test('輸入框初始值為 0.75，且 HTML 原始碼不帶 value 屬性', async ({ page }) => {
    await recognize(page);
    await expect(page.locator('#p_fuzzy_threshold')).toHaveValue('0.75');
    expect(await page.locator('#p_fuzzy_threshold').getAttribute('value')).toBeNull();
  });

  test('預設值：一般用語「血壓」不被誤改（v23.1 的 0.65 會改成「高血壓 (Hypertension)」）', async ({ page }) => {
    const srt = await runWithThreshold(page, BORDERLINE);
    expect(srt).toContain('體溫和血壓');
    expect(srt).not.toContain('Hypertension');
  });

  test('欄位被清空時後備值＝預設值：結果與預設相同，不會退回舊的 0.65', async ({ page }) => {
    const srt = await runWithThreshold(page, BORDERLINE, async (p) => {
      await p.locator('#p_fuzzy_threshold').fill('');
    });
    expect(srt).toContain('體溫和血壓');
    expect(srt).not.toContain('Hypertension');
  });

  test('對照組：明確設為 0.65 時確實會誤改（證明門檻真的接到辨識流程，且本測試有鑑別力）', async ({ page }) => {
    const srt = await runWithThreshold(page, BORDERLINE, async (p) => {
      await p.locator('#p_fuzzy_threshold').fill('0.65');
    });
    expect(srt).toContain('Hypertension');
  });

  test('同音異字仍被改正（提高門檻沒有犧牲文件化案例）：「心飢哽塞」→「心肌梗塞」', async ({ page }) => {
    const srt = await runWithThreshold(page, '病人主訴心飢哽塞');
    expect(srt).toContain('心肌梗塞 (Myocardial Infarction)');
  });
});

test.describe('修正 2：內建詞典移除別稱「衣原體」', () => {
  async function exactPass(page: Page, text: string): Promise<string> {
    await installFakeWhisperWorker(page, [{ text, timestamp: [0.5, 3.0] }]);
    await recognize(page);
    await setToggles(page, ['tog_medical'], ['tog_vad', 'tog_fuzzy']); // 只開精確比對，與門檻無關
    await runAndWaitDone(page);
    return downloadText(page);
  }

  test('「衣原體」不再被標註英文（台灣用語僅用砂眼披衣菌）', async ({ page }) => {
    const srt = await exactPass(page, '病人被診斷為衣原體感染');
    expect(srt).toContain('衣原體感染');
    expect(srt).not.toContain('Chlamydia');
  });

  test('「披衣菌」與「砂眼披衣菌」仍正常標註', async ({ page }) => {
    const srt = await exactPass(page, '披衣菌感染需要治療');
    expect(srt).toContain('砂眼披衣菌 (Chlamydia trachomatis)');
  });

  test('詞典表格中不含「衣原體」', async ({ page }) => {
    await recognize(page);
    const html = await page.locator('body').innerHTML();
    expect(html).toContain('砂眼披衣菌');     // 先確認詞典表格確實已渲染（否則下一行會空洞通過）
    expect(html).not.toContain('衣原體');
  });
});
