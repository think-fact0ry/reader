// 한글(.hwp 5.0 / .hwpx) 파서 워커 — rhwp(@rhwp/core 0.8.2, WASM) 격리 실행
// 프로토콜: open{bytes} → ready{pages,w,h} / page{i} → svg / 진행: progress
// 렌더는 원본(페이지) 한 가지뿐 — 읽기(리플로우) 모드는 유성 확정으로 폐기(2026-08-12)
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
    }
  } catch (err) {
    post({ type: 'error', where: m.cmd, msg: String(err && err.message || err).slice(0, 300) });
  }
};
