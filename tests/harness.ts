// tests/harness.ts — v24 測試基礎設施（只用於測試；不得出貨）
import { Page, BrowserContext, Browser } from '@playwright/test';
import fs from 'fs';
import { execFileSync } from 'child_process';
import path from 'path';

export const ROOT_HTML = path.join(__dirname, '..', 'index.html');
export const OLD_HTML = path.join(__dirname, 'baseline', 'v23_2', 'index.html');
export const BASE_URL = process.env.WHISPER_TEST_URL ?? 'http://localhost:8080/index.html';

/** 在「最後一段 <script>（SW 註冊）」之前的 </script> 前插入測試掛勾，讀寫主程式 module 內部名稱。
 *  只用於原始碼頁面（無 CSP）；dist 頁面的 CSP 不含 unsafe-eval，不可使用。舊版沒有的名稱以 try 略過。 */
/** 預設詞典陣列在 index.html 內的位置：`const DEFAULT_MEDICAL_DICT = [` 到下一個行首的 `];`。 */
function dictRegion(html: string): [number, number] {
  const a = html.indexOf('const DEFAULT_MEDICAL_DICT = [');
  const b = a < 0 ? -1 : html.indexOf('\n];', a);
  if (a < 0 || b < 0) throw new Error('找不到 DEFAULT_MEDICAL_DICT 陣列');
  return [a, b + 3];
}

/** 舊版（v23.2）頁面：提供頁面時把它的預設詞典換成受測頁面（ROOT）的詞典，磁碟上的 baseline 檔案不動。
 *  為什麼：「舊版當 oracle」的特徵測試要驗的是引擎（切片器、預篩、預編譯）逐字相同；詞典內容本來就會隨版本增修
 *  （r5：P4 高信心詞條、重複別稱去重），若新舊各用自己的詞典，詞典差異會被誤判成引擎差異。
 *  詞典內容本身由 round12-r5-review 的 TR-08～TR-11 驗證，不靠新舊對照。 */
function withRootDict(oldHtml: string): string {
  const root = fs.readFileSync(ROOT_HTML, 'utf8');
  const [ra, rb] = dictRegion(root), [oa, ob] = dictRegion(oldHtml);
  return oldHtml.slice(0, oa) + root.slice(ra, rb) + oldHtml.slice(ob);
}

/** 測試要提供給瀏覽器的頁面 HTML：新版＝原始碼；舊版＝v23.2＋受測頁面的預設詞典（見 withRootDict）。所有「舊版當 oracle」的測試都從這裡取頁面。 */
export function readPageHtml(which: 'new' | 'old'): string {
  return which === 'old' ? withRootDict(fs.readFileSync(OLD_HTML, 'utf8')) : fs.readFileSync(ROOT_HTML, 'utf8');
}

export async function exposeInternals(page: Page, names: string[], which: 'new' | 'old' = 'new') {
  let html = readPageHtml(which);
  const opens = html.match(/<script[\s>]/g) ?? [];
  if (opens.length !== 3) throw new Error(`expected exactly 3 <script>, got ${opens.length}`);
  const lastOpen = html.lastIndexOf('<script');
  const closeBefore = html.lastIndexOf('</script>', lastOpen);
  const hook =
    '\nwindow.__t = {}; ' +
    names.map((n) => `try{__t[${JSON.stringify(n)}]=${n}}catch(_){}`).join(' ') +
    ' __t.evalIn = (s) => eval(s);\n';
  html = html.slice(0, closeBefore) + hook + html.slice(closeBefore);
  await page.route('**/index.html', (r) => r.fulfill({ contentType: 'text/html; charset=utf-8', body: html }));
}

/** 每個測試用獨立 context，並封鎖 Service Worker：SW 會接管第二次導覽，使 page.route 注入的測試掛勾失效（實測會卡住）。 */
export async function newCtx(browser: Browser) { return browser.newContext({ serviceWorkers: 'block' }); }

export async function openWithHook(ctx: BrowserContext, names: string[], which: 'new' | 'old') {
  const p = await ctx.newPage();
  await exposeInternals(p, names, which);
  await p.goto(BASE_URL);
  await p.waitForFunction(() => !!(window as any).__t);
  return p;
}

// ── 合成逐字稿（由頁面內的 BOPOMOFO_MAP／DEFAULT_MEDICAL_DICT 產生，種子固定；詞間距 > WORD_MERGE_GAP）──
export type Seg = { text: string; timestamp: [number, number] }[];
export type CorpusSpec = { segments: number; linesPerSegment: number; charsPerLine: number; termRate: number; seed: number };

export async function buildSegments(ctx: BrowserContext, spec: CorpusSpec): Promise<Seg[]> {
  const p = await openWithHook(ctx, ['BOPOMOFO_MAP', 'DEFAULT_MEDICAL_DICT'], 'old'); // 以舊版當產生器：與受測版本無關
  try {
    return await p.evaluate(({ segments, linesPerSegment, charsPerLine, termRate, seed }) => {
      const T = (window as any).__t;
      const M: Map<string, string> = T.BOPOMOFO_MAP, D = T.DEFAULT_MEDICAL_DICT;
      let s = seed >>> 0;
      const rnd = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
      const pick = <X,>(a: X[]) => a[Math.floor(rnd() * a.length)];
      const homo = new Map<string, string[]>();
      for (const [k, v] of M) { if (!homo.has(v)) homo.set(v, []); homo.get(v)!.push(k); }
      const terms: string[] = D.flatMap((e: any) => [e.zh, ...e.raw.split('|').map((v: string) => v.trim()).filter(Boolean)])
        .filter((t: string) => /[\u4e00-\u9fff]/.test(t) && t.length >= 2);
      const mangle = (t: string) => [...t].map((c) => (rnd() < 0.35 && homo.get(M.get(c)!) ? pick(homo.get(M.get(c)!)!) : c)).join('');
      const filler = ['今天', '我們', '討論', '這個', '病人', '因為', '所以', '可以', '需要', '注意', '如果', '出現', '然後', '的', '是', '在', '有', '很',
        '大家', '那麼', '其實', '就是', '我覺得', '比較', '開始', '上課', '同學', '請看', '這邊', '之後'];
      const mk = () => { let x = ''; while (x.length < charsPerLine) x += rnd() < termRate ? (rnd() < 0.6 ? mangle(pick(terms)) : pick(terms)) : pick(filler); return x.slice(0, charsPerLine + 3); };
      const spacing = Math.min(3, 24 / linesPerSegment);
      return Array.from({ length: segments }, () => Array.from({ length: linesPerSegment }, (_, j) => {
        const st = +(5 + j * spacing).toFixed(2);
        return { text: mk(), timestamp: [st, +(st + spacing * 0.6).toFixed(2)] as [number, number] };
      }));
    }, spec);
  } finally { await p.close(); }
}

// ── 假 Whisper Worker（可編排；依主程式實際協定回覆）──────────────────────────────
export type Rule = { segIdx: number; attempt?: number; silent?: boolean; crash?: string;
  reply?: { type: 'CHUNK_ERROR'; error: string } | { type: 'ERROR'; payload: string } };

export async function installScriptedWorker(page: Page, cfg: { segments: Seg[]; rules?: Rule[]; backend?: 'webgpu' | 'wasm' }) {
  await page.addInitScript(({ segments, rules, backend }) => {
    const w = window as any;
    w.__workerLog = []; w.__attempts = {}; w.__dtype = null; w.__nWorkers = 0;
    class FakeWorker extends EventTarget {
      onmessage: ((e: MessageEvent) => void) | null = null;
      onerror: any = null; dead = false; id: number;
      constructor(_u: any) { super(); this.id = ++w.__nWorkers; }
      emit(data: any) {
        if (this.dead) return;
        w.__workerLog.push({ type: 'REPLY', of: data.type, t: performance.now(), w: this.id });
        const ev = new MessageEvent('message', { data });
        this.dispatchEvent(ev);
        if (typeof this.onmessage === 'function') this.onmessage(ev);
      }
      postMessage(msg: any) {
        const p = msg.payload || {};
        if (msg.type === 'LOAD_MODEL') {
          w.__dtype = p.dtype;
          w.__workerLog.push({ type: 'LOAD_MODEL', dtype: p.dtype, preferGpu: p.preferGpu, w: this.id, t: performance.now() });
          const be = backend === 'webgpu' && p.preferGpu !== false ? 'webgpu' : 'wasm';
          setTimeout(() => { this.emit({ type: 'BACKEND', payload: { backend: be, dtype: p.dtype } }); this.emit({ type: 'MODEL_READY', payload: { device: be } }); }, 3);
        } else if (msg.type === 'RUN_CHUNK') {
          const k = (w.__attempts[p.segIdx] = (w.__attempts[p.segIdx] ?? -1) + 1);
          w.__workerLog.push({ type: 'RUN_CHUNK', segIdx: p.segIdx, attempt: k, dtype: w.__dtype, w: this.id, t: performance.now() });
          const rule = rules.find((r: any) => r.segIdx === p.segIdx && (r.attempt === undefined || r.attempt === k));
          if (rule?.silent) return;
          if (rule?.crash) {
            setTimeout(() => { const ev = new ErrorEvent('error', { message: rule.crash }); this.dispatchEvent(ev); if (typeof this.onerror === 'function') this.onerror(ev); }, 3);
            return;
          }
          setTimeout(() => {
            if (rule?.reply?.type === 'CHUNK_ERROR') this.emit({ type: 'CHUNK_ERROR', payload: { error: rule.reply.error, segIdx: p.segIdx } });
            else if (rule?.reply?.type === 'ERROR') this.emit({ type: 'ERROR', payload: rule.reply.payload });
            else this.emit({ type: 'CHUNK_DONE', payload: { result: { chunks: segments[p.segIdx % segments.length] }, segIdx: p.segIdx, startSec: p.startSec, strideSec: p.strideSec } });
          }, 3);
        }
      }
      terminate() { this.dead = true; }
    }
    w.Worker = FakeWorker;
  }, { segments: cfg.segments, rules: cfg.rules ?? [], backend: cfg.backend ?? 'wasm' });
  await page.route('**/opencc-js@*/dist/umd/cn2t.js', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: 'window.OpenCC = { Converter: () => (t) => t };' }));
}

// ── 停頓／進度監看（longtask＋rAF 間隔＋進度標籤）；視窗＝最後一次 RUN_CHUNK 回覆 → 「完成」標籤 ──────
export async function installMonitor(page: Page) {
  await page.addInitScript(() => {
    const m: any = ((window as any).__mon = { long: [], raf: [], prog: [], doneAt: 0 });
    try { new PerformanceObserver((l) => l.getEntries().forEach((e) => m.long.push([e.startTime, e.duration]))).observe({ type: 'longtask', buffered: true }); } catch (_) {}
    let last = performance.now();
    const tick = (t: number) => { m.raf.push([t, t - last]); last = t; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    document.addEventListener('DOMContentLoaded', () => {
      const lbl = document.getElementById('progLabel')!, pct = document.getElementById('progPct')!;
      const rec = () => { const now = performance.now(); const l = lbl.textContent || ''; m.prog.push([now, l, pct.textContent || '']); if (l.includes('完成')) m.doneAt = now; };
      const o = { childList: true, characterData: true, subtree: true };
      new MutationObserver(rec).observe(lbl, o); new MutationObserver(rec).observe(pct, o);
      // 取消延遲：以事件的 timeStamp（輸入抵達時間）到日誌出現「已取消」為止；主執行緒被占住時，延遲會被如實量到
      document.addEventListener('click', (e) => { if ((e.target as HTMLElement)?.id === 'cancelBtn') m.clickTs = e.timeStamp; }, true);
      const lb = document.getElementById('logBox')!;
      new MutationObserver(() => { if (!m.cancelLogged && (lb.textContent || '').includes('已取消')) m.cancelLogged = performance.now(); }).observe(lb, o);
    });
  });
}

export type Stall = {
  cancelLatencyMs?: number; windowMs: number; maxLongtaskMs: number; longtasks: number; maxRafGapMs: number; progressUpdates: number; progressMonotonic: boolean };
export async function stallReport(page: Page): Promise<Stall> {
  return page.evaluate(() => {
    const w = window as any, m = w.__mon, wl: any[] = w.__workerLog;
    const t0 = Math.max(...wl.filter((e) => e.type === 'REPLY' && e.of === 'CHUNK_DONE').map((e) => e.t));
    const t1 = m.doneAt || performance.now();
    const long = m.long.filter(([s, d]: number[]) => s + d >= t0 && s <= t1);
    const raf = m.raf.filter(([t]: number[]) => t >= t0 && t <= t1);
    const prog = m.prog.filter(([t, l]: any[]) => t >= t0 && t <= t1 && !String(l).includes('完成'));
    const nums = prog.map((p: any[]) => parseInt(String(p[2]), 10)).filter((n: number) => !Number.isNaN(n));
    const distinct = new Set(prog.map((p: any[]) => p[1] + '|' + p[2])).size;
    return {
      windowMs: Math.round(t1 - t0),
      maxLongtaskMs: Math.round(Math.max(0, ...long.map((x: number[]) => x[1]))),
      longtasks: long.length,
      maxRafGapMs: Math.round(Math.max(0, ...raf.map((x: number[]) => x[1]))),
      progressUpdates: distinct,
      progressMonotonic: nums.every((n: number, i: number) => i === 0 || n >= nums[i - 1]),
      cancelLatencyMs: m.clickTs && m.cancelLogged ? Math.round(m.cancelLogged - m.clickTs) : undefined,
    };
  });
}

/** 取 batch 完成後的下載文字（沿用 #dlBtn）。 */
export async function waitDone(page: Page, timeout = 300_000) {
  await page.locator('.batch-item.done').first().waitFor({ timeout });
}

/** 以子行程呼叫純 Node 的 gen-media.mjs（檔案已存在則略過）；回傳絕對路徑。 */
export function ensureMedia(names: string[]): string[] {
  const dir = path.join(__dirname, 'fixtures');
  if (names.some((n) => !fs.existsSync(path.join(dir, 'generated', n)))) {
    execFileSync(process.execPath, [path.join(dir, 'gen-media.mjs'), ...names], { stdio: 'inherit' });
  }
  return names.map((n) => path.join(dir, 'generated', n));
}

// ── 真實 onnxruntime-web（devDependency，版本須與 index.html 的 ONNX_WASM_CDN 相同）＋「輸出＝輸入×0.5」替身模型 ──────────────
// 用途：沙盒／CI 沒有 66 MB 的真 Kim_Vocal_2 時，仍能讓 UVR Worker 在真實 ORT-web（WASM）上跑完整流程。
export const REAL_ORT_DIR = path.join(__dirname, '..', 'node_modules', 'onnxruntime-web', 'dist');
export const HALF_MODEL_PATH = path.join(__dirname, 'fixtures', 'uvr', 'half-model.onnx');
export const REAL_ORT_AVAILABLE = fs.existsSync(path.join(REAL_ORT_DIR, 'ort.all.min.js')) && fs.existsSync(HALF_MODEL_PATH);
const ORT_MIME: Record<string, string> = { '.js': 'application/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.map': 'application/json' };

/** 以 node_modules 內的真實 ORT-web 檔案回應 cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/*；served 收集實際被取用的檔名。 */
export async function routeRealOrt(page: Page, served: string[] = []) {
  await page.route('**/onnxruntime-web@1.30.0/dist/**', async (r) => {
    const name = decodeURIComponent(new URL(r.request().url()).pathname.split('/').pop() ?? '');
    const file = path.join(REAL_ORT_DIR, path.basename(name));
    if (!name || !fs.existsSync(file)) return r.fulfill({ status: 404, body: 'not found', headers: { 'access-control-allow-origin': '*' } });
    served.push(name);
    return r.fulfill({ status: 200, body: fs.readFileSync(file),
      headers: { 'content-type': ORT_MIME[path.extname(name)] ?? 'application/octet-stream', 'access-control-allow-origin': '*', 'cross-origin-resource-policy': 'cross-origin' } });
  });
  return served;
}
