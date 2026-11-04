/*
 * inspection_score.js — 성능 상태 계산기 (사이트용)
 *
 * 성능·상태점검기록부 입력(부위 37곳 × 상태 7가지), 엑셀 '성능 상태' 한 칸, 성능점검 원문을 받아
 * 파이프라인(prep.py · inspection_score.py)과 같은 규칙으로 계산한다.
 *   → 사고 단계·라벨, 단계별 교환·판금 수, 글로비스 감점합·종합평가점·사고평가점, 자체 성능감가율·점수·등급
 * 규칙·가중치는 /data/inspection_model.json 하나에서 읽는다(inspection_score.py 가 내보냄. 직접 고치지 말 것).
 * 파이프라인과 같은 값인지는 python inspection_parity.py 로 검증한다.
 *
 *   var calc = InspectionScore.create(model);
 *   calc.evaluate({ state: '입력', items: [{ part: '프론트 휀더', side: '좌', status: '교환' }] });
 *   calc.evaluate(calc.parseText('좌프론트휀더 X, 우쿼터 W'));
 *   calc.evaluate(calc.fromRaw(outerPanelText, mainFrameText));
 *
 * state: '입력'(부위 입력) / '무사고'(이상 없음을 직접 고름) / '미상'(입력 안 함 — 무사고로 치지 않는다)
 * item:  { part: 부위 이름, side: '좌'|'우'|null, pillar: '앞'|'중간'|'뒤'|null, status: 교환·용접절단·판금·요철·손상·부식·흠집 }
 */
(function (root) {
  'use strict';

  var SEVERITY = ['교환', '용접절단', '판금', '요철', '손상', '부식', '흠집'];   // 한 부위에 여러 상태면 앞쪽(더 심한 것)
  var COUNT_COLS = ['외판1_교환수', '외판1_판금수', '외판2_교환수', '외판2_판금수', '골격_교환수', '골격_판금수'];
  var RESULT_COLS = COUNT_COLS.concat(['용접절단여부', '경미손상수', '손상부위', '단순수리', '단순수리_자동', '결함단계',
    '글로비스_감점합', '글로비스_종합평가점', '글로비스_사고평가점', '성능감가율', '성능점검점수', '성능등급']);
  var SYMBOL_OF = { 교환: 'X', 판금: 'W', 용접절단: '절단', 요철: 'U', 손상: 'T', 부식: 'C', 흠집: 'A' };

  function compact(s) { return String(s).replace(/\s+/g, '').toUpperCase(); }
  function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function spacedRe(c, flags) { return new RegExp(c.split('').map(escapeRe).join('\\s*'), flags); }   // 글자 사이 띄어쓰기 허용
  // numpy np.round 와 같은 반올림(정확히 .5 이면 짝수 쪽)
  function rint(y) { var f = Math.floor(y), d = y - f; return d > 0.5 ? f + 1 : d < 0.5 ? f : (f % 2 === 0 ? f : f + 1); }
  function round(x, n) { var m = Math.pow(10, n); return rint(x * m) / m; }

  function create(model) {
    var parts = model.parts, generic = model.generic_parts || {};
    var kindOf = model.status_kind, gl = model.glovis, sc = model.score, P = model.parser;
    var rawRules = model.raw_status_rules.map(function (r) { return [new RegExp(r[0]), r[1]]; });
    var accOf = {};   // 글로비스 부위 → 사고평가 그룹(B·C·D·F)
    Object.keys(gl.acc).forEach(function (k) {
      gl.acc[k].forEach(function (p) { (accOf[p] = accOf[p] || []).push(k); });
    });

    function info(part) { return parts[part] || (generic[part] ? parts[generic[part]] : null); }
    function itemLabel(it) { return it.part + (it.pillar ? '(' + it.pillar + ')' : '') + (it.side ? '(' + it.side + ')' : ''); }

    // ── 성능점검 원문 (outer_panel · main_frame) — inspection_score.parse_items 와 같음 ──
    function rawStatus(stat) {
      for (var i = 0; i < rawRules.length; i++) if (rawRules[i][0].test(stat)) return rawRules[i][1];
      return '기타';
    }

    function fromRaw(outer, frame) {
      var items = [];
      [outer, frame].forEach(function (txt) {
        if (txt == null || txt === '') return;
        String(txt).split(' | ').forEach(function (it) {
          var i = it.indexOf(':');
          if (i < 0) return;
          var label = it.slice(0, i);
          var item = { part: label.replace(/\(.*?\)/g, '').trim(), side: null, pillar: null, status: rawStatus(it.slice(i + 1)) };
          (label.match(/\(.*?\)/g) || []).forEach(function (t) {
            t = t.slice(1, -1);
            if (t === '좌' || t === '우') item.side = t;
            else if (t === '앞' || t === '중간' || t === '뒤') item.pillar = t;
          });
          items.push(item);
        });
      });
      return { state: '입력', items: items };
    }

    // ── 계산 — prep.classify_damage · inspection_score.glovis_eval · score_features · apply_score 와 같음 ──
    function autoSimpleRepair(items) {   // 외판(1·2랭크)에 교환·판금·용접절단이 있으면 단순수리 있음
      return (items || []).some(function (it) {
        var inf = info(it.part), k = kindOf[it.status];
        return !!inf && (inf.rank === '외판1' || inf.rank === '외판2') && (k === '교환' || k === '용접절단' || k === '판금');
      });
    }

    function blank(state, extra) {
      var o = { 상태: state, 점검여부: false, 사고단계: null, 사고라벨: state === '미상' ? '미상' : null };
      RESULT_COLS.forEach(function (c) { o[c] = null; });
      for (var k in extra) o[k] = extra[k];
      return o;
    }

    function evaluate(input) {
      input = input || {};
      if (input.unknown && input.unknown.length) return blank('확인 필요', { 확인필요: input.unknown.slice() });
      var state = input.state || ((input.items && input.items.length) ? '입력' : '미상');
      if (state === '미상') return blank('미상');
      var items = state === '무사고' ? [] : (input.items || []);
      var o = { 상태: state, 점검여부: true };

      // ① 사고 단계·라벨 — 교환·판금·용접절단이 있는 부위 중 가장 높은 등급 + 그 등급의 교환 여부
      var cnt = {}, lv = 0, serious = [], weld = false, minor = 0, labels = [];
      COUNT_COLS.forEach(function (c) { cnt[c] = 0; });
      items.forEach(function (it) {
        var inf = info(it.part), rank = inf ? inf.rank : '미분류', kind = kindOf[it.status] || '기타';
        if (kind === '기타') return;
        labels.push(it.part + '(' + kind + ')');
        if (kind === '용접절단') weld = true;
        if (kind === '경미') { minor++; return; }
        var k2 = kind === '교환' ? '교환' : '판금', l = model.rank_level[rank] || 0;
        if (inf) cnt[rank + '_' + k2 + '수']++;
        serious.push([l, k2]);
        if (l > lv) lv = l;
      });
      var topExch = serious.filter(function (s) { return s[0] === lv && s[1] === '교환'; }).length;
      o.사고단계 = lv;
      o.사고라벨 = lv === 0 ? '무사고' : model.level_name[lv] + '·' + (topExch > 0 ? '교환' : '판금');
      COUNT_COLS.forEach(function (c) { o[c] = cnt[c]; });
      o.용접절단여부 = weld;
      o.경미손상수 = minor;
      o.손상부위 = labels.length ? labels.join(' / ') : null;

      // ② 글로비스 감점합·종합평가점·사고평가점(주요골격 교환만)
      var pts = 0, n = { B: 0, C: 0, D: 0, F: 0 };
      items.forEach(function (it) {
        var inf = info(it.part), gp = inf ? inf.glovis : null, row = gp ? gl.table[gp] : null;
        if (gp && (it.status === '교환' || it.status === '용접절단')) (accOf[gp] || []).forEach(function (k) { n[k]++; });
        if (!row) return;
        var cols = gl.status_cols[it.status] || [];
        for (var i = 0; i < cols.length; i++) if (row[cols[i]] != null) { pts += row[cols[i]]; break; }
      });
      var grade = 1;
      for (var j = 0; j < gl.grade_bins.length; j++) if (pts <= gl.grade_bins[j][0]) { grade = gl.grade_bins[j][1]; break; }
      o.글로비스_감점합 = pts;
      o.글로비스_종합평가점 = grade;
      o.글로비스_사고평가점 = (n.F >= 1 || n.D >= 2) ? 'F' : (n.D === 1 || n.C >= 2) ? 'D'
        : (n.C === 1 || n.B >= 2) ? 'C' : n.B === 1 ? 'B' : 'A';

      // ③ 자체 성능감가율·점수·등급 — 부위 그룹 × 상태 개수(상한) · 용접절단 · 단순수리 · 기계 결함
      var x = {}, weld2 = false;
      items.forEach(function (it) {
        var inf = info(it.part), grp = inf ? inf.group : null, k = sc.status_k[it.status];
        if (!grp || !k) return;
        var key = grp + '|' + k;
        x[key] = Math.min((x[key] || 0) + 1, sc.cap);
        if (it.status === '용접절단') weld2 = true;
      });
      var simple = input.simpleRepair, auto = simple !== true && simple !== false;
      if (auto) simple = autoSimpleRepair(items);
      var mech = input.mechLevel;
      x['용접절단'] = weld2 ? 1 : 0;
      x['단순수리'] = simple ? 1 : 0;
      x['결함_경미'] = mech === 1 ? 1 : 0;
      x['결함_결함'] = mech === 2 ? 1 : 0;
      var loss = 0;
      sc.columns.forEach(function (c) { loss = loss + (x[c] || 0) * (sc.coef[c] || 0); });   // 파이프라인과 같은 순서로 더함
      var rate = (1 - Math.exp(loss)) * 100;
      var score = Math.min(100, Math.max(0, 100 - rate * sc.points_per_pct));
      var cut = 0;
      sc.grade_cuts.forEach(function (c) { if (rate >= c) cut++; });
      o.단순수리 = !!simple;
      o.단순수리_자동 = auto;
      o.결함단계 = (mech === 0 || mech === 1 || mech === 2) ? mech : null;
      o.성능감가율 = round(rate, 2);
      o.성능점검점수 = round(score, 1);
      o.성능등급 = 9 - cut;
      return o;
    }

    // ── 글 읽기 — 기록부 메모 · 엑셀 '성능 상태' 한 칸 (기획 v2.31 5.14, 인터뷰 Q198~Q212) ──
    //  ① 소리 맞추기: 외래어 표기가 흔들리는 자모를 한 소리로 모은 글자로 비교한다(펜터·헨다·팬더 → 펜더, 스탭 → 스텝, 은전석 → 운전석).
    //     한 글자를 한 글자로 바꾸므로 원문과 자리가 같다. 한 글자 낱말(좌·우·앞·교·판·휀…)과 영문 기호(X·W·FL…)는 원문 그대로 비교한다.
    //  ② 사전 낱말로 글자를 다 덮으면 끝. 남는 글자가 있으면 ③ 가장 가까운 낱말로 짐작한다(글자 단위 편집 거리 — 자모가 다른 만큼 1/3씩).
    //     짐작한 조각은 결과(tokens)에 보여 주고, 그래도 못 읽은 조각은 후보(가까운 부위·상태)를 돌려준다.
    var LV = [0, 0, 2, 3, 3, 5, 6, 17, 17, 9, 9, 11, 12, 12, 12, 0, 3, 17, 17];             // 초성: ㄱㄲㅋ · ㄷㄸㅌ · ㅂㅃㅍㅎ · ㅅㅆ · ㅈㅉㅊ
    var VV = [4, 5, 4, 5, 4, 5, 4, 5, 8, 4, 5, 5, 8, 13, 4, 5, 16, 13, 13, 20, 20];        // 중성: ㅏㅑㅓㅕㅘㅝ · ㅐㅒㅔㅖㅙㅚㅞ · ㅗㅛ · ㅜㅠㅡ · ㅣㅢ · ㅟ
    var TV = [0, 1, 1, 1, 4, 4, 4, 19, 8, 8, 8, 8, 8, 8, 8, 8, 16, 17, 17, 19, 19, 21, 19, 19, 1, 19, 17, 19];   // 종성: 소리 나는 7갈래
    function canonChar(ch) {
      var c = ch.charCodeAt(0) - 0xAC00;
      if (c < 0 || c > 11171) return ch;
      return String.fromCharCode(0xAC00 + (LV[Math.floor(c / 588)] * 21 + VV[Math.floor(c % 588 / 28)]) * 28 + TV[c % 28]);
    }
    function canon(s) { var o = ''; for (var i = 0; i < s.length; i++) o += canonChar(s.charAt(i)); return o; }
    function jamo(ch) { var c = ch.charCodeAt(0) - 0xAC00; return c < 0 || c > 11171 ? ch : [Math.floor(c / 588), Math.floor(c % 588 / 28), c % 28]; }
    function isLatin(ch) { return ch >= 'A' && ch <= 'Z'; }
    function isLetter(ch) { return /[A-Zㄱ-ㆎ가-힣]/.test(ch); }       // 못 읽음을 가르는 글자(숫자는 '헤드램프2'처럼 건너뛰어도 된다)
    function skipCost(ch) { return isLetter(ch) ? SKIP : /[0-9]/.test(ch) ? 0.2 : 0; }

    var TYPE_RANK = { part: 0, outside: 1, status: 2, paint: 3, pos: 4, side: 5, dir: 6, both: 7, bothdir: 8, ignore: 9 };
    function lexEntry(w, type, extra) {
      var o = compact(w);
      if (!o) return null;
      var e = { w: w, o: o, c: canon(o), n: o.length, type: type, latin: /^[A-Z]+$/.test(o) };
      e.exact = e.latin || o.length === 1;                     // 한 글자 · 영문 기호는 원문 그대로만
      e.k = e.c.split('').map(jamo);
      for (var x in extra) e[x] = extra[x];
      e.mean = type + '|' + (e.part || e.status || e.side || e.dir || '') + '|' + (e.pillar || '') + '|' + (type === 'pos' ? e.side : '');
      return e;
    }
    function sortLex(list) {                                   // 긴 낱말 먼저, 같은 길이면 부위 → 상태 → 위치 순(정렬은 안정적)
      var seen = {};
      return list.filter(function (e) {
        var key = (e.exact ? 'o:' + e.o : 'c:' + e.c) + '|' + e.mean;
        if (seen[key]) return false;
        return (seen[key] = true);
      }).sort(function (a, b) { return b.n - a.n || TYPE_RANK[a.type] - TYPE_RANK[b.type]; });
    }
    var BASE = [];
    function add(w, type, extra) { var e = lexEntry(w, type, extra); if (e) BASE.push(e); }
    Object.keys(P.part_aliases).forEach(function (part) { P.part_aliases[part].forEach(function (a) { add(a, 'part', { part: part }); }); });
    Object.keys(P.pillar_aliases).forEach(function (a) { add(a, 'part', { part: '필러 패널', pillar: P.pillar_aliases[a] }); });
    (P.outside_parts || []).forEach(function (a) { add(a, 'outside'); });
    Object.keys(P.status_words).forEach(function (w) { add(w, 'status', { status: P.status_words[w] }); });
    Object.keys(P.status_symbols).forEach(function (w) { add(w, 'status', { status: P.status_symbols[w], sym: true }); });
    (P.paint_words || []).forEach(function (w) { add(w, 'paint'); });
    Object.keys(P.side_words).forEach(function (w) { add(w, 'side', { side: P.side_words[w] }); });
    Object.keys(P.pos_words || {}).forEach(function (w) { add(w, 'pos', { dir: P.pos_words[w][0], side: P.pos_words[w][1] }); });
    Object.keys(P.direction_words).forEach(function (w) { add(w, 'dir', { dir: P.direction_words[w] }); });
    P.both_words.forEach(function (w) { add(w, 'both'); });
    (P.bothdir_words || []).forEach(function (w) { add(w, 'bothdir'); });
    P.ignore_words.forEach(function (w) { add(w, 'ignore'); });
    P.no_damage_cell.forEach(function (w) { if (compact(w).length > 1) add(w, 'ignore'); });   // '본넷 교환 외 이상없음'
    BASE = sortLex(BASE);

    // 팀 표기 사전(사이트 저장소) — { t: 표기, kind: part|status|outside|ignore|paint, part, side, pillar, status }. 같은 길이면 기본 사전보다 먼저
    var termCache = { src: null, lex: BASE };
    function lexFor(terms) {
      if (!terms || !terms.length) return BASE;
      if (termCache.src === terms) return termCache.lex;
      var extra = [];
      terms.forEach(function (t) {
        var e = null;
        if (!t || !t.t) return;
        if (t.kind === 'part' && (parts[t.part] || generic[t.part])) e = lexEntry(t.t, 'part', { part: t.part, side: t.side || null, pillar: t.pillar || null, team: true });
        else if (t.kind === 'status' && kindOf[t.status]) e = lexEntry(t.t, 'status', { status: t.status, team: true });
        else if (t.kind === 'outside' || t.kind === 'ignore' || t.kind === 'paint') e = lexEntry(t.t, t.kind, { team: true });
        if (e) extra.push(e);
      });
      termCache = { src: terms, lex: sortLex(extra.concat(BASE)) };
      return termCache.lex;
    }

    var POS_KEY = {};                                          // 기록부 37곳(부위|좌우|필러 위치)
    model.positions.forEach(function (p) { POS_KEY[p.part + '|' + (p.side || '') + '|' + (p.pillar || '')] = true; });
    function wordSet(list) { var s = {}; list.forEach(function (w) { s[compact(w)] = true; }); return s; }
    var UNKNOWN_CELL = wordSet(P.unknown_cell), NO_DAMAGE = wordSet(P.no_damage_cell);

    // 조각 하나 → 원문 압축(O) · 소리 맞춘 압축(C) · 띄어쓰기 자리(brk) · 개수
    function prepTok(tok) {
      var s = ' ' + tok.replace(/[()[\]{}<>]/g, ' ') + ' ', count = 1;
      var cm = s.match(/(\d+)\s*(개|곳|짝|EA)/i) || s.match(/[×*]\s*(\d+)/);
      if (cm) { count = parseInt(cm[1], 10); s = s.replace(cm[0], ' '); }
      var O = '', brk = [], gap = true;
      for (var i = 0; i < s.length; i++) {
        var ch = s.charAt(i);
        if (/\s/.test(ch)) { gap = true; continue; }
        brk.push(gap);
        gap = false;
        O += ch.toUpperCase();
      }
      brk.push(true);
      return { O: O, C: canon(O), brk: brk, count: count, sy: canon(O).split('').map(jamo) };
    }
    function edge(p, i, j, sym) {                              // 영문 기호는 다른 영문자와 붙어 있으면 안 읽는다(LHX = LH X 가 아니면).
      if ((i === 0 || p.brk[i] || !isLatin(p.O.charAt(i - 1))) && (j === p.O.length || p.brk[j] || !isLatin(p.O.charAt(j)))) return true;
      if (!sym) return false;                                  // 상태 기호만 붙은 묶음(WC = 판금 + 부식)은 하나씩
      var a = i, b = j;
      while (a > 0 && !p.brk[a] && isLatin(p.O.charAt(a - 1))) a--;
      while (b < p.O.length && !p.brk[b] && isLatin(p.O.charAt(b))) b++;
      return /^[XWUTCA]+$/.test(p.O.slice(a, b));
    }

    // ② 사전 낱말로 나누기 — 글자를 건너뛰면 1. fz(짐작)이면 가까운 낱말도: 2글자 0.34 · 3글자 0.67 · 4글자 이상 1까지
    //    (자모가 다르면 초성 0.5 · 중성·종성 0.34). 같은 값이면 원문 철자 그대로 · 띄어쓴 자리에서 끊긴 것 · 조각 수가 적은 것
    var SKIP = 1, EPS = 0.01, D_CANON = 0.005, D_EDGE = 0.004;
    function maxCost(n) { return n <= 1 ? 0 : n === 2 ? 0.34 : n === 3 ? 0.67 : 1; }
    function subCost(a, b) {
      if (typeof a === 'string' || typeof b === 'string') return a === b ? 0 : 1;
      return (a[0] !== b[0] ? 0.5 : 0) + (a[1] !== b[1] ? 0.34 : 0) + (a[2] !== b[2] ? 0.34 : 0);
    }
    function edit(sy, i, j, k, lim) {                         // sy[i..j) 와 낱말 k 의 편집 거리(넣기·빼기 1) — lim 을 넘으면 Infinity
      var m = k.length, prev = [], cur = [], x, y, t;
      for (y = 0; y <= m; y++) prev[y] = y;
      for (x = 1; x <= j - i; x++) {
        cur[0] = x;
        var low = x;
        for (y = 1; y <= m; y++) {
          cur[y] = Math.min(prev[y] + 1, cur[y - 1] + 1, prev[y - 1] + subCost(sy[i + x - 1], k[y - 1]));
          if (cur[y] < low) low = cur[y];
        }
        if (low > lim) return Infinity;
        t = prev; prev = cur; cur = t;
      }
      return prev[m];
    }
    function costAt(p, e, i, j, lim) {                        // 토막 [i, j) 를 낱말 e 로 읽는 값(못 읽으면 Infinity)
      var len = j - i;
      if (e.exact) return len === e.n && p.O.substr(i, len) === e.o && (!e.latin || edge(p, i, j, e.sym)) ? 0 : Infinity;
      if (len === e.n && p.C.substr(i, len) === e.c) return 0;
      if (lim <= 0 || Math.abs(len - e.n) > 1) return Infinity;
      var c = edit(p.sy, i, j, e.k, lim);
      return c <= lim ? c : Infinity;
    }
    function seg(p, lex, fz, anchors) {                       // anchors: 앞 단계에서 맞은 두 글자 이상 낱말 — 짐작이 그 낱말을 반만 먹지 않게('도어 수리' ≠ 도+어수리)
      var O = p.O, n = O.length, best = [0], back = [null], j, q, len, aid = [];
      function bound(x) { return x === 0 || x === n || p.brk[x]; }
      (anchors || []).forEach(function (a, k) { for (var x = a.i; x < a.j; x++) aid[x] = k; });
      function cuts(i, j2) {
        var a = aid[i] != null ? anchors[aid[i]] : null, b = aid[j2 - 1] != null ? anchors[aid[j2 - 1]] : null;
        return (a && a.i < i) || (b && b.j > j2);
      }
      for (j = 1; j <= n; j++) {
        best[j] = best[j - 1] + skipCost(O.charAt(j - 1));
        back[j] = { i: j - 1, e: null, cost: 0 };
        for (q = 0; q < lex.length; q++) {
          var e = lex[q], lo = !fz || e.exact ? e.n : Math.max(2, e.n - 1), hi = !fz || e.exact ? e.n : e.n + 1;
          for (len = lo; len <= hi; len++) {
            var i = j - len;
            if (i < 0) continue;
            var c = costAt(p, e, i, j, fz ? maxCost(e.n) : 0);
            if (c === Infinity || (c > 0 && anchors && cuts(i, j))) continue;
            var v = best[i] + c + EPS + (!e.exact && O.substr(i, len) !== e.o ? D_CANON : 0) + (bound(i) ? 0 : D_EDGE) + (bound(j) ? 0 : D_EDGE);
            if (v < best[j] - 1e-9) { best[j] = v; back[j] = { i: i, e: e, cost: c }; }
          }
        }
      }
      var segs = [], skipped = [], k = n;
      while (k > 0) {
        var b = back[k];
        if (b.e) segs.unshift({ i: b.i, j: k, e: b.e, cost: b.cost });
        else if (isLetter(O.charAt(k - 1))) skipped.unshift(k - 1);
        k = b.i;
      }
      return { segs: segs, skipped: skipped };
    }
    function rivals(p, lex, i, j, lim, types) {                // 토막 [i, j) 와 가까운 낱말들(뜻마다 가장 가까운 것) — 짐작이 애매한지 · 후보
      var bestOf = {};
      lex.forEach(function (e) {
        if (types.indexOf(e.type) < 0) return;
        var c = e.exact ? costAt(p, e, i, j, 0) : (Math.abs(j - i - e.n) > 2 ? Infinity : edit(p.sy, i, j, e.k, lim));
        if (c > lim) return;
        var m = e.mean;
        if (!bestOf[m] || c < bestOf[m].cost) bestOf[m] = { e: e, cost: c };
      });
      return Object.keys(bestOf).map(function (m) { return bestOf[m]; }).sort(function (a, b) { return a.cost - b.cost || b.e.n - a.e.n; });
    }

    function family(a, b) {                                    // 같은 부위(앞뒤 미상 이름과 앞·뒤 이름 포함)
      function of(x) { return P.generic_dir[x] ? [x, P.generic_dir[x]['앞'], P.generic_dir[x]['뒤']] : [x]; }
      return a === b || of(a).indexOf(b) >= 0 || of(b).indexOf(a) >= 0;
    }
    // 조각 → 부위별 묶음. 좌우·앞뒤·상태를 앞뒤의 부위에 붙인다('좌앞휀다판 우뒤도어교' → 둘, '휀더 좌 도어 우' → 둘)
    function grouping(segs) {
      var out = [], g = { seq: [] };
      function core(s) { var t = s.e.type; return t === 'part' || t === 'outside' || t === 'status' || t === 'paint'; }
      function isMod(s) { var t = s.e.type; return t === 'side' || t === 'dir' || t === 'pos' || t === 'both' || t === 'bothdir'; }
      segs.forEach(function (s) {
        var t = s.e.type, head = null;
        g.seq.forEach(function (x) { if (x.e.type === 'part' || x.e.type === 'outside') head = head || x; });
        if ((t === 'part' || t === 'outside') && head) {
          var last = -1, k;
          for (k = 0; k < g.seq.length; k++) if (core(g.seq[k])) last = k;
          var lastSt = last >= 0 && (g.seq[last].e.type === 'status' || g.seq[last].e.type === 'paint');
          if (t === 'part' && head.e.type === 'part' && family(head.e.part, s.e.part) && !lastSt && last === g.seq.indexOf(head) &&
              !g.seq.slice(last + 1).length) { g.seq.push(s); return; }   // '사이드멤버(프레임)' — 같은 부위 이름 두 번
          var tail = g.seq.slice(last + 1), before = g.seq.slice(0, g.seq.indexOf(head)).some(isMod);
          var move = tail.length && tail.every(function (x) { return isMod(x) || x.e.type === 'ignore'; }) && (lastSt || before);
          if (move) g.seq = g.seq.slice(0, last + 1);
          out.push(g);
          g = { seq: move ? tail : [] };
        }
        g.seq.push(s);
      });
      out.push(g);
      // 부위 없이 좌우·앞뒤만 남은 묶음은 앞 묶음에 붙인다('휀더 판금 좌')
      var res = [];
      out.forEach(function (x) {
        var hasCore = x.seq.some(function (s) { return s.e.type !== 'ignore' && !isMod(s); });
        if (!hasCore && res.length && x.seq.some(isMod)) res[res.length - 1].seq = res[res.length - 1].seq.concat(x.seq);
        else if (x.seq.length) res.push(x);
      });
      return res.map(function (x) {
        var o = { seq: x.seq, part: null, out: null, sts: [], mods: [], paint: false, stFirst: false, ign: [] };
        x.seq.forEach(function (s) {
          var t = s.e.type;
          if (t === 'part') o.part = !o.part || (P.generic_dir[o.part.e.part] && !P.generic_dir[s.e.part]) ? s : o.part;   // '앞사이드멤버(프레임)' → 앞 쪽
          else if (t === 'outside') o.out = o.out || s;
          else if (t === 'status') { o.sts.push(s); if (!o.part && !o.out) o.stFirst = true; }
          else if (t === 'paint') o.paint = true;
          else if (t === 'ignore') o.ign.push(s);
          else o.mods.push(s);
        });
        return o;
      });
    }
    function topStatus(g) {
      var st = g.sts.map(function (s) { return s.e.status; });
      return SEVERITY.filter(function (v) { return st.indexOf(v) >= 0; })[0] || null;
    }

    // 묶음 하나를 부위 목록으로 — 앞뒤로 바뀌는 부위(뒤 휀더 = 쿼터), 좌우로 바뀌는 부위(운전석 뒤패널 = 쿼터(좌)), 좌우 없는 부위는 좌우를 버린다
    function resolve(g, status, count) {
      var e = g.part.e, part = e.part, pillar = e.pillar || null, side = e.side || null, dir = null, both = false, two = false;
      for (var q = 0; q < g.mods.length; q++) {
        var m = g.mods[q].e;
        if (m.type === 'both') both = true;
        else if (m.type === 'bothdir') two = true;
        if (m.side) { if (side && side !== m.side) return { err: '좌우가 둘' }; side = m.side; }
        if (m.dir) { if (dir && dir !== m.dir) return { err: '앞뒤가 둘' }; dir = m.dir; }
      }
      function withDir(d) {
        if (!d) return { part: part, pillar: pillar };
        if (part === '필러 패널') return pillar && pillar !== d ? null : { part: part, pillar: d };
        if (P.generic_dir[part]) return P.generic_dir[part][d] ? { part: P.generic_dir[part][d], pillar: null } : null;
        var rm = P.dir_remap && P.dir_remap[part] && P.dir_remap[part][d];
        if (rm) return { part: rm, pillar: null };
        if (parts[part] && parts[part].dir && parts[part].dir !== d) return null;
        return { part: part, pillar: pillar };                 // 앞뒤가 없는 부위(후드·루프…)는 앞뒤를 버린다
      }
      var targets = (two ? ['앞', '뒤'] : [dir]).map(withDir);
      if (targets.some(function (x) { return !x; })) return { err: '앞뒤가 맞지 않음' };
      var items = [], dropped = false;
      if (both && count > 2) return { err: '개수가 맞지 않음' };
      if (count < 1 || count > 6) return { err: '개수가 맞지 않음' };
      targets.forEach(function (tg) {
        var p2 = tg.part, inf = info(p2), sd = side, bo = both;
        if ((sd || bo) && !(inf && inf.sides)) {
          var rs = P.side_remap && P.side_remap[p2];
          if (rs && info(rs) && info(rs).sides) p2 = rs;
          else { sd = null; bo = false; dropped = true; }
        }
        if (bo) ['좌', '우'].forEach(function (s2) { items.push({ part: p2, side: s2, pillar: tg.pillar, status: status }); });
        else for (var c = 0; c < count; c++) items.push({ part: p2, side: sd, pillar: tg.pillar, status: status });
      });
      return { items: items, dropped: dropped };
    }

    // 조각 하나 읽기(상태 물려받기 전) — 덮기 → 안 되면 짐작
    function readTok(raw, lex) {
      var t = { text: raw, groups: [], header: null, nod: false, guess: [], skipped: [], amb: null, p: null };
      if (NO_DAMAGE[compact(raw)]) { t.nod = true; return t; }
      var p = t.p = prepTok(raw), f = seg(p, lex, false), segs = f.segs;
      if (f.skipped.length) {                                   // 사전 낱말로 다 못 덮으면 짐작까지
        f = seg(p, lex, true, f.segs.filter(function (s) { return s.j - s.i >= 2 && s.e.type !== 'outside'; }));
        segs = f.segs; t.skipped = f.skipped;
        segs.forEach(function (s) {
          if (!(s.cost > 0)) return;
          t.guess.push({ from: p.O.slice(s.i, s.j), to: s.e.w, cost: s.cost });
          var r = rivals(p, lex, s.i, s.j, s.cost + 0.34, ['part', 'outside', 'status', 'side', 'dir', 'pos']);
          if (r.some(function (x) { return x.e.mean !== s.e.mean && x.cost <= s.cost + 0.34 && !(x.e.type === 'part' && s.e.type === 'part' && x.e.part === s.e.part); }) && !t.amb) {
            t.amb = { i: s.i, j: s.j };                         // 비슷하게 가까운 다른 뜻이 있다 — 짐작하지 않고 후보로
          }
        });
      }
      t.segs = segs;
      t.groups = grouping(segs);
      if (!t.skipped.length && !t.amb && t.groups.length && t.groups.every(function (g) { return !g.part && !g.out && !g.mods.length; }) &&
          t.groups.some(function (g) { return g.sts.length; })) {
        t.header = topStatus({ sts: [].concat.apply([], t.groups.map(function (g) { return g.sts; })) });   // '[교환]' · '교환:' 머리
      }
      return t;
    }

    // 못 읽은 조각의 후보 — 남은 글자와 가까운 부위·상태로 바꿔 끼워 다시 읽은 것(최대 4개). save = 팀 사전에 넣을 표기
    function candidates(t, lex, carry) {
      var p = t.p, out = [], seen = {};
      if (!p) return out;
      var span = null;
      if (t.amb) span = t.amb;
      else if (!t.skipped.length && t.segs.some(function (s) { return s.cost > 0; })) {   // 짐작한 조각의 다른 후보('짐작 → 다른 것')
        var gs = t.segs.filter(function (s) { return s.cost > 0; }).sort(function (a, b) { return b.cost - a.cost; })[0];
        span = { i: gs.i, j: gs.j };
      }
      else if (t.skipped.length) {                               // 가장 긴 건너뛴 토막
        var runs = [], st = t.skipped[0], pv = st;
        t.skipped.slice(1).concat([-9]).forEach(function (x) { if (x !== pv + 1) { runs.push({ i: st, j: pv + 1 }); st = x; } pv = x; });
        span = runs.sort(function (a, b) { return (b.j - b.i) - (a.j - a.i); })[0];
        t.segs.forEach(function (s) {
          if (s.e.type !== 'outside' && !(s.cost > 0)) return;
          if (s.j === span.i) span = { i: s.i, j: span.j };
          else if (s.i === span.j) span = { i: span.i, j: s.j };
        });
      }
      function tryWith(segs, save) {
        var g2 = grouping(segs), items = [], ok = true;
        g2.forEach(function (g) {
          if (!ok || (!g.part && !g.out)) return;
          if (g.out) return;
          var stt = topStatus(g) || carry;
          if (!stt) { ok = false; return; }
          var r = resolve(g, stt, p.count);
          if (r.err) ok = false; else items = items.concat(r.items);
        });
        if (!ok || !items.length) return;
        var label = summary(items);
        if (seen[label]) return;
        seen[label] = true;
        out.push({ items: items, label: label, save: save });
      }
      if (span) {
        var others = t.segs.filter(function (s) { return s.j <= span.i || s.i >= span.j; });
        var from = p.O.slice(span.i, span.j), lim = Math.max(1, (span.j - span.i) * 0.5);
        rivals(p, lex, span.i, span.j, lim, ['part', 'status']).slice(0, 6).forEach(function (r) {
          var segs = others.concat([{ i: span.i, j: span.j, e: r.e, cost: r.cost }]).sort(function (a, b) { return a.i - b.i; });
          var save = r.e.type === 'part' ? { t: from, kind: 'part', part: r.e.part, pillar: r.e.pillar || null, side: r.e.side || null } : { t: from, kind: 'status', status: r.e.status };
          if (r.e.type === 'status' || segs.some(function (s) { return s.e.type === 'status'; }) || carry) tryWith(segs, save);
          else ['판금', '교환'].forEach(function (s2) {
            tryWith(segs.concat([{ i: p.O.length, j: p.O.length, e: { type: 'status', status: s2, w: s2, mean: 'status|' + s2 } }]), save);
          });
        });
        if (!t.segs.some(function (s) { return s.e.type === 'status'; }) && !carry) {   // 남은 글자가 상태 말일 수도('도어 수리') → 교환 · 판금 · 손상
          ['교환', '판금', '손상'].forEach(function (s2) {
            var st2 = { type: 'status', status: s2, w: s2, mean: 'status|' + s2 };
            tryWith(others.concat([{ i: span.i, j: span.j, e: st2, cost: 1 }]).sort(function (a, b) { return a.i - b.i; }), { t: from, kind: 'status', status: s2 });
          });
        }
      } else {                                                   // 부위는 읽었는데 상태가 없음 → 교환 · 판금 · 손상(수리필요)
        ['교환', '판금', '손상'].forEach(function (s2) {
          tryWith(t.segs.concat([{ i: p.O.length, j: p.O.length, e: { type: 'status', status: s2, w: s2, mean: 'status|' + s2 } }]), null);
        });
      }
      return out.slice(0, 4);
    }

    // 상태 3가지(기획 v2.32): 교환(교환·용접절단) · 판금 · 수리필요(요철·손상·부식·흠집)
    var KIND3 = { 교환: '교환', 용접절단: '교환', 판금: '판금', 요철: '수리필요', 손상: '수리필요', 부식: '수리필요', 흠집: '수리필요', 수리필요: '수리필요' };
    function to3(items) { return (items || []).map(function (it) { return Object.assign({}, it, { status: KIND3[it.status] || it.status }); }); }

    // opt: { terms: 팀 표기 사전, picks: { 조각 원문: 부위 목록 } — 사용자가 후보에서 고른 것,
    //        status3: 상태를 교환 · 판금 · 수리필요로(사이트 · 묶음) — 기록부 밖 부위의 수리필요도 부위로 돌려준다 }
    function parseText(text, opt) {
      var lex = lexFor(opt && opt.terms), picks = (opt && opt.picks) || {}, three = !!(opt && opt.status3);
      var res = { state: '입력', items: [], unknown: [], notes: [], outside: [], paint: [], tokens: [] }, ignored = [];
      var s = text == null ? '' : String(text);
      if (s.normalize) s = s.normalize('NFKC');   // 전각 문자 → 반각
      s = s.trim();
      if (!s || UNKNOWN_CELL[compact(s)]) { res.state = '미상'; return res; }
      if (NO_DAMAGE[compact(s)]) { res.state = '무사고'; return res; }
      s = s.replace(/판금\s*\/\s*용접\s*,\s*용접\s*,\s*절단/g, '절단')   // 원문 표기
        .replace(/교환\s*\(\s*교체\s*\)/g, '교환')
        .replace(/판금\s*\/\s*용접/g, '판금')
        .replace(/[판빤]\s*[넬낼]/g, '패널')                      // 판넬 = 패널
        .replace(/프레[임인]\s*\/\s*사이드\s*[멤맴]버/g, '사이드멤버')    // '프레임/사이드멤버' = 한 부위
        .replace(/좌\s*[·,\/&]\s*우/g, '좌우')
        .replace(/앞\s*[·,\/&]\s*뒤/g, '앞뒤')
        .replace(/\[([^\]\n]*)\]/g, '\n$1 ')                       // '[교환] 본넷, 앞펜더(좌)' — 꼬리표가 새 줄의 머리
        .replace(/:/g, ' ');
      var toks = [];
      s.split(/[\n\r]+/).forEach(function (line, li) {
        line.split(/[,\/;|·+&]+/).forEach(function (tok) { tok = tok.trim(); if (tok) toks.push({ raw: tok, line: li }); });
      });
      var rd = toks.map(function (t) { return picks[t.raw] ? { text: t.raw, picked: picks[t.raw] } : readTok(t.raw, lex); });

      // 상태 물려받기 — 같은 조각의 뒤 묶음 → 앞의 머리 상태('[교환] 본넷, 앞펜더') → 같은 줄 뒤 조각('본넷, 휀다 교환')
      var carry = null;
      rd.forEach(function (t, k) {
        if (t.picked || t.nod) return;
        if (t.header) { carry = t.header; return; }
        t.groups.forEach(function (g, gi) {
          g.status = topStatus(g);
          if ((g.part || g.out) && !g.status) {
            var nx = t.groups.slice(gi + 1).filter(function (x) { return x.sts.length; })[0];
            if (nx) { g.status = topStatus(nx); g.inh = 'next'; }
            else if (carry) { g.status = carry; g.inh = 'carry'; }
            else {
              for (var k2 = k + 1; k2 < rd.length && toks[k2].line === toks[k].line; k2++) {
                var t2 = rd[k2];
                if (!t2.groups || t2.header) break;
                var h = t2.groups.filter(function (x) { return x.sts.length && (x.part || x.out) && !x.stFirst; })[0];
                if (h) { g.status = topStatus(h); g.inh = 'later'; break; }
                if (t2.groups.some(function (x) { return x.sts.length; })) break;
              }
            }
          }
          if (g.stFirst && g.status) carry = g.status;
        });
        t.carry = carry;
      });

      rd.forEach(function (t, k) {
        var row = { text: t.text, kind: 'ok', items: [], label: '', guess: t.guess || [], inh: null, cands: [], why: '' };
        res.tokens.push(row);
        if (t.picked) { row.kind = 'picked'; row.items = t.picked; row.label = summary(t.picked); res.items = res.items.concat(t.picked); return; }
        if (t.nod) { row.kind = 'clean'; ignored.push(t.text); return; }
        if (t.header) { row.kind = 'header'; row.label = '다음 부위들의 상태: ' + t.header; return; }
        var bad = t.skipped.length ? '못 읽은 글자' : t.amb ? '비슷한 낱말이 여럿' : '', outs = [], paint = false;
        t.groups.forEach(function (g) {
          g.seq.forEach(function (s) { if (s.e.w === '경미') res.notes.push("'" + t.text + "' — '경미'는 손상으로 계산"); });
          if (g.out) {                                           // 기록부 밖 부위: 수리필요면 수리비(3가지 상태로 읽을 때, Q224) · 교환·판금 이력은 계산 제외
            if (three && g.status && KIND3[g.status] === '수리필요') {
              var sd = null;
              g.mods.forEach(function (m) { if (m.e.side) sd = m.e.side; });
              row.items.push({ part: g.out.e.w, side: sd, pillar: null, status: g.status, outside: true });
            } else outs.push(g.out.e.w);
            return;
          }
          if (!g.part) {
            if (g.mods.length) bad = bad || '부위 없음';
            else if (g.paint) paint = true;
            return;
          }
          if (g.paint && !g.sts.length && !g.status) { paint = true; return; }   // 도색만 → 계산 제외(Q206)
          if (!g.status) { bad = bad || '상태 없음'; return; }
          if (g.part.e.part === '필러 패널' && !g.part.e.pillar && g.sts.length === 1 && g.sts[0].e.sym && (g.status === '흠집' || g.status === '부식') &&
              !g.mods.some(function (m) { return m.e.dir; })) { bad = bad || 'A·C 가 필러 위치인지 상태인지 모름'; return; }
          var r = resolve(g, g.status, t.p.count);
          if (r.err) { bad = bad || r.err; return; }
          row.items = row.items.concat(r.items);
          if (g.inh) row.inh = g.inh;
          if (r.dropped) row.guess = row.guess.concat([{ from: '좌우', to: '좌우 구분 없는 부위라 뺌', cost: 0 }]);   // '후드 좌' · '코너패널(좌)'
        });
        if (bad) {
          row.kind = 'unknown'; row.why = bad;
          row.cands = candidates(t, lex, t.carry);
          res.unknown.push(t.text);
          row.label = row.items.length ? summary(row.items) : '';
          row.items = [];                                        // 못 읽은 조각은 고를 때까지 반영하지 않는다(읽은 일부만 넣으면 헷갈림)
          return;
        }
        if (!row.items.length) {
          if (outs.length) { row.kind = 'outside'; row.label = outs.join(' · '); res.outside.push(t.text); return; }
          if (paint) { row.kind = 'paint'; row.label = '도색만'; res.paint.push(t.text); return; }
          row.kind = 'ignore'; return;
        }
        if (outs.length) res.outside.push(t.text);
        if (paint) res.paint.push(t.text);
        row.kind = row.guess.length || row.inh === 'later' ? 'guess' : 'ok';
        row.label = summary(row.items);
        if (row.kind === 'guess' && t.segs.some(function (s2) { return s2.cost > 0; })) {
          row.cands = candidates(t, lex, t.carry).filter(function (x) { return x.label !== row.label; });
        }
        res.items = res.items.concat(row.items);
      });
      var at = {}, kept = [];                                     // 37곳 중 같은 자리를 두 번 적었으면 더 심한 상태 하나만('좌앞휀다 판, 휜더 좌 교환')
      res.items.forEach(function (it) {
        var key = it.part + '|' + (it.side || '') + '|' + (it.pillar || '');
        if (!POS_KEY[key]) { kept.push(it); return; }
        if (at[key] == null) { at[key] = kept.length; kept.push(it); return; }
        var old = kept[at[key]], worse = SEVERITY.indexOf(it.status) < SEVERITY.indexOf(old.status) ? it : old;
        res.notes.push("'" + itemLabel(it) + "' 두 번 적음 — 더 심한 상태(" + worse.status + ')로 계산');
        kept[at[key]] = worse;
      });
      res.items = kept;
      if (three) {                                                // 3가지 상태로(겹친 자리 고르기는 원래 상태의 심한 순서로 마친 뒤)
        res.items = to3(res.items);
        res.tokens.forEach(function (r) {
          if (r.items.length) { r.items = to3(r.items); r.label = summary(r.items); }
          r.cands.forEach(function (c) { c.items = to3(c.items); c.label = summary(c.items); });
        });
        res.notes = res.notes.map(function (n) { return n.replace("'경미'는 손상으로 계산", "'경미'는 수리필요로 계산"); });
      }
      if (!res.items.length && !res.unknown.length) {             // 무사고 = 이상 없음 · 범퍼 같은 기록부 밖 · 도색만을 적은 경우. 상태 머리만 쓴 글은 아직 미상
        res.state = res.tokens.some(function (r) { return r.kind === 'clean' || r.kind === 'outside' || r.kind === 'paint'; }) ? '무사고' : '미상';
      } else ignored.forEach(function (t) { res.notes.push("'" + t + "' — 다른 부위가 함께 적혀 있어 무시"); });
      res.outside.forEach(function (t) { res.notes.push("'" + t + "' — 성능점검 대상이 아니라 시세 계산에서 뺌(경매 평가에서는 감점될 수 있음)"); });
      res.paint.forEach(function (t) { res.notes.push("'" + t + "' — 도색만(기록부에 안 적히는 항목)이라 시세 계산에서 뺌"); });
      res.tokens.forEach(function (r) {
        if (r.kind === 'guess') res.notes.push("'" + r.text + "' → " + r.label + ' (짐작' + (r.guess.length ? ': ' + r.guess.map(function (g) { return g.from + '→' + g.to; }).join(', ') : ': 상태는 뒤 조각에서') + ')');
      });
      return res;
    }

    function toText(items) {   // 기록부 기호로 한 줄: "프론트 휀더(좌) X, 쿼터 패널(우) W"
      return (items || []).filter(function (it) { return SYMBOL_OF[it.status]; })
        .map(function (it) { return itemLabel(it) + ' ' + SYMBOL_OF[it.status]; }).join(', ');
    }

    function summary(items) {   // 입력 확인 줄: "프론트 휀더(좌) 교환 · 쿼터 패널(우) 판금"
      return (items || []).map(function (it) { return itemLabel(it) + ' ' + it.status; }).join(' · ');
    }

    return {
      version: model.version,
      positions: model.positions,
      statuses: model.statuses,
      fromRaw: fromRaw,
      parseText: parseText,
      evaluate: evaluate,
      autoSimpleRepair: autoSimpleRepair,
      toText: toText,
      summary: summary
    };
  }

  var api = { create: create };
  root.InspectionScore = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
