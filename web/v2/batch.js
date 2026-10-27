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
    ['year', '연식'], ['reg', '최초등록'], ['km', '주행거리'], ['color', '색상'], ['cond', '성능 상태'], ['cost', '수리비'], ['rent', '렌트']];
  var ROLE_NAME = {};
  ROLES.forEach(function (r) { ROLE_NAME[r[0]] = r[1]; });
  var TEXT_ROLES = ['maker', 'name', 'grade', 'fuel'];       // 여러 열이면 이 순서로 이어 붙여 차명 매칭에 쓴다
  var SKIP_HEAD = /가격|금액|시세|호가|매입|낙찰|판매가|희망가|비고|메모|^no\.?$|^번호$|순번|^#$/i;
  var HEAD = [['plate', /차량\s*번호|차번|번호판|등록\s*번호/], ['cost', /수리\s*비|정비\s*비|예상\s*수리/],
    ['cond', /성능|상태|사고|기록부|수리\s*내역|외판/], ['reg', /최초\s*등록|등록\s*(일|연월|년월)|출고/],
    ['year', /연식|년식|연형|연도|년도/], ['km', /주행|km|키로|㎞/i], ['color', /색상|컬러|색/],
    ['maker', /제조사|메이커|브랜드|제작사/], ['grade', /등급|트림|사양/], ['fuel', /연료|유종/], ['rent', /렌트|용도/],
    ['name', /차명|차종|모델|차량/]];

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
    var m = s.match(/^(\d+(?:\.\d+)?)만$/), x = m ? parseFloat(m[1]) * 1e4 : (/^\d+(\.\d+)?$/.test(s) ? Number(s) : NaN);
    return isFinite(x) && x >= 0 && x < 2e6 ? Math.round(x) : null;
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
    return null;
  }
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
  function keyOf(t) { return String(t || '').toUpperCase().replace(/[^0-9A-Z가-힣.]/g, ''); }   // 같은 표기 = 띄어쓰기·기호만 다른 것
  function load(k) { try { return JSON.parse(localStorage.getItem(STORE + k) || 'null'); } catch (e) { return null; } }
  function save(k, v) { try { if (v == null) localStorage.removeItem(STORE + k); else localStorage.setItem(STORE + k, JSON.stringify(v)); } catch (e) { /* 저장 못 해도 계산은 된다 */ } }
  function colName(c) { var s = ''; c++; while (c > 0) { var m = (c - 1) % 26; s = String.fromCharCode(65 + m) + s; c = Math.floor((c - 1) / 26); } return s; }

  function create(ctx) {
    var X = ctx.X, ENG = ctx.ENG, ISC = ctx.ISC, GROUPS = ctx.GROUPS, esc = ctx.esc, man = ctx.man, pad = ctx.pad;
    var NM = NameMatch.create(X.idx), el = null, token = 0, onlyCheck = false;
    var T = { text: '', table: [], header: false, roles: [], over: 0 };
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
      if (!h) return null;
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
      return { header: header, roles: roles };
    }

    // ───── 행 만들기 · 맞추기 · 산정 ─────
    function makeRow(cells, no) {
      var r = { no: no, cells: cells }, by = {};
      T.roles.forEach(function (role, c) { if (role && cells[c]) (by[role] = by[role] || []).push(cells[c]); });
      function one(k) { return by[k] ? by[k][0] : ''; }
      r.plate = one('plate');
      r.text = TEXT_ROLES.map(function (k) { return (by[k] || []).join(' '); }).join(' ').replace(/\s+/g, ' ').trim();
      r.key = keyOf(r.text);
      var y = yearOf(one('year')) || yearOf(one('reg'));
      r.reg = regOf(one('reg')) || (y ? { y: y, m: 6, guess: true } : null);   // 연식만 있으면 6월로
      r.km = kmOf(one('km'));
      r.color = colorOf(one('color'));
      r.cost = costOf(one('cost'));
      r.rent = rentOf(r.plate, one('rent'));
      r.condRaw = one('cond');
      readCond(r);
      return r;
    }
    function readCond(r) {                                   // 고친 표기를 먼저 바꿔 넣고 읽는다
      var s = String(r.condRaw || '');
      if (s.normalize) s = s.normalize('NFKC');
      s = s.replace(/:/g, ' ');
      Object.keys(FIX.cond).forEach(function (tok) { if (s.indexOf(tok) >= 0) s = s.split(tok).join(FIX.cond[tok]); });
      r.cond = ISC.parseText(s);
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
        '색상계열': r.color || null, '렌트': r.rent, '성능': c['상태'] === '미상' ? null : { '감가율': c['성능감가율'], '등급': c['성능등급'] },
        '수리비': r.cost || 0, '연료': fuelOf(G, r.best.model, r.grade) };
      r.R = ENG.estimateCar(G, r.car, { sold: true });
      if (!r.R) r.why.push('비교 매물 5대 미만');
    }
    function needsCheck(r) { return !!r.best && ((r.conf === 'mid' || r.conf === 'low') || r.gconf === 'low'); }

    function run() {
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
      }).catch(function (e) { progress('비교 매물 파일을 불러오지 못했습니다: ' + esc(e && e.message || e)); });
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
    function progress(msg) { $('bOut').innerHTML = '<div class="card"><div class="v2-kv" style="margin:0"><span class="spinner v2-spin"></span>' + msg + '</div></div>'; }
    function frame() {
      el.innerHTML = '<div class="card"><div class="card-title">① 엑셀에서 차량 목록을 복사해 붙여넣으세요 <span class="hint">머리글 행째로 · 한 번에 ' + LIMIT + '대까지</span></div>' +
        '<textarea class="v2-in v2-paste" id="bPaste" spellcheck="false" wrap="off" aria-label="차량 목록 붙여넣기" placeholder="차량번호&#9;차명&#9;최초등록&#9;주행거리&#9;색상&#9;성능 상태&#10;12가3456&#9;투싼 (NX4) 1.6T 인스퍼레이션&#9;2022-03&#9;38,200&#9;흰색&#9;좌프론트휀더 X"></textarea>' +
        '<div class="v2-actions"><button type="button" class="v2-btn primary" data-b="run">산정하기</button>' +
        '<button type="button" class="v2-btn" data-b="sample">예시 목록 넣기</button><button type="button" class="v2-btn" data-b="clear">지우기</button></div>' +
        '<p class="v2-help">꼭 있어야 하는 열: 차명(모델·등급), 최초등록 또는 연식, 주행거리. 있으면 더 정확해지는 열: 색상, 성능 상태(예: 좌프론트휀더 X, 본넷 W — 빈칸이면 상태 미상), ' +
        '수리비(만원), 차량번호(하·허·호는 렌트로 봅니다). 붙여넣은 글과 고친 표기는 이 브라우저에만 남습니다.</p></div>' +
        '<div id="bCols"></div><div id="bFix"></div><div id="bOut"></div>' +
        '<datalist id="bModels">' + MODELS.map(function (m) { return '<option value="' + esc(m.label) + '"></option>'; }).join('') + '</datalist>';
      el.addEventListener('click', onClick);
      el.addEventListener('change', onChange);
      $('bPaste').addEventListener('paste', function () { setTimeout(run, 0); });
    }

    function renderCols() {
      if (!T.table.length) { $('bCols').innerHTML = ''; return; }
      var nc = T.roles.length, head = T.header ? T.table[0] : null, data = (T.header ? T.table.slice(1) : T.table).slice(0, 3);
      var h = '<div class="card"><div class="v2-tools"><div class="card-title">② 열 확인 <span class="hint">자동으로 알아본 열 · 틀리면 고르세요</span></div>' +
        '<label class="v2-chk" style="margin:0"><input type="checkbox" data-b="header"' + (T.header ? ' checked' : '') + '> 첫 줄은 머리글</label></div>' +
        '<div class="v2-tablewrap"><table class="t v2-tbl v2-ctbl"><thead><tr>';
      for (var c = 0; c < nc; c++) {
        h += '<th><select class="v2-csel" data-role="' + c + '" aria-label="' + colName(c) + '열의 쓰임">' + ROLES.map(function (o) {
          return '<option value="' + o[0] + '"' + (T.roles[c] === o[0] ? ' selected' : '') + '>' + o[1] + '</option>';
        }).join('') + '</select><div class="v2-ch">' + colName(c) + (head ? ' · ' + esc(head[c]) : '') + '</div></th>';
      }
      h += '</tr></thead><tbody>' + data.map(function (r) {
        return '<tr>' + r.map(function (v, c) { return '<td class="' + (T.roles[c] ? '' : 'v2-dim') + '">' + esc(v) + '</td>'; }).join('') + '</tr>';
      }).join('') + '</tbody></table></div>';
      var miss = [];
      if (!T.roles.some(function (r) { return r === 'name' || r === 'grade'; })) miss.push('차명');
      if (T.roles.indexOf('reg') < 0 && T.roles.indexOf('year') < 0) miss.push('최초등록 또는 연식');
      if (T.roles.indexOf('km') < 0) miss.push('주행거리');
      if (miss.length) h += '<p class="v2-help v2-bad">꼭 필요한 열이 없습니다: ' + miss.join(', ') + ' — 위에서 열의 쓰임을 골라 주세요.</p>';
      if (T.over) h += '<p class="v2-help v2-bad">' + LIMIT + '대까지만 계산합니다. 나머지 ' + T.over + '대는 나눠서 붙여 주세요.</p>';
      $('bCols').innerHTML = h + '</div>';
    }

    function renderFix() {
      var unk = {}, order = [];
      rows.forEach(function (r) {
        r.cond.unknown.forEach(function (t) { if (!unk[t]) { unk[t] = 0; order.push(t); } unk[t]++; });
      });
      var low = rows.filter(needsCheck).length, none = rows.filter(function (r) { return r.text && !r.best; }).length;
      var guess = rows.filter(function (r) { return r.reg && r.reg.guess; }).length;
      var missKm = rows.filter(function (r) { return r.km == null; }).length, missReg = rows.filter(function (r) { return !r.reg; }).length;
      var remembered = Object.keys(FIX.name).length + Object.keys(FIX.grade).length + Object.keys(FIX.cond).length;
      if (!order.length && !low && !none && !guess && !missKm && !missReg && !remembered) { $('bFix').innerHTML = ''; return; }
      var h = '<div class="card"><div class="card-title">③ 확인할 것 <span class="hint">같은 표기는 한 번 고치면 모두 적용됩니다</span></div>';
      if (order.length) {
        h += '<div class="v2-sub">못 읽은 성능 표기 ' + order.length + '가지 — 고치기 전에는 그 차를 계산하지 않습니다</div><div class="v2-fixes">';
        order.forEach(function (t, k) {
          h += '<div class="v2-fixrow"><span class="v2-tok">' + esc(t) + '</span><span class="v2-dim">' + unk[t] + '대</span>' +
            '<input class="v2-in" data-tok="' + k + '" autocomplete="off" placeholder="바르게 고쳐 쓰기 (예: 좌프론트휀더 X)">' +
            '<button type="button" class="v2-btn" data-b="tokFix" data-k="' + k + '">적용</button>' +
            '<button type="button" class="v2-btn" data-b="tokSkip" data-k="' + k + '">무시하고 계산</button></div>';
        });
        h += '</div><p class="v2-help">쓸 수 있는 표기: 부위(프론트 휀더·도어·후드·트렁크·쿼터·루프·필러…) + 좌·우 + 상태(X 교환 · W 판금 · 용접 · 절단 · U 요철 · T 손상 · C 부식 · A 흠집). ' +
          '여러 부위는 쉼표로 나눕니다.</p>';
        T.unk = order;
      }
      var notes = [];
      if (low) notes.push('차명 확신이 낮은 차 <b>' + low + '대</b> — 아래 표의 노란 칸에서 맞는 모델·등급을 고르세요');
      if (none) notes.push('차명을 찾지 못한 차 <b>' + none + '대</b> — 빨간 칸에서 "다른 모델 찾기"로 고르세요');
      if (missReg) notes.push('최초등록·연식이 없는 차 <b>' + missReg + '대</b>');
      if (missKm) notes.push('주행거리가 없는 차 <b>' + missKm + '대</b>');
      if (guess) notes.push('연식만 있어 <b>6월</b> 등록으로 계산한 차 <b>' + guess + '대</b>(표에 * 표시)');
      if (notes.length) h += '<ul class="v2-notes">' + notes.map(function (n) { return '<li>' + n + '</li>'; }).join('') + '</ul>';
      if (remembered) h += '<p class="v2-help">이 브라우저에 기억한 고침: 차명 ' + Object.keys(FIX.name).length + ' · 등급 ' + Object.keys(FIX.grade).length +
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
      if (c.state === '무사고' && !c.items.length) return '무사고';
      return '<span title="' + esc(ISC.summary(c.items)) + '">' + esc(r.c['사고라벨']) + ' · ' + r.c['성능등급'] + '등급</span>';
    }
    function link(r) {
      return ctx.href({ mk: r.best.maker, grp: r.best.group, model: r.best.model, grade: r.grade, trim: r.trim, y: String(r.reg.y), m: String(r.reg.m),
        km: String(r.km), color: r.color, cost: r.cost ? String(r.cost) : '', rent: r.rent,
        cond: r.cond.state === '미상' ? '미상' : (r.cond.items.length ? '입력' : '무사고'), items: r.cond.items });
    }
    function eok(v) { v = Math.round(v); return v >= 1e4 ? Math.floor(v / 1e4) + '억 ' + man(v % 1e4) : man(v); }

    function rowHtml(r, i) {                                 // 한 행 = 차(번호판·붙여넣은 글) · 매칭(세부모델/등급) · 등록·주행 · 성능 · 결과
      var warnM = r.conf === 'mid' || r.conf === 'low';
      var h = '<tr class="' + (r.R ? '' : 'is-skip') + '"><td class="num v2-dim">' + r.no + '</td>';
      h += '<td class="v2-car">' + (r.plate ? '<b>' + esc(r.plate) + '</b>' + (r.rent ? ' <span class="v2-rent">렌트</span>' : '') + '<br>' : '') +
        '<span class="v2-src">' + esc(r.text || '—') + '</span></td>';
      h += '<td class="v2-match"><div class="' + (!r.best ? 'v2-cbad' : warnM ? 'v2-cwarn' : '') + '">' + modelCell(r, i) + '</div>' +
        (r.best ? '<div class="' + (r.gconf === 'low' ? 'v2-cwarn' : '') + '">' + gradeCell(r, i) + '</div>' : '') + '</td>';
      h += '<td>' + (r.reg ? r.reg.y + '-' + pad(r.reg.m) + (r.reg.guess ? '<sup title="월을 몰라 6월로 계산">*</sup>' : '') : '<span class="v2-bad">등록 없음</span>') +
        '<br>' + (r.km != null ? (r.km / 1e4).toFixed(1) + '만km' : '<span class="v2-bad">주행 없음</span>') + '</td>';
      h += '<td class="v2-cond">' + condCell(r) + '</td>';
      if (r.R) {
        h += '<td class="num"><b class="v2-amt">' + man(r.R.price) + '</b><br><span class="v2-dim">' + man(r.R.range[0]) + '~' + man(r.R.range[1]) + '</span></td>' +
          '<td class="num"><b class="v2-amt">' + man(r.R.converted) + '</b><br><span class="v2-dim">' + r.R.rate + '%</span></td>' +
          '<td><span class="v2-gb ' + r.R.grade + '">' + r.R.grade + '</span> <span class="v2-dim">' + r.R.n + '대</span></td>' +
          '<td><a href="' + esc(link(r)) + '" target="_blank" rel="noopener">열기 ↗</a></td>';
      } else h += '<td colspan="4" class="v2-bad">' + esc(r.why.join(' · ')) + '</td>';
      return h + '</tr>';
    }

    function renderOut() {
      if (!rows.length) { $('bOut').innerHTML = ''; return; }
      var done = rows.filter(function (r) { return r.R; }), sumP = 0, sumC = 0, cN = 0;
      done.forEach(function (r) { sumP += r.R.price; sumC += r.R.converted; if (r.R.grade === 'C') cN++; });
      var chk = rows.filter(needsCheck).length, skip = rows.length - done.length;
      var h = '<div class="card v2-headcard"><div class="v2-head">④ 결과 · ' + rows.length + '대<br><span class="sub">추정 시세는 엔카 호가 기준 · 환산가는 팀 환산 비율 적용 · ' +
        '"열기"는 그 차의 한 대 산정 화면(근거·비교 매물)</span></div><div class="v2-actions" style="margin:0">' +
        '<label class="v2-chk" style="margin:0"><input type="checkbox" data-b="only"' + (onlyCheck ? ' checked' : '') + '> 확인할 차만 보기</label>' +
        '<button type="button" class="v2-btn primary" data-b="xlsx"' + (done.length ? '' : ' disabled') + '>엑셀 내려받기</button></div></div>';
      h += '<div class="v2-cards v2-bcards">' +
        ctx.tile('산정', String(done.length), '대', skip ? '계산 안 됨 ' + skip + '대 · 이유는 표에' : '전부 계산됨') +
        ctx.tile('추정 시세 합계', man(sumP), '만원', eok(sumP) + '만 · 엔카 호가 기준 · 수리비 반영') +
        ctx.tile('환산가 합계', man(sumC), '만원', eok(sumC) + '만 · 팀 환산 비율 적용') +
        ctx.tile('확인할 차', String(chk + skip), '대', '신뢰도 C ' + cN + '대 · 차명 확인 ' + chk + '대') + '</div>';
      var shown = rows.map(function (r, i) { return [r, i]; }).filter(function (x) { return !onlyCheck || !x[0].R || needsCheck(x[0]) || x[0].R.grade === 'C'; });
      h += '<div class="card"><div class="v2-tablewrap"><table class="t v2-tbl v2-btbl"><thead><tr><th class="num">행</th>' +
        '<th>차(붙여넣은 글)</th><th>매칭 — 세부모델 / 등급·세부등급</th><th>등록 · 주행</th><th>성능</th>' +
        '<th class="num">추정 시세 · 범위</th><th class="num">환산가 · 비율</th><th>신뢰도 · 비교</th><th></th></tr></thead><tbody>' +
        shown.map(function (x) { return rowHtml(x[0], x[1]); }).join('') + '</tbody></table></div>' +
        (shown.length ? '' : '<p class="v2-kv">확인할 차가 없습니다.</p>') +
        '<p class="v2-help">노란 칸 = 확신이 낮은 매칭(맞는지 확인) · 빨간 칸 = 찾지 못함 · ✓ = 직접 고름 · 금액은 만원. 신뢰도 C는 같은 세부모델 전체로 넓혀 찾은 참고값입니다.</p></div>';
      $('bOut').innerHTML = h;
    }
    function render() { renderCols(); renderFix(); renderOut(); }

    // ───── 엑셀 ─────
    function exportAll() {
      var nc = T.roles.length, head = T.header ? T.table[0].slice() : T.roles.map(function (_, c) { return colName(c) + '열'; });
      var calc = ['산정_제조사', '산정_모델', '산정_세부모델', '산정_등급', '산정_세부등급', '차명 확신', '산정_최초등록', '산정_주행(km)', '성능 상태(읽은 결과)',
        '사고 라벨', '성능등급', '성능감가율(%)', '글로비스 종합', '글로비스 사고평가', '수리비(만원)', '추정 시세(만원)', '범위 하한(만원)', '범위 상한(만원)',
        '환산 비율(%)', '환산가(만원)', '환산 비율 출처', '신뢰도', '비교 매물(대)', '매칭 단계', '계산 안 된 이유', '한 대 산정 주소'];
      var CONF = { high: '확실', mid: '확인 권장', low: '확인 필요', fixed: '직접 고름', none: '못 찾음' };
      var base = location.href.split('#')[0], out = [head.concat(calc)];
      rows.forEach(function (r) {
        var c = r.c, R = r.R, cond = r.cond.unknown.length ? '못 읽음: ' + r.cond.unknown.join(', ') : r.cond.state === '미상' ? '미상' : (r.cond.items.length ? ISC.summary(r.cond.items) : '무사고');
        out.push(r.cells.slice(0, nc).concat([r.best ? r.best.maker : null, r.best ? r.best.group : null, r.best ? r.best.model : null, r.grade || null, r.trim || null,
          CONF[r.conf] || r.conf, r.reg ? r.reg.y + '-' + pad(r.reg.m) + (r.reg.guess ? '(월 미상)' : '') : null, r.km, cond,
          c && c['상태'] !== '미상' ? c['사고라벨'] : null, c && c['상태'] !== '미상' ? c['성능등급'] : null, c && c['상태'] !== '미상' ? c['성능감가율'] : null,
          c && c['상태'] !== '미상' ? c['글로비스_종합평가점'] : null, c && c['상태'] !== '미상' ? c['글로비스_사고평가점'] : null, r.cost || null,
          R ? Math.round(R.price) : null, R ? Math.round(R.range[0]) : null, R ? Math.round(R.range[1]) : null, R ? R.rate : null, R ? Math.round(R.converted) : null,
          R ? R.rateSource : null, R ? R.grade : null, R ? R.n : null, R ? R.stepName : null, r.why.join(' · ') || null, R ? base + link(r) : null]));
      });
      if (T.over) (T.header ? T.table.slice(1) : T.table).slice(LIMIT).forEach(function (cells) {
        var line = cells.slice(0, nc);
        while (line.length < nc + calc.length) line.push(null);
        line[nc + calc.indexOf('계산 안 된 이유')] = LIMIT + '대 초과 — 나눠서 다시 붙여 주세요';
        out.push(line);
      });
      var money = ['산정_주행(km)', '추정 시세(만원)', '범위 하한(만원)', '범위 상한(만원)', '환산가(만원)'].map(function (k) { return nc + calc.indexOf(k); });
      var cmp = [['행', '차량', '유사도', '매물ID', '상태', '판매 확인일', '최초등록', '주행(km)', '색상', '등급', '세부등급', '성능등급', '사고 라벨',
        '손상 부위', '호가(만원)', '보정 후(만원)', '이상치', '엔카 링크']];
      rows.forEach(function (r) {
        if (!r.R) return;
        var G = GROUPS[r.best.file], F = G.F, fi = G.fi, who = (r.plate ? r.plate + ' ' : '') + r.best.model + ' ' + r.grade;
        r.R.comps.forEach(function (x) {
          var row = x.row, reg = String(row[fi.reg]), sold = row[fi.sold] === 1;
          cmp.push([r.no, who, x.sim, row[fi.id], sold ? '판매' : '판매중', sold ? row[fi.sd] : null, reg.slice(0, 4) + '-' + reg.slice(4, 6), row[fi.km],
            F.colors[row[fi.col]], F.grades[row[fi.g]], F.trims[row[fi.t]] || null, row[fi.perf], F.labels[row[fi.acc]],
            ENG.damage(G, row).join(' · ') || null, row[fi.price], Math.round(x.adj),
            x.outlier ? '예' : null, 'https://fem.encar.com/cars/detail/' + row[fi.id]]);
        });
      });
      var done = rows.filter(function (r) { return r.R; }), sum = function (f) { return Math.round(done.reduce(function (s, r) { return s + f(r.R); }, 0)); };
      var mi = X.mi.crawls || [];
      var info = [['항목', '값'], ['붙여넣은 차', rows.length + T.over], ['산정한 차', done.length], ['계산 안 된 차', rows.length + T.over - done.length],
        ['추정 시세 합계(만원)', { v: sum(function (R) { return R.price; }), money: true }], ['환산가 합계(만원)', { v: sum(function (R) { return R.converted; }), money: true }],
        ['신뢰도 C(대)', done.filter(function (r) { return r.R.grade === 'C'; }).length],
        ['데이터 기준', '엔카 목록 ' + (mi.length ? mi[mi.length - 1].date : '')], ['비교 매물 파일', X.idx.version], ['보정 계수', X.coef.version], ['환산 비율', RatesStore.label(X.rates)],
        ['비교 범위', '판매중 + 최근 3개월 판매'],
        ['열 지정', T.roles.map(function (role, c) { return role ? colName(c) + '=' + ROLE_NAME[role] : null; }).filter(Boolean).join(', ')],
        ['차명 확신', '확실 · 확인 권장 · 확인 필요 · 직접 고름 · 못 찾음 — 확인 권장·필요는 결과 시트에서 산정_세부모델을 확인하세요'],
        ['최초등록', '연식만 있으면 그해 6월 등록으로 계산'], ['성능 상태', '빈칸은 상태 미상(성능 보정 없이 계산). 못 읽은 표기가 있으면 계산하지 않음'],
        ['수리비', '단위 없이 1만 이상이면 원으로 보고 만원으로 바꿈. 추정 시세·환산가에서 그대로 뺌'],
        ['참고', '추정 시세는 엔카 호가 기준. 환산가는 팀 환산 비율(도·소매 갭 요약치)을 적용한 값']];
      var widths = head.map(function () { return 14; }).concat([10, 12, 20, 18, 14, 10, 12, 11, 30, 12, 8, 10, 10, 10, 10, 12, 12, 12, 10, 12, 16, 7, 9, 22, 24, 40]);
      XlsxWriter.download(ctx.fileSafe('묶음산정_' + ctx.today()) + '.xlsx', [
        { name: '결과', rows: out, header: true, freeze: true, money: money, widths: widths },
        { name: '비교 매물', rows: cmp, header: true, freeze: true, money: [7, 14, 15], widths: [6, 30, 7, 11, 7, 11, 9, 10, 9, 18, 14, 8, 12, 34, 10, 11, 7, 42] },
        { name: '산정 기준', rows: info, header: true, widths: [22, 90] }]);
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
      var b = e.target.closest('button[data-b]');
      if (!b) return;
      var a = b.getAttribute('data-b'), k = +b.getAttribute('data-k');
      if (a === 'run') run();
      else if (a === 'sample') sample();
      else if (a === 'clear') { $('bPaste').value = ''; run(); }
      else if (a === 'xlsx') exportAll();
      else if (a === 'forget') { FIX = { name: {}, grade: {}, cond: {} }; save('fix', null); process(); }
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
    function addCar(c) {                                     // c = { name, reg(YYYY-MM), year, km, color, cond, cost, rent } → 묶음 대수
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
      text = text.replace(/\s+$/, '') + '\n' + cells.map(function (v) { return String(v).replace(/[\t\r\n]+/g, ' '); }).join('\t');
      if (el) { $('bPaste').value = text; run(); }
      else save('draft', { text: text, roles: roles, header: header });
      return parseTSV(text).length - (header ? 1 : 0);
    }

    function show(container) {
      if (el !== container) {
        el = container;
        frame();
        var d = load('draft');
        if (d && d.text) { $('bPaste').value = d.text; run(); }
      }
    }
    return { show: show, addCar: addCar, parseTSV: parseTSV, detect: detect };
  }

  var api = { create: create, parseTSV: parseTSV, kmOf: kmOf, costOf: costOf, regOf: regOf, yearOf: yearOf, colorOf: colorOf, rentOf: rentOf };
  root.V2Batch = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
