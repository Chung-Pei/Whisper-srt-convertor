# 🎙️ Whisper 離線字幕產生器

<div align="center">

![Version](https://img.shields.io/badge/version-6.0-brightgreen)
![License](https://img.shields.io/badge/license-MIT-blue)
![Platform](https://img.shields.io/badge/platform-Browser-orange)
![Offline](https://img.shields.io/badge/offline-100%25-success)
![No Backend](https://img.shields.io/badge/backend-none-lightgrey)
![PWA](https://img.shields.io/badge/PWA-supported-blueviolet)

**完全在瀏覽器內運行的 AI 語音辨識字幕工具**  
基於 OpenAI Whisper + Transformers.js，不需伺服器、不上傳任何資料  
支援 PWA 安裝，可釘選至 iPhone / Android 主畫面離線使用

[快速開始](#-快速開始) · [功能特色](#-功能特色) · [支援格式](#-支援格式) · [建議裝置](#-建議作業系統與裝置) · [PWA 安裝](#-pwa-安裝至主畫面) · [常見問題](#-常見問題)

</div>

---

## 📖 專案簡介

本工具是一個**單一 HTML 檔案**的離線字幕產生器，利用 [Transformers.js](https://huggingface.co/docs/transformers.js) 將 OpenAI Whisper 語音辨識模型直接執行於瀏覽器內。

所有音訊處理皆在**本機端完成**，不呼叫任何外部 API，不傳送任何資料至伺服器，適合處理含有隱私或機密內容的音訊。

```
音訊檔案 → 瀏覽器（Whisper ONNX 模型） → 字幕檔
              ↑ 完全本機處理，零資料外傳
```

---

## ✨ 功能特色

### 🔒 隱私優先、完全離線
- 音訊資料**永不離開本機**，無任何網路請求（模型下載後即可斷網使用）
- 不依賴任何第三方 API 金鑰或帳號
- 適合處理會議錄音、私人影片等敏感內容

### 🤖 多種 Whisper 模型可選
| 模型 | 大小 | 適用情境 |
|------|------|----------|
| `tiny` | ~75 MB | 快速草稿、低記憶體裝置 |
| `base` | ~145 MB | 日常使用的平衡選擇 |
| `small` | ~460 MB | 較高精度需求 |
| `medium` | ~1.5 GB | 高精度辨識 |
| `large-v3-turbo` ⚡ | ~1.6 GB | 最高精度，支援 WebGPU 加速 |

### ⚡ WebGPU 硬體加速
- 自動偵測瀏覽器是否支援 WebGPU
- 支援時優先啟用 GPU 加速（encoder `fp16` + decoder `q4`），顯著提升推論速度
- 不支援時自動降級至 WebAssembly（WASM）後端

### 🧠 自動量化（Auto Quantization）
系統依照可用記憶體自動選擇最佳精度：
- 記憶體充裕 → `fp32`（全精度）
- 記憶體適中 → `q8`（8-bit 量化）
- 記憶體不足 → `q4`（4-bit 量化，約壓縮至 400–800 MB）

### 📂 雙層模型快取機制
1. **File System Access API 資料夾快取**：指定本機資料夾後，模型檔案直接儲存於磁碟，重整頁面後免重新下載，不受瀏覽器 IndexedDB 清除影響
2. **IndexedDB 瀏覽器快取**：未指定資料夾時的備選方案，儲存於瀏覽器內部快取

### 🗂️ 批次辨識
- 支援一次拖放或選取**多個媒體檔案**，加入佇列後依序自動處理
- 每個檔案獨立顯示辨識狀態（等待中 / 辨識中 / 完成 / 失敗 / 已取消）
- 批次完成後顯示統計摘要（完成數 / 失敗數 / 取消數）
- 可中途取消整個批次，已完成項目保留結果

### 📁 自動儲存至指定資料夾
- 可透過 File System Access API 指定**輸出資料夾**
- 批次辨識完成後自動將字幕檔儲存至指定位置，免手動逐一下載

### 🌐 多語言支援
- 中文（繁體 / 簡體自動辨識）
- English
- 日本語
- 한국어
- 自動偵測語言

### 🔄 翻譯模式
除原語言轉錄外，支援**翻譯成英文**（Whisper translate task）

### 🛠️ 智慧後處理（V6 新增）
辨識設定下方提供可折疊的**智慧後處理**區塊，顯示已啟用項目數量 badge，共 6 大功能可獨立開關：

| 功能 | 預設 | 說明 |
|------|------|------|
| **合併短行** | 關 | 可調最大字數（預設 20）與最大間隔秒數（預設 0.5s），將過短字幕段落合併 |
| **分割長行** | 關 | 可調單行最大字數（預設 25），從標點 → 空格 → 中間依序嘗試切割 |
| **修正時間軸重疊** | ✅ 啟用 | 自動修正 start > end 及相鄰段落時間重疊問題 |
| **修正過短顯示時間** | 關 | 可調最短秒數（預設 0.8s），有防呆機制，不覆蓋下一句時間 |
| **自動補全句號** | 關 | 依語言自動選擇全形（中日韓）或半形（英文）句號 |
| **修正英文大小寫** | 關 | 強制句首字母大寫 |

#### 🏥 醫學專有名詞標注（V6 新增）
- 內建 **70+ 條預設詞典**，涵蓋心臟科、神經科、呼吸科、腫瘤科等多科別
- 開啟後顯示詞典編輯器，支援**行內編輯**、新增、刪除
- **一鍵還原預設**，不怕誤改

**詞典匯入 / 匯出（多格式支援）：**

| 格式 | 副檔名 | 說明 |
|------|--------|------|
| JSON | `.json` | 標準程式格式，完整保留所有欄位 |
| CSV | `.csv` | 自動加 BOM，Excel 可直接開啟並正確顯示中文 |
| TSV | `.tsv` | 適合從 Excel「另存為 TSV」使用 |

- **匯出**：選好格式後一鍵下載
- **匯入**：依副檔名自動判斷格式（`.json` / `.csv` / `.tsv` / `.txt`），CSV 支援引號包覆與逗號跳脫；若自動判斷失敗，自動改用 Tab 分隔再試一次
- **CSV 欄位順序**：`原始字（| 分隔）, 標準中文術語, 英文對照`

### 📱 PWA — 可安裝至主畫面
本工具支援 Progressive Web App（PWA）規範：
- **iOS（Safari）**：加入主畫面後以全螢幕 App 模式啟動，無瀏覽器 UI
- **Android（Chrome）**：支援「安裝應用程式」提示，體驗接近原生 App
- **Service Worker** 快取靜態資源（HTML / manifest / icons），讓 App 殼層離線可用
- Whisper 模型本身不由 SW 快取（體積過大），由 App 透過 IndexedDB / 資料夾自行管理

---

## 📄 支援格式

### 輸入（媒體格式）
`MP4` `MP3` `WAV` `M4A` `FLAC` `WebM` `OGG`  
以及瀏覽器原生支援的其他音訊 / 影片格式

### 輸出（字幕 / 文字格式）
| 格式 | 副檔名 | 說明 |
|------|--------|------|
| SRT 字幕 | `.srt` | 最通用的字幕格式，相容 VLC、Premiere、DaVinci 等 |
| WebVTT | `.vtt` | HTML5 原生字幕格式，適合網頁播放器 |
| 純文字 | `.txt` | 僅保留辨識文字，不含時間碼 |
| Markdown | `.md` | 含時間碼的 Markdown 格式，適合文件撰寫 |

---

## 🚀 快速開始

### 方法一：GitHub Pages（最簡單）

若您已將此專案 push 至 GitHub，直接啟用 GitHub Pages：

1. 進入 Repository → **Settings** → **Pages**
2. Source 選擇 `main` branch，資料夾選 `/ (root)`
3. 儲存後等候部署完成
4. 使用產生的 `https://YOUR_USERNAME.github.io/YOUR_REPO/whisper-srt-v5_3.html` 網址開啟

### 方法二：本機 Python 伺服器

```bash
# 在 HTML 檔案所在目錄執行
python -m http.server 8080

# 開啟瀏覽器訪問
http://localhost:8080/whisper-srt-v5_3.html
```

### 方法三：VS Code Live Server

1. 安裝 VS Code 擴充功能 [Live Server](https://marketplace.visualstudio.com/items?itemName=ritwickdey.LiveServer)
2. 在 VS Code 中開啟此 HTML 檔案
3. 右鍵 → **Open with Live Server**

### 方法四：Node.js serve

```bash
npx serve .
# 預設開啟 http://localhost:3000
```

> ⚠️ **重要：請勿直接雙擊開啟 HTML 檔案**（`file://` 協定）  
> 瀏覽器安全限制將導致模型無法載入（CORS 問題）、File System Access API 失效、WebGPU 停用。
> 請務必透過 HTTP 伺服器開啟（`http://localhost:...` 或 `https://...`）。

---

## 📋 詳細操作步驟

### 第一次使用

#### Step 1：開啟頁面
確認網址列顯示 `http://` 或 `https://`，而非 `file://`。

#### Step 2：選擇語音模型
頁面頂部的**語音模型**區塊列出可用模型，點擊選取：
- 初次使用建議選 **`tiny`**（75 MB）快速體驗
- 需要更高精度可選 `small` 或 `medium`
- 高效能裝置（≥ 8 GB RAM，支援 WebGPU）可選 `large-v3-turbo`

#### Step 3：（選用）指定模型快取資料夾
點擊**選擇資料夾**（模型快取資料夾區塊），選擇一個用來儲存模型的本機資料夾。  
好處：模型下載一次後永久保存，不受瀏覽器快取清除影響。  
若不指定，模型仍會快取於瀏覽器 IndexedDB，但可能隨時被瀏覽器清除。

#### Step 4：上傳媒體檔案
- 將音訊 / 影片檔案**拖放**至虛線框內，或點擊框內選取
- 支援**多選**，多個檔案會進入批次佇列
- 佇列列表顯示每個檔案的名稱與大小

#### Step 5：設定辨識參數

| 設定項 | 選項 | 說明 |
|--------|------|------|
| **辨識語言** | 中文 / English / 日本語 / 한국어 / 自動偵測 | 手動指定可提升準確率 |
| **任務** | 轉錄（原語言）/ 翻譯成英文 | 翻譯模式輸出英文字幕 |

#### Step 6：（選用）設定輸出

| 設定項 | 說明 |
|--------|------|
| **輸出檔名** | 留空則沿用音訊檔名，不需填寫副檔名 |
| **輸出格式** | 選擇 SRT / VTT / TXT / Markdown |
| **輸出資料夾** | 指定後自動儲存至該資料夾（批次模式特別有用） |

#### Step 7：開始辨識
點擊綠色的 **▶ 開始辨識** 按鈕。

**首次使用**：按下按鈕後會先下載模型（依模型大小與網速需時數秒至數分鐘），進度條顯示下載狀態，下載完成後自動開始辨識。  
**後續使用**：模型已快取，跳過下載直接辨識。

#### Step 8：查看結果與下載
辨識完成後顯示**結果卡片**：
- 字幕段落數、總時長、使用模型
- 字幕內容預覽（前 40 行）
- **⬇ 下載** 按鈕：儲存至瀏覽器預設下載路徑
- **📁 儲存至指定資料夾** 按鈕：儲存至 Step 6 指定的資料夾（需事先指定）

### 批次辨識流程

1. 在 Step 4 時選取**多個檔案**（或多次拖放）
2. 批次佇列顯示所有排隊的檔案
3. 點擊 **▶ 開始辨識**，系統依序處理每個檔案
4. 辨識中的檔案以黃色標記顯示，完成後顯示下載連結
5. 全部完成後顯示**批次辨識完成**摘要
6. 若已指定輸出資料夾，所有字幕檔自動儲存；否則需逐一下載

### 中途取消辨識

點擊 **✕ 取消辨識** 按鈕：
- 系統立即中止當前辨識
- 已完成的批次項目保留結果可供下載
- 尚未開始的批次項目標記為「已取消」

---

## 🔧 核心技術機制

### Inline Web Worker 架構
模型推論在獨立的 **Web Worker** 中執行，與主執行緒完全隔離：
- 避免 UI 卡頓（推論過程中頁面保持可互動）
- Worker 程式碼以 Blob URL 動態建立，無需額外 `.js` 檔案
- 推論完成後主動釋放 KV Cache 張量記憶體，防止 OOM

### 分段推論 + 滑動視窗（Stride）
長音訊採用分段（Chunking）方式處理：
- 每段固定長度（`CHUNK_SEC`），相鄰段之間有重疊（`STRIDE_SEC`）
- Stride 區間的結果被捨棄，僅保留有效段落，避免句子在邊界被截斷
- 每段完成後更新進度條與 ETA（預估剩餘時間）

### 自動重試機制
若某段推論失敗（逾時或錯誤），系統自動重試一次（最長 5 分鐘超時），重試仍失敗才跳過該段繼續。

### 記憶體壓力偵測
每段推論前透過 `performance.memory` API 偵測 JS Heap 使用率：
- 使用率超過 85% 時發出 `MEMORY_PRESSURE` 信號並跳過當前段
- 配合自動量化（q8/q4）降低記憶體需求

### File System Access API 整合
- **模型資料夾**：攔截 Transformers.js 的 fetch 請求，優先從本機資料夾讀取，讀取不到才從 CDN 下載並同步寫入資料夾
- **輸出資料夾**：辨識完成後以 `FileSystemWritableFileStream` 直接寫入磁碟，不觸發瀏覽器下載對話框

### ETA 預估演算法
推論開始後記錄起始時間，依照「已處理音訊秒數 / 已用時間」計算實時處理速率，推算剩餘時間並顯示於進度條下方。

### segIdx 驗證（防止竄台）
批次辨識時，每個 Worker 訊息均攜帶 `segIdx` 欄位，接收端嚴格比對，防止不同段落的回應互相覆蓋（Cross-segment contamination）。

---

## 💻 建議作業系統與裝置

### 桌機 / 筆電（完整功能）

| 作業系統 | 建議瀏覽器 | 備註 |
|----------|-----------|------|
| **Windows 10/11** | Chrome / Edge 最新版 | WebGPU + File System Access API 完整支援 |
| **macOS 12+** | Chrome / Safari 17+ | WebGPU 在 Safari 17+ 可用；File System Access API 僅 Chrome 支援 |
| **Ubuntu 22.04+** | Chrome 最新版 | WebGPU 需確認 GPU 驅動，部分 Linux 環境降級至 WASM |

> **最佳體驗**：Windows 11 + Chrome 最新版 + 獨立顯示卡（支援 WebGPU）

### 行動裝置（PWA 模式）

| 裝置 | 建議瀏覽器 | 支援功能 |
|------|-----------|----------|
| **iPhone 12+（iOS 16.4+）** | Safari | PWA 安裝、離線使用；File System Access API 不支援 |
| **iPad（iPadOS 16.4+）** | Safari | 同 iPhone；較大 RAM 可跑 `small` 模型 |
| **Android（Chrome）** | Chrome 最新版 | PWA 安裝、部分裝置支援 WebGPU |

> **行動裝置限制**：受限於 RAM，建議使用 `tiny` 或 `base` 模型。File System Access API（資料夾儲存）在所有行動瀏覽器中均不支援。

### 不建議使用
- **Firefox**（任何平台）：File System Access API 未完整支援
- **iOS Chrome / Edge**：底層仍為 WebKit，不支援 PWA 安裝
- **記憶體 < 4 GB 的裝置**：可能在載入 `small` 以上模型時崩潰

---

## ⚙️ 系統需求

| 項目 | 最低需求 | 建議配置 |
|------|----------|----------|
| **瀏覽器** | Chrome 94+ / Edge 94+ | Chrome / Edge 最新版 |
| **作業系統** | Windows / macOS / Linux（64-bit） | 同左 |
| **RAM（tiny/base）** | 2 GB 可用 | 4 GB+ |
| **RAM（small）** | 3 GB 可用 | 6 GB+ |
| **RAM（medium/large-v3-turbo）** | 6 GB 可用 | 8 GB+ |
| **網路（首次使用）** | 需下載模型一次 | 寬頻為佳 |
| **網路（後續使用）** | 可完全離線 | — |

> **Firefox 注意**：File System Access API（資料夾儲存功能）在 Firefox 中尚未完整支援，建議使用 Chrome 或 Edge 以獲得完整功能。

---

## ⚠️ 注意事項

### 使用前必讀
1. **必須透過 HTTP/HTTPS 伺服器開啟**，`file://` 協定會導致功能失效（頁面會顯示警告）
2. **首次使用需要網路連線**以下載模型，之後可離線使用
3. **關閉瀏覽器分頁**會中止正在進行的辨識，請等待完成再關閉
4. **不要在辨識進行中重新整理頁面**，這會終止 Worker 並丟失進度

### 記憶體相關
1. 選擇 `medium` 或 `large-v3-turbo` 模型前，請確認系統有足夠可用 RAM（建議 ≥ 8 GB）
2. 記憶體不足可能導致瀏覽器分頁崩潰，建議先用較小模型測試
3. 系統會自動量化模型以降低記憶體需求，但仍可能不足以應對極低記憶體的裝置
4. 長時間使用後若發現記憶體持續增加，可嘗試重整頁面（需重新載入模型）

### 模型快取
1. **建議指定模型快取資料夾**，避免瀏覽器定期清除 IndexedDB 快取
2. 清除瀏覽器資料時，IndexedDB 快取的模型會一併被刪除，下次需重新下載
3. 指定資料夾快取後，切換到其他瀏覽器或電腦仍需重新下載

### 辨識品質
1. 音訊品質直接影響辨識準確率，雜訊過多或說話不清晰會降低品質
2. 建議手動指定辨識語言（而非自動偵測）以提升準確率
3. 混合語言（如中英夾雜）的辨識效果視模型而定，`large-v3-turbo` 表現最佳
4. 極短的音訊片段（< 1 秒）可能無法正確辨識

### 輸出資料夾
1. File System Access API 需要使用者明確授權，每次開啟頁面需重新選擇資料夾
2. Firefox 不支援此 API，無法使用自動儲存至資料夾功能

---

## 🗂️ 專案結構

```
your-repo/
├── index.html                      # 主應用程式（含 PWA meta tags + SW 註冊）
├── manifest.json                   # PWA Manifest
├── sw.js                           # Service Worker（靜態資源快取）
├── .nojekyll                       # 讓 GitHub Pages 正確 serve 所有檔案
├── README.md
└── icons/
    ├── icon-192.png
    ├── icon-192-maskable.png
    ├── icon-512.png
    └── apple-touch-icon-180x180.png
```

本工具所有資源均在運行時從 CDN 載入：
- `@huggingface/transformers` v3.5.2（從 jsDelivr CDN 載入）
- Google Fonts（IBM Plex Mono + Syne）

---

## 🌐 部署至 GitHub Pages

### Step 1：Push 檔案至 GitHub

```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
git push -u origin main
```

### Step 2：啟用 GitHub Pages

1. 進入 Repo → **Settings** → **Pages**
2. Source 選 `Deploy from a branch`
3. Branch 選 `main`，資料夾選 `/ (root)`
4. 儲存後等待部署完成（約 1–2 分鐘）
5. 訪問：`https://YOUR_USERNAME.github.io/YOUR_REPO/`

> GitHub Pages 提供 HTTPS，完全符合 WebGPU 及 File System Access API 對 Secure Context 的要求。

### Step 3：更新 manifest.json 路徑（重要！）

若 Repo 部署於子路徑（例如 `https://username.github.io/repo-name/`），需修改以下檔案：

**`manifest.json`**
```json
{
  "start_url": "/repo-name/",
  "scope": "/repo-name/",
  "icons": [
    { "src": "/repo-name/icons/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/repo-name/icons/icon-512.png", "sizes": "512x512", "type": "image/png" }
  ]
}
```

**`index.html`**（head 區段）
```html
<link rel="manifest" href="/repo-name/manifest.json">
<link rel="apple-touch-icon" href="/repo-name/icons/apple-touch-icon-180x180.png">
```

**`sw.js`**（APP_SHELL 陣列）
```js
const APP_SHELL = [
  '/repo-name/',
  '/repo-name/index.html',
  '/repo-name/manifest.json',
  '/repo-name/icons/icon-192.png',
  // ...其他圖示
];
```

---

## 📱 PWA 安裝至主畫面

### iPhone / iPad（iOS Safari）

1. 用 **Safari** 開啟部署好的 GitHub Pages 網址（需 iOS 16.4+）
2. 點擊底部工具列的 **分享按鈕**（方框加箭頭圖示）
3. 選擇「**加入主畫面**」
4. 確認名稱後點擊「新增」
5. App 圖示出現於主畫面，之後可離線啟動

> ⚠️ iOS PWA 僅 Safari 支援安裝，Chrome for iOS 無法加入主畫面。

### Android（Chrome）

1. 用 **Chrome** 開啟部署好的 GitHub Pages 網址
2. 點擊網址列右側選單（⋮）→「**安裝應用程式**」或「加入主畫面」
3. 確認後 App 圖示出現於桌面

### 更新 App（重要）

每次修改靜態資源後，請遞增 `sw.js` 中的快取版本號，強制用戶端更新：

```js
const CACHE_VERSION = 'v2'; // 每次更新後遞增
```

---

## ❓ 常見問題

**Q：頁面顯示「請勿直接雙擊開啟此檔案」警告？**  
A：您以 `file://` 協定開啟，請改用本機 HTTP 伺服器或 GitHub Pages。

**Q：模型下載到一半失敗了怎麼辦？**  
A：重新整理頁面，再次點擊開始辨識，Transformers.js 會嘗試繼續下載（視 CDN 快取情況而定）。若多次失敗，可嘗試清除 IndexedDB 後重試。

**Q：辨識完成但字幕內容全是亂碼或錯誤語言？**  
A：請在「辨識語言」下拉選單中手動選擇正確語言，不要使用「自動偵測」。

**Q：使用 large-v3-turbo 但瀏覽器分頁崩潰？**  
A：記憶體不足。請關閉其他分頁 / 應用程式，或改用較小的模型（`small` 或 `medium`）。

**Q：在 Firefox 上無法選擇資料夾？**  
A：Firefox 不支援 File System Access API，資料夾功能僅在 Chrome / Edge 可用，辨識功能仍可正常使用。

**Q：辨識速度很慢怎麼辦？**  
A：（1）改用較小模型如 `tiny` 或 `base`；（2）確認使用 Chrome / Edge 以啟用 WebGPU 加速；（3）縮短音訊長度後再辨識。

**Q：輸出的 SRT 時間碼有誤？**  
A：Whisper 對極短片段（< 1 秒）的時間戳估計可能不精確。可嘗試使用更大的模型，或在影片剪輯軟體中手動調整。

**Q：安裝 PWA 後，App 更新了但畫面還是舊版？**  
A：請確認開發者已遞增 `sw.js` 中的 `CACHE_VERSION`。您也可以在瀏覽器設定中清除網站快取，強制取得最新版本。

**Q：iPhone 上可以使用 PWA 的推播通知嗎？**  
A：需要 iOS 16.4+ 且已將 App 安裝至主畫面，才支援 Web Push 通知功能。

**Q：智慧後處理的合併短行和分割長行可以同時開啟嗎？**  
A：可以。系統會先執行合併，再執行分割，兩者不衝突，可視需求組合使用。

**Q：醫學詞典匯入後格式錯誤怎麼辦？**  
A：請確認 CSV 欄位順序為「原始字（`|` 分隔）, 標準中文術語, 英文對照」。匯入失敗時系統會自動嘗試 TSV 格式，若仍失敗可改用 JSON 格式匯入。點擊「還原預設」可回到內建詞典。

---

## 📜 授權

本專案採用 [MIT License](LICENSE)。

Whisper 模型版權歸屬 [OpenAI](https://openai.com/research/whisper)，  
Transformers.js 版權歸屬 [Hugging Face](https://huggingface.co/docs/transformers.js)。

---

<div align="center">

**完全離線 · 零資料外傳 · 無需帳號 · PWA 可安裝 · 智慧後處理**

Made with ❤️ using [Transformers.js](https://huggingface.co/docs/transformers.js) + OpenAI Whisper

</div>
