/*
 * batch.js — 묶음 산정: 엑셀에서 복사한 차량 목록을 한 번에 산정 (기획안 5.1.4)
 *
 * 붙여넣기(탭 구분) → 열 알아보기(머리글 이름, 머리글이 없으면 값의 모양 · 고칠 수 있음)
 *   → 차명 매칭(../lib/name_match.js) · 성능 상태 읽기(../lib/inspection_score.js) → 산정(../lib/price_engine.js)
 *   → 결과 표·합계 → 엑셀(결과 = 원본 열 그대로 + 산정 열 · 차량별 비교 매물 · 산정 기준)
 * 확신이 낮은 차명과 못 읽은 성능 표기는 한 번 고치면 같은 표기 전체에 적용되고, 이 브라우저에 기억된다(localStorage).
 *
 *   var B = V2Batch.create(ctx);   B.show(el);     // ctx = app.js 가 넘기는 데이터·엔진·도우미
 */
(function (root) {
  'use strict';

  var LIMIT = 200;                                           // 한 번에 산정하는 대수(브라우저 계산 시간 기준)
  var STORE = 'v2.batch.';                                   // + draft(붙여넣은 글·열 지정) · fix(고친 표기)
  var ROLES = [['', '쓰지 않음'], ['plate', '차량번호'], ['maker', '제조사'], ['name', '차명'], ['grade', '등급·트림'], ['fuel', '연료'],
    ['year', '연식'], ['reg', '최초등록'], ['km', '주행거리'], ['color', '색상'], ['cond', '성능 상태'], ['cost', '수리비'], ['rent', '렌트'],
    ['actual', '실제 낙찰가'], ['ask', '판매 가격']];
  var ROLE_NAME = {};
  ROLES.forEach(function (r) { ROLE_NAME[r[0]] = r[1]; });
  var TEXT_ROLES = ['maker', 'name', 'grade', 'fuel'];       // 여러 열이면 이 순서로 이어 붙여 차명 매칭에 쓴다
  var ASK_HEAD = /(판매|매물|희망|제시|광고)\s*(가|가격|금액)|호가|^\s*가격\s*$/;   // 판매 가격(매물에 붙은 값) — 시세 대비 싸다/비싸다(기획 v2.29 Q184)
  var ACTUAL_HEAD = /(낙찰|매각|실제\s*판매|실거래)\s*(가|가격|금액)|^\s*(낙찰|매각)\s*$/;   // 실제 건 검증(기획안 WP3): 과거 매각 건의 실제 값
  var SKIP_HEAD = /가격|금액|시세|호가|매입|낙찰|판매가|희망가|비고|메모|^no\.?$|^번호$|순번|^#$/i;
  var HEAD = [['plate', /차량\s*번호|차번|번호판|등록\s*번호/], ['cost', /수리\s*비|정비\s*비|예상\s*수리/],
    ['cond', /성능|상태|사고|기록부|수리\s*내역|외판/], ['reg', /최초\s*등록|등록\s*(일|연월|년월)|출고/],
    ['year', /연식|년식|연형|연도|년도/], ['km', /주행|km|키로|㎞/i], ['color', /색상|컬러|색/],
    ['maker', /제조사|메이커|브랜드|제작사/], ['grade', /등급|트림|사양/], ['fuel', /연료|유종/], ['rent', /렌트|용도/],
    ['name', /차명|차종|모델|차량/]];

  // ───── 붙여넣기 양식(사용자 요청 11-03) — 복사하면 엑셀 빈 시트에 그대로 열로 들어간다 ─────
  var FORM = [['차량번호', '선택', '12가3456 — 하·허·호면 렌트로 봄'], ['차명', '꼭', '더 뉴 그랜저 IG 2.5 프리미엄 — 모델·등급까지 쓸수록 정확'],
    ['최초등록', '꼭(또는 연식)', '2019년 3월 · 2019-03 · 19년 3월 — 엑셀이 Mar-19처럼 바꿔 보여도 그대로 읽음 · 월을 모르면 연식(2019)만 써도 6월로 계산'], ['주행거리', '꼭', '45000 · 45,000km · 4.5만'],
    ['색상', '선택', '흰색 · 검정 · 회색 · 청색 · 펄'], ['성능 상태', '선택', '무사고 · 좌프론트휀더 X, 후드 W — 비우면 상태 미상'], ['수리비', '선택', '만원(50) 또는 원(500,000)'], ['판매 가격', '선택', '매물에 붙은 값(만원) — 넣으면 시세보다 싸게 나왔는지 비싸게 나왔는지 판정']];
  var FORM_ROWS = [['12가3456', '더 뉴 그랜저 IG 2.5 프리미엄', '2019년 3월', '45000', '흰색', '무사고', '', ''],     // '2019-03'은 엑셀이 날짜(Mar-19)로 바꾼다
    ['34나5678', '쏘렌토 MQ4 2.2 디젤 시그니처', '2021년 7월', '32000', '검정', '좌프론트휀더 X', '50', '2950']];
  function formTSV() { return [FORM.map(function (f) { return f[0]; })].concat(FORM_ROWS).map(function (r) { return r.join('\t'); }).join('\r\n'); }

  // ───── 칸 읽기 ─────
  function parseTSV(text) {                                  // 엑셀 복사 = 탭 구분. 줄바꿈이 든 칸은 "…"로 감싸 온다
    var rows = [], row = [], cell = '', q = false, i, ch;
    for (i = 0; i < text.length; i++) {
      ch = text.charAt(i);
      if (q) {
        if (ch === '"') { if (text.charAt(i + 1) === '"') { cell += '"'; i++; } else q = false; }
        else cell += ch;
      } else if (ch === '"' && cell === '') q = true;
      else if (ch === '\t') { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text.charAt(i + 1) === '\n') i++;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else cell += ch;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    rows = rows.map(function (r) { return r.map(function (c) { return c.replace(/\s+/g, ' ').trim(); }); })
      .filter(function (r) { return r.some(function (c) { return c !== ''; }); });
    var w = rows.reduce(function (m, r) { return Math.max(m, r.length); }, 0);
    rows.forEach(function (r) { while (r.length < w) r.push(''); });
    return rows;
  }
  function kmOf(v) {                                         // "38,200" · "3.8만" · "61000km" → 38200
    var s = String(v || '').replace(/[,\s]|km|㎞|키로(미터)?/gi, '');
    if (!s) return null;
    var m = s.match(/^(\d+(?:\.\d+)?)만$/), m2 = s.match(/^(\d+(?:\.\d+)?)만(\d+)(천)?$/), m3 = s.match(/^(\d+)천$/);
    var x = m ? parseFloat(m[1]) * 1e4 : m2 ? parseFloat(m2[1]) * 1e4 + +m2[2] * (m2[3] ? 1000 : 1) : m3 ? +m3[1] * 1000 :
      (/^\d+(\.\d+)?$/.test(s) ? Number(s) : NaN);   // 4만5천 · 4만5000 · 45천
    return isFinite(x) && x >= 0 && x < 2e6 ? Math.round(x) : null;
  }
  function priceOf(v) {                                      // 차 값 → 만원: "1,850" · "1850만" · "1억 2,300" · "18,500,000"(원, 10만 이상이면 원으로 봄)
    var s = String(v || '').replace(/[\s,]|원/g, ''), m = s.match(/^(?:(\d+(?:\.\d+)?)억)?(\d+(?:\.\d+)?)?(만)?$/);
    if (!s || !m || (!m[1] && !m[2])) return null;
    var x = (m[1] ? parseFloat(m[1]) * 1e4 : 0) + (m[2] ? parseFloat(m[2]) : 0);
    if (!m[1] && !m[3] && x >= 1e5) x /= 1e4;
    return x > 0 ? x : null;
  }
  function costOf(v) {                                       // 만원. 단위 없이 1만 이상이면 원으로 본다(150,000 → 15만)
    var s = String(v || '').replace(/[,\s]/g, ''), m = s.match(/^(\d+(?:\.\d+)?)(만원|만|원)?$/);
    if (!m) return null;
    var x = parseFloat(m[1]);
    if (m[2] === '원' || (!m[2] && x >= 10000)) x /= 10000;
    return x;
  }
  function yearOf(v) {
    var s = String(v || ''), m = s.match(/(19[89]\d|20[0-4]\d)/);
    if (m) return +m[1];
    m = s.match(/^(\d{2})\s*(년식|년형|년)?$/);
    return m ? (+m[1] > 50 ? 1900 : 2000) + +m[1] : null;
  }
  function regOf(v) {                                        // 최초등록 → { y, m } — 월을 알 수 없으면 null
    var s = String(v || '').trim(), m;
    function ok(y, mo) { return y >= 1980 && y <= 2049 && mo >= 1 && mo <= 12 ? { y: y, m: mo } : null; }
    if (!s) return null;
    if (/^\d{5}$/.test(s) && +s > 25000 && +s < 60000) {    // 엑셀 날짜 일련번호(1968~2064)
      var d = new Date(Date.UTC(1899, 11, 30) + +s * 864e5);
      return ok(d.getUTCFullYear(), d.getUTCMonth() + 1);
    }
    if ((m = s.match(/^((?:19|20)\d{2})\s*[-./년]\s*(\d{1,2})/)) || (m = s.match(/^((?:19|20)\d{2})(\d{2})(\d{2})?$/))) return ok(+m[1], +m[2]);
    if ((m = s.match(/^(\d{2})\s*[-./]\s*(\d{1,2})(\s*[-./]\s*\d{1,2})?$/))) return ok((+m[1] > 50 ? 1900 : 2000) + +m[1], +m[2]);
    if ((m = s.match(/^(\d{2})\s*년\s*(\d{1,2})\s*월?/))) return ok((+m[1] > 50 ? 1900 : 2000) + +m[1], +m[2]);   // 19년 3월
    // 엑셀이 날짜로 바꿔 보여 준 모양(사용자 보고 11-03: 양식의 2019-03이 'Mar-19'로 바뀜) — 영어 달 이름 · 미국식 월/일/연
    var yr = function (v) { return v.length === 2 ? (+v > 50 ? 1900 : 2000) + +v : +v; }, mon = function (v) { return MONTHS[v.slice(0, 3).toLowerCase()]; };
    if ((m = s.match(/^([A-Za-z]{3,9})\.?[\s\-\/.,]*(\d{4}|\d{2})$/)) && mon(m[1])) return ok(yr(m[2]), mon(m[1]));            // Mar-19 · Mar-2019 · March 2019
    if ((m = s.match(/^((?:19|20)\d{2})[\s\-\/.]*([A-Za-z]{3,9})\.?$/)) && mon(m[2])) return ok(+m[1], mon(m[2]));               // 2019-Mar
    if ((m = s.match(/^\d{1,2}[\s\-\/.]([A-Za-z]{3,9})\.?[\s\-\/.,]+(\d{4}|\d{2})$/)) && mon(m[1])) return ok(yr(m[2]), mon(m[1]));   // 1-Mar-19 · 01 Mar 2019
    if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/((?:19|20)\d{2})$/))) return ok(+m[3], +m[1]);                                  // 3/1/2019(월/일/연)
    return null;
  }
  var MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  function colorOf(v) {                                      // 산정 엔진의 색상 계열로
    var s = String(v || '').replace(/\s/g, '').toUpperCase();
    if (!s) return '';
    if (/흰|화이트|WHITE|백색|진주|펄|PEARL|아이보리/.test(s)) return '흰색·진주';
    if (/검|블랙|BLACK|흑/.test(s)) return '검정';
    if (/회|그레이|GRAY|GREY|은색|은회|실버|SILVER|쥐색|티타늄|건메탈/.test(s)) return '회색·은색';
    if (/청|파랑|블루|BLUE|남색|네이비|NAVY/.test(s)) return '청색';
    return '기타';
  }
  function rentOf(plate, cell) {                             // 번호판 하·허·호 = 렌트
    var m = String(plate || '').replace(/\s/g, '').match(/^\d{2,3}([가-힣])\d{4}$/);
    return !!(m && '하허호'.indexOf(m[1]) >= 0) || /렌트|렌터|대여|^(Y|YES|예|O|1|TRUE)$/i.test(String(cell || '').trim());
  }
  // 한 칸에 이어 쓴 글('그랜저 IG 2.5 프리미엄 2019년 3월 45,000km')에서 최초등록·연식·주행을 꺼낸다 — 엑셀 열로 나뉘지 않은 붙여넣기용.
  // 주행: 단위(km·키로·만)가 붙은 숫자, 또는 천 단위 쉼표 숫자. 연식: 따로 떨어진 19xx·20xx(여럿이면 마지막 — 푸조 2008 같은 모델 이름 보호), 'YY년식'.
  function pullFromText(text) {
    var t = ' ' + String(text || '') + ' ', out = { reg: null, km: null };
    var km = /(?:^|[\s,/(])(\d+(?:\.\d+)?\s*만\s*(?:\d+\s*천?)?\s*(?:km|㎞|키로(?:미터)?)?|\d{1,3}(?:,\d{3})+\s*(?:km|㎞|키로(?:미터)?)?|\d{3,7}\s*(?:km|㎞|키로(?:미터)?)|\d{5,7})(?=$|[\s,/)])/i.exec(t);   // 단위 없는 숫자는 5자리 이상만(4자리는 모델 이름일 수 있음)
    if (km && kmOf(km[1]) != null) { out.km = kmOf(km[1]); t = t.replace(km[1], ' '); }
    var reg = /(?:^|[\s,/(])((?:19|20)\d{2}\s*(?:[-./]\s*|년\s*)\d{1,2}(?:\s*월|\s*[-./]\s*\d{1,2})?|\d{2}\s*년\s*\d{1,2}\s*월)(?=$|[\s,/)])/.exec(t);
    if (reg && regOf(reg[1].replace(/\s+/g, ''))) { out.reg = regOf(reg[1].replace(/\s+/g, '')); t = t.replace(reg[1], ' '); }
    else {
      var re = /(?:^|[\s,/(])((?:19|20)\d{2}\s*(?:년식|년형|년)?|\d{2}\s*(?:년식|년형))(?=$|[\s,/)])/g, m, last = null;
      while ((m = re.exec(t))) last = m;
      if (last && yearOf(last[1])) { out.reg = { y: yearOf(last[1]), m: 6, guess: true }; t = t.slice(0, last.index) + t.slice(last.index).replace(last[1], ' '); }
    }
    out.text = t.replace(/[,/]\s*(?=[,/]|$)/g, ' ').replace(/\s+/g, ' ').trim();
    return out;
  }
  function keyOf(t) { return String(t || '').toUpperCase().replace(/[^0-9A-Z가-힣.]/g, ''); }   // 같은 표기 = 띄어쓰기·기호만 다른 것
  function load(k) { try { return JSON.parse(localStorage.getItem(STORE + k) || 'null'); } catch (e) { return null; } }
  function save(k, v) { try { if (v == null) localStorage.removeItem(STORE + k); else localStorage.setItem(STORE + k, JSON.stringify(v)); } catch (e) { /* 저장 못 해도 계산은 된다 */ } }
  function colName(c) { var s = ''; c++; while (c > 0) { var m = (c - 1) % 26; s = String.fromCharCode(65 + m) + s; c = Math.floor((c - 1) / 26); } return s; }

  function create(ctx) {
    var X = ctx.X, ENG = ctx.ENG, ISC = ctx.ISC, GROUPS = ctx.GROUPS, esc = ctx.esc, man = ctx.man, pad = ctx.pad;
    var NM = NameMatch.create(X.idx), el = null, token = 0, onlyCheck = false;
    var T = { text: '', table: [], header: false, roles: [], over: 0 };
    var TS = { list: [], msg: '' };                           // 팀 표기 사전에 넣을, 이번에 고른 표기(기획 v2.31)
    var rows = [], FIX = load('fix') || {};
    ['name', 'grade', 'cond'].forEach(function (k) { FIX[k] = FIX[k] || {}; });
    var MODELS = [], byName = {};                            // 다른 모델 찾기 목록
    X.idx.makers.forEach(function (mk) {
      mk.groups.forEach(function (g) {
        g.models.forEach(function (m) {
          var it = { maker: mk.name, group: g.name, model: m.name, file: g.file, y0: m.y0, y1: m.y1, n: m.n, label: mk.name + ' › ' + g.name + ' › ' + m.name };
          MODELS.push(it);
          byName[it.label] = it;
        });
      });
    });
    var VAL = {                                              // 머리글이 없을 때 값의 모양으로 열 알아보기
      plate: function (v) { return /^\d{2,3}\s?[가-힣]\s?\d{4}$/.test(v); },
      reg: function (v) { return !!regOf(v) && !/^\d{5}$/.test(v); },
      year: function (v) { return /^(19|20)\d{2}\s*(년식?|년형)?$/.test(v) || /^\d{2}\s*(년식|년형)$/.test(v); },
      km: function (v) { return /^\d{1,3}(,\d{3})+\s*(km|㎞)?$/i.test(v) || /^\d+(\.\d+)?\s*만\s*(km|㎞)?$/i.test(v) || /^\d{3,7}\s*(km|㎞)$/i.test(v) || /^\d{5,7}$/.test(v); },
      cond: function (v) { var r = ISC.parseText(v); return r.state === '무사고' || r.items.length > 0; },
      color: function (v) { var c = colorOf(v); return v.length <= 12 && (c && c !== '기타' || /색$/.test(v)); },
      name: function (v) { return /[가-힣A-Za-z]{2}/.test(v) && !!NM.model(v).best; }
    };

    function $(id) { return document.getElementById(id); }
    function grpOf(f) { return GROUPS[f] || null; }
    function loadGroups(files) {
      return Promise.all(files.filter(function (f) { return f && !GROUPS[f]; }).map(function (f) {
        return ctx.getJSON('comps/' + f).then(function (F) { GROUPS[f] = ENG.group(F); });
      }));
    }

    // ───── 열 알아보기 ─────
    function headRole(h) {                                   // 역할 · ''(쓰지 않는 열) · null(모름 → 값으로 알아본다)
      if (!h || h.length > 20 || /\d{3,}|\d+\s*(년|만)/.test(h)) return null;   // 숫자가 든 긴 글은 값(머리글 아님)
      if (ACTUAL_HEAD.test(h)) return 'actual';
      if (ASK_HEAD.test(h)) return 'ask';
      if (SKIP_HEAD.test(h)) return '';
      for (var i = 0; i < HEAD.length; i++) if (HEAD[i][1].test(h)) return HEAD[i][0];
      return null;
    }
    function detect(table) {
      var first = table[0], nc = first.length, hr = first.map(headRole);
      var looksData = first.some(function (v) { return VAL.plate(v) || (VAL.reg(v) && /\d/.test(v)) || VAL.km(v); });
      var header = !looksData && hr.filter(function (r) { return r != null; }).length >= Math.max(1, Math.ceil(nc * 0.3));
      var data = (header ? table.slice(1) : table).slice(0, 30), roles = [], used = {};
      for (var c = 0; c < nc; c++) {
        var role = header ? hr[c] : null;
        if (role == null) {
          var vals = data.map(function (r) { return r[c]; }).filter(Boolean).slice(0, 20);
          role = '';
          if (vals.length) {
            ['plate', 'reg', 'year', 'km', 'cond', 'color', 'name'].some(function (k) {
              var hit = vals.filter(VAL[k]).length / vals.length;
              if (hit >= (k === 'name' ? 0.5 : 0.6)) { role = k; return true; }
              return false;
            });
          }
        }
        if (role && TEXT_ROLES.indexOf(role) < 0 && used[role]) role = '';   // 차명 쪽이 아니면 한 열만
        if (role) used[role] = true;
        roles.push(role);
      }
      if (nc === 1 && !roles[0]) roles[0] = 'name';            // 엑셀 열로 나뉘지 않은 붙여넣기 — 한 줄 글에서 차명·연식·주행을 읽는다(makeRow)
      return { header: header, roles: roles };
    }

    // ───── 행 만들기 · 맞추기 · 산정 ─────
    function makeRow(cells, no) {
      var r = { no: no, cells: cells }, by = {};
      T.roles.forEach(function (role, c) { if (role && cells[c]) (by[role] = by[role] || []).push(cells[c]); });
      function one(k) { return by[k] ? by[k][0] : ''; }
      r.plate = one('plate');
      r.text = TEXT_ROLES.map(function (k) { return (by[k] || []).join(' '); }).join(' ').replace(/\s+/g, ' ').trim();
      var y = yearOf(one('year')) || yearOf(one('reg'));
      r.reg = regOf(one('reg')) || (y ? { y: y, m: 6, guess: true } : null);   // 연식만 있으면 6월로
      r.km = kmOf(one('km'));
      if (!r.reg || r.km == null) {                         // 연식·주행 열이 없거나 비었으면 차명 글에서 꺼낸다(꺼낸 숫자는 차명에서 뺀다)
        var pf = pullFromText(r.text);
        if (!r.reg && pf.reg) { r.reg = pf.reg; r.fromText = true; }
        if (r.km == null && pf.km != null) { r.km = pf.km; r.fromText = true; }
        if (r.fromText) r.text = pf.text;
      }
      r.key = keyOf(r.text);
      r.color = colorOf(one('color'));
      r.cost = costOf(one('cost'));
      r.rent = rentOf(r.plate, one('rent'));
      r.condRaw = one('cond');
      r.actual = priceOf(one('actual'));
      r.ask = priceOf(one('ask'));
      readCond(r);
      return r;
    }
    function readCond(r) {                                   // 고친 표기를 먼저 바꿔 넣고 읽는다
      var s = String(r.condRaw || '');
      if (s.normalize) s = s.normalize('NFKC');
      s = s.replace(/:/g, ' ');
      Object.keys(FIX.cond).forEach(function (tok) { if (s.indexOf(tok) >= 0) s = s.split(tok).join(FIX.cond[tok]); });
      r.cond = ISC.parseText(s, { terms: ctx.terms ? ctx.terms.list() : [], status3: true });   // 소리 맞추기 · 짐작 · 팀 사전(v2.31) · 상태 3가지(v2.32)
      r.c = null;
      if (!r.cond.unknown.length) {
        var st = r.cond.state, input = st === '미상' ? { state: '미상' } : { state: st === '무사고' ? '무사고' : '입력', items: r.cond.items, mechLevel: 0 };
        r.c = ISC.evaluate(input);
      }
    }
    function matchRow(r) {                                   // 1단계: 색인만으로 후보 → 불러올 모델그룹 파일
      var fx = FIX.name[r.key];
      r.res0 = r.text ? NM.model(r.text, r.reg ? r.reg.y : null) : { best: null, conf: 'none', cands: [] };
      r.files = fx ? [fx.file] : [];
      if (r.res0.best) {
        var top = r.res0.best.score;
        r.res0.cands.forEach(function (c) { if (c.score >= top - 2.5 && r.files.indexOf(c.file) < 0) r.files.push(c.file); });
      }
    }
    function finishMatch(r) {                                // 2단계: 등급까지 맞춰 고르고 등급·세부등급을 정한다
      var fx = FIX.name[r.key], year = r.reg ? r.reg.y : null;
      if (fx && GROUPS[fx.file] && GROUPS[fx.file].models[fx.model]) {
        r.res = { best: { maker: fx.maker, group: fx.group, model: fx.model, file: fx.file, y0: fx.y0, y1: fx.y1 }, conf: 'fixed', cands: r.res0.cands };
      } else r.res = r.res0.best ? NM.refine(r.res0, r.text, year, grpOf) : r.res0;
      r.best = r.res.best && GROUPS[r.res.best.file] ? r.res.best : null;
      r.conf = r.best ? r.res.conf : 'none';
      r.grade = ''; r.trim = ''; r.gconf = ''; r.gres = null;
      if (!r.best) return;
      var G = GROUPS[r.best.file], gf = FIX.grade[r.best.model + '|' + r.key];
      r.gres = NM.grade(G, r.best.model, r.text);
      if (gf != null) { var p = gf.split('|'); r.grade = p[0]; r.trim = p[1] || ''; r.gconf = 'fixed'; }
      else if (r.gres) { r.grade = r.gres.grade; r.trim = r.gres.trim; r.gconf = r.gres.conf; }
    }
    function fuelOf(G, model, grade) {                       // 환산 비율 모델 예외용: 그 세부모델·등급에서 가장 흔한 연료
      var M = G.models[model], fi = G.fi, all = {}, same = {}, pick = function (c) {
        var k = Object.keys(c).sort(function (a, b) { return c[b] - c[a]; })[0];
        return k == null ? null : G.F.fuels[k];
      };
      if (!M) return null;
      G.F.rows.forEach(function (r) {
        if (r[fi.m] !== M.idx) return;
        all[r[fi.fu]] = (all[r[fi.fu]] || 0) + 1;
        if (G.F.grades[r[fi.g]] === grade) same[r[fi.fu]] = (same[r[fi.fu]] || 0) + 1;
      });
      return pick(same) || pick(all);
    }
    function estimate(r) {
      r.why = [];
      if (!r.best) r.why.push(r.text ? '차명 못 찾음' : '차명 없음');
      else if (!r.grade) r.why.push('등급 없음');
      if (!r.reg) r.why.push('연식·최초등록 없음');
      if (r.km == null) r.why.push('주행 없음');
      if (r.cond.unknown.length) r.why.push('못 읽은 성능 표기');
      r.R = null;
      if (r.why.length) return;
      var G = GROUPS[r.best.file], c = r.c;
      r.car = { '모델': r.best.model, '등급': r.grade, '세부등급': r.trim, '등록연월': r.reg.y * 100 + r.reg.m, '주행km': r.km,
        '색상계열': r.color || null, '렌트': r.rent, '상태': c['상태'] === '미상' ? null : { items: c['상태'] === '무사고' ? [] : r.cond.items },
        '수리비': r.cost || 0, '수입': origin(r.best.maker) === '수입', '연료': fuelOf(G, r.best.model, r.grade) };   // 기록부 상태 3가지 · 수리필요 수리비는 엔진이 더함(v2.32)
      r.R = ENG.estimateCar(G, r.car, { sold: true });
      if (!r.R) r.why.push('비교 매물 5대 미만');
      else {
        r.lp = ENG.logParts ? ENG.logParts(G, r.car, r.R.base) : null;    // 같은 모델끼리 값 차이를 항목별로 나눌 때(기획 v2.29)
        r.fp = ENG.factoryPrice ? ENG.factoryPrice(G, r.car) : null;   // 출고가(사용자 요청 11-04)
      }
    }
    function origin(maker) { var m = (X.idx.makers || []).filter(function (x) { return x.name === maker; })[0]; return m ? m.origin : ''; }
    function condShort(r) {                                  // 사고 단계 · 이력 감가 · 수리비(수리필요 자동 + 직접 입력, v2.32)
      var R = r.R, lab = r.c && r.c['사고라벨'] || '무사고';
      return lab + (R && R.D && r.car && r.car['상태'] ? ' · −' + (R.D * 100).toFixed(1) + '%' : '') + (R && R.repair ? ' · 수리 −' + man(R.repair) + '만' : '');
    }
    function repairNote(r) {                                 // 수리비 나눔 — 수리필요 자동 · 직접 입력
      var R = r.R;
      return R.repairAuto && r.cost ? ' (수리필요 ' + man(R.repairAuto) + ' + 직접 ' + man(r.cost) + ')' : R.repairAuto ? ' (수리필요 표준 수리비)' : '';
    }
    function needsCheck(r) { return !!r.best && ((r.conf === 'mid' || r.conf === 'low') || r.gconf === 'low' || yearOut(r)); }
    function yearOut(r) {                                    // 등록연도가 매칭한 모델 기간(±1년) 밖 — 다른 세대·다른 모델일 수 있다. 직접 고르면 그대로 쓴다
      var b = r.best;
      return !!(b && r.reg && r.conf !== 'fixed' && b.y0 && b.y1 && (r.reg.y < b.y0 - 1 || r.reg.y > b.y1 + 1));
    }
    function counted(r) { return !!r.R && !yearOut(r); }      // 합계에 넣는 차

    function run() {
      if ($('bPaste').value !== T.text) { V.cmp = []; V.ref = null; V.openR = {}; V.openG = {}; V.inOpen = null; }
      T.text = $('bPaste').value;
      var table = parseTSV(T.text);
      T.table = table;
      if (!table.length) { rows = []; T.roles = []; save('draft', null); render(); return; }
      var det = detect(table), d = load('draft');
      T.header = det.header;
      T.roles = det.roles;
      if (d && d.text === T.text && d.roles && d.roles.length === det.roles.length) { T.header = d.header; T.roles = d.roles; }   // 직접 고친 열 지정을 살린다
      process();
    }
    function process() {
      var my = ++token, data = T.header ? T.table.slice(1) : T.table;
      T.over = Math.max(0, data.length - LIMIT);
      rows = data.slice(0, LIMIT).map(function (cells, i) { return makeRow(cells, i + (T.header ? 2 : 1)); });
      save('draft', { text: T.text, roles: T.roles, header: T.header });
      renderCols();
      $('bFix').innerHTML = '';
      progress('차명을 맞추는 중…');
      var need = {};
      rows.forEach(function (r) { matchRow(r); r.files.forEach(function (f) { need[f] = 1; }); });
      loadGroups(Object.keys(need)).then(function () {
        if (my !== token) return;
        rows.forEach(finishMatch);
        var i = 0;
        (function step() {                                    // 몇 대씩 나눠 계산해 화면이 멈추지 않게
          if (my !== token) return;
          for (var end = Math.min(rows.length, i + 10); i < end; i++) estimate(rows[i]);
          if (i < rows.length) { progress('산정 중… ' + i + ' / ' + rows.length + '대'); setTimeout(step, 0); }
          else render();
        })();
      }).catch(function (e) { progress('비교 매물 파일을 불러오지 못했습니다: ' + esc(e && e.message || e)); if (window.CT) CT.err('load', e && e.message || e); });
    }
    function redo(list) {                                    // 고친 행만 다시
      var need = {};
      list.forEach(function (r) { matchRow(r); r.files.forEach(function (f) { need[f] = 1; }); });
      return loadGroups(Object.keys(need)).then(function () {
        list.forEach(function (r) { finishMatch(r); estimate(r); });
        render();
      });
    }

    // ───── 고치기 ─────
    function setModel(i, it) {
      var r = rows[i];
      if (!r || !it) return;
      FIX.name[r.key] = { maker: it.maker, group: it.group, model: it.model, file: it.file, y0: it.y0, y1: it.y1 };
      save('fix', FIX);
      loadGroups([it.file]).then(function () {
        return redo(rows.filter(function (x) { return x.key === r.key; }));
      }).catch(function (e) { progress('불러오지 못했습니다: ' + esc(e.message)); });
    }
    function setGrade(i, v) {
      var r = rows[i];
      if (!r || !r.best) return;
      FIX.grade[r.best.model + '|' + r.key] = v;
      save('fix', FIX);
      redo(rows.filter(function (x) { return x.key === r.key; }));
    }
    function setCond(tok, v) {
      FIX.cond[tok] = v;
      save('fix', FIX);
      var list = rows.filter(function (r) { return r.cond.unknown.indexOf(tok) >= 0; });
      list.forEach(readCond);
      list.forEach(estimate);
      render();
    }

    // ───── 화면 ─────
    var IB = ' <button type="button" class="v2-ibtn" data-ib aria-expanded="false" aria-label="설명">i</button>';
    function info(t) { return '<div class="v2-info" hidden>' + t + '</div>'; }
    function progress(msg) { $('bOut').innerHTML = '<div class="card"><div class="v2-kv" style="margin:0"><span class="spinner v2-spin"></span>' + msg + '</div></div>'; }
    function frame() {
      el.innerHTML = '<div class="card bt-inbar" id="bInBar" hidden></div><div class="card" id="bIn"><div class="card-title">① 엑셀 목록 붙여넣기' + IB +
        '<button type="button" class="v2-link bt-infold" id="bInFold" data-b="inFold" hidden>접기 ▴</button></div>' +
        info('엑셀에서 머리글 행째로 복사해 붙여넣으세요(한 번에 ' + LIMIT + '대까지). 꼭 있어야 하는 열: 차명(모델·등급), 최초등록 또는 연식, 주행거리. ' +
          '있으면 더 정확해지는 열: 색상, 성능 상태(예: 좌프론트휀더 X, 본넷 W — 빈칸이면 상태 미상), 수리비(만원), 차량번호(하·허·호는 렌트로 봅니다). ' +
          '붙여넣은 글과 고친 표기는 이 브라우저에만 남습니다.') +
        '<p class="v2-bform"><b>필요한 열</b> 차명 · 최초등록(또는 연식) · 주행거리 <span>있으면 더 정확: 색상 · 성능 상태 · 수리비 · 차량번호 · 판매 가격(시세 대비 판정)</span></p>' +
        '<div class="v2-actions v2-bformbtn"><button type="button" class="v2-btn" data-b="formCopy">양식 복사</button><button type="button" class="v2-btn" data-b="formXlsx">양식 엑셀 ↓</button>' +
        '<span class="v2-dim" id="bFormMsg">양식을 엑셀에 붙여 채운 뒤, 머리글째로 복사해 아래에 붙여 넣으세요</span></div>' +
        '<textarea class="v2-in v2-paste" id="bPaste" spellcheck="false" wrap="off" aria-label="차량 목록 붙여넣기" placeholder="차량번호&#9;차명&#9;최초등록&#9;주행거리&#9;색상&#9;성능 상태&#10;12가3456&#9;투싼 (NX4) 1.6T 인스퍼레이션&#9;2022-03&#9;38,200&#9;흰색&#9;좌프론트휀더 X"></textarea>' +
        '<div class="v2-actions"><button type="button" class="v2-btn primary" data-b="run">산정하기</button>' +
        '<button type="button" class="v2-btn" data-b="sample">예시 목록 넣기</button><button type="button" class="v2-btn" data-b="clear">지우기</button></div></div>' +
        '<div id="bCols"></div><div id="bFix"></div><div id="bOut"></div>' +
        '<datalist id="bModels">' + MODELS.map(function (m) { return '<option value="' + esc(m.label) + '"></option>'; }).join('') + '</datalist>';
      el.addEventListener('click', onClick);
      el.addEventListener('change', onChange);
      var tip = document.getElementById('tip');                // 요약 그림 말풍선 — 한 대 산정과 같은 #tip
      if (tip) {
        el.addEventListener('mouseover', function (e) {
          var t = e.target.closest && e.target.closest('[data-tip]');
          if (!t) return;
          tip.textContent = t.getAttribute('data-tip');
          tip.hidden = false;
        });
        el.addEventListener('mousemove', function (e) {
          if (tip.hidden) return;
          tip.style.left = Math.min(e.clientX + 14, window.innerWidth - tip.offsetWidth - 8) + 'px';
          tip.style.top = Math.min(e.clientY + 14, window.innerHeight - tip.offsetHeight - 8) + 'px';
        });
        el.addEventListener('mouseout', function (e) {
          var t = e.target.closest && e.target.closest('[data-tip]');
          if (t && !(e.relatedTarget && t.contains(e.relatedTarget))) tip.hidden = true;
        });
      }
      $('bPaste').addEventListener('paste', function () { setTimeout(run, 0); });
      window.addEventListener('scroll', function () { if (!V.spy) V.spy = requestAnimationFrame(spy); }, { passive: true });
    }

    function renderCols() {
      if (!T.table.length) { $('bCols').innerHTML = ''; return; }
      var nc = T.roles.length, head = T.header ? T.table[0] : null, data = (T.header ? T.table.slice(1) : T.table).slice(0, 3);
      var h = '<div class="card"><div class="v2-tools"><div class="card-title">② 열 확인' + IB + '</div>' +
        '<label class="v2-chk" style="margin:0"><input type="checkbox" data-b="header"' + (T.header ? ' checked' : '') + '> 첫 줄은 머리글</label></div>' +
        info('자동으로 알아본 열입니다. 틀리면 열 위의 칸에서 쓰임을 고르세요.') +
        '<div class="v2-tablewrap"><table class="t v2-tbl v2-ctbl"><thead><tr>';
      for (var c = 0; c < nc; c++) {
        h += '<th><select class="v2-csel" data-role="' + c + '" aria-label="' + colName(c) + '열의 쓰임">' + ROLES.map(function (o) {
          return '<option value="' + o[0] + '"' + (T.roles[c] === o[0] ? ' selected' : '') + '>' + o[1] + '</option>';
        }).join('') + '</select><div class="v2-ch">' + colName(c) + (head ? ' · ' + esc(head[c]) : '') + '</div></th>';
      }
      h += '</tr></thead><tbody>' + data.map(function (r) {
        return '<tr>' + r.map(function (v, c) { return '<td class="' + (T.roles[c] ? '' : 'v2-dim') + '">' + esc(v) + '</td>'; }).join('') + '</tr>';
      }).join('') + '</tbody></table></div>';
      var miss = [], fromText = rows.filter(function (r) { return r.fromText; }).length;
      if (!T.roles.some(function (r) { return r === 'name' || r === 'grade'; })) miss.push('차명');
      if (T.roles.indexOf('reg') < 0 && T.roles.indexOf('year') < 0 && !fromText) miss.push('최초등록 또는 연식');
      if (T.roles.indexOf('km') < 0 && !fromText) miss.push('주행거리');
      if (nc === 1) h += '<p class="v2-help v2-warnt2">한 칸으로 붙여졌습니다(엑셀 열로 나뉘지 않음) — 한 줄 글에서 차명 · 연식 · 주행을 읽어 계산했습니다. 더 정확하게 하려면 <b>양식 복사</b>로 열을 나눠 주세요.</p>';
      else if (fromText) h += '<p class="v2-help v2-warnt2">연식·주행 열이 없거나 빈 차 ' + fromText + '대는 차명 글에서 읽었습니다.</p>';
      if (miss.length) h += '<p class="v2-help v2-bad">꼭 필요한 값을 찾지 못했습니다: ' + miss.join(', ') + ' — 위에서 열의 쓰임을 고르거나, <b>양식 복사</b>로 받은 양식에 맞춰 붙여 넣으세요.</p>';
      if (T.over) h += '<p class="v2-help v2-bad">' + LIMIT + '대까지만 계산합니다. 나머지 ' + T.over + '대는 나눠서 붙여 주세요.</p>';
      $('bCols').innerHTML = h + '</div>';
    }

    function tokOf(text) {                                   // 그 표기를 가진 첫 차의 읽은 결과(후보 · 짐작)
      for (var i = 0; i < rows.length; i++) {
        var t = (rows[i].cond.tokens || []).filter(function (x) { return x.text === text; })[0];
        if (t) return t;
      }
      return null;
    }
    function renderFix() {
      var unk = {}, order = [], gss = {}, gorder = [];
      rows.forEach(function (r) {
        r.cond.unknown.forEach(function (t) { if (!unk[t]) { unk[t] = 0; order.push(t); } unk[t]++; });
        (r.cond.tokens || []).forEach(function (t) { if (t.kind === 'guess') { if (!gss[t.text]) { gss[t.text] = 0; gorder.push(t.text); } gss[t.text]++; } });
      });
      var low = rows.filter(needsCheck).length, none = rows.filter(function (r) { return r.text && !r.best; }).length;
      var guess = rows.filter(function (r) { return r.reg && r.reg.guess; }).length;
      var missKm = rows.filter(function (r) { return r.km == null; }).length, missReg = rows.filter(function (r) { return !r.reg; }).length;
      var remembered = Object.keys(FIX.name).length + Object.keys(FIX.grade).length + Object.keys(FIX.cond).length;
      if (!order.length && !gorder.length && !low && !none && !guess && !missKm && !missReg && !remembered && !TS.list.length) { $('bFix').innerHTML = ''; return; }
      var h = '<div class="card"><div class="card-title">③ 확인할 것' + IB + '</div>' + info('같은 표기는 한 번 고치면 모두 적용됩니다. 성능 표기는 띄어쓰기 · 줄임말 · 소리가 같은 철자(펜터 · 헨다 → 휀더)를 ' +
        '읽고, 비슷한 이름은 짐작해 읽은 뒤 아래에 보여 줍니다. 쓸 수 있는 표기: 부위(프론트 휀더·도어·후드·트렁크·쿼터·루프·필러…) + 좌·우(운전석·조수석 · FL·RR) + ' +
        '상태(교환·교 · 판금·판 · 용접 · 절단 · 요철 · 손상 · 부식 · 흠집 · 기스 · 수리필요). 여러 부위는 쉼표로 나눕니다.');
      if (order.length) {
        h += '<div class="v2-sub">못 읽은 성능 표기 ' + order.length + '가지 — 고치기 전에는 그 차를 계산하지 않습니다</div><div class="v2-fixes">';
        order.forEach(function (t, k) {
          var tk = tokOf(t), cs = tk && tk.cands || [];
          h += '<div class="v2-fixrow"><span class="v2-tok">' + esc(t) + '</span><span class="v2-dim">' + unk[t] + '대' + (tk && tk.why ? ' · ' + esc(tk.why) : '') + '</span>' +
            (cs.length ? '<span class="bt-cands">' + cs.map(function (c, ci) {
              return '<button type="button" class="v2-btn v2-cand" data-b="tokPick" data-k="' + k + '" data-c="' + ci + '">' + esc(c.label) + '</button>';
            }).join('') + '</span>' : '') +
            '<input class="v2-in" data-tok="' + k + '" autocomplete="off" placeholder="바르게 고쳐 쓰기 (예: 좌프론트휀더 판금)">' +
            '<button type="button" class="v2-btn" data-b="tokFix" data-k="' + k + '">적용</button>' +
            '<button type="button" class="v2-btn" data-b="tokSkip" data-k="' + k + '">무시하고 계산</button></div>';
        });
        h += '</div>';
        T.unk = order;
      }
      if (gorder.length) {                                   // 짐작해 읽은 표기 — 계산에는 넣었고, 틀렸으면 고친다(인터뷰 Q199)
        h += '<div class="v2-sub">짐작해 읽은 성능 표기 ' + gorder.length + '가지 — 계산에 넣었습니다. 틀렸으면 고르거나 고쳐 쓰세요</div><div class="v2-fixes">';
        gorder.forEach(function (t, k) {
          var tk = tokOf(t), cs = tk && tk.cands || [];
          h += '<div class="v2-fixrow"><span class="v2-tok">' + esc(t) + '</span><span class="v2-dim">' + gss[t] + '대</span>' +
            '<span class="bt-gread">→ <b>' + esc(tk ? tk.label : '') + '</b>' + (tk && tk.guess.length ? ' <small>' + esc(tk.guess.map(function (g) { return g.from === '좌우' ? g.to : g.from + '→' + g.to; }).join(' · ')) + '</small>' : '') + '</span>' +
            (cs.length ? '<span class="bt-cands">다른 것: ' + cs.map(function (c, ci) {
              return '<button type="button" class="v2-btn v2-cand" data-b="gPick" data-k="' + k + '" data-c="' + ci + '">' + esc(c.label) + '</button>';
            }).join('') + '</span>' : '') + '</div>';
        });
        h += '</div>';
        T.gss = gorder;
      }
      if (TS.list.length) {                                  // 고른 표기를 팀 사전에(환산 비율과 같은 비밀번호, 인터뷰 Q201·Q209)
        var by = ''; try { by = localStorage.getItem('v2.rates.by') || ''; } catch (e) { /* 없어도 된다 */ }
        h += '<div class="bt-tsave"><b>고른 표기 ' + TS.list.length + '개를 팀 사전에 넣으면</b> 다음부터 팀 모두가 자동으로 읽습니다: ' +
          esc(TS.list.map(function (x) { return "'" + x.t + "' = " + (x.kind === 'part' ? x.part + (x.side ? '(' + x.side + ')' : '') + (x.pillar ? '(' + x.pillar + ')' : '') : x.status); }).join(' · ')) +
          '<span class="bt-tform"><input class="v2-in" id="bTermBy" autocomplete="name" placeholder="이름" value="' + esc(by) + '">' +
          '<input class="v2-in" id="bTermPw" type="password" autocomplete="current-password" placeholder="수정 비밀번호" value="' + esc(ctx.terms.pw()) + '">' +
          '<button type="button" class="v2-btn primary" data-b="termSave">팀 사전에 저장</button><button type="button" class="v2-link" data-b="termSkip">안 넣음</button>' +
          '<em id="bTermMsg">' + esc(TS.msg) + '</em></span></div>';
      } else if (TS.msg) h += '<p class="v2-note bt-tdone">' + esc(TS.msg) + '</p>';
      var notes = [];
      if (low) notes.push('차명 확신이 낮은 차 <b>' + low + '대</b> — 아래 표의 노란 칸에서 맞는 모델·등급을 고르세요');
      if (none) notes.push('차명을 찾지 못한 차 <b>' + none + '대</b> — 빨간 칸에서 "다른 모델 찾기"로 고르세요');
      if (missReg) notes.push('최초등록·연식이 없는 차 <b>' + missReg + '대</b>');
      if (missKm) notes.push('주행거리가 없는 차 <b>' + missKm + '대</b>');
      if (guess) notes.push('연식만 있어 <b>6월</b> 등록으로 계산한 차 <b>' + guess + '대</b>(표에 * 표시)');
      if (notes.length) h += '<ul class="v2-notes">' + notes.map(function (n) { return '<li>' + n + '</li>'; }).join('') + '</ul>';
      if (remembered) h += '<p class="v2-note">이 브라우저에 기억한 고침: 차명 ' + Object.keys(FIX.name).length + ' · 등급 ' + Object.keys(FIX.grade).length +
        ' · 성능 표기 ' + Object.keys(FIX.cond).length + ' <button type="button" class="v2-btn" data-b="forget">모두 잊기</button></p>';
      $('bFix').innerHTML = h + '</div>';
    }

    function gradeOptions(r) {                               // 그 세부모델의 등급(세부등급 상관없음) + 등급·세부등급 조합, 많은 순
      var G = GROUPS[r.best.file], M = G.models[r.best.model], fi = G.fi, by = {}, list = [];
      G.F.rows.forEach(function (row) {
        if (row[fi.m] !== M.idx) return;
        var g = G.F.grades[row[fi.g]], t = G.F.trims[row[fi.t]] || '';
        var b = by[g] || (by[g] = { n: 0, t: {} });
        b.n++;
        if (t) b.t[t] = (b.t[t] || 0) + 1;
      });
      Object.keys(by).sort(function (a, b) { return by[b].n - by[a].n; }).forEach(function (g) {
        var ts = Object.keys(by[g].t).sort(function (a, b) { return by[g].t[b] - by[g].t[a]; });
        list.push([g + '|', g + (ts.length ? ' (세부등급 상관없음)' : '') + ' · ' + by[g].n + '대']);
        ts.forEach(function (t) { list.push([g + '|' + t, '　' + g + ' ' + t + ' · ' + by[g].t[t] + '대']); });
      });
      return list;
    }
    function modelCell(r, i) {
      if (r.other) return '<input class="v2-in v2-cin" list="bModels" data-other="' + i + '" autocomplete="off" placeholder="모델 이름으로 찾기">';
      var list = (r.res && r.res.cands || []).slice(), cur = r.best;
      function same(a) { return function (b) { return a.model === b.model && a.file === b.file; }; }
      if (cur && !list.some(same(cur))) list.unshift(cur);
      r.mc = list;
      var o = list.map(function (c, k) {
        return '<option value="' + k + '"' + (cur && same(cur)(c) ? ' selected' : '') + '>' + esc(c.maker + ' ' + c.model + (c.y0 ? ' (' + c.y0 + '~' + c.y1 + ')' : '')) + '</option>';
      });
      if (!cur) o.unshift('<option value="" selected>— 못 찾음 —</option>');
      o.push('<option value="other">다른 모델 찾기…</option>');
      return '<select class="v2-csel" data-model="' + i + '" aria-label="' + r.no + '행 세부모델">' + o.join('') + '</select>' +
        (r.conf === 'fixed' ? '<span class="v2-ok" title="직접 고름">✓</span>' : '');
    }
    function gradeCell(r, i) {
      if (!r.best) return '';
      var cur = r.grade + '|' + r.trim, o = gradeOptions(r);
      if (!o.some(function (x) { return x[0] === cur; })) o.unshift([cur, r.grade + ' ' + r.trim]);
      return '<select class="v2-csel" data-grade="' + i + '" aria-label="' + r.no + '행 등급">' + o.map(function (x) {
        return '<option value="' + esc(x[0]) + '"' + (x[0] === cur ? ' selected' : '') + '>' + esc(x[1]) + '</option>';
      }).join('') + '</select>' + (r.gconf === 'fixed' ? '<span class="v2-ok" title="직접 고름">✓</span>' : '');
    }
    function condCell(r) {
      var c = r.cond;
      if (c.unknown.length) return '<span class="v2-bad">못 읽음: ' + esc(c.unknown.join(', ')) + '</span>';
      if (c.state === '미상') return '<span class="v2-dim">미상</span>';
      var out = c.outside && c.outside.length ? '<br><span class="v2-dim" title="성능점검 대상이 아니라 시세 계산에서 뺌(경매 평가에서는 감점될 수 있음)">계산 제외: ' +
        esc(c.outside.join(', ')) + '</span>' : '';
      if (c.state === '무사고' && !c.items.length) return '무사고' + out;
      var gs = (c.tokens || []).filter(function (t) { return t.kind === 'guess'; });
      return '<span title="' + esc(ISC.summary(c.items)) + '">' + esc(condShort(r)) + '</span>' +
        (gs.length ? ' <i class="bt-guess" title="' + esc(gs.map(function (t) { return t.text + ' → ' + t.label; }).join('\n')) + '">짐작</i>' : '') + out;
    }
    function link(r) {
      return ctx.href({ mk: r.best.maker, grp: r.best.group, model: r.best.model, grade: r.grade, trim: r.trim, y: String(r.reg.y), m: String(r.reg.m),
        km: String(r.km), color: r.color, cost: r.cost ? String(r.cost) : '', rent: r.rent,
        cond: r.cond.state === '미상' ? '미상' : (r.cond.items.length ? '입력' : '무사고'), items: r.cond.items });
    }
    function eok(v) { v = Math.round(v); return v >= 1e4 ? Math.floor(v / 1e4) + '억 ' + man(v % 1e4) : man(v); }
    function sgn(p) { return (p > 0 ? '+' : p < 0 ? '−' : '') + Math.abs(p).toFixed(1) + '%'; }
    function med(a) { var s = a.slice().sort(function (x, y) { return x - y; }), n = s.length; return n ? (n % 2 ? s[n >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; }

    // 실제 건 검증(기획안 WP3): '실제 낙찰가' 열이 있으면 환산가와 비교하고, 실제 값으로 거꾸로 구한 환산 비율을 지금 비율과 견준다
    function verify() {
      var v = rows.filter(function (r) { return r.R && r.actual != null; });
      if (!v.length) return null;
      var err = v.map(function (r) { return (r.R.converted - r.actual) / r.actual * 100; });
      var imp = v.map(function (r) { return (1 - (r.actual + (r.cost || 0)) / r.R.est) * 100; }), used = v.map(function (r) { return r.R.rate; });
      return { rows: v, n: v.length, mdape: med(err.map(Math.abs)), bias: med(err), within: err.filter(function (e) { return Math.abs(e) <= 10; }).length / v.length,
        imp: med(imp), used: med(used), err: err, impl: imp };
    }
    function verifyCard(s) {
      var gap = s.imp - s.used, adv = Math.abs(gap) < 1.5 ? '지금 쓰는 비율과 비슷합니다' :
        '지금 비율보다 <b>' + Math.abs(gap).toFixed(1) + '%p ' + (gap > 0 ? '높습니다' : '낮습니다') + '</b> — ' + (s.n < 5 ? '건수가 적어 참고만 하세요' :
          '⚙ 환산 비율에서 해당 호가대·차령 칸이나 모델별 비율을 ' + (gap > 0 ? '올리는' : '내리는') + ' 것을 검토하세요');
      var h = '<div class="card"><div class="card-title">실제 건 비교' + IB + '</div>' + info('붙여넣은 실제 낙찰가 대비 환산가입니다. + 는 환산가가 실제보다 높다는 뜻입니다. ' +
        '실제 비율 = 1 − (실제 낙찰가 + 수리비) ÷ 수리비 빼기 전 추정 시세. 같은 호가대·차령에서 실제 비율이 꾸준히 다르면 ⚙ 환산 비율에서 그 칸을 고칩니다.') +
        '<div class="v2-kv">비교 <b>' + s.n + '대</b> · 오차 중위(절댓값) <b>' + s.mdape.toFixed(1) + '%</b> · 치우침 <b>' + sgn(s.bias) + '</b> · ±10% 안 <b>' +
        Math.round(s.within * 100) + '%</b><br>실제 낙찰가로 거꾸로 구한 환산 비율 중위 <b>' + s.imp.toFixed(1) + '%</b> · 지금 쓰는 비율 중위 <b>' + s.used.toFixed(1) +
        '%</b> → ' + adv + '</div><div class="v2-tablewrap"><table class="t v2-tbl"><thead><tr><th class="num">행</th><th>세부모델 · 등급</th><th class="num">추정 시세</th>' +
        '<th class="num">환산가</th><th class="num">실제 낙찰가</th><th class="num">오차</th><th class="num">쓴 비율</th><th class="num">실제 비율</th><th>비율 출처</th></tr></thead><tbody>';
      s.rows.forEach(function (r, k) {
        h += '<tr><td class="num v2-dim">' + r.no + '</td><td>' + esc(r.best.model + ' ' + r.grade) + '</td><td class="num">' + man(r.R.price) + '</td>' +
          '<td class="num">' + man(r.R.converted) + '</td><td class="num"><b>' + man(r.actual) + '</b></td><td class="num">' + sgn(s.err[k]) + '</td>' +
          '<td class="num">' + r.R.rate + '%</td><td class="num">' + s.impl[k].toFixed(1) + '%</td><td>' + esc(r.R.rateSource) + '</td></tr>';
      });
      return h + '</tbody></table></div></div>';
    }

    // ───── 차급·신뢰도별 대수·합계(05 차급별 요약 · 엑셀 '요약' 시트) ─────
    var GRADES = ['A', 'B', 'C'];
    function segOf(r) {                                      // 차급 이름(국산 대형) — 비교 매물 파일의 세부모델 차급
      var G = GROUPS[r.best.file], M = G && G.models[r.best.model], s = (M && M.seg || '').split('·');
      return s[1] ? s[1] + ' ' + s[0] : '기타';
    }
    function nice(a, z, n) {                                 // 보기 좋은 눈금(app.js niceTicks 와 같은 방식)
      var span = z - a, step = Math.pow(10, Math.floor(Math.log(span / n) / Math.LN10)), e = span / n / step;
      if (e >= 7.5) step *= 10; else if (e >= 3.5) step *= 5; else if (e >= 1.5) step *= 2;
      var t = [];
      var dp = Math.max(0, -Math.floor(Math.log(step) / Math.LN10 + 1e-9));   // 소수 꼬리 없이
      for (var v = Math.ceil(a / step) * step; v <= z + step * 1e-9; v += step) t.push(+(Math.round(v / step) * step).toFixed(dp));
      return t;
    }
    function logTicks(a, z) {                                // 로그 눈금: 1·2·5 × 10ⁿ
      var t = [];
      for (var k = Math.floor(Math.log(a) / Math.LN10); Math.pow(10, k) <= z; k++) {
        [1, 2, 5].forEach(function (m) { var v = m * Math.pow(10, k); if (v >= a && v <= z) t.push(v); });
      }
      return t;
    }
    function aggregate(done) {                               // 차급·신뢰도별 대수·합계(합계에 넣는 차만) — 요약 표와 엑셀 '요약' 시트
      var cnt = done.filter(counted), by = {}, order = [], gr = {};
      var z = function () { return { n: 0, A: 0, B: 0, C: 0, p: 0, c: 0, e: 0, er: 0 }; }, tot = z();
      cnt.forEach(function (r) {
        var s = segOf(r), R = r.R, add = function (b) { b.n++; b[R.grade]++; b.p += R.price; b.c += R.converted; b.e += R.est; b.er += R.est * R.rate; };
        if (!by[s]) { by[s] = z(); order.push(s); }
        add(by[s]); add(tot); add(gr[R.grade] = gr[R.grade] || z());
      });
      order.sort(function (a, b) { return by[b].n - by[a].n || by[b].p - by[a].p; });
      return { order: order, by: by, tot: tot, gr: gr, off: done.length - cnt.length };
    }

    function sumTable(ag) {
      var gb = function (b) { return GRADES.map(function (g) { return b[g] ? '<span class="v2-gb ' + g + '">' + g + '</span>' + b[g] : ''; }).filter(Boolean).join(' '); };
      var row = function (name, b, tot) {
        return '<tr' + (tot ? ' class="tot"' : '') + '><td>' + esc(name) + '</td><td class="num">' + b.n + '</td><td class="gr">' + gb(b) + '</td><td class="num">' + man(b.p) +
          '</td><td class="num">' + man(b.c) + '</td><td class="num">' + (b.e ? (b.er / b.e).toFixed(1) + '%' : '–') + '</td></tr>';
      };
      var h = '<div class="v2-ssub">차급별 · 합계에 넣는 차</div><div class="v2-tablewrap"><table class="t v2-bseg"><thead><tr><th>차급</th><th class="num">대수</th>' +
        '<th>신뢰도</th><th class="num">추정 시세 합계</th><th class="num">환산가 합계</th><th class="num">평균 환산 비율</th></tr></thead><tbody>' +
        ag.order.map(function (s) { return row(s, ag.by[s]); }).join('') + row('합계', ag.tot, true) + '</tbody></table></div>';
      h += '<div class="v2-ssub">신뢰도별</div><div class="v2-tablewrap"><table class="t v2-bseg"><thead><tr><th>신뢰도</th><th class="num">대수</th><th class="num">추정 시세 합계</th>' +
        '<th class="num">환산가 합계</th><th class="num">추정 시세 비중</th></tr></thead><tbody>' + GRADES.filter(function (g) { return ag.gr[g]; }).map(function (g) {
          var b = ag.gr[g];
          return '<tr><td><span class="v2-gb ' + g + '">' + g + '</span> ' + { A: '믿을 만함', B: '조건을 조금 넓힘', C: '참고값' }[g] + '</td><td class="num">' + b.n + '</td><td class="num">' + man(b.p) +
            '</td><td class="num">' + man(b.c) + '</td><td class="num">' + (ag.tot.p ? Math.round(b.p / ag.tot.p * 100) + '%' : '–') + '</td></tr>';
        }).join('') + '</tbody></table></div>';
      return h + (ag.off ? '<p class="v2-note">차명 확인이 필요한 ' + ag.off + '대(등록연도가 모델 기간 밖)는 합계에서 뺐습니다</p>' : '');
    }

    // ───── 묶음 결과(기획 v2.29 · 5.12, 인터뷰 Q174~Q197) — 01 합계 02 가격 그림(모델 묶음) 03 목록(모델별 · 펼침) 04 나란히 비교 05 차급별 요약 ─────
    // 한 번에 50대 넘게 넣으므로(Q175) 모델 묶음으로 접어 보이고, 자세히 볼 차는 그 자리에서 펼치거나 골라 나란히 본다(6대까지).
    // 상태는 붙여넣은 행 번호(r.no)로 기억한다 — 고쳐서 다시 계산해도 고른 차·기준 차·펼친 줄이 그대로.
    var V = { sort: 'row', group: true, openG: {}, openR: {}, cmp: [], ref: null, segOpen: false, inOpen: null, spy: 0, msg: '' };
    var CMP_MAX = 6, LP = ['차령', '주행', '성능', '색상', '렌트', '등급'], ITEMS = LP.concat(['수리비', '그 밖']);
    function gkey(r) { return r.best ? r.best.maker + '|' + r.best.model : ''; }
    function carName(r) { return (r.plate ? r.plate + ' ' : '') + (r.best ? r.best.model : r.text || '—'); }
    function regTxt(r) { return r.reg ? String(r.reg.y).slice(2) + '.' + pad(r.reg.m) + (r.reg.guess ? '*' : '') : '등록 없음'; }
    function kmTxt(r) { return r.km != null ? (r.km / 1e4).toFixed(1) + '만km' : '주행 없음'; }
    function condTxt(r) { return r.cond.unknown.length ? '성능 못 읽음' : r.cond.state === '미상' ? '상태 미상' : r.c['사고라벨']; }
    function signMan(v) { v = Math.round(v); return (v > 0 ? '+' : v < 0 ? '−' : '±') + man(Math.abs(v)); }
    function avgReg(m) { m = Math.round(m); var y = Math.floor((m - 1) / 12); return String(y).slice(2) + '.' + pad(m - y * 12); }
    function kv(k, v) { return '<div class="kv"><span>' + k + '</span><b>' + v + '</b></div>'; }

    function groupList() {                                   // 모델 묶음 — 대수 · 합계 · 평균 · 범위 · 평균 조건 · 같은 모델 평균(보정 차이 기준, Q195·Q196)
      var by = {}, order = [];
      rows.forEach(function (r) {
        var k = gkey(r);
        if (!by[k]) { by[k] = { key: k, maker: r.best ? r.best.maker : '', model: r.best ? r.best.model : '차명 확인 필요', rows: [], done: [], first: order.length }; order.push(k); }
        by[k].rows.push(r);
        if (r.R) by[k].done.push(r);
      });
      return order.map(function (k) {
        var g = by[k], d = g.done, n = d.length, avg = function (f) { return n ? d.reduce(function (s, r) { return s + f(r); }, 0) / n : null; };
        var cnt = d.filter(counted);
        g.sumP = cnt.reduce(function (s, r) { return s + r.R.price; }, 0);
        g.sumC = cnt.reduce(function (s, r) { return s + r.R.converted; }, 0);
        g.avgP = avg(function (r) { return r.R.price; });
        g.avgC = avg(function (r) { return r.R.converted; });
        g.lo = n ? Math.min.apply(null, d.map(function (r) { return r.R.price; })) : null;
        g.hi = n ? Math.max.apply(null, d.map(function (r) { return r.R.price; })) : null;
        g.avgM = avg(function (r) { return r.reg.y * 12 + r.reg.m; });
        g.avgKm = avg(function (r) { return r.km; });
        var mean = function (list) {                          // 평균 차(보정 차이 기준) — 시세 · 수리비 · 보정 위치(로그). 색상·성능은 아는 차끼리만
          var m = list.length, a = function (f, ls) { ls = ls || list; return ls.length ? ls.reduce(function (s, r) { return s + f(r); }, 0) / ls.length : 0; };
          var o = { n: m, price: a(function (r) { return r.R.price; }), est: a(function (r) { return r.R.est; }), repair: a(function (r) { return r.R.repair || 0; }), lp: {} };
          var lpl = list.filter(function (r) { return r.lp; }), colK = lpl.filter(function (r) { return r.lp.colorKnown; }), condK = lpl.filter(function (r) { return r.lp.condKnown; });
          LP.forEach(function (k) { o.lp[k] = a(function (r) { return r.lp[k]; }, k === '색상' ? colK : k === '성능' ? condK : lpl); });
          o.lp.colorKnown = colK.length > 0; o.lp.condKnown = condK.length > 0;
          return o;
        };
        g.ref = n ? mean(d) : null;
        g.sub = {};                                          // 같은 등급끼리(2대 이상) — 등급 차이가 '그 밖'에 섞이지 않게
        d.forEach(function (r) { (g.sub[r.grade] = g.sub[r.grade] || []).push(r); });
        Object.keys(g.sub).forEach(function (k) { g.sub[k] = g.sub[k].length >= 2 ? mean(g.sub[k]) : null; });
        return g;
      }).sort(function (a, b) {
        return (!a.key) - (!b.key) || (V.sort === 'row' ? a.first - b.first : b.done.length - a.done.length || (b.avgP || 0) - (a.avgP || 0));
      });
    }
    function refRow() {
      if (V.ref == null) return null;
      var r = rows.filter(function (x) { return x.no === V.ref; })[0];
      return r && r.R ? r : null;
    }
    function refFor(r, G, noCar) {                           // 보정 차이 기준: 같은 모델 기준 차 → 같은 등급 평균(2대 이상) → 같은 모델 평균(2대 이상, 등급 차이는 '등급·그 밖') → 없음
      var rf = noCar ? null : refRow();
      if (rf && rf !== r && gkey(rf) === gkey(r)) return { label: '기준 차(' + carName(rf) + ')', short: '기준', price: rf.R.price, est: rf.R.est, repair: rf.R.repair || 0, lp: rf.lp };
      var g = G.filter(function (x) { return x.key === gkey(r); })[0];
      if (!g || !g.ref) return null;
      var sg = g.sub[r.grade];
      if (sg && sg.n < g.done.length) return { label: '같은 등급 평균(' + r.grade + ' ' + sg.n + '대)', short: '등급 평균', price: sg.price, est: sg.est, repair: sg.repair, lp: sg.lp };
      return g.done.length >= 2 ? { label: '같은 모델 평균(' + g.done.length + '대)', short: '평균', price: g.ref.price, est: g.ref.est, repair: g.ref.repair, lp: g.ref.lp } : null;
    }
    function decomp(r, ref) {                                // 값 차이를 보정 항목으로(Q180) — 엔진과 같은 계수로 두 차의 조건 차이를 금액(기준 차 값 기준)으로, 남는 차이는 '그 밖'
      var a = r.lp, out = [];
      if (a && ref.lp) LP.forEach(function (k) {
        var ok = k === '색상' ? a.colorKnown && ref.lp.colorKnown : k === '성능' ? a.condKnown && ref.lp.condKnown : true;   // 모르는 색상·성능은 나누지 않음
        out.push([k, ok ? ref.est * (Math.exp(a[k] - ref.lp[k]) - 1) : 0]);
      });
      out.push(['수리비', -((r.R.repair || 0) - ref.repair)]);
      var tot = r.R.price - ref.price, part = out.reduce(function (s, x) { return s + x[1]; }, 0);
      out.push(['그 밖', tot - part]);
      return { items: out.filter(function (x) { return Math.abs(x[1]) >= 0.5 || x[0] === '그 밖'; }), tot: tot };
    }
    function verdict(r) {                                    // 판매 가격 vs 추정 범위(가운데 50%) — Q184·Q194
      if (!r.R || r.ask == null) return null;
      var d = r.ask - r.R.price, k = r.ask < r.R.range[0] ? 'lo' : r.ask > r.R.range[1] ? 'hi' : 'ok';
      return { k: k, d: d, p: d / r.R.price * 100, label: { lo: '싸게 나옴', ok: '적정', hi: '비싸게 나옴' }[k] };
    }
    function delta(r, G) {                                   // '기준 대비' — 기준 차가 있으면 그 차(다른 모델도 금액만), 없으면 같은 등급(또는 모델) 평균
      if (!r.R) return null;
      var rf = refRow();
      if (rf) return rf === r ? { star: true } : { d: r.R.price - rf.R.price, by: '기준' };
      var ref = refFor(r, G, true);
      return ref ? { d: r.R.price - ref.price, by: ref.short } : null;
    }
    function sortRows(list, G) {                             // 정렬(Q187) — 계산 못 한 차는 뒤로(입력 순은 그대로)
      if (V.sort === 'row') return list.slice().sort(function (a, b) { return a.no - b.no; });
      var key = { hi: function (r) { return -r.R.price; }, lo: function (r) { return r.R.price; }, conv: function (r) { return -r.R.converted; },
        ref: function (r) { var x = delta(r, G); return !x ? 1e9 : x.star ? -1e9 : x.d; },
        deal: function (r) { var v = verdict(r); return v ? v.p : 1e9; } }[V.sort];
      return list.slice().sort(function (a, b) { return (!a.R) - (!b.R) || (a.R && b.R ? key(a) - key(b) : 0) || a.no - b.no; });
    }
    function cmpCars() { return V.cmp.map(function (no) { return rows.filter(function (r) { return r.no === no && r.R; })[0]; }).filter(Boolean); }

    function bsec(id, no, title, body, o) {                  // 번호 섹션(한 대 산정과 같은 모양, Q189)
      o = o || {};
      var folded = !!o.fold && !V.segOpen;
      return '<section class="v2-sec bt-sec' + (folded ? ' is-folded' : '') + '" id="bsec-' + id + '" data-bsec="' + id + '">' +
        '<div class="v2-sech"><span class="v2-secno" aria-hidden="true">0' + no + '</span><h2>' + esc(title) + '</h2>' + (o.peek ? '<span class="v2-peek">' + o.peek + '</span>' : '') +
        '<span class="v2-sectools">' + (folded ? '' : o.tools || '') + (o.fold ? '<button type="button" class="v2-btn v2-foldbtn" data-b="segFold" aria-expanded="' + !folded + '">' +
          (folded ? '펼치기 ▾' : '접기 ▴') + '</button>' : '') + '</span></div>' + (folded ? '' : body) + '</section>';
    }

    // 01 합계 — 숫자 4칸 · 계산 못 한 차(이유와 할 일) · 실제 건 비교
    function sumSec(done, skip, chk, cN, sumP, sumC, offNote) {
      var h = '<div class="v2-cards v2-bcards">' +
        ctx.tile('산정', String(done.length), '대', skip ? '계산 못 함 ' + skip + '대' : '전부 계산됨') +
        ctx.tile('추정 시세 합계', man(sumP), '만원', eok(sumP) + '만 · 수리비 반영' + offNote) +
        ctx.tile('환산가 합계', man(sumC), '만원', eok(sumC) + '만' + offNote) +
        ctx.tile('확인할 차', String(chk + skip), '대', '신뢰도 C ' + cN + '대 · 차명 확인 ' + chk + '대') + '</div>';
      if (skip) {                                            // 계산 못 한 차 — 이유별 대수와 할 일(사용자 요청 11-03)
        var why = {}, HOW = { '차명 못 찾음': '목록의 빨간 칸에서 "다른 모델 찾기"로 고르세요', '차명 없음': '차명 열을 확인하세요', '등급 없음': '목록에서 등급을 고르세요',
          '연식·최초등록 없음': '최초등록(2019년 3월 · 2019-03) 또는 연식(2019) 열을 넣으세요', '주행 없음': '주행거리(45000) 열을 넣으세요',
          '못 읽은 성능 표기': '위 ③에서 표기를 고치거나 "무시하고 계산"을 누르세요', '비교 매물 5대 미만': '매물이 적은 차라 계산하지 않았습니다(한 대 산정에서 조건을 넓혀 보세요)' };
        rows.forEach(function (r) { if (!r.R) r.why.forEach(function (w) { why[w] = (why[w] || 0) + 1; }); });
        h += '<div class="card v2-bwhy"><div class="card-title">계산 못 한 차 ' + skip + '대</div><ul>' + Object.keys(why).sort(function (a, b) { return why[b] - why[a]; }).map(function (w) {
          return '<li><b>' + esc(w) + ' ' + why[w] + '대</b> — ' + esc(HOW[w] || '목록에서 확인하세요') + '</li>';
        }).join('') + '</ul><p class="v2-note">붙여 넣는 모양을 모르겠으면 <button type="button" class="v2-btn" data-b="formCopy">양식 복사</button> 로 받아 채워 보세요.</p></div>';
      }
      var vs = verify();
      if (vs) h += verifyCard(vs);
      return h;
    }

    // 02 가격 그림 — 모델 묶음 한 줄(가장 싼 ~ 비싼 차 · 차마다 점 · 평균), 누르면 그 모델의 차들(Q186)
    function scaleOf(done) {
      var lo = Infinity, hi = -Infinity;
      done.forEach(function (r) {
        lo = Math.min(lo, r.R.range[0], r.R.converted, r.ask != null ? r.ask : Infinity, r.actual != null ? r.actual : Infinity);
        hi = Math.max(hi, r.R.range[1], r.R.price, r.ask != null ? r.ask : -Infinity, r.actual != null ? r.actual : -Infinity);
      });
      var log = lo > 0 && hi / lo > 4;                        // 값 차이가 4배를 넘으면(여러 차종) 로그 눈금 — 싼 차의 범위도 보이게
      if (log) { lo *= 0.92; hi *= 1.06; } else { var gap = (hi - lo) * 0.04 || hi * 0.05; lo = Math.max(0, lo - gap); hi += gap; }
      var f = log ? Math.log : function (v) { return v; }, f0 = f(lo), f1 = f(hi);
      return { log: log, pc: function (v) { return ((f(v) - f0) / (f1 - f0) * 100).toFixed(2) + '%'; },
        w: function (a, b) { return Math.max(0.4, (f(b) - f(a)) / (f1 - f0) * 100).toFixed(2) + '%'; }, ticks: log ? logTicks(lo, hi) : nice(lo, hi, 5) };
    }
    function chartHtml(G, done) {
      if (!done.length) return '<p class="v2-note">계산된 차가 없습니다</p>';
      var sc = scaleOf(done), grid = sc.ticks.map(function (t) { return '<i class="g" style="left:' + sc.pc(t) + '"></i>'; }).join('');
      var hasAsk = done.some(function (r) { return r.ask != null; }), hasAct = done.some(function (r) { return r.actual != null; });
      var h = '<div class="v2-legend bt-legend"><span><i class="bt-lspan"></i>모델: 가장 싼 ~ 비싼 차</span><span><i class="bt-ldot"></i>차 한 대</span><span><i class="bt-lavg"></i>모델 평균</span>' +
        '<span><i class="v2-brng"></i>펼친 차: 추정 범위 · 색 = 신뢰도</span><span><i class="v2-best"></i>추정 시세</span><span><i class="v2-bcv"></i>환산가</span>' +
        (hasAsk ? '<span><i class="bt-lask"></i>판매 가격</span>' : '') + (hasAct ? '<span><i class="v2-bac"></i>실제 낙찰가</span>' : '') + '</div><div class="bt-chart">';
      G.filter(function (g) { return g.done.length; }).forEach(function (g) {
        var open = !!V.openG[g.key];
        var tip = g.model + ' · ' + g.done.length + '대\n평균 ' + man(g.avgP) + '만 · 환산 평균 ' + man(g.avgC) + '만\n가장 싼 ' + man(g.lo) + ' ~ 비싼 ' + man(g.hi) + '만\n누르면 ' + (open ? '접기' : '이 모델의 차 보기');
        h += '<button type="button" class="bt-crow g' + (open ? ' on' : '') + '" data-b="g" data-v="' + esc(g.key) + '" aria-expanded="' + open + '">' +
          '<span class="nm"><i class="ar" aria-hidden="true">' + (open ? '▾' : '▸') + '</i><b>' + esc(g.model) + '</b><small>' + esc(g.maker) + ' · ' + g.done.length + '대</small></span>' +
          '<span class="trk" data-tip="' + esc(tip) + '">' + grid + '<i class="span" style="left:' + sc.pc(g.lo) + ';width:' + sc.w(g.lo, g.hi) + '"></i>' +
          g.done.map(function (r) { return '<i class="d" style="left:' + sc.pc(r.R.price) + '"></i>'; }).join('') + '<i class="avg" style="left:' + sc.pc(g.avgP) + '"></i></span>' +
          '<span class="v"><b>' + man(g.avgP) + '</b><small>평균 · 환산 ' + man(g.avgC) + '</small></span></button>';
        if (!open) return;
        var ls = scaleOf(g.done), lgrid = ls.ticks.map(function (t) { return '<i class="g" style="left:' + ls.pc(t) + '"></i>'; }).join('');   // 펼친 모델은 그 모델 눈금으로 — 같은 모델 안의 차이가 보이게
        sortRows(g.done, G).forEach(function (r) {
          var R = r.R, v = verdict(r), off = yearOut(r);
          var tip2 = carName(r) + ' ' + r.grade + (r.trim ? ' ' + r.trim : '') + '\n' + regTxt(r) + ' · ' + kmTxt(r) + ' · ' + condTxt(r) + '\n추정 ' + man(R.price) + '만(범위 ' +
            man(R.range[0]) + '~' + man(R.range[1]) + ') · 신뢰도 ' + R.grade + '\n환산 ' + man(R.converted) + '만(' + R.rate + '%)' +
            (v ? '\n판매 ' + man(r.ask) + '만 — ' + v.label + '(' + signMan(v.d) + ')' : '') + (off ? '\n차명 확인 필요 — 합계 제외' : '') + '\n누르면 목록의 그 차로';
          h += '<div class="bt-crow c' + (off ? ' off' : '') + '" data-bs="' + r.no + '">' +
            '<span class="nm"><b>' + esc(r.plate || ('행 ' + r.no)) + '</b><small>' + esc(r.grade + (r.trim ? ' ' + r.trim : '')) + ' · ' + regTxt(r) + ' · ' + kmTxt(r) + '</small></span>' +
            '<span class="trk" data-tip="' + esc(tip2) + '">' + lgrid + '<i class="rng ' + R.grade + '" style="left:' + ls.pc(R.range[0]) + ';width:' + ls.w(R.range[0], R.range[1]) + '"></i>' +
            '<i class="cv" style="left:' + ls.pc(R.converted) + '"></i><i class="es" style="left:' + ls.pc(R.price) + '"></i>' +
            (v ? '<i class="ask ' + v.k + '" style="left:' + ls.pc(r.ask) + '"></i>' : '') + (r.actual != null ? '<i class="ac" style="left:' + ls.pc(r.actual) + '"></i>' : '') + '</span>' +
            '<span class="v"><b>' + man(R.price) + '</b><small>환산 ' + man(R.converted) + '</small></span></div>';
        });
        h += '<div class="bt-crow ax sub"><span class="axn">' + esc(g.model) + ' 눈금</span><span class="axt">' + ls.ticks.map(function (t) { return '<i style="left:' + ls.pc(t) + '">' + man(t) + '</i>'; }).join('') +
          '</span><span class="axu">만원</span></div>';
      });
      h += '<div class="bt-crow ax"><span></span><span class="axt">' + sc.ticks.map(function (t) { return '<i style="left:' + sc.pc(t) + '">' + man(t) + '</i>'; }).join('') +
        '</span><span class="axu">만원</span></div></div>';
      if (sc.log) h += '<p class="v2-note">값 차이가 커서 눈금을 로그(비율)로 · 같은 너비 = 같은 비율</p>';
      return h;
    }

    // 03 목록 — 모델별 묶음 머리 + 한 줄 = 한 차(넉넉한 줄) · 누르면 그 자리에서 펼침(Q185)
    function listTools(hasAsk) {
      var s = [['row', '입력 순'], ['hi', '시세 높은 순'], ['lo', '시세 낮은 순'], ['conv', '환산가 높은 순'], ['ref', refRow() ? '기준보다 싼 순' : '평균보다 싼 순']]
        .concat(hasAsk ? [['deal', '싸게 나온 순']] : []);
      return '<div class="segmented" role="group" aria-label="정렬">' + s.map(function (o) {
        return '<button type="button" data-b="sort" data-v="' + o[0] + '" class="' + (V.sort === o[0] ? 'on' : '') + '">' + o[1] + '</button>';
      }).join('') + '</div><div class="segmented" role="group" aria-label="묶기">' + [['1', '모델별'], ['0', '한 줄로']].map(function (o) {
        return '<button type="button" data-b="grp" data-v="' + o[0] + '" class="' + ((V.group ? '1' : '0') === o[0] ? 'on' : '') + '">' + o[1] + '</button>';
      }).join('') + '</div><label class="v2-chk" style="margin:0"><input type="checkbox" data-b="only"' + (onlyCheck ? ' checked' : '') + '> 확인할 차만</label>';
    }
    function ghead(g) {
      var n = g.done.length;
      if (g.rows.length === 1) return '<div class="bt-ghead one"><div class="t"><b>' + esc(g.model) + '</b><small>' + esc(g.maker) + (g.maker ? ' · ' : '') + '1대</small></div></div>';   // 한 대뿐이면 이름만
      return '<div class="bt-ghead"><div class="t"><b>' + esc(g.model) + '</b><small>' + esc(g.maker) + (g.maker ? ' · ' : '') + g.rows.length + '대' +
        (g.rows.length > n ? '(계산 ' + n + ')' : '') + '</small></div>' +
        (n ? '<div class="k"><span>추정 합계</span><b>' + man(g.sumP) + '</b></div><div class="k"><span>환산 합계</span><b>' + man(g.sumC) + '</b></div>' +
          '<div class="k"><span>평균 시세</span><b>' + man(g.avgP) + '</b></div><div class="k"><span>범위</span><b>' + man(g.lo) + ' ~ ' + man(g.hi) + '</b></div>' +
          '<div class="k"><span>평균 조건</span><b>' + avgReg(g.avgM) + ' · ' + (g.avgKm / 1e4).toFixed(1) + '만km</b></div>' : '') + '</div>';
    }
    function listHtml(G) {
      var shown = function (r) { return !onlyCheck || !r.R || needsCheck(r) || r.R.grade === 'C'; }, any = false;
      var h = '<div class="bt-list"><div class="bt-lhead"><span aria-hidden="true">비교</span><span>차</span><span>조건</span><span class="num">추정 시세</span><span class="num">환산가</span>' +
        '<span>' + (refRow() ? '기준 차 대비' : '같은 등급 · 모델 평균 대비') + ' · 판매가</span><span>신뢰도</span><span></span></div>';
      if (V.group) G.forEach(function (g) {
        var list = sortRows(g.rows, G).filter(shown);
        if (!list.length) return;
        any = true;
        h += ghead(g) + list.map(function (r) { return rowItem(r, G); }).join('');
      });
      else {
        var list = sortRows(rows, G).filter(shown);
        any = list.length > 0;
        h += list.map(function (r) { return rowItem(r, G); }).join('');
      }
      return any ? h + '</div>' : '<p class="v2-kv">확인할 차가 없습니다.</p>';
    }
    function rowItem(r, G) {
      var i = rows.indexOf(r), R = r.R, open = !!V.openR[r.no], isRef = !!R && V.ref === r.no, inCmp = V.cmp.indexOf(r.no) >= 0;
      var warnM = r.conf === 'mid' || r.conf === 'low', fix = !R || !r.best || yearOut(r) || warnM || r.gconf === 'low';
      var dl = delta(r, G), v = verdict(r), off = R && yearOut(r) ? ' v2-off' : '';
      var h = '<div class="bt-row' + (R ? '' : ' is-skip') + (open ? ' is-open' : '') + (isRef ? ' is-ref' : '') + '" data-row="' + r.no + '">' +
        '<label class="ck" title="나란히 비교에 넣기(' + CMP_MAX + '대까지)"><input type="checkbox" data-cmp="' + r.no + '"' + (inCmp ? ' checked' : '') + (R ? '' : ' disabled') +
        ' aria-label="' + r.no + '행 나란히 비교에 넣기"></label>' +
        '<div class="car"><b>' + (isRef ? '★ ' : '') + esc(r.plate || ('행 ' + r.no)) + (r.rent ? ' <span class="v2-rent">렌트</span>' : '') + '</b>' +
        (r.best ? '<span class="gr">' + esc((V.group ? '' : r.best.model + ' · ') + r.grade + (r.trim ? ' ' + r.trim : '')) + '</span>' : '') +
        '<small class="src">' + esc(r.text || '—') + '</small>' +
        (fix ? '<div class="fix"><div class="' + (!r.best || yearOut(r) ? 'v2-cbad' : warnM ? 'v2-cwarn' : '') + '">' + modelCell(r, i) + '</div>' +
          (yearOut(r) ? '<div class="v2-bad v2-ynote">등록 ' + r.reg.y + ' · 모델 ' + r.best.y0 + '~' + r.best.y1 + ' — 다른 모델인지 확인(합계 제외)</div>' : '') +
          (r.best ? '<div class="' + (r.gconf === 'low' ? 'v2-cwarn' : '') + '">' + gradeCell(r, i) + '</div>' : '') + '</div>' : '') + '</div>' +
        '<div class="cnd"><b>' + (r.reg ? regTxt(r) : '<span class="v2-bad">등록 없음</span>') + ' · ' + (r.km != null ? kmTxt(r) : '<span class="v2-bad">주행 없음</span>') + '</b>' +
        '<small>' + esc(r.color || '색상 —') + ' · ' + condCell(r) + '</small></div>';
      if (R) {
        h += '<div class="num p' + off + '"><b>' + man(R.price) + '</b><small>' + man(R.range[0]) + '~' + man(R.range[1]) + '</small></div>' +
          '<div class="num c' + off + '"><b>' + man(R.converted) + '</b><small>' + R.rate + '%' + (r.actual != null ? ' · 실제 ' + man(r.actual) : '') + '</small></div>' +
          '<div class="rel">' + (dl ? dl.star ? '<span class="bt-ref">★ 기준</span>' : '<span class="bt-d ' + (dl.d > 0 ? 'up' : dl.d < 0 ? 'dn' : '') + '">' + dl.by + ' ' + signMan(dl.d) + '</span>' : '') +
          (v ? '<span class="bt-v ' + v.k + '">' + v.label + ' ' + signMan(v.d) + '</span>' : '') + '</div>' +
          '<div class="cf"><span class="v2-gb ' + R.grade + '">' + R.grade + '</span><small>' + R.n + '대</small></div>';
      } else h += '<div class="why v2-bad">' + esc(r.why.join(' · ')) + '</div>';
      h += '<button type="button" class="tg" data-b="open" data-v="' + r.no + '" aria-expanded="' + open + '" aria-label="' + r.no + '행 자세히">' + (open ? '▴' : '▾') + '</button></div>';
      return h + (open ? detailHtml(r, G) : '');
    }
    function detailHtml(r, G) {                              // 펼침: 왜 다른가(보정 항목별) · 비교 매물 · 환산 · 판매가 판정 · 매칭 · 단추
      var R = r.R, i = rows.indexOf(r);
      if (!R) return '<div class="bt-detail"><p class="v2-note">계산 못 한 이유: ' + esc(r.why.join(' · ')) + ' — 위 칸에서 고치면 다시 계산합니다.</p></div>';
      var ref = refFor(r, G), rf = refRow(), v = verdict(r), h = '<div class="bt-detail"><div class="bt-dgrid"><div class="bt-dleft">';
      if (ref) {
        var dc = decomp(r, ref), mx = Math.max.apply(null, dc.items.map(function (x) { return Math.abs(x[1]); }).concat([1]));
        h += '<div class="bt-dt">왜 다른가 — ' + esc(ref.label) + ' 대비 <b class="' + (dc.tot > 0 ? 'up' : dc.tot < 0 ? 'dn' : '') + '">' + signMan(dc.tot) + '만</b></div>' +
          dc.items.map(function (x) {
            return '<div class="bt-db"><span class="nm">' + x[0] + '</span><span class="tr"><i class="' + (x[1] >= 0 ? 'p' : 'm') + '" style="' + (x[1] >= 0 ? 'left' : 'right') +
              ':50%;width:' + (Math.abs(x[1]) / mx * 50).toFixed(1) + '%"></i></span><span class="num ' + (x[1] > 0 ? 'up' : x[1] < 0 ? 'dn' : '') + '">' + signMan(x[1]) + '</span></div>';
          }).join('') + '<p class="v2-note">시세 엔진과 같은 보정 계수로 나눈 금액(만원) · 등급 = 등급 · 세부등급 차이 · 그 밖 = 비교 매물 · 시점 · 시장 차이 · 색상 · 성능을 모르는 차는 그 항목을 나누지 않음</p>';
      } else if (rf && rf !== r) {
        h += '<div class="bt-dt">기준 차(' + esc(carName(rf)) + ')보다 <b class="' + (R.price > rf.R.price ? 'up' : 'dn') + '">' + signMan(R.price - rf.R.price) + '만</b></div>' +
          '<p class="v2-note">다른 모델끼리는 조건 차이로 나누지 않습니다</p>';
      } else h += '<div class="bt-dt">같은 모델이 이 차 하나라 비교할 평균이 없습니다</div><p class="v2-note">같은 모델의 다른 차를 ★ 기준 차로 고르면 그 차 대비 차이가 나옵니다</p>';
      h += '</div><div class="bt-dk">' + kv('추정 범위', man(R.range[0]) + ' ~ ' + man(R.range[1]) + '만') +
        (r.fp ? kv('출고가', man(r.fp.op) + '만 · 잔존율 ' + Math.round(R.est / r.fp.op * 100) + '%' + (r.fp.exact ? '' : ' (등급 기준)')) : '') + kv('비교 매물', R.n + '대 · ' + esc(R.stepName || '')) +
        kv('환산', man(R.converted) + '만 · ' + R.rate + '% · ' + esc(R.rateSource || '')) +
        (R.D && r.car && r.car['상태'] ? kv('기록부', esc(r.c && r.c['사고라벨'] || '무사고') + ' · 이력 감가 −' + (R.D * 100).toFixed(1) + '% · 무사고였다면 ' + man(R.base) + '만') : '') +
        (R.repair ? kv('수리비', '−' + man(R.repair) + '만 반영' + repairNote(r)) : '') +
        (v ? kv('판매 가격', man(r.ask) + '만 — <span class="bt-v ' + v.k + '">' + v.label + '</span> 시세 대비 ' + signMan(v.d) + '만(' + sgn(v.p) + ')') : '') +
        '<div class="bt-dfix"><span>매칭</span>' + modelCell(r, i) + gradeCell(r, i) + '</div></div></div>' +
        '<div class="v2-actions"><a class="v2-btn" href="' + esc(link(r)) + '" target="_blank" rel="noopener">한 대 산정 열기 ↗</a>' +
        '<button type="button" class="v2-btn" data-b="ref" data-v="' + r.no + '">' + (V.ref === r.no ? '기준 해제' : '★ 기준 차로') + '</button>' +
        '<button type="button" class="v2-btn" data-b="cmp" data-v="' + r.no + '">' + (V.cmp.indexOf(r.no) >= 0 ? '비교에서 빼기' : '나란히 비교에 넣기') + '</button></div></div>';
      return h;
    }

    // 04 나란히 비교 — 고른 차 6대까지, 열 = 차 · 가격 · 조건 · 보정 줄(Q182·Q183)
    function cmpData(G, cars, conv) {                        // 화면 · 한 장 · 엑셀이 같은 값을 쓴다 → [{ sec, name, vals: [[글, 모양]] }]
      var rf = refRow(), out = [], many = cars.length > 1, ps = cars.map(function (r) { return r.R.price; });
      var mn = Math.min.apply(null, ps), mx = Math.max.apply(null, ps);
      var add = function (sec, name, f) { out.push({ sec: sec, name: name, vals: cars.map(f) }); };
      add('가격', '추정 시세', function (r) { return [man(r.R.price) + '만', 'big' + (many && r.R.price === mn ? ' mn' : many && r.R.price === mx ? ' mx' : '')]; });
      add('가격', '범위(가운데 50%)', function (r) { return [man(r.R.range[0]) + ' ~ ' + man(r.R.range[1])]; });
      if (cars.some(function (r) { return r.fp; })) add('가격', '출고가 · 잔존율', function (r) {
        return r.fp ? [man(r.fp.op) + '만 · ' + Math.round(r.R.est / r.fp.op * 100) + '%' + (r.fp.exact ? '' : '(등급)')] : ['—', 'dim'];
      });
      if (conv) {
        add('가격', '환산가', function (r) { return [man(r.R.converted) + '만', 'b']; });
        add('가격', '환산 비율', function (r) { return [r.R.rate + '%']; });
      }
      add('가격', rf ? '기준 차 대비' : '같은 등급 · 모델 평균 대비', function (r) {
        var d = delta(r, G);
        return !d ? ['—', 'dim'] : d.star ? ['★ 기준', 'ref'] : [signMan(d.d) + '만', d.d > 0 ? 'up' : d.d < 0 ? 'dn' : ''];
      });
      if (cars.some(function (r) { return r.ask != null; })) {
        add('가격', '판매 가격', function (r) { return [r.ask != null ? man(r.ask) + '만' : '—', r.ask != null ? '' : 'dim']; });
        add('가격', '시세 대비', function (r) { var v = verdict(r); return v ? [v.label + ' ' + signMan(v.d) + '만(' + sgn(v.p) + ')', 'v ' + v.k] : ['—', 'dim']; });
      }
      add('조건', '최초등록', function (r) { return [r.reg.y + '-' + pad(r.reg.m) + (r.reg.guess ? '(월 미상)' : '')]; });
      add('조건', '주행', function (r) { return [r.km.toLocaleString('ko-KR') + 'km']; });
      add('조건', '색상', function (r) { return [r.color || '—', r.color ? '' : 'dim']; });
      add('조건', '성능 상태', function (r) { return [r.cond.state === '미상' ? '상태 미상(평균)' : r.cond.items.length ? condShort(r) : '무사고']; });
      if (cars.some(function (r) { return r.rent; })) add('조건', '렌트', function (r) { return [r.rent ? '렌트' : '—', r.rent ? '' : 'dim']; });   // 모두 비면 줄을 뺀다
      if (cars.some(function (r) { return r.R.repair; })) add('조건', '수리비', function (r) { return [r.R.repair ? man(r.R.repair) + '만' : '—', r.R.repair ? '' : 'dim']; });
      var dcs = cars.map(function (r) { var ref = refFor(r, G); return ref ? decomp(r, ref) : null; });
      var bs = '보정 — ' + (rf ? '같은 모델이면 기준 차 대비, 아니면 같은 등급 · 모델 평균 대비' : '같은 등급(없으면 같은 모델) 평균 대비') + ' · 다른 모델끼리는 나누지 않음';
      ITEMS.forEach(function (k) {
        add(bs, k, function (r, q) {
          if (rf && rf === r) return [k === '그 밖' ? '★ 기준' : '·', 'dim'];   // 기준 차 자신은 비교 대상
          var d = dcs[q];
          if (!d) return ['—', 'dim'];
          var x = d.items.filter(function (y) { return y[0] === k; })[0];
          return x ? [signMan(x[1]) + '만', x[1] > 0 ? 'up' : x[1] < 0 ? 'dn' : ''] : ['±0', 'dim'];
        });
      });
      return out.filter(function (row) {                     // 보정 줄은 모든 차가 ±0 · — 이면 뺀다(그 밖은 남김)
        return row.sec.indexOf('보정') !== 0 || row.name === '그 밖' || row.vals.some(function (x) { return x[1] !== 'dim'; });
      });
    }
    function cmpTable(G, cars, opt) {
      var data = cmpData(G, cars, opt.conv), last = '', h = '<table class="t bt-cmp"><thead><tr><th></th>' + cars.map(function (r) {
        return '<th>' + (V.ref === r.no ? '<span class="bt-ref">★ 기준</span>' : '') + '<b>' + esc(r.plate || ('행 ' + r.no)) + '</b><span>' + esc(r.best.model) + '</span><small>' +
          esc(r.grade + (r.trim ? ' ' + r.trim : '')) + '</small>' + (opt.print ? '' : '<button type="button" class="bt-x" data-b="cmp" data-v="' + r.no + '" aria-label="비교에서 빼기">×</button>') + '</th>';
      }).join('') + '</tr></thead><tbody>';
      data.forEach(function (row) {
        if (row.sec !== last) { last = row.sec; h += '<tr class="sec"><th colspan="' + (cars.length + 1) + '">' + esc(row.sec) + '</th></tr>'; }
        h += '<tr><th>' + esc(row.name) + '</th>' + row.vals.map(function (x) { return '<td class="' + (x[1] || '') + '">' + esc(x[0]) + '</td>'; }).join('') + '</tr>';
      });
      return h + '</tbody></table>';
    }
    function cmpHtml(G) {
      var cars = cmpCars(), msg = V.msg ? '<p class="v2-help v2-warnt2">' + esc(V.msg) + '</p>' : '';
      V.msg = '';
      if (!cars.length) return msg + '<div class="bt-cmpempty">목록에서 ☐를 눌러 비교할 차를 고르세요(' + CMP_MAX + '대까지). ★ 기준 차를 정하면 다른 차는 그 차보다 얼마나 비싼지 · 싼지로 보입니다.</div>';
      return msg + '<div class="v2-tablewrap">' + cmpTable(G, cars, { conv: true }) + '</div>';
    }
    function cmpToggle(no, on) {
      var k = V.cmp.indexOf(no);
      if (on && k < 0) { if (V.cmp.length >= CMP_MAX) V.msg = CMP_MAX + '대까지 비교합니다 — 다른 차를 빼고 넣으세요'; else V.cmp.push(no); }
      if (!on && k >= 0) V.cmp.splice(k, 1);
      renderOut();
    }
    function cmpSheet() {                                    // 비교 한 장(인쇄 · PDF, Q192) — 한 대 산정 한 장 요약과 같은 방식, A4 가로
      var cars = cmpCars();
      if (!cars.length) return;
      var G = groupList(), conv = false, mi = X.mi.crawls || [];
      var dlg = document.createElement('div');
      dlg.className = 'v2-sheetdlg';
      dlg.id = 'bSheetDlg';
      dlg.setAttribute('role', 'dialog');
      dlg.setAttribute('aria-modal', 'true');
      dlg.setAttribute('aria-label', '나란히 비교 한 장 미리보기');
      dlg.innerHTML = '<div class="bar"><b>나란히 비교 한 장</b><label><input type="checkbox" data-bsheet="conv"> 환산가 포함</label>' +
        '<span class="hint">외부에 보낼 때는 환산가를 끄세요. 인쇄 창에서 대상을 "PDF로 저장"으로 고르면 파일이 됩니다.</span>' +
        '<button type="button" class="v2-btn primary" data-bsheet-act="print">인쇄 · PDF</button><button type="button" class="v2-btn" data-bsheet-act="close">닫기</button></div>' +
        '<div class="v2-page bt-land" id="bSheetPage"><div class="v2-sheet bt-sheet" id="bSheet"></div></div>';
      document.body.appendChild(dlg);
      document.body.classList.add('v2-sheeton');
      var fit = function () { var p = $('bSheetPage'); if (p) p.style.zoom = Math.min(1, (window.innerWidth - 32) / 1123).toFixed(3); };
      var draw = function () {
        $('bSheet').innerHTML = '<div class="bt-sh"><div><div class="bt-sht">차량 비교 · ' + cars.length + '대</div><div class="bt-shs">온라인 소매 호가 기준 추정 시세 · ' +
          (mi.length ? '데이터 기준 ' + esc(mi[mi.length - 1].date) + ' 목록 · ' : '') + '작성 ' + esc(ctx.today()) + '</div></div><div class="bt-shb">카리스마<span>R</span></div></div>' +
          cmpTable(G, cars, { print: true, conv: conv }) + '<p class="bt-shn">추정 범위 = 보정 후 비교 매물 가격의 가운데 50% · 보정 줄 = 같은 보정 계수로 나눈 금액(같은 모델끼리만) · ' +
          '그 밖 = 세부등급 · 비교 매물 · 시점 차이' + (cars.some(function (r) { return r.ask != null; }) ? ' · 판매 가격 판정 = 범위 아래 싸게 나옴 · 안 적정 · 위 비싸게 나옴' : '') + '</p>';
        var p = $('bSheetPage'), sh = $('bSheet');                // 인쇄는 A4 가로 한 장(내용 높이 약 718px)에 맞춰 줄인다
        p.style.zoom = 1;
        sh.style.setProperty('--pz', Math.min(1, 700 / sh.offsetHeight).toFixed(3));
        fit();
      };
      var close = function () { dlg.remove(); document.body.classList.remove('v2-sheeton'); document.removeEventListener('keydown', key); window.removeEventListener('resize', fit); };
      var key = function (e) { if (e.key === 'Escape') close(); };
      dlg.addEventListener('change', function (e) { if (e.target.getAttribute('data-bsheet') === 'conv') { conv = e.target.checked; draw(); } });
      dlg.addEventListener('click', function (e) {
        var b = e.target.closest('[data-bsheet-act]');
        if (!b) { if (e.target === dlg) close(); return; }
        if (b.getAttribute('data-bsheet-act') === 'print') window.print(); else close();
      });
      document.addEventListener('keydown', key);
      window.addEventListener('resize', fit);
      draw();
      dlg.querySelector('input').focus();
    }

    // 오른쪽 목차(Q189) — 위에 산정 대수 · 합계 고정, 섹션으로 이동, 지금 보는 섹션 강조
    function navHtml(done, sumP, sumC, G) {
      var items = [['sum', 1, '합계', done.length + '대'], ['chart', 2, '가격 그림', G.filter(function (g) { return g.done.length; }).length + '모델'],
        ['list', 3, '목록', rows.length + '대'], ['cmp', 4, '나란히 비교', cmpCars().length + '/' + CMP_MAX], ['seg', 5, '차급별 요약', '']];
      return '<div class="nv-top"><div><span>산정</span><b>' + done.length + '대</b></div><div><span>추정 합계</span><b>' + man(sumP) + '</b></div>' +
        '<div><span>환산 합계</span><b>' + man(sumC) + '</b></div></div><ol>' + items.map(function (x) {
          return '<li><button type="button" data-bgo="' + x[0] + '"><span class="no">' + x[1] + '</span>' + x[2] + '<span class="v">' + x[3] + '</span></button></li>';
        }).join('') + '</ol><button type="button" class="v2-link nv-up" data-bgo="top">↑ 목록 다시 붙여넣기</button>';
    }
    function goSec(id) {
      if (id === 'top') { V.inOpen = true; inFold(); window.scrollTo({ top: 0, behavior: 'smooth' }); var ta = $('bPaste'); if (ta) ta.focus({ preventScroll: true }); return; }
      if (id === 'seg' && !V.segOpen) { V.segOpen = true; renderOut(); }
      var s = $('bsec-' + id), hd = document.querySelector('header'), nav = $('bNav');
      if (!s) return;
      var off = (hd ? hd.getBoundingClientRect().bottom : 60) + (window.innerWidth < 1200 && nav ? nav.offsetHeight : 0) + 12;
      window.scrollTo({ top: s.getBoundingClientRect().top + window.pageYOffset - off, behavior: 'smooth' });
    }
    function spy() {
      V.spy = 0;
      var nav = $('bNav');
      if (!nav || !nav.offsetParent) return;
      var secs = el.querySelectorAll('.bt-sec'), cur = secs[0], lim = window.innerWidth >= 1200 ? 140 : 190;
      secs.forEach(function (s) { if (s.getBoundingClientRect().top <= lim) cur = s; });
      if (secs.length && window.innerHeight + window.pageYOffset >= document.documentElement.scrollHeight - 4) cur = secs[secs.length - 1];
      var id = cur && cur.getAttribute('data-bsec');
      nav.querySelectorAll('li [data-bgo]').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-bgo') === id); });
    }

    function focusRow(no) {                                  // 가격 그림에서 누른 차 → 목록의 그 차(펼쳐서) · 확인할 차만 보기면 풀고
      no = +no;
      V.openR[no] = true;
      if (onlyCheck) onlyCheck = false;
      renderOut();
      var row = el.querySelector('.bt-row[data-row="' + no + '"]');
      if (!row) return;
      el.querySelectorAll('.bt-row.is-hl').forEach(function (x) { x.classList.remove('is-hl'); });
      row.classList.add('is-hl');
      row.scrollIntoView({ block: 'center' });
    }

    function renderOut() {
      var tipEl = document.getElementById('tip');
      if (tipEl) tipEl.hidden = true;                        // 다시 그리면 가리키던 칸이 사라지므로 말풍선도 닫는다
      if (!rows.length) { $('bOut').innerHTML = ''; return; }
      var done = rows.filter(function (r) { return r.R; }), sumP = 0, sumC = 0, cN = 0, off = done.filter(yearOut).length;
      done.filter(counted).forEach(function (r) { sumP += r.R.price; sumC += r.R.converted; });
      done.forEach(function (r) { if (r.R.grade === 'C') cN++; });
      var chk = rows.filter(needsCheck).length, skip = rows.length - done.length, offNote = off ? ' · 차명 확인 ' + off + '대는 합계 제외' : '';
      var G = groupList(), hasAsk = done.some(function (r) { return r.ask != null; }), nCmp = cmpCars().length;
      var h = '<div class="v2-rescol bt"><nav class="v2-snav" id="bNav" aria-label="묶음 결과 목차">' + navHtml(done, sumP, sumC, G) + '</nav><div class="v2-main">';
      h += bsec('sum', 1, '합계', sumSec(done, skip, chk, cN, sumP, sumC, offNote), {
        peek: done.length + '대 · 만원', tools: '<button type="button" class="v2-btn primary" data-b="xlsx"' + (done.length ? '' : ' disabled') + '>엑셀 내려받기</button>' });
      h += bsec('chart', 2, '가격 그림', '<div class="card">' + chartHtml(G, done) + '</div>', { peek: '모델을 누르면 그 모델의 차' });
      h += bsec('list', 3, '목록', '<div class="card bt-listcard">' + listHtml(G) + '</div>', { peek: rows.length + '대 · 줄을 누르면 자세히', tools: listTools(hasAsk) });
      h += bsec('cmp', 4, '나란히 비교', '<div class="card">' + cmpHtml(G) + '</div>', { peek: nCmp + ' / ' + CMP_MAX + '대',
        tools: '<button type="button" class="v2-btn" data-b="cmpSheet"' + (nCmp ? '' : ' disabled') + '>한 장 요약 →</button><button type="button" class="v2-btn" data-b="cmpClear"' +
          (nCmp ? '' : ' disabled') + '>비우기</button>' });
      h += bsec('seg', 5, '차급별 요약', '<div class="card">' + sumTable(aggregate(done)) + '</div>', { fold: true });
      $('bOut').innerHTML = h + '</div></div>';
      spy();
    }

    function render() { renderCols(); renderFix(); renderOut(); inFold(); }
    function inFold() {                                      // 결과가 나오면 ① ② ③을 한 줄로 접는다(Q190) — 못 읽은 성능 표기가 있으면 ③은 펼친 채
      var has = rows.some(function (r) { return r.R; }), fold = has && V.inOpen !== true, bar = $('bInBar');
      var blocking = rows.some(function (r) { return r.cond.unknown.length; });
      $('bIn').hidden = fold;
      $('bCols').hidden = fold;
      $('bFix').hidden = fold && !blocking;
      var fb = $('bInFold');
      if (fb) fb.hidden = !has;
      if (!bar) return;
      bar.hidden = !fold;
      if (!fold) return;
      var cols = T.roles.filter(Boolean).map(function (r) { return ROLE_NAME[r]; }), chk = rows.filter(needsCheck).length + rows.filter(function (r) { return !r.R; }).length;
      bar.innerHTML = '<span><b>' + rows.length + '대</b> 붙여 넣음 · 열 ' + cols.length + '개(' + esc(cols.slice(0, 4).join(' · ') + (cols.length > 4 ? ' …' : '')) + ')' +
        (chk ? ' · <span class="v2-warnt">확인할 것 ' + chk + '</span>' : '') + '</span><button type="button" class="v2-btn" data-b="inOpen">입력 펼치기 ▾</button>';
    }

    function formCopy(b) {                                   // 양식 복사 → 엑셀 빈 시트 A1에 붙이면 열로 나뉜다
      var tsv = formTSV(), msg = $('bFormMsg');
      var done = function () {
        if (msg) msg.textContent = '복사했습니다 — 엑셀 빈 시트 A1에 붙여 넣고(Ctrl+V) 차량을 채운 뒤, 머리글째로 복사해 아래에 붙여 넣으세요';
        var t = b.textContent; b.textContent = '복사됨'; setTimeout(function () { b.textContent = t; }, 1600);
      };
      var fallback = function () {                           // 클립보드 권한이 없을 때
        var ta = document.createElement('textarea'); ta.value = tsv; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); done(); } catch (e) { if (msg) msg.textContent = '복사하지 못했습니다 — 양식 엑셀 ↓ 로 받으세요'; }
        document.body.removeChild(ta);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(tsv).then(done, fallback); else fallback();
    }
    function formXlsx() {                                    // 양식 엑셀: 목록(머리글 + 예시 2대) · 작성 방법
      XlsxWriter.download('묶음산정_양식.xlsx', [
        { name: '목록', rows: [FORM.map(function (f) { return f[0]; })].concat(FORM_ROWS), header: true, widths: [12, 34, 12, 12, 10, 26, 10, 12] },
        { name: '작성 방법', rows: [['열', '필요', '쓰는 법 · 예']].concat(FORM).concat([[], ['붙여 넣기', '', '목록 시트에서 머리글 행부터 마지막 차까지 골라 복사(Ctrl+C) → 묶음 산정 칸에 붙여 넣기(Ctrl+V) → 산정하기'],
          ['한 번에', '', LIMIT + '대까지'], ['예시 2대', '', '지우고 쓰세요']]), header: true, widths: [12, 14, 70] }]);
    }

    // ───── 엑셀 ─────
    function exportAll() {
      var nc = T.roles.length, head = T.header ? T.table[0].slice() : T.roles.map(function (_, c) { return colName(c) + '열'; });
      var calc = ['산정_제조사', '산정_모델', '산정_세부모델', '산정_등급', '산정_세부등급', '차명 확신', '산정_최초등록', '산정_주행(km)', '성능 상태(읽은 결과)',
        '사고 단계', '이력 감가(%)', '무사고 시세(만원)', '수리필요 수리비(만원)', '직접 입력 수리비(만원)', '추정 시세(만원)', '범위 하한(만원)', '범위 상한(만원)',
        '환산 비율(%)', '환산가 사고 감가(%)', '환산가(만원)', '환산 비율 출처', '신뢰도', '비교 매물(대)', '매칭 단계', '계산 안 된 이유', '한 대 산정 주소'];
      var vs = verify(), hasAsk = rows.some(function (r) { return r.ask != null; });
      if (vs) calc = calc.concat(['실제 낙찰가(만원)', '환산가 오차(%)', '실제 환산 비율(%)']);
      if (hasAsk) calc = calc.concat(['판매 가격(만원)', '시세 대비(만원)', '시세 대비(%)', '판정']);
      calc = calc.concat(['출고가(만원)', '잔존율(%)']);
      var CONF = { high: '확실', mid: '확인 권장', low: '확인 필요', fixed: '직접 고름', none: '못 찾음' };
      var base = location.href.split('#')[0], out = [head.concat(calc)];
      rows.forEach(function (r) {
        var c = r.c, R = r.R, cond = (r.cond.unknown.length ? '못 읽음: ' + r.cond.unknown.join(', ') : r.cond.state === '미상' ? '미상' : (r.cond.items.length ? ISC.summary(r.cond.items) : '무사고')) +
          (r.cond.outside && r.cond.outside.length ? ' (계산 제외: ' + r.cond.outside.join(', ') + ')' : '');
        var why = r.why.concat(yearOut(r) ? ['합계 제외 — 등록 ' + r.reg.y + '이 모델 기간 ' + r.best.y0 + '~' + r.best.y1 + ' 밖(차명 확인)'] : []);
        var line = r.cells.slice(0, nc).concat([r.best ? r.best.maker : null, r.best ? r.best.group : null, r.best ? r.best.model : null, r.grade || null, r.trim || null,
          CONF[r.conf] || r.conf, r.reg ? r.reg.y + '-' + pad(r.reg.m) + (r.reg.guess ? '(월 미상)' : '') : null, r.km, cond,
          c && c['상태'] !== '미상' ? c['사고라벨'] : null, R ? Math.round(R.D * 1000) / 10 : null, R ? Math.round(R.base) : null,
          R ? R.repairAuto || null : null, r.cost || null,
          R ? Math.round(R.price) : null, R ? Math.round(R.range[0]) : null, R ? Math.round(R.range[1]) : null, R ? R.rate : null,
          R ? Math.round((R.convD || 0) * 1000) / 10 : null, R ? Math.round(R.converted) : null,
          R ? R.rateSource : null, R ? R.grade : null, R ? R.n : null, R ? R.stepName : null, why.join(' · ') || null, R ? base + link(r) : null]);
        if (vs) line.push(r.actual != null ? r.actual : null, R && r.actual != null ? +((R.converted - r.actual) / r.actual * 100).toFixed(1) : null,
          R && r.actual != null ? +((1 - (r.actual + (r.cost || 0)) / R.est) * 100).toFixed(1) : null);
        if (hasAsk) { var vd = verdict(r); line.push(r.ask != null ? r.ask : null, vd ? Math.round(vd.d) : null, vd ? +vd.p.toFixed(1) : null, vd ? vd.label : null); }
        line.push(R && r.fp ? Math.round(r.fp.op) : null, R && r.fp ? Math.round(R.est / r.fp.op * 1000) / 10 : null);
        out.push(line);
      });
      if (T.over) (T.header ? T.table.slice(1) : T.table).slice(LIMIT).forEach(function (cells) {
        var line = cells.slice(0, nc);
        while (line.length < nc + calc.length) line.push(null);
        line[nc + calc.indexOf('계산 안 된 이유')] = LIMIT + '대 초과 — 나눠서 다시 붙여 주세요';
        out.push(line);
      });
      var money = ['산정_주행(km)', '추정 시세(만원)', '범위 하한(만원)', '범위 상한(만원)', '환산가(만원)', '실제 낙찰가(만원)']
        .filter(function (k) { return calc.indexOf(k) >= 0; }).map(function (k) { return nc + calc.indexOf(k); });
      var cmp = [['행', '차량', '유사도', '매물ID', '상태', '판매 확인일', '최초등록', '주행(km)', '색상', '등급', '세부등급', '이력 감가(%)', '사고 라벨',
        '손상 부위', '호가(만원)', '보정 후(만원)', '이상치', '매물 링크']];
      rows.forEach(function (r) {
        if (!r.R) return;
        var G = GROUPS[r.best.file], F = G.F, fi = G.fi, who = (r.plate ? r.plate + ' ' : '') + r.best.model + ' ' + r.grade;
        r.R.comps.forEach(function (x) {
          var row = x.row, reg = String(row[fi.reg]), sold = row[fi.sold] === 1;
          cmp.push([r.no, who, x.sim, row[fi.id], sold ? '판매' : '판매중', sold ? row[fi.sd] : null, reg.slice(0, 4) + '-' + reg.slice(4, 6), row[fi.km],
            F.colors[row[fi.col]], F.grades[row[fi.g]], F.trims[row[fi.t]] || null, x.D != null ? Math.round(x.D * 1000) / 10 : null, F.labels[row[fi.acc]],
            ENG.damage(G, row).join(' · ') || null, row[fi.price], Math.round(x.adj),
            x.outlier ? '예' : null, 'https://fem.encar.com/cars/detail/' + row[fi.id]]);
        });
      });
      var done = rows.filter(function (r) { return r.R; }), sum = function (f) { return Math.round(done.filter(counted).reduce(function (s, r) { return s + f(r.R); }, 0)); };
      var ag = aggregate(done), B = function (t) { return { v: t, bold: true }; }, mw = function (v) { return { v: Math.round(v), money: true }; };
      var sumRows = [[B('차급별 — 합계에 넣는 차만' + (ag.off ? '(차명 확인 ' + ag.off + '대 제외)' : ''))],
        ['차급', '대수', '신뢰도 A', '신뢰도 B', '신뢰도 C', '추정 시세 합계(만원)', '환산가 합계(만원)', '평균 환산 비율(%)'].map(B)];
      ag.order.forEach(function (sg) { var b = ag.by[sg]; sumRows.push([sg, b.n, b.A, b.B, b.C, mw(b.p), mw(b.c), b.e ? +(b.er / b.e).toFixed(1) : null]); });
      sumRows.push([B('합계'), ag.tot.n, ag.tot.A, ag.tot.B, ag.tot.C, mw(ag.tot.p), mw(ag.tot.c), ag.tot.e ? +(ag.tot.er / ag.tot.e).toFixed(1) : null],
        [], [B('신뢰도별')], ['신뢰도', '대수', '추정 시세 합계(만원)', '환산가 합계(만원)', '추정 시세 비중(%)'].map(B));
      GRADES.forEach(function (g) { var b = ag.gr[g]; if (b) sumRows.push([g, b.n, mw(b.p), mw(b.c), ag.tot.p ? +(b.p / ag.tot.p * 100).toFixed(1) : null]); });
      sumRows.push([], ['평균 환산 비율 = 추정 시세로 가중한 환산 비율 · 신뢰도 A = 비교 매물 10대 이상, 조건을 거의 넓히지 않음, 범위 ±8% 안 · ' +
        'B = 조건을 조금 넓힘 · C = 같은 세부모델 전체로 넓힌 참고값']);
      var mi = X.mi.crawls || [];
      var info = [['항목', '값'], ['붙여넣은 차', rows.length + T.over], ['산정한 차', done.length], ['계산 안 된 차', rows.length + T.over - done.length],
        ['추정 시세 합계(만원)', { v: sum(function (R) { return R.price; }), money: true }], ['환산가 합계(만원)', { v: sum(function (R) { return R.converted; }), money: true }],
        ['신뢰도 C(대)', done.filter(function (r) { return r.R.grade === 'C'; }).length],
        ['데이터 기준', '온라인 매물 목록 ' + (mi.length ? mi[mi.length - 1].date : '')], ['비교 매물 파일', X.idx.version], ['보정 계수', X.coef.version], ['환산 비율', RatesStore.label(X.rates)],
        ['비교 범위', '판매중 + 최근 3개월 판매'],
        ['열 지정', T.roles.map(function (role, c) { return role ? colName(c) + '=' + ROLE_NAME[role] : null; }).filter(Boolean).join(', ')],
        ['차명 확신', '확실 · 확인 권장 · 확인 필요 · 직접 고름 · 못 찾음 — 확인 권장·필요는 결과 시트에서 산정_세부모델을 확인하세요'],
        ['최초등록', '연식만 있으면 그해 6월 등록으로 계산'], ['성능 상태', '빈칸은 상태 미상(성능 보정 없이 계산). 못 읽은 표기가 있으면 계산하지 않음. ' +
          '범퍼·램프·유리·휠·타이어처럼 성능점검 대상이 아닌 부위는 계산에서 뺌'],
        ['합계', '등록연도가 매칭한 모델 기간(±1년) 밖인 차는 차명을 확인할 때까지 합계에서 뺌'],
        ['수리비', '단위 없이 1만 이상이면 원으로 보고 만원으로 바꿈. 추정 시세·환산가에서 그대로 뺌'],
        ['참고', '추정 시세는 온라인 소매 호가 기준. 환산가는 팀 환산 비율(도·소매 갭 요약치)을 적용한 값']];
      if (vs) info.push(['실제 건 비교', vs.n + '대 · 오차 중위(절댓값) ' + vs.mdape.toFixed(1) + '% · 치우침 ' + sgn(vs.bias) + ' · ±10% 안 ' + Math.round(vs.within * 100) + '%'],
        ['실제로 구한 환산 비율', '중위 ' + vs.imp.toFixed(1) + '% (지금 쓰는 비율 중위 ' + vs.used.toFixed(1) + '%) — 실제 비율 = 1 − (낙찰가 + 수리비) ÷ 수리비 빼기 전 추정 시세']);
      var widths = head.map(function () { return 14; }).concat([10, 12, 20, 18, 14, 10, 12, 11, 30, 12, 8, 10, 10, 10, 10, 12, 12, 12, 10, 12, 16, 7, 9, 22, 24, 40], vs ? [14, 12, 14] : [],
        hasAsk ? [14, 14, 12, 12] : [], [12, 10]);
      var G = groupList(), gRows = [['제조사', '세부모델', '대수', '계산', '추정 시세 합계(만원)', '환산가 합계(만원)', '평균 시세(만원)', '가장 싼(만원)', '가장 비싼(만원)', '평균 최초등록', '평균 주행(km)']];
      G.forEach(function (g) {
        var n = g.done.length;
        gRows.push([g.maker || null, g.model, g.rows.length, n, n ? { v: Math.round(g.sumP), money: true } : null, n ? { v: Math.round(g.sumC), money: true } : null,
          n ? { v: Math.round(g.avgP), money: true } : null, n ? { v: Math.round(g.lo), money: true } : null, n ? { v: Math.round(g.hi), money: true } : null,
          n ? avgReg(g.avgM) : null, n ? { v: Math.round(g.avgKm), money: true } : null]);
      });
      var cars = cmpCars(), cmpSheetRows = null;
      if (cars.length) {
        cmpSheetRows = [['항목'].concat(cars.map(function (r) { return (r.plate ? r.plate + ' ' : '') + r.best.model + ' ' + r.grade + (r.trim ? ' ' + r.trim : '') + (V.ref === r.no ? ' ★기준' : ''); }))];
        var last = '';
        cmpData(G, cars, true).forEach(function (row) {
          if (row.sec !== last) { last = row.sec; cmpSheetRows.push([{ v: row.sec, bold: true }]); }
          cmpSheetRows.push([row.name].concat(row.vals.map(function (x) { return x[0]; })));
        });
      }
      XlsxWriter.download(ctx.fileSafe('묶음산정_' + ctx.today()) + '.xlsx', [
        { name: '결과', rows: out, header: true, freeze: true, money: money, widths: widths },
        { name: '요약', rows: sumRows, widths: [34, 8, 10, 10, 10, 20, 20, 18] },
        { name: '모델별', rows: gRows, header: true, freeze: true, widths: [12, 30, 7, 7, 18, 18, 15, 13, 13, 13, 14] }]
        .concat(cmpSheetRows ? [{ name: '나란히 비교', rows: cmpSheetRows, header: true, widths: [22].concat(cars.map(function () { return 30; })) }] : []).concat([
        { name: '비교 매물', rows: cmp, header: true, freeze: true, money: [7, 14, 15], widths: [6, 30, 7, 11, 7, 11, 9, 10, 9, 18, 14, 8, 12, 34, 10, 11, 7, 42] },
        { name: '산정 기준', rows: info, header: true, widths: [22, 90] }]));
    }

    // ───── 예시 목록(실제 비교 매물에서 고른 차) ─────
    function sample() {
      var picks = [], plates = ['12가3456', '345나6789', '45하1234', '27머8810', '159더2471', '61보5302', '38호9124', '210로3388', '73수4415', '16우7720'];
      X.idx.makers.slice(0, 6).forEach(function (mk) {
        mk.groups.slice().sort(function (a, b) { return b.n - a.n; }).slice(0, mk === X.idx.makers[0] ? 3 : 1).forEach(function (g) { picks.push(g); });
      });
      picks = picks.slice(0, 8);
      progress('예시 목록을 만드는 중…');
      loadGroups(picks.map(function (g) { return g.file; })).then(function () {
        var conds = ['무사고', '', '좌프론트휀더 X', '본넷 W, 우프론트도어 X', '좌휀다X', '트렁크 교환', '', '루프 판금'];
        var colors = ['흰색', '검정', '쥐색', '진주색', '블루', '', '화이트', '은색'], costs = ['', '', '30', '', '150,000', '', '', ''];
        var lines = [['차량번호', '차명', '최초등록', '주행거리', '색상', '성능 상태', '수리비'].join('\t')];
        picks.forEach(function (g, k) {
          var G = GROUPS[g.file], fi = G.fi, M = G.F.models.slice().sort(function (a, b) { return b.n - a.n; })[0];
          var on = G.F.rows.filter(function (r) { return r[fi.m] === G.models[M.name].idx && r[fi.sold] === 0; });
          if (!on.length) return;
          var r = on[Math.floor(on.length / 2)], grade = G.F.grades[r[fi.g]], trim = G.F.trims[r[fi.t]] || '', reg = String(r[fi.reg]);
          var name = M.name + ' ' + grade + (trim ? ' ' + trim : '');
          if (k === 1) name = name.replace(/\s+/g, '');                                  // 띄어쓰기 없이
          if (k === 2) name = name.replace(/^(디\s*올\s*뉴|더\s*올\s*뉴|올\s*뉴|더\s*뉴|뉴)\s*/, '');   // 세대 접두어 없이
          if (k === 6) name = g.name + ' ' + grade;                                      // 모델그룹 이름 + 등급만(확신 낮음)
          var regTxt = [reg.slice(0, 4) + '-' + reg.slice(4, 6), reg.slice(0, 4) + '.' + reg.slice(4, 6), reg.slice(0, 4) + '년 ' + (+reg.slice(4, 6)) + '월',
            reg.slice(0, 4), reg.slice(2, 4) + '.' + reg.slice(4, 6)][k % 5];
          var km = Math.round(r[fi.km] / 100) * 100, kmTxt = [km.toLocaleString('ko-KR'), (km / 1e4).toFixed(1) + '만', km + 'km'][k % 3];
          lines.push([plates[k], name, regTxt, kmTxt, colors[k], conds[k], costs[k]].join('\t'));
        });
        $('bPaste').value = lines.join('\n');
        run();
      }).catch(function (e) { progress('예시를 만들지 못했습니다: ' + esc(e.message)); });
    }

    // ───── 이벤트 ─────
    function onClick(e) {
      var bs = e.target.closest('[data-bs]');
      if (bs) { focusRow(bs.getAttribute('data-bs')); return; }
      var go = e.target.closest('[data-bgo]');
      if (go) { goSec(go.getAttribute('data-bgo')); return; }
      var rowEl = e.target.closest('.bt-row');                 // 줄을 누르면 그 자리에서 펼침(입력 칸 · 단추 · 링크는 그대로)
      if (rowEl && !e.target.closest('input, select, a, button, label, .fix')) { var rn = +rowEl.getAttribute('data-row'); V.openR[rn] = !V.openR[rn]; renderOut(); return; }
      var b = e.target.closest('button[data-b]');
      if (!b) return;
      var a = b.getAttribute('data-b'), k = +b.getAttribute('data-k');
      if (a === 'formCopy') { formCopy(b); return; }
      if (a === 'formXlsx') { formXlsx(); return; }
      var bv = b.getAttribute('data-v');
      if (a === 'g') { V.openG[bv] = !V.openG[bv]; renderOut(); return; }
      if (a === 'open') { V.openR[+bv] = !V.openR[+bv]; renderOut(); return; }
      if (a === 'sort') { V.sort = bv; renderOut(); return; }
      if (a === 'grp') { V.group = bv === '1'; renderOut(); return; }
      if (a === 'ref') { V.ref = V.ref === +bv ? null : +bv; renderOut(); return; }
      if (a === 'cmp') { cmpToggle(+bv, V.cmp.indexOf(+bv) < 0); return; }
      if (a === 'cmpClear') { V.cmp = []; renderOut(); return; }
      if (a === 'cmpSheet') { cmpSheet(); return; }
      if (a === 'segFold') { V.segOpen = !V.segOpen; renderOut(); return; }
      if (a === 'inOpen') { V.inOpen = true; inFold(); return; }
      if (a === 'inFold') { V.inOpen = false; inFold(); var o = $('bOut'); if (o) o.scrollIntoView({ block: 'start' }); return; }
      if (a === 'run') { run(); if (window.CT) CT.ev('batch', 'run', rows.length); }   // 이용 통계: 사용자가 누른 산정만(예시·저장본 복원은 안 셈) · 대수
      else if (a === 'sample') sample();
      else if (a === 'clear') { $('bPaste').value = ''; run(); }
      else if (a === 'xlsx') exportAll();
      else if (a === 'forget') { FIX = { name: {}, grade: {}, cond: {} }; save('fix', null); process(); }
      else if (a === 'tokPick' || a === 'gPick') {
        var tx = (a === 'tokPick' ? T.unk : T.gss || [])[k], tk2 = tx != null ? tokOf(tx) : null, cand = tk2 && tk2.cands[+b.getAttribute('data-c')];
        if (!cand) return;
        if (cand.save && ctx.terms && ctx.terms.writable() && !TS.list.some(function (x) { return x.t === cand.save.t; })) TS.list.push(cand.save);
        TS.msg = '';
        setCond(tx, cand.label);
      }
      else if (a === 'termSkip') { TS.list = []; TS.msg = ''; renderFix(); }
      else if (a === 'termSave') {
        var by2 = ($('bTermBy').value || '').trim(), pw2 = $('bTermPw').value;
        if (!by2) { $('bTermMsg').textContent = '이름을 넣어 주세요'; $('bTermBy').focus(); return; }
        $('bTermMsg').textContent = '저장하는 중…';
        ctx.terms.save(TS.list.slice(), by2, pw2).then(function () {
          TS.msg = '팀 사전에 넣었습니다(' + TS.list.length + '개) — 다음부터 팀 모두가 자동으로 읽습니다';
          TS.list = [];
          renderFix();
        }).catch(function (e2) { var m = $('bTermMsg'); if (m) m.textContent = e2.message || '저장하지 못했습니다'; });
      }
      else if (a === 'tokFix' || a === 'tokSkip') {
        var tok = T.unk && T.unk[k], inp = el.querySelector('input[data-tok="' + k + '"]');
        if (tok == null) return;
        if (a === 'tokFix' && !(inp && inp.value.trim())) { if (inp) inp.focus(); return; }
        setCond(tok, a === 'tokSkip' ? '' : inp.value.trim());
      }
    }
    function onChange(e) {
      var t = e.target, v;
      if (t.getAttribute('data-b') === 'header') { T.header = t.checked; process(); return; }
      if (t.getAttribute('data-b') === 'only') { onlyCheck = t.checked; renderOut(); return; }
      if ((v = t.getAttribute('data-cmp')) != null) { cmpToggle(+v, t.checked); return; }
      if ((v = t.getAttribute('data-role')) != null) {
        var role = t.value, c = +v;
        if (role && TEXT_ROLES.indexOf(role) < 0) T.roles = T.roles.map(function (x, j) { return x === role && j !== c ? '' : x; });   // 한 열만
        T.roles[c] = role;
        process();
        return;
      }
      if ((v = t.getAttribute('data-model')) != null) {
        var r = rows[+v];
        if (t.value === 'other') { r.other = true; renderOut(); var inp = el.querySelector('input[data-other="' + v + '"]'); if (inp) inp.focus(); return; }
        if (t.value !== '') setModel(+v, r.mc[+t.value]);
        return;
      }
      if ((v = t.getAttribute('data-grade')) != null) { setGrade(+v, t.value); return; }
      if ((v = t.getAttribute('data-other')) != null) {
        var it = byName[t.value];
        if (it) { rows[+v].other = false; setModel(+v, it); }
      }
    }

    // 한 대 산정 [묶음에 추가](기획안 6장): 지금 붙여넣은 표의 열 구성에 맞춰 한 줄을 덧붙인다. 비어 있으면 기본 머리글로 시작
    var STD = ['차명', '최초등록', '주행거리', '색상', '성능 상태', '수리비', '렌트'];
    function carLine(c) {                                    // c = { name, reg(YYYY-MM), year, km, color, cond, cost, rent } → 지금 묶음 글·열에 맞춘 한 줄
      var text = el ? $('bPaste').value : ((load('draft') || {}).text || '');
      var table = parseTSV(text);
      if (!table.length) { text = STD.join('\t'); table = [STD.slice()]; }
      var det = detect(table), d = load('draft');
      var roles = d && d.text === text && d.roles && d.roles.length === det.roles.length ? d.roles : det.roles;
      var header = d && d.text === text && d.roles ? d.header : det.header;
      var val = { name: c.name, reg: c.reg, year: c.year, km: c.km, color: c.color, cond: c.cond, cost: c.cost, rent: c.rent ? '렌트' : '' };
      var used = {}, cells = roles.map(function (r) {
        if (!r || used[r]) return '';                         // 같은 쓰임의 둘째 열(예: 제조사·등급으로 나뉜 차명)은 비운다
        used[r] = true;
        return val[r] == null ? '' : val[r];
      });
      if (!used.name && roles.indexOf('grade') >= 0) cells[roles.indexOf('grade')] = c.name;
      return { text: text, roles: roles, header: header, line: cells.map(function (v) { return String(v).replace(/[\t\r\n]+/g, ' '); }).join('\t') };
    }
    function hasCar(c) {                                     // 같은 차(같은 줄)가 이미 묶음에 있나
      var x = carLine(c);
      return x.text.split(/\r?\n/).indexOf(x.line) >= 0;
    }
    function addCar(c) {                                     // → { n: 묶음 대수, dup: 이미 있어서 더하지 않음 }
      var x = carLine(c), dup = x.text.split(/\r?\n/).indexOf(x.line) >= 0, text = dup ? x.text : x.text.replace(/\s+$/, '') + '\n' + x.line;
      if (!dup) {
        if (el) { $('bPaste').value = text; run(); }
        else save('draft', { text: text, roles: x.roles, header: x.header });
      }
      return { n: parseTSV(text).length - (x.header ? 1 : 0), dup: dup };
    }

    function show(container) {
      if (el !== container) {
        el = container;
        frame();
        var d = load('draft');
        if (d && d.text) { $('bPaste').value = d.text; run(); }
      }
    }
    return { show: show, addCar: addCar, hasCar: hasCar, parseTSV: parseTSV, detect: detect };
  }

  var api = { create: create, parseTSV: parseTSV, pullFromText: pullFromText, formTSV: formTSV, kmOf: kmOf, costOf: costOf, priceOf: priceOf, regOf: regOf, yearOf: yearOf, colorOf: colorOf, rentOf: rentOf };
  root.V2Batch = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
