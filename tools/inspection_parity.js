// inspection_parity.js — 사이트 성능 계산기(web/lib/inspection_score.js) ↔ 파이프라인(prep.py) 일치 검증
// 실행은 python inspection_parity.py (매물 자료를 만들어 이 스크립트에 넘긴다)
//   node tools/inspection_parity.js <자료.json> <web/data/inspection_model.json>
'use strict';
const fs = require('fs');
const path = require('path');
const IS = require(path.join(__dirname, '..', 'web', 'lib', 'inspection_score.js'));

const [fixturePath, modelPath] = process.argv.slice(2);
const model = JSON.parse(fs.readFileSync(modelPath, 'utf8'));
const calc = IS.create(model);
const rows = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const FIELDS = ['사고단계', '사고라벨', '외판1_교환수', '외판1_판금수', '외판2_교환수', '외판2_판금수', '골격_교환수', '골격_판금수',
  '용접절단여부', '경미손상수', '손상부위', '글로비스_감점합', '글로비스_종합평가점', '글로비스_사고평가점',
  '성능감가율', '성능점검점수', '성능등급'];
const same = (a, b) => a === b || (a == null && b == null);
let failures = 0;

// 매물마다 계산기 결과와 파이프라인 값을 17개 열 모두 비교
function check(title, makeInput) {
  const bad = {};
  let n = 0, fail = 0, unread = 0;
  const t0 = Date.now();
  rows.forEach((row, i) => {
    const input = makeInput(row, i);
    n++;
    if (input.unknown && input.unknown.length) unread++;
    const got = calc.evaluate(Object.assign({ simpleRepair: row.simple, mechLevel: row.mech }, input));
    let ok = true;
    for (const f of FIELDS) {
      if (!same(got[f], row.exp[f])) { ok = false; (bad[f] = bad[f] || []).push([row.id, got[f], row.exp[f]]); }
    }
    if (!ok) fail++;
  });
  failures += fail;
  console.log(`\n[${title}] ${n.toLocaleString()}대 · 불일치 ${fail.toLocaleString()}대` +
    (unread ? ` · 못 읽은 표기가 있는 매물 ${unread.toLocaleString()}대` : '') + ` · ${((Date.now() - t0) / 1000).toFixed(1)}초`);
  const badFields = FIELDS.filter(f => bad[f]);
  if (!badFields.length) console.log(`  ✓ ${FIELDS.length}개 열 모두 일치`);
  for (const f of badFields) {
    console.log(`  ✗ ${f}: ${bad[f].length.toLocaleString()}건  예) ` + bad[f].slice(0, 3).map(x => JSON.stringify(x)).join('  '));
  }
}

// 1) 엔카 성능점검 원문 → 계산기
check('원문 → 계산기', row => calc.fromEncar(row.outer, row.frame));

// 2) 같은 매물을 사람이 적을 법한 텍스트 3가지로 바꿔 '성능 상태' 칸 읽기를 거친 뒤 계산
const PILLAR_ALIAS = { 앞: 'A필러', 중간: 'B필러', 뒤: 'C필러' };
const WORD = s => (s === '용접절단' ? '절단' : s);
function asText(items, i) {
  const its = items.filter(it => it.status !== '기타');
  const style = i % 3;
  if (!its.length) return ['무사고', '이상없음', '무'][style];                        // 빈칸은 '미상'이라 무손상은 직접 적는다
  if (style === 0) return calc.toText(its);                                            // "프론트 휀더(좌) X, 쿼터 패널(우) W"
  if (style === 1) {
    return its.map((it, j) => {                                                       // "좌앞 펜더 교환 / 우리어 휀더 판금"
      const list = model.parser.part_aliases[it.part];
      const name = it.part === '필러 패널' && it.pillar ? PILLAR_ALIAS[it.pillar] : list[(i + j) % list.length];
      return (it.side || '') + name + ' ' + WORD(it.status);
    }).join(' / ');
  }
  return its.map(it => `${it.part}(${WORD(it.status)})`).join('; ');                  // "프론트 휀더(교환); 후드(판금)"
}
let textSamples = [];
check('텍스트 → 칸 읽기 → 계산기', (row, i) => {
  const text = asText(calc.fromEncar(row.outer, row.frame).items, i);
  if (i < 3 || (i % 33333 === 1 && textSamples.length < 6)) textSamples.push(text);
  return calc.parseText(text);
});
console.log('  읽은 텍스트 예: ' + textSamples.filter(Boolean).slice(0, 5).map(t => JSON.stringify(t)).join('  '));

// 3) 엑셀 표기 읽기 사례 — [입력, 상태, 기대 부위(부위|좌우|필러위치|상태)] · null = 못 읽음으로 돌려줘야 함
const CASES = [
  ['', '미상', ''], ['미상', '미상', ''], ['-', '미상', ''], ['무사고', '무사고', ''], ['이상 없음', '무사고', ''],
  ['좌프론트휀더 X, 우쿼터 W', '입력', '프론트 휀더|좌||교환,쿼터 패널|우||판금'],
  ['후드 교환 / 리어도어(우) 판금', '입력', '후드|||교환,리어 도어|우||판금'],
  ['본넷 x; 앞펜더 좌우 교환', '입력', '후드|||교환,프론트 휀더|좌||교환,프론트 휀더|우||교환'],
  ['A필러 좌 판금', '입력', '필러 패널|좌|앞|판금'],
  ['C필러(우) C', '입력', '필러 패널|우|뒤|부식'],
  ['프론트 사이드 멤버(좌):판금/용접,용접,절단', '입력', '프론트 사이드 멤버|좌||용접절단'],
  ['프론트 휀더(좌):교환(교체) | 후드:판금/용접', '입력', '프론트 휀더|좌||교환,후드|||판금'],
  ['프론트 휀더(교환) / 리어 도어(판금) / 후드(경미)', '입력', '프론트 휀더|||교환,리어 도어|||판금,후드|||손상'],
  ['도어 2개 교환', '입력', '도어|||교환,도어|||교환'],
  ['뒷 휠하우스 좌 X', '입력', '리어 휠하우스|좌||교환'],
  ['휠하우스 앞 우 W', '입력', '프론트 휠하우스|우||판금'],
  ['트렁크 플로어 X, 플로어 W', '입력', '트렁크 플로어|||교환,플로어 패널|||판금'],
  ['라디에이터 서포트(볼트체결부품) X', '입력', '라디에이터 서포트|||교환'],
  ['우측 쿼터패널 판금, 무사고', '입력', '쿼터 패널|우||판금'],
  ['좌·우 프론트 도어 W', '입력', '프론트 도어|좌||판금,프론트 도어|우||판금'],
  ['ＬＨ 프론트 휀더 Ｘ', '입력', '프론트 휀더|좌||교환'],
  ['쿼터 패널 2곳 판금', '입력', '쿼터 패널|||판금,쿼터 패널|||판금'],
  ['사이드실(좌) 요철', '입력', '사이드실 패널|좌||요철'],
  ['범퍼 교환', '무사고', ''], ['앞범퍼 교환, 후드 W', '입력', '후드|||판금'], ['선루프 교환', '무사고', ''],   // 성능점검 밖 부위는 계산에서 뺀다
  ['라디에이터 그릴 교환', '무사고', ''], ['프론트 휠하우스 좌 W', '입력', '프론트 휠하우스|좌||판금'],
  ['좌앞펜다 판금', '입력', '프론트 휀더|좌||판금'], ['뒷휀다 우 판금', '입력', '쿼터 패널|우||판금'],   // 현장 표기 휀다·펜다
  ['후드X 좌앞휀더W', '입력', '후드|||교환,프론트 휀더|좌||판금'], ['후드:교환 좌앞휀더:판금', '입력', '후드|||교환,프론트 휀더|좌||판금'],   // 쉼표 없는 나열
  ['후드 교환 좌측 앞 휀더 판금', '입력', '후드|||교환,프론트 휀더|좌||판금'], ['후드 교환 앞범퍼 교환', '입력', '후드|||교환'],
  ['후드 교환 아님', '입력', null], ['필러 C', '입력', null],
  ['후드 좌 교환', '입력', null], ['리어 도어 앞 교환', '입력', null], ['후드', '입력', null],
];
const fmt = items => items.map(it => [it.part, it.side || '', it.pillar || '', it.status].join('|')).join(',');
let caseFail = 0;
for (const [text, state, expect] of CASES) {
  const r = calc.parseText(text);
  const ok = expect === null ? r.unknown.length > 0
    : r.state === state && r.unknown.length === 0 && fmt(r.items) === expect;
  if (!ok) { caseFail++; console.log(`  ✗ ${JSON.stringify(text)} → ${r.state} [${fmt(r.items)}] 못 읽음 ${JSON.stringify(r.unknown)}`); }
}
failures += caseFail;
console.log(`\n[엑셀 표기 읽기 사례] ${CASES.length}건 · 실패 ${caseFail}건`);

// 4) 계산 예시 — 보고서·기획안에 적은 값
const EXAMPLES = [
  ['레이(리어 도어·프론트 휀더 교환, 사이드실 판금)', {
    state: '입력', items: [{ part: '리어 도어', side: '우', status: '교환' }, { part: '프론트 휀더', side: '좌', status: '교환' },
      { part: '사이드실 패널', side: '우', status: '판금' }]
  }, { 사고라벨: '외판2·판금', 단순수리: true, 글로비스_감점합: 19, 글로비스_종합평가점: 8, 글로비스_사고평가점: 'A', 성능감가율: 6.69, 성능점검점수: 73.2, 성능등급: 5 }],
  ['기획안 화면(좌프론트휀더 X, 우쿼터 W)', calc.parseText('좌프론트휀더 X, 우쿼터 W'),
    { 사고라벨: '외판2·판금', 글로비스_감점합: 12, 글로비스_종합평가점: 8, 글로비스_사고평가점: 'A', 성능감가율: 3.55, 성능점검점수: 85.8, 성능등급: 7 }],
  ['무사고', { state: '무사고' },
    { 사고라벨: '무사고', 단순수리: false, 글로비스_감점합: 0, 글로비스_종합평가점: 9, 글로비스_사고평가점: 'A', 성능감가율: 0, 성능점검점수: 100, 성능등급: 9 }],
  ['미상(입력 안 함)', {}, { 상태: '미상', 사고라벨: '미상', 성능등급: null }],
  ['못 읽은 표기가 있음', calc.parseText('좌앞휠더 판금, 후드 W'), { 상태: '확인 필요', 성능등급: null }],
];
let exFail = 0;
for (const [title, input, expect] of EXAMPLES) {
  const r = calc.evaluate(input);
  const wrong = Object.keys(expect).filter(k => !same(r[k], expect[k]));
  if (wrong.length) exFail++;
  console.log(`  ${wrong.length ? '✗' : '✓'} ${title}: ${r.상태} · ${r.사고라벨} · 성능 ${r.성능등급}등급 ${r.성능감가율}% ${r.성능점검점수}점 · ` +
    `글로비스 ${r.글로비스_감점합}점 → ${r.글로비스_종합평가점}점·${r.글로비스_사고평가점}` + (wrong.length ? `  (다름: ${wrong.join(', ')})` : ''));
}
failures += exFail;
console.log(`[계산 예시] ${EXAMPLES.length}건 · 실패 ${exFail}건`);

// 5) 단순수리 자동 판정이 성능점검 표기와 얼마나 맞는지 (참고)
let agree = 0;
rows.forEach(row => { if (calc.autoSimpleRepair(calc.fromEncar(row.outer, row.frame).items) === row.simple) agree++; });
console.log(`\n[참고] 단순수리 자동 판정 ↔ 성능점검 표기 일치 ${(agree / rows.length * 100).toFixed(1)}% (${agree.toLocaleString()} / ${rows.length.toLocaleString()})`);

console.log(failures ? `\n✗ 불일치·실패 ${failures.toLocaleString()}건` : '\n✓ 전부 일치');
process.exit(failures ? 1 : 0);
