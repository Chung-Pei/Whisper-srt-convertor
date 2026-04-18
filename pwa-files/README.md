# Whisper 離線字幕產生器 — PWA

在瀏覽器中使用 Whisper AI 模型進行離線語音辨識，完全不上傳至伺服器。

## 部署到 GitHub Pages

### 1. 建立 Repo 並上傳檔案

```
your-repo/
├── index.html              ← 修改版（含 PWA meta tags + SW 註冊）
├── manifest.json
├── sw.js
├── .nojekyll               ← 讓 GitHub Pages 正確 serve 所有檔案
└── icons/
    ├── icon-192.png
    ├── icon-192-maskable.png
    ├── icon-512.png
    └── apple-touch-icon-180x180.png
```

### 2. 啟用 GitHub Pages

1. Repo → **Settings** → **Pages**
2. Source 選 `Deploy from a branch`
3. Branch 選 `main`（或 `master`），資料夾選 `/ (root)`
4. 儲存後等待部署完成（約 1~2 分鐘）

### 3. 更新 manifest.json 的路徑（重要！）

若 Repo 不是直接部署在根網域（例如 `https://username.github.io/repo-name/`），
需修改 `manifest.json`：

```json
{
  "start_url": "/repo-name/",
  "scope": "/repo-name/",
  "icons": [
    { "src": "/repo-name/icons/icon-192.png", ... },
    ...
  ]
}
```

並同步更新 `index.html` 中：
```html
<link rel="manifest" href="/repo-name/manifest.json">
<link rel="apple-touch-icon" href="/repo-name/icons/apple-touch-icon-180x180.png">
```

以及 `sw.js` 中的 `APP_SHELL` 陣列路徑也需加上 `/repo-name/` 前綴。

### 4. 安裝到 iPhone 主畫面（iOS PWA）

1. 用 Safari 開啟部署好的 GitHub Pages 網址
2. 點擊下方分享按鈕 → 「加入主畫面」
3. App 即可離線使用（模型需先連線下載一次）

## 注意事項

- **Whisper 模型檔案不會被 Service Worker 快取**（體積過大），由 App 自行透過 IndexedDB 管理
- 每次更新靜態資源後，請遞增 `sw.js` 中的 `CACHE_VERSION` 以強制使用者更新快取
- iOS 16.4+ 且已安裝到主畫面才支援 Web Push 通知
