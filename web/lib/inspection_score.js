/*
 * inspection_score.js — 성능 상태 계산기 (사이트용)
 *
 * 성능·상태점검기록부 입력(부위 37곳 × 상태 7가지), 엑셀 '성능 상태' 한 칸, 엔카 성능점검 원문을 받아
 * 파이프라인(prep.py · inspection_score.py)과 같은 규칙으로 계산한다.
 *   → 사고 단계·라벨, 단계별 교환·판금 수, 글로비스 감점합·종합평가점·사고평가점, 자체 성능감가율·점수·등급
 * 규칙·가중치는 /data/inspection_model.json 하나에서 읽는다(inspection_score.py 가 내보냄. 직접 고치지 말 것).
 * 파이프라인과 같은 값인지는 python inspection_parity.py 로 검증한다.
 *
 *   var calc = InspectionScore.create(model);
 *   calc.evaluate({ state: '입력', items: [{ part: '프론트 휀더', side: '좌', status: '교환' }] });
 *   calc.evaluate(calc.parseText('좌프론트휀더 X, 우쿼터 W'));
 *   calc.evaluate(calc.fromEncar(outerPanelText, mainFrameText));
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

    // ── 엔카 성능점검 원문 (outer_panel · main_frame) — inspection_score.parse_items 와 같음 ──
    function rawStatus(stat) {
      for (var i = 0; i < rawRules.length; i++) if (rawRules[i][0].test(stat)) return rawRules[i][1];
      return '기타';
    }

    function fromEncar(outer, frame) {
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

    // ── 엑셀 '성능 상태' 한 칸 읽기 — 별칭·위치·기호. 못 읽은 표기는 unknown 으로 돌려준다 ──
    var aliases = [];
    Object.keys(P.part_aliases).forEach(function (part) {
      P.part_aliases[part].forEach(function (a) { aliases.push({ c: compact(a), part: part, pillar: null }); });
    });
    Object.keys(P.pillar_aliases).forEach(function (a) {
      aliases.push({ c: compact(a), part: '필러 패널', pillar: P.pillar_aliases[a] });
    });
    aliases.forEach(function (a) { a.re = spacedRe(a.c, 'i'); });
    aliases.sort(function (a, b) { return b.c.length - a.c.length; });

    var words = [];
    function addWords(map, type) { Object.keys(map).forEach(function (w) { words.push({ w: w, type: type, value: map[w] }); }); }
    addWords(P.status_words, 'status');
    addWords(P.status_symbols, 'status');
    addWords(P.side_words, 'side');
    addWords(P.direction_words, 'dir');
    P.both_words.forEach(function (w) { words.push({ w: w, type: 'both' }); });
    P.ignore_words.forEach(function (w) { words.push({ w: w, type: 'ignore' }); });
    words.forEach(function (v) {
      v.c = compact(v.w);
      v.latin = /^[A-Z]+$/.test(v.c);   // X·W·L·R 같은 영문 기호는 다른 영문자와 붙어 있으면 읽지 않는다
      v.re = v.latin ? new RegExp('(^|[^A-Z])' + v.c + '(?![A-Z])', 'i') : spacedRe(v.c, 'i');
    });
    words.sort(function (a, b) { return b.c.length - a.c.length; });

    function wordSet(list) { var s = {}; list.forEach(function (w) { s[compact(w)] = true; }); return s; }
    var UNKNOWN_CELL = wordSet(P.unknown_cell), NO_DAMAGE = wordSet(P.no_damage_cell);
    var OUTSIDE = (P.outside_parts || []).map(function (w) { var c = compact(w); return { c: c, re: spacedRe(c, 'i') }; })
      .sort(function (a, b) { return b.c.length - a.c.length; });

    // 성능점검 37곳 밖 부위(범퍼·램프·유리…)만 적힌 칸인가. 더 긴 성능점검 부위 이름이 맞으면 그쪽(휠 < 휠하우스), 그 이름과
    // 상태·좌우·앞뒤·개수 말고 글자가 남으면 아니다 — 오타 '좌앞휠더 판금'을 휠로 읽어 조용히 빼지 않고 '못 읽음'으로 돌려준다
    function outside(tok) {
      var cs = compact(tok), o = null, i;
      for (i = 0; i < OUTSIDE.length; i++) if (cs.indexOf(OUTSIDE[i].c) >= 0) { o = OUTSIDE[i]; break; }
      if (!o) return false;
      for (i = 0; i < aliases.length; i++) if (cs.indexOf(aliases[i].c) >= 0 && aliases[i].c.length >= o.c.length) return false;
      var s = (' ' + tok.replace(/[()[\]{}<>]/g, ' ') + ' ').replace(o.re, ' ').replace(/\d+\s*(개|곳|짝|EA)/gi, ' ').replace(/[×*]\s*\d+/g, ' ');
      words.forEach(function (w) {
        var g = new RegExp(w.re.source, 'gi');
        s = w.latin ? s.replace(g, function (all, pre) { return pre + ' '; }) : s.replace(g, ' ');
      });
      return !/[0-9A-Za-zㄱ-ㆎ가-힣]/.test(s);
    }

    function parseToken(tok, notes) {
      var s = ' ' + tok.replace(/[()[\]{}<>]/g, ' ') + ' ', count = 1;
      var cm = s.match(/(\d+)\s*(개|곳|짝|EA)/i) || s.match(/[×*]\s*(\d+)/);
      if (cm) { count = parseInt(cm[1], 10); s = s.replace(cm[0], ' '); }
      var cs = compact(s), al = null;
      for (var i = 0; i < aliases.length; i++) if (cs.indexOf(aliases[i].c) >= 0) { al = aliases[i]; break; }
      if (!al) return null;
      var m = al.re.exec(s);
      if (!m) return null;
      s = s.slice(0, m.index) + ' ' + s.slice(m.index + m[0].length);

      var st = [], side = null, both = false, dir = null, symbolOnly = true, hit;
      for (;;) {
        hit = null;
        for (var j = 0; j < words.length; j++) if (words[j].re.test(s)) { hit = words[j]; break; }
        if (!hit) break;
        s = hit.latin ? s.replace(hit.re, function (all, pre) { return pre + ' '; }) : s.replace(hit.re, ' ');
        if (hit.type === 'status') {
          st.push(hit.value);
          if (!hit.latin) symbolOnly = false;
          if (hit.w === '경미') notes.push("'" + tok.trim() + "' — '경미'는 손상으로 계산");
        } else if (hit.type === 'side') {
          if (side && side !== hit.value) return null;
          side = hit.value;
        } else if (hit.type === 'both') {
          both = true;
        } else if (hit.type === 'dir') {
          if (dir && dir !== hit.value) return null;
          dir = hit.value;
        }
      }
      if (/[0-9A-Za-zㄱ-ㆎ가-힣]/.test(s)) return null;   // 읽지 못한 글자가 남음
      if (!st.length || count < 1 || count > 6) return null;

      var status = SEVERITY.filter(function (v) { return st.indexOf(v) >= 0; })[0];
      var part = al.part, pillar = al.pillar;
      if (dir) {
        if (part === '필러 패널') {
          if (pillar && pillar !== dir) return null;
          pillar = dir;
        } else if (P.generic_dir[part]) {
          if (!P.generic_dir[part][dir]) return null;
          part = P.generic_dir[part][dir];
        } else if (!parts[part] || parts[part].dir !== dir) {
          return null;
        }
      }
      // 필러 + 기호 A·C 하나뿐: A·C필러(위치)인지 흠집·부식(상태)인지 알 수 없다
      if (part === '필러 패널' && !pillar && symbolOnly && st.length === 1 && (status === '흠집' || status === '부식')) return null;
      var inf = info(part);
      if ((side || both) && !(inf && inf.sides)) return null;
      if (both && count > 2) return null;
      var out = [];
      if (both) ['좌', '우'].forEach(function (sd) { out.push({ part: part, side: sd, pillar: pillar, status: status }); });
      else for (var c = 0; c < count; c++) out.push({ part: part, side: side, pillar: pillar, status: status });
      return out;
    }

    function parseText(text) {
      var res = { state: '입력', items: [], unknown: [], notes: [], outside: [] }, ignored = [];
      var s = text == null ? '' : String(text);
      if (s.normalize) s = s.normalize('NFKC');   // 전각 문자 → 반각
      s = s.trim();
      if (!s || UNKNOWN_CELL[compact(s)]) { res.state = '미상'; return res; }
      if (NO_DAMAGE[compact(s)]) { res.state = '무사고'; return res; }
      s = s.replace(/판금\s*\/\s*용접\s*,\s*용접\s*,\s*절단/g, '절단')   // 엔카 원문 표기
        .replace(/교환\s*\(\s*교체\s*\)/g, '교환')
        .replace(/판금\s*\/\s*용접/g, '판금')
        .replace(/좌\s*[·,\/&]\s*우/g, '좌우')
        .replace(/:/g, ' ');
      s.split(/[,\/;|\n\r·+&]+/).forEach(function (tok) {
        tok = tok.trim();
        if (!tok) return;
        if (NO_DAMAGE[compact(tok)]) { ignored.push(tok); return; }
        if (outside(tok)) { res.outside.push(tok); return; }
        var r = parseToken(tok, res.notes);
        if (r) res.items = res.items.concat(r);
        else res.unknown.push(tok);
      });
      if (!res.items.length && !res.unknown.length) res.state = '무사고';
      else ignored.forEach(function (t) { res.notes.push("'" + t + "' — 다른 부위가 함께 적혀 있어 무시"); });
      res.outside.forEach(function (t) { res.notes.push("'" + t + "' — 성능점검 대상이 아니라 시세 계산에서 뺌(경매 평가에서는 감점될 수 있음)"); });
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
      fromEncar: fromEncar,
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
