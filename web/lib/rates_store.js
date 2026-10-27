/*
 * rates_store.js — 환산 비율 팀 공용 저장소 읽기·쓰기 (기획안 5.1.6 · D6)
 *
 * 초기값(경매 갭 분석 요약치)은 정적 파일 data/conversion_rates.json, 팀이 고친 것만 사이트 저장소(/api/rates, worker/index.js)에 둔다.
 * 저장소가 아직 없으면(정적 배포·로컬 미리보기) 초기값만 쓰고 수정은 막는다.
 *
 *   RatesStore.load('/api/rates').then(function (s) { s.store; s.writable; s.team; });   // 실패해도 { store: false }
 *   RatesStore.apply(rates, team);   // rates(초기값 객체)에 팀 수정을 합친다 → PriceEngine 이 그대로 읽는다
 *   RatesStore.save('/api/rates', { password, rev, by, note, cells, models }) → Promise(새 team)  · 실패 시 Error(status·team)
 */
(function (root) {
  'use strict';

  function load(api) {
    return fetch(api, { cache: 'no-store' }).then(function (r) {
      var ct = r.headers.get('content-type') || '';
      if (!r.ok || ct.indexOf('application/json') < 0) return { store: false, writable: false, team: null };   // 정적 배포는 index.html 이 올 수 있다
      return r.json().then(function (j) { return { store: !!j.store, writable: !!j.writable, team: j.team || null }; });
    }).catch(function () { return { store: false, writable: false, team: null }; });
  }

  // 팀 수정 합치기: 모델별 비율(연료를 적은 규칙 먼저) · 팀이 고친 기준표 칸 · 판 정보
  function apply(rates, team) {
    var models = (team && team.models || []).slice();
    models.sort(function (a, b) { return (b['연료'] ? 1 : 0) - (a['연료'] ? 1 : 0); });
    rates.team_models = models;
    rates.team_cells = team && team.cells ? team.cells : null;
    rates.team_rev = team ? team.rev : 0;
    rates.team_updated_at = team ? team.updated_at : null;
    rates.team_updated_by = team ? team.updated_by : null;
    return rates;
  }

  function save(api, body) {
    return fetch(api, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (r.ok && j.ok) return j.team;
          var e = new Error(j.error || '저장하지 못했습니다(' + r.status + ')');
          e.status = r.status;
          e.team = j.team || null;
          throw e;
        });
      });
  }

  function kst(iso) {                                       // 저장 시각(UTC) → 한국 시각 "2026-10-28 10:12"
    var t = Date.parse(iso);
    return isFinite(t) ? new Date(t + 9 * 3600e3).toISOString().slice(0, 16).replace('T', ' ') : '';
  }

  // 판 설명 한 줄: "2026-10-26 초기값 + 팀 수정 3판(2026-10-28 10:12 권재훈)"
  function label(rates) {
    var s = rates.version + ' 초기값';
    if (rates.team_rev) s += ' + 팀 수정 ' + rates.team_rev + '판(' + kst(rates.team_updated_at) + ' ' + (rates.team_updated_by || '') + ')';
    return s;
  }

  var api = { load: load, apply: apply, save: save, label: label, kst: kst };
  root.RatesStore = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
