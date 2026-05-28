// sw.js — Whisper 離線字幕產生器 Service Worker
// CACHE_VERSION：每次更新 index.html 靜態資源後遞增（格式：YYYYMMDD-N）
const CACHE_VERSION = '20260528-1';
const CACHE_NAME    = `whisper-subtitler-${CACHE_VERSION}`;

// App Shell：只快取 UI 骨架
// BASE = '' 表示根目錄部署；子目錄部署請將 BASE 改為 '/your-subpath'
// 根目錄部署（GitHub Pages root）
const BASE = '';

const APP_SHELL = [
  `${BASE}/`,
  `${BASE}/index.html`,
  `${BASE}/manifest.json`,
  `${BASE}/icons/icon-180.png`,
  `${BASE}/icons/icon-192.png`,
  `${BASE}/icons/icon-512.png`,
  `${BASE}/icons/apple-touch-icon-180x180.png`,
];

// ── 安裝：快取 App Shell ──────────────────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
      .catch((err) => {
        // addAll 若有任一資源 404 即失敗；記錄後重拋讓 SW install 正確中止
        console.error('[SW] install failed:', err);
        throw err;
      })
  );
});

// ── 啟動：清除舊版快取 ───────────────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME)
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

// ── Fetch 攔截 ────────────────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const { request } = event;

  // 只處理 GET 請求
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // 跳過非同源請求（CDN 字型、huggingface 模型等）
  if (url.origin !== self.location.origin) return;

  // 頁面導航：Network First，離線時回傳快取的 index.html
  if (request.mode === 'navigate') {
    event.respondWith(navigationHandler(request));
    return;
  }

  // 靜態資源（圖示、manifest）：Cache First
  if (isStaticAsset(url.pathname)) {
    event.respondWith(cacheFirst(request));
    return;
  }

  // 其他同源請求：Network First
  event.respondWith(networkFirst(request));
});

// ── 策略函式 ──────────────────────────────────────────────────────────────────

function isStaticAsset(pathname) {
  return (
    pathname.startsWith(`${BASE}/icons/`) ||
    pathname === `${BASE}/manifest.json` ||
    /\.(png|jpg|jpeg|svg|webp|ico|woff2?|ttf)$/.test(pathname)
  );
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(request, response.clone()); // BUG-3 fix: await
    }
    return response;
  } catch {
    return new Response('', { status: 503, statusText: 'Offline' });
  }
}

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(request, response.clone()); // BUG-3 fix: await
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    // BUG-6 fix: 回傳可識別的離線錯誤頁，而非空白 503
    return new Response(
      JSON.stringify({ error: 'offline' }),
      { status: 503, statusText: 'Offline', headers: { 'Content-Type': 'application/json' } }
    );
  }
}

async function navigationHandler(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(request, response.clone()); // BUG-3 fix: await
    }
    return response;
  } catch {
    // 離線時依序嘗試：精確路徑 → index.html → 根目錄 → 內建離線頁
    const cached =
      (await caches.match(request)) ||
      (await caches.match(`${BASE}/index.html`)) ||
      (await caches.match(`${BASE}/`));
    if (cached) return cached;
    return new Response(
      '<!DOCTYPE html><html lang="zh-TW"><head><meta charset="UTF-8"><title>離線中</title></head>' +
      '<body style="font-family:sans-serif;padding:2rem"><h1>離線中</h1><p>請連線後重試。</p></body></html>',
      { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  }
}
