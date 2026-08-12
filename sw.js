// 문서리더 SW — 셸 프리캐시 + 벤더(WASM 7MB 포함) 캐시 + 공유 진입(share target POST) 수신
// 주의: 공유 POST는 SW가 안 잡으면 GitHub Pages가 405를 낸다(docs/5 §3) — clients.claim으로 최대한 빨리 장악
const VER = 'r10';
const SHELL = `shell-${VER}`;
const VENDOR = 'vendor-v2'; // 벤더는 파일명이 곧 버전 — 셸과 분리해 갱신 시 재다운로드 방지
const SHELL_FILES = [
  './', 'index.html', 'app.css', 'manifest.webmanifest',
  'js/app.js', 'js/db.js', 'js/hwp.worker.js', 'js/sheet.worker.js', 'js/xlsxpatch.js',
  'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== SHELL && k !== VENDOR) await caches.delete(k);
    await self.clients.claim();
  })());
});

// ── 공유 수신용 IDB (js/db.js와 같은 스키마 — SW는 모듈 임포트 대신 최소 복제)
function idb() {
  return new Promise((res, rej) => {
    const rq = indexedDB.open('reader-db', 1);
    rq.onupgradeneeded = () => {
      const db = rq.result;
      if (!db.objectStoreNames.contains('docs')) db.createObjectStore('docs', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('prefs')) db.createObjectStore('prefs');
    };
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
  });
}
function docIdOf(name, size, lastModified) {
  const key = `${(name || '').normalize('NFC')}|${size}|${lastModified || 0}`;
  let h = 5381;
  for (let i = 0; i < key.length; i++) h = ((h << 5) + h + key.charCodeAt(i)) >>> 0;
  return h.toString(36) + '-' + (size || 0).toString(36);
}
async function storeShared(file) {
  const db = await idb();
  const id = docIdOf(file.name, file.size, file.lastModified);
  const extM = /\.([a-z0-9]+)$/i.exec(file.name || '');
  const doc = {
    id, name: (file.name || '공유 문서').normalize('NFC'), ext: extM ? extM[1].toLowerCase() : '',
    mime: file.type || '', size: file.size, bytes: file,
    addedAt: Date.now(), lastOpenedAt: Date.now(), source: 'share', anchor: null,
  };
  await new Promise((res, rej) => {
    const t = db.transaction('docs', 'readwrite');
    t.objectStore('docs').put(doc);
    t.oncomplete = res; t.onerror = () => rej(t.error);
  });
  return id;
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // ── 공유 진입: N메일·카톡 → 공유 시트 → 문서리더
  if (e.request.method === 'POST' && url.pathname.endsWith('/share-target')) {
    e.respondWith((async () => {
      try {
        const fd = await e.request.formData();
        const files = fd.getAll('files').filter(f => f && f.size !== undefined);
        if (!files.length) return Response.redirect('./?share=empty', 303);
        if (files[0].size > 60 * 1024 * 1024) return Response.redirect('./?share=toobig', 303);
        const id = await storeShared(files[0]);
        for (const f of files.slice(1, 5)) { try { await storeShared(f); } catch {} }
        return Response.redirect(`./?doc=${id}`, 303);
      } catch {
        return Response.redirect('./?share=fail', 303);
      }
    })());
    return;
  }
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.endsWith('/__native_file')) return; // 네이티브 셸이 가로채는 경로 — SW는 손대지 않는다
  if (url.pathname.endsWith('.apk')) return;           // 앱 설치 파일은 캐시에 담지 않는다(1.5MB·항상 최신본이어야 함)
  // ── 벤더: cache-first (rhwp WASM 등 대용량 — 한 번 받으면 고정)
  if (url.pathname.includes('/vendor/')) {
    e.respondWith(caches.open(VENDOR).then(async (c) => {
      const hit = await c.match(e.request);
      if (hit) return hit;
      const resp = await fetch(e.request);
      if (resp.ok) c.put(e.request, resp.clone());
      return resp;
    }));
    return;
  }
  // ── 셸: cache-first + 백그라운드 갱신 (오프라인에서도 열리게)
  e.respondWith(caches.open(SHELL).then(async (c) => {
    const hit = await c.match(e.request, { ignoreSearch: url.pathname.endsWith('/') || url.pathname.endsWith('index.html') });
    const net = fetch(e.request).then(resp => { if (resp.ok) c.put(e.request, resp.clone()); return resp; }).catch(() => null);
    return hit || net.then(r => r || new Response('offline', { status: 503 }));
  }));
});
