# 🎙️ Whisper 離線字幕產生器

<div align="center">

![Version](https://img.shields.io/badge/version-v24-brightgreen)
![License](https://img.shields.io/badge/license-MIT-blue)
![Platform](https://img.shields.io/badge/platform-Browser-orange)
![Offline](https://img.shields.io/badge/offline-100%25-success)
![No Backend](https://img.shields.io/badge/backend-none-lightgrey)
![PWA](https://img.shields.io/badge/PWA-installable-blueviolet)

**單一 HTML 檔案 · 完全離線 · 零資料外傳 · 可安裝為 PWA**  
基於 OpenAI Whisper + Transformers.js 4.3.0，無需伺服器、無需帳號

[快速開始](#-快速開始) · [功能特色](#-功能特色) · [常見問題](#-常見問題)

最後更新：2026-10-22

</div>

---

## 📖 簡介

在瀏覽器中使用 Whisper AI 模型進行離線語音辨識與字幕產生，**音訊與影片檔案完全不會上傳至任何伺服器**——所有運算（模型下載後）都在使用者本機瀏覽器內完成。可安裝為 PWA，安裝後支援離線使用。

```
音訊檔案 → 瀏覽器（Whisper ONNX） → 字幕檔
              ↑ 完全本機，零資料外傳
```

唯一的網路存取是首次下載所選 Whisper 模型（來自 Hugging Face / jsDelivr / unpkg CDN），下載後由瀏覽器快取，離線可重複使用。

---

## ✨ 功能特色

### 語音模型

| 模型 | 大小 | 適用情境 |
|------|------|----------|
| `base` | ~145 MB | 日常平衡選擇（首次使用預設） |
| `small` | ~460 MB | 較高精度 |
| `medium` | ~1.5 GB | 高精度 |
| `large-v3-turbo` ⚡ | ~1.6 GB | 最高精度，支援 WebGPU |
| `large-v3-turbo WebGPU 相容版` 🧪 `實驗性` | ~1.6 GB | 測試性模型，用於評估 WebGPU 相容性，尚未如其餘模型完整驗證 |

### 核心功能

- **批次處理**：一次拖入多個音訊／視訊檔案，逐一排隊處理，支援中途取消與斷點續傳
- **⚡ 斷點續傳**：頁面意外關閉後，重開可從中斷段落繼續
- **指定輸出資料夾**：批次完成後自動寫檔，免手動下載
- **WebGPU 加速**：自動偵測並啟用，不支援時降級至 WASM
- **自動量化**：依可用記憶體自動選 fp32 / q8 / q4，壓縮至 400–800 MB
- **動態記憶體調適**：記憶體監控貫穿整個批次處理過程，非僅第一個檔案
- **雙層模型快取**：File System Access API 資料夾 + IndexedDB 備援
- **🔒 Wake Lock 防休眠**：辨識進行中自動鎖定螢幕常亮；不支援的瀏覽器會顯示提示但不影響辨識
- **👁 字幕即時預覽**：完成項目可展開預覽面板，於影片／音訊上即時檢視字幕疊圖，調整字級與垂直位置

### 🎛️ 音訊前處理

| 功能 | 說明 |
|------|------|
| Silero VAD v5 | 跳過靜音，消除幻覺字幕，節省 20–40% 推論時間 |
| 音訊正規化 | Peak Normalization -1 dBTP，降低漏字率 |
| 人聲分離（UVR，選用、預設關）| MDX-Net Kim_Vocal_2，去除背景音樂後再辨識（首次需下載 ~64MB 模型；**很慢**，耗時為音訊長度的數倍；低記憶體裝置不提供）。單檔模式可另外下載人聲 WAV |

### ✦ 智慧後處理

**排版**：合併短行 / 分割長行  
**時間軸**：修正重疊（預設啟用）/ 修正過短顯示時間  
**文字**：自動補全句號 / 修正英文大小寫  
**簡繁**：簡體轉台灣正體（opencc-js，預設啟用，於醫學詞典比對前執行）  
**術語**：醫學專有名詞標注 + 自訂詞典（JSON / CSV / TSV 匯入匯出）  
**精準度**：注音聲學模糊匹配 v2（預設啟用，相似度門檻預設 0.75，可於「後處理」面板調整）/ 幻覺偵測  
**進階**：說話者標籤 Diarization `實驗性`（~18 MB 模型）/ 逐字時間戳

### 語言與格式

- **辨識語言**：中文（繁/簡）/ English / 日本語 / 한국어 / 自動偵測
- **翻譯模式**：直接輸出英文字幕
- **輸出格式**：SRT / WebVTT / ASS / 純文字 (.txt) / Markdown（預覽面板調整的字級與位置僅寫回 ASS／VTT，SRT／TXT／MD 不受影響）

---

## 🚀 快速開始

> ⚠️ **必須透過 HTTP/HTTPS 開啟**，直接雙擊 `file://` 會導致模型與 Service Worker 無法運作。

```bash
# 任一種本機伺服器皆可，例如：
npx serve .
# 或
python -m http.server 8080
```

以瀏覽器開啟後即可使用（此為原始碼直接執行，**不含** CSP；CSP 只在建置產物 `dist/` 內注入）。**不建議以 `file://` 直接開啟**——Service Worker／PWA 安裝在 `file://` 協定下無法正常運作，請務必透過 HTTP(S) 伺服器存取。

---

## 🌐 部署到 GitHub Pages

本專案透過 GitHub Actions 自動建置並部署（設定檔：`.github/workflows/deploy.yml`）。日常只需 `git push` 到 `main`，不需手動處理任何檔案：

1. 一次性設定：repo Settings → Pages → Build and deployment → Source 選擇 **GitHub Actions**
2. 之後每次 push 到 `main`，Actions 依序執行：圖示一致性檢查（`scripts/check-consistency.mjs`）→ 建置（`scripts/build.mjs`）→ 部署 `dist/`
3. 建置時自動完成兩件事：(a) 為 `index.html` 注入 Content-Security-Policy（含 3 段內嵌 `<script>` 的 SHA-256 hash）；(b) 產生 `sw.js` 的 `CACHE_VERSION`（UTC，格式 `YYYYMMDD-HHmm`），**不需手動遞增**

`dist/` 不進版控（已列入 `.gitignore`），只存在於 CI 執行期間。

---

## 📋 操作流程

1. 選擇語音模型（首次使用預設 `base`）
2. （選用）指定模型快取資料夾，避免重複下載
3. 拖放音訊 / 影片檔案（支援多選批次）
4. 調整前處理（VAD、音訊正規化、人聲分離）與後處理選項
5. 選擇輸出格式與輸出資料夾
6. 點擊 **▶ 開始辨識**，辨識期間螢幕將自動保持常亮
7. 完成後點項目旁的 **👁 預覽**，可在影片／音訊上檢視字幕疊圖並用滑桿微調字級與位置（僅 ASS／VTT 會寫入匯出檔）

**斷點續傳**：重開頁面後出現提示橫幅 → 點「恢復任務」→ 重新選取相同檔案即可繼續。

---

## ⚙️ 系統需求

- **瀏覽器**：Chrome / Edge（建議最新版；需支援 WebAssembly、Web Worker、IndexedDB）
- Firefox 不支援 File System Access API，模型快取資料夾與輸出資料夾功能不可用，辨識功能仍正常。
- **首次使用需連線下載所選模型**（模型下載後由瀏覽器快取，離線可重複使用同一模型）
- **記憶體**：本工具具備「動態記憶體調適」，會依可用記憶體自動調整模型量化精度：
  - `large-v3-turbo` 系列（含 WebGPU 相容版）：建議系統記憶體 ≥ 8GB，執行時需 3–4GB 可用 RAM，不足時自動壓縮模型至約 400–800MB
  - `base` / `small` / `medium`：需求遠低於 large-v3-turbo 系列，一般現代裝置可正常執行
- **Wake Lock**：需 Chrome / Edge 84+、Safari 16.4+（含 iOS）；iOS 鎖定螢幕時系統會強制釋放，解鎖後自動重新啟用。

---

## 📱 行動裝置注意事項

| 裝置 | Wake Lock 行為 |
|------|--------------|
| 桌機 / 筆電 | 辨識中螢幕不休眠 |
| Android Chrome | 完整支援，辨識中螢幕常亮 |
| iPhone / iPad（Safari 16.4+）| 螢幕鎖定後系統強制釋放，解鎖後自動重新啟用 |
| 不支援的瀏覽器 | 顯示提示但不影響辨識功能，建議手動保持螢幕常亮 |

---

## 🔧 技術堆疊

| 元件 | 版本 | 用途 |
|------|------|------|
| Transformers.js | 4.3.0 | Whisper ONNX 推論 |
| Silero VAD | v5 | 靜音偵測 |
| onnxruntime-web | 1.30.0 | WASM／WebGPU 推論後端（VAD、UVR 共用同一版本）|
| @ricky0123/vad-web | 0.0.31 | VAD 整合封裝 |
| opencc-js | 1.4.2 | 簡繁中文正規化 |
| JSZip | 3.10.2 | 批次結果打包下載 |
| Screen Wake Lock API | — | 防止辨識中休眠 |

所有推論均在 **Web Worker** 中執行，不阻塞主執行緒 UI；Worker 例外狀況會攔截後顯示於介面 log。

---

## 📦 PWA 安裝

本專案內含 `manifest.json` 與 Service Worker（`sw.js`），支援安裝為獨立 App：

- 桌機 Chrome / Edge：網址列出現安裝圖示，或選單「安裝應用程式」
- Android Chrome：選單「加入主畫面」
- 安裝後介面本身可離線開啟；**辨識新音訊仍需網路連線下載一次所選模型**，下載後由瀏覽器快取供離線重複使用

---

## 🛠 開發與測試

指令以 Windows PowerShell（Windows 11）為準。

```powershell
npm install                      # 安裝 @playwright/test、serve 等 devDependencies
npx playwright install chromium
npm run check                    # 一致性檢查（圖示三處一致、預設值單一來源等）
npm run build                    # 產生 dist/（注入 CSP、寫入 CACHE_VERSION）
npm run test:functional           # 離線功能測試（需先 npm run build）
```

---

## ❓ 常見問題

**Q：頁面顯示警告無法開啟？** → 改用 HTTP 伺服器，勿直接雙擊 HTML。  
**Q：模型下載失敗？** → 重整再試；建議指定本機快取資料夾。  
**Q：字幕語言辨識錯誤？** → 手動指定語言，不要用「自動偵測」。  
**Q：分頁崩潰？** → 記憶體不足，改用較小模型或關閉其他分頁。  
**Q：時間碼有誤？** → 確認後處理「修正時間軸重疊」是否已啟用（預設開啟）。  
**Q：醫學術語辨識不準？** → 開啟「醫學專有名詞標注」並新增自訂詞典。  
**Q：簡體字沒有自動轉繁體？** → 確認「簡繁正規化」是否已開啟（預設開啟）。  
**Q：如何調整字幕在畫面上的大小與位置？** → 完成後點「👁 預覽」展開面板拖動滑桿；僅 ASS／VTT 格式會把調整結果寫入匯出檔。  
**Q：看到「偵測到未完成任務」？** → 點「恢復任務」並重新選取相同音訊檔案。  
**Q：手機辨識到一半螢幕暗掉？** → 已內建 Wake Lock 防休眠；iOS 鎖定螢幕後解鎖即自動恢復，辨識不中斷。  
**Q：`large-v3-turbo WebGPU 相容版` 可以直接用嗎？** → 標示 🧪 為實驗性測試模型，建議先以其他模型為主，待相容性更明確後再採用。

---

## 📜 版本紀錄

| 版本 | 主要更新 |
|------|---------|
| **v24** | GitHub Actions 自動建置部署；dist 版 Content-Security-Policy 強化（含 Hugging Face 轉址主機白名單）；記憶體分級與錯誤驅動降級（依裝置分級決定模型 dtype，失敗依錯誤類型重試）；UVR 人聲分離（MDX-Net）；注音聲學模糊匹配 v2＋醫學術語自訂詞典；逐字時間戳；測試覆蓋 round9～round14（含真實 ORT 人聲分離測試） |
| v22 系列（v22 → v22.4）| 簡繁正規化（opencc-js）、WebGPU 相容測試模型、字幕即時預覽面板、PWA 根目錄部署修正、多輪穩定性與發布就緒度稽核。逐輪詳細紀錄見 [`CHANGELOG_v22.md`](./CHANGELOG_v22.md) |
| v16 | Wake Lock 防休眠（行動裝置辨識保障）、Worker 全域錯誤攔截、UVR importScripts 容錯處理 |
| v15 | Transformers.js 3.5.2、動態記憶體調適、斷點續傳 |

---

## 📁 專案結構

```
.
├── index.html          # 主程式（單一自包含檔案：UI + 3 個 Worker 樣板字串）
├── sw.js                # Service Worker（離線快取策略）
├── manifest.json         # PWA manifest
├── icons/                # PWA / Apple touch 圖示
├── scripts/              # check-consistency.mjs（一致性檢查）、build.mjs（CSP＋CACHE_VERSION＋產出 dist/）
├── tests/                # Playwright 測試（functional／perf／network 三個 project）
├── .github/workflows/    # deploy.yml：push main → 檢查 → 建置 → 部署 GitHub Pages
├── package.json
├── LICENSE               # MIT
└── CHANGELOG_v22.md      # v22 系列逐輪稽核紀錄
```

---

## 📜 授權

MIT License

Whisper © [OpenAI](https://openai.com/research/whisper) · Transformers.js © [Hugging Face](https://huggingface.co/docs/transformers.js)

---

<div align="center">

**完全離線 · 零資料外傳 · 無需帳號 · PWA 可安裝 · 斷點續傳 · 智慧後處理 · Wake Lock 防休眠**  
Made with ❤️ using [Transformers.js](https://huggingface.co/docs/transformers.js) + OpenAI Whisper

</div>
