// tests/dist-csp.spec.ts
//
// 對「建置後」的 dist/index.html 驗證 Content-Security-Policy（由 scripts/build.mjs 注入）。
//
// 執行方式（dist/ 只是一堆靜態檔案，需另開 port serve；刻意與 preview-panel.spec.ts 的 8080/3000 分開）：
//   npm run build
//   npx serve dist -l 8081                      # 另開終端機
//   WHISPER_DIST_TEST_URL=http://localhost:8081/index.html npx playwright test tests/dist-csp.spec.ts
//
// 本檔使用獨立環境變數 WHISPER_DIST_TEST_URL，與 preview-panel.spec.ts 的 WHISPER_TEST_URL 分開，避免互相干擾。
//
// ── 設計說明與已知涵蓋範圍限制（如實記錄）─────────────────────────────────────
// 1. 「假 Worker 替身」會取代 window.Worker，因此真正的 WORKER_CODE（含 onnxruntime／transformers.js
//    於 Worker 內動態 import CDN、下載模型）不會執行；這部分 CSP 行為（Worker 內對 CDN 與 HF 模型網域的
//    連線）無法以本檔驗證，需在具備一般網際網路存取的環境以真實模型實測（見 SPEC 第 10 節）。
//    為補足 worker-src／wasm-unsafe-eval，另有一個測試使用「真實 blob Worker」單獨驗證。
// 2. CDN 腳本（JSZip、OpenCC）以 page.route() 回應極小替身檔：請求仍是對 cdn.jsdelivr.net 的真實
//    <script src>，因此 script-src 白名單仍被真實檢查；只是檔案內容為替身。
// 3. 測試「對照組」刻意觸發違規（eval、內嵌腳本、非白名單腳本），證明 CSP 確實生效——
//    否則「零違規」的結果可能只是 CSP 沒生效。

import { test, expect, type Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { newCtx, openWithHook, routeRealOrt, REAL_ORT_AVAILABLE, HALF_MODEL_PATH } from './harness';

const DIST_URL = process.env.WHISPER_DIST_TEST_URL ?? 'http://localhost:8081/index.html';
const SAMPLE_AUDIO = path.join(__dirname, 'fixtures', 'sample.mp3');

// 沙盒／受限網路下必然失敗、且與 CSP 無關的外部字型請求（CSP 本身允許這兩個網域）
const ENV_ONLY_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

type Violation = { directive: string; blocked: string };

/** 掛上 console / pageerror / requestfailed / securitypolicyviolation 監聽 */
async function attachWatchers(page: Page) {
  const consoleCsp: string[] = [];
  const pageErrors: string[] = [];
  const failedRequests: { url: string; error: string }[] = [];

  page.on('console', (msg) => {
    const t = msg.text();
    if (msg.type() === 'error' && /Content Security Policy|Refused to /i.test(t)) consoleCsp.push(t);
  });
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  page.on('requestfailed', (req) => {
    failedRequests.push({ url: req.url(), error: req.failure()?.errorText ?? '' });
  });

  // 結構化違規事件（比解析 console 文字更精確）
  await page.addInitScript(() => {
    (window as any).__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (e) => {
      (window as any).__cspViolations.push({ directive: e.violatedDirective, blocked: e.blockedURI });
    });
  });

  return {
    consoleCsp,
    pageErrors,
    failedRequests,
    violations: async (): Promise<Violation[]> =>
      page.evaluate(() => (window as any).__cspViolations ?? []),
    /**
     * 不屬於下列兩類「與 CSP 無關」的失敗請求：
     *  1. 沙盒才有的外部字型請求失敗（CSP 本身允許這兩個網域）
     *  2. blob: 媒體請求的 net::ERR_ABORTED——預覽面板 <audio>/<video> 被重新渲染時瀏覽器取消載入。
     *     對照實驗：同一流程在「無 CSP 的原始碼」重複 8 次亦出現 1 次，兩邊 CSP 違規皆為 0，故非 CSP 造成。
     * CSP 阻擋本身由 securitypolicyviolation 事件與 console 錯誤另外斷言，不依賴此過濾。
     */
    unexpectedFailures: () =>
      failedRequests.filter(
        (f) =>
          !ENV_ONLY_HOSTS.some((h) => f.url.includes(h)) &&
          !(f.url.startsWith('blob:') && f.error === 'net::ERR_ABORTED')
      ),
  };
}

// ══════════════════════════════════════════════════════════════════════════
test.describe('dist CSP：靜態結構與生效對照組', () => {
  // r7：頁面自己註冊的 Service Worker 會攔截對照組的探針腳本請求，使 page.route() 的替身回應不被採用，
  // 測試以約 40% 的機率失敗（原版 r6 同樣，重複 40 次失敗 20 次）。與下方兩處相同，封鎖 SW 即可穩定。
  test.use({ serviceWorkers: 'block' });
  test('CSP <meta> 位於 <head> 內緊接 charset 的第 2 個元素，且含 3 個 script hash', async ({ page }) => {
    await page.goto(DIST_URL);
    const info = await page.evaluate(() => {
      const kids = Array.from(document.head.children);
      const csp = kids[1] as HTMLMetaElement | undefined;
      return {
        first: kids[0]?.outerHTML ?? '',
        secondHttpEquiv: csp?.getAttribute('http-equiv') ?? '',
        content: csp?.getAttribute('content') ?? '',
        cspIndexInHead: kids.findIndex((k) => k.getAttribute('http-equiv') === 'Content-Security-Policy'),
      };
    });
    expect(info.first).toContain('charset');
    expect(info.cspIndexInHead).toBe(1);
    expect(info.secondHttpEquiv).toBe('Content-Security-Policy');
    const hashes = info.content.match(/'sha256-[A-Za-z0-9+/=]+'/g) ?? [];
    expect(hashes).toHaveLength(3);
  });

  test('對照組：CSP 確實生效（eval、內嵌腳本、非白名單腳本皆被擋）', async ({ page }) => {
    const w = await attachWatchers(page);
    await page.goto(DIST_URL);

    // 注意：page.evaluate() 經 CDP 執行，eval 限制不套用於該呼叫本身（實測 new Function 會被放行），
    // 因此改由「頁面自行載入的同源腳本」（script-src 'self' 允許）在頁面正常情境下嘗試 eval。
    await page.route('**/__eval-probe.js', (route) =>
      route.fulfill({
        contentType: 'application/javascript',
        body: `try { new Function('return 1')(); window.__evalProbe = 'ALLOWED'; } catch (e) { window.__evalProbe = e.name; }`,
      })
    );
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          const s = document.createElement('script');
          s.src = './__eval-probe.js';
          s.onload = () => resolve();
          s.onerror = () => resolve();
          document.head.appendChild(s);
        })
    );
    expect(await page.evaluate(() => (window as any).__evalProbe)).toBe('EvalError');

    const injected = await page.evaluate(async () => {
      const s = document.createElement('script');
      s.textContent = 'window.__injected = 1;';
      document.body.appendChild(s);
      await new Promise((r) => setTimeout(r, 100));
      return (window as any).__injected === 1;
    });
    expect(injected).toBe(false);

    const foreignBlocked = await page.evaluate(
      () =>
        new Promise<boolean>((resolve) => {
          const s = document.createElement('script');
          s.src = 'https://evil.example.com/x.js';
          s.onload = () => resolve(false);
          s.onerror = () => resolve(true);
          document.head.appendChild(s);
        })
    );
    expect(foreignBlocked).toBe(true);

    const v = await w.violations();
    const directives = v.map((x) => x.directive);
    expect(directives.some((d) => d.startsWith('script-src'))).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════
test.describe('dist CSP：頁面載入', () => {
  test('載入零 CSP 違規；3 段 <script> 皆已執行；Service Worker 註冊成功', async ({ page }) => {
    const w = await attachWatchers(page);
    await page.goto(DIST_URL);
    await page.waitForLoadState('load');

    // script #1（theme 初始化）已執行
    expect(await page.evaluate(() => typeof (window as any)._initTheme)).toBe('string');
    // script #2（主程式 module）已執行：模型按鈕由它綁定／渲染互動
    await expect(page.locator('.model-btn').first()).toBeVisible();
    expect(await page.title()).toContain('v24');
    // script #3（SW 註冊）已執行且 sw.js 未被 CSP／MIME 擋下
    const swScope = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      return reg?.scope ?? null;
    });
    expect(swScope).not.toBeNull();

    const v = await w.violations();
    expect(v, `CSP 違規：${JSON.stringify(v)}`).toEqual([]);
    expect(w.consoleCsp, w.consoleCsp.join('\n')).toEqual([]);
    expect(w.pageErrors).toEqual([]);
    const bad = w.unexpectedFailures();
    expect(bad, JSON.stringify(bad)).toEqual([]);
  });

  test('wasm-unsafe-eval：主執行緒與「真實 blob Worker」內皆可 WebAssembly.instantiate', async ({ page }) => {
    const w = await attachWatchers(page);
    await page.goto(DIST_URL);
    const result = await page.evaluate(async () => {
      const bytes = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]); // 空 wasm 模組
      const main = await WebAssembly.instantiate(bytes).then(() => 'ok').catch((e) => 'FAIL:' + e.message);
      const code = `self.onmessage = async (e) => {
        try { await WebAssembly.instantiate(e.data); self.postMessage('ok'); }
        catch (err) { self.postMessage('FAIL:' + err.message); }
      };`;
      const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
      const worker = await new Promise<string>((resolve) => {
        let wk: Worker;
        try { wk = new Worker(url); } catch (e: any) { return resolve('CREATE_FAIL:' + e.message); }
        wk.onmessage = (m) => resolve(String(m.data));
        wk.onerror = () => resolve('WORKER_ERROR');
        wk.postMessage(bytes);
        setTimeout(() => resolve('TIMEOUT'), 5000);
      });
      return { main, worker };
    });
    expect(result.main).toBe('ok');
    expect(result.worker).toBe('ok');
    expect(await w.violations()).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════════════
test.describe('dist CSP：ORT-web 的 blob: 動態 import（r4 回歸）', () => {
  // 背景（T-S 實機測試發現）：transformers.js 內建的 onnxruntime-web 建立 WASM 後端時，會把 glue 模組（.mjs）
  // 做成 blob: URL 再動態 import()。script-src 缺 blob: 時整個後端建不起來
  // （底層錯誤：no available backend found. ERR: [wasm] TypeError: Failed to fetch dynamically imported module: blob:…），
  // dist 版因此「完全無法載入任何模型」。source 版沒有 CSP meta，所以先前的測試與假 Worker 流程都看不到。
  // 沙盒無法連 CDN／HuggingFace，這裡以「同一機制」的最小重現驗證：頁面與 blob Worker 內皆可 import(blob:)。
  const MODULE_SRC = 'export const answer = 42;';

  test('TB-01 主執行緒：import(blob: 模組) 成功，零 CSP 違規', async ({ page }) => {
    const w = await attachWatchers(page);
    await page.goto(DIST_URL);
    const r = await page.evaluate(async (src) => {
      const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      try { const m = await import(/* @vite-ignore */ url); return { ok: true, answer: m.answer }; }
      catch (e: any) { return { ok: false, error: String(e?.message ?? e) }; }
      finally { URL.revokeObjectURL(url); }
    }, MODULE_SRC);
    expect(r, JSON.stringify(r)).toEqual({ ok: true, answer: 42 });
    expect(await w.violations()).toEqual([]);
  });

  test('TB-02 blob Worker 內：import(blob: 模組) 成功（Worker 繼承文件 CSP；Whisper 的 ORT 就在這裡建後端）', async ({ page }) => {
    const w = await attachWatchers(page);
    await page.goto(DIST_URL);
    const r = await page.evaluate(async (src) => {
      const workerCode = `self.onmessage = async (e) => {
        const url = URL.createObjectURL(new Blob([e.data], { type: 'text/javascript' }));
        try { const m = await import(url); self.postMessage({ ok: true, answer: m.answer }); }
        catch (err) { self.postMessage({ ok: false, error: String(err && err.message || err) }); }
      };`;
      const wurl = URL.createObjectURL(new Blob([workerCode], { type: 'text/javascript' }));
      return await new Promise<any>((resolve) => {
        const wk = new Worker(wurl);
        wk.onmessage = (m) => resolve(m.data);
        wk.onerror = (e) => resolve({ ok: false, error: 'WORKER_ERROR ' + e.message });
        wk.postMessage(src);
        setTimeout(() => resolve({ ok: false, error: 'TIMEOUT' }), 8000);
      });
    }, MODULE_SRC);
    expect(r, JSON.stringify(r)).toEqual({ ok: true, answer: 42 });
    expect(await w.violations()).toEqual([]);
  });

  test('TB-03 script-src 只多開 blob:：白名單逐項精確比對（不得出現 unsafe-inline／unsafe-eval／萬用字元）', async ({ page }) => {
    await page.goto(DIST_URL);
    const content = await page.evaluate(
      () => document.querySelector('meta[http-equiv="Content-Security-Policy"]')!.getAttribute('content') || '');
    const scriptSrc = content.split(';').map((d) => d.trim()).find((d) => d.startsWith('script-src ')) ?? '';
    const tokens = scriptSrc.split(/\s+/).slice(1);
    const hashes = tokens.filter((t) => /^'sha256-[A-Za-z0-9+/=]+'$/.test(t));
    expect(hashes).toHaveLength(3);
    expect(tokens.filter((t) => !hashes.includes(t)).sort()).toEqual(
      ["'self'", "'wasm-unsafe-eval'", 'blob:', 'https://cdn.jsdelivr.net', 'https://unpkg.com'].sort());
    expect(content.startsWith("default-src 'none'")).toBe(true);
  });

  // HuggingFace 大檔案（ONNX 權重）由 huggingface.co 302 轉址到「地區性」CDN 主機：實測 us.aws.cdn.hf.co（xet-bridge-us），
  // 另有 cdn-lfs*.hf.co（LFS）、cas-bridge.xethub.hf.co（Xet）；台灣用戶可能拿到其他地區的 *.aws.cdn.hf.co。逐區列舉追不完，
  // 所以 connect-src 用 https://*.hf.co（CSP 的 *. 通配涵蓋多層子網域）。CSP 對「每一次轉址」都檢查 connect-src，
  // 缺主機時模型下載會在轉址那一跳被擋（Failed to fetch）。模型是在 Worker 內下載，故在 blob Worker 內驗證。
  // 此處以 page.route 回應替身，但 CSP 檢查發生在請求送出前，因此白名單仍被真實檢查。
  // 對照組：外來主機、以及「長得像」的主機（nothf.co 無點分隔、hf.co.evil.example.com 後綴不符）都必須被擋。
  test('TB-04 blob Worker 內可連線 HuggingFace 的地區性轉址主機；外來與相似主機仍被擋（對照組）', async ({ page }) => {
    await attachWatchers(page);
    const allowed = ['us.aws.cdn.hf.co', 'eu.aws.cdn.hf.co', 'cdn-lfs.hf.co', 'cas-bridge.xethub.hf.co', 'huggingface.co'];
    const blocked = ['evil.example.com', 'nothf.co', 'hf.co.evil.example.com'];
    for (const h of [...allowed, ...blocked])
      await page.route(`https://${h}/**`, (r) => r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*' }, body: 'ok' }));
    await page.goto(DIST_URL);
    // Worker 內的 securitypolicyviolation 事件只會在 Worker 全域觸發（不會冒到頁面 document），所以在 Worker 內自己收
    const { results, violated } = await page.evaluate(async (list) => {
      const code = `const viol = [];
      self.addEventListener('securitypolicyviolation', (ev) => viol.push({ directive: ev.violatedDirective, blocked: ev.blockedURI }));
      self.onmessage = async (e) => {
        const out = {};
        for (const h of e.data) { try { const r = await fetch('https://' + h + '/probe'); out[h] = r.ok ? 'ok' : 'HTTP' + r.status; } catch (err) { out[h] = 'BLOCKED'; } }
        setTimeout(() => self.postMessage({ results: out, violated: viol }), 50);
      };`;
      const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
      return await new Promise<any>((resolve) => {
        const wk = new Worker(url);
        wk.onmessage = (m) => resolve(m.data);
        wk.postMessage(list);
        setTimeout(() => resolve({ results: { TIMEOUT: 'TIMEOUT' }, violated: [] }), 10000);
      });
    }, [...allowed, ...blocked]);
    expect(results).toEqual({
      ...Object.fromEntries(allowed.map((h) => [h, 'ok'])),
      ...Object.fromEntries(blocked.map((h) => [h, 'BLOCKED'])),
    });
    // 被擋的恰好是對照組（connect-src 違規），白名單內的主機零違規
    expect(violated.every((v: any) => v.directive.startsWith('connect-src'))).toBe(true);
    expect(violated.map((v: any) => new URL(v.blocked).hostname).sort()).toEqual([...blocked].sort());
  });
});

// ══════════════════════════════════════════════════════════════════════════
test.describe('dist：Service Worker 與建置寫入的 CACHE_VERSION', () => {
  test('SW 實際安裝，快取名稱＝dist/sw.js 內的 CACHE_VERSION，App Shell（含 4 個圖示）全數入快取', async ({ page }) => {
    const swUrl = new URL('sw.js', DIST_URL).toString();
    const swText = await (await page.request.get(swUrl)).text();
    const m = swText.match(/const CACHE_VERSION = '(\d{8}-\d{4})';/);
    expect(m, 'dist/sw.js 的 CACHE_VERSION 應為建置產生的 YYYYMMDD-HHmm').not.toBeNull();
    const cacheName = `whisper-subtitler-${m![1]}`;

    await page.goto(DIST_URL);
    await page.evaluate(() => navigator.serviceWorker.ready);

    await expect
      .poll(async () => page.evaluate(async (name) => (await caches.keys()).includes(name), cacheName), { timeout: 15_000 })
      .toBe(true);

    const cachedPaths = await page.evaluate(async (name) => {
      const c = await caches.open(name);
      return (await c.keys()).map((r) => new URL(r.url).pathname);
    }, cacheName);
    const joined = cachedPaths.join('\n');
    for (const icon of ['icon-192.png', 'icon-192-maskable.png', 'icon-512.png', 'apple-touch-icon-180x180.png']) {
      expect(joined, `App Shell 快取缺少 ${icon}`).toContain(icon);
    }
    expect(joined).toContain('manifest.json');
    expect(joined).toContain('index.html');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 假 Worker 替身完整流程：選模型 → 辨識 → 預覽 → 匯出 → ZIP
// serviceWorkers: 'block'：避免 SW 攔截影響 page.route() 的替身回應
// ══════════════════════════════════════════════════════════════════════════

/** 安裝假 Worker（依主程式實際協定回覆）與 CDN 腳本替身 */
async function installFakes(page: Page) {
  await page.addInitScript(() => {
    class FakeWorker extends EventTarget {
      onmessage: ((e: MessageEvent) => void) | null = null;
      onerror: ((e: any) => void) | null = null;
      constructor(_url: any) { super(); }
      private emit(data: any) {
        const ev = new MessageEvent('message', { data });
        this.dispatchEvent(ev);
        if (typeof this.onmessage === 'function') this.onmessage(ev);
      }
      postMessage(msg: any) {
        setTimeout(() => {
          if (msg.type === 'LOAD_MODEL') {
            this.emit({ type: 'MODEL_READY', payload: { device: 'wasm' } });
          } else if (msg.type === 'RUN_CHUNK') {
            const p = msg.payload;
            this.emit({
              type: 'CHUNK_DONE',
              payload: {
                result: {
                  chunks: [
                    { text: '測試', timestamp: [0.2, 0.6] },
                    { text: '字幕', timestamp: [0.7, 1.1] },
                    { text: '第一句', timestamp: [1.2, 1.8] },
                  ],
                },
                segIdx: p.segIdx, startSec: p.startSec, strideSec: p.strideSec,
              },
            });
          }
        }, 5);
      }
      terminate() {}
    }
    (window as any).Worker = FakeWorker;
  });

  // CDN 腳本替身：仍是對 cdn.jsdelivr.net 的真實 <script src>，script-src 白名單照常被檢查
  await page.route('**/jszip@3.10.2/dist/jszip.min.js', (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body: `window.JSZip = class { constructor(){this._f={};} file(n,b){this._f[n]=b;} async generateAsync(){ return new Blob(['PK-fake-zip']); } };`,
    })
  );
  await page.route('**/opencc-js@1.4.2/dist/umd/cn2t.js', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: `window.OpenCC = { Converter: () => (t) => t };` })
  );
}

/** 選模型、關閉 VAD、上傳檔案、開始辨識 */
async function startRecognition(page: Page, files: string[]) {
  await page.goto(DIST_URL);
  await page.locator('.model-btn[data-model="Xenova/whisper-base"]').click();
  // VAD 需從 CDN 載入真實 vad-web/onnxruntime（無法以替身取代），此測試聚焦於 CSP，故關閉
  await page.evaluate(() => {
    const el = document.getElementById('tog_vad') as HTMLInputElement;
    el.checked = false;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.locator('#fileInput').setInputFiles(files);
  await page.locator('#startBtn').click();
}

async function expectClean(page: Page, w: Awaited<ReturnType<typeof attachWatchers>>) {
  const v = await w.violations();
  expect(v, `CSP 違規：${JSON.stringify(v)}`).toEqual([]);
  expect(w.consoleCsp, w.consoleCsp.join('\n')).toEqual([]);
  expect(w.pageErrors).toEqual([]);
  const bad = w.unexpectedFailures();
  expect(bad, JSON.stringify(bad)).toEqual([]);
}

test.describe('dist CSP：假 Worker 替身走完整流程', () => {
  test.use({ serviceWorkers: 'block' });

  test('單檔：選模型→辨識→單檔下載（#dlBtn，blob: 下載）零 CSP 違規', async ({ page }) => {
    const w = await attachWatchers(page);
    await installFakes(page);
    await startRecognition(page, [SAMPLE_AUDIO]);

    await expect(page.locator('.batch-item.done')).toHaveCount(1, { timeout: 60_000 });
    const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#dlBtn').click()]);
    expect(download.suggestedFilename()).toMatch(/\.srt$/i);
    const fs = await import('fs');
    expect(fs.readFileSync((await download.path())!, 'utf8')).toContain('測試');

    await expectClean(page, w);
  });

  test('兩檔：辨識→預覽面板（<audio src=blob:>）→批次 ZIP（fetch blob:＋JSZip 腳本）零 CSP 違規', async ({ page }) => {
    const w = await attachWatchers(page);
    await installFakes(page);

    // 第二個檔案放在純 ASCII 路徑：實測 Playwright 的輸出目錄名稱含中文與「→」時，
    // setInputFiles 的第二個檔案不會進入佇列（與 CSP 無關，原因未深究），故改用系統暫存目錄。
    const fs = await import('fs');
    const os = await import('os');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-csp-'));
    const SECOND_AUDIO = path.join(tmpDir, 'sample2.mp3');
    fs.copyFileSync(SAMPLE_AUDIO, SECOND_AUDIO);

    await startRecognition(page, [SAMPLE_AUDIO, SECOND_AUDIO]);
    await expect(page.locator('.batch-item.done')).toHaveCount(2, { timeout: 90_000 });
    const id = await page.locator('.batch-item.done').first().getAttribute('data-id');

    // 預覽面板：<audio src="blob:…">（需要 media-src blob:）
    await page.locator(`.batch-item-preview-btn[data-id="${id}"]`).click();
    await expect(page.locator('.preview-media-el').first()).toBeAttached();
    await page.waitForTimeout(500); // 給瀏覽器時間嘗試載入 blob 媒體並回報違規

    // 批次 ZIP：downloadAllAsZip() 內 fetch(blob:) 與 JSZip <script> 載入
    const zipBtn = page.locator('#btnDownloadZip');
    await expect(zipBtn).toBeVisible();
    const [zipDl] = await Promise.all([page.waitForEvent('download'), zipBtn.click()]);
    expect(zipDl.suggestedFilename()).toMatch(/\.zip$/i);

    await expectClean(page, w);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// r7：UVR Worker 在 CSP 之下以「真實 onnxruntime-web 1.30.0（WASM）」推論。
// 為什麼要有：假 ORT 只指派 self.ort，測不出 ORT 真正的載入行為（r7 即因此抓到全域 let ort 與 UMD 的 var ort 衝突）；
// 而真實 ORT 還要 wasm-unsafe-eval、動態 import 並下載 .wasm——這些只有真實載入才驗得到。
// 作法：從「來源頁」取出 UVR_WORKER_CODE 字串，放進 dist 頁（CSP 生效）的 blob Worker 執行；替身模型輸出＝輸入×0.5。
test.describe('dist CSP：UVR Worker＋真實 onnxruntime-web', () => {
  test.setTimeout(180_000);
  test('TB-05 blob Worker 在 CSP 下載入真實 ORT、建立 session、推論（人聲 RMS ≈ 輸入 RMS × 0.5），零 CSP 違規', async ({ browser, page }) => {
    test.skip(!REAL_ORT_AVAILABLE, '需要 npm install（onnxruntime-web 1.30.0）與 tests/fixtures/uvr/half-model.onnx');
    // 取得受測的 UVR_WORKER_CODE（原始碼頁無 CSP，只用來讀字串）
    const srcCtx = await newCtx(browser);
    const srcPage = await openWithHook(srcCtx, ['UVR_WORKER_CODE'], 'new');
    const workerCode: string = await srcPage.evaluate(() => (window as any).__t.UVR_WORKER_CODE);
    await srcCtx.close();

    const served: string[] = [];
    await routeRealOrt(page, served);
    const w = await attachWatchers(page);
    await page.goto(DIST_URL);
    const model = Array.from(fs.readFileSync(HALF_MODEL_PATH));
    const r = await page.evaluate(async ({ code, model }) => {
      const full = code + "\nself.addEventListener('securitypolicyviolation', (ev) => self.postMessage({ type: 'CSPV', payload: { directive: ev.violatedDirective, blocked: ev.blockedURI } }));";
      const wk = new Worker(URL.createObjectURL(new Blob([full], { type: 'text/javascript' })), { name: 'uvr' });
      const viol: any[] = [];
      const wait = (until: string, ms: number) => new Promise<any>((resolve) => {
        const t = setTimeout(() => resolve({ type: 'TIMEOUT' }), ms);
        const h = (m: MessageEvent) => {
          if (m.data.type === 'CSPV') { viol.push(m.data.payload); return; }
          if (m.data.type === until || m.data.type === 'ERROR') { clearTimeout(t); wk.removeEventListener('message', h); resolve(m.data); }
        };
        wk.addEventListener('message', h);
      });
      const bytes = Uint8Array.from(model).buffer;
      const ready = wait('READY', 90_000);
      wk.postMessage({ type: 'INIT', payload: { model: bytes, threads: 1 } }, [bytes]);
      const rd = await ready;
      if (rd.type !== 'READY') { wk.terminate(); return { stage: 'INIT', rd, viol }; }
      const n = 44100, left = new Float32Array(n), right = new Float32Array(n);
      for (let i = 0; i < n; i++) { left[i] = 0.5 * Math.sin(2 * Math.PI * 440 * i / 44100); right[i] = 0.4 * Math.sin(2 * Math.PI * 523.25 * i / 44100); }
      const done = wait('DONE', 90_000);
      wk.postMessage({ type: 'SEPARATE', payload: { left, right } }, [left.buffer, right.buffer]);
      const dn = await done;
      wk.terminate();
      return { stage: 'SEPARATE', type: dn.type, rmsIn: dn.payload?.rmsIn, rmsOut: dn.payload?.rmsOut, err: dn.type === 'ERROR' ? dn.payload : undefined, viol };
    }, { code: workerCode, model });
    expect(r.err, JSON.stringify(r)).toBeUndefined();
    expect(r.type, JSON.stringify(r)).toBe('DONE');
    expect(r.rmsOut / r.rmsIn).toBeGreaterThan(0.47);
    expect(r.rmsOut / r.rmsIn).toBeLessThan(0.53);
    expect(r.viol).toEqual([]);                                   // Worker 內零 CSP 違規
    expect(served.some((f) => f.endsWith('.wasm')), `實際取用：${served.join(', ')}`).toBe(true);
    expect(await w.violations()).toEqual([]);
    expect(w.consoleCsp).toEqual([]);
  });
});
