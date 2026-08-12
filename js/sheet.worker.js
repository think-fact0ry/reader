// 엑셀 파서 워커 — ExcelJS(서식) + SheetJS(.xls 폴백·SSF 숫자서식) + officecrypto(암호) + 외과적 저장
// 프로토콜: open{bytes,ext,password?} → ready{model} / needpassword / badpassword / error
//           save{edits} → saved{bytes,encrypted}
importScripts('../vendor/exceljs.min.js', '../vendor/xlsx.full.min.js', '../vendor/officecrypto.browser.js',
  '../vendor/fflate.min.js', './xlsxpatch.js');

const post = (m) => self.postMessage(m);
const prog = (p, msg) => post({ type: 'progress', p, msg });
const MAX_ROWS = 3000, MAX_COLS = 120;

const isCFB = (u8) => u8[0] === 0xd0 && u8[1] === 0xcf && u8[2] === 0x11 && u8[3] === 0xe0;
const isZIP = (u8) => u8[0] === 0x50 && u8[1] === 0x4b;

function argbToCss(argb) {
  if (!argb || argb.length < 6) return '';
  const hex = argb.length === 8 ? argb.slice(2) : argb;
  return '#' + hex.toLowerCase();
}
// 자주 쓰는 테마색 근사(엑셀 기본 테마) — 채움색 판독용
const THEME = ['#ffffff', '#000000', '#e7e6e6', '#44546a', '#4472c4', '#ed7d31', '#a5a5a5', '#ffc000', '#5b9bd5', '#70ad47'];
function fillCss(fill) {
  if (!fill || fill.type !== 'pattern' || fill.pattern === 'none' || !fill.fgColor) return '';
  const c = fill.fgColor;
  if (c.argb) { const css = argbToCss(c.argb); return css === '#ffffff' ? '' : css; }
  if (typeof c.theme === 'number') {
    let css = THEME[c.theme] || '';
    if (css && c.tint > 0) css = '';  // 밝은 tint 근사 생략(흰색 계열)
    return css === '#ffffff' ? '' : css;
  }
  return '';
}
function dateToSerial(d) { return (d.getTime() - Date.UTC(1899, 11, 30)) / 86400000; }
function fmtGeneral(n) {
  if (!isFinite(n)) return String(n);
  if (Number.isInteger(n) && Math.abs(n) < 1e15) return n.toLocaleString('en-US').replace(/,/g, '') === String(n) ? String(n) : String(n);
  return String(Math.round(n * 1e10) / 1e10);
}
function dispValue(cell) {
  let v = cell.value;
  if (v == null) return { text: '', num: false };
  if (typeof v === 'object' && !(v instanceof Date)) {
    if (v.richText) return { text: v.richText.map(t => t.text).join(''), num: false };
    if (v.error) return { text: String(v.error), num: false };
    if (v.formula !== undefined || v.sharedFormula !== undefined) { v = v.result; if (v == null) return { text: '', num: false }; }
    if (v && typeof v === 'object' && v.hyperlink) return { text: v.text || v.hyperlink, num: false };
    if (v && typeof v === 'object' && v.richText) return { text: v.richText.map(t => t.text).join(''), num: false };
  }
  const fmt = cell.numFmt;
  try {
    if (v instanceof Date) return { text: XLSX.SSF.format(fmt && fmt !== 'General' ? fmt : 'yyyy-mm-dd', dateToSerial(v)), num: true };
    if (typeof v === 'number') {
      if (fmt && fmt !== 'General') return { text: XLSX.SSF.format(fmt, v), num: true };
      return { text: fmtGeneral(v), num: true };
    }
  } catch { return { text: String(v), num: typeof v === 'number' }; }
  if (typeof v === 'boolean') return { text: v ? 'TRUE' : 'FALSE', num: false };
  return { text: String(v), num: false };
}

async function modelFromExcelJS(u8) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(u8);
  prog(70, '표를 그리는 중');
  const sheets = [];
  const styles = ['']; const styleIdx = new Map([['', 0]]);
  wb.eachSheet((ws) => {
    if (ws.state && ws.state !== 'visible') return;
    const dim = ws.dimensions || { top: 1, left: 1, bottom: ws.rowCount || 1, right: ws.columnCount || 1 };
    const R = Math.min(dim.bottom || 1, MAX_ROWS), C = Math.min(dim.right || 1, MAX_COLS);
    const truncated = (dim.bottom > MAX_ROWS) || (dim.right > MAX_COLS);
    const rows = [];
    for (let r = 1; r <= R; r++) {
      const row = ws.getRow(r); const arr = [];
      for (let c = 1; c <= C; c++) {
        const cell = row.getCell(c);
        const { text, num } = dispValue(cell);
        let st = '';
        const f = cell.font || {};
        const bg = fillCss(cell.fill);
        if (bg) st += `background:${bg};`;
        if (f.bold) st += 'font-weight:700;';
        if (f.color && f.color.argb) { const cc = argbToCss(f.color.argb); if (cc && cc !== '#000000') st += `color:${cc};`; }
        if (f.strike) st += 'text-decoration:line-through;';
        const al = cell.alignment || {};
        if (al.horizontal === 'center') st += 'text-align:center;';
        else if (al.horizontal === 'right' || (num && !al.horizontal)) st += 'text-align:right;';
        if (al.wrapText) st += 'white-space:normal;';
        let si = styleIdx.get(st);
        if (si === undefined) { si = styles.length; styles.push(st); styleIdx.set(st, si); }
        arr.push(si === 0 && !text ? 0 : [text, si]);
      }
      rows.push(arr);
    }
    // 병합: 'A1:B2' 문자열 목록 → {r,c,rs,cs}
    const merges = [];
    try {
      for (const ref of (ws.model.merges || [])) {
        const g = XLSX.utils.decode_range(ref);
        if (g.s.r + 1 <= R && g.s.c + 1 <= C)
          merges.push({ r: g.s.r + 1, c: g.s.c + 1, rs: g.e.r - g.s.r + 1, cs: g.e.c - g.s.c + 1 });
      }
    } catch {}
    let frozen = { r: 0, c: 0 };
    try { const v = (ws.views || [])[0]; if (v && v.state === 'frozen') frozen = { r: v.ySplit || 0, c: v.xSplit || 0 }; } catch {}
    sheets.push({ name: ws.name, rows, merges, frozen, truncated, totalR: dim.bottom, totalC: dim.right });
  });
  return { kind: 'grid', sheets, styles };
}

function modelFromSheetJS(u8) {
  const wb = XLSX.read(u8, { type: 'array', cellText: true, cellNF: true, cellDates: false });
  const sheets = [];
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name]; if (!ws || !ws['!ref']) { sheets.push({ name, rows: [], merges: [], frozen: { r: 0, c: 0 } }); continue; }
    const g = XLSX.utils.decode_range(ws['!ref']);
    const R = Math.min(g.e.r + 1, MAX_ROWS), C = Math.min(g.e.c + 1, MAX_COLS);
    const rows = [];
    for (let r = 0; r < R; r++) {
      const arr = [];
      for (let c = 0; c < C; c++) {
        const cell = ws[XLSX.utils.encode_cell({ r, c })];
        if (!cell) { arr.push(0); continue; }
        const text = cell.w != null ? cell.w : (cell.v != null ? String(cell.v) : '');
        arr.push(text ? [text, cell.t === 'n' ? 1 : 0] : 0);
      }
      rows.push(arr);
    }
    const merges = (ws['!merges'] || []).map(m => ({ r: m.s.r + 1, c: m.s.c + 1, rs: m.e.r - m.s.r + 1, cs: m.e.c - m.s.c + 1 }));
    sheets.push({ name, rows, merges, frozen: { r: 0, c: 0 }, truncated: g.e.r + 1 > MAX_ROWS || g.e.c + 1 > MAX_COLS, totalR: g.e.r + 1, totalC: g.e.c + 1 });
  }
  return { kind: 'grid', sheets, styles: ['', 'text-align:right;'] };
}

// 저장용 보관: 열 때 쓴 (복호화된) 원본 zip 바이트와 암호
let srcZip = null, srcPassword = null, srcEditable = false;

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.cmd === 'open') {
      let u8 = new Uint8Array(m.bytes);
      srcZip = null; srcPassword = null; srcEditable = false;
      prog(15, '문서를 여는 중이에요');
      if (isCFB(u8)) {
        let enc = false;
        try { enc = OfficeCrypto.isEncrypted(u8); } catch {}
        if (enc) {
          if (!m.password) { post({ type: 'needpassword' }); return; }
          prog(30, '암호를 푸는 중');
          try { u8 = new Uint8Array(await OfficeCrypto.decrypt(u8, { password: m.password })); }
          catch { post({ type: 'badpassword' }); return; }
          srcPassword = m.password;
        } else {
          // 구형 .xls(BIFF) — SheetJS 폴백(서식 없음·수정 불가: 형식이 zip이 아니라 외과 패치가 안 됨)
          prog(45, '표를 그리는 중');
          post({ type: 'ready', model: modelFromSheetJS(u8), editable: false });
          return;
        }
      }
      if (!isZIP(u8)) { post({ type: 'error', msg: '엑셀 파일 형식이 아니에요' }); return; }
      prog(45, '문서를 여는 중이에요');
      const model = await modelFromExcelJS(u8);
      srcZip = u8; srcEditable = true;
      post({ type: 'ready', model, editable: true });
      return;
    }
    if (m.cmd === 'save') {
      if (!srcEditable || !srcZip) { post({ type: 'error', msg: '이 형식은 고쳐서 저장할 수 없어요' }); return; }
      prog(30, '고친 내용을 넣는 중');
      let out = XlsxPatch.patch(srcZip, m.edits);
      let encrypted = false;
      if (srcPassword) { // 원래 암호가 걸려 있었으면 같은 암호로 다시 걸어 준다(제출 조건 유지)
        prog(70, '암호를 다시 거는 중');
        out = new Uint8Array(await OfficeCrypto.encrypt(out, { password: srcPassword }));
        encrypted = true;
      }
      const buf = out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
      post({ type: 'saved', bytes: buf, encrypted }, [buf]);
      return;
    }
  } catch (err) {
    post({ type: 'error', msg: String(err && err.message || err).slice(0, 300) });
  }
};
