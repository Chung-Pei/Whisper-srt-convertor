// sw.js — Whisper 離線字幕產生器 Service Worker
// 版本號請在每次更新靜態資源後遞增
const CACHE_VERSION = 'v1';
const CACHE_NAME = `whisper-subtitler-${CACHE_VERSION}`;

// App Shell：只快取 UI 骨架，不快取 Whisper 模型（模型由 App 自行透過 IndexedDB 管理）
const APP_SHELL = [
  '/Whisper-srt-convertor/',
  '/Whisper-srt-convertor/index.html',
  '/Whisper-srt-convertor/manifest.json',
  '/Whisper-srt-convertor/icons/icon-192.png',
  '/Whisper-srt-convertor/icons/icon-512.png',
  '/Whisper-srt-convertor/icons/apple-touch-icon-180x180.png',
];

// ── 安裝：快取 App Shell ──────────────────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
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

  // 其他請求：Network First
  event.respondWith(networkFirst(request));
});

// ── 策略函式 ──────────────────────────────────────────────────────────────────

function isStaticAsset(pathname) {
  return (
    pathname.startsWith('/Whisper-srt-convertor/icons/') ||
    pathname === '/Whisper-srt-convertor/manifest.json' ||
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
      cache.put(request, response.clone());
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
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    return new Response('', { status: 503, statusText: 'Offline' });
  }
}

async function navigationHandler(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    // 離線時回傳已快取的 index.html
    const cached =
      (await caches.match(request)) ||
      (await caches.match('/Whisper-srt-convertor/index.html')) ||
      (await caches.match('/Whisper-srt-convertor/'));
    if (cached) return cached;
    return new Response('<h1>離線中</h1><p>請連線後重試。</p>', {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }
}
