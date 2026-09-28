# 🎙️ Whisper 離線字幕產生器

<div align="center">

![Version](https://img.shields.io/badge/version-22.4-brightgreen)
![License](https://img.shields.io/badge/license-MIT-blue)
![Platform](https://img.shields.io/badge/platform-Browser-orange)
![Offline](https://img.shields.io/badge/offline-100%25-success)
![No Backend](https://img.shields.io/badge/backend-none-lightgrey)
![PWA](https://img.shields.io/badge/PWA-installable-blueviolet)

**單一 HTML 檔案 · 完全離線 · 零資料外傳 · 可安裝為 PWA**  
基於 OpenAI Whisper + Transformers.js 4.3.0，無需伺服器、無需帳號

[快速開始](#-快速開始) · [功能特色](#-功能特色) · [常見問題](#-常見問題)

最後更新：2026-09-27

</div>

---

## 📖 簡介

所有音訊處理皆在本機瀏覽器內完成，不呼叫任何外部 API，適合處理含隱私或機密內容的音訊。安裝為 PWA 後，介面本身可離線開啟（辨識新音訊仍需先下載一次模型）。

```
音訊檔案 → 瀏覽器（Whisper ONNX） → 字幕檔
              ↑ 完全本機，零資料外傳
```

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

- **WebGPU 加速**：自動偵測並啟用，不支援時降級至 WASM
- **自動量化**：依可用記憶體自動選 fp32 / q8 / q4，壓縮至 400–800 MB
- **動態記憶體調適**：記憶體監控貫穿整個批次處理過程，非僅第一個檔案
- **雙層模型快取**：File System Access API 資料夾 + IndexedDB 備援
- **批次辨識**：多檔拖放依序處理，支援中途取消
- **⚡ 斷點續傳**：頁面意外關閉後，重開可從中斷段落繼續
- **指定輸出資料夾**：批次完成後自動寫檔，免手動下載
- **🔒 Wake Lock 防休眠**：辨識進行中自動鎖定螢幕常亮；不支援的瀏覽器會顯示提示但不影響辨識
- **👁 字幕即時預覽**：完成項目可展開預覽面板，於影片／音訊上即時檢視字幕疊圖，調整字級與垂直位置

### 🎛️ 音訊前處理

| 功能 | 說明 |
|------|------|
| Silero VAD v5 | 跳過靜音，消除幻覺字幕，節省 20–40% 推論時間 |
| 音訊正規化 | Peak Normalization -1 dBTP，降低漏字率 |
| 人聲分離（UVR）| MDX-Net Kim_Vocal_2，去除背景音樂後再辨識（首次需下載 ~63MB 模型） |

### ✦ 智慧後處理（11 項可選）

**排版**：合併短行 / 分割長行  
**時間軸**：修正重疊（預設啟用）/ 修正過短顯示時間  
**文字**：自動補全句號 / 修正英文大小寫  
**簡繁**：簡體轉台灣正體（opencc-js，預設啟用，於醫學詞典比對前執行）  
**術語**：醫學專有名詞標注 + 自訂詞典（JSON / CSV / TSV 匯入匯出）  
**精準度**：注音聲學模糊匹配 v2（預設啟用）/ 幻覺偵測  
**進階**：說話者標籤 Diarization `實驗性`（~18 MB 模型）

### 語言與格式

- **辨識語言**：中文（繁/簡）/ English / 日本語 / 한국어 / 自動偵測
- **翻譯模式**：直接輸出英文字幕
- **輸出格式**：SRT / WebVTT / ASS / 純文字 (.txt) / Markdown（預覽面板調整的字級與位置僅寫回 ASS／VTT，SRT／TXT／MD 不受影響）

---

## 🚀 快速開始

> ⚠️ **必須透過 HTTP/HTTPS 開啟**，直接雙擊 `file://` 會導致模型與 Service Worker 無法運作。

```bash
# 方法一：Python
python -m http.server 8080
# → http://localhost:8080/

# 方法二：Node.js
npx serve .

# 方法三：VS Code → 右鍵 → Open with Live Server
```

GitHub Pages：將 `index.html`、`sw.js`、`manifest.json`、`icons/` 推送至 repo 根目錄 → Settings → Pages 啟用後，直接使用 HTTPS 網址（本專案設計為根目錄部署）。

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
- 每次更新部署內容後，請同步遞增 `sw.js` 內的 `CACHE_VERSION`，否則使用者瀏覽器可能因快取看不到更新

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
| v22 系列（v22 → v22.4）| 簡繁正規化（opencc-js）、WebGPU 相容測試模型、字幕即時預覽面板、PWA 根目錄部署修正、多輪穩定性與發布就緒度稽核。逐輪詳細紀錄見 [`CHANGELOG_v22.md`](./CHANGELOG_v22.md) |
| v16 | Wake Lock 防休眠（行動裝置辨識保障）、Worker 全域錯誤攔截、UVR importScripts 容錯處理 |
| v15 | Transformers.js 3.5.2、動態記憶體調適、斷點續傳 |

---

## 📁 專案結構

```
.
├── index.html         # 主程式（單一自包含檔案：UI + 3 個 Worker 樣板字串）
├── sw.js               # Service Worker（離線快取策略）
├── manifest.json       # PWA manifest
├── icons/              # PWA / Apple touch 圖示
├── tests/               # Playwright 測試腳本與測試素材
└── CHANGELOG_v22.md    # v22 系列逐輪稽核紀錄
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
