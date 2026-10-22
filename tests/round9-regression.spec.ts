// tests/round9-regression.spec.ts
//
// v23.1（第九輪）修正的回歸測試。完全離線：不下載模型、不連 CDN。
//   1. ModelRegistry 確認 dtype 檔案存在：真實 blob Worker ＋ 小型替身函式庫（page.route 攔截 CDN 連結）
//   2. 字幕編輯器「新增段落／還原」在辨識後仍可操作（先前被 innerHTML 重寫弄壞）
//   3. 模糊詞典比對不再連鎖蓋掉剛替換的術語／原本正確的術語
//   4. Worker 錯誤前導共用後，Diarization Worker 的錯誤訊息仍完整回報（不是 undefined）
//
// 執行方式（測的是「原始碼」index.html，不含 CSP；與 preview-panel.spec.ts 相同）：
//   npx serve .      # 另開終端機
//   WHISPER_TEST_URL=http://localhost:3000/index.html npx playwright test tests/round9-regression.spec.ts
//
// 涵蓋範圍限制：函式庫與 HF 網站皆為替身，驗證的是「本 App 如何使用 ModelRegistry 並選 dtype」，
// 不是 transformers.js 本身；真實函式庫請在有網路環境以真實模型另行實測。

import { test, expect, type Page } from '@playwright/test';
import { SAMPLE_AUDIO, installFakeWhisperWorker, setToggles, recognize, runAndWaitDone, downloadText } from './helpers';

// ══════════════════════════════════════════════════════════════════════════
test.describe('修正 1：ModelRegistry 在 Worker 內確認 dtype 檔案存在（真實 blob Worker＋替身函式庫）', () => {
  // 政策：「偏好哪個 dtype」只有主執行緒的靜態規則（whisper-base 145MB：可用記憶體 ≥725MB→fp32、
  // <435MB→q4）；ModelRegistry 只確認該格式的檔案存在，不存在才改選最接近的可用格式。
  // 替身函式庫：export 與真實 transformers.js 相同名稱；ModelRegistry 回傳指定的 dtype 清單
  const stubLib = (dtypes: string[] | 'throw') => `
    export const env = {};
    export const ModelRegistry = { get_available_dtypes: async () => ${dtypes === 'throw' ? "{ throw new Error('HF unreachable'); }" : JSON.stringify(dtypes)} };
    export async function pipeline() {
      const fn = async () => ({ chunks: [{ text: 'x', timestamp: [0, 1] }] });
      fn.dispose = async () => {};
      return fn;
    }`;

  // freeMB：主執行緒量到的可用記憶體（jsHeapSizeLimit − usedJSHeapSize）
  async function runScenario(page: Page, opts: { freeMB: number; dtypes: string[] | 'throw' }) {
    await page.addInitScript(({ lim, used }) => {
      Object.defineProperty(performance, 'memory', {
        get: () => ({ jsHeapSizeLimit: lim * 1048576, usedJSHeapSize: used * 1048576, totalJSHeapSize: used * 1048576 }),
      });
      Object.defineProperty(navigator, 'gpu', { get: () => undefined }); // 強制走 wasm 分支
      (window as any).__backend = [];
      const RealWorker = window.Worker;
      (window as any).Worker = class extends RealWorker {   // 真實 Worker，只旁聽 BACKEND 訊息
        constructor(u: any, o: any) {
          super(u, o);
          this.addEventListener('message', (e: any) => { if (e.data?.type === 'BACKEND') (window as any).__backend.push(e.data.payload); });
        }
      };
    }, { lim: opts.freeMB + 500, used: 500 });

    const body = stubLib(opts.dtypes);
    await page.route(/cdn\.jsdelivr\.net\/npm\/@huggingface\/transformers@[^/]+\/dist\/transformers\.min\.js/, (r) => r.fulfill({ contentType: 'application/javascript', body }));
    await page.route(/unpkg\.com\/@huggingface\/transformers@[^/]+\/dist\/transformers\.min\.js/, (r) => r.fulfill({ contentType: 'application/javascript', body }));
    await page.route('**/opencc-js@*/dist/umd/cn2t.js', (r) => r.fulfill({ contentType: 'application/javascript', body: 'window.OpenCC = { Converter: () => (t) => t };' }));

    await recognize(page);
    await setToggles(page, [], ['tog_vad']);
    await page.locator('#fileInput').setInputFiles(SAMPLE_AUDIO);
    await page.locator('#startBtn').click();
    await page.waitForFunction(() => (window as any).__backend.length > 0, null, { timeout: 30_000 });
    return page.evaluate(() => (window as any).__backend[0]);
  }

  test('偏好 fp32（可用 1500MB）且檔案存在 → 沿用 fp32（不因 ModelRegistry 改變既有的靜態政策）', async ({ page }) => {
    const b = await runScenario(page, { freeMB: 1500, dtypes: ['fp32', 'fp16', 'q8', 'q4'] });
    expect(b.backend).toBe('wasm');
    expect(b.dtype).toBe('fp32');
  });

  test('偏好 q4（可用僅 300MB）且檔案存在 → 沿用 q4', async ({ page }) => {
    const b = await runScenario(page, { freeMB: 300, dtypes: ['fp32', 'fp16', 'q8', 'q4'] });
    expect(b.dtype).toBe('q4');
  });

  test('偏好 fp32 但模型只發行 q8 → 改選 q8，而不是載入一個不存在的 fp32 檔（v23 會選 fp32）', async ({ page }) => {
    const b = await runScenario(page, { freeMB: 1500, dtypes: ['q8'] });
    expect(b.dtype).toBe('q8');
  });

  test('偏好 q4 但模型只發行 fp16、fp32 → 找不到更輕者，改選最接近的較重格式 fp16', async ({ page }) => {
    const b = await runScenario(page, { freeMB: 300, dtypes: ['fp32', 'fp16'] });
    expect(b.dtype).toBe('fp16');
  });

  test('查詢失敗（HF 連不上）→ 靜默沿用偏好值，不中斷載入', async ({ page }) => {
    const b = await runScenario(page, { freeMB: 1500, dtypes: 'throw' });
    expect(b.dtype).toBe('fp32');
    await expect(page.locator('.batch-item.done')).toHaveCount(1, { timeout: 60_000 });
  });
});

// ══════════════════════════════════════════════════════════════════════════
test.describe('修正 2：字幕編輯器按鈕在辨識後仍可操作', () => {
  test('新增段落／刪除／還原 皆有作用（v23 的「新增段落」「還原」在辨識後點了沒反應）', async ({ page }) => {
    page.on('dialog', (d) => d.accept());
    await installFakeWhisperWorker(page, [{ text: '第一句字幕', timestamp: [1.0, 3.5] }]);
    await recognize(page);
    await setToggles(page, [], ['tog_vad', 'tog_fuzzy']);
    await runAndWaitDone(page);

    await expect(page.locator('#editorToolbar')).toBeVisible();
    await expect(page.locator('.editor-row')).toHaveCount(1);

    await page.locator('#editorAddRow').click();
    await expect(page.locator('.editor-row')).toHaveCount(2);
    await expect(page.locator('#editorSegCount')).toContainText('2');

    await page.locator('.editor-del').nth(1).click();
    await expect(page.locator('.editor-row')).toHaveCount(1);

    await page.locator('.editor-text').first().fill('已被編輯');
    await page.locator('.editor-text').first().dispatchEvent('input');
    await page.locator('#editorResetBtn').click();
    await expect(page.locator('.editor-text').first()).toHaveValue('第一句字幕');
  });

  test('新增段落後改到很後面的起始時間 → 匯出的段落長度為 2 秒，而非 1 毫秒', async ({ page }) => {
    await installFakeWhisperWorker(page, [{ text: '第一句字幕', timestamp: [1.0, 3.5] }]);
    await recognize(page);
    await setToggles(page, [], ['tog_vad', 'tog_fuzzy']);
    await runAndWaitDone(page);

    await page.locator('#editorAddRow').click();
    await page.locator('.editor-ts').nth(1).fill('00:00:20,000');
    await page.locator('.editor-ts').nth(1).dispatchEvent('change');
    await page.locator('.editor-text').nth(1).fill('新增的一句');
    await page.locator('.editor-text').nth(1).dispatchEvent('input');
    await page.locator('#editorApplyBtn').click();

    const srt = await downloadText(page);
    expect(srt).toContain('00:00:20,000 --> 00:00:22,000');
    expect(srt).not.toContain('00:00:20,000 --> 00:00:20,001');
  });
});

// ══════════════════════════════════════════════════════════════════════════
test.describe('修正 3：模糊詞典比對不再連鎖蓋掉術語', () => {
  async function fuzzyResult(page: Page, text: string): Promise<string> {
    await installFakeWhisperWorker(page, [{ text, timestamp: [0.5, 3.0] }]);
    await recognize(page);
    await setToggles(page, ['tog_medical', 'tog_fuzzy'], ['tog_vad']);
    await runAndWaitDone(page);
    return downloadText(page);
  }

  test('已是正確標準詞的句子不會被別的候選詞咬進去', async ({ page }) => {
    const srt = await fuzzyResult(page, '巨噬細胞吞噬病原體');
    expect(srt).toContain('巨噬細胞 (Macrophage)');
    // v23 會把剛替換上去的「巨噬細胞」再次模糊比對、連鎖改成「巨噬白紅血球 (Red Blood Cell) (White Blood Cell)…」
    expect(srt).not.toContain('Red Blood Cell');
    expect(srt).not.toContain('White Blood Cell');
    // v23.1 曾記錄的已知限制（UI 預設門檻 0.65 下「病原體」被改成「砂眼披衣菌」）已於 v23.2 解決：
    // 移除別稱「衣原體」、預設門檻統一為 0.75；回歸測試見 round10-defaults-and-dictionary.spec.ts
  });

  test('同音異字仍會被改正，且只改一次（不連鎖）', async ({ page }) => {
    const srt = await fuzzyResult(page, '今天討論具勢細胞');
    expect(srt).toContain('(Macrophage)');
    expect((srt.match(/\(/g) ?? []).length).toBe(1);
  });
});

// ══════════════════════════════════════════════════════════════════════════
test.describe('修正 4：Worker 錯誤前導改為共用後，Diarization 錯誤訊息仍完整', () => {
  test('真實 Diarization Worker 載入函式庫失敗 → 使用者看到真正的錯誤內容，不是 undefined', async ({ page }) => {
    await page.addInitScript(() => {
      // 只把「不是 Diarization」的 Worker 換成假的；Diarization 用真實 blob Worker
      const srcOf = new Map<string, string>();
      const OrigBlob = window.Blob;
      const origCreate = URL.createObjectURL.bind(URL);
      (window as any).Blob = class extends OrigBlob {
        __src = '';
        constructor(parts?: any, o?: any) { super(parts, o); this.__src = Array.isArray(parts) && typeof parts[0] === 'string' ? parts[0] : ''; }
      };
      URL.createObjectURL = (b: any) => { const u = origCreate(b); if (b.__src) srcOf.set(u, b.__src); return u; };
      const RealWorker = window.Worker;
      class Fake extends EventTarget {
        onmessage: any = null;
        private emit(d: any) { const ev = new MessageEvent('message', { data: d }); this.dispatchEvent(ev); if (this.onmessage) this.onmessage(ev); }
        postMessage(m: any) {
          setTimeout(() => {
            if (m.type === 'LOAD_MODEL') this.emit({ type: 'MODEL_READY', payload: { device: 'wasm' } });
            else if (m.type === 'RUN_CHUNK') this.emit({ type: 'CHUNK_DONE', payload: { result: { chunks: [{ text: '測試', timestamp: [0.2, 1.4] }] }, segIdx: m.payload.segIdx, startSec: m.payload.startSec, strideSec: m.payload.strideSec } });
          }, 3);
        }
        terminate() {}
      }
      (window as any).Worker = function (url: any, opts: any) {
        return (srcOf.get(String(url)) ?? '').includes('pyannote') ? new RealWorker(url, opts) : new Fake();
      };
    });
    const failLib = (r: any) => r.fulfill({ status: 200, contentType: 'application/javascript', body: 'throw new Error("SIMULATED_LIB_LOAD_FAILURE");' });
    await page.route(/cdn\.jsdelivr\.net\/npm\/@huggingface\/transformers/, failLib);
    await page.route(/unpkg\.com\/@huggingface\/transformers/, failLib);
    await page.route('**/opencc-js@*/dist/umd/cn2t.js', (r) => r.fulfill({ contentType: 'application/javascript', body: 'window.OpenCC = { Converter: () => (t) => t };' }));

    await recognize(page);
    await setToggles(page, ['tog_diarization'], ['tog_vad', 'tog_fuzzy']);
    await page.locator('#fileInput').setInputFiles(SAMPLE_AUDIO);
    await page.locator('#startBtn').click();
    await expect(page.locator('.log-line', { hasText: '說話者分割失敗' }).first()).toBeVisible({ timeout: 60_000 });
    const line = await page.locator('.log-line', { hasText: '說話者分割失敗' }).first().innerText();
    expect(line).toContain('SIMULATED_LIB_LOAD_FAILURE');
    expect(line).not.toContain('undefined');
  });
});
