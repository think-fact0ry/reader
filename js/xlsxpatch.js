// xlsx 외과적 패치 — zip 안의 해당 시트 XML '셀 값'만 고치고 나머지 엔트리는 원본 그대로 재포장.
// ExcelJS로 통째 다시 쓰면 차트·유효성·조건부서식 등 라이브러리가 모델링 못 하는 요소가 조용히 사라진다.
// 관공서 제출 서식이 대상이라 "우리가 안 건드린 건 바이트 그대로"가 안전 기준.
// 전역 XlsxPatch 노출(워커 classic script). 의존 = fflate.
(function (root) {
  const dec = (u8) => new TextDecoder('utf-8').decode(u8);
  const enc = (s) => new TextEncoder().encode(s);
  const xesc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  function colToNum(col) { let n = 0; for (const ch of col) n = n * 26 + (ch.charCodeAt(0) - 64); return n; }
  function numToCol(n) { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = (n - 1 - m) / 26; } return s; }
  const refOf = (r, c) => numToCol(c) + r;

  // 입력 문자열을 숫자로 저장할지 판정 — 앞자리 0(전화·계좌·코드)은 숫자화하면 소실되므로 텍스트 유지
  function isNumeric(v) {
    if (!/^-?(0|[1-9]\d*)(\.\d+)?$/.test(v)) return false;
    return true;
  }

  function newCell(ref, styleAttr, value) {
    if (value === '') return `<c r="${ref}"${styleAttr}/>`;
    if (isNumeric(value)) return `<c r="${ref}"${styleAttr}><v>${value}</v></c>`;
    return `<c r="${ref}"${styleAttr} t="inlineStr"><is><t xml:space="preserve">${xesc(value)}</t></is></c>`;
  }

  // 시트 XML 한 장에 셀 값 하나를 써 넣는다. 기존 스타일(s 속성)은 보존, 수식(<f>)은 제거된다.
  function setCell(xml, ref, value) {
    const rowNum = +(/\d+/.exec(ref)[0]);
    const colNum = colToNum(/^[A-Z]+/.exec(ref)[0]);

    // ① 셀이 이미 있으면 교체
    const cellRe = new RegExp(`<c r="${reEsc(ref)}"(\\s[^>]*?)?(/>|>[\\s\\S]*?</c>)`);
    const cm = cellRe.exec(xml);
    if (cm) {
      const sm = /\ss="(\d+)"/.exec(cm[1] || '');
      const styleAttr = sm ? ` s="${sm[1]}"` : '';
      return xml.slice(0, cm.index) + newCell(ref, styleAttr, value) + xml.slice(cm.index + cm[0].length);
    }

    // ② 행은 있는데 셀이 없으면 열 순서에 맞춰 삽입
    const rowRe = new RegExp(`<row r="${rowNum}"(\\s[^>]*?)?(/>|>[\\s\\S]*?</row>)`);
    const rm = rowRe.exec(xml);
    const cellXml = newCell(ref, '', value);
    if (rm) {
      if (rm[2] === '/>') { // 빈 행(self-closing) → 열린 행으로 바꾸며 셀 삽입
        const open = `<row r="${rowNum}"${rm[1] || ''}>`;
        return xml.slice(0, rm.index) + open + cellXml + '</row>' + xml.slice(rm.index + rm[0].length);
      }
      const rowXml = rm[0];
      const inner = rowXml.slice(rowXml.indexOf('>') + 1, rowXml.lastIndexOf('</row>'));
      let insertAt = inner.length; // 기본 = 행 끝
      const cre = /<c r="([A-Z]+)(\d+)"/g;
      let x;
      while ((x = cre.exec(inner))) {
        if (colToNum(x[1]) > colNum) { insertAt = x.index; break; }
      }
      const newInner = inner.slice(0, insertAt) + cellXml + inner.slice(insertAt);
      const newRow = rowXml.slice(0, rowXml.indexOf('>') + 1) + newInner + '</row>';
      return xml.slice(0, rm.index) + newRow + xml.slice(rm.index + rm[0].length);
    }

    // ③ 행 자체가 없으면 행 번호 순서에 맞춰 삽입
    const rowXml = `<row r="${rowNum}">${cellXml}</row>`;
    const sdEmpty = /<sheetData\s*\/>/.exec(xml);
    if (sdEmpty) return xml.slice(0, sdEmpty.index) + `<sheetData>${rowXml}</sheetData>` + xml.slice(sdEmpty.index + sdEmpty[0].length);
    const sdOpen = xml.indexOf('<sheetData>');
    const sdClose = xml.indexOf('</sheetData>');
    if (sdOpen < 0 || sdClose < 0) throw new Error('sheetData 없음');
    const inner = xml.slice(sdOpen + 11, sdClose);
    let insertAt = inner.length;
    const rre = /<row r="(\d+)"/g;
    let y;
    while ((y = rre.exec(inner))) { if (+y[1] > rowNum) { insertAt = y.index; break; } }
    const newInner = inner.slice(0, insertAt) + rowXml + inner.slice(insertAt);
    return xml.slice(0, sdOpen + 11) + newInner + xml.slice(sdClose);
  }

  // workbook.xml + rels → 시트 이름 → zip 경로
  function sheetPathMap(files) {
    const wb = dec(files['xl/workbook.xml']);
    const rels = dec(files['xl/_rels/workbook.xml.rels']);
    const relMap = {};
    for (const m of rels.matchAll(/<Relationship\s[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)) {
      relMap[m[1]] = m[2].replace(/^\/?xl\//, '').replace(/^\//, '');
    }
    // Id/Target 속성 순서가 뒤바뀐 파일도 있어 역순 패턴 보강
    for (const m of rels.matchAll(/<Relationship\s[^>]*Target="([^"]+)"[^>]*Id="([^"]+)"/g)) {
      if (!relMap[m[2]]) relMap[m[2]] = m[1].replace(/^\/?xl\//, '').replace(/^\//, '');
    }
    const map = {};
    for (const m of wb.matchAll(/<sheet\s[^>]*\/>/g)) {
      const tag = m[0];
      const name = /name="([^"]*)"/.exec(tag);
      const rid = /r:id="([^"]+)"/.exec(tag);
      if (!name || !rid) continue;
      const target = relMap[rid[1]];
      if (!target) continue;
      const path = target.startsWith('xl/') ? target : 'xl/' + target;
      map[name[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")] = path;
    }
    return map;
  }

  // 수식 셀을 값으로 덮으면 calcChain이 낡아 엑셀이 '복구' 프롬프트를 띄운다 → 통째 제거(엑셀이 다시 만든다)
  function dropCalcChain(files) {
    if (!files['xl/calcChain.xml']) return;
    delete files['xl/calcChain.xml'];
    if (files['[Content_Types].xml']) {
      const s = dec(files['[Content_Types].xml']).replace(/<Override[^>]*calcChain\.xml[^>]*\/>/g, '');
      files['[Content_Types].xml'] = enc(s);
    }
    if (files['xl/_rels/workbook.xml.rels']) {
      const s = dec(files['xl/_rels/workbook.xml.rels']).replace(/<Relationship[^>]*calcChain\.xml[^>]*\/>/g, '');
      files['xl/_rels/workbook.xml.rels'] = enc(s);
    }
  }

  /**
   * @param {Uint8Array} zipBytes 원본 xlsx(복호화된 상태)
   * @param {Array} edits [{ sheet: '시트이름', r: 1-based행, c: 1-based열, value: '문자열' }]
   * @returns {Uint8Array} 패치된 xlsx
   */
  function patch(zipBytes, edits) {
    const files = fflate.unzipSync(zipBytes);
    const map = sheetPathMap(files);
    const bySheet = new Map();
    for (const e of edits) {
      if (!bySheet.has(e.sheet)) bySheet.set(e.sheet, []);
      bySheet.get(e.sheet).push(e);
    }
    let touchedFormula = false;
    for (const [name, list] of bySheet) {
      const path = map[name];
      if (!path || !files[path]) throw new Error(`시트를 찾지 못했어요: ${name}`);
      let xml = dec(files[path]);
      for (const e of list) {
        const ref = refOf(e.r, e.c);
        const before = new RegExp(`<c r="${reEsc(ref)}"[^>]*>[\\s\\S]*?</c>`).exec(xml);
        if (before && before[0].includes('<f')) touchedFormula = true;
        xml = setCell(xml, ref, e.value == null ? '' : String(e.value));
      }
      files[path] = enc(xml);
    }
    if (touchedFormula) dropCalcChain(files);
    // level 6 = 원본 대비 크기 유사, 압축 시간도 폰에서 부담 없음
    return fflate.zipSync(files, { level: 6 });
  }

  root.XlsxPatch = { patch, isNumeric, refOf, colToNum, numToCol };
})(typeof self !== 'undefined' ? self : globalThis);
