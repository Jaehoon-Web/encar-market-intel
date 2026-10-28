/*
 * rates.js — ⚙ 환산 비율 설정 화면(팀 공용, 기획안 5.1.6 · D6)
 *
 * 보기: 호가대×차령 기준표(팀이 고친 칸 강조 · 초기값·표본 수) · 팀 수정(모델별 비율) · 모델 예외(데이터) · 변경 기록 · 시험 계산
 * 고치기: [수정하기] → 이름·비밀번호 → 칸·모델 고치기 → [저장] = PUT /api/rates(worker/index.js). 저장소가 없으면 보기만 된다.
 * 저장하면 같은 비율 객체(X.rates)에 바로 합쳐서, 열려 있는 한 대 산정·묶음 산정도 새 비율로 계산한다.
 *
 *   var V = V2Rates.create(ctx);   V.show(el);
 */
(function (root) {
  'use strict';

  var API = '/api/rates';
  var FUELS = ['가솔린', '디젤', 'LPG', '하이브리드', '전기', '수소', '기타'];

  function create(ctx) {
    var X = ctx.X, R = X.rates, esc = ctx.esc, el = null;
    var S = { store: false, writable: false, team: null, edit: null, msg: '', err: false, busy: false, loaded: false };
    var MODELS = [], byLabel = {};
    X.idx.makers.forEach(function (mk) {
      mk.groups.forEach(function (g) {
        g.models.forEach(function (m) {
          var it = { maker: mk.name, model: m.name, label: mk.name + ' › ' + g.name + ' › ' + m.name };
          MODELS.push(it);
          byLabel[it.label] = it;
        });
      });
    });
    function $(id) { return document.getElementById(id); }
    function remember(k, v) { try { if (v === undefined) return localStorage.getItem('v2.rates.' + k) || ''; localStorage.setItem('v2.rates.' + k, v); } catch (e) { return ''; } }
    function blankCells() { return R.rates.map(function (r) { return r.map(function () { return null; }); }); }
    function teamCells() { return S.team && S.team.cells ? S.team.cells : blankCells(); }
    function f1(v) { return v == null ? '' : (Math.round(v * 10) / 10).toFixed(1); }

    // ───── 화면 ─────
    function head() {
      var t = S.team, h = '<div class="card v2-headcard"><div class="v2-head">⚙ 환산 비율 — 팀 공용<br><span class="sub">';
      if (!S.loaded) h += '저장소를 확인하는 중…';
      else if (!S.store) h += '팀 저장소 연결 전 — 초기값(경매 낙찰가 ÷ 같은 조건 엔카 호가 요약치)만 쓰는 중입니다. 수정은 저장소를 연결한 뒤에 됩니다.';
      else if (t) h += '팀 저장소 ' + t.rev + '판 · 마지막 수정 ' + esc(RatesStore.kst(t.updated_at)) + ' ' + esc(t.updated_by);
      else h += '팀 저장소 연결됨 · 아직 팀이 고친 것이 없습니다(초기값 그대로)';
      h += '</span></div><div class="v2-actions" style="margin:0">';
      if (S.edit) {
        h += '<button type="button" class="v2-btn" data-r="cancel"' + (S.busy ? ' disabled' : '') + '>취소</button>' +
          '<button type="button" class="v2-btn primary" data-r="save"' + (S.busy ? ' disabled' : '') + '>' + (S.busy ? '저장 중…' : '저장') + '</button>';
      } else {
        h += '<button type="button" class="v2-btn" data-r="reload">다시 불러오기</button>' +
          '<button type="button" class="v2-btn primary" data-r="edit"' + (S.store && S.writable ? '' : ' disabled title="저장소 연결 후 수정할 수 있습니다"') + '>수정하기</button>';
      }
      h += '</div></div>';
      if (S.msg) h += '<div class="notebox ' + (S.err ? 'v2-bad' : '') + '">' + esc(S.msg) + '</div>';
      if (S.edit) {
        h += '<div class="card"><div class="card-title">수정하는 사람</div><div class="v2-rform">' +
          '<label class="v2-f"><span class="v2-l">이름</span><input class="v2-in" id="rBy" autocomplete="name" value="' + esc(S.edit.by) + '" placeholder="예: 권재훈"></label>' +
          '<label class="v2-f"><span class="v2-l">수정 비밀번호<em>팀 관리 비밀번호</em></span><input class="v2-in" id="rPw" type="password" autocomplete="current-password"></label>' +
          '<label class="v2-f v2-rnote"><span class="v2-l">무엇을 왜 고쳤나<em>선택 — 변경 기록에 남음</em></span><input class="v2-in" id="rNote" autocomplete="off" value="' + esc(S.edit.note) + '" placeholder="예: 9~10월 낙찰 결과 반영"></label></div></div>';
      }
      return h;
    }

    function tableCard() {
      var cells = S.edit ? S.edit.cells : teamCells(), fill = R.filled_from_neighbor || [], cnt = R.counts || [];
      var h = '<div class="card"><div class="card-title">호가대 × 차령 기준표 <span class="hint">환산 비율(%) = 엔카 호가에서 뺄 비율 · 칸 아래는 초기값과 근거 대수</span></div>' +
        '<div class="v2-tablewrap"><table class="t v2-rtbl"><thead><tr><th>추정 시세 \\ 차령</th>' + R.age_bands.map(function (b) { return '<th>' + esc(b.label) + '</th>'; }).join('') +
        '</tr></thead><tbody>';
      R.price_bands.forEach(function (p, i) {
        h += '<tr><td><b>' + esc(p.label) + '</b></td>';
        R.age_bands.forEach(function (a, j) {
          var base = R.rates[i][j], tv = cells[i] ? cells[i][j] : null, n = cnt[i] ? cnt[i][j] : null, nb = fill[i] && fill[i][j];
          var sub = (tv != null ? '초기 ' + f1(base) + ' · ' : '') + (nb ? '이웃 칸 값' : (n != null ? n.toLocaleString() + '대' : ''));
          if (S.edit) {
            h += '<td class="' + (tv != null ? 'is-team' : '') + '"><input class="v2-in v2-rin" data-cell="' + i + '|' + j + '" inputmode="decimal" autocomplete="off" value="' +
              (tv != null ? f1(tv) : '') + '" placeholder="' + f1(base) + '" aria-label="' + esc(p.label + ' · ' + a.label) + ' 환산 비율"><small>' + esc(sub) + '</small></td>';
          } else {
            h += '<td class="' + (tv != null ? 'is-team' : '') + '"><b>' + f1(tv != null ? tv : base) + '</b><small>' + esc(sub) + '</small></td>';
          }
        });
        h += '</tr>';
      });
      h += '</tbody></table></div><p class="v2-help">' + (S.edit ? '칸을 비우면 초기값을 씁니다. ' : '') + '강조된 칸은 팀이 고친 값입니다. 전체 평균 ' + f1(R.overall) + '%' +
        (R.recent ? ' · 최근(' + esc(R.recent.label) + ') ' + f1(R.recent.rate) + '%' : '') + '. 초기값 근거: ' + esc(R.basis || '') + '.</p></div>';
      return h;
    }

    function teamCard() {
      var list = S.edit ? S.edit.models : (S.team && S.team.models) || [];
      var h = '<div class="card"><div class="card-title">팀 수정 — 모델별 비율 <span class="hint">기준표·모델 예외보다 먼저 씁니다 · 연료를 비우면 그 모델 전체</span></div>';
      if (list.length) {
        h += '<div class="v2-tablewrap"><table class="t v2-tbl v2-mtbl"><thead><tr><th>제조사</th><th>세부모델</th><th>연료</th><th class="num">비율(%)</th><th>메모</th>' +
          (S.edit ? '<th></th>' : '<th>수정</th>') + '</tr></thead><tbody>';
        list.forEach(function (m, k) {
          h += '<tr><td>' + esc(m['제조사']) + '</td><td>' + esc(m['모델']) + '</td><td>' + esc(m['연료'] || '전체') + '</td>';
          if (S.edit) {
            h += '<td class="num"><input class="v2-in v2-rin" data-mrate="' + k + '" inputmode="decimal" value="' + f1(m['비율']) + '" aria-label="비율"></td>' +
              '<td><input class="v2-in" data-mmemo="' + k + '" value="' + esc(m['메모'] || '') + '" aria-label="메모"></td>' +
              '<td><button type="button" class="v2-btn" data-r="del" data-k="' + k + '">빼기</button></td></tr>';
          } else {
            h += '<td class="num"><b>' + f1(m['비율']) + '</b></td><td>' + esc(m['메모'] || '') + '</td><td class="v2-dim">' + esc((m['수정자'] || '') + ' ' + RatesStore.kst(m['수정일']).slice(0, 10)) + '</td></tr>';
          }
        });
        h += '</tbody></table></div>';
      } else h += '<p class="v2-kv">팀이 정한 모델별 비율이 없습니다.</p>';
      if (S.edit) {
        h += '<div class="v2-radd"><input class="v2-in" id="rAddModel" list="rModels" autocomplete="off" placeholder="세부모델 찾기 (예: 그랜저 IG)">' +
          '<select class="filter-select" id="rAddFuel" aria-label="연료"><option value="">연료 전체</option>' + FUELS.map(function (f) { return '<option>' + f + '</option>'; }).join('') + '</select>' +
          '<input class="v2-in v2-rin" id="rAddRate" inputmode="decimal" placeholder="비율 %">' +
          '<input class="v2-in" id="rAddMemo" autocomplete="off" placeholder="메모(선택)">' +
          '<button type="button" class="v2-btn" data-r="add">추가</button></div>' +
          '<datalist id="rModels">' + MODELS.map(function (m) { return '<option value="' + esc(m.label) + '"></option>'; }).join('') + '</datalist>';
      }
      return h + '</div>';
    }

    function exCard() {
      var ex = R.model_exceptions || [];
      var h = '<div class="card"><div class="card-title">모델 예외 — 데이터 <span class="hint">기준표 값에 더하거나 뺀다(%p) · 낙찰 100대 이상·차이 2%p 이상</span></div>';
      if (!ex.length) return h + '<p class="v2-kv">없습니다.</p></div>';
      h += '<div class="v2-tablewrap"><table class="t v2-tbl v2-mtbl"><thead><tr><th>제조사</th><th>세부모델</th><th>연료</th><th class="num">가감(%p)</th><th class="num">근거 대수</th></tr></thead><tbody>';
      ex.forEach(function (e) {
        h += '<tr><td>' + esc(e['제조사']) + '</td><td>' + esc(e['모델']) + '</td><td>' + esc(e['연료'] || '전체') + '</td><td class="num">' +
          (e['가감'] > 0 ? '+' : '') + f1(e['가감']) + '</td><td class="num">' + (e['대수'] != null ? e['대수'].toLocaleString() : '') + '</td></tr>';
      });
      return h + '</tbody></table></div><p class="v2-help">팀 수정(모델별 비율)에 같은 모델이 있으면 그쪽을 씁니다.</p></div>';
    }

    function logCard() {
      var log = (S.team && S.team.log) || [];
      var h = '<div class="card"><div class="card-title">변경 기록 <span class="hint">최근 100번 · 예전 판은 180일 보관</span></div>';
      if (!log.length) return h + '<p class="v2-kv">' + (S.store ? '아직 바뀐 것이 없습니다.' : '저장소 연결 후 쌓입니다.') + '</p></div>';
      h += '<ul class="v2-log">' + log.slice(0, 30).map(function (l) {
        return '<li><b>' + l.rev + '판</b> <span class="v2-dim">' + esc(RatesStore.kst(l.at)) + ' · ' + esc(l.by) + '</span>' + (l.note ? ' — ' + esc(l.note) : '') +
          '<br><span class="v2-dim">' + esc((l.what || []).join(' · ')) + '</span></li>';
      }).join('') + '</ul>';
      return h + '</div>';
    }

    function tryCard() {
      return '<div class="card"><div class="card-title">시험 계산 <span class="hint">지금 비율로 환산가가 얼마나 나오는지</span></div><div class="v2-rtry">' +
        '<label class="v2-f"><span class="v2-l">추정 시세(만원)</span><input class="v2-in" id="rTryPrice" inputmode="numeric" value="2000"></label>' +
        '<label class="v2-f"><span class="v2-l">차령(년)<em>올해 − 연식</em></span><input class="v2-in" id="rTryAge" inputmode="numeric" value="4"></label>' +
        '<label class="v2-f"><span class="v2-l">세부모델<em>선택</em></span><input class="v2-in" id="rTryModel" list="rModelsTry" autocomplete="off" placeholder="모델별 비율·예외 확인"></label>' +
        '<label class="v2-f"><span class="v2-l">연료<em>선택</em></span><select class="filter-select" id="rTryFuel"><option value="">—</option>' + FUELS.map(function (f) { return '<option>' + f + '</option>'; }).join('') + '</select></label>' +
        '</div><div class="v2-kv" id="rTryOut"></div><datalist id="rModelsTry">' + MODELS.map(function (m) { return '<option value="' + esc(m.label) + '"></option>'; }).join('') + '</datalist></div>';
    }
    function tryCalc() {
      var out = $('rTryOut');
      if (!out) return;
      var est = Number(String($('rTryPrice').value).replace(/[,\s만원]/g, '')), yrs = Number($('rTryAge').value), m = byLabel[$('rTryModel').value];
      if (!(est > 0) || !(yrs >= 0)) { out.textContent = '시세와 차령을 넣어 주세요'; return; }
      var cv = ctx.ENG.conversionRate(est, yrs, m ? m.maker : null, m ? m.model : null, $('rTryFuel').value || null);
      out.innerHTML = '환산 비율 <b>' + cv.rate + '%</b> (' + esc(cv.source) + ') → 환산가 <b>' + ctx.man(est * (1 - cv.rate / 100)) + '</b>만원';
    }

    function render() {
      if (!el) return;
      el.innerHTML = head() + tableCard() + teamCard() + '<div class="v2-two-col">' + tryCard() + exCard() + '</div>' + logCard() +
        '<p class="v2-help">적용 순서: 한 대 산정에서 직접 넣은 비율 → 팀 수정(모델별) → 모델 예외(기준표 값 ± 가감) → 호가대×차령 기준표(팀이 고친 칸 우선). ' +
          '기준표는 칸 가운데(호가대 가운데 만원 · 차령 가운데 해) 사이를 이어서 읽습니다 — 예: 추정 1,900만·6년이면 1~2천·2~3천, 5~6년·7~9년 네 칸을 거리만큼 섞어 씁니다. ' +
        '환산가 = 추정 시세 × (1 − 환산 비율) − 수리비.</p>';
      if (S.edit && $('rPw')) $('rPw').value = S.edit.password;   // 비밀번호는 화면 글(속성)에 남기지 않는다
      tryCalc();
    }

    // ───── 고치기 ─────
    function startEdit() {
      S.edit = { by: remember('by'), password: '', note: '', cells: teamCells().map(function (r) { return r.slice(); }),
        models: ((S.team && S.team.models) || []).map(function (m) { return Object.assign({}, m); }) };
      S.msg = '';
      render();
      var f = $(S.edit.by ? 'rPw' : 'rBy');
      if (f) f.focus();
    }
    function readForm() {                                    // 입력칸 → S.edit (다시 그리기 전에)
      if (!S.edit) return;
      ['by', 'password', 'note'].forEach(function (k, n) { var e = $(['rBy', 'rPw', 'rNote'][n]); if (e) S.edit[k] = e.value; });
      el.querySelectorAll('input[data-cell]').forEach(function (e) {
        var p = e.getAttribute('data-cell').split('|'), v = e.value.trim();
        S.edit.cells[+p[0]][+p[1]] = v === '' ? null : Number(v);
      });
      el.querySelectorAll('input[data-mrate]').forEach(function (e) { S.edit.models[+e.getAttribute('data-mrate')]['비율'] = e.value.trim() === '' ? null : Number(e.value); });
      el.querySelectorAll('input[data-mmemo]').forEach(function (e) { S.edit.models[+e.getAttribute('data-mmemo')]['메모'] = e.value; });
    }
    function addModel() {
      readForm();
      var m = byLabel[$('rAddModel').value], v = $('rAddRate').value.trim(), fuel = $('rAddFuel').value;
      if (!m) { S.msg = '세부모델을 목록에서 골라 주세요'; S.err = true; render(); return; }
      if (v === '' || !(Number(v) >= 0 && Number(v) <= 60)) { S.msg = '비율은 0~60(%) 사이 숫자로 넣어 주세요'; S.err = true; render(); return; }
      S.edit.models = S.edit.models.filter(function (x) { return !(x['제조사'] === m.maker && x['모델'] === m.model && (x['연료'] || '') === fuel); });
      S.edit.models.push({ '제조사': m.maker, '모델': m.model, '연료': fuel, '비율': Number(v), '메모': $('rAddMemo').value.trim() });
      S.msg = '';
      render();
    }
    function save() {
      readForm();
      var e = S.edit;
      if (!e.by.trim()) { S.msg = '이름을 넣어 주세요'; S.err = true; render(); return; }
      if (!e.password) { S.msg = '수정 비밀번호를 넣어 주세요'; S.err = true; render(); return; }
      var bad = [];
      e.cells.forEach(function (r) { r.forEach(function (v) { if (v != null && !(v >= 0 && v <= 60)) bad.push(v); }); });
      e.models.forEach(function (m) { if (m['비율'] == null || !(m['비율'] >= 0 && m['비율'] <= 60)) bad.push(m['모델']); });
      if (bad.length) { S.msg = '비율은 0~60(%) 사이 숫자로 넣어 주세요: ' + bad.slice(0, 3).join(', '); S.err = true; render(); return; }
      remember('by', e.by.trim());
      S.busy = true;
      render();
      RatesStore.save(API, { password: e.password, rev: S.team ? S.team.rev : 0, by: e.by.trim(), note: e.note, cells: e.cells, models: e.models })
        .then(function (team) {
          S.busy = false; S.edit = null; S.team = team; S.err = false;
          S.msg = team.rev + '판으로 저장했습니다. 지금 열린 산정 화면에도 바로 적용됩니다(묶음 산정은 [산정하기]를 다시 누르면 반영).';
          RatesStore.apply(R, team);
          ctx.changed();
          render();
        })
        .catch(function (err) {
          S.busy = false; S.err = true;
          if (err.status === 409) {                         // 다른 사람이 먼저 저장 — 새 판을 보여 주고 다시 고치게
            S.team = err.team; S.edit = null;
            RatesStore.apply(R, err.team);
            ctx.changed();
            S.msg = err.message + ' (지금 ' + (err.team ? err.team.rev : 0) + '판)';
          } else S.msg = err.message;
          if (S.edit && err.status === 401) S.edit.password = '';
          render();
        });
    }

    function onClick(e) {
      var b = e.target.closest('button[data-r]');
      if (!b || b.disabled) return;
      var a = b.getAttribute('data-r');
      if (a === 'edit') startEdit();
      else if (a === 'cancel') { S.edit = null; S.msg = ''; render(); }
      else if (a === 'save') save();
      else if (a === 'add') addModel();
      else if (a === 'del') { readForm(); S.edit.models.splice(+b.getAttribute('data-k'), 1); render(); }
      else if (a === 'reload') reload();
    }
    function onInput(e) { if (/^rTry/.test(e.target.id || '')) tryCalc(); }
    function onKey(e) { if (e.key === 'Enter' && /^rAdd/.test(e.target.id || '')) { e.preventDefault(); addModel(); } }

    function reload() {
      S.msg = '';
      return RatesStore.load(API).then(function (s) {
        S.loaded = true; S.store = s.store; S.writable = s.writable; S.team = s.team;
        RatesStore.apply(R, s.team);
        render();
      });
    }

    function show(container) {
      if (el !== container) {
        el = container;
        el.addEventListener('click', onClick);
        el.addEventListener('input', onInput);
        el.addEventListener('change', onInput);
        el.addEventListener('keydown', onKey);
      }
      S.loaded = !!ctx.store;
      if (ctx.store) { S.store = ctx.store.store; S.writable = ctx.store.writable; S.team = ctx.store.team; }
      render();
    }
    return { show: show, reload: reload };
  }

  var api = { create: create };
  root.V2Rates = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
