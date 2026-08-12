# 문서리더 (reader)

갤럭시에서 한글(.hwp/.hwpx)·엑셀(.xlsx/.xls)·PDF·이미지 서류를 광고 없이 읽는 정적 PWA.
모든 파일 처리는 100% 브라우저 안에서 이루어지며 서버로 아무것도 전송하지 않습니다.

- 배포: GitHub Pages — `think-fact0ry.github.io/reader/`
- 진입: ①[파일 열기](시스템 선택기 '최근' 탭) ②안드로이드 공유 시트(Web Share Target, 설치된 폰)
- 저장: IndexedDB = 재열람 편의 캐시(LRU, 총 30MB·30건) — 원본 보관은 폰 Download 폴더가 담당

## 구조
```
index.html / app.css      A안(토스 그린) 스킨 · 문서함 + 뷰어 SPA (?doc=id)
js/app.js                 라우팅·매직바이트 판별·뷰어 셸·핀치 확대(CSS zoom — 틀 고정과 공존)
js/db.js                  IndexedDB (docs·prefs, LRU)
js/hwp.worker.js          rhwp(WASM) 격리 — 원본 SVG 렌더 + 읽기(리플로우) 추출
js/sheet.worker.js        ExcelJS(서식) + SheetJS(.xls·숫자서식 SSF) + officecrypto(암호 xlsx)
sw.js                     셸·벤더 캐시 + share-target POST 수신(→ ?doc=id 리다이렉트)
vendor/                   전부 로컬 벤더 (CDN 금지)
```

## 벤더 (버전 핀)
| 라이브러리 | 버전 | 라이선스 | 용도 |
|---|---|---|---|
| @rhwp/core | 0.8.2 | MIT | .hwp 5.0 / .hwpx → SVG |
| pdf.js | (pdfpng 승계본) | Apache-2.0 | PDF 렌더 |
| ExcelJS | 4.x | MIT | .xlsx 서식(병합·채움·numFmt) |
| SheetJS CE | 0.18.x | Apache-2.0 | .xls 폴백 + SSF 숫자서식 |
| officecrypto-tool | 0.0.19 | MIT | 암호 걸린 xlsx 복호화 (esbuild 브라우저 번들) |

`vendor/officecrypto.browser.js` 재생성: officecrypto-tool을 esbuild로
`--platform=browser --define:global=globalThis --alias:{buffer,events,stream,crypto,timers}=브라우저폴리필 --inject:Buffer/process셔임` 번들.

아이콘 재생성: `icons/icon.html`을 투명 배경으로 캡처(512/192 원형 투명 + maskable/apple 불투명 — manifest icons엔 투명 원형만).
