# 🎙️ Whisper 離線字幕產生器

<div align="center">

![Version](https://img.shields.io/badge/version-16-brightgreen)
![License](https://img.shields.io/badge/license-MIT-blue)
![Platform](https://img.shields.io/badge/platform-Browser-orange)
![Offline](https://img.shields.io/badge/offline-100%25-success)
![No Backend](https://img.shields.io/badge/backend-none-lightgrey)

**單一 HTML 檔案 · 完全離線 · 零資料外傳**  
基於 OpenAI Whisper + Transformers.js 3.5.2，無需伺服器、無需帳號

[快速開始](#-快速開始) · [功能特色](#-功能特色) · [常見問題](#-常見問題)

</div>

---

## 📖 簡介

所有音訊處理皆在本機瀏覽器內完成，不呼叫任何外部 API，適合處理含隱私或機密內容的音訊。

```
音訊檔案 → 瀏覽器（Whisper ONNX） → 字幕檔
              ↑ 完全本機，零資料外傳
```

---

## ✨ 功能特色

### 語音模型

| 模型 | 大小 | 適用情境 |
|------|------|----------|
| `tiny` | ~75 MB | 快速草稿、低記憶體 |
| `base` | ~145 MB | 日常平衡選擇 |
| `small` | ~460 MB | 較高精度 |
| `medium` | ~1.5 GB | 高精度 |
| `large-v3-turbo` ⚡ | ~1.6 GB | 最高精度，支援 WebGPU |

### 核心功能

- **WebGPU 加速**：自動偵測並啟用，不支援時降級至 WASM
- **自動量化**：依記憶體自動選 fp32 / q8 / q4，壓縮至 400–800 MB
- **雙層模型快取**：File System Access API 資料夾 + IndexedDB 備援
- **批次辨識**：多檔拖放依序處理，支援中途取消
- **⚡ 斷點續傳**：頁面意外關閉後，重開可從中斷段落繼續
- **指定輸出資料夾**：批次完成後自動寫檔，免手動下載
- **🔒 Wake Lock 防休眠**：辨識進行中自動鎖定螢幕常亮，防止行動裝置休眠中斷辨識；不支援的瀏覽器靜默略過

### 🎛️ 音訊前處理

| 功能 | 說明 |
|------|------|
| Silero VAD v5 | 跳過靜音，消除幻覺字幕，節省 20–40% 推論時間 |
| 音訊正規化 | Peak Normalization -1 dBTP，降低漏字率 |
| 人聲分離（UVR）| MDX-Net Kim_Vocal_2，去除背景音樂後再辨識 |

### ✦ 智慧後處理（10 項可選）

**排版**：合併短行 / 分割長行  
**時間軸**：修正重疊（預設啟用）/ 修正過短顯示時間  
**文字**：自動補全句號 / 修正英文大小寫  
**術語**：醫學專有名詞標注 + 自訂詞典（JSON / CSV / TSV 匯入匯出）  
**精準度**：注音聲學模糊匹配 v2（預設啟用）/ 幻覺偵測  
**進階**：說話者標籤 Diarization `實驗性`（~18 MB 模型）

### 語言與格式

- **辨識語言**：中文（繁/簡）/ English / 日本語 / 한국어 / 自動偵測
- **翻譯模式**：直接輸出英文字幕
- **輸出格式**：SRT / WebVTT / TXT / Markdown

---

## 🚀 快速開始

> ⚠️ **必須透過 HTTP/HTTPS 開啟**，直接雙擊 `file://` 會導致模型無法載入。

```bash
# 方法一：Python
python -m http.server 8080
# → http://localhost:8080/whisper-srt-v16.html

# 方法二：Node.js
npx serve .

# 方法三：VS Code → 右鍵 → Open with Live Server
```

GitHub Pages：Settings → Pages → main branch，啟用後直接使用 HTTPS 網址。

---

## 📋 操作流程

1. 選擇語音模型（首次使用建議 `tiny`）
2. （選用）指定模型快取資料夾，避免重複下載
3. 拖放音訊 / 影片檔案（支援多選批次）
4. 調整前處理（VAD、音訊正規化、人聲分離）與後處理選項
5. 選擇輸出格式與輸出資料夾
6. 點擊 **▶ 開始辨識**，辨識期間螢幕將自動保持常亮

**斷點續傳**：重開頁面後出現提示橫幅 → 點「恢復任務」→ 重新選取相同檔案即可繼續。

---

## ⚙️ 系統需求

| 模型 | 最低 RAM | 建議 RAM |
|------|---------|---------|
| tiny / base | 2 GB | 4 GB+ |
| small | 3 GB | 6 GB+ |
| medium / large-v3-turbo | 6 GB | 8 GB+ |

- **瀏覽器**：Chrome / Edge 94+（建議最新版）
- Firefox 不支援 File System Access API，資料夾功能不可用，辨識功能正常。
- Wake Lock 需 Chrome 84+ / Edge 84+ / Safari 16.4+；iOS 鎖定螢幕仍會強制釋放，解鎖後自動恢復。

---

## 📱 行動裝置注意事項

| 裝置 | Wake Lock 行為 |
|------|--------------|
| 桌機 / 筆電 | 辨識中螢幕不休眠，完整保障 |
| Android Chrome | 完整支援，辨識中螢幕常亮 |
| iPhone / iPad（Safari 16.4+）| 螢幕鎖定後自動釋放，解鎖後自動重新啟用 |
| 不支援的瀏覽器 | 靜默略過，不影響辨識功能，建議手動保持螢幕常亮 |

---

## 🔧 技術堆疊

| 元件 | 版本 | 用途 |
|------|------|------|
| Transformers.js | 3.5.2 | Whisper ONNX 推論 |
| Silero VAD | v5 | 靜音偵測 |
| onnxruntime-web | 1.22.0 | VAD WASM 後端 |
| onnxruntime-web | 1.18.0 | UVR 人聲分離 WASM 後端 |
| @ricky0123/vad-web | 0.0.30 | VAD 整合封裝 |
| Screen Wake Lock API | — | 防止辨識中休眠 |

所有推論均在 **Web Worker** 中執行，不阻塞主執行緒 UI。Worker 錯誤（CDN 載入失敗、WASM 初始化異常）均會攔截並顯示於介面 log，不會以 `Uncaught Error` 形式出現於瀏覽器 console。

---

## ❓ 常見問題

**Q：頁面顯示警告無法開啟？** → 改用 HTTP 伺服器，勿直接雙擊 HTML。  
**Q：模型下載失敗？** → 重整再試；建議指定本機快取資料夾。  
**Q：字幕語言辨識錯誤？** → 手動指定語言，不要用「自動偵測」。  
**Q：分頁崩潰？** → 記憶體不足，改用較小模型或關閉其他分頁。  
**Q：時間碼有誤？** → 開啟後處理「修正時間軸重疊」。  
**Q：醫學術語辨識不準？** → 開啟「醫學專有名詞標注」並新增自訂詞典。  
**Q：看到「偵測到未完成任務」？** → 點「恢復任務」並重新選取相同音訊檔案。  
**Q：手機辨識到一半螢幕暗掉？** → v16 已內建 Wake Lock 防休眠；iOS 鎖定螢幕後解鎖即自動恢復，辨識不中斷。  
**Q：console 出現錯誤訊息？** → v16 已將所有 Worker 錯誤轉為介面 log 顯示，如仍有問題請確認網路連線及 CDN 可存取性。

---

## 📜 版本紀錄

| 版本 | 主要更新 |
|------|---------|
| v16 | Wake Lock 防休眠（行動裝置辨識保障）、Worker 全域錯誤攔截、UVR importScripts 容錯處理 |
| v15 | Transformers.js 3.5.2、動態記憶體調適、斷點續傳 |

---

## 📜 授權

MIT License · Whisper © [OpenAI](https://openai.com/research/whisper) · Transformers.js © [Hugging Face](https://huggingface.co/docs/transformers.js)

---

<div align="center">

**完全離線 · 零資料外傳 · 無需帳號 · 斷點續傳 · 智慧後處理 · Wake Lock 防休眠**  
Made with ❤️ using [Transformers.js](https://huggingface.co/docs/transformers.js) + OpenAI Whisper

</div>
