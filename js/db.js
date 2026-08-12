// IndexedDB — 재열람 편의 캐시(원본 진실원천 = 폰 Download 폴더, 지워져도 무손실)
// LRU 상한: 총 30MB·30건 (오리진 공유 수용 조건 — docs/5 §1-d 08-12 확정)
const DB_NAME = 'reader-db';
const MAX_TOTAL_BYTES = 30 * 1024 * 1024;
const MAX_DOCS = 30;
export const MAX_CACHE_FILE = 10 * 1024 * 1024;  // 이보다 크면 저장 없이 1회 열기
export const MAX_OPEN_FILE = 60 * 1024 * 1024;   // 이보다 크면 열기 거절

let _db = null;
function open() {
  if (_db) return Promise.resolve(_db);
  return new Promise((res, rej) => {
    const rq = indexedDB.open(DB_NAME, 1);
    rq.onupgradeneeded = () => {
      const db = rq.result;
      if (!db.objectStoreNames.contains('docs')) db.createObjectStore('docs', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('prefs')) db.createObjectStore('prefs');
    };
    rq.onsuccess = () => { _db = rq.result; res(_db); };
    rq.onerror = () => rej(rq.error);
  });
}
function tx(store, mode, fn) {
  return open().then(db => new Promise((res, rej) => {
    const t = db.transaction(store, mode);
    const r = fn(t.objectStore(store));
    t.oncomplete = () => res(r && r.result !== undefined ? r.result : undefined);
    t.onerror = () => rej(t.error);
  }));
}

export const docsAll = () => tx('docs', 'readonly', s => s.getAll());
export const docGet = (id) => tx('docs', 'readonly', s => s.get(id));
export const docPut = (doc) => tx('docs', 'readwrite', s => s.put(doc));
export const docDel = (id) => tx('docs', 'readwrite', s => s.delete(id));
export const prefGet = (k) => tx('prefs', 'readonly', s => s.get(k));
export const prefSet = (k, v) => tx('prefs', 'readwrite', s => s.put(v, k));

export function docId(name, size, lastModified) {
  // 이름은 NFC 정규화(같은 파일이 조합형/완성형으로 두 항목이 되는 것 방지)
  const key = `${(name || '').normalize('NFC')}|${size}|${lastModified || 0}`;
  let h = 5381;
  for (let i = 0; i < key.length; i++) h = ((h << 5) + h + key.charCodeAt(i)) >>> 0;
  return h.toString(36) + '-' + (size || 0).toString(36);
}

// LRU: 현재 문서는 지우지 않음
export async function enforceLRU(keepId) {
  const all = await docsAll();
  const sized = all.map(d => ({ id: d.id, at: d.lastOpenedAt || d.addedAt || 0, bytes: d.size || 0, cached: !!d.bytes }));
  let total = sized.reduce((a, d) => a + (d.cached ? d.bytes : 0), 0);
  let count = sized.length;
  const victims = sized.filter(d => d.id !== keepId).sort((a, b) => a.at - b.at);
  for (const v of victims) {
    if (total <= MAX_TOTAL_BYTES && count <= MAX_DOCS) break;
    await docDel(v.id);
    if (v.cached) total -= v.bytes;
    count--;
  }
}
