// scripts/check-consistency.mjs
// 圖示三處一致性檢查：manifest.json（唯一真實來源）／index.html（子集合）／sw.js（須完全相等）。
// 純內建模組：fs、path、url。無外部依賴。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// 正規化：去掉 sw.js 樣板字串的 ${BASE} 前綴，再去掉開頭的 '/'。
// manifest.json 只需去開頭 '/'；index.html 兩者皆無、正規化為 no-op。
function normalize(s) {
  return s.replace(/^\$\{BASE\}/, '').replace(/^\//, '');
}

function readManifestIcons(manifestPath) {
  const json = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  return (json.icons ?? []).map((icon) => normalize(icon.src));
}

function readIndexIconLinks(indexPath) {
  const html = fs.readFileSync(indexPath, 'utf8');
  const linkTags = html.match(/<link\b[^>]*>/g) ?? [];
  const iconLinks = linkTags.filter((tag) => /rel=["'](icon|apple-touch-icon)["']/.test(tag));
  const hrefs = [];
  for (const tag of iconLinks) {
    const m = tag.match(/href=["']([^"']+)["']/);
    if (m) hrefs.push(normalize(m[1]));
  }
  return hrefs;
}

function readSwAppShellIcons(swPath) {
  const js = fs.readFileSync(swPath, 'utf8');
  const arrMatch = js.match(/const APP_SHELL = \[([\s\S]*?)\];/);
  if (!arrMatch) return [];
  const items = arrMatch[1].match(/`([^`]*)`/g) ?? [];
  const icons = [];
  for (const raw of items) {
    const inner = raw.slice(1, -1); // 去掉外層反引號
    const norm = normalize(inner);
    if (norm.startsWith('icons/')) icons.push(norm);
  }
  return icons;
}

/**
 * 檢查 manifest.json／index.html／sw.js 三處圖示宣告是否一致。
 * 純函式，不呼叫 process.exit。
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function checkIconConsistency({
  manifestPath = path.join(ROOT, 'manifest.json'),
  indexPath = path.join(ROOT, 'index.html'),
  swPath = path.join(ROOT, 'sw.js'),
} = {}) {
  const errors = [];

  const M = readManifestIcons(manifestPath);
  const L = readIndexIconLinks(indexPath);
  const S = readSwAppShellIcons(swPath);

  const setM = new Set(M);
  const setS = new Set(S);

  // a. index.html 的 <link> 必須是 manifest 集合的子集合
  const extraInL = L.filter((x) => !setM.has(x));
  if (extraInL.length > 0) {
    errors.push(
      `[check] index.html 的 <link rel="icon"|"apple-touch-icon"> 連到 manifest.json 未宣告的圖示：${extraInL.join(', ')}`
    );
  }

  // b. sw.js 的 APP_SHELL 圖示須與 manifest 完全相等
  const missingInS = M.filter((x) => !setS.has(x));
  const extraInS = S.filter((x) => !setM.has(x));
  if (missingInS.length > 0) {
    errors.push(`[check] sw.js 的 APP_SHELL 缺少 manifest.json 宣告的圖示：${missingInS.join(', ')}`);
  }
  if (extraInS.length > 0) {
    errors.push(`[check] sw.js 的 APP_SHELL 多出 manifest.json 未宣告的圖示：${extraInS.join(', ')}`);
  }

  // c. manifest 宣告的每個圖示檔案須實際存在
  for (const rel of M) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) {
      errors.push(`[check] manifest.json 宣告的圖示檔案不存在：${rel}（預期路徑：${abs}）`);
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * 模糊詞典比對的相似度門檻預設值只能有「單一來源」：index.html 內的常數 FUZZY_THRESHOLD_DEFAULT。
 * 歷史上曾出現函式預設 0.75、UI 與後備值 0.65 兩套數字並存（v23.2 統一）。
 * 這裡以靜態檢查防止日後又有人在別處寫死數字：
 *   1. 常數必須恰好定義一次
 *   2. applyFuzzyMedicalDict 的 threshold 預設參數不得是數字字面值
 *   3. #p_fuzzy_threshold 輸入框不得帶 value 屬性（初始值由程式以常數設定）
 *   4. 讀取該輸入框的 `|| 後備值` 不得是數字字面值
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function checkDefaultsConsistency({ indexPath = path.join(ROOT, 'index.html') } = {}) {
  const html = fs.readFileSync(indexPath, 'utf8');
  const errors = [];

  const defs = html.match(/const FUZZY_THRESHOLD_DEFAULT\s*=/g) ?? [];
  if (defs.length !== 1) {
    errors.push(`[check] 預期 const FUZZY_THRESHOLD_DEFAULT 恰好定義 1 次，實際 ${defs.length} 次`);
  }
  if (/function applyFuzzyMedicalDict\s*\([^)]*threshold\s*=\s*[0-9.]/.test(html)) {
    errors.push('[check] applyFuzzyMedicalDict 的 threshold 預設參數寫成數字字面值，應使用 FUZZY_THRESHOLD_DEFAULT');
  }
  const inputTag = html.match(/<input\b[^>]*id="p_fuzzy_threshold"[^>]*>/)?.[0] ?? '';
  if (!inputTag) {
    errors.push('[check] 找不到 #p_fuzzy_threshold 輸入框');
  } else if (/\svalue=/.test(inputTag)) {
    errors.push('[check] #p_fuzzy_threshold 輸入框不得帶 value 屬性（預設值只能來自 FUZZY_THRESHOLD_DEFAULT）');
  }
  if (/p_fuzzy_threshold'\)\?\.value\)\s*\|\|\s*[0-9.]/.test(html)) {
    errors.push("[check] 讀取 #p_fuzzy_threshold 的後備值寫成數字字面值，應使用 FUZZY_THRESHOLD_DEFAULT");
  }
  return { ok: errors.length === 0, errors };
}

/** v24：Worker 內沒有 performance.memory（實測），儲存配額使用率也不是 RAM；這類偵測已移除，不得再出現。 */
export function checkNoWorkerMemoryApi({ indexPath = path.join(ROOT, 'index.html') } = {}) {
  const html = fs.readFileSync(indexPath, 'utf8');
  const errors = [];
  const forbidden = ['performance.memory', 'storage.estimate', 'MEMORY_PRESSURE', 'DEGRADE_STRATEGY'];
  for (const name of ['WORKER_CODE', 'DIARIZATION_WORKER_CODE', 'UVR_WORKER_CODE']) {
    const m = html.match(new RegExp('const ' + name + '\\s*=\\s*`([\\s\\S]*?)\\n`;'));
    if (!m) { errors.push(`[check] 找不到 ${name} 樣板字串`); continue; }
    for (const f of forbidden) {
      if (m[1].includes(f)) errors.push(`[check] ${name} 內不得出現 ${f}（Worker 內沒有 performance.memory；儲存配額比例不是 RAM）`);
    }
  }
  // r7：ORT-web 的 UMD 檔以 var ort= 在全域宣告 ort。UVR Worker 若在最上層也宣告 ort（let／const／var／function／class），
  // importScripts 會以 NetworkError 失敗（1.30.0 實測）。假 ORT 的測試測不出這件事，故另設靜態守門。
  const uvr = html.match(/const UVR_WORKER_CODE\s*=\s*`([\s\S]*?)\n`;/)?.[1] ?? '';
  if (/^(?:let|const|var|function|class)\s+ort\b/m.test(uvr) || /^(?:let|const|var)\s[^\n;]*,\s*ort\b/m.test(uvr)) {
    errors.push('[check] UVR_WORKER_CODE 最上層不得宣告名為 ort 的識別字（與 ORT-web UMD 的全域 var ort 衝突，importScripts 會失敗）；請用 ortApi 之類的名稱');
  }
  for (const f of ['MEMORY_PRESSURE', 'DEGRADE_STRATEGY', '_dynamicChunkSec']) {
    if (html.includes(f)) errors.push(`[check] index.html 不得再出現 ${f}`);
  }
  return { ok: errors.length === 0, errors };
}

/** v24：單一來源守門——關鍵常數與函式各只能定義一次；解碼與讓出機制各只有一份實作。 */
export function checkSingleSources({ indexPath = path.join(ROOT, 'index.html') } = {}) {
  const html = fs.readFileSync(indexPath, 'utf8');
  const count = (re) => (html.match(re) || []).length;
  const expect = [
    [/const POST_SLICE_BUDGET_MS\b/g, 1, 'POST_SLICE_BUDGET_MS 只能定義一次'],
    [/const TIER_BUDGET_MB\b/g, 1, 'TIER_BUDGET_MB 只能定義一次'],
    [/const OOM_ERROR_PATTERNS\b/g, 1, 'OOM_ERROR_PATTERNS 只能定義一次'],
    [/let CHUNK_TIMEOUT_MS\b/g, 1, 'CHUNK_TIMEOUT_MS 只能定義一次'],
    [/const FUZZY_UNSAFE_RE\b/g, 1, 'FUZZY_UNSAFE_RE 只能定義一次'],
    [/function yieldToMain\b/g, 1, 'yieldToMain 只能定義一次'],
    [/new MessageChannel\b/g, 1, '讓出主執行緒的 MessageChannel 只能出現在 yieldToMain'],
    [/function decodeToMono16k\b/g, 1, 'decodeToMono16k 只能定義一次'],
    [/decodeAudioData\(/g, 1, 'decodeAudioData 只能出現在 decodeFileToBuffer（辨識 16 kHz 與 UVR 44.1 kHz 共用的解碼入口）'],
    [/function idbPut\b/g, 1, 'idbPut 只能定義一次（音訊分片與 UVR 模型快取共用；須處理 tx.onabort）'],
    [/function idbGet\b/g, 1, 'idbGet 只能定義一次（音訊分片與 UVR 模型快取共用）'],
    [/db\.transaction\(/g, 7, 'IndexedDB 交易只能出現在既有的 taskState／清理／idbPut／idbGet／idbDeletePrefix 內，不可再複製一份讀寫函式'],
    [/function mixToMono\b/g, 1, 'mixToMono 只能定義一次（辨識與 UVR 的多聲道降混共用）'],
    [/new Worker\(/g, 1, 'new Worker( 只能出現在 spawnWorker（辨識／說話者分割／UVR 共用的 Blob Worker 建立入口）'],
    [/const TRANSFORMERS_URL\s*=/g, 1, 'TRANSFORMERS_URL 只能在 WORKER_IMPORT_TRANSFORMERS 內定義一次（辨識與說話者分割兩個 Worker 共用載入器）'],
    [/function importTransformers\b/g, 1, 'importTransformers 只能定義一次'],
    [/await import\(TRANSFORMERS_URL/g, 2, '動態 import Transformers.js 只能出現在 importTransformers（主 CDN＋備援 CDN 各一次）'],
    [/const SILERO_VAD_THRESHOLD\b/g, 1, 'SILERO_VAD_THRESHOLD 只能定義一次'],
    [/const RMS_VAD_THRESHOLD\b/g, 1, 'RMS_VAD_THRESHOLD 只能定義一次（Silero 的機率閾值與 RMS 的能量閾值語意不同，不可混用）'],
    [/getElementById\('p_vad_threshold'\)/g, 1, '#p_vad_threshold 只能在 audioChunkGenerator 讀取一次（它是 Silero 閾值，不可傳給 RMS 備援）'],
    [/function uvrCreateDsp\b/g, 1, 'uvrCreateDsp 只能定義一次（主執行緒測試與 UVR Worker 以 toString() 共用同一份 DSP）'],
    [/const UVR_WORKER_CODE\b/g, 1, 'UVR_WORKER_CODE 只能定義一次'],
    [/function encodeWavPcm16\b/g, 1, 'encodeWavPcm16 只能定義一次'],
    [/const ORT_SCRIPT_FILES\b/g, 1, 'ORT_SCRIPT_FILES 只能定義一次（VAD 與 UVR Worker 共用 ort 主檔名清單）'],
    [/releases\/download\//g, 0, 'index.html 不得使用 GitHub Release 下載網址（github.com 與 release-assets.githubusercontent.com 不回 CORS 標頭，瀏覽器 fetch 必定失敗）；UVR 模型用 Hugging Face 鏡像'],
    [/type: 'RUN_CHUNK'/g, 1, 'RUN_CHUNK 只能由 runChunkOnWorker 送出'],
    [/createElement\('script'\)/g, 1, '動態載入 script 標籤只能出現在 loadScriptOnce（JSZip／OpenCC／VAD 共用）'],
    [/--bg:#0a0a0a;/g, 1, '深色主題樣式字串只能出現一次（檔頭主題 script 為唯一來源，模組以 window._themeStyles 取用）'],
    [/--bg:#f4f4f0;/g, 1, '淺色主題樣式字串只能出現一次（檔頭主題 script 為唯一來源，模組以 window._themeStyles 取用）'],
    [/function normalizeDictEntry\b/g, 1, 'normalizeDictEntry 只能定義一次（手動新增、JSON 匯入、CSV／TSV 匯入共用）'],
  ];
  const errors = [];
  for (const [re, n, msg] of expect) {
    const got = count(re);
    if (got !== n) errors.push(`[check] ${msg}（預期 ${n} 處，實際 ${got} 處）`);
  }
  return { ok: errors.length === 0, errors };
}

/** r7：Cache Storage 以網域為單位。sw.js 的 activate 只能刪「自己前綴」的舊版快取，不可刪所有不等於 CACHE_NAME 的快取。 */
export function checkServiceWorkerCacheScope({ swPath = path.join(ROOT, 'sw.js') } = {}) {
  const sw = fs.readFileSync(swPath, 'utf8');
  const errors = [];
  if (!/const CACHE_PREFIX\s*=\s*'whisper-subtitler-'/.test(sw)) errors.push("[check] sw.js 須定義 const CACHE_PREFIX = 'whisper-subtitler-'");
  if (!/\.filter\(\(key\) => key\.startsWith\(CACHE_PREFIX\)\s*&&\s*key !== CACHE_NAME\)/.test(sw)) {
    errors.push('[check] sw.js 的 activate 只能刪除 CACHE_PREFIX 開頭且不等於 CACHE_NAME 的快取（同網域其他 PWA 共用 Cache Storage）');
  }
  return { ok: errors.length === 0, errors };
}

/** 全部檢查的唯一清單：`npm run check` 與 `npm run build` 共用，新增檢查只改這裡。
 *  （r4 以前 build.mjs 自己列了 2 項、check 指令列 4 項：違反單一來源守門的 index.html 照樣能建置出 dist。） */
export function runAllChecks() {
  const merged = [checkIconConsistency(), checkDefaultsConsistency(), checkNoWorkerMemoryApi(), checkSingleSources(), checkServiceWorkerCacheScope()];
  return { ok: merged.every((r) => r.ok), errors: merged.flatMap((r) => r.errors) };
}

// CLI 進入點：只有被直接執行時才跑，被 import 時不會自動觸發
if (import.meta.url === `file://${process.argv[1]}`) {
  const result = runAllChecks();
  if (!result.ok) {
    console.error(result.errors.join('\n'));
    process.exit(1);
  }
  console.log('[check] 一致性檢查通過');
}
