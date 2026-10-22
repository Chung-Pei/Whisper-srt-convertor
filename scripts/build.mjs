// scripts/build.mjs
// 一致性檢查（不通過即中止）→ 清空重建 dist/ → 算 3 段 <script> 的 CSP hash →
// 注入 CSP <meta>（插在 <meta charset> 之後、<head> 最前面）→ 自動產生 CACHE_VERSION（UTC）
// 並寫回 index.html／sw.js → 複製 manifest.json／icons/ → 輸出至 dist/。
// 純內建模組：fs、crypto、path、url。無外部依賴。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runAllChecks } from './check-consistency.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

// ── 1. 一致性檢查：不通過就中止，不產生任何 dist/ 輸出 ─────────────────────────
const checkResult = runAllChecks();   // 與 `npm run check` 同一份清單（5 項）
if (!checkResult.ok) {
  console.error(checkResult.errors.join('\n'));
  process.exit(1);
}

// ── 2. 清空重建 dist/（避免舊建置殘留檔案造成新的「對不上」問題）───────────────
fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

// ── 3. 讀 index.html，抓 3 段 <script> 區塊 ────────────────────────────────────
const indexHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const scriptRe = /<script\b[^>]*>([\s\S]*?)<\/script>/g;
const scriptMatches = [...indexHtml.matchAll(scriptRe)];

if (scriptMatches.length !== 3) {
  console.error(
    `[build] 預期 index.html 內恰好有 3 段 <script> 區塊，實際找到 ${scriptMatches.length} 段。` +
      `這通常代表有人新增/刪除了 <script> 卻未同步處理 CSP hash，已中止建置。`
  );
  process.exit(1);
}

// ── 4. 逐一取原始文字（不 trim）算 SHA-256 → base64 → 'sha256-<base64>' ───────
const hashes = scriptMatches.map(([, content]) => {
  const digest = crypto.createHash('sha256').update(content, 'utf8').digest('base64');
  return `sha256-${digest}`;
});

// ── 5. 組出完整 CSP 字串（3 個 hash 依出現順序代入）────────────────────────────
const csp = [
  `default-src 'none'`,
  // blob:：transformers.js 內建的 onnxruntime-web 建 WASM 後端時，會把 glue 模組（.mjs）做成 blob: URL 再動態 import()；
  // 缺少時 dist 版完全無法載入任何模型（no available backend found … Failed to fetch dynamically imported module: blob:）。
  // Worker 繼承文件的 CSP，所以頁面與 Whisper Worker 兩處都需要。仍不開放 unsafe-inline／unsafe-eval（tests/dist-csp.spec.ts TB-03 逐項比對）。
  `script-src 'self' 'wasm-unsafe-eval' blob: '${hashes[0]}' '${hashes[1]}' '${hashes[2]}' https://cdn.jsdelivr.net https://unpkg.com`,
  `worker-src 'self' blob:`,
  // connect-src blob:：downloadAllAsZip() 以 fetch(blob:) 讀取各字幕檔（實測缺少時批次 ZIP 失敗：Failed to fetch）
  // https://*.hf.co：HuggingFace 大檔案（ONNX 權重）由 huggingface.co 302 轉址到「地區性」CDN 主機（實測 us.aws.cdn.hf.co；
  // 另有 cdn-lfs*.hf.co、cas-bridge.xethub.hf.co），逐區列舉追不完；CSP 逐跳檢查轉址目標，缺少時模型下載在轉址那一跳失敗。
  // *. 通配只匹配 hf.co 的子網域（不匹配 nothf.co）；tests/dist-csp.spec.ts TB-04 以對照組鎖定。舊的 *.huggingface.co 保留以相容舊轉址。
  // r6：UVR 模型（Kim_Vocal_2.onnx）也從 huggingface.co 下載（Hallo 鏡像，SHA-256 與官方檔相同），所以不需要 github.com／githubusercontent.com——
  // 那些主機不回 CORS 標頭，開放了也無法 fetch；r5 以前為舊 UVR 設計留的三個 GitHub 主機一併移除（最小權限）。
  `connect-src 'self' blob: https://huggingface.co https://cdn-lfs.huggingface.co https://cdn-lfs-us-1.huggingface.co https://*.hf.co https://cdn.jsdelivr.net`,
  `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com`,
  `font-src https://fonts.gstatic.com`,
  // data:：index.html 的 body::before 使用 data:image/svg+xml 雜訊背景（實測 img-src 'self' 會被擋）
  `img-src 'self' data:`,
  // media-src：預覽面板的 <audio>/<video> 使用 blob: URL（實測缺少此指令時預覽面板會觸發 media-src 違規）
  `media-src blob:`,
  `manifest-src 'self'`,
  `base-uri 'none'`,
  `form-action 'none'`,
  `object-src 'none'`,
  `frame-src 'none'`,
].join('; ') + ';';

// ── 6. 產生新 CACHE_VERSION：UTC，'YYYYMMDD-HHmm' ──────────────────────────────
const iso = new Date().toISOString(); // e.g. '2026-09-28T12:34:56.789Z'
const datePart = iso.slice(0, 10).replace(/-/g, '');
const timePart = iso.slice(11, 16).replace(':', '');
const CACHE_VERSION = `${datePart}-${timePart}`;

// ── 7a. 插入 CSP <meta>：<meta charset="UTF-8"> 之後、<head> 最前面（非 </head> 前）──
const charsetLine = '<meta charset="UTF-8">\n';
const charsetOccurrences = indexHtml.split(charsetLine).length - 1;
if (charsetOccurrences !== 1) {
  console.error(
    `[build] 預期 index.html 內恰好有 1 個 '${charsetLine.trim()}'，實際找到 ${charsetOccurrences} 個。已中止建置。`
  );
  process.exit(1);
}
const cspMetaTag = `<meta http-equiv="Content-Security-Policy" content="${csp}">\n`;
let distIndexHtml = indexHtml.replace(charsetLine, charsetLine + cspMetaTag);

// ── 7b. <title>／subtitle 等人工維護的可讀版本字串不動（手術範圍外）──────────

// ── 8. sw.js：只換 CACHE_VERSION 的值，不動註解 ────────────────────────────────
const swJs = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
const cacheVersionRe = /const CACHE_VERSION = '[^']*';/;
if (!cacheVersionRe.test(swJs)) {
  console.error(`[build] 在 sw.js 內找不到 "const CACHE_VERSION = '...';"，已中止建置。`);
  process.exit(1);
}
const distSwJs = swJs.replace(cacheVersionRe, `const CACHE_VERSION = '${CACHE_VERSION}';`);

// ── 9. 寫入 dist/：處理後的 index.html／sw.js；manifest.json／icons/ 原樣複製 ──
fs.writeFileSync(path.join(DIST, 'index.html'), distIndexHtml, 'utf8');
fs.writeFileSync(path.join(DIST, 'sw.js'), distSwJs, 'utf8');
fs.cpSync(path.join(ROOT, 'manifest.json'), path.join(DIST, 'manifest.json'));
fs.cpSync(path.join(ROOT, 'icons'), path.join(DIST, 'icons'), { recursive: true });

// ── 10. 印出這次的 CACHE_VERSION 與 3 個 hash 值 ───────────────────────────────
console.log(`[build] CACHE_VERSION = ${CACHE_VERSION}`);
console.log(`[build] script hash 1 = ${hashes[0]}`);
console.log(`[build] script hash 2 = ${hashes[1]}`);
console.log(`[build] script hash 3 = ${hashes[2]}`);
console.log('[build] 完成，輸出於 dist/');
