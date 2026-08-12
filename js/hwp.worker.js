// 한글(.hwp 5.0 / .hwpx) 파서 워커 — rhwp(@rhwp/core 0.8.2, WASM) 격리 실행
// 프로토콜: open{bytes} → ready{pages,w,h} / page{i} → svg / reflow → blocks / 진행: progress
import init, { HwpDocument } from '../vendor/rhwp/rhwp.js';

// rhwp는 init 전에 전역 measureTextWidth(canvas 폭 측정)를 요구
let mctx = null, lastFont = '';
globalThis.measureTextWidth = (font, text) => {
  if (!mctx) mctx = new OffscreenCanvas(1, 1).getContext('2d');
  if (font !== lastFont) { mctx.font = font; lastFont = font; }
  return mctx.measureText(text).width;
};

let doc = null;
let inited = false;
const post = (m) => self.postMessage(m);
const prog = (p, msg) => post({ type: 'progress', p, msg });

// rhwp 문자열 반환은 raw/JSON이 섞여 있어 관용 파싱
function loose(s) {
  if (typeof s !== 'string') return s;
  const t = s.trim();
  if (t.startsWith('{') || t.startsWith('[')) { try { return JSON.parse(t); } catch { return s; } }
  return s;
}
function textOf(s) {
  const v = loose(s);
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') return v.text ?? v.value ?? '';
  return '';
}

function buildReflow() {
  // 읽기(리플로우) 모드: 구역→문단 순회로 텍스트 + 표(HTML) 추출
  const blocks = [];
  const secs = doc.getSectionCount();
  for (let s = 0; s < secs; s++) {
    const n = doc.getParagraphCount(s);
    for (let p = 0; p < n; p++) {
      // 이 문단에 걸린 컨트롤(표 등) → HTML로 변환해 문단 앞에 배치
      let ctrls = [];
      try { const c = loose(doc.getControlTextPositions(s, p)); if (Array.isArray(c)) ctrls = c; } catch {}
      for (let ci = 0; ci < Math.max(ctrls.length, 0); ci++) {
        try {
          const h = doc.exportControlHtml(s, p, '', ctrls[ci].controlIndex ?? ctrls[ci].index ?? ci);
          const hv = loose(h);
          const html = typeof hv === 'string' ? hv : (hv && hv.html) || '';
          if (html && html.trim().startsWith('<')) blocks.push({ t: 'html', html });
        } catch {}
      }
      try {
        const len = doc.getParagraphLength(s, p);
        if (len > 0) {
          const text = textOf(doc.getTextRange(s, p, 0, len));
          if (text && text.trim()) blocks.push({ t: 'p', text });
        }
      } catch {}
    }
  }
  return blocks;
}

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.cmd === 'open') {
      prog(8, '뷰어 준비 중');
      if (!inited) {
        await init({ module_or_path: new URL('../vendor/rhwp/rhwp_bg.wasm', import.meta.url) });
        inited = true;
      }
      prog(35, '문서를 여는 중이에요');
      doc = new HwpDocument(new Uint8Array(m.bytes));
      prog(75, '문서를 여는 중이에요');
      const pages = doc.pageCount();
      // 쪽 크기: 첫 페이지 SVG의 width/height 속성에서 취득
      let w = 794, h = 1123, svg0 = '';
      if (pages > 0) {
        svg0 = doc.renderPageSvg(0);
        const mw = svg0.match(/width="([\d.]+)/), mh = svg0.match(/height="([\d.]+)/);
        if (mw) w = parseFloat(mw[1]);
        if (mh) h = parseFloat(mh[1]);
      }
      prog(96, '거의 다 됐어요');
      post({ type: 'ready', kind: 'hwp', pages, w, h, svg0 });
    } else if (m.cmd === 'page') {
      post({ type: 'page', i: m.i, svg: doc.renderPageSvg(m.i) });
    } else if (m.cmd === 'reflow') {
      prog(50, '읽기 모드로 바꾸는 중');
      post({ type: 'reflow', blocks: buildReflow() });
    }
  } catch (err) {
    post({ type: 'error', where: m.cmd, msg: String(err && err.message || err).slice(0, 300) });
  }
};
