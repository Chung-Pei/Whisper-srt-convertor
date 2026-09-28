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
