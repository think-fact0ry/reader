// 문서리더 SW — 셸 프리캐시 + 벤더(WASM 7MB 포함) 캐시 + 공유 진입(share target POST) 수신
// 주의: 공유 POST는 SW가 안 잡으면 GitHub Pages가 405를 낸다(docs/5 §3) — clients.claim으로 최대한 빨리 장악
const VER = 'r12'; // r12 셸=network-first 자동 갱신(유성 08-16 "업데이트가 안 됐어" — 캐시 우선이라 첫 열람이 옛 판이던 것) / r11 뒤로가기/스와이프 더블백(§4.11)
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
    // 캐시 우선(r11 이전) 셸로 이미 떠 있는 화면은 옛 판이다 — 물음에 응답 없는 화면만 새로 고친다.
    // r12+ 셸은 network-first라 뜰 때 이미 최신이고 app.js가 응답하므로 건드리지 않는다(엑셀 수정 중 강제 새로고침 방지).
    for (const cl of await self.clients.matchAll({ type: 'window' })) {
      const fresh = await new Promise((res) => {
        const mc = new MessageChannel();
        const t = setTimeout(() => res(false), 900);
        mc.port1.onmessage = () => { clearTimeout(t); res(true); };
        try { cl.postMessage({ type: 'gen?' }, [mc.port2]); } catch { clearTimeout(t); res(false); }
      });
      // ⚠️navigate를 await 금지 — 리로드는 activation 완료를 기다리므로 여기서 기다리면 서로를 기다리는 교착
      if (!fresh) { try { cl.navigate(cl.url).catch(() => {}); } catch {} }
    }
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
  // ── 셸: network-first (열면 최신 — 유성 08-16 "자동 업데이트하게") + 캐시 폴백(오프라인·회선 3초 지연 시)
  //    cache:'no-cache'=브라우저 HTTP 캐시(Pages max-age=600)를 건너뛰고 ETag 재검증 — Pages CDN ~10분은 남는 한계.
  //    navigate 모드 Request는 fetch(req,init) 재구성이 TypeError라 URL로 fetch(정적 서빙이라 리다이렉트 없음).
  e.respondWith(caches.open(SHELL).then(async (c) => {
    const ignoreSearch = url.pathname.endsWith('/') || url.pathname.endsWith('index.html');
    const net = (e.request.mode === 'navigate' ? fetch(url.href, { cache: 'no-cache' }) : fetch(e.request, { cache: 'no-cache' }))
      .then(resp => { if (resp.ok) c.put(ignoreSearch ? url.origin + url.pathname : e.request, resp.clone()); return resp; });
    const hit = await c.match(e.request, { ignoreSearch });
    if (!hit) return net.catch(() => new Response('offline', { status: 503 }));
    return Promise.race([
      net.catch(() => hit),                             // 오프라인·실패 → 캐시
      new Promise(r => setTimeout(() => r(hit), 3000)), // 회선이 3초 못 주면 캐시 먼저(속도 우선) — 받아지는 새 판은 캐시에 들어가 다음 열기에 반영
    ]);
  }));
});
