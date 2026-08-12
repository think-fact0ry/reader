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
const srcLabel = { share: '공유로 받음', picker: '파일 열기' };

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
    return `<button class="da-card" data-id="${d.id}">
      <span class="fbadge ${cls}">${label}</span>
      <div><div class="da-name">${esc(d.name)}</div>
      <div class="da-meta">${fmtTime(d.lastOpenedAt || d.addedAt)} · ${srcLabel[d.source] || ''}</div></div>
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
  $('segWrap').style.display = 'none';
  $('warnReflow').style.display = 'none';
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

// ───────────────────── 한글 뷰어 (rhwp — [읽기|원본] 세그)
async function viewHwp(doc, blob) {
  const worker = new Worker(new URL('./hwp.worker.js', import.meta.url), { type: 'module' });
  cur.worker = worker;
  const bytes = await blob.arrayBuffer();
  const svgCache = new Map();
  let pages = 0, pw = 794, ph = 1123, reflowBlocks = null;
  let mode = (await prefGet('hwpMode')) || 'read';

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
  pages = ready.pages; pw = ready.w; ph = ready.h;
  if (ready.svg0) svgCache.set(0, ready.svg0);

  // 이후 메시지(페이지·리플로우) 핸들러
  const pageWaiters = new Map();
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'page') { svgCache.set(m.i, m.svg); const w = pageWaiters.get(m.i); if (w) { w(m.svg); pageWaiters.delete(m.i); } }
    else if (m.type === 'reflow') { reflowBlocks = m.blocks; if (mode === 'read') renderRead(); }
    else if (m.type === 'progress') loadingProg(m.p, m.msg);
    else if (m.type === 'error') { loadingHide(); if (m.where === 'reflow') { reflowBlocks = []; if (mode === 'read') renderRead(); } }
  };
  const getPage = (i) => svgCache.has(i) ? Promise.resolve(svgCache.get(i)) :
    new Promise((res) => { pageWaiters.set(i, res); worker.postMessage({ cmd: 'page', i }); });

  $('segWrap').style.display = '';
  const segR = $('segRead'), segO = $('segOrig');
  const setSeg = () => { segR.classList.toggle('on', mode === 'read'); segO.classList.toggle('on', mode === 'orig'); };
  segR.onclick = () => { if (mode !== 'read') { mode = 'read'; prefSet('hwpMode', 'read'); setSeg(); renderRead(); } };
  segO.onclick = () => { if (mode !== 'orig') { mode = 'orig'; prefSet('hwpMode', 'orig'); setSeg(); renderOrig(); } };
  setSeg();

  let pinch = null, fontScale = (await prefGet('fontScale')) || 1;

  function renderOrig() {
    $('warnReflow').style.display = 'none';
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
    let curPage = 1;
    const foot = $('vFoot');
    foot.innerHTML = `<span class="hint">두 손가락으로 확대</span><span class="pg tnum" id="pgInd">1 / ${pages}쪽</span>`;
    const io = new IntersectionObserver((ents) => {
      for (const en of ents) {
        const i = +en.target.dataset.i;
        if (en.isIntersecting) {
          if (!en.target.dataset.done) { en.target.dataset.done = 1; getPage(i).then(svg => { en.target.innerHTML = svg; }); }
          if (en.intersectionRatio > 0.4) { curPage = i + 1; const el = $('pgInd'); if (el) el.textContent = `${curPage} / ${pages}쪽`; }
        }
      }
    }, { root: vb, rootMargin: '600px 0px', threshold: [0, 0.45] });
    phs.forEach(d => io.observe(d));
    pinch = attachPinch(vb, () => cont, { min: 0.6, max: 3.5 });
    cur.cleanup = () => io.disconnect();
    loadingHide();
  }

  function renderRead() {
    $('warnReflow').style.display = '';
    const vb = $('vBody'); vb.className = 'vbody white'; vb.innerHTML = '';
    if (reflowBlocks === null) { loadingShow('읽기 모드로 바꾸는 중'); worker.postMessage({ cmd: 'reflow' }); return; }
    const art = document.createElement('article'); art.className = 'reflow';
    art.style.fontSize = (16 * fontScale) + 'px';
    if (!reflowBlocks.length) {
      art.innerHTML = `<p style="color:var(--g500)">읽기 모드로 바꿀 내용을 찾지 못했어요. 상단 [원본]으로 봐 주세요.</p>`;
    } else {
      art.innerHTML = reflowBlocks.map(b =>
        b.t === 'p' ? `<p>${esc(b.text)}</p>` : `<div class="rtbl">${sanitizeHtml(b.html)}</div>`
      ).join('');
    }
    vb.appendChild(art);
    const foot = $('vFoot');
    foot.innerHTML = `<button class="fbtn" id="fMinus">가−</button><button class="fbtn" id="fPlus">가+</button>`;
    $('fMinus').onclick = () => { fontScale = Math.max(0.8, +(fontScale - 0.1).toFixed(2)); art.style.fontSize = (16 * fontScale) + 'px'; prefSet('fontScale', fontScale); };
    $('fPlus').onclick = () => { fontScale = Math.min(1.8, +(fontScale + 0.1).toFixed(2)); art.style.fontSize = (16 * fontScale) + 'px'; prefSet('fontScale', fontScale); };
    cur.cleanup = null;
    loadingHide();
  }

  if (mode === 'read') renderRead(); else renderOrig();
}

// 워커가 만든 표 HTML을 화면에 넣기 전 무해화
function sanitizeHtml(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  tpl.content.querySelectorAll('script,style,iframe,object,embed,link,meta').forEach(n => n.remove());
  tpl.content.querySelectorAll('*').forEach(n => {
    for (const a of [...n.attributes]) {
      if (/^on/i.test(a.name) || (a.name === 'href' && /^javascript:/i.test(a.value)) || a.name === 'srcdoc') n.removeAttribute(a.name);
    }
  });
  return tpl.innerHTML;
}

// ───────────────────── 엑셀 뷰어 (틀 고정 + 핀치)
async function viewSheet(doc, blob) {
  const worker = new Worker(new URL('./sheet.worker.js', import.meta.url));
  cur.worker = worker;
  const send = async (password) => {
    const bytes = await blob.arrayBuffer();
    worker.postMessage({ cmd: 'open', bytes, ext: doc.ext, password }, [bytes]);
  };
  const model = await new Promise((res, rej) => {
    worker.onerror = (e) => rej(new Error(e.message || 'worker error')); // 조용한 행 금지
    worker.onmessage = async (e) => {
      const m = e.data;
      if (m.type === 'progress') loadingProg(m.p, m.msg);
      else if (m.type === 'ready') res(m.model);
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
  if (!model) return;

  const vb = $('vBody'); vb.className = 'vbody white';
  let si = 0, pinch = null;
  function renderSheet() {
    const sh = model.sheets[si];
    vb.innerHTML = '';
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
        const cls = [(r < fr ? 'stik-t' : ''), (c < fc ? 'stik-l' : ''), (r < fr ? 'hd' : '')].filter(Boolean).join(' ');
        html += `<td${cls ? ` class="${cls}"` : ''}${st ? ` style="${st}"` : ''}${mg ? ` rowspan="${mg.rs}" colspan="${mg.cs}"` : ''}>${esc(text)}</td>`;
      }
      html += '</tr>';
    }
    html += '</table>';
    if (sh.truncated) html += `<div class="truncnote">표가 커서 ${Math.min(sh.totalR, 99999)}행 중 ${sh.rows.length}행까지 보여드려요 · 전체는 PC에서 확인해 주세요</div>`;
    wrap.innerHTML = html;
    pinch = attachPinch(wrap, () => wrap.querySelector('.xltab'), { min: 0.5, max: 3 });
    const foot = $('vFoot');
    foot.innerHTML = `<div class="sheets">${model.sheets.map((s, i) =>
      `<button class="shtab${i === si ? ' on' : ''}" data-i="${i}">${esc(s.name)}</button>`).join('')}</div>
      <span class="hint">두 손가락으로 확대</span>`;
    foot.querySelectorAll('.shtab').forEach(b => b.onclick = () => { si = +b.dataset.i; renderSheet(); });
  }
  renderSheet();
  loadingHide();
}

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

// ───────────────────── ⋮ 메뉴 (공유·출력·목록에서 지우기)
$('btnMenu').addEventListener('click', () => { $('sheetBg').classList.add('on'); $('menuSheet').classList.add('on'); });
const closeMenu = () => { $('sheetBg').classList.remove('on'); $('menuSheet').classList.remove('on'); };
$('sheetBg').addEventListener('click', closeMenu);
$('miClose').addEventListener('click', closeMenu);
$('miShare').addEventListener('click', async () => {
  closeMenu();
  if (!cur) return;
  const file = new File([cur.blob], cur.doc.name, { type: cur.doc.mime || 'application/octet-stream' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file] }); } catch {}
  } else {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(cur.blob); a.download = cur.doc.name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
});
$('miPrint').addEventListener('click', async () => {
  closeMenu();
  if (!cur) return;
  if (cur.kind === 'hwp' && $('warnReflow').style.display !== 'none') {
    if (!confirm('읽기 모드는 원본과 배치가 달라요. 제출용이면 원본 모드로 출력해 주세요.\n이대로 출력할까요?')) return;
  }
  window.print(); // 페이지형은 화면에 렌더된 쪽까지 출력 — 긴 문서는 스크롤로 내려 렌더 후 출력
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

// ───────────────────── 진입 처리
const params = new URLSearchParams(location.search);
enforceLRU(params.get('doc') || null); // 공유 진입으로 쌓인 캐시도 상한 유지 (오리진 공유 수용 조건)
if (params.get('share') === 'toobig') toast('60MB가 넘는 파일은 열 수 없어요');
else if (params.get('share') === 'fail' || params.get('share') === 'empty') toast('공유로 받은 파일을 읽지 못했어요 · [파일 열기]로 시도해 주세요');
if (params.get('doc')) openDoc(params.get('doc'), false);
else renderList();

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
