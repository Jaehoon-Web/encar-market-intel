// xlsx_writer_check.js — web/lib/xlsx_writer.js 가 만든 파일이 정상 .xlsx 인지 확인할 시험 파일을 만든다
//   실행은 python tools/xlsx_writer_check.py (이 스크립트로 파일을 만들고 openpyxl 로 열어 비교한다)
'use strict';
const fs = require('fs');
const path = require('path');
const XW = require(path.join(__dirname, '..', 'web', 'lib', 'xlsx_writer.js'));

const out = process.argv[2];
const bytes = XW.build([
  { name: '산정 결과', header: true, widths: [24, 40], money: [1],
    rows: [['항목', '값'], ['추정 시세(만원)', 2149], [{ v: '대상 차', bold: true }, null], ['모델', '현대 더 뉴 그랜저 IG'],
      ['특수문자', '<a & "b"> \'c\''], ['소수', 17.25], ['음수', -30], ['줄바꿈', '첫 줄\n둘째 줄']] },
  { name: '비교 매물/목록?', header: true, freeze: true, money: [2], widths: [10, 12, 12],
    rows: [['유사도', '매물ID', '호가']].concat(Array.from({ length: 30 }, (_, i) => [100 - i, 42500000 + i, 2000 + i * 7])) },
]);
fs.writeFileSync(out, bytes);
console.log(`${out} ${bytes.length} bytes`);
