// tests/helpers.ts
// 回歸測試共用輔助函式（假 Whisper Worker、OpenCC 替身、開關設定、辨識流程、下載讀取）。
// 抽成單一檔案，避免各 spec 各自複製一份而日後分歧。

import { expect, type Page } from '@playwright/test';
import path from 'path';

export const BASE_URL = process.env.WHISPER_TEST_URL ?? 'http://localhost:8080/index.html';
export const SAMPLE_AUDIO = path.join(__dirname, 'fixtures', 'sample.mp3');

// ── 共用：假的 Whisper Worker（依主程式實際協定回覆）＋ OpenCC 替身 ────────────────
export async function installFakeWhisperWorker(page: Page, chunks: { text: string; timestamp: [number, number] }[]) {
  await page.addInitScript((chunkList) => {
    class FakeWorker extends EventTarget {
      onmessage: ((e: MessageEvent) => void) | null = null;
      constructor(_url: any) { super(); }
      private emit(data: any) {
        const ev = new MessageEvent('message', { data });
        this.dispatchEvent(ev);
        if (typeof this.onmessage === 'function') this.onmessage(ev);
      }
      postMessage(msg: any) {
        setTimeout(() => {
          if (msg.type === 'LOAD_MODEL') this.emit({ type: 'MODEL_READY', payload: { device: 'wasm' } });
          else if (msg.type === 'RUN_CHUNK') {
            const p = msg.payload;
            this.emit({ type: 'CHUNK_DONE', payload: { result: { chunks: chunkList }, segIdx: p.segIdx, startSec: p.startSec, strideSec: p.strideSec } });
          }
        }, 3);
      }
      terminate() {}
    }
    (window as any).Worker = FakeWorker;
  }, chunks);
  await page.route('**/opencc-js@*/dist/umd/cn2t.js', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: 'window.OpenCC = { Converter: () => (t) => t };' })
  );
}

export async function setToggles(page: Page, on: string[], off: string[]) {
  await page.evaluate(({ on, off }) => {
    const set = (id: string, v: boolean) => {
      const el = document.getElementById(id) as HTMLInputElement | null;
      if (!el) throw new Error('找不到開關 #' + id);
      el.checked = v;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    on.forEach((id) => set(id, true));
    off.forEach((id) => set(id, false));
  }, { on, off });
}

export async function recognize(page: Page) {
  await page.goto(BASE_URL);
  await page.locator('.model-btn[data-model="Xenova/whisper-base"]').click();
}

export async function runAndWaitDone(page: Page) {
  await page.locator('#fileInput').setInputFiles(SAMPLE_AUDIO);
  await page.locator('#startBtn').click();
  await expect(page.locator('.batch-item.done')).toHaveCount(1, { timeout: 60_000 });
}

export async function downloadText(page: Page): Promise<string> {
  const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('#dlBtn').click()]);
  const fs = await import('fs');
  return fs.readFileSync((await dl.path())!, 'utf8');
}

