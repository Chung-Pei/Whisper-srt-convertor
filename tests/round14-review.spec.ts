// tests/round14-review.spec.ts — r7 穿透式審查：每個缺陷先寫會失敗的測試，修正後轉綠。
// 涵蓋：VAD 切段不可吃掉每段開頭的字、VAD 閾值語意、取消說話者分割不可卡住、Service Worker 不可誤刪他人快取。
import { test, expect, type Page } from '@playwright/test';
import { newCtx, installScriptedWorker, openWithHook, type Seg } from './harness';
import { setToggles, downloadText, BASE_URL } from './helpers';

/** 16 kHz mono 16-bit WAV：bursts 內為 220 Hz 正弦（RMS≈0.21），其餘靜音。 */
function makeWav(durSec: number, bursts: [number, number][]): Buffer {
  const sr = 16000, n = Math.round(durSec * sr);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (const [a, b] of bursts) {
    for (let i = Math.floor(a * sr); i < Math.min(n, Math.floor(b * sr)); i++) {
      buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * i) / sr) * 0.15 * 32767), 44 + i * 2);
    }
  }
  // 一個滿幅單點脈衝（落在第一段語音內）：模擬真實語音的高波峰因數。峰值正規化後 RMS 仍遠低於 0.5（≈0.09），
  // 否則正規化會把純正弦放大到 RMS≈0.63，掩蓋「Silero 閾值被拿去當 RMS 閾值」的缺陷。
  if (bursts.length) buf.writeInt16LE(32767, 44 + Math.floor((bursts[0][0] + 0.5) * sr) * 2);
  return buf;
}

/** 讓 Silero VAD 的 CDN 載入立即失敗 → 走 RMS 備援（沙盒無外網；先註冊，之後註冊的 OpenCC 替身優先）。 */
async function blockVadCdn(page: Page) {
  await page.route(/cdn\.jsdelivr\.net|unpkg\.com/, (r) => r.abort());
}

async function openAndPickModel(page: Page) {
  await page.goto(BASE_URL);
  await page.locator('.model-btn[data-model="Xenova/whisper-base"]').click();
}

// 每個 VAD 語音段各回一個「段首字」（相對時間 0.5s）與一個「段中字」（相對 6s）
const headWords = (tag: string): Seg => [
  { text: `${tag}HEAD`, timestamp: [0.5, 1.0] },
  { text: `${tag}MID`, timestamp: [6.0, 6.6] },
];

test.describe('r7 審查：VAD', () => {
  test('TR14-01 每個 VAD 語音段開頭的字不可被丟棄', async ({ browser }) => {
    const ctx = await newCtx(browser); const page = await ctx.newPage();
    await blockVadCdn(page);
    await installScriptedWorker(page, { segments: [headWords('S0'), headWords('S1'), headWords('S2')] });
    await openAndPickModel(page);
    await setToggles(page, ['tog_vad'], ['tog_diarization', 'tog_uvr']);
    await page.evaluate(() => { (document.getElementById('p_vad_threshold') as HTMLInputElement).value = '0.02'; });   // 讓原版 RMS 備援也能偵測到語音（隔離「吃字」這個缺陷）
    await page.locator('#fileInput').setInputFiles({ name: 'vad.wav', mimeType: 'audio/wav', buffer: makeWav(30, [[1, 4], [8, 12], [20, 23]]) });
    await page.locator('#startBtn').click();
    await expect(page.locator('.batch-item.done')).toHaveCount(1, { timeout: 60_000 });
    const log = await page.locator('#logBox').innerText();
    expect(log).toContain('偵測到 3 個語音段');
    const txt = await downloadText(page);
    for (const k of ['S0HEAD', 'S1HEAD', 'S2HEAD', 'S1MID', 'S2MID']) expect(txt, `缺少 ${k}`).toContain(k);
    await ctx.close();
  });

  test('TR14-02 使用 UI 預設閾值（0.5，Silero 語意）時，RMS 備援仍須能偵測語音', async ({ browser }) => {
    const ctx = await newCtx(browser); const page = await ctx.newPage();
    await blockVadCdn(page);
    await installScriptedWorker(page, { segments: [headWords('S0'), headWords('S1'), headWords('S2')] });
    await openAndPickModel(page);
    await setToggles(page, ['tog_vad'], ['tog_diarization', 'tog_uvr']);
    expect(await page.locator('#p_vad_threshold').inputValue()).toBe('0.5');
    await page.locator('#fileInput').setInputFiles({ name: 'vad.wav', mimeType: 'audio/wav', buffer: makeWav(30, [[1, 4], [8, 12], [20, 23]]) });
    await page.locator('#startBtn').click();
    await expect(page.locator('.batch-item.done')).toHaveCount(1, { timeout: 60_000 });
    const log = await page.locator('#logBox').innerText();
    expect(log).not.toContain('未偵測到語音段落');
    expect(log).toContain('偵測到 3 個語音段');
    await ctx.close();
  });

  test('TR14-03 極短音訊（< 1 個 RMS 視窗）不可讓 VAD 丟出 RangeError', async ({ browser }) => {
    const ctx = await newCtx(browser);
    const p = await openWithHook(ctx, ['runVAD_rms'], 'new');
    const r = await p.evaluate(() => {
      const f = (window as any).__t.runVAD_rms;
      const out: any = {};
      for (const n of [0, 100, 255, 256, 511, 512, 700]) {
        try { out[n] = f(new Float32Array(n), 16000).length; } catch (e: any) { out[n] = 'ERR ' + e.name; }
      }
      return out;
    });
    for (const [n, v] of Object.entries(r)) expect(v, `長度 ${n}`).toBe(0);
    await ctx.close();
  });
});

test.describe('r7 審查：IndexedDB 單一來源', () => {
  test('TR14-06 idbPut／idbGet 對音訊分片庫與模型庫往返一致；分片經 storeAudioInIDB 寫入後可讀回', async ({ browser }) => {
    const ctx = await newCtx(browser);
    const p = await openWithHook(ctx, ['idbPut', 'idbGet', 'storeAudioInIDB', 'readAudioShard', 'IDB_MODEL_STORE', 'UVR_IDB_KEY'], 'new');
    const r = await p.evaluate(async () => {
      const T = (window as any).__t;
      await T.idbPut('r7:k', new Float32Array([1, 2, 3]));                                  // 預設庫（音訊分片）
      const a = await T.idbGet('r7:k');
      const none = await T.idbGet('r7:missing');                                           // 不存在 → null
      const model = new Uint8Array([9, 8, 7, 6]).buffer;
      await T.idbPut(T.UVR_IDB_KEY, model, T.IDB_MODEL_STORE);                              // 模型庫
      const m = await T.idbGet(T.UVR_IDB_KEY, T.IDB_MODEL_STORE);
      const cross = await T.idbGet(T.UVR_IDB_KEY);                                          // 兩個庫互不相通
      const audio = new Float32Array(30000).map((_, i) => Math.sin(i / 50));
      await T.storeAudioInIDB('r7-audio', audio);
      const shard = await T.readAudioShard('r7-audio', 0);
      return { a: Array.from(a), none, m: Array.from(new Uint8Array(m)), cross, shardLen: shard.length, shard0: shard[1] === audio[1] };
    });
    expect(r.a).toEqual([1, 2, 3]); expect(r.none).toBeNull();
    expect(r.m).toEqual([9, 8, 7, 6]); expect(r.cross).toBeNull();
    expect(r.shardLen).toBe(30000); expect(r.shard0).toBe(true);
    await ctx.close();
  });
});

test.describe('r7 審查：IndexedDB 交易中止', () => {
  test('TR14-07 交易在提交階段被中止（如 QuotaExceededError）時，idbPut 必須 reject 一個 Error，不可永遠等待', async ({ browser }) => {
    const ctx = await newCtx(browser);
    const p = await openWithHook(ctx, ['idbPut', 'IDB_MODEL_STORE'], 'new');
    const r = await p.evaluate(async () => {
      const T = (window as any).__t;
      const orig = IDBObjectStore.prototype.put;
      // 請求成功後才中止交易：只會觸發 transaction 的 abort 事件，不會對任何請求觸發 error（與提交階段的配額錯誤同型）
      IDBObjectStore.prototype.put = function (...a: any[]) {
        const req = (orig as any).apply(this, a);
        req.addEventListener('success', () => this.transaction.abort());
        return req;
      };
      try {
        return await Promise.race([
          T.idbPut('r7:abort', new Uint8Array(4)).then(() => ({ kind: 'resolved' }), (e: any) => ({ kind: 'rejected', isError: e instanceof Error, msg: String(e?.message ?? e) })),
          new Promise((res) => setTimeout(() => res({ kind: 'HANG' }), 4000)),
        ]);
      } finally { IDBObjectStore.prototype.put = orig; }
    });
    expect(r, JSON.stringify(r)).toMatchObject({ kind: 'rejected', isError: true });
    expect((r as any).msg.length).toBeGreaterThan(0);
    await ctx.close();
  });
});

test.describe('r7 審查：取消與 Service Worker', () => {
  test('TR14-04 說話者分割進行中按取消，須在數秒內結束（不可等 300 秒計時器）', async ({ browser }) => {
    const ctx = await newCtx(browser); const page = await ctx.newPage();
    await blockVadCdn(page);
    await page.addInitScript(() => {
      const w = window as any; w.__diarStarted = false;
      class FakeWorker extends EventTarget {
        onmessage: any = null; onerror: any = null; dead = false;
        constructor(_u: any) { super(); }
        emit(data: any) { if (this.dead) return; const ev = new MessageEvent('message', { data }); this.dispatchEvent(ev); if (typeof this.onmessage === 'function') this.onmessage(ev); }
        postMessage(msg: any) {
          setTimeout(() => {
            if (msg.type === 'LOAD_MODEL') { this.emit({ type: 'BACKEND', payload: { backend: 'wasm', dtype: 'q8' } }); this.emit({ type: 'MODEL_READY', payload: { device: 'wasm' } }); }
            else if (msg.type === 'RUN_CHUNK') this.emit({ type: 'CHUNK_DONE', payload: { result: { chunks: [{ text: '你好', timestamp: [0.5, 1.0] }] }, segIdx: msg.payload.segIdx, startSec: msg.payload.startSec } });
            else if (msg.type === 'LOAD') this.emit({ type: 'LOADED' });
            else if (msg.type === 'DIARIZE') w.__diarStarted = true;           // 永不完成，等待取消
            else if (msg.type === 'CANCEL') this.emit({ type: 'CANCELLED' });   // 與真 Worker 相同的回覆
          }, 3);
        }
        terminate() { this.dead = true; }
      }
      w.Worker = FakeWorker;
    });
    await page.route('**/opencc-js@*/dist/umd/cn2t.js', (r) => r.fulfill({ contentType: 'application/javascript', body: 'window.OpenCC = { Converter: () => (t) => t };' }));
    await openAndPickModel(page);
    await setToggles(page, ['tog_diarization'], ['tog_vad', 'tog_uvr']);
    await page.locator('#fileInput').setInputFiles({ name: 'a.wav', mimeType: 'audio/wav', buffer: makeWav(10, [[1, 4]]) });
    await page.locator('#startBtn').click();
    await page.waitForFunction(() => (window as any).__diarStarted === true, null, { timeout: 30_000 });
    await page.locator('#cancelBtn').click();
    await expect(page.locator('#logBox')).toContainText('已取消', { timeout: 5_000 });
    // 取消後整批結束：取消鈕收起、進度顯示「已取消」、該檔狀態為已取消（不可變成「完成」）
    await expect(page.locator('#cancelBtn')).not.toHaveClass(/show/, { timeout: 5_000 });
    await expect(page.locator('#progLabel')).toContainText('已取消');
    await expect(page.locator('.batch-item.done')).toHaveCount(0);
    await ctx.close();
  });

  test('TR14-05 Service Worker 啟動時只清自己的舊版快取，不可刪同網域其他 PWA 的快取', async ({ browser }) => {
    const ctx = await browser.newContext();           // 這個測試需要真的 Service Worker
    const page = await ctx.newPage();
    await page.goto(new URL('manifest.json', BASE_URL).toString());     // 同網域、尚未註冊 SW
    await page.evaluate(async () => {
      await caches.open('other-app-v1');
      await caches.open('whisper-subtitler-19700101-0000');             // 自己的舊版：應被清掉
    });
    await page.goto(BASE_URL);
    await page.evaluate(() => navigator.serviceWorker.ready);
    await expect.poll(async () => page.evaluate(async () => (await caches.keys()).includes('whisper-subtitler-19700101-0000')), { timeout: 10_000 }).toBe(false);
    const keys = await page.evaluate(() => caches.keys());
    expect(keys).toContain('other-app-v1');
    await ctx.close();
  });
});
