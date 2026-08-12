// 문서리더 — 메인 앱 (문서함 + 뷰어 셸). 파싱은 워커 격리, 뷰어 셸은 kind만 본다(docs/5 §6 계약)
import { docsAll, docGet, docPut, docDel, prefGet, prefSet, docId, enforceLRU, MAX_CACHE_FILE, MAX_OPEN_FILE } from './db.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ───────────────────── 상태
let cur = null;               // { doc, kind, worker, blob, cleanup() }
const transientBlobs = new Map(); // 저장 안 한 대용량 파일의 세션 내 보관
let lastRemoved = null;       // 되돌리기용

// ───────────────────── 시간·배지
function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts), now = new Date();
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = (day(now) - day(d)) / 86400000;
  const hm = `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (diff === 0) return `오늘 ${hm}`;
  if (diff === 1) return '어제';
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}. ${d.getDate()}.`;
  return `${d.getFullYear()}. ${d.getMonth() + 1}. ${d.getDate()}.`;
}
const extOf = (name) => { const m = /\.([a-z0-9]+)$/i.exec(name || ''); return m ? m[1].toLowerCase() : ''; };
function badgeOf(ext) {
  if (ext === 'hwp' || ext === 'hwpx') return ['한글', 'fb-hwp'];
  if (['xlsx', 'xls', 'xlsm', 'csv'].includes(ext)) return ['엑셀', 'fb-xls'];
  if (ext === 'pdf') return ['PDF', 'fb-pdf'];
  if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)) return ['사진', 'fb-img'];
  return [ext ? ext.toUpperCase().slice(0, 4) : '파일', 'fb-etc'];
}
const srcLabel = { share: '공유로 받음', picker: '파일 열기', native: '다른 앱에서 열기' };

// ───────────────────── 문서함
async function renderList() {
  const all = (await docsAll()).sort((a, b) => (b.lastOpenedAt || b.addedAt) - (a.lastOpenedAt || a.addedAt));
  const list = $('docList');
  $('recentSec').style.display = all.length ? '' : 'none';
  if (!all.length) {
    list.innerHTML = `<div class="da-empty">아직 연 문서가 없어요.<br>[파일 열기]를 누르면 최근 받은 파일이 바로 보여요.</div>`;
    return;
  }
  list.innerHTML = all.map(d => {
    const [label, cls] = badgeOf(d.ext);
    const n = Array.isArray(d.edits) ? d.edits.length : 0;
    return `<button class="da-card" data-id="${d.id}">
      <span class="fbadge ${cls}">${label}</span>
      <div><div class="da-name">${esc(d.name)}</div>
      <div class="da-meta">${fmtTime(d.lastOpenedAt || d.addedAt)} · ${srcLabel[d.source] || ''}${n ? ` · <b class="editing">고치는 중 ${n}칸</b>` : ''}</div></div>
    </button>`;
  }).join('');
  list.querySelectorAll('.da-card').forEach(b => b.addEventListener('click', () => openDoc(b.dataset.id, true)));
}

function showList(replace) {
  cleanupViewer();
  $('viewerView').classList.remove('on');
  $('listView').classList.add('on');
  if (replace) history.replaceState({}, '', './');
  renderList();
}

// ───────────────────── 파일 등록
$('btnOpen').addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  if (!files.length) return;
  let firstId = null;
  for (const f of files) {
    const id = await registerFile(f, 'picker');
    if (id && !firstId) firstId = id;
  }
  if (firstId) openDoc(firstId, true);
});

async function registerFile(file, source) {
  if (file.size > MAX_OPEN_FILE) {
    toast(`${file.name} — 60MB가 넘어 열 수 없어요`);
    return null;
  }
  const id = docId(file.name, file.size, file.lastModified);
  const cacheable = file.size <= MAX_CACHE_FILE;
  const existing = await docGet(id);
  const doc = {
    id, name: (file.name || '문서').normalize('NFC'), ext: extOf(file.name), mime: file.type || '',
    size: file.size, bytes: cacheable ? file : null,
    addedAt: existing ? existing.addedAt : Date.now(), lastOpenedAt: Date.now(),
    source, anchor: existing ? existing.anchor : null,
    edits: existing ? existing.edits : undefined, // 같은 파일을 다시 골라도 고치던 내용은 살아남는다
  };
  if (!cacheable) transientBlobs.set(id, file);
  try { await docPut(doc); await enforceLRU(id); } catch { transientBlobs.set(id, file); }
  return id;
}

// ───────────────────── 매직바이트 라우팅 (확장자는 힌트 — docs/5 §3)
async function sniff(blob, ext) {
  const head = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
  const asc = String.fromCharCode(...head);
  if (head[0] === 0x50 && head[1] === 0x4b) { // ZIP계
    if (ext === 'hwpx') return 'hwp';
    if (['xlsx', 'xlsm'].includes(ext)) return 'sheet';
    // 확장자가 못 미더우면 내용 스캔
    const tail = new Uint8Array(await blob.slice(Math.max(0, blob.size - 65536)).arrayBuffer());
    const s = new TextDecoder('latin1').decode(tail);
    if (s.includes('xl/workbook')) return 'sheet';
    if (s.includes('Contents/') || s.includes('content.hpf')) return 'hwp';
    if (s.includes('word/document')) return 'unsupported-docx';
    return 'unsupported';
  }
  if (head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0) { // CFB계
    if (ext === 'hwp') return 'hwp';
    if (['xls', 'xlsx', 'xlsm'].includes(ext)) return 'sheet';
    if (ext === 'doc' || ext === 'ppt') return 'unsupported-docx';
    return 'hwp'; // 우리 사용처(구청 공문)는 hwp가 압도적
  }
  if (asc.startsWith('%PDF')) return 'pdf';
  if (head[0] === 0xff && head[1] === 0xd8) return 'image';
  if (head[0] === 0x89 && asc.slice(1, 4) === 'PNG') return 'image';
  if (asc.startsWith('GIF8')) return 'image';
  if (asc.startsWith('RIFF')) return 'image'; // webp
  const t = asc.replace(/^[\uFEFF\s\0]+/, '');
  if (t.startsWith('<') || asc.includes('<htm') || asc.includes('<HTM')) return 'html';
  if (ext === 'csv' || ext === 'txt') return 'text';
  return 'unsupported';
}

// ───────────────────── 문서 열기
async function openDoc(id, push) {
  const doc = await docGet(id);
  const blob = (doc && doc.bytes) || transientBlobs.get(id);
  if (!doc || !blob) {
    showList(true);
    toast('이 문서가 캐시에 없어요 · [파일 열기]에서 다시 선택해 주세요');
    if (doc && !blob) await docDel(id);
    renderList();
    return;
  }
  cleanupViewer();
  doc.lastOpenedAt = Date.now();
  try { await docPut(doc); } catch {}
  if (push) history.pushState({ v: 1 }, '', `./?doc=${id}`);

  $('listView').classList.remove('on');
  $('viewerView').classList.add('on');
  $('vTitle').textContent = doc.name;
  $('btnSave').style.display = 'none';
  $('editBar').classList.remove('on');
  $('vBody').innerHTML = '';
  $('vFoot').innerHTML = '';

  loadingShow('문서를 여는 중이에요');
  const kind = await sniff(blob, doc.ext);
  cur = { doc, blob, kind, worker: null, cleanup: null };
  try {
    if (kind === 'hwp') await viewHwp(doc, blob);
    else if (kind === 'sheet') await viewSheet(doc, blob);
    else if (kind === 'pdf') await viewPdf(doc, blob);
    else if (kind === 'image') await viewImage(doc, blob);
    else if (kind === 'html') await viewHtml(doc, blob);
    else if (kind === 'text') await viewText(doc, blob);
    else showUnsupported(kind);
  } catch (err) {
    if (cur && cur.worker) { try { cur.worker.terminate(); } catch {} cur.worker = null; }
    loadingHide();
    showError('문서를 열지 못했어요', '파일이 손상됐거나 아직 지원하지 않는 형식이에요.');
  }
}

function cleanupViewer() {
  if (!cur) return;
  try { cur.cleanup && cur.cleanup(); } catch {}
  if (cur.worker) { try { cur.worker.terminate(); } catch {} }
  cur = null;
  editTarget = null;
  pendingSave = null;
  $('editBar').classList.remove('on');
  $('btnSave').style.display = 'none';
  loadingHide();
}

function showError(title, body) {
  loadingHide();
  $('vBody').className = 'vbody white';
  $('vBody').innerHTML = `<div class="errcard"><b>${esc(title)}</b>${esc(body)}</div>`;
  $('vFoot').innerHTML = '';
}
function showUnsupported(kind) {
  const isDocx = kind === 'unsupported-docx';
  showError(isDocx ? '워드·PPT 문서는 아직 열 수 없어요' : '지원하지 않는 파일이에요',
    '우상단 ⋮ → 공유로 다른 앱에 넘겨서 열 수 있어요.');
}

// ───────────────────── 로딩
let loadTimer = 0;
function loadingShow(msg) {
  $('loadMsg').textContent = msg;
  $('loadBar').style.width = '4%';
  $('loading').classList.add('on');
  clearTimeout(loadTimer);
  loadTimer = setTimeout(() => { if ($('loading').classList.contains('on')) { cleanupViewer(); showError('시간이 너무 오래 걸려요', '파일이 크거나 손상됐을 수 있어요. 다시 시도해 주세요.'); } }, 60000);
}
function loadingProg(p, msg) {
  $('loadBar').style.width = Math.min(99, p) + '%';
  if (msg) $('loadMsg').textContent = `${msg} · ${Math.round(Math.min(99, p))}%`;
}
function loadingHide() { clearTimeout(loadTimer); $('loading').classList.remove('on'); }
$('loadCancel').addEventListener('click', () => { cleanupViewer(); showList(true); });

// ───────────────────── 핀치 확대 (앱이 직접 수신 — CSS zoom이라 틀 고정과 공존)
function attachPinch(scroller, getTarget, opts = {}) {
  const min = opts.min || 0.5, max = opts.max || 3;
  let startDist = 0, startZ = 1, z = opts.initial || 1, pinching = false, raf = 0, pend = null;
  const dist = (e) => Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
  const apply = () => {
    raf = 0;
    if (!pend) return;
    const { nz, mx, my } = pend; pend = null;
    const prev = z; z = nz;
    const t = getTarget(); if (!t) return;
    const sx = scroller.scrollLeft, sy = scroller.scrollTop;
    t.style.zoom = z;
    const k = z / prev;
    scroller.scrollLeft = (sx + mx) * k - mx;
    scroller.scrollTop = (sy + my) * k - my;
  };
  scroller.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) { pinching = true; startDist = dist(e); startZ = z; }
  }, { passive: true });
  scroller.addEventListener('touchmove', (e) => {
    if (!pinching || e.touches.length !== 2) return;
    e.preventDefault();
    const r = scroller.getBoundingClientRect();
    const mx = (e.touches[0].clientX + e.touches[1].clientX) / 2 - r.left;
    const my = (e.touches[0].clientY + e.touches[1].clientY) / 2 - r.top;
    pend = { nz: Math.min(max, Math.max(min, startZ * dist(e) / startDist)), mx, my };
    if (!raf) raf = requestAnimationFrame(apply);
  }, { passive: false });
  const end = () => { if (pinching) { pinching = false; opts.onEnd && opts.onEnd(z); } };
  scroller.addEventListener('touchend', end, { passive: true });
  scroller.addEventListener('touchcancel', end, { passive: true });
  return { getZ: () => z, setZ: (v) => { z = v; const t = getTarget(); if (t) t.style.zoom = v; } };
}

// ───────────────────── 한글 뷰어 (rhwp — 원본 페이지 렌더만, 유성 확정 2026-08-12)
async function viewHwp(doc, blob) {
  const worker = new Worker(new URL('./hwp.worker.js', import.meta.url), { type: 'module' });
  cur.worker = worker;
  const bytes = await blob.arrayBuffer();
  const svgCache = new Map();

  const ready = await new Promise((res, rej) => {
    worker.onerror = (e) => rej(new Error(e.message || 'worker error')); // 조용한 행 금지
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'progress') loadingProg(m.p, m.msg);
      else if (m.type === 'ready') res(m);
      else if (m.type === 'error') rej(new Error(m.msg));
    };
    worker.postMessage({ cmd: 'open', bytes }, [bytes]);
  });
  const pages = ready.pages, pw = ready.w, ph = ready.h;
  if (ready.svg0) svgCache.set(0, ready.svg0);

  const pageWaiters = new Map();
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'page') { svgCache.set(m.i, m.svg); const w = pageWaiters.get(m.i); if (w) { w(m.svg); pageWaiters.delete(m.i); } }
    else if (m.type === 'progress') loadingProg(m.p, m.msg);
  };
  const getPage = (i) => svgCache.has(i) ? Promise.resolve(svgCache.get(i)) :
    new Promise((res) => { pageWaiters.set(i, res); worker.postMessage({ cmd: 'page', i }); });

  const vb = $('vBody'); vb.className = 'vbody'; vb.innerHTML = '';
  const cont = document.createElement('div'); cont.className = 'pages'; vb.appendChild(cont);
  const base = Math.min(vb.clientWidth - 28, 900);
  const phs = [];
  for (let i = 0; i < pages; i++) {
    const d = document.createElement('div');
    d.className = 'pageph'; d.dataset.i = i;
    d.style.width = base + 'px'; d.style.aspectRatio = `${pw}/${ph}`;
    cont.appendChild(d); phs.push(d);
  }
  $('vFoot').innerHTML = `<span class="hint">두 손가락으로 확대</span><span class="pg tnum" id="pgInd">1 / ${pages}쪽</span>`;
  const io = new IntersectionObserver((ents) => {
    for (const en of ents) {
      const i = +en.target.dataset.i;
      if (en.isIntersecting) {
        if (!en.target.dataset.done) { en.target.dataset.done = 1; getPage(i).then(svg => { en.target.innerHTML = svg; }); }
        if (en.intersectionRatio > 0.4) { const el = $('pgInd'); if (el) el.textContent = `${i + 1} / ${pages}쪽`; }
      }
    }
  }, { root: vb, rootMargin: '600px 0px', threshold: [0, 0.45] });
  phs.forEach(d => io.observe(d));
  attachPinch(vb, () => cont, { min: 0.6, max: 3.5 });
  cur.cleanup = () => io.disconnect();
  loadingHide();
}

// ───────────────────── 엑셀 뷰어 (틀 고정 + 핀치)
async function viewSheet(doc, blob) {
  const worker = new Worker(new URL('./sheet.worker.js', import.meta.url));
  cur.worker = worker;
  const send = async (password) => {
    const bytes = await blob.arrayBuffer();
    worker.postMessage({ cmd: 'open', bytes, ext: doc.ext, password }, [bytes]);
  };
  const ready = await new Promise((res, rej) => {
    worker.onerror = (e) => rej(new Error(e.message || 'worker error')); // 조용한 행 금지
    worker.onmessage = async (e) => {
      const m = e.data;
      if (m.type === 'progress') loadingProg(m.p, m.msg);
      else if (m.type === 'ready') res(m);
      else if (m.type === 'needpassword') {
        const pw = await askPassword('문서를 열려면 암호를 입력해 주세요.');
        if (pw === null) { cleanupViewer(); showList(true); rej(new Error('cancel')); return; }
        loadingShow('암호를 푸는 중'); send(pw);
      } else if (m.type === 'badpassword') {
        const pw = await askPassword('암호가 맞지 않아요. 다시 입력해 주세요.');
        if (pw === null) { cleanupViewer(); showList(true); rej(new Error('cancel')); return; }
        loadingShow('암호를 푸는 중'); send(pw);
      } else if (m.type === 'error') rej(new Error(m.msg));
    };
    send();
  }).catch(err => { if (String(err.message) !== 'cancel') throw err; return null; });
  if (!ready) return;
  const model = ready.model;
  const editable = ready.editable !== false;

  const vb = $('vBody'); vb.className = 'vbody white';
  let si = 0, picked = null; // picked = 편집 중인 td
  const edits = new Map();   // key `시트|행|열` → { sheet, r, c, value }
  cur.edits = edits;
  cur.saveSheet = () => saveEditedSheet(doc, worker, edits);

  // 고치던 내용 복원 — 앱을 나갔다 와도(전화·카톡) 입력이 날아가지 않게.
  // 키는 파일 신원(docId=이름+크기+수정시각)에 매달려 있어 다른 파일로 새지 않는다([[idempotency-key-with-time-unit-breaks]]).
  const saved = (await docGet(doc.id))?.edits;
  if (Array.isArray(saved) && saved.length) {
    for (const e of saved) {
      edits.set(`${e.sheet}|${e.r}|${e.c}`, e);
      const sh = model.sheets.find(s => s.name === e.sheet);
      if (sh && sh.rows[e.r - 1]) {
        const prev = sh.rows[e.r - 1][e.c - 1];
        const sidx = prev === 0 || !prev ? 0 : prev[1];
        sh.rows[e.r - 1][e.c - 1] = e.value ? [e.value, sidx] : 0;
      }
    }
    $('btnSave').style.display = '';
    setTimeout(() => snackbar(`고치던 내용 ${saved.length}칸을 그대로 뒀어요`, '', null), 400);
  }
  let saveTimer = 0;
  const persistEdits = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      const d = await docGet(doc.id);
      if (!d) return;
      d.edits = [...edits.values()];
      try { await docPut(d); } catch {}
    }, 400);
  };

  function renderSheet() {
    const sh = model.sheets[si];
    vb.innerHTML = '';
    picked = null;
    const wrap = document.createElement('div'); wrap.className = 'xlwrap'; vb.appendChild(wrap);
    if (!sh || !sh.rows.length) { wrap.innerHTML = '<div class="errcard">빈 시트예요</div>'; return; }
    // 병합 스킵맵
    const skip = new Set(), span = new Map();
    for (const m of sh.merges) {
      span.set(`${m.r},${m.c}`, m);
      for (let r = m.r; r < m.r + m.rs; r++) for (let c = m.c; c < m.c + m.cs; c++)
        if (r !== m.r || c !== m.c) skip.add(`${r},${c}`);
    }
    const fr = Math.max(sh.frozen.r, 1), fc = Math.max(sh.frozen.c, 1);
    let html = '<table class="xltab">';
    for (let r = 0; r < sh.rows.length; r++) {
      html += '<tr>';
      const row = sh.rows[r];
      for (let c = 0; c < row.length; c++) {
        const key = `${r + 1},${c + 1}`;
        if (skip.has(key)) continue;
        const cell = row[c];
        const [text, sidx] = cell === 0 ? ['', 0] : cell;
        const st = model.styles[sidx] || '';
        const mg = span.get(key);
        const cls = [(r < fr ? 'stik-t' : ''), (c < fc ? 'stik-l' : ''), (r < fr ? 'hd' : ''),
          (edits.has(`${sh.name}|${r + 1}|${c + 1}`) ? 'edited' : '')].filter(Boolean).join(' ');
        html += `<td data-r="${r + 1}" data-c="${c + 1}"${cls ? ` class="${cls}"` : ''}${st ? ` style="${st}"` : ''}${mg ? ` rowspan="${mg.rs}" colspan="${mg.cs}"` : ''}>${esc(text)}</td>`;
      }
      html += '</tr>';
    }
    html += '</table>';
    if (sh.truncated) html += `<div class="truncnote">${sh.rows.length}행까지 보여드려요 (양식은 ${Math.min(sh.totalR, 99999)}행까지) · 더 필요하면 PC에서 채워 주세요</div>`;
    wrap.innerHTML = html;
    attachPinch(wrap, () => wrap.querySelector('.xltab'), { min: 0.5, max: 3 });

    // 셀 탭 → 편집 (스크롤·핀치와 구분: 거의 안 움직인 짧은 탭만)
    if (editable) {
      let dn = null;
      wrap.addEventListener('pointerdown', (e) => { dn = { x: e.clientX, y: e.clientY, t: Date.now() }; });
      wrap.addEventListener('pointerup', (e) => {
        if (!dn) return;
        const moved = Math.hypot(e.clientX - dn.x, e.clientY - dn.y);
        const quick = Date.now() - dn.t < 500;
        dn = null;
        if (moved > 8 || !quick) return;
        const td = e.target.closest('td');
        if (td) pickCell(td);
      });
    }
    renderFoot();
  }

  function renderFoot() {
    const foot = $('vFoot');
    foot.innerHTML = `<div class="sheets">${model.sheets.map((s, i) =>
      `<button class="shtab${i === si ? ' on' : ''}" data-i="${i}">${esc(s.name)}</button>`).join('')}</div>
      <span class="hint">${editable ? '칸을 눌러 고칠 수 있어요' : '두 손가락으로 확대'}</span>`;
    foot.querySelectorAll('.shtab').forEach(b => b.onclick = () => { si = +b.dataset.i; closeEdit(); renderSheet(); });
  }

  function pickCell(td) {
    if (picked) picked.classList.remove('picked');
    picked = td; td.classList.add('picked');
    const sh = model.sheets[si];
    const r = +td.dataset.r, c = +td.dataset.c;
    $('editRef').textContent = colName(c) + r;
    $('editInput').value = td.textContent;
    $('editBar').classList.add('on');
    $('editInput').focus();
    $('editInput').select();
    editTarget = { sheet: sh.name, r, c, td };
  }
  function closeEdit() {
    $('editBar').classList.remove('on');
    if (picked) picked.classList.remove('picked');
    picked = null; editTarget = null;
  }
  function commitEdit(moveNext) {
    if (!editTarget) return;
    const v = $('editInput').value;
    const { sheet, r, c, td } = editTarget;
    const sh = model.sheets.find(s => s.name === sheet);
    edits.set(`${sheet}|${r}|${c}`, { sheet, r, c, value: v });
    // 화면·모델 즉시 반영(시트를 오갔다 와도 유지)
    td.textContent = v;
    td.classList.add('edited');
    if (sh && sh.rows[r - 1]) {
      const prev = sh.rows[r - 1][c - 1];
      const sidx = prev === 0 || !prev ? 0 : prev[1];
      sh.rows[r - 1][c - 1] = v ? [v, sidx] : 0;
    }
    $('btnSave').style.display = '';
    persistEdits();
    // 한 사람 정보가 한 줄에 가로로 놓이는 서식이 많아 다음 칸 = 오른쪽
    const next = moveNext ? td.nextElementSibling : null;
    if (next && next.dataset.r) { pickCell(next); next.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
    else closeEdit();
  }
  cur.resetEdits = async () => {
    edits.clear();
    $('btnSave').style.display = 'none';
    const d = await docGet(doc.id);
    if (d) { delete d.edits; try { await docPut(d); } catch {} }
    toast('고친 내용을 되돌렸어요 · 원본 그대로예요');
    openDoc(doc.id, false); // 원본에서 다시 읽어 화면 복구
  };

  $('editOk').onclick = () => commitEdit(true);
  $('editInput').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); commitEdit(true); } };

  renderSheet();
  loadingHide();
}
let editTarget = null;
function colName(n) { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = (n - 1 - m) / 26; } return s; }

// 고친 엑셀 저장 — 워커가 zip 안 해당 시트 XML만 고쳐 되돌려준다(원본 서식·유효성·차트 보존)
async function saveEditedSheet(doc, worker, edits) {
  if (!edits.size) { toast('아직 고친 칸이 없어요'); return; }
  loadingShow('고친 내용을 저장하는 중');
  const out = await new Promise((res, rej) => {
    const prev = worker.onmessage;
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'saved') { worker.onmessage = prev; res(m); }
      else if (m.type === 'error') { worker.onmessage = prev; rej(new Error(m.msg)); }
      else if (m.type === 'progress') loadingProg(m.p, m.msg);
    };
    worker.postMessage({ cmd: 'save', edits: [...edits.values()] });
  }).catch(err => { loadingHide(); showErrorToast(err); return null; });
  loadingHide();
  if (!out) return;
  const base = doc.name.replace(/\.(xlsx|xlsm|xls)$/i, '');
  const name = `${base}_수정.xlsx`;
  const blob = new Blob([out.bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  pendingSave = { blob, name, encrypted: out.encrypted };
  $('saveHead').textContent = out.encrypted
    ? '암호는 원래대로 걸어서 저장했어요'
    : `고친 칸 ${edits.size}개를 새 파일로 만들었어요`;
  openSheet('saveSheet');
}
let pendingSave = null;
function showErrorToast(err) { toast('저장하지 못했어요 · ' + String(err.message || err).slice(0, 60)); }

// ───────────────────── PDF 뷰어 (pdf.js — pdfpng 벤더 승계)
async function viewPdf(doc, blob) {
  loadingProg(20, '뷰어 준비 중');
  const pdfjs = await import('../vendor/pdfjs/pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
  loadingProg(45, '문서를 여는 중이에요');
  const pdf = await pdfjs.getDocument({ data: await blob.arrayBuffer() }).promise;
  const vb = $('vBody'); vb.className = 'vbody'; vb.innerHTML = '';
  const cont = document.createElement('div'); cont.className = 'pages'; vb.appendChild(cont);
  const base = Math.min(vb.clientWidth - 28, 900);
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const phs = [];
  const p1 = await pdf.getPage(1);
  const vp1 = p1.getViewport({ scale: 1 });
  for (let i = 1; i <= pdf.numPages; i++) {
    const d = document.createElement('div');
    d.className = 'pageph'; d.dataset.i = i;
    d.style.width = base + 'px'; d.style.aspectRatio = `${vp1.width}/${vp1.height}`;
    cont.appendChild(d); phs.push(d);
  }
  let zoom = 1;
  async function renderPage(holder, z) {
    const i = +holder.dataset.i;
    const page = i === 1 ? p1 : await pdf.getPage(i);
    const vp = page.getViewport({ scale: (base / vp1.width) * dpr * z });
    const cv = document.createElement('canvas');
    cv.width = Math.floor(vp.width); cv.height = Math.floor(vp.height);
    await page.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
    holder.innerHTML = ''; holder.appendChild(cv);
    holder.dataset.z = z;
  }
  const foot = $('vFoot');
  foot.innerHTML = `<span class="hint">두 손가락으로 확대</span><span class="pg tnum" id="pgInd">1 / ${pdf.numPages}쪽</span>`;
  const io = new IntersectionObserver((ents) => {
    for (const en of ents) {
      const holder = en.target;
      if (en.isIntersecting) {
        if (!holder.dataset.done) { holder.dataset.done = 1; renderPage(holder, zoom); }
        if (en.intersectionRatio > 0.4) { const el = $('pgInd'); if (el) el.textContent = `${holder.dataset.i} / ${pdf.numPages}쪽`; }
      }
    }
  }, { root: vb, rootMargin: '500px 0px', threshold: [0, 0.45] });
  phs.forEach(d => io.observe(d));
  attachPinch(vb, () => cont, {
    min: 0.6, max: 3.5,
    onEnd: (z) => { // 멈추면 보이는 쪽만 선명 재렌더 (pdfpng 확대 경험 재사용)
      zoom = z;
      const r = vb.getBoundingClientRect();
      phs.forEach(d => {
        const dr = d.getBoundingClientRect();
        if (dr.bottom > r.top - 400 && dr.top < r.bottom + 400 && d.dataset.done && d.dataset.z !== String(z)) renderPage(d, z);
      });
    }
  });
  cur.cleanup = () => { io.disconnect(); pdf.destroy(); };
  loadingHide();
}

// ───────────────────── 이미지·HTML 표·텍스트
async function viewImage(doc, blob) {
  const url = URL.createObjectURL(blob);
  const vb = $('vBody'); vb.className = 'vbody';
  vb.innerHTML = `<div class="imgwrap"><img src="${url}" alt=""></div>`;
  $('vFoot').innerHTML = `<span class="hint">두 손가락으로 확대</span>`;
  attachPinch(vb, () => vb.querySelector('.imgwrap'), { min: 0.5, max: 4 });
  cur.cleanup = () => URL.revokeObjectURL(url);
  loadingHide();
}
async function decodeK(blob) {
  const buf = await blob.arrayBuffer();
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }
  catch { return new TextDecoder('euc-kr').decode(buf); } // 정부 시스템 산출물 대비
}
async function viewHtml(doc, blob) {
  // "xls인데 실은 HTML 표"(전자바우처·홈택스) — 스크립트 차단 iframe으로 표시
  const text = await decodeK(blob);
  const vb = $('vBody'); vb.className = 'vbody white'; vb.innerHTML = '';
  const f = document.createElement('iframe');
  f.className = 'htmlframe'; f.setAttribute('sandbox', '');
  f.srcdoc = text;
  vb.appendChild(f);
  $('vFoot').innerHTML = '';
  loadingHide();
}
async function viewText(doc, blob) {
  const text = await decodeK(blob);
  const vb = $('vBody'); vb.className = 'vbody white';
  vb.innerHTML = `<article class="reflow" style="white-space:pre-wrap;font-size:14px">${esc(text.slice(0, 400000))}</article>`;
  $('vFoot').innerHTML = '';
  loadingHide();
}

// ───────────────────── 암호 다이얼로그
function askPassword(msg) {
  return new Promise((res) => {
    $('pwMsg').textContent = msg;
    $('pwInput').value = '';
    $('pwDlg').classList.add('on');
    setTimeout(() => $('pwInput').focus(), 60);
    const done = (v) => { $('pwDlg').classList.remove('on'); $('pwGo').onclick = $('pwCancel').onclick = null; res(v); };
    $('pwGo').onclick = () => done($('pwInput').value);
    $('pwCancel').onclick = () => done(null);
    $('pwInput').onkeydown = (e) => { if (e.key === 'Enter') done($('pwInput').value); };
  });
}

// ───────────────────── 바텀시트 (⋮ 메뉴 · 수정본 저장)
function openSheet(id) { $('sheetBg').classList.add('on'); $(id).classList.add('on'); }
const closeMenu = () => { $('sheetBg').classList.remove('on'); $('menuSheet').classList.remove('on'); $('saveSheet').classList.remove('on'); };
$('btnMenu').addEventListener('click', () => openSheet('menuSheet'));
$('sheetBg').addEventListener('click', closeMenu);
$('miClose').addEventListener('click', closeMenu);
$('svClose').addEventListener('click', closeMenu);
$('miShare').addEventListener('click', async () => {
  closeMenu();
  if (!cur) return;
  await shareOrDownload(cur.blob, cur.doc.name, cur.doc.mime || 'application/octet-stream', true);
});
$('miPrint').addEventListener('click', async () => {
  closeMenu();
  if (!cur) return;
  window.print(); // 페이지형은 화면에 렌더된 쪽까지 출력 — 긴 문서는 스크롤로 내려 렌더 후 출력
});

// 안드로이드: 공유 시트(메일·카톡 회신) 우선, 없으면 다운로드 폴더로 저장.
// 네이티브 셸 안에서는 WebView에 공유·저장 기능이 없어 앱 쪽 창구를 쓴다.
const NATIVE = typeof window.__native === 'object' && window.__native && typeof window.__native.saveBase64 === 'function';
const blobToBase64 = (blob) => new Promise((res, rej) => {
  const fr = new FileReader();
  fr.onload = () => res(String(fr.result).split(',')[1] || '');
  fr.onerror = () => rej(fr.error);
  fr.readAsDataURL(blob);
});
async function shareOrDownload(blob, name, mime, preferShare) {
  if (NATIVE) {
    const b64 = await blobToBase64(blob);
    if (preferShare && typeof window.__native.shareBase64 === 'function') { window.__native.shareBase64(b64, name, mime || ''); return 'share'; }
    window.__native.saveBase64(b64, name, mime || '');
    return 'native-save';
  }
  const file = new File([blob], name, { type: mime });
  if (preferShare && navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return 'share'; }
    catch (e) { if (e && e.name === 'AbortError') return 'cancel'; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  return 'download';
}

// 엑셀 수정본 저장 흐름
$('btnSave').addEventListener('click', () => { if (cur && cur.saveSheet) cur.saveSheet(); });
$('svShare').addEventListener('click', async () => {
  closeMenu();
  if (!pendingSave) return;
  const how = await shareOrDownload(pendingSave.blob, pendingSave.name, pendingSave.blob.type, true);
  if (how === 'download') toast(`보내기가 안 돼서 폰에 저장했어요 · ${pendingSave.name}`);
});
$('svDown').addEventListener('click', async () => {
  closeMenu();
  if (!pendingSave) return;
  const how = await shareOrDownload(pendingSave.blob, pendingSave.name, pendingSave.blob.type, false);
  if (how !== 'native-save') toast(`다운로드 폴더에 저장했어요 · ${pendingSave.name}`); // 앱 안에서는 앱이 알려준다
});
$('svReset').addEventListener('click', () => {
  closeMenu();
  if (cur && cur.resetEdits) cur.resetEdits();
});
$('miRemove').addEventListener('click', async () => {
  closeMenu();
  if (!cur) return;
  const d = await docGet(cur.doc.id);
  lastRemoved = d;
  await docDel(cur.doc.id);
  transientBlobs.delete(cur.doc.id);
  showList(true);
  snackbar('목록에서 지웠어요 · 폰의 원본 파일은 그대로예요', '되돌리기', async () => {
    if (lastRemoved) { await docPut(lastRemoved); lastRemoved = null; renderList(); }
  });
});

// ───────────────────── 스낵바·토스트
let snackTimer = 0;
function snackbar(msg, act, fn) {
  $('snackMsg').textContent = msg;
  $('snackAct').textContent = act || '';
  $('snackAct').style.display = act ? '' : 'none';
  $('snackAct').onclick = () => { hideSnack(); fn && fn(); };
  $('snack').classList.add('on');
  clearTimeout(snackTimer);
  snackTimer = setTimeout(hideSnack, 6000);
}
const hideSnack = () => $('snack').classList.remove('on');
const toast = (msg) => snackbar(msg, '');

// ───────────────────── 히스토리 (문서함서 뒤로 = 종료가 정상 — 트랩 금지)
history.scrollRestoration = 'manual';
$('btnBack').addEventListener('click', () => {
  if (history.state && history.state.v) history.back();
  else showList(true);
});
window.addEventListener('popstate', () => {
  const id = new URLSearchParams(location.search).get('doc');
  if (id) openDoc(id, false);
  else showList(false);
});

// ───────────────────── 네이티브 셸(안드로이드 앱)에서 넘어온 파일 받기
// 안드로이드 '연결 앱/다른 앱으로 열기'는 웹앱이 등록될 수 없어(구조적 한계, docs/5 §1-f)
// 얇은 네이티브 껍데기가 인텐트를 받아 이 경로로 파일 바이트를 흘려준다.
async function openFromNative() {
  loadingShow('문서를 여는 중이에요');
  try {
    const r = await fetch('__native_file?t=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) throw new Error('no file ' + r.status);
    const name = decodeURIComponent(r.headers.get('X-File-Name') || '문서');
    const blob = await r.blob();
    const file = new File([blob], name, { type: r.headers.get('Content-Type') || '', lastModified: Date.now() });
    const id = await registerFile(file, 'native');
    loadingHide();
    if (id) { history.replaceState({}, '', `./?doc=${id}`); openDoc(id, false); return; }
  } catch (e) {
    loadingHide();
    toast('파일을 받지 못했어요 · [파일 열기]로 열어 주세요');
  }
  history.replaceState({}, '', './');
  renderList();
}

// ───────────────────── 앱 설치 안내 (?install=1)
// 링크 하나로 끝나게 만드는 화면 — 사람마다 말로 안내하지 않기 위해서다.
// (스토어에 올리기 전까지의 다리. 스토어 배포가 확정되면 이 화면은 스토어 링크만 남기고 단순해진다)
const APK_URL = 'https://github.com/think-fact0ry/reader/releases/download/apk-latest/saenggak-reader.apk';
function renderInstall() {
  document.body.innerHTML = `
    <section class="view on" style="overflow:auto">
      <div class="da-head"><div><span class="da-brand">생각공작소</span><div class="da-title">문서 리더기 설치</div></div></div>
      <div class="insWrap">
        <p class="insLead">앱을 설치하면 <b>메일·파일함에서 문서를 누를 때</b> 바로 열려요.
          설치 없이 이 화면 그대로 써도 됩니다(그때는 공유 버튼으로 열어요).</p>

        <div class="insStep"><span class="n">1</span><div><b>아래 [앱 받기]를 누르세요</b><br>
          <span class="sub">받은 파일은 알림이나 다운로드 폴더에 있어요</span></div></div>

        <div class="insStep"><span class="n">2</span><div><b>갤럭시는 한 번만 설정이 필요해요</b><br>
          <span class="sub">설치가 막히면 → 설정 → 보안 및 개인정보 보호 → <b>보안 위험 자동 차단</b> 끄기</span><br>
          <span class="sub">설치를 마치면 <b>다시 켜 두세요</b>(평소엔 켜 두는 게 안전합니다)</span></div></div>

        <div class="insStep"><span class="n">3</span><div><b>받은 파일을 눌러 설치하세요</b><br>
          <span class="sub">설치 뒤 문서를 누르면 목록에 <b>문서 리더기</b>가 보여요 — <b>‘한 번만’</b>을 누르시길 권합니다</span></div></div>

        <a class="da-open" style="display:block;text-align:center;text-decoration:none;margin:18px 16px 6px" href="${APK_URL}">앱 받기</a>
        <button class="fbtn" id="insWeb" style="width:calc(100% - 32px);margin:10px 16px;padding:13px">설치하지 않고 웹으로 쓰기</button>
        <p class="insNote">앱을 쓰기 시작하면 홈 화면에 만들어 둔 바로가기는 지워 주세요.
          안드로이드가 둘의 저장 공간을 따로 관리해서 <b>문서함 목록이 서로 달라 보입니다</b>.</p>
      </div>
    </section>`;
  $('insWeb').onclick = () => location.href = './';
}

// ───────────────────── 자가진단 (?diag=1) — 실기기에서 무엇이 되고 안 되는지 앱이 스스로 보고
async function renderDiag() {
  const rows = [];
  const yn = (b) => b ? '✅ 예' : '❌ 아니오';
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const ua = navigator.userAgent;
  const inApp = /KAKAOTALK|NAVER\(inapp|inapp;|FBAV|Instagram|Line\//i.test(ua);
  const br = /SamsungBrowser/i.test(ua) ? '삼성 인터넷' : /Chrome/i.test(ua) ? 'Chrome' : /Firefox/i.test(ua) ? 'Firefox' : '기타';
  rows.push(['앱으로 설치돼 열림', yn(standalone), standalone ? '' : '홈 화면 아이콘으로 열어야 공유 진입이 됩니다', 'warn']);
  rows.push(['실행 방식', NATIVE ? '설치한 앱(문서 리더)' : (inApp ? '앱 안 브라우저(' + br + ')' : br + ' 브라우저'),
    NATIVE ? '파일에서 바로 열기가 됩니다' : (inApp ? '카톡·메일 앱 안에서 열림 — Chrome으로 열어야 합니다' : ''), NATIVE ? 'ok' : 'warn']);
  let swOk = !!navigator.serviceWorker.controller;
  rows.push(['서비스워커 작동', yn(swOk), swOk ? '' : '새로고침 한 번 해 주세요(공유 진입이 이것에 매달립니다)', 'warn']);
  let canFile = false;
  try {
    const f = new File([new Uint8Array([1, 2, 3])], 't.hwp', { type: 'application/octet-stream' });
    canFile = !!(navigator.canShare && navigator.canShare({ files: [f] }));
  } catch {}
  rows.push(['파일 공유·보내기 지원', yn(canFile), canFile ? '' : '수정본은 다운로드 폴더 저장으로 대체됩니다', 'info']);
  let est = null, persisted = false;
  try { est = await navigator.storage.estimate(); persisted = await navigator.storage.persisted(); } catch {}
  rows.push(['저장 공간 사용', est ? `${(est.usage / 1048576).toFixed(1)}MB / ${(est.quota / 1048576 / 1024).toFixed(1)}GB` : '알 수 없음', '']);
  rows.push(['저장소 보호(persist)', yn(persisted), persisted ? '' : '보호 안 됨 — 캐시라 지워져도 원본은 폰에 그대로', 'info']);
  let wasmCached = false;
  try {
    const url = new URL('vendor/rhwp/rhwp_bg.wasm', location.href).href;
    for (const k of await caches.keys()) {
      if (!k.startsWith('vendor')) continue;
      const c = await caches.open(k);
      if (await c.match(url)) { wasmCached = true; break; }
    }
  } catch {}
  rows.push(['한글 엔진 미리 받음', yn(wasmCached), wasmCached ? '한글 파일이 바로 열립니다' : '첫 한글 파일 열 때 7MB를 받습니다(1회)', wasmCached ? 'ok' : 'info']);
  const vs = (visualViewport && visualViewport.scale) ? visualViewport.scale.toFixed(2) : '1.00';
  rows.push(['화면 확대 배율', vs, vs !== '1.00' ? '접근성 확대가 켜져 있으면 표 확대가 이중으로 될 수 있어요' : '', 'warn']);
  rows.push(['화면 크기', `${innerWidth}×${innerHeight} (배율 ${devicePixelRatio})`, '']);
  const docs = await docsAll();
  rows.push(['앱에 담긴 문서', `${docs.length}개`, '']);

  document.body.innerHTML = `
    <section class="view on" style="overflow:auto">
      <div class="da-head"><div class="da-title">상태 확인</div></div>
      <div style="padding:0 16px 20px">
        <table class="diag">${rows.map(r => `<tr><td class="k">${esc(r[0])}</td><td class="v">${esc(r[1])}</td></tr>${r[2] ? `<tr><td colspan="2" class="note ${r[3] || 'info'}">${esc(r[2])}</td></tr>` : ''}`).join('')}</table>
        <button class="da-open" id="dgCopy" style="margin:16px 0 0">이 내용 복사하기</button>
        <button class="fbtn" id="dgBack" style="width:100%;margin-top:10px;padding:13px">문서함으로</button>
      </div>
    </section>`;
  $('dgCopy').onclick = async () => {
    const txt = '[문서리더 상태]\n' + rows.map(r => `${r[0]}: ${r[1]}${r[2] ? ' — ' + r[2] : ''}`).join('\n') + `\n${ua}`;
    try { await navigator.clipboard.writeText(txt); $('dgCopy').textContent = '복사했어요 · 카톡에 붙여넣기'; }
    catch { alert(txt); }
  };
  $('dgBack').onclick = () => location.href = './';
}

// 한글 엔진(7MB WASM)은 처음 여는 순간에 받으면 느리다 — 쉬는 동안 미리 받아 캐시에 넣어 둔다
function prefetchHwpEngine() {
  const c = navigator.connection;
  if (c && (c.saveData || /(^|-)2g$/.test(c.effectiveType || ''))) return; // 데이터 절약 중이면 건너뜀
  const go = () => { fetch('vendor/rhwp/rhwp_bg.wasm', { cache: 'force-cache' }).catch(() => {}); };
  if ('requestIdleCallback' in window) requestIdleCallback(() => setTimeout(go, 2500), { timeout: 10000 });
  else setTimeout(go, 6000);
}

// ───────────────────── 진입 처리
const params = new URLSearchParams(location.search);
enforceLRU(params.get('doc') || null); // 공유 진입으로 쌓인 캐시도 상한 유지 (오리진 공유 수용 조건)
if (params.get('share') === 'toobig') toast('60MB가 넘는 파일은 열 수 없어요');
else if (params.get('share') === 'fail' || params.get('share') === 'empty') toast('공유로 받은 파일을 읽지 못했어요 · [파일 열기]로 시도해 주세요');
if (params.get('install')) renderInstall();
else if (params.get('diag')) renderDiag();
else if (params.get('native')) openFromNative();
else if (params.get('doc')) openDoc(params.get('doc'), false);
else { renderList(); prefetchHwpEngine(); }

// ───────────────────── SW·설치·인앱 브라우저
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch {}

const ua = navigator.userAgent;
const isInApp = /KAKAOTALK|NAVER\(inapp|inapp;|FBAV|Instagram|Line\//i.test(ua);
const isStandalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
if (isInApp) {
  $('inappBanner').style.display = '';
  $('openChrome').addEventListener('click', () => {
    location.href = 'intent://think-fact0ry.github.io/reader/#Intent;scheme=https;package=com.android.chrome;end';
  });
}
let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredPrompt = e; });
if (!isStandalone && !isInApp) $('installBar').classList.add('on');
$('btnInstall').addEventListener('click', async () => {
  if (deferredPrompt) { deferredPrompt.prompt(); deferredPrompt = null; $('installBar').classList.remove('on'); }
  else alert('Chrome 우상단 ⋮ 메뉴 → "홈 화면에 추가"를 눌러 주세요.');
});
