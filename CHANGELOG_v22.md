# Whisper 離線字幕產生器 v21 → v22 升級紀錄

依 `whisper-srt-v22-implementation-spec-v2.md`（定案版）實作。v21 原檔保留未修改。

## 異動檔案
- `whisper-srt-v22.html`（第二輪：修正 4 項邏輯 bug＋2 項效率優化，見下方「第二輪」章節）
- `sw.js`：`CACHE_VERSION` → `20260926-2`
- `manifest.json`：無異動
- `tests/preview-panel.spec.ts`：Playwright 測試腳本，對應規格第 5 節案例 1–9
- `tests/fixtures/sample.mp4`、`tests/fixtures/sample.mp3`（新增）：以 ffmpeg 產生的真實測試素材（各 6 秒）

## 功能異動

### P0　簡繁正規化（opencc-js，預設開啟）
- 新增 `OPENCC_CDN`、`loadOpenCC()`（延遲載入，模式比照既有 `loadJSZip()`）、`applyOpenCC(subs)`
- `applyPostProcessing()` 改為 `async function`，於醫學詞典 / 模糊比對**之前**執行 opencc 轉換；呼叫端已加 `await`
- 新增 `tog_opencc` toggle（預設 checked），已納入 badge 計數陣列與 change 監聽註冊陣列
- **關閉時**：其餘後處理管線行為與 v21 完全一致（`if (cfg.opencc)` 包裹，不影響其他步驟）

### P1　新增模型選項（striimit WebGPU 相容測試版）
- 新增第 5 個模型按鈕 `striimit/whisper-large-v3-turbo-webgpu`，帶「🧪 實驗性」樣式
- **修正一處規格未預期的既有問題**：`isOnnxCommunity` 判斷（worker 內與 info box 提示各一處）原僅比對 `onnx-community/` 前綴，`striimit/` 模型不會命中，會被誤判為單一 dtype 的 Xenova 類模型。已擴充為同時比對兩個前綴，使新模型正確走分離式 encoder/decoder dtype 路徑
- WASM dtype 靜態備援 sizeMap 已加入該模型（1600MB）

### 字幕即時預覽面板
- 結果列表每個已完成項目新增「👁 預覽」按鈕，點擊展開/收合面板（存於 `item.previewOpen`）
- 面板內容：video（原生 `<video controls>`）或 audio（純色占位 + `<audio controls>`，不做波形視覺化）＋字幕疊圖層＋字級滑桿（12–48px，預設 24）＋垂直位置滑桿（0–100%，預設 88）＋格式限制提示
- `timeupdate` 同步疊圖文字；滑桿 `input` 即時更新疊圖 CSS；滑桿 `change`（放開時）觸發重新匯出（`regenerateItemOutput`），所見即所得
- 匯出樣式寫回：ASS 寫入 `Fontsize`/`MarginV`；VTT 寫入 cue `line:` 設定；SRT／TXT／MD 完全不寫入（僅預覽用）
- **未經預覽面板調整前，ASS/VTT 匯出與 v21 完全一致**（因初次匯出呼叫未帶樣式參數，函式在無 `opts` 時回退舊版硬編碼值）

## 需要使用者知悉的判斷與假設

1. **垂直位置滑桿方向**：v1 規格文件對「由下往上百分比」與「預設 88% 貼近下緣」的描述互相矛盾（若 88% 是由下往上量測，應接近頂端而非底部）。因定案版 v2 未重述此矛盾說法，僅給出範圍與預設值，故本次實作依「使用者實際看到的效果」決策：**滑桿值越大＝越貼近畫面下緣**（`bottom% = 100 − 滑桿值`），預設 88 對應 `bottom:12%`。如與您原本設想的方向相反，屬一行公式即可反轉的調整。

2. **`tog_opencc` 未使用 localStorage**：規格假設「納入 toggle 註冊陣列與 localStorage persistence」，但實測 v21 原始碼中**僅深色/淺色主題**使用 `localStorage`，其餘所有 toggle（含 `tog_fuzzy`／`tog_medical` 等）皆無持久化、每次重新載入頁面即回到 HTML 預設值。本次 `tog_opencc` 依實際既有慣例（而非規格文件的假設）實作，與其他 toggle 行為一致（不持久化）。

3. **重繪時機問題已於第二輪修正**（見下方「第二輪：窮舉式除錯審查」）。

## 第二輪：窮舉式除錯審查（karpathy-guidelines + systematic-debugging）

依使用者要求，對第一輪交付的 v22 進行窮舉式審查，確認根因後修正，並以真實瀏覽器（非僅 jsdom 模擬）重新驗證。

### 修正 1：重繪時機問題（第一輪發現但未修改，本輪修正）
**根因**：批次迴圈中，`qItem.dlUrl`／`dlFilename`／`savedToFolder` 的賦值發生在該項目自身觸發的 `setBatchItemStatus(id,'done')` 重繪**之後**。前 N-1 項目靠「下一項」的重繪順帶帶出正確狀態，但最後一項沒有下一項可以觸發重繪，迴圈結束後也沒有再呼叫 `renderBatchQueue()`。
**修正**：於批次迴圈結束、所有欄位皆已賦值完成後，明確補一次 `renderBatchQueue()`，確保每一項的下載圖示／預覽按鈕都反映最終狀態（修正時機點本身，而非為最後一項加特例）。

### 修正 2：`_speaker`（說話者標籤）在後處理管線中被靜默丟失
**根因**：`chunksToSubs`／`subsToChunks`（後處理管線 chunks↔subs 邊界轉換函式）僅保留 `index/start/end/text`，其餘所有轉換函式（`mergeShortLines`、`applyOpenCC`、`applyMedicalDict`…）皆以物件展開語法（`{...s, ...}`）正確保留額外欄位，**唯獨這兩個邊界函式沒有**。
**影響範圍**：只要同時開啟「說話者分割」與**任一**後處理選項（合併、簡繁正規化、醫學詞典…），最終輸出的 SRT 就會遺失全部說話者標籤，即使 `chunksToSrtWithSpeakers()` 仍被正確呼叫。
**修正**：`chunksToSubs`／`subsToChunks` 皆改為在 `_speaker` 存在時一併攜帶。

### 修正 3：編輯器「套用編輯」獨立維護另一套格式判斷，未同步支援說話者標籤
**根因**：`applyEditorChanges()`（單檔模式手動編輯器的匯出邏輯）是與主要匯出點（`processFile` 內）**各自獨立維護**的第二套「格式→匯出函式」判斷式，從未考慮 `chunksToSrtWithSpeakers`。修正 2 讓 `_editorChunks` 開始正確攜帶 `_speaker` 後，此處若不同步修正，等於把問題從「管線丟失」變成「編輯器覆寫時丟失」。
**修正**：`applyEditorChanges()` 的 SRT 分支改為依資料本身是否含 `_speaker` 決定使用 `chunksToSrtWithSpeakers` 或 `chunksToSrt`（不含說話者標籤時行為與修正前完全一致，純加法、無回歸風險）。

### 修正 4：預覽面板「即時重新匯出」對 SRT/TXT/MD 的處理違反規格且有資料退化風險
**根因**：`regenerateItemOutput()`（滑桿放開時觸發）先前對所有 5 種格式都會重新產生內容並覆蓋 `item.dlUrl`。但規格明訂 SRT/TXT/MD「不支援樣式資訊…不會寫入匯出檔案」，滑桿調整本就不影響這三種格式的輸出——重新產生不僅是**沒有意義的運算浪費**，SRT 分支更會呼叫不含說話者標籤的 `chunksToSrt`，若原始匯出是靠 `chunksToSrtWithSpeakers` 產生（開啟說話者分割時），使用者只要打開預覽面板拖動任一滑桿，就會**靜默把已下載連結換成遺失說話者標籤的版本**。
**修正**：`regenerateItemOutput()` 現在只在格式為 ASS 或 VTT 時才重新產生內容，SRT/TXT/MD 完全不觸碰 `item.dlUrl`，維持原始匯出（含說話者標籤）不變。

### 效率優化
- `findActiveChunkText`（`timeupdate` 高頻觸發，通常每秒數次）：由每次從頭線性掃描全部字幕（O(n)）改為二分搜尋（O(log n)）。chunks 恆依時間排序（Whisper 原生輸出＋所有後處理轉換函式皆保序），故二分搜尋安全可靠。
- `updatePreviewOverlayStyle`／`updatePreviewNotice`：原本每次呼叫都重新 `querySelector` 疊圖層／提示區塊元素，而這兩個函式會在滑桿 `input`（拖曳時連續觸發）與 `timeupdate`（播放時連續觸發）中被呼叫。改為在面板綁定事件時查詢一次並快取元素參照，往後重複使用。

### 死碼／孤兒碼審查
逐一確認本次新增的所有函式（`loadOpenCC`、`applyOpenCC`、`togglePreviewPanel`、`findActiveChunkText`、`buildPreviewPanel`、`updatePreviewOverlayStyle`、`updatePreviewNotice`、`bindPreviewPanelEvents`、`regenerateItemOutput`、`getPreviewFormatNotice`、`getPreviewBottomPct`）皆確實被呼叫，無孤兒函式；確認上一輪的 listener 清理機制（`_previewNoticeCleanups`）已是正確的最終版本，無殘留死碼。額外檢查了「格式→副檔名」「模型 ID→dtype」等清單是否有第三處未同步維護的重複邏輯，確認沒有。（另發現一處**已知但刻意不修改**的重複維護模式：字幕結束時間 fallback 公式 `timestamp[1] ?? timestamp[0]+2` 在 6 處以完全相同的寫法重複出現——目前所有出現處皆一致、未發生「跑掉」，屬理論上的維護風險而非已發生的 bug，且多數出自不在本次修改範圍內的既有函式，故未大動干戈抽成共用函式，僅在此記錄供您評估是否要在未來重構。）

## 測試（第二輪：改用真實瀏覽器）

第一輪誤以為沙盒無法執行 Playwright；本輪複查後發現 **Chromium 其實已預先安裝**在 `/opt/pw-browsers/`（`PLAYWRIGHT_BROWSERS_PATH` 環境變數指向該處），只是需要加上 `--no-sandbox`（容器內以 root 執行的常見必要參數）才能啟動。故本輪已改用**真實 Playwright + Chromium**，並以 `ffmpeg` 產生真實的模擬測試素材（`sample.mp4`、`sample.mp3`，各 6 秒）。

| 項目 | 方法 | 結果 |
|---|---|---|
| 三個 `<script>` 區塊語法 | `node --check` | 全部通過 |
| 既有全套第一輪測試回歸 | 重新執行 opencc-js／`chunksToAss`/`chunksToVtt`／DOM 整合／預覽面板 14 項／即時重新匯出，共 7 個測試檔 | 全部通過，無回歸 |
| 本輪 5 項修正專項測試（jsdom） | 19 項斷言：重繪時機重現與修正、`_speaker` 保存、編輯器說話者感知（含「不含說話者時行為不變」對照組）、`regenerateItemOutput` 對三種格式的 no-op 驗證、二分搜尋含邊界案例 | 全部通過 |
| **真實瀏覽器**：頁面載入 | Playwright + 真實 Chromium，監聽 `console.error`／`pageerror`／`requestfailed` | 無應用程式錯誤（唯一的資源載入失敗是沙盒網路白名單不含 `fonts.googleapis.com` 導致的 Google Fonts 403，非應用程式問題，正式環境可正常載入） |
| **真實瀏覽器**：UI 與真實 CSS | 標題／`tog_opencc`／5 個模型按鈕／預覽面板展開／`getComputedStyle` 讀取真實字級與位置／格式提示真實 class 切換／audio 占位真實背景色 | 全部通過（非僅字串斷言，而是瀏覽器實際算出的樣式值） |
| **真實瀏覽器**：本輪修正項目 | 以 `page.evaluate()` 注入測試資料並呼叫真實頁面內部函式（透過測試專用 hook，見下方說明），驗證 8 項修正 | 全部通過 |

**關於測試 hook**：為了在 Playwright 中呼叫 ES module（`<script type="module">`）內部的私有變數（如 `batchQueue`），額外建立了 `whisper-srt-v22-test-instrumented.html`——僅比 `whisper-srt-v22.html` 多了一段 `window.__test = {...}` 的測試專用暴露程式碼，**此檔案僅存在於測試環境，不會出現在交付的 zip 封裝中**。

## 第三輪：穿透式審查（karpathy-guidelines + systematic-debugging）

依使用者要求做更深一層的「穿透式」審查。這輪對「同一段邏輯各自維護」的搜尋擴大到全檔案範圍（非僅本次修改處），並新增真實瀏覽器視覺層級的檢查。

### 全檔案範圍掃描（非僅本次改動處）
以程式化方式掃描整份檔案：
- **126 個頂層函式**：逐一確認皆被呼叫或以參照方式使用（如 `addEventListener('click', fn)` 這種不帶括號的傳遞方式），**無孤兒函式**。
- **145 個 CSS class**：逐一確認皆被使用（含動態組合的 class，如 `'log-' + type`），**無死 CSS**。掃描過程中出現的 `.org`／`.w3` 為 regex 誤判（其實是 SVG data URI 裡 `www.w3.org` 網址的一部分，非 CSS class），已排除。
- **`log()` 呼叫的 60 處 type 參數**：全數落在合法集合 `{ok, warn, err, info}` 內，無拼字或型別不一致風險。
- 發現 `modelFolderHandle` 以 `let` 宣告兩次，追查後確認一處在主執行緒、一處在 `WORKER_CODE` 樣板字串內（等同獨立的 Worker 執行環境自己的狀態），本非同一作用域，並非真的重複宣告——`node --check` 全程通過本身即是此推論的佐證（若為同一作用域重複宣告會是語法錯誤）。

### 新發現並修正的問題（真實瀏覽器視覺層級）
這兩項純靠讀程式碼不易發現，是實際在瀏覽器算出 computed style 後才確認的：

1. **對比度問題**：預覽面板疊圖文字色固定為白色（`color:#fff`），影片模式沒問題（背景恆為畫面內容或 `#000`），但音訊模式依規格使用主題色 `--panel2` 作為純色背景，淺色主題下 `--panel2` 為 `#eeeeea`（近乎白色），白字對比不足。修正：音訊模式改用與 `--panel2` 搭配設計的 `--text` 主題色（深淺主題下皆為對比配色）。
2. **版面重疊問題**：位置滑桿的計算方式（值越大越貼近下緣）在使用者將其拉到接近 100 時，疊圖文字的 `bottom` 會趨近 0，音訊模式下會與原生 `<audio>` 控制列（固定於 `bottom:6px`）重疊。修正：改用 CSS 自訂屬性 `--preview-bottom-pct` 承載滑桿換算值，音訊模式額外套用 `max(var(--preview-bottom-pct), 44px)` 作為下限，確保任何滑桿數值下都不會蓋住控制列；影片模式不受影響（無固定控制列重疊疑慮，行為與之前完全一致）。

兩項修正皆已在**真實 Chromium**（非 jsdom）中以 `getComputedStyle()`／`boundingBox()` 實際量測像素驗證：影片模式 88% 精確對應容器高度 12%（誤差 <5px）；音訊模式極端值下實測疊圖距底部恰為 44px 下限（而非貼底 0px）；音訊模式文字色確認已由白色改為主題文字色。

### 效率與其他優化
本輪逐一檢視批次處理迴圈、`downloadAllAsZip`（讀取當下 `item.dlUrl` 而非快取內容，與滑桿即時重新匯出功能天然相容，無需額外處理）、模型按鈕事件綁定（`querySelectorAll` 動態綁定、無寫死索引，新增第 5 顆按鈕不受影響）、斷點續傳／IndexedDB 恢復流程（走與一般上傳相同的 `addFilesToBatch` 路徑，不會繞過本次所有修正），確認均無額外的邏輯風險或效能問題，故本輪未變更這些既有程式碼。

## 測試（第三輪）

| 項目 | 方法 | 結果 |
|---|---|---|
| 語法檢查 | `node --check`（三個 script 區塊） | 全部通過 |
| jsdom 全套回歸（7 個測試檔，含前兩輪全部案例） | 因 `overlay.style.bottom` 改為 CSS 自訂屬性，同步更新 2 處斷言 | 全部通過，無回歸 |
| 真實瀏覽器：既有 3 份測試（UI／修正 1-5／CSS 變數重構） | Playwright + 真實 Chromium | 全部通過 |
| 真實瀏覽器：本輪 2 項新修正 | 實測 `boundingBox()` 像素距離、`getComputedStyle().color` | 全部通過（見上方數據） |

累計至今三輪共發現並修正 **6 個真實邏輯／視覺 bug**（重繪時機、`_speaker` 遺失×2 處、預覽面板誤觸發重新匯出、對比度不足、控制列重疊），外加 2 項效率優化（二分搜尋、DOM 參照快取），全程未發現孤兒碼或死碼殘留。

`tests/preview-panel.spec.ts`（規格第 5 節 9 項案例）與 `tests/fixtures/sample.mp4`／`sample.mp3` 已一併封裝，可直接 `npm install -D @playwright/test && npx playwright test` 執行（需自行啟動本機伺服器並調整 `WHISPER_TEST_URL`）。

---

## 第四輪（v22 → v22.1，2026-09-26，獨立穿透式覆核）

本輪由另一次獨立稽核執行，未預先信任前三輪任何結論，逐項重新以實際執行取證（語法檢查、
自動交叉比對、原始碼追蹤、Node.js 行為比對測試、真實 Playwright + Chromium 頁面/函式測試）。

### 覆核前三輪既有結論（全數獨立驗證屬實）
- 語法：以真實插值取代 `${...}`（`HF_TRANSFORMERS_VERSION`、`ORT_WEB_CDN`、`UVR_N_FFT` 等）後，
  主執行緒 + 3 個 Worker 樣板字串共 4 段程式碼 `node --check` 全數通過
- 頂層函式：126 個，全數在宣告以外至少再被引用一次，無孤兒函式
- CSS：141 個 class 選擇器，`log-err/log-info/log-ok/log-warn` 4 個經追蹤確認為 `'log-' + type`
  動態組成（非孤兒，靜態掃描的合理偽陽性）
- 無 TODO/FIXME/`console.log`/`debugger`/整段被注解的死碼
- 前三輪聲稱修正的 6 項 bug（重繪時機、`_speaker` 遺失×2、預覽面板誤觸發重新匯出範圍、
  `isOnnxCommunity` 前綴、DOM 參照快取、二分搜尋）逐一回到原始碼比對，確認實際存在且正確
- `modelFolderHandle` 於主執行緒與 `WORKER_CODE` 各宣告一次：確認為兩個獨立 Worker 全域作用域
  （worker 透過 `postMessage` 接收後設定自己的本地變數），非真正重複維護，非 bug

### 本輪新發現並修正：殘存的「同一段邏輯各自維護」風險（使用者關切項目 1）
前三輪已注意到但**選擇不修正**的一處風險，本輪判定風險已實際發生局部分歧、非僅理論風險，予以修正：

- **問題**：字幕結束時間 fallback 公式 `c.timestamp[1] != null ? c.timestamp[1] : c.timestamp[0] + 2`
  （缺 end 時退回 start+2 秒）＋ `Math.max(rawEnd, start+epsilon)`（避免零/負長度字幕）在
  `chunksToSrt`、`chunksToVtt`、`chunksToMarkdown`、`chunksToAss`、`chunksToSubs` 共 **5 處**各自手動維護。
  非「完全相同」：`chunksToMarkdown` 已出現變數改名為 `rawEnd2`（複製貼上痕跡），`chunksToAss`
  epsilon 為 0.01（配合 ASS 百分秒精度，正確但寫法各自獨立維護），`chunksToSubs` 結構又不同。
  日後若調整最小長度容許值，極易只改到部分函式、遺漏其他處，屬靜默、不易察覺的迴歸風險。
- **修正**：抽出共用函式 `resolveChunkEnd(c, minGap = 0.001)`，5 處呼叫點改為
  `resolveChunkEnd(c)` 或 `resolveChunkEnd(c, 0.01)`（ASS 專用），單一函式集中維護公式本身；
  `findActiveChunkText`（二分搜尋用途不同，不需 epsilon）與編輯器「新增列」邏輯
  （`last.timestamp[1] ?? last.timestamp[0]+2`，情境不同）經個別確認後維持原樣，未一併合併。

### 驗證方式與結果（實際執行證據）
1. **語法**：修改後重新萃取主執行緒 script，`node --check` 通過；3 個 Worker 樣板字串重新萃取
   （含真實插值），逐一 `node --check` 通過，行數與修改前完全一致（確認未誤觸worker內容）
2. **行為保留測試（Node.js）**：抽出修改前後版本的 8 個純函式（`resolveChunkEnd`、`fmtTime`、
   `fmtTimeVtt`、`chunksToSrt`、`chunksToVtt`、`chunksToMarkdown`、`chunksToAss`、`chunksToSubs`），
   針對 8 組邊界情境（正常值、缺 end timestamp、近零間距、含說話者標籤、空陣列、小數時間戳、
   零長度、end < start 之異常資料）逐一比對修改前後輸出，**全數逐字元相同**
3. **真實瀏覽器測試（Playwright + Chromium，`/opt/pw-browsers`，`--no-sandbox`，非模擬）**：
   - 頁面載入：0 個 `pageerror`、0 個非預期 console error、0 個非預期 failed request
     （唯一 blocked 請求為 Google Fonts，因沙盒網路白名單不含 `fonts.googleapis.com`，與程式碼
     邏輯無關，前三輪已知同一現象）
   - UI 結構：title/subtitle 正確顯示 v22.1、5 個模型按鈕、`#tog_opencc` 存在、
     實驗性 `striimit/` 模型按鈕存在
   - 以暫時性測試掛鉤（`window.__test = {...}`，**未包含於最終交付檔案**）在真實頁面內直接呼叫
     修改後的實際函式（非另外抽取的副本），同一組 8 個邊界情境測試，輸出與 Node.js 版本完全一致，
     並確認 ASS 的 0.01 epsilon 與其餘格式的 0.001 epsilon 在真實瀏覽器執行結果中正確區分
4. **既有 `tests/preview-panel.spec.ts`（案例 1–9）**：本輪確認 Playwright 本身可在本沙盒真實執行
   （推翻該檔案標頭舊註解「本沙盒無法執行 Playwright」之說法，已一併更正），但案例 1–9 需實際
   上傳音檔、下載 Whisper 模型並完成推論，模型 CDN（`cdn.jsdelivr.net`／`unpkg.com`）不在本沙盒
   網路白名單內，故此 9 案例本輪仍**無法端對端執行完成**，需使用者本機或一般網際網路存取的 CI
   環境執行；已同步修正該檔案標頭註解（原文誤導）與 `BASE_URL` 預設值（`v22.html`→`v22.1.html`）

### 效能／優化
- 除上述 `resolveChunkEnd` 抽取（減少 5 處重複程式碼、降低未來調整遺漏風險）外，本輪未發現
  其他具體、可驗證的效能瓶頸或優化空間；`findActiveChunkText` 二分搜尋、DOM 參照快取等既有
  優化維持不變，未重複投入未經證實效益的重構

### 異動檔案（第四輪）
- `whisper-srt-v22.html` → 重新命名為 `whisper-srt-v22.1.html`；`<title>`／`<p class="subtitle">`
  版本字串同步更新為 v22.1；抽出 `resolveChunkEnd()`，5 處呼叫點同步替換
- `sw.js`：`CACHE_VERSION` → `20260926-3`
- `manifest.json`：無異動
- `tests/preview-panel.spec.ts`：更正標頭過時說明（Playwright 可執行 vs. 端對端案例受 CDN
  白名單限制）；`BASE_URL` 預設值同步新檔名

---

## 第五輪（v22.1 → v22.2，2026-09-26，穩定性／實用性／執行效率專項覆核）

使用者要求明確確認最終版本是否已達「穩定性、實用性、執行效率」最佳化水準；若未達成則修正，
並要求修正後以真實 Playwright/Chromium 配合生成的模擬檔案實測。本輪即針對此三項重新審查
（前四輪聚焦於邏輯正確性與孤兒碼，未系統性檢查這三項），發現並修正 **2 個真實 bug**。

### 系統性檢查範圍
`createObjectURL`/`revokeObjectURL`、`addEventListener`/`removeEventListener`（65 vs 24，逐一分類：
9 處 `worker.addEventListener('message', handler)` 型態經檢查全數在成功／失敗／逾時三路徑皆有對應
`removeEventListener`，非洩漏）、`setInterval`/`clearInterval`、`requestAnimationFrame`（2 處皆為
一次性延遲執行，非迴圈動畫，不需 `cancelAnimationFrame`）、`renderBatchQueue()` 呼叫頻率（確認與
高頻的 `setProgress()` 完全解耦，只在狀態轉換時觸發，非每次進度更新都重繪整個列表）、
Diarization Worker 模型是否跨批次重複載入（worker 內 `loadModels()` 已有
`if (processor && model) return;` guard，主執行緒逐檔重送 `LOAD` 訊息僅為廉價 no-op，非真正重載）。

### 發現並修正的問題

**1. 記憶體監控橫跨批次時提早停止（穩定性／實用性）**
`startMemMonitor()` 僅於整個批次開始前呼叫一次（`startBtn` 點擊處理常式），但
`stopMemMonitor()` 卻寫在單一檔案處理函式 `runInference()` 自己的 `finally` 區塊內——每處理完
**一個**檔案就會被呼叫一次且未再重啟。對批次中的第 2 個以後的檔案，記憶體監控列會靜默停止更新／
隱藏，而這正是 v22 主打的「動態記憶體調適」功能的核心可視化元件，對多檔案批次（此工具的主要使用
情境）而言等同該功能只對第一個檔案有效。
修正：移除 `runInference()` 內的 `stopMemMonitor()`；於批次層級既有的
`} finally { // ── 無論正常完成、取消或例外，都確保釋放 Wake Lock 並還原 UI ── }`
區塊中，與 `releaseWakeLock()` 同層級新增一次 `stopMemMonitor()`，使其生命週期正確對應
「整個批次」而非「單一檔案」。

**2. `startBtn` 快速連點／誤觸雙擊競態條件（穩定性）**
點擊處理常式為 `async`，`isRunning = true` 雖已在 `await acquireWakeLock()` 之前同步賦值，但
**缺少對 `isRunning` 的重入檢查**，且 `startBtn.disabled = true` 要到 `await acquireWakeLock()`
**之後**才設定。快速連續點擊（或觸控裝置誤觸雙擊）會在第一次點擊仍卡在
`await acquireWakeLock()` 期間，讓第二次點擊也通過檢查並完整重跑一次批次迴圈——同一檔案被兩個
併行迴圈同時送入 Worker（`LOAD_MODEL`／`RUN_CHUNK` 重複觸發）、`_memMonitorTimer` 被覆寫導致原計
時器永久洩漏、`inferenceWorker` 共用變數在兩迴圈間互踩。
修正：於處理常式最頂端（早於 `pendingItems` 計算）新增 `if (isRunning) return;`。因
`isRunning = true` 已在原程式碼中位於第一個 `await` 之前同步執行，此單行檢查即可完整堵住競態
窗口（JS 事件迴圈保證：第二次點擊的處理常式要開始執行，前提是第一次點擊已讓出控制權，此時
`isRunning` 必已為 `true`），故修正為最小幅度變更，未變動其餘 UI 停用邏輯的時序。

### 驗證方式與結果（真實 Playwright + Chromium，非模擬，使用本輪以 ffmpeg 生成的模擬音檔）
以 `ffmpeg -f lavfi -i "sine=..."` 生成 2 個真實 WAV 檔（3 秒／4 秒正弦波）作為批次測試素材。
測試方法：僅替換全域 `window.Worker` 為假實作（回應 `LOAD_MODEL`→`MODEL_READY`、
`RUN_CHUNK`→`CHUNK_DONE` 並附上模擬 `chunks`），**其餘全部為未修改的真實程式碼**
（真實 `startBtn` click handler、真實 `runInference()`、真實 `decodeAudio()`
以瀏覽器原生 `AudioContext.decodeAudioData()` 解碼真實 WAV 檔、真實
`startMemMonitor`/`stopMemMonitor`），驅動整個批次真正跑過 2 個檔案：

| 測試 | 修正前（v22.1，對照組） | 修正後（v22.2） |
|---|---|---|
| 記憶體監控於檔案 1 完成、檔案 2 仍處理中時是否仍在運作 | `false`（已停止，重現 bug） | `true`（正確持續） |
| 記憶體監控於整個批次結束後是否已停止 | `true`（但停止時機錯誤：其實早於檔案2就停了） | `true`（正確，且時機對） |
| 快速雙擊 `startBtn` 後，`LOAD_MODEL` 訊息送出次數（單一檔案批次） | **2**（重現競態，同檔案被處理兩次） | **1**（guard 正確擋下第二次） |

過程中的方法論修正：最初以 log 文字中「開始辨識：xxx」出現次數作為雙擊測試訊號，於修正後版本
顯示「1 次」看似通過；但同一測試套在**修正前**版本也顯示「1 次」——追查後發現該訊號本身有瑕疵：
第二次點擊執行到 `logBox.innerHTML = ''` 時，會把第一次點擊已寫入的「開始辨識」記錄清空，導致
即使重複處理真實發生，畫面上也只殘留一筆記錄（誤判為通過）。改以攔截 `Worker.postMessage()` 計數
`LOAD_MODEL` 呼叫次數作為訊號後，才在對照組（修正前）正確重現出「2 次」，確認先前的測試方法本身
不具鑑別力、已更正。三項測試最終於修正前／修正後版本得到正確且不同的結果，過程零 `pageerror`。

### 未發現需修正之處（已檢查，維持現狀）
- 9 處 `worker.addEventListener('message', handler)` 型態：全數在成功／失敗／逾時路徑正確配對
  `removeEventListener`，非洩漏
- `renderBatchQueue()` 完整重繪列表（非增量更新）：呼叫頻率已與高頻進度更新解耦，僅於狀態轉換時
  觸發（每檔案 2–3 次），批次規模下非效能瓶頸，未見有 ROI 的優化空間
- Diarization Worker 逐檔重送 `LOAD` 訊息：worker 內已有已載入guard，僅為廉價 no-op，非真正重載
- UVR Worker 每檔案結束即 terminate（下次重建 ~5–10s）：註解已載明這是刻意的記憶體／速度權衡
  （立即釋放 ~100MB），非疏漏，予以保留

### 異動檔案（第五輪）
- `whisper-srt-v22.1.html` → 重新命名為 `whisper-srt-v22.2.html`；`<title>`／`<p class="subtitle">`
  版本字串同步更新為 v22.2；`stopMemMonitor()` 由 `runInference()` 移至批次層級 `finally`；
  `startBtn` click handler 頂端新增 `if (isRunning) return;` 重入防護
- `sw.js`：`CACHE_VERSION` → `20260926-4`
- `manifest.json`：無異動
- `tests/preview-panel.spec.ts`：`BASE_URL` 預設值同步新檔名（`v22.1.html`→`v22.2.html`）

---

## 第六輪（v22.2 → v22.3，2026-09-26，發布/部署就緒度專項覆核）

使用者提出第二個問題：是否已達「可作為程式碼釋出模板和 GitHub 部署版本」水準。本輪專門針對
此點覆核（前五輪聚焦程式邏輯正確性，從未檢查部署層面），發現 **1 個嚴重、已用真實瀏覽器證實
會導致 PWA 離線功能完全失效的部署性 bug**，並補齊發布為公開 repo 所需的基本文件。

### 發現並修正的問題

**1.（嚴重）Service Worker 安裝於「文件自述的標準部署方式」下會直接失敗**
`sw.js` 的 `APP_SHELL` 清單包含 `${BASE}/index.html` 與 `${BASE}/icons/*.png`（4 個圖示檔），
但交付的套件裡：(a) 主程式檔名為 `whisper-srt-v22.2.html`，從未有 `index.html`；(b) 整個套件
**沒有 `icons/` 目錄**，4 個圖示檔案一個都不存在。`cache.addAll()` 只要清單中任一 URL 回應 404
就會整體失敗（`sw.js` 自己的程式碼與註解也明確記載此行為），導致 `install` 事件的 `waitUntil`
被 reject，Service Worker 直接進入 `redundant` 狀態，永遠無法啟用——等於 PWA 離線支援、
Service Worker 快取策略全部失效，且完全符合 `sw.js` 註解中自己說明的「根目錄部署（GitHub Pages
root）」情境，並非邊緣案例。

另外同時發現**同一組圖示檔名在三個檔案裡各自維護、彼此不一致**（與使用者先前關切的「同一段邏輯
各自維護導致跑掉」同一類問題，這次出現在部署設定而非程式邏輯）：
`manifest.json` 用 `apple-touch-icon-180x180.png`；`index.html` 的
`<link rel="apple-touch-icon">` 卻用 `icon-180.png`；`sw.js` 的 `APP_SHELL` 也用 `icon-180.png`
（且未包含 `manifest.json` 要求的 `icon-192-maskable.png`）。

修正：
- 以 Pillow 產生原創、簡潔的 4 個圖示檔（192／192 maskable／512／180 apple-touch，深色背景
  配合 `manifest.json` 既有 `theme_color #00e5a0`／`background_color #0a0a0a`，maskable 版本
  已預留安全邊界），置於新增的 `icons/` 目錄
- 統一三處圖示檔名為 `manifest.json` 現有宣告（`icon-192.png`、`icon-192-maskable.png`、
  `icon-512.png`、`apple-touch-icon-180x180.png`），修正 `index.html` 的 `<link>` 與 `sw.js` 的
  `APP_SHELL`
- 於 `sw.js` `APP_SHELL` 上方新增註解，明確指出此清單須與另外兩處完全一致、404 會導致的後果，
  降低未來再次因分開維護而跑掉的風險
- 主程式檔名由 `whisper-srt-v22.2.html` 重新命名為 **`index.html`**（不再每輪遞增檔名）：
  GitHub Pages 根目錄部署預期網站根目錄有 `index.html`；`sw.js`／未來各輪均無需再為了對齊
  進版而編輯 `APP_SHELL` 裡的主檔名，版本資訊改由 `<title>`／subtitle 文字與 `CACHE_VERSION`
  承載（此為本輪之後才成立的新慣例，之前四輪的既有檔名歷史紀錄不回溯更動）

### 驗證方式與結果（真實 Playwright + Chromium，非模擬）
以真實 HTTP 伺服器完整部署修正前／修正後兩個版本目錄，各自以 `navigator.serviceWorker.register()`
實際註冊、追蹤 Service Worker 狀態轉換：

| | 修正前（對照組，原樣部署） | 修正後（v22.3） |
|---|---|---|
| SW 狀態轉換 | `installing → redundant`（安裝失敗） | `installing → installed → activating → activated`（完整成功） |
| Cache 內容 | 已建立但 **0 筆**（`addAll` 中途失敗） | **7 筆全數快取成功**：`/`、`/index.html`、`/manifest.json`、4 個圖示 |
| `manifest.json` 解析 | 可解析，但宣告的 4 個圖示皆 404 | 可解析，4 個圖示皆可實際下載 |

修正後另重跑第四、五輪既有的迴歸測試（記憶體監控橫跨批次、`startBtn` 雙擊防護）於重新命名後的
`index.html`，結果與前一輪一致（記憶體監控於檔案 2 處理中仍為 `true`；雙擊後 `LOAD_MODEL`
僅送出 1 次），確認檔名變更未影響既有邏輯修正。

### 新增：發布為公開 repo 所需的基本文件
- **`README.md`**：專案說明、功能清單（逐項核對原始碼確認存在，非憑印象列出）、需求、本機執行、
  GitHub Pages 部署步驟（含 `CACHE_VERSION`／三處圖示檔名須同步的提醒）、測試方式、專案結構、
  隱私說明
- **`.gitignore`**：`node_modules/`、Playwright 測試產物、常見作業系統／編輯器暫存檔
- **License：尚未加入，刻意保留待使用者決定**——授權條款選擇涉及使用者對自身專案的實質法律
  決策，非本輪應代為決定之事項，已於 README 明確標註待辦，未擅自附加任何授權條款文字

### 異動檔案（第六輪）
- `whisper-srt-v22.2.html` → 重新命名為 `index.html`；`<title>`／subtitle 版本字串更新為 v22.3；
  `<link rel="apple-touch-icon">` 檔名修正
- `sw.js`：`CACHE_VERSION` → `20260926-5`；`APP_SHELL` 圖示檔名修正並補上遺漏的 maskable 圖示；
  新增一致性提醒註解
- `icons/`（新增目錄）：4 個原創產生的圖示檔
- `README.md`（新增）、`.gitignore`（新增）
- `tests/preview-panel.spec.ts`：`BASE_URL` 預設值與說明註解同步新檔名（`index.html`）

---

## 第七輪（v22.3 → v22.4，2026-09-26，窮舉式審查）

使用者要求「窮舉式」（而非先前各輪的「穿透式」）審查，對同樣兩個問題（穩定性/實用性/執行效率、
發布模板/GitHub 部署就緒度）做更全面覆蓋，而非僅追查最高風險路徑。

### 審查範圍（本輪新增，先前各輪未系統性覆蓋）
- 39 個主執行緒頂層 `async function`：逐一自動化檢測是否有 try/catch 保護、有多少 `await`，
  再對篩選出「無 try 但有 await」的 10 個函式逐一人工追查呼叫端是否有妥善處理
- 全檔案 3 處 `.then(` 鏈：逐一確認是否配對 `.catch(`
- 24 個 `.addEventListener('click', ...)` 點擊處理常式：抽查未於前幾輪檢查過的
  `downloadAllAsZip`、`btnPickModelFolder`、`btnPickOutFolder`、`btnSaveToFolder`、
  斷點續傳橫幅按鈕等
- 字幕後處理管線（`mergeShortLines`／`fixOverlaps`／`fixShortDuration`／`detectHallucinations`）
  是否有隱藏的巢狀迴圈 / 二次方複雜度風險
- 無障礙（accessibility）：`aria-label` 使用量、純圖示按鈕是否僅靠 `title`
- 發布就緒度加項：`<html lang>`、favicon、meta description、Open Graph、CSP

### 發現並修正的問題

**1.（次要，防禦性）`chooseDtype(...).then()` 缺少 `.catch()`**
3 處 `.then(` 鏈中，2 處已正確配對 `.catch()`（storage quota 估算、SW 註冊），僅此 1 處遺漏。
追查後確認：目前程式碼路徑下 `chooseDtype()` 實際上不會 reject（其內部呼叫的
`_dtypeViaRegistry()` 已有自己的 `try/catch` 吞掉所有錯誤並回傳 `null`），故此非可重現的當前
bug，而是防禦性缺口——若未來改動使 `_dtypeFallback()` 或函式內的 `log()` 意外拋錯，會在此處
產生未處理的 promise rejection。已補上 `.catch()`，失敗時顯示明確的降級文字而非讓 UI 停留在
「查詢中…」或靜默無反應。

**2.（無障礙／發布就緒度）3 處純圖示按鈕僅靠 `title`、無 `aria-label`**
批次項目移除鈕、字典移除鈕、編輯器逐段刪除鈕皆為單一「✕」符號，僅有滑鼠 hover 用的 `title`
屬性（螢幕報讀軟體支援不一致，且對鍵盤/觸控使用者無效）。已為全部 3 處補上對應 `aria-label`。

**3.（發布就緒度）缺少 `<meta name="description">` 與 Open Graph 標籤**
已補上，內容直接沿用 `manifest.json` 既有的 `description` 欄位文字（避免又產生第 4 份各自維護
的說明文字副本）；未加入 `og:image`，因目前無實際截圖/預覽圖可引用，不虛構不存在的圖檔路徑。

### 審查後判斷維持現狀、未修改之處

- **Content-Security-Policy**：評估後決定本輪不加入。本專案為單一自包含 HTML 檔（無建置流程），
  3 個 `<script>` 區塊與整段 `<style>` 皆為 inline；若要有意義的 CSP（不含 `'unsafe-inline'`），
  需採 hash-based（`script-src 'sha256-...'`），但這代表**每次修改 JS/CSS 內容都必須重新計算並
  同步更新 CSP hash**——恰好是本次一系列審查一路在抓、在修的「同一份資訊分開維護、容易跑掉」
  同一類風險，且此處後果更嚴重（算錯或忘記更新 = 整個 app 的 inline script 被自己的 CSP 擋下，
  白畫面）。含 `'unsafe-inline'` 的 CSP 雖不會擋到自己，但也幾乎不提供其設計目的（防 XSS）的
  實質保護，只是自我感覺良好。在目前「純靜態單檔、無建置管線」的架構下沒有低風險的加法，故不
  加入，留待專案未來若導入建置流程（可自動算 hash／nonce）時再處理，優於現在草率加一個要嘛無效
  要嘛容易自砸腳的設定
- **downloadAllAsZip 等其餘 event handler**：`downloadAllAsZip` 已在函式最頂端、任何 `await`
  之前同步設定 `btn.disabled = true`（比 `startBtn` 原本的錯誤寫法更正確），`btnPickModelFolder`／
  `btnPickOutFolder`／`btnSaveToFolder` 均有適當 `try/catch` 且正確過濾 `AbortError`（使用者取消
  資料夾選取視窗不視為錯誤），無需修改
- **字幕後處理巢狀迴圈**（`detectHallucinations` 內的 n-gram 偵測）：巢狀迴圈的內層維度是「單一
  字幕行的字元數」（通常 <100 字），非整份逐字稿的段落數，即使巢狀對單一批次而言運算量仍可忽略
  （實測等級：毫秒內完成），非效能瓶頸
- 其餘 9 個「無 try 但有 await」的函式（`updateModelFolderStatus`、`loadJSZip`、`loadOpenCC`、
  `applyOpenCC`、`idbGet`、`storeAudioInIDB`、`ensureVadScripts`、`separateVocals`、`loadUvrModel`）
  逐一追查呼叫端，確認均由上層已有 `try/catch` 的函式呼叫（如 `runInference` 內對應區塊、
  `runUVR`／`getVadInstance` 自身的 try/catch），屬「讓錯誤往上層統一處理」的合理設計，非疏漏

### 驗證方式（真實 Playwright + Chromium，非模擬，使用先前已生成的模擬音檔）
- `node --check`：修改後主程式／theme script／SW inline script 3 段全數通過
- 真實瀏覽器：確認 `<meta name="description">`／`og:title` 出現於實際渲染的 DOM；上傳檔案後
  確認 `.batch-item-rm` 實際渲染出的 `aria-label="移除"`；點擊模型按鈕觸發 `chooseDtype` 路徑
  （本測試環境 headless Chromium 支援 WebGPU，實際走的是 GPU 分支而非 WASM／`.then()` 分支，
  故此次測試確認了「新增的分支邏輯不影響任何路徑的正常運作」，但未能觸發到 `.catch()` 本身
  ——如上所述，這是因為 `.catch()` 保護的情境在目前程式碼下本來就無法重現，如實記錄而非誇大
  測試涵蓋範圍）
- 重跑第五輪迴歸測試：記憶體監控橫跨批次（檔案 2 處理中仍為 `true`，批次結束後為 `false`）於本
  輪修改後結果不變，過程零 `pageerror`

### 異動檔案（第七輪）
- `index.html`：`<title>`／subtitle 版本字串更新為 v22.4；新增 `<meta name="description">`／
  `og:title`／`og:description`／`og:type`；`chooseDtype(...).then()` 補上 `.catch()`；3 處純
  圖示按鈕補上 `aria-label`
- `sw.js`：`CACHE_VERSION` → `20260926-6`

## 第八輪（v22.4 → v23，2026-09-28，建置流程與 CSP）

依 `SPEC-build-pipeline-v2.md`（定案版；v1 為未列於 v2 差異表之項目的基準）與 `HANDOFF-build-pipeline.md` 實作。
`index.html` 原始碼**內容不變**，僅 `<title>`／subtitle 版本字串改為 v23（與 v22.4 原檔 `diff` 僅此 2 行）；
CSP 只在建置產物 `dist/index.html` 注入。

### 異動檔案
- 新增 `scripts/check-consistency.mjs`：`manifest.json`（唯一真實來源）／`index.html`（子集合）／`sw.js`（完全相等）圖示一致性檢查
- 新增 `scripts/build.mjs`：一致性檢查（不過即中止）→ 清空重建 `dist/` → 3 段 `<script>` SHA-256 hash → 注入 CSP `<meta>`
  （緊接 `<meta charset>`，為 `<head>` 第 2 個元素）→ 自動產生 `CACHE_VERSION`（UTC，`YYYYMMDD-HHmm`）→ 輸出 `dist/`
- 新增 `package.json`、`.github/workflows/deploy.yml`、`LICENSE`（MIT）、`tests/dist-csp.spec.ts`
- 修改 `.gitignore`（加 `dist/`）、`sw.js`（僅註解：說明 `CACHE_VERSION` 改由建置產生）、`README.md`（版本、部署、開發與測試、專案結構、License）
- `manifest.json`、`sw.js`：依使用者重新上傳的**更正版**取代（`start_url`／`scope`／icon 路徑改相對；`sw.js` 的 `BASE` 改由自身網址推得）；
  `check-consistency`／`build` 對更正版實測通過

### 與 spec 不同之處（皆有實測證據）
spec 的 CSP 標明為「提案基準，實作時務必用真實瀏覽器跑過一輪確認」。以真實 Chromium 對 `dist/` 執行後發現原 CSP 會弄壞既有功能，已補正：
1. `img-src 'self'` → `img-src 'self' data:`：`body::before` 的 `data:image/svg+xml` 雜訊背景被擋（實測違規：`img-src <- data`）
2. 新增 `media-src blob:`：預覽面板 `<audio>／<video src="blob:…">` 被擋（實測違規：`media-src <- blob`）
3. `connect-src` 加入 `blob:`：批次 ZIP 的 `fetch(blob:)` 被擋，App 記錄「ZIP … Failed to fetch」；同流程在無 CSP 的原始碼可正常產出 `subtitles_YYYY-MM-DD.zip`（對照組）
4. `connect-src` 加入 `release-assets.githubusercontent.com`：對 UVR 模型網址（`github.com/TRvlvr/…/Kim_Vocal_2.onnx`）實際 `curl -IL`，
   302 導向的是此網域；spec 原列的 `objects.githubusercontent.com` 予以保留（未能驗證是否仍會用到）
5. `package.json` 移除 spec 所列 `"type": "module"`：它使既有 `tests/preview-panel.spec.ts` 因 `__dirname is not defined in ES module scope` 無法載入
   （實測）。`.mjs` 腳本本身即為 ESM，`check`／`build` 不受影響（實測）
6. GitHub Actions 版本依 spec 指示查證後更新：`checkout@v6`、`setup-node@v7`、`upload-pages-artifact@v5`、`deploy-pages@v5`
   （查自各 repo 的 Releases 頁面與近期 PR）。`node-version` 維持 spec 的 20；本沙盒僅以 Node 22 實測，未在 Node 20 實測

### 驗證方式（真實 Playwright 1.56.0 + Chromium，非模擬）
- `check-consistency`：破壞 3 種情境（多餘 `<link>`、`APP_SHELL` 缺項、圖示檔不存在）皆被抓到且 `exit 1`；還原後 `exit 0`
- `build`：連續執行多次，`dist/` 恆為 7 個檔案、無殘留；script hash 在原始碼不變時逐次相同；`CACHE_VERSION` 逐次前進；
  `dist/index.html` 與原始 `index.html` 的差異僅 CSP `<meta>` 一行；`dist` 內 3 段 `<script>` 皆 `node --check` 通過
- `tests/dist-csp.spec.ts`（7 個案例，對 `dist/` 以真實瀏覽器執行）：CSP `<meta>` 位置與 3 個 hash；對照組（eval、內嵌腳本、非白名單腳本皆被擋，證明 CSP 確實生效）；
  載入零違規且 3 段 script 皆執行；`wasm-unsafe-eval`（主執行緒與真實 blob Worker 內 `WebAssembly.instantiate`）；
  Service Worker 實際安裝、快取名稱＝建置寫入的 `CACHE_VERSION`、App Shell（含 4 個圖示）全數入快取；
  單檔辨識→下載；兩檔辨識→預覽面板→批次 ZIP。重複執行 5 輪（35 次）全數通過
- 負向對照：拿掉 `media-src` 與 `connect-src blob:` 的變異版 dist，測試確實失敗

### 未能驗證（如實記錄，需在具備一般網際網路存取的環境補驗）
- 本沙盒對 `cdn.jsdelivr.net`、`huggingface.co`、`unpkg.com` 實測皆回 HTTP 403（`curl`），故：
  - **假 Worker 替身取代了 `window.Worker`**，真正的 `WORKER_CODE`（Worker 內動態 `import` transformers.js／onnxruntime、下載模型）**未被執行**；
    `wasm-unsafe-eval` 只以空 wasm 模組驗證，**未以真實 onnxruntime 驗證是否足夠**
  - HF 模型下載網域（`cdn-lfs.huggingface.co`、`cdn-lfs-us-1.huggingface.co`）未實測；`objects.githubusercontent.com` 是否仍會用到未實測
  - VAD（`vad-web`／onnxruntime 腳本載入）於 CSP 流程測試中關閉；JSZip／OpenCC 以 `page.route()` 替身檔回應（請求仍是對 `cdn.jsdelivr.net` 的真實 `<script src>`，白名單照常被檢查）
  - 既有 `tests/preview-panel.spec.ts` 案例 1–9 需真實模型推論，未能執行（僅確認 11 個案例可被 Playwright 載入）
- Google Fonts 在本沙盒無法連線（與 CSP 無關；CSP 允許其網域）
- `deploy.yml` 未在真實 GitHub Actions 上執行（僅以 YAML 解析確認語法與 job 相依）
- 建議上線前以真實模型在 `npm run build` 後的 `dist/` 跑一輪，並觀察 DevTools Console 有無 CSP 違規

### 觀察（未修改，非本輪範圍）
- 依 `grep` 行號，`ModelRegistry` 只在 `WORKER_CODE` 樣板字串內宣告（第 1940 行），但主執行緒的 `_dtypeViaRegistry`（第 2538–2544 行）也引用它；
  因函式內有 `try/catch` 而回傳 `null`、退回靜態估算，不會當機，但查詢路徑實際上可能從未生效。未實際執行驗證，僅供參考
- 實測 Playwright 輸出目錄名稱含中文與「→」時，`setInputFiles` 的第二個檔案不會進入佇列（改用 ASCII 暫存路徑即正常；原因未深究，應與 App 無關）

### 需要使用者確認
- `LICENSE` 版權人暫填 `Chung-pei`、年份 2026；若著作權歸屬學校或其他單位，請自行更正

## 第九輪（v23 → v23.1，2026-09-29，穿透式審查：飄移的重複邏輯、死碼、效能）

對已交付的 v23 zip 做審查（靜態分析＋真實瀏覽器實測）：ESLint（no-undef／no-unused-vars／no-useless-assignment 等，
分別掃主程式與三個 Worker 樣板字串展開後的程式）、頂層 114 個函式的呼叫圖可達性分析、jscpd 複製貼上偵測
（起始 3 組重複片段，修正後 0 組）。所有修正都以真實 Chromium 對「v23 原樣」與「修正後」做過對照，並留有可重現的回歸測試。

### A. 實際的 bug（v23 原樣可重現）
1. **`ModelRegistry` 在主執行緒未定義**（上輪「觀察」項目，本輪優先修正）。`_dtypeViaRegistry()` 引用的 `ModelRegistry` 只在
   `WORKER_CODE` 內宣告，主執行緒從未載入該函式庫；每次呼叫都丟 `ReferenceError`、被自己的 `try/catch` 吞掉，故「查詢模型實際發行哪些
   量化檔案」這條路徑**從未執行過**（埋樁重現：`DTYPE_CATCH ReferenceError: ModelRegistry is not defined`；ESLint `no-undef ×2` 亦指向同處）。
   - 影響：模型只發行 `q8` 時，v23 仍會載入不存在的 `fp32` 檔。以**真實 transformers.js 4.3.0**（自 npm 取得，於真實 Worker 內執行，
     HF 網站回應以 `page.route` 模擬）實測：v23 在四種情境一律選 `fp32`；修正後在「HF 只有 q8」情境改選 `q8`，其餘情境維持 `fp32`。
   - 作法：查詢移到 Worker 內（`_pickAvailableDtype`）。**政策只保留一套**：「偏好哪個 dtype」仍由主執行緒靜態規則（依可用記憶體與模型大小）
     決定；ModelRegistry 只確認該格式檔案存在，不存在才改選最接近者（先較輕、再較重）。**刻意沒有沿用**原 `_dtypeViaRegistry` 那套「可用記憶體
     <3GB 一律偏好 q4」的門檻——它不看模型大小，會把 145MB 的 whisper-base 在可用 1.5GB 時降成 q4（實測會改變預設輸出品質），且與實際運作中的
     靜態規則分歧。若你希望改採原作者的規則，只需改 `_pickAvailableDtype` 一個函式。
2. **字幕編輯器「＋ 新增段落」「↺ 還原」在按過一次「開始辨識」後永遠點不動。** 重設編輯器時對工具列與按鈕執行 `el.innerHTML = el.innerHTML`，
   會重建子節點，而事件只在載入時對原節點繫結一次（實測：辨識前標記的節點，辨識後已被換掉）。改為只隱藏、只清空列表。
3. **編輯器新增段落後把起始時間改到很後面，匯出的段落只有 1 毫秒。** 舊結束時間 ≤ 新起始時間，被 `resolveChunkEnd()` 夾成 start+0.001。
   改起始時間時若結束時間已不晚於它，改用與「新增段落」相同的 2 秒預設長度。
4. **模糊詞典比對（`applyFuzzyMedicalDict`）連鎖蓋掉術語。** 其滑動視窗內有 `window.includes('\x00')` 的略過判斷，是從 `applyMedicalDict` 的
   placeholder 機制照抄的，但只抄了「檢查」、從未真的放 marker，判斷永遠不成立。重現（內建詞典、UI 預設門檻 0.65）：
   「今天討論具勢細胞」→「…具巨噬白紅血球 (Red Blood Cell) (White Blood Cell) (Macrophage)」。現改為真正實作保護：標準詞與每次替換結果皆遮成
   marker、最後展開；只保護標準詞（raw 別稱正是要被改正的對象）。
   - 實測（內建詞典 295 筆、門檻 0.65，兩版使用相同取樣）：**輸入本身已是標準詞** 99 筆，v23 僅 42 筆維持不變（其餘被咬壞），修正後 99/99；
     **同音異字別稱** 214 筆，被改正為「標準詞 (英文)」由 37 筆增至 61 筆，輸出含多個括號（連鎖／多重命中）由 99 筆降至 6 筆。
     剩餘 6 筆是不同視窗各自的獨立誤判（見文末「門檻 0.65 會產生誤判」），不是連鎖蓋掉。

### B. 「同一邏輯各自維護」已消除／預防
- 三個 Worker 各自複製的「全域錯誤攔截」前導（~10 行）→ 單一常數 `WORKER_ERROR_FORWARD` 以 `${...}` 插入。三份原本已分歧：DIARIZATION 曾誤用
  `error:`（上輪修過）、UVR 一直用 `message:`。**ERROR 訊息欄位統一為 `payload`**，UVR 的兩個 Worker 內發送點與兩個主執行緒消費端一併改。
  以真實 UVR／Diarization Worker 實測，錯誤文字仍完整呈現（非 undefined），與 v23 相同。
- `fmtTimeVtt()` 複製了 `fmtTime()` 的整段換算 → 改為 `fmtTime(sec).replace(',', '.')`（與先前 `secToDisplay` 分歧成 4 位數毫秒是同一類風險）。
- `ensureVadScripts()` 內「載入 vad-web bundle」6 行在兩個 `onload` 各複製一份 → 抽出 `loadScript`／`loadVadBundle`。
- 兩處手寫的 `LOAD_MODEL` 訊息物件（首次載入、記憶體壓力重載）→ 單一 `buildLoadModelPayload()`。
- 相似度公式：權重 0.7／0.3 抽成常數 `PHON_WEIGHT`／`CHAR_WEIGHT`，公式只有 `phoneticSimilarityFromProfiles()` 一處；新增的「便宜上界」
  與它共用同一組常數（見 D）。

### C. 死碼／孤兒碼（皆以全檔搜尋確認零讀取後移除）
- `_inferredSec`、`_totalAudSec`：整個推論迴圈持續寫入但**從未被讀取**（`updateEta()` 實際吃的是呼叫端傳入的參數）。連同 3 處寫入一併移除；`_inferStart` 仍被讀取，保留。
- `runInference` 的 UVR 區塊內 `language`／`task`／`CHUNK_SEC`／`STRIDE_SEC`／`totalSamples`／`totalAudSec`／`monoSnapshot=null` 與 `_inferStart`／`_inferredSec` 的賦值：
  同一同步流程兩行後即被共用流程無條件覆寫／重算，從未生效。
- `_dtypeViaRegistry()`（見 A1）、`bopomofoLevenshtein()`（只被相似度函式使用，已內聯）、`phoneticSimilarity()` 字串包裝（重構後無人呼叫）。
- `buildEditorRow` 未使用的 `te`；`applyFuzzyMedicalDict` 內死賦值 `start += replacement.length`（緊接 `break`）；`readUvrModelFromIDB` 未使用的 `rej`；
  UVR Worker 內 `re.map(f => …)` 未使用的 `f`；一個多餘的 `\[` 跳脫。
- **審查後刻意保留**：`decoded = null`／`decoded2 = null`（ESLint `no-useless-assignment` 誤報；是釋放大型 AudioBuffer 的 GC 提示，與 Worker 內 `result = null` 同一慣例）。

### D. 效能（實測，非估計）
`applyFuzzyMedicalDict` 是同步執行、會凍結畫面的熱點：v23 每行字幕約 **225 ms**（30 句較長句、295 筆詞典），1000 行約 3.7 分鐘。
- 候選詞與視窗的注音／音節只各算一次（原本每個「視窗×候選詞」都重算）：187 行語料 7.6 秒 → 4.7 秒。
- 新增「便宜上界」提早排除不可能達標的組合（Levenshtein 距離 ≥ max(m,n) − 相同元素數，故 1 − d/max ≤ 相同元素數/max；只做 Set 查詢）。
  **輸出不變**：187 行輸出逐行相同、2,809 筆相似度逐位元相同；於 2,267,406 組「視窗×候選詞」上驗證上界從未低於真實值（違反 0 次），99.7% 被直接排除。
- 合計：187 行語料 7.6 秒 → 1.2 秒（6.2×）；30 句較長句每行 225 ms → 13 ms（約 17×），1000 行約 3.7 分鐘 → 約 13 秒。

### 驗證（真實 Playwright 1.56 + Chromium）
- 新增 `tests/round9-regression.spec.ts`（10 案例，離線）：修正後 10/10 通過；同一份測試對 v23 原樣執行，與修正直接相關的 6 案例失敗
  （「只發行 q8」「只發行 fp16/fp32」、編輯器 ×2、模糊詞典 ×2），其餘 4 案例為既有正確行為的守門測試。
- 模擬媒體以 ffmpeg 生成（75 秒立體聲 44.1kHz WAV／12 秒單聲道 8kHz MP3／20 秒 VP9+Opus WebM），走完整辨識 → 後處理 → 匯出：
  SRT／VTT／ASS／TXT／MD 五種格式的批次 ZIP（真實 JSZip、OpenCC），**與 v23 逐檔位元組相同**（模糊詞典關閉時），頁面錯誤 0。
- 編輯器：編輯、新增、刪除、套用、下載、還原皆正確；預覽面板 `<video src=blob:>` 正常。
- `dist-csp.spec.ts`（CSP）與既有 `preview-panel.spec.ts` 載入檢查於最終檔案重跑（結果見交付說明）。
- 靜態分析收尾：`node --check` 六段程式全過；ESLint 僅剩 2 則刻意保留的 GC 提示與 1 則工具設定造成的 `ort` 誤報；不可達函式 0；jscpd 重複 0 組。

### 未修改、需要你決定的觀察
- **模糊詞典預設門檻 0.65 會產生誤判**：例如「病原體」中的兩字視窗「原體」與別稱「衣原體」相似度 0.667，被改成「砂眼披衣菌 (Chlamydia trachomatis)」；門檻 0.75 以上不會。
  屬精確率／召回率的取捨，且函式預設值（0.75）與 UI 預設值（0.65）不一致（函式預設值實際上從未被用到，唯一呼叫端一律傳入 UI 值）。未動。
- 辨識完成後才切換「輸出格式」不會重新產生已完成項目的檔案（格式在辨識完成當下決定）。看起來是設計，未動。
- `applyFuzzyMedicalDict` 仍為同步執行（現約 13 ms／行）；長影片仍會有短暫凍結，若要徹底解決需搬進 Worker，屬架構變動，未做。
- 未能驗證：真實模型推論（需下載模型）、真實 HF 檔案清單語意（以模擬回應驗證「本 App 如何使用 ModelRegistry」，並自 4.3.0 套件原始碼確認 dtype 名稱對應）、
  `deploy.yml` 於真實 GitHub Actions 的執行。

## 第十輪（v23.1 → v23.2，2026-09-30，詞典用語、模糊門檻裡外一致化）

### 1. 詞典：移除別稱「衣原體」
台灣用語僅使用「砂眼披衣菌」。內建詞典該條由 `砂眼披衣菌|披衣菌|衣原體` 改為 `砂眼披衣菌|披衣菌`。全專案搜尋確認「衣原體」僅此一處（詞典不跨次保存，只存在記憶體，故只改預設值即可；若使用者曾匯出含「衣原體」的詞典檔再匯入，會把它帶回來）。
此別稱同時作用於精確比對與模糊比對：移除後，上一輪記錄的誤判（「病原體」被改成「砂眼披衣菌」）來源消失。

### 2. 模糊門檻：函式預設與 UI 預設的選擇與一致化
**不一致的實況**：函式預設 0.75，UI 輸入框與 `cfg` 後備值為 0.65，三處各自寫死；另外標籤寫「0.55=較寬鬆」但輸入框 `min` 是 0.5。同一函式內其他 6 個參數（合併字數、合併間隔、分行長度、最短時長、幻覺間隔、幻覺速度）的 HTML 值與 JS 後備值逐一核對皆一致，**只有模糊門檻不一致**。

**如何決定哪個比較好（實測，非直覺）**：在真實 Chromium 以內建詞典掃描 0.55～0.90。語料事前固定（未看結果前即存檔）：
- 正向：由 App 自己的注音分組表對 295 個標準詞各做 1～2 個「同音異字」替換，共 503 例；另加程式註解中的 2 個文件化案例（具勢細胞→巨噬細胞、心飢哽塞→心肌梗塞）
- 負向：83 句不含詞典術語的一般／醫學口語（含許多近似詞如「病原體」「細胞」「免疫」「血壓」）

| 門檻 | 文件化案例 | 同音異字改正 | 一般句子被誤改 |
|---|---|---|---|
| 0.55 | 2/2 | 72% | 15/83 |
| 0.60 | 2/2 | 75% | 11/83 |
| 0.65（v23.1 UI） | 2/2 | 80%（400/503） | 8/83 |
| 0.70 | 2/2 | 86% | 0/83 |
| **0.75（採用）** | 2/2 | **90%（453/503）** | **0/83** |
| 0.80 | 2/2 | 92% | 0/83 |
| 0.85 | 2/2 | 93% | 0/83 |
| 0.90 | 1/2 | 77% | 0/83 |

誤改例（0.65）：「血壓」→「高血壓 (Hypertension)」、「細胞膜」→「白血球 膜」。0.65 在每項指標上都不如 0.75（召回較低是因為低門檻讓無關候選詞先搶走視窗）。
選 0.75 而非 0.85：0.70～0.85 是零誤改平台，0.75 在中段（距誤改懸崖 0.05、距召回懸崖 0.10）；0.85 雖召回最高，但兩字詞的分數恰為 0.85，是靠浮點相等才通過，過於貼邊。
**限制**：語料為合成資料，非真實逐字稿；同音異字只涵蓋注音表內的字、只做單字替換。建議用你自己的逐字稿重跑確認。

**裡外一致化的作法**：新增唯一常數 `FUZZY_THRESHOLD_DEFAULT = 0.75`，① `applyFuzzyMedicalDict` 預設參數 ② `collectPostConfig` 的後備值 ③ 頁面載入時設定輸入框初始值，三處都由它而來；HTML 輸入框不再帶 `value` 屬性；標籤改為「越低越寬鬆、越容易誤改一般用語」並與 `min/max` 一致。
`scripts/check-consistency.mjs` 新增 `checkDefaultsConsistency()`（建置與 CI 皆會執行）：常數必須恰好定義一次、函式預設參數／後備值不得是數字字面值、輸入框不得帶 `value`。已以 4 種故意破壞驗證都會被擋下。
行為測試見 `tests/round10-defaults-and-dictionary.spec.ts`（8 案例）：對 v23.1 執行 5 個失敗、修正後 8/8 通過。

### 3. 效能量測的更正
上一輪寫「約 13 秒」並推測提高門檻可能有助於效能——**實測推翻了後者**：門檻 0.65～0.85 的耗時幾乎相同（約 3.4 ms/行）。耗時主要由「每行字數」與「詞典候選詞數」決定，詳見 `HANDOFF-postproc-freeze-and-worker-memory.md`。

### 驗證
真實 Playwright 1.56 + Chromium：`dist-csp.spec.ts`、`round9-regression.spec.ts`（改用共用 `helpers.ts` 後仍 10/10）、`round10-defaults-and-dictionary.spec.ts`；5 種輸出格式 × 3 個模擬媒體檔對 v23.1 逐檔位元組比對。

### 為何這輪沒有動 `applyFuzzyMedicalDict` 的執行方式
長影片的凍結成因、量測與處理策略不在本輪實作範圍，已整理成 handoff 文件供另一個對話撰寫 spec。

## 第十一輪（v23.2 → v24，2026-10-17，後處理凍結＋記憶體穩定性＋NUL 亂碼修正）

準則：**輸出不變（T-B1 除外）、畫面不凍結、低記憶體裝置不當機**。依 `whisper-srt-v24-implementation-spec.md` 逐任務實作（TDD：每個任務先對未修改的檔案跑出紅燈，再實作轉綠；一任務一 commit）。

### P：後處理時間切片（T-P）
- `createSlicer`＋`yieldToMain`（MessageChannel，預算 `POST_SLICE_BUDGET_MS` = 8 ms）：精確詞典與模糊比對都會讓出主執行緒；後處理期間可操作介面、可按「取消」（取消後保留 `task_state` 斷點）。進度 96→99% 逐步更新（DOM 寫入節流 ≥ 100 ms）。
- 後處理開頭以 JSON 快照 `getPostConfig()` 與 `medicalDict`：切片後使用者可在期間編輯詞典，不會讀到半改狀態。
- 模糊比對加「音節倒排索引預篩」（`buildFuzzyIndex`／`countCandidateHits`）、精確詞典預編譯 RegExp：**輸出與 v23.2 逐字相同**（TF-02／03／05／06b／10）。
- **行為變更（Q5）**：`outFormat` 於後處理**之後**才讀取；切片後使用者可在後處理期間切換輸出格式，檔案會以新格式輸出。

### B：守護標記內數字被誤替換 → 輸出含 NUL 亂碼（T-B1，v23.2 既有 bug）
- 現象：精確詞典／模糊比對的佔位標記 `\x00<十進位索引>\x00` 內部的數字，會被「純數字詞條」或「純數字視窗」當成可替換文字；或兩個相鄰標記之間夾著等於某標記索引的原文數字時，標記被拼錯。結果是字幕**丟字**並**夾帶不可見的 NUL 字元**（例：「高血壓 糖尿病」→ `高血壓 (HTN) <NUL>一 (One)<NUL>`，「糖尿病」消失）。
- 修正：標記改為 `\x00<私用區字元>\x00`（`0xE000` 起，單一產生器 `guardMarker(i)`，兩階段共用）。
- **這是 V24 唯一刻意改變輸出的修正**，且僅影響「兩個詞命中之間夾數字」「詞典含純數字詞條」「單行 ≥ 11 次替換且詞典含數字詞條」這幾類行；其餘行與 v23.2 逐字相同（TB-03：輸入不含數字且舊版未損壞的行逐字相同，新版任何一行都不含 NUL）。
- 測試調整：刪除 TF-03c（它把損壞行為鎖成預期，已由 TB-02／TB-04 取代）；TF-03 的 oracle 改為「輸入不含數字與 NUL、且舊版輸出未損壞的行逐字相同」。

### M0：移除 Worker 內的記憶體偵測（T-M0）
- 刪除 Worker 內 `refreshStorageRatio`／`getMemoryUsageRatio` 與主執行緒的 `MEMORY_PRESSURE`／`DEGRADE_STRATEGY` 訊息及處理、`_dynamicChunkSec`（動態縮短切片）。原因：Worker 內沒有 `performance.memory`，原偵測實際讀的是**磁碟儲存配額**而非 RAM，在小配額環境會誤報壓力並重載模型（偽造配額 90%：v23.2 載入模型 3 次、誤報 2 次；v24 載入 1 次、誤報 0 次，TM-02）。Whisper 編碼器輸入固定 30 秒，縮短切片不會降低編碼器記憶體。切片長度固定 `CHUNK_SEC = 30`。
- 記憶體條標籤 `RAM` → `JS 堆積`（它量的是主執行緒 JS 堆積，看不到 Worker／WASM；本輪只改標籤，量測對象未改，屬既有限制）。

### M1：單一 16 kHz 解碼路徑（T-M1）
- `decodeToMono16k`：以 16 kHz 的 `AudioContext` 直接解碼，**執行期驗證 `decoded.sampleRate`**；瀏覽器忽略／拒絕 `sampleRate` 選項時退回離線重取樣（日誌會出現「重取樣：」）。降混與重取樣不再各自複製一份完整陣列。
- `applyPeakNormalization` → `applyPeakNormalizationInPlace`：就地正規化，運算與 v23.2 逐位元相同，只是不再另配一份完整長度陣列。
- 刪除 IDB 儲存失敗後實質不可達的「重新解碼」分支。UVR 解碼路徑不動。
- 解碼 JS 堆積峰值（新／舊，同機同檔，TM-05）：見下方「實測數字」。

### M2：靜態記憶體分級（T-M2）
- `detectMemoryTier()`：所有 iOS 家族與 `deviceMemory ≤ 4` 視為 `low`（預算 `TIER_BUDGET_MB.low` = 1024 MB），其餘為 `standard`（spec 原值 2048 MB；r2 補修降為 1536 MB，見下方 R2）。`getAvailableMemoryMB` 不再使用磁碟配額。`_dtypeFallback` 公式不變（×3 → q4、×5 → q8、其餘 fp32）。
- **行為變更**：(1) `low` 上限 1024 MB，`small` 起改用 q4（辨識精度可能略降）；(2) Firefox／Safari 不再以磁碟配額估算可用記憶體（無 `performance.memory` 時使用分級預算）；(3) Chromium standard 與 v23.2 逐位相同。
- 低記憶體裝置顯示警告框（`ramWarnLow`，不使用行內腳本，CSP 不放寬）。

### M3：錯誤驅動降級（T-M3a、T-M3b）
- T-M3a：所有「段落辨識失敗」都把**原始錯誤文字**寫入日誌（v23.2 有數條路徑完全靜默）。
- T-M3b：單一送出點 `runChunkOnWorker`（監聽 `message` 與 `error`：Worker 未捕捉例外立即失敗，不必等 300 秒逾時；單段辨識逾時 `CHUNK_TIMEOUT_MS` = 300,000 ms；重試時重載模型的逾時 600,000 ms）。每段最多重試一次：`oom`／`crash` → WebGPU 後端改 `preferGpu:false`（WASM），WASM 後端改更輕的 dtype（`fp32→fp16→q8→q4`）；`timeout` → 同設定重建 Worker；`other` → 不重載直接重送。**不自動換模型、不縮短切片。**
- 失敗上限：連續 3 段（各含重試）失敗後不再重試；連續 5 段失敗終止該檔並提示「可能是記憶體不足，請改用較小的模型（base 或 small）」。重試後仍失敗的段落**跳過並標示**：日誌列出跳過段落（第幾段、hh:mm:ss 起），批次列表顯示「完成（N 段跳過）」，輸出照常產生。上限 3／5 無實測依據（真機驗收項目 10）。
- `seg.data` 永不被 transfer（每次嘗試傳複本），不再需要 retry buffer；取消與逾時時 listener 與 timer 一律清乾淨。
- 重試前「重載模型」本身失敗（例如再次記憶體不足）時，該段同樣走「跳過並標示」，不放棄整個檔案（最終獨立審查 I-1；測試 TM-09j）。

### X：守門與版本
- `scripts/check-consistency.mjs` 新增 `checkNoWorkerMemoryApi()`（Worker 樣板字串內不得出現 `performance.memory`／`storage.estimate`／`MEMORY_PRESSURE`／`DEGRADE_STRATEGY`）與 `checkSingleSources()`（`POST_SLICE_BUDGET_MS`、`TIER_BUDGET_MB`、`OOM_ERROR_PATTERNS`、`CHUNK_TIMEOUT_MS`、`FUZZY_UNSAFE_RE`、`yieldToMain`／`MessageChannel`、`decodeToMono16k`／`decodeAudioData(`、`RUN_CHUNK` 各只能有一份實作）；接進 `npm run check` 與 CI。對凍結的 v23.2 基準檔，後者判定 10 項違規（證明守門有鑑別力，TX-01）。
- 副標題「動態記憶體調適」→「錯誤驅動降級」；移除的訊息與功能見 M0。`sw.js` 的 `CACHE_VERSION` 仍由建置腳本產生。

### R2：審查延後 minor 與預算補修（2026-10-17 晚；每項先紅後綠，TM-09k～q、TM-07b）
- 重試時重載模型使用「本次工作開始時」的模型；辨識中點選別的模型按鈕不再讓重試換模型（TM-09k）。
- WebGPU 失敗改用 WASM 重載後，畫面的後端標示（`#statModel`、infoBox 提示列）同步更新；首次載入與重載共用 `applyBackendInfo()`（TM-09l）。
- Worker 異常終止（`crash`）的重載日誌不再說「記憶體不足」，改為「Worker 異常終止」；OOM 仍說（TM-09m）。
- 後處理日誌「套用（N 項）」取自實際套用的設定快照：`runInference` 只快照一次並以 `applyPostProcessing(chunks, { cfg })` 傳入（TM-09n）。
- `runChunkOnWorker`：已取消時不送出辨識（TM-09o）；`postMessage` 同步丟出例外時回報失敗並清除監聽器與計時器（TM-09p）。
- OOM 分類：`/RangeError/` 縮窄為記憶體相關的 `RangeError`（`Invalid typed array length`、`Array buffer`）；`Maximum call stack`、`Invalid time value` 等不再被當成 OOM（TM-09q）。
- **辨識中停用模型按鈕**：辨識中點選別的模型按鈕，會釋放並終止執行中的 Worker（既有行為，v23.2 即如此），造成該段等 300 秒逾時。現在 `isRunning` 為真時（開始辨識的同一時刻、早於任何 `await`）五個 `.model-btn` 全部 `disabled`，結束／取消／錯誤時於 `finally` 最先恢復（TM-09r、TM-09s）。TM-09k 改以內部賦值 `selectedModel` 模擬，保留「重試用原模型」的縱深防禦驗證。
- 過時註解更新（舊 `\x00N\x00` 標記、「記憶體壓力重載」）；`playwright.config.ts` 移除不存在的 `zz-debug`。
- **`standard` 記憶體預算 2048 → 1536 MB**：預算只用來挑 dtype（`< 3×模型大小 → q4`、`< 5× → q8`）。small（460 MB）要維持 q8 需 ≥ 1380，未知模型（500 MB）需 ≥ 1500；1536 使**每個現有模型的 dtype 完全不變**（TM-07 表不變；TM-07b 鎖定）。低於 1380 時 small 會改 q4、辨識精度下降，所以不再降。實際記憶體用量不變；只影響無 `performance.memory` 的 Firefox／桌面 Safari，Chromium 與 `low`（1024）不動。
- T-S spike（多執行緒 WASM）：**不在 V24 主線**。獨立分支 `spike/coi` 與執行手冊另行交付（`whisper-srt-v24-r4-spike-coi-package.zip`）。

### R3：dist 版 CSP 擋掉模型載入（T-S 實機測試發現；2026-10-18；每項先紅後綠，TB-01～04）
- **現象**：dist 版（`npm run build` 產物，即 GitHub Pages 部署版）**無法載入任何模型**（一般網址與 `?coi=1` 皆然）；模型檔下載完成後拋 `no available backend found. ERR: [wasm] TypeError: Failed to fetch dynamically imported module: blob:…`。source 版沒有 CSP `<meta>`，所以先前所有測試（含假 Worker 流程）都看不到；v23.2 基準同樣受影響（同為 transformers.js 4.3.0），此前無人以 dist 做過真實模型端到端測試。
- **根因**：transformers.js 內建的 onnxruntime-web 建立 WASM 後端時，把 glue 模組（`.mjs`）做成 `blob:` URL 再動態 `import()`；`script-src` 沒有 `blob:`。Whisper Worker 繼承文件 CSP，同樣被擋。
- **修正**（`scripts/build.mjs`）：`script-src` 加 `blob:`（**不加引號**：CSP 的 scheme 來源不可加引號，`'blob:'` 是無效來源會被忽略）。仍不開放 `unsafe-inline`／`unsafe-eval`。
- **一併補**：`connect-src` 加 `cdn-lfs.hf.co`、`cdn-lfs-us-1.hf.co`、`cdn-lfs-eu-1.hf.co`、`cas-bridge.xethub.hf.co`。HuggingFace 大檔案現在由 `huggingface.co` 轉址到這些主機，CSP 逐跳檢查轉址目標；舊清單只有 `cdn-lfs*.huggingface.co`，實機會在轉址那一跳被擋。此項依 HuggingFace 論壇的白名單串（2024-10、2025-02 記載）判斷，**沙盒無法連 HuggingFace，未以真實下載驗證**；舊的兩個 `*.huggingface.co` 保留。
- **測試**（`tests/dist-csp.spec.ts`）：TB-01 主執行緒 `import(blob:)`；TB-02 blob Worker 內 `import(blob:)`（修正前錯誤訊息與實機一致）；TB-03 `script-src` 逐項精確比對（只多 `blob:`，無 `unsafe-*`）；TB-04 blob Worker 內連線 5 個 HuggingFace 主機成功、`evil.example.com` 仍被擋。突變檢查：把 `blob:` 改成 `'blob:'`，TB-01～03 全紅。
- **未驗證**：沙盒連不到 CDN／HuggingFace／npm，**真實模型的端到端辨識仍需在你的電腦驗證**（RUNBOOK 的 S3-0 煙霧測試）。

### R4（v24 r5）：穿透式審查＋高信心詞典＋connect-src 萬用子網域（2026-10-19；每項先紅後綠，TR-01～13）
審查五問的結論：**(1) 同邏輯各自維護**——找到 4 處（詞條驗證、CSV 標題列、腳本載入、主題樣式字串）＋精確／模糊兩套詞典引擎對重複別稱各選不同歸屬；**(2) 錯誤 fallback**——找到 2 處（IndexedDB 分片讀不到被靜默略過、build 只跑 4 項檢查中的 2 項）；**(3) 孤兒碼**——全檔識別字掃描無孤兒宣告；刪除 1 個永遠空操作的分支、1 個多餘別名、2 個孤兒 import。
- **P1 `connect-src` → `https://*.hf.co`**：HuggingFace 轉址主機會變動（`us.aws.cdn.hf.co` 等），逐一列舉每次都漏。萬用子網域只涵蓋 `hf.co` 底下；對照組 `evil.example.com`、`hf.co.evil.example.com` 仍被擋（TB-04 改寫）。
- **P4 高信心詞典**：新增 9 筆（維生物→微生物、素族→宿主、表成感染→表淺感染、往狀內皮系統→網狀內皮系統、分口傳染→糞口傳染、潛伏其→潛伏期、分子感菌→分枝桿菌、民旗統→免疫系統、干燃→感染）＋4 筆補別稱（先天性免疫、後天性免疫、肺結核、大腸桿菌）。預設詞典 295 → 304 筆。**B 組 11 組未加**。**A 組中另有數項因會誤傷一般文句而未加**（例：為生物→「作為生物」、做清楚→「為清楚起見」、呼吸到→「呼吸到新鮮空氣」、乾脹→「餅乾脹氣」、水斗／水豆→「水豆腐」），理由逐項列在 HANDOFF；以 130 句一般語句（含刻意設計的碰撞句，`tests/fixtures/benign-zh.txt`）驗證新增後輸出與舊詞典逐字相同（TR-11）。
- **預設詞典重複別稱去重（TR-10）**：4 個別稱同屬兩筆（人類免疫缺乏病毒、嗜中性球、clonal deletion、過敏性休克）。精確詞典「後者蓋前者」、模糊比對「前者優先」，兩套引擎各選不同歸屬（例：模糊比對把「過敏性休克」標成「第一型超敏反應」，精確詞典標成「Anaphylaxis」）。現在每個別稱只屬於一筆，保留精確詞典原本生效的那筆，**精確詞典輸出不變，模糊比對對這 4 個詞改為與精確詞典一致**。
- **模糊比對改壞精確詞典寫好的英文標注（v23.2 起即有；TR-08／09）**：「IgG (Immunoglobulin G)」→「IgG (抗體 (Antibody / Immunoglobulin)n G)」。預設詞典 1,194 個（詞或別稱＋前後文）有 73 個被改壞。修正：`applyFuzzyMedicalDict` 先整段保護「標準詞 (英文)」。**順帶效益**：被保護的英文不再進入視窗比對，4,000 行「精確＋模糊」20.3 s → 1.4 s。
- **詞條驗證只有一份（TR-02／03）**：`normalizeDictEntry` 供手動新增、JSON 匯入、CSV／TSV 匯入共用。修正前 JSON 匯入帶非字串欄位會在「整份辨識完成後的後處理」才丟 TypeError。
- **匯出再匯入（TR-04）**：CSV／TSV 匯出的中文標題列重新匯入會變成一筆詞條（295 → 296）。標題列只有 `DICT_CSV_HEADER` 一份定義，匯入時跳過。
- **批次取消計數少 1（TR-01）**：3 個檔案、第 1 個辨識中按取消，摘要顯示「取消 2」，現為 3。
- **IndexedDB 分片讀取失敗不再靜默（TR-07）**：另一分頁清掉暫存時，原本悄悄少字幕並顯示成功；現在記錄失敗、計入跳過／連續失敗，且不重試（資料已不在）。
- **建置與檢查共用同一份檢查清單（TR-05）**：`runAllChecks()`；原本 `npm run build` 只跑 4 項檢查中的 2 項，違反單一來源守門的 index.html 仍能建出 dist。
- **腳本載入只有一份（TR-06）**：`loadScriptOnce`（JSZip／OpenCC／VAD 共用）；同時兩次載入只發 1 次請求，失敗可重試；OpenCC 轉換器也只建一份。
- **主題樣式只有一份（TR-12）**：檔頭主題 script 與模組內切換按鈕各存一份相同的 600 字元樣式字串，改為模組取用 `window._themeStyles`；`check` 守門。
- **刪除死碼**：`fixCasing` 第二分支（永遠空操作；TR-13 新舊逐字相同）、Worker fetch 攔截的 `urlObj_chk` 別名、`perf-freeze`／`round11-freeze` 兩個孤兒 `fs` import。
- **測試基礎設施**：「舊版當 oracle」的測試改由 `readPageHtml('old')` 提供頁面（v23.2＋受測頁面的預設詞典；磁碟上的 baseline 不動），否則詞典增修會被誤判成引擎差異。TF-07 的對照組改為同一頁面不切片、詞典不動（舊版引擎帶有上述標注 bug）。`perf-freeze` 不再寫死詞條總數。
- **查到但未修（報告於 HANDOFF，附證據）**：UVR 人聲分離（預設關）無法運作（`postMessage` transfer 清單重複同一個 buffer → `DataCloneError`；`fft` 對 n=7680 回 NaN）；Worker WebGPU 路徑忽略記憶體分級 dtype；Diarization 固定 300 s 逾時且不終止 Worker；幻聽偵測對 CJK 任何重複 2–4 字都標記（與文件「連續重複」不符）；`applyPostProcessing` 開頭的「全部關閉就提早返回」判斷恆為真（修了會改變凍結輸出）；`float32ToWav` 每取樣配置閉包（僅 UVR 用）；既有短別稱（癌、高壓、結核、中風）會誤傷子字串（v23.2 凍結）。

### R5（v24 r6）：UVR 人聲分離移除後重做（2026-10-19～20；測試先行，TU 系列 U-01～U-15）
r5 查到舊 UVR 無法運作，本輪依使用者指示「全部移除後重做」。舊實作在每一層都錯：模型輸入／輸出是 `[batch, 4, 3072, 256]`（n_fft 7680、hop 1024、聲道 [L實, L虛, R實, R虛]），舊碼組出 `[1, 2, 2048, 256]`、hop 1920；radix-2 FFT 對 n=7680（＝4·4·4·4·2·3·5）回 NaN；`postMessage` transfer 清單重複同一個 buffer → `DataCloneError`；人聲音訊繞過正規化與 IndexedDB 分片；無任何測試。重做的規格、驗證與取捨：
- **規格先用真實模型驗證**：以 numpy 獨立實作（`tests/uvr/uvr_ref.py`）＋ onnxruntime 跑真實 Kim_Vocal_2：純語音 SI-SDR 40.8 dB；語音＋音樂（0 dB）提升到 24.6 dB。JS 管線與這份參考實作逐點比對（U-03 STFT 20 個頻格 × 4 影格 × 4 聲道；U-04 分塊管線含接縫與首尾，差 ≤ 2e-4；真實課程檔 12 秒節錄差 0）。
- **DSP**（`uvrCreateDsp`，單一來源）：混合基數 Stockham FFT（radix 4／2 特化＋一般路徑；對 11 種長度與樸素 DFT 比對，7680 點相對誤差 6e-15）；兩個實數聲道合併成一個複數 FFT；STFT／iSTFT 等同 `torch.stft／istft`（center、reflect、週期 Hann）。同一份函式以 `toString()` 注入 Worker，主執行緒測試與 Worker 不會分歧。
- **頻帶上限 17.6 kHz 的後果（如實記錄）**：模型只看前 3072 個頻格，訊號首尾的階躍／折角含高頻被截掉，邊緣約 0.02～0.03 的誤差（與模型實際行為相同）；內部還原誤差 ≤ 2.5e-6。測試因此以「邊界 8192 樣本內與 numpy 逐點比對、之外與輸入比對」兩種方式驗證，不放寬容許誤差。
- **模型來源改為 Hugging Face 鏡像**（`fudan-generative-ai/hallo`，SHA-256 `ce74ef3b…9c8b` 與官方檔逐位元相同）。**舊網址（GitHub Release）在瀏覽器必定失敗**：`github.com` 與 `release-assets.githubusercontent.com` 都不回 `Access-Control-Allow-Origin`（實測標頭）。下載後驗證大小與 SHA-256，不合格不入快取；`check` 守門禁止 `releases/download/` 再出現。CSP `connect-src` 同步移除三個不再使用的 GitHub 主機。
- **與既有機制共用而非另起爐灶**：人聲音訊經 `decodeAudio(file, mono16k)` 走同一條正規化／diarization 快照／大檔 IndexedDB 分片路徑；`workerCall` 增加 `transfer`／`onProgress`（逾時＝「超過 N 毫秒沒有任何訊息」）；取消沿用 `registerCancelReject`，取消按鈕處理函式未動；ort 主檔名清單 `ORT_SCRIPT_FILES` 由 VAD 與 UVR Worker 共用；`resampleChannels` 取代 `resampleMono` 的實作（單聲道結果逐點相同，U-06）。
- **失敗一律 fallback、不靜默採用壞結果**：略過（低記憶體裝置、超過上限）、失敗（session 建立、下載、校驗、形狀不符、NaN、輸出幾乎無聲）都記錄原因並改用原始音訊辨識；Worker 在 `finally` 終止（取消、失敗、成功都不留）。
- **使用者可見**：設定面板「🎤 UVR 人聲分離」（預設關；說明速度、約 64 MB、20 分鐘上限、低記憶體不提供）；單檔模式出現「下載人聲音訊（WAV）」（`<檔名>_vocals.wav`，44.1 kHz 立體聲 PCM16）；批次模式不保留 WAV（一個 10 分鐘 WAV 約 100 MB）。進度標籤「人聲分離 n/N 段（剩餘約 …）」。
- **音訊長度上限 20 分鐘**：初版 10 分鐘會擋掉使用者的 12 分鐘課程錄音，改 20 分鐘。取捨：44.1 kHz 立體聲解碼＋輸出約 0.85 GB／20 分鐘。
- **測試**：U-01～U-13（原始碼頁面，含假 ORT 的真實 Worker）、U-14（選用：真實模型＋Python 橋接）、U-15（選用：真實 66,759,214 位元組＋假 ORT，原始碼與 dist CSP 各一次；驗證兩個模型常數與 CSP）。突變測試：通道順序互換、分塊錯位、不驗 SHA、靜音防護停用，各自被對應測試抓到。
- **沒做到／誠實限制**：(1) onnxruntime-web 本身未在真實瀏覽器執行（沙盒取不到套件；以假 ORT＋Python onnxruntime 橋接驗證其餘全部流程）。(2) 速度是硬限制：本機 CPU 2 執行緒、真實課程檔 12 分 07 秒約 0.8× 實時；瀏覽器 WASM 單執行緒預期明顯更慢，未實測。(3) 未使用 WebGPU。(4) 多聲道（5.1）來源全部降混為單聲道再分離。

### 移除與保留
- 移除：`DEGRADE_STRATEGY`／`MEMORY_PRESSURE` 訊息、`_dynamicChunkSec`（動態縮短切片）、Worker 內的儲存配額偵測、`_storageQuotaMB`。
- 保留未修（既有限制）：記憶體條仍只量主執行緒 JS 堆積；`seg.data` 以 `slice` 複本 transfer 的記憶體成本；P4（解碼階段降混／正規化切片）為條件式，未做（觸發條件：真機量到單次停頓 > 250 ms）。
- 未做（有決策與重評條件，見 spec §3.2）：D-B（模糊比對搬進 Worker）、D-D（行級快取）、D-E（辨識中管線化後處理）、D-F（預估時間提示）、D-W（WebCodecs 串流解碼）；T-S（多執行緒 WASM／跨來源隔離）為 spike，**不隨 V24 出貨**。

### 實測數字（Playwright 1.56.0／Chromium 141，沙盒 1 vCPU；合成媒體與假 Whisper Worker；單次執行約 ±20% 雜訊，門檻以新／舊比值表達）
離線功能測試 `npm run test:functional`：**89 passed**（既有 25＋新增 54＋r2 補修 10；含 `dist-csp`）。效能 `npm run test:perf`：**7 passed**。
r4（dist CSP 補修）後：functional **93 passed**（89＋TB-01～04，含 `dist-csp` 11 項）；perf 未重跑（`index.html` 未變動，只改 `build.mjs`、`sw.js` 時間戳與測試）。
r5 後：functional **108 passed**（93＋TR-01～13，其中 TR-04 為 json／csv／tsv 三案；含 `dist-csp` 11 項，對重建後的 `dist/` 執行）；perf **7 passed**（TF-12 後處理 1,157 ms／最大 rAF 間隔 17 ms，v23.2 為 21,244 ms／21,183 ms；TF-16 0.048、TF-17 0.224、TM-05 0.27／0.18／0.48／0.30）。
r2 補修後重跑（同機）：functional **89 passed**、perf **7 passed**（TF-12 最大 rAF 間隔 17 ms、TF-18 0.138、TF-16 0.045、TF-17 0.221、TM-05 0.27／0.18／0.48／0.33）。TM-05 的 1 小時單聲道比值 0.33 離門檻 0.35 只剩小幅餘裕（單次 ±20% 雜訊）；下方表格為首次完整實測。

| 測試 | v23.2 | v24 | 門檻 |
|---|---|---|---|
| TF-12 後處理最大 rAF 間隔／longtask（約 1,080 行、395 筆詞典、後處理全開） | 21,283／21,287 ms | 17／0 ms（longtask 0 個） | ≤ 100 ms |
| TF-14 進度標籤更新次數、單調 | 1 | 29、單調不減 | ≥ 5、單調 |
| TF-18 後處理總耗時 | 21,339 ms | 2,938 ms（0.138） | < 1.0 |
| TF-13 後處理中按「取消」 | 取消被忽略，檔案照常完成 | 20 ms 生效，`task:` 斷點鍵保留 | ≤ 200 ms |
| TF-16 模糊比對 600 行、395 筆詞典 | 8,451 ms | 414 ms（0.049） | ≤ 0.2 |
| TF-17 精確詞典 1,000 行、895 variants | 499 ms | 121 ms（0.243） | ≤ 0.5 |
| TM-05 解碼 JS 堆積峰值：4 分鐘 44.1 kHz 立體聲 | 165 MB | 44 MB（0.27） | ≤ 0.35 |
| TM-05 10 分鐘 16 kHz 單聲道 | 201 MB | 37 MB（0.18） | ≤ 0.35 |
| TM-05 10 分鐘 44.1 kHz 立體聲（IDB 分片路徑） | 302 MB | 147 MB（0.49） | ≤ 0.6 |
| TM-05 1 小時 16 kHz 單聲道（IDB 分片路徑） | 1,210 MB（7,612 ms） | 365 MB（1,984 ms）（0.30） | ≤ 0.5 |

說明：(1) spec 規劃輪記錄的「4 分鐘立體聲 15 MB（0.09）」在本次實作環境兩次執行都量到 44 MB（0.27），與 spec 自己的 E3（`o2.mjs`）數字一致，仍低於 0.35 門檻；(2) 偽造儲存配額 90% 的 TM-02：v23.2 載入模型 3 次／誤報 2 次，v24 載入 1 次／誤報 0 次。真機（iPhone 12、Safari、Firefox、真實模型與逐字稿）**均未驗證**，清單見 spec §9。

## 第十二輪（v24 r6 → r7，2026-10-21，穿透式審查：人聲分離實跑、VAD、取消、飄移的重複邏輯、孤兒碼）

依使用者要求逐項審查：(1) 相同邏輯各自維護的 bug、(2) 錯誤的 fallback、(3) 人聲分離是否正常、(4) 程式碼／邏輯／流程正確性、(5) 垃圾碼與孤兒碼。每個缺陷先寫會失敗的測試（原版 r6 上確實失敗），修正後轉綠。

**方法**：沙盒補上真實瀏覽器（Chromium 153，經 npm 套件 `@sparticuz/chromium` 取得）與真實 `onnxruntime-web@1.30.0`；沒有 66 MB 的 Kim_Vocal_2，改用 131 位元組的「輸出＝輸入×0.5」替身 ONNX（`tests/uvr/gen-half-model.py`，原生 ORT 驗過 `max|y−0.5x| = 0`）。ESLint（`no-unused-vars`、`no-undef`）掃過 `index.html` 三段 script 與三個 Worker 樣板字串。

### 缺陷與修正

| # | 症狀（根因） | 修正 | 證據 |
|---|---|---|---|
| 1 | **人聲分離在真實瀏覽器永遠失敗並悄悄改用原音。** ORT-web 的 `ort.all.min.js`／`ort.min.js` 以 `var ort=` 在全域宣告 `ort`；UVR Worker 最上層寫了 `let ort = null`，同名衝突使 `importScripts` 丟 `NetworkError: failed to load`。假 ORT 只指派 `self.ort` 屬性，r6 的 U-07～U-13 全測不出 | Worker 內改名 `ortApi`；`check-consistency` 新增守門（UVR Worker 最上層不得宣告 `ort`） | U-15a（真實 ORT-web）：原版失敗、修正後通過；差異對照：僅 `let ort` 一項使同一份 ORT 在同一個 Worker 失敗 |
| 2 | **VAD 開啟（預設）時，每個語音段（第一段除外）的前 5 秒文字被丟棄，短於 5 秒的語音段整段消失。** `cleanStart = i === 0 ? 0 : strideSec` 是為重疊視窗設計，VAD 的每個語音段第一個視窗卻是獨立起點。v23.2 基準版同樣寫法；測試皆關閉 VAD 所以抓不到 | 切段器為每個 chunk 帶 `leadSec`（只有接續視窗才有重疊）；消費端改讀 `seg.leadSec`；`strideSec` 從 Worker 協定移除 | TR14-01：原版 SRT 缺 `S1HEAD`／`S2HEAD`、仍有 `S1MID`／`S2MID` |
| 3 | **VAD 閾值被拿去當 RMS 閾值。** UI 的 `p_vad_threshold`（預設 0.5，Silero 機率）只傳給 RMS 備援；Silero 本身寫死 0.5／0.35，控制項對 Silero 無效。Silero 載入失敗時 RMS 備援拿 0.5 當能量閾值，幾乎偵測不到語音，悄悄改走全段處理 | `SILERO_VAD_THRESHOLD`（UI 可調，預設 0.5／負閾值 0.35，與原本寫死的值相同）與 `RMS_VAD_THRESHOLD`（固定 0.02）分開；UI 值變動時重建 Silero 實例 | TR14-02（合成訊號 RMS≈0.09） |
| 4 | `runVAD_rms` 對短於 256 個樣本的音訊丟 `RangeError`（`numFrames` 為負） | `Math.max(0, …)` | TR14-03 |
| 5 | **說話者分割中按取消會卡到 300 秒計時器**：Worker 回 `CANCELLED`，主執行緒不認得；取消後還可能被當成功收尾。載入階段同樣無法取消 | 載入與推論改走 `workerCall`（取消立即 reject；逾時改為「超過時限沒有任何進度訊息」）；`CANCELLED` 不再被「分割失敗」吞掉；分割後加取消檢查；Worker 以 `_runId` 取代會被新一輪蓋掉的 `_cancelled` 旗標 | TR14-04 |
| 6 | **Service Worker 啟動時刪除所有「不等於 CACHE_NAME」的快取**——同一個 github.io 網域的其他 PWA 共用 Cache Storage，會被一併清掉 | 只刪 `whisper-subtitler-` 開頭者；`check-consistency` 新增守門 | TR14-05 |
| 7 | `idbPut`（音訊分片）與 `uvrIdbPut` 各自維護且已分歧：只有 UVR 版處理 `tx.onabort`。交易在提交階段被中止（如 QuotaExceededError）時只觸發 abort、不觸發任何請求的 error，通用版的 Promise 永不結束（`HANG`） | 合併為單一 `idbGet/idbPut(key, …, store)`，含 `onabort`；中止時 `tx.error` 可能為 null，保證 reject 的是 `Error`（呼叫端會讀 `err.message`） | TR14-07：原版 `HANG`、修正後 reject `Error`；`check-consistency`（單一來源守門） |

### 重複邏輯合併（單一來源，並加守門）
- `WORKER_IMPORT_TRANSFORMERS`：辨識與說話者分割 Worker 共用「主 CDN → 備援 CDN」載入器（原本兩份，說話者分割版兩個 CDN 都失敗時只丟原始英文錯誤）。
- `spawnWorker`：三處 Blob Worker 建立共用，建構失敗時也會撤銷 Blob URL。
- `decodeFileToBuffer`＋`mixToMono`：辨識（16 kHz）與 UVR（44.1 kHz）共用解碼與多聲道降混（UVR 的 >2 聲道降混改為與辨識路徑相同的「先加總再除」，數值差異在浮點誤差內）。
- `idbGet/idbPut`：見上表 7。

### 孤兒碼
`startBtn` 內只寫不讀的 `results` 陣列（還會讓整批結果的內容多留在記憶體）、`updateEta` 的 `fmtSec` 別名、過期的「第 2897 行」註解、只剩一個呼叫點的 `resampleMono`、`check-consistency` 的 `iconsDir` 參數（以 `void` 壓警告）、因缺陷 2 而不再需要的 `strideSec` 協定欄位、`uvrIdbGet/uvrIdbPut`。ESLint 另確認：沒有未使用的變數、函式、參數，沒有未定義名稱；HTML id、CSS class 無孤兒（`log-*` 為動態組字串）。

### 效能
量測 `uvrCreateDsp`：60 秒立體聲音訊的 STFT／iSTFT 約 3.7 秒（每 5.9 秒音訊一塊約 335 ms；7680 點 FFT 約 0.54 ms），真模型在 WASM 上每塊需數秒到數十秒，DSP 只佔約 1～2%，**不是熱點，未改動**。本輪沒有為了「看起來更快」而改動沒有量到問題的程式碼。

### 測試異動
- 新增 `tests/round14-review.spec.ts`（TR14-01～07）、`round13-uvr` 的 **U-15a**（真實 ORT-web，完整流程）、`dist-csp` 的 **TB-05**（真實 ORT-web 在 CSP 下於 blob Worker 推論，Worker 內零 CSP 違規）。
- `round13-uvr` 的 `setup()` 固定 `navigator.deviceMemory = 8`：原本測試隱性依賴主機 RAM，沙盒的 Chromium 回報 ≤ 4 時 UVR 會被（正確地）判為低記憶體而略過，U-07 等會誤失敗。
- U-06 改以 `resampleChannels([x])` 比對 v23.2 的單聲道實作（`resampleMono` 包裝已移除）。
- `playwright.config.ts` 的 functional 範圍納入 `round13`／`round14`；`package.json` 新增 devDependency `onnxruntime-web@1.30.0`（釘死，須與 `ONNX_WASM_CDN` 同版）；`tests/harness.ts` 新增 `routeRealOrt`。

### 驗證結果與未驗證項目
**驗證結果（沙盒：Chromium 153，4 GB RAM；逐檔執行，每次都在打包後的副本上跑）**
- functional 共 142 項。最後一輪（11 個 spec 檔，除 `round11-freeze` 外全部）118 項：**115 通過、3 略過、退出碼 0**；略過者為 `U-14`、`U-15`×2，需 `UVR_MODEL_PATH` 指向真正的 Kim_Vocal_2.onnx 才執行。`round11-freeze` 24 項（輸出與 v23.2 逐字相同）在較早的完整逐檔跑通過，之後 `index.html` 只再改了 `idbPut` 的一行（`onabort` 的 reject 值）。
- 本輪新增 9 項（TR14-01～07、U-15a、TB-05）。其中 TR14-01～05、TR14-07、U-15a 已在原版 r6 上實際執行並確認失敗，修正後通過；TB-05（真實 ORT 在 CSP 下）與 TR14-06（往返）是覆蓋新增的執行路徑，未對原版做紅燈驗證。
- `npm run check`（5 項）通過；ESLint（`no-unused-vars`、`no-undef`）對 `index.html` 三段 script 與三個 Worker 樣板字串零警告。
- perf：TF-12／13／16／17 與 TM-05（4 分鐘立體聲、10 分鐘單聲道、10 分鐘立體聲 IDB 分片）共 6 項通過；TM-05 的 1 小時單聲道項**未完成**——失敗點在凍結的 v23.2 對照版那一側（`peakMB(…,'old',…)`，超過單項 900 秒上限），尚未執行到 r7 的程式碼，原因推測是沙盒只有 4 GB RAM，未另行確認。perf 在 `idbPut` 與解碼改動之後沒有重跑。
- spike 版：以「新主線 ＋ 原 spike 差異」重建，`index.html`、`sw.js` 的差異內容與 r6 的 spike 版逐行相同（`patch` 全部套用成功、無 `.rej`）。最後一輪 spike 驗證（`round11-spike-coi`、`round14`、`round13`、`dist-csp`）：53 通過、3 略過、1 失敗（下述既有不穩定測試）；修正該測試後單獨重跑 `dist-csp` 12 項全過。

**兩個既有的不穩定測試（與本輪改動無關，已量化）**
- `round12` 的 TR-07（1 小時音訊、約 220 MB 寫入 IndexedDB）：沙盒內偶發寫入失敗。同一環境各跑 8 次——原版 r6 失敗 3 次，全部是「等到 120 秒逾時」（交易中止後 Promise 永不結束，即上表第 7 項）；r7 失敗 2 次，皆立即失敗並走既有的「降級使用記憶體模式」。r7 把「卡死」變成「依設計降級」，但該測試要求寫入成功，所以失敗仍會發生；最後一輪完整驗證中它通過。另一組 8 次對照因沙盒重啟而遺失，只有一組數據。
- `dist-csp` 的「CSP 確實生效」對照組：頁面註冊的 Service Worker 攔截探針腳本請求，使 `page.route()` 的替身回應不被採用。原版 r6 重複 40 次失敗 20 次（r7 為 15～18 次，spike 版 12 次、原 spike 16 次）。已在該 describe 加 `test.use({ serviceWorkers: 'block' })`（檔內另有兩處同樣作法），原版、r7 主線、r7 spike 版各 40/40 通過。

仍未驗證：真實 Kim_Vocal_2 在瀏覽器內的端到端結果（模型取不到）；多執行緒（`crossOriginIsolated`）下的 ORT-web；WebGPU 路徑；Silero VAD 以真實 CDN 載入。說話者分割的說話者編號在每個 10 秒視窗內是局部的，跨視窗不保證一致（設計限制，未改）。

