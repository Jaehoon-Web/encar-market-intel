/*
 * name_match.js — 차명 자유 표기 → 엔카 분류 (기획안 D5 모델명 매칭, 묶음 산정용)
 *
 * 1) 세부모델: 모델그룹 이름(또는 수입차 등급 코드 520d·E300)이 있는지 + 세부모델만의 표시(세대 코드·더뉴/올뉴·하이브리드)
 *    + 등록 연도 범위 + 매물 수. 같은 이름이라도 연도로 세대를 가른다(그랜저 IG ↔ 더 뉴 그랜저 IG)
 * 2) 등급·세부등급: 그 세부모델의 등급 조합 중 연료·배기량·터보·구동·인승·트림 단어(앞부분만 써도 됨)가 가장 잘 맞는 것
 * 확신(conf): high · mid · low — 묶음 화면에서 low 는 노랗게 표시하고 후보 중에서 고르게 한다
 *
 *   var nm = NameMatch.create(index);                               // comps/index.json
 *   nm.model('올뉴투싼 2.0 디젤', 2018)
 *     → { best: { maker, group, model, file, score }, conf, cands: [...5] }   (못 찾으면 best = null)
 *   nm.grade(grp, '투싼 (NX4)', '1.6T 인스퍼')                      // grp = PriceEngine 의 group(모델그룹 파일)
 *     → { grade, trim, conf, cands: [...5] }
 */
(function (root) {
  'use strict';

  var PREFIX = ['디올뉴', '더올뉴', '올뉴', '더뉴', '신형', '뉴'];       // 띄어쓰기 없앤 꼴, 긴 것부터
  var GROUP_ALIAS = { '그랜져': '그랜저', '소나타': '쏘나타', '산타페': '싼타페', '아반테': '아반떼', '쏘렌또': '쏘렌토',
    '스타랙스': '스타렉스' };                                  // 흔한 오타만. 실제 엑셀 표기를 받으면 더한다
  var MAKER_EXTRA = { '현대': ['현대자동차', 'HYUNDAI'], '기아': ['기아자동차', 'KIA'], '제네시스': ['GENESIS'],
    'KG모빌리티(쌍용)': ['쌍용', 'KGM', 'SSANGYONG'], '르노코리아(삼성)': ['르노삼성', '르노', 'RENAULT'],
    '쉐보레(GM대우)': ['쉐보레', 'GM대우', '대우', 'CHEVROLET'], '벤츠': ['메르세데스', 'MERCEDES', 'BENZ'], 'BMW': [], '아우디': ['AUDI'] };
  var FUEL = [['PHEV', /PHEV|플러그인/], ['HEV', /HEV|하이브리드|HYBRID/], ['EV', /(^|[^A-Z])EV([^A-Z0-9]|$)|전기|일렉트릭/],
    ['LPG', /LPG|LPI|LPLI|LPE/], ['디젤', /디젤|DIESEL|CRDI|VGT|TDI/], ['가솔린', /가솔린|GASOLINE|GDI|MPI|TSI|TFSI/], ['수소', /수소/]];
  var AWD = /4MATIC|4매틱|XDRIVE|X드라이브|콰트로|QUATTRO|HTRAC|에이치트랙|4MOTION|4모션|ALL4|4WD|AWD|4륜|사륜/;
  var TWD = /2WD|FWD|RWD|전륜|후륜|2륜/;
  var DRIVE_GLUE = /(4MATIC|XDRIVE|SDRIVE|QUATTRO|HTRAC|4MOTION|ALL4|4WD|AWD|2WD|FWD|RWD)/g;   // E220D4MATIC → E220D 4MATIC
  var NOISE = /^(?:가솔린|디젤|하이브리드|전기|일렉트릭|터보|플러그인|수소|사륜|전륜|후륜|인승|모델|등급|트림|차량|중고)$/;
  var NOISE1 = /^(?:더|뉴|디|올|신|구|및|용|형)$/;

  function up(s) {                                         // 대문자 + 표기 맞추기(xDrive20d → XDRIVE 20D, 150PS → 150마력)
    return String(s == null ? '' : s).toUpperCase().replace(/(XDRIVE|SDRIVE)(\d)/g, '$1 $2').replace(/(\d)\s*PS\b/g, '$1마력');
  }
  function compact(s) { return up(s).replace(/[\s\-_.,·:;()\[\]\/+]/g, ''); }
  function spaced(s) { return up(s).replace(/[^0-9A-Z가-힣]+/g, ' ').trim(); }
  function prefixOf(c) {                                    // 띄어쓰기 없앤 글에서 세대 접두어(첫 번째)
    var best = null, at = 1e9;
    PREFIX.forEach(function (p) { var i = c.indexOf(p); if (i >= 0 && (i < at || (i === at && p.length > best.length))) { best = p; at = i; } });
    return best;
  }
  function fuelOf(text) {
    var t = up(text);
    for (var i = 0; i < FUEL.length; i++) if (FUEL[i][1].test(t)) return FUEL[i][0];
    return null;
  }
  function words(text) {                                    // 한글·영문 낱말(숫자 섞인 코드 포함)
    return (up(text).match(/[A-Z0-9]*[A-Z][A-Z0-9]*|[가-힣]+|\d+(?:\.\d+)?/g) || []);
  }
  function feats(text, skip) {                              // skip = 세부모델 이름의 낱말(E-클래스의 E, W213 등)은 등급 단서에서 뺀다
    var t = up(text), f = { fuel: fuelOf(t), disp: null, turbo: /\d\.\dT(?![A-Z])|터보|TURBO|T-?GDI/.test(t),
      drive: AWD.test(t) ? 'AWD' : (TWD.test(t) ? '2WD' : null), seats: null, words: [], codes: [], letters: [], nums: [], rest: [] };
    var d = t.match(/(\d\.\d)/); if (d) f.disp = d[1];
    var s = t.match(/(\d{1,2})인승/); if (s) f.seats = +s[1];
    words(t.replace(DRIVE_GLUE, ' $1 ')).forEach(function (w) {
      if (AWD.test(w) || TWD.test(w) || /인승$/.test(w) || (skip && skip.indexOf(w) >= 0)) return;
      if (/\d/.test(w) && /[A-Z]/.test(w) && w.length >= 2) f.codes.push(w);           // 520I · 730LD · E220D · S550 · C7
      else if (/^\d{2,3}$/.test(w)) f.codes.push(w);                                      // 아우디 45 · 40
      else if (/^\d{4}$/.test(w)) f.nums.push(w);                                        // 알핀 1955 같은 에디션 숫자
      else if (/^[A-Z]$/.test(w)) f.letters.push(w);                                     // 아이오닉 Q · 쿠페 R · S400L d · M 스포츠
      else if (/^[가-힣]$/.test(w)) { if (!NOISE1.test(w)) f.words.push(w); }           // 밴 — 한 글자는 똑같을 때만 맞춘다
      else if (w.length >= 2 && !/^\d/.test(w) && !NOISE.test(w) && !fuelOf(w)) f.words.push(w);
      else if (/[가-힣]{2}/.test(w)) f.rest.push(w);                                     // 연료가 붙은 낱말(코나하이브리드프리미엄) — 붙여 쓴 글 찾기에만
    });
    return f;
  }

  function create(index) {
    var makers = [], models = [], groupNames = {};
    function nameOf(s, alt) { var c = compact(s); return { c: c, s: spaced(s), latin: !/[가-힣]/.test(c), alt: !!alt }; }
    index.makers.forEach(function (mk) {
      var al = [mk.name].concat((mk.name.match(/[^()]+/g) || []), MAKER_EXTRA[mk.name] || []).map(compact).filter(function (a) { return a.length >= 2; });
      makers.push({ name: mk.name, alias: al });
      mk.groups.forEach(function (g) {
        var gc = compact(g.name);
        if (/^기타/.test(gc)) return;                                    // '기타 승용차' 같은 묶음은 이름으로 찾지 않는다
        groupNames[gc] = true;
        g.models.forEach(function (m) {
          var names = [nameOf(g.name)], cut = up(g.name);
          if (compact(m.name).indexOf(gc) < 0 || gc.length === 1) {     // 그란투리스모 (GT) / 3시리즈 GT (F34) · 인피니티 G / G25 —
            cut = up(m.name).replace(/\(.*?\)|\d+세대/g, ' ').replace(/\s+/g, ' ').trim();   //   세부모델 이름(괄호·세대 빼고)도 모델명으로
            names.push(nameOf(cut, true));
          }
          var rest = up(m.name).replace(cut, ' ');                       // 모델그룹 이름을 뺀 나머지 = 세부모델 표시
          var rc = compact(rest), pf = prefixOf(rc);
          if (pf) rest = rest.replace(new RegExp(pf.split('').join('\\s*')), ' ');
          var core = words(rest).filter(function (w) { return !/^(?:HEV|PHEV|EV)$/.test(w) && !fuelOf(w); });
          models.push({ maker: mk.name, group: g.name, model: m.name, file: g.file, n: m.n, y0: m.y0, y1: m.y1,
            names: names, prefix: pf, core: core, fuel: /하이브리드|HEV/.test(up(m.name)) ? (/PHEV|플러그인/.test(up(m.name)) ? 'PHEV' : 'HEV')
              : (/일렉트릭|(^|[^A-Z])EV([^A-Z]|$)|전기/.test(up(m.name)) ? 'EV' : null),
            gk: (m.gk || []).map(compact) });
        });
      });
    });

    function prep(text) {
      var t = up(text);
      Object.keys(GROUP_ALIAS).forEach(function (a) { t = t.split(up(a)).join(up(GROUP_ALIAS[a])); });
      var c = compact(t), toks = words(t), f = fuelOf(t);
      var maker = null;
      makers.forEach(function (mk) { mk.alias.forEach(function (a) { if (c.indexOf(a) >= 0 && (!maker || a.length > maker.len)) maker = { name: mk.name, len: a.length, word: a }; }); });
      var cm = maker && c.indexOf(maker.word) === 0 ? c.slice(maker.word.length) : c;   // 맨 앞 제조사는 세부모델 표시가 아니다(기아 더 뉴 레이 ≠ 더 뉴 기아 레이)
      return { t: t, c: c, cm: cm, s: spaced(t), toks: toks, prefix: prefixOf(c), fuel: f === 'PHEV' || f === 'HEV' || f === 'EV' ? f : null, maker: maker };
    }
    function has(inp, tok) {                                 // 영문 한 글자는 독립 낱말일 때만(R·S 등)
      return tok.length <= 1 && /[A-Z]/.test(tok) ? inp.toks.indexOf(tok) >= 0 : inp.cm.indexOf(compact(tok)) >= 0;
    }

    function groupHit(m, inp) {                             // 맞은 모델명 중 가장 긴 것의 길이(없으면 0)
      function scan(str, sub) {                             // 영문·숫자만인 모델명(S60·LS·iX)은 바로 앞이 영문·숫자가 아닐 때만
        for (var i = str.indexOf(sub); i >= 0; i = str.indexOf(sub, i + 1)) if (i === 0 || !/[A-Z0-9]/.test(str.charAt(i - 1))) return true;
        return false;                                       //   GLS600 안의 S60 ✗ · CLS 안의 LS ✗ · 더뉴K53세대의 K5 ✓ · BMW X7 ✓
      }
      var len = 0, alt = false;
      m.names.forEach(function (nm) {
        var ok = nm.c.length === 1 ? inp.toks.indexOf(nm.c) >= 0            // 한 글자 이름(인피니티 G · 던)은 따로 떨어진 낱말일 때만
          : (nm.latin ? scan(inp.s, nm.s) || scan(inp.c, nm.c) : inp.c.indexOf(nm.c) >= 0);
        if (ok && nm.c.length > len) { len = nm.c.length; alt = nm.alt; }
      });
      return { len: len, partial: len > 0 && m.names.length > 1 && !alt };   // partial = 모델그룹 이름만 맞음(쿠퍼 쿠페 ↔ 쿠퍼 S 쿠페)
    }

    function scoreModel(m, inp, year) {
      var s, why = [], hit = groupHit(m, inp);
      if (hit.len) { s = 3 + Math.min(hit.len, 10) * 0.5 - (hit.partial ? 1 : 0); why.push('모델명'); }   // 긴 이름일수록(X5M > X5)
      else if (m.gk.some(function (k) { return inp.toks.indexOf(k) >= 0; })) { s = 2.5; why.push('등급 코드'); }   // 낱말 단위(18DOHC ≠ 18D)
      else return null;
      if (m.prefix || inp.prefix) {
        if (m.prefix === inp.prefix) { s += 1.5; why.push(m.prefix); }
        else if (!inp.prefix) s -= 1.2;
        else if (!m.prefix) s -= 1.2;
        else s -= 1.5;
      }
      m.core.forEach(function (tok) { if (has(inp, tok)) { s += 2.5; why.push(tok); } else s -= 0.6; });
      if (m.fuel) { if (inp.fuel === m.fuel) { s += 3; why.push(m.fuel); } else s -= 3; }
      else if (inp.fuel) s -= 1.5;
      if (year) {                                            // 연도 범위(2~98%) 안 +2.5, 1년 밖 +1, 더 멀면 감점
        var d = year < m.y0 ? m.y0 - year : (year > m.y1 ? year - m.y1 : 0);
        if (!d) { s += 2.5; why.push(m.y0 + '~' + m.y1); }
        else if (d === 1) s += 1;                            // 1.5 · 범위 1~99%로 넓히면 접두어 없는 표기에서 세대를 더 틀렸다(97.0 → 94.5%)
        else s -= 1.2 * Math.min(d - 1, 5);
      }
      if (inp.maker && inp.maker.name !== m.maker) s -= groupNames[inp.maker.word] ? 0.5 : 1.5;   // 약하게만(현대 G80 = 엔카 제네시스 등)
      s += 0.25 * Math.log(m.n + 1) / Math.LN10;
      return { maker: m.maker, group: m.group, model: m.model, file: m.file, score: s, why: why, y0: m.y0, y1: m.y1 };
    }

    function model(text, year) {
      var inp = prep(text), list = [];
      models.forEach(function (m) { var r = scoreModel(m, inp, year); if (r) list.push(r); });
      list.sort(function (a, b) { return b.score - a.score; });
      if (!list.length) return { best: null, conf: 'none', cands: [] };
      return finish(list, year);
    }
    function finish(list, year) {
      var best = list[0], next = list[1], gap = next ? best.score - next.score : 9;
      var yearOk = !year || (year >= best.y0 - 1 && year <= best.y1 + 1);
      var named = best.why[0] === '모델명', alone = named && !(next && next.why[0] === '모델명');   // 2등은 등급 코드로만 걸림(BMW X7 ↔ X5)
      var conf = named && yearOk && (gap >= 2 || (alone && gap >= 1)) ? 'high' : (gap >= 0.8 && yearOk ? 'mid' : 'low');
      return { best: best, conf: conf, cands: list.slice(0, 5) };
    }

    // 세부모델 후보가 비슷하면(2.5점 안) 등급명까지 맞춰 보고 다시 고른다 — 그 모델그룹 파일이 있어야 한다
    function refine(res, text, year, grpOf) {
      if (!res.best || res.cands.length < 2) return res;
      var top = res.best.score, list = res.cands.map(function (c) {
        var x = Object.assign({}, c), g = c.score >= top - 2.5 ? grpOf(c.file) : null;
        if (g) { var gr = grade(g, c.model, text); if (gr && gr.score > 0) { x.score += 0.5 * gr.score; x.why = c.why.concat(['등급']); } }
        return x;
      }).sort(function (a, b) { return b.score - a.score; });
      return finish(list, year);
    }

    // 등급·세부등급: 그 세부모델에 실제로 있는 조합 중에서 고른다
    function grade(grp, modelName, text) {
      var M = grp.models[modelName], F = grp.F, fi = grp.fi;
      if (!M) return null;
      var cnt = {};
      F.rows.forEach(function (r) { if (r[fi.m] === M.idx) { var k = r[fi.g] + '|' + r[fi.t]; cnt[k] = (cnt[k] || 0) + 1; } });
      var mx = up(modelName), mw = words(mx), f = feats(up(text).split(mx).join(' '), mw);
      var phrase = function (s) { return up(s).replace(/[\s\-_.,·:;()\[\]\/]/g, ''); }, whole = phrase(text);
      var list = Object.keys(cnt).map(function (k) {
        var p = k.split('|'), g = F.grades[+p[0]], t = F.trims[+p[1]], cf = feats(g + ' ' + t, mw), s = 0, ev = 0, trimHit = false;
        if (f.fuel && cf.fuel) { if (f.fuel === cf.fuel) { s += 3; ev++; } else s -= 4; }
        else if (!f.fuel && cf.fuel) s -= 0.3;                                // 연료를 안 적었으면 연료가 붙은 등급을 조금 덜(어린이보호차 ↔ 어린이보호차 LPi)
        if (f.disp && cf.disp) { if (f.disp === cf.disp) { s += 3; ev++; } else s -= 3; }
        if (f.turbo) { if (cf.turbo) { s += 1; ev++; } else s -= 0.5; }
        else if (cf.turbo) s -= 0.3;                                          // 캐스퍼 인스퍼레이션 ↔ 터보 인스퍼레이션
        if (f.drive && cf.drive) { if (f.drive === cf.drive) { s += 1; ev++; } else s -= 1.5; }
        else if (!f.drive && cf.drive === 'AWD') s -= 0.4;                   // 구동 표시가 없으면 사륜 등급을 조금 덜
        if (f.seats && cf.seats) { if (f.seats === cf.seats) { s += 1; ev++; } else s -= 1; }
        if (f.codes.length && cf.codes.length) {                             // 코드는 정확히 같아야(730LD ≠ 740LI, S550 ≠ S550L)
          var same = f.codes.filter(function (c) { return cf.codes.indexOf(c) >= 0; }).length;
          var inside = same ? 0 : cf.codes.filter(function (c) {               // 붙여 쓴 코드 안에 있으면 조금(W213E220D 의 E220D)
            return c.length >= 3 && f.codes.some(function (x) { return x.length > c.length && x.indexOf(c) >= 0; });
          }).length;
          if (same) { s += 3 * same; ev += same; } else if (inside) { s += 2 * inside; ev += inside; } else s -= 2;
        } else if (cf.codes.length) s -= 0.3;                                 // 코드를 안 적었으면 코드가 붙은 등급을 조금 덜(L3.5 휠체어)
        var ph = phrase(g + ' ' + t);
        if (ph.length >= 3 && whole.indexOf(ph) >= 0) s += 0.5;               // 등급 이름이 적힌 그대로 들어 있으면(낱말 순서 · 팩2 ↔ 팩1)
        var tw = words(t), done = {}, glue = '|' + f.rest.join('|');        // glue = 등급 낱말에 안 맞고 남은 글(노블레스스페셜 의 스페셜)
        var pre = function (x, w) { return x === w || (x.length >= 2 && w.length >= 2 && (x.indexOf(w) === 0 || w.indexOf(x) === 0)); };
        f.words.forEach(function (w) {                                       // 앞부분만 써도 맞다(캘리 → 캘리그래피). 한 글자는 똑같을 때만
          var hit = cf.words.filter(function (x) { return pre(x, w); });
          if (!hit.length) { glue += '|' + w; return; }
          s += 2; ev++; hit.forEach(function (x) { done[x] = 1; });
          if (tw.some(function (x) { return pre(x, w); })) trimHit = true;
          var head = hit.reduce(function (a, x) { return w.indexOf(x) === 0 && x.length > a.length ? x : a; }, '');
          if (head && head.length < w.length) glue += '|' + w.slice(head.length);
        });
        mw.forEach(function (x) { if (x.length >= 2) glue = glue.split(x).join('|'); });   // 붙여 쓴 모델명(더뉴카니발)은 빼고
        f.letters.forEach(function (w) {                                     // 영문 한 글자(Q·R·D·M)는 따로 떨어진 낱말끼리만
          if (cf.letters.indexOf(w) >= 0) { s += 1.5; ev++; if (tw.indexOf(w) >= 0) trimHit = true; }
        });
        cf.words.forEach(function (x) {
          if (done[x]) return;
          if (x.length >= 2 && /[가-힣]/.test(x) && glue.indexOf(x) >= 0) {  // 붙여 쓴 글 안에 있으면(노블레스스페셜 의 스페셜)
            s += 1.5; ev++; if (tw.indexOf(x) >= 0) trimHit = true; return;
          }
          s -= 0.3;                                                          // 입력에 없는 말이 붙은 등급은 조금 덜
        });
        cf.letters.forEach(function (x) { if (f.letters.indexOf(x) < 0) s -= 0.3; });
        f.nums.forEach(function (x) { if (cf.nums.indexOf(x) >= 0) { s += 1.5; ev++; } });
        cf.nums.forEach(function (x) { if (f.nums.indexOf(x) < 0) s -= 0.3; });
        s += 0.15 * Math.log(cnt[k] + 1) / Math.LN10;
        return { grade: g, trim: t, n: cnt[k], score: s, ev: ev, trimHit: trimHit };
      }).sort(function (a, b) { return b.score - a.score; });
      if (!list.length) return null;
      var best = list[0], gap = list.length > 1 ? best.score - list[1].score : 9;
      var conf = best.ev >= 2 && gap >= 1.5 ? 'high' : (best.ev >= 1 ? 'mid' : 'low');
      if (!best.ev) {                                       // 단서가 없으면 가장 흔한 등급(세부등급 상관없음)
        var byG = {};
        list.forEach(function (x) { byG[x.grade] = (byG[x.grade] || 0) + x.n; });
        var g0 = Object.keys(byG).sort(function (a, b) { return byG[b] - byG[a]; })[0];
        return { grade: g0, trim: '', conf: 'low', score: 0, cands: list.slice(0, 5) };
      }
      return { grade: best.grade, trim: best.trimHit ? best.trim : '', conf: conf, score: best.score, cands: list.slice(0, 5) };
    }

    return { model: model, refine: refine, grade: grade, prep: prep };
  }

  var api = { create: create, feats: feats };
  root.NameMatch = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
