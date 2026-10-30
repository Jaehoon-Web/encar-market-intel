/*
 * data.js — 새 사이트(v2) 데이터 탭 (기획안 5.3: 내려받기 · 수집 현황 · 지표·산정 방법 · 한계)
 *
 * 내려받기 파일은 매주 파이프라인이 web/downloads 에 만든다(build_data.py 6종 + market_index.py 2종 + model_report.py 1종, 엑셀용 CP949).
 * 수집 현황은 market_index.json 의 crawls(목록 관측일·간격·목록/상세 대수·메모)를 그대로 보여 준다.
 *
 *   var D = V2Data.create(ctx);   D.show(el);
 */
(function (root) {
  'use strict';

  var FILES = [
    ['market_index.csv', '시황판 — 구분(전체·국산·수입 × 차급)별, 수집 회차별 시세·판매속도·재고·시황 지수와 재고·유입·판매', true],
    ['market_models.csv', '차종 비교 — 세부모델별 판매중·중앙 호가·인하 비율·최근 90일 판매·체류일·주간 판매율·시세(기준기간=100)', true],
    ['residual_curves.csv', '잔존율 — 세부모델·차급별 차령(년)별 잔존율(호가 ÷ 출고가) 가운데 값·25~75%·중앙 호가·대수(모델 리포트 감가 곡선)', true],
    ['listings_compact.csv', '현재 매물 — 판매중 매물 핵심 11개 열(매물ID·제조사·모델·등급·연식·주행·연료·차체·시도·판매가·잔존율)'],
    ['model_price_summary.csv', '모델별 시세 요약 — 매물 수와 가격 분위(P10~P90)·중앙 주행·연식'],
    ['manufacturer_summary.csv', '제조사별 요약 — 매물 수·중앙 시세·잔존율·평균 주행'],
    ['region_summary.csv', '지역(시도)별 요약 — 매물 수·중앙 시세·잔존율·주행'],
    ['trend_snapshots.csv', '수집 회차별 시장 집계 — 목록·상세 대수, 평균·중앙가, 유입·소진, 연료 비중'],
    ['history_accumulated.zip', '누적 이력 — 모든 수집 회차의 매물 기록(판매완료 포함, 가격 변동 추적용, zip 압축)']
  ];
  var TERMS = [
    ['시세 산정', [
      ['추정 시세', '대상 차와 비슷한 엔카 매물(판매중 + 최근 3개월 판매)의 호가를 조건 차이만큼 보정한 뒤, 비슷한 매물일수록 크게 쳐서 낸 가운데 값. 범위는 보정 후 가격의 25~75%. 엔카 소매 호가 기준이다.'],
      ['비교 매물 찾기', '같은 세부모델·등급·차령·주행·성능등급부터 찾고, 5대가 안 되면 조건을 한 단계씩 넓힌다(5단계).'],
      ['보정', '차령·주행·색상·렌트 번호판·등급 차이는 매주 데이터에서 추정한 계수로, 성능 상태는 자체 성능감가율로 맞춘다. 판매된 매물의 마지막 호가는 시세지수로 지금 시점에 맞춘다.'],
      ['신뢰도 A·B·C', 'A = 비교 매물 10대 이상·조건을 거의 넓히지 않음·범위 ±8% 안. B = 조건을 조금 넓힘. C = 같은 세부모델 전체로 넓힌 참고값.'],
      ['환산가', '추정 시세 × (1 − 환산 비율) − 수리비. 환산 비율은 경매 낙찰가와 같은 조건 엔카 호가의 차이로 정한 호가대×차령 기준표에서 찾고(칸 가운데 값 사이는 이어서 읽음), 모델 예외·팀 수정이 있으면 그 값을 쓴다.'],
      ['수리비', '입력한 예상 수리비를 추정 시세와 환산가에서 그대로 뺀다(학습값이 아님).']]],
    ['성능 상태', [
      ['성능감가율·성능등급', '성능·상태점검기록부의 부위(37곳)×상태(교환·판금·용접·절단·요철·손상·부식·흠집)가 가격에 주는 영향을 학습한 자체 점수. 감가율(%) → 점수 100 − 4×감가율 → 등급 9~1.'],
      ['사고 라벨', '손상 부위를 외판1·외판2·골격으로 나눠, 가장 높은 단계와 그 단계의 교환/판금으로 표시한다(예: 외판1·교환).'],
      ['글로비스 평가점', '글로비스 감점표를 재현한 감점합 → 종합평가점(9~1), 주요 골격 교환 → 사고평가점(A~F). 경매 평가표와 대조할 때 쓴다.'],
      ['상태 미상', '성능 상태를 넣지 않으면 성능 보정 없이 계산하고, 무사고라면 얼마인지 함께 보여 준다.']]],
    ['시장 시황', [
      ['시세지수', '새로 등록된 매물(7일 이내)의 첫 호가를 기준기간(7월 초) 같은 모델·등급·세부등급 신규 매물과 비교한 값. 차령·주행·성능 차이는 빼서 시장 요인만 남긴다. 7월 초 = 100.'],
      ['판매속도지수', '구간 동안 판매된 비율을 7일 기준으로 맞춰 기준기간과 비교한 값. 수집 간격이 5~16일인 구간만 계산한다.'],
      ['재고지수', '엔카 목록의 매물 수(중복 제거)를 기준기간 평균과 비교한 값. 높을수록 공급이 많다.'],
      ['시황지수', '시세 · 판매속도 · (10000 ÷ 재고)의 기하평균. 102 이상 강세(판매자 우위), 98 이하 약세, 그 사이 보합.'],
      ['판매중 재고·유입·판매', '상세까지 확인한 매물 기준. 유입 = 직전 수집 뒤 엔카에 등록된 매물, 판매 = 목록에서 사라진 매물(재등록 제외). 주간 값은 구간 값을 7일 기준으로 맞춘 값.'],
      ['체류일·인하 매물(첫 호가 대비)', '체류일 = 엔카 등록부터 사라질 때까지 일수(최근 90일 판매의 가운데 값). 인하 매물 비율 = 첫 호가보다 지금 호가가 낮은 판매중 매물의 비율(시장 시황 차종 비교·모델 리포트).']]],
    ['마켓 펄스 · 모델 리포트', [
      ['같은 매물 가격 변화 · 이번 주 인하', '지난주와 이번 주 목록에 모두 있고 상세까지 확인한 판매중 매물의 호가 변화(더미가·인수금 의심·가격 이상·핵심 결측·중복 매물과, 한 주에 호가가 절반 아래·2배 넘게 바뀐 관측은 뺌). ' +
        '이번 주 인하 = 그중 값을 내린 매물의 비율, 인하 폭 = 내린 매물의 가운데 값. 큰 숫자(금액 가중) = 이번 주 호가 합 ÷ 지난주 호가 합 − 1.'],
      ['주간 판매율 · 재고 소진 주수', '구간 동안 팔린 매물 ÷ 구간 시작 판매중 매물을 7일 기준으로 맞춘 비율. 소진 주수 = 1 ÷ 주간 판매율(지금 재고가 다 팔리는 데 걸리는 주).'],
      ['주목할 모델', '판매중 100대 이상 세부모델 가운데 주간 판매율이 같은 차급(국산·수입 구분)의 1.15배 이상(빨리 팔리는)·0.87배 이하(쌓이는, 재고 소진 주수가 긴 순) 모델과, ' +
        '1주 시세 변화가 흔들림(신규 매물 수로 생기는 표준오차)의 2배와 0.5를 모두 넘는 모델(가격 내리는·오르는).'],
      ['잔존율 · 감가 곡선', '잔존율 = 지금 호가 ÷ 출고가(엔카 표기). 판매중 매물을 차령(년)별로 나눠 가운데 값과 25~75% 범위를 그린다. 미래 예측이 아니라 지금 시장의 차령별 가치다.'],
      ['잔존가치 지수', '같은 차급·구분·차령 매물의 잔존율 가운데 값 = 100으로 둔 이 모델의 상대값. 100보다 크면 같은 연식의 차급 평균보다 값을 잘 지킨다.'],
      ['이상 의심 매물', '그 매물을 빼고 나머지 비교 매물로 추정한 시세의 75%에 못 미치는 호가(신뢰도 A·B만). 이상 매물을 걸러내는 용도다(사고·상태 차이나 호가 입력 오류일 수 있어 확인 필요). ' +
        '시세 산정 근거 표의 "이상치"(비교 매물 가운데 값에서 크게 벗어난 비교 매물을 계산에서 빼는 규칙)와는 다른 기준이다.'],
      ['오래 안 팔리는 매물', '엔카에 올라온 지 1년(365일) 이상 지났는데 아직 판매중이고, 첫 호가보다 값을 내린 매물(다시 올린 매물은 처음 올린 날부터 센다).']]]
  ];
  var LIMITS = [
    '시세는 엔카에 올라온 **소매 호가** 기준이다. 실제 거래가가 아니다. 경매 기준 가격은 환산가로 본다.',
    '"판매"는 목록에서 사라진 것으로 추정한다. 판매자가 지운 매물도 섞일 수 있다(재등록은 뺌).',
    '옵션 데이터는 쓰지 않는다. 세부등급은 매물의 절반 정도만 채워져 있어 필수 조건이 아니라 가산점으로만 쓴다.',
    '국산 쉐보레(GM대우)는 10/28 수집까지 목록 조회에서 빠져 있었다(전기차만 들어옴). 11/4 수집부터 받으므로, 그 전까지는 이 모델의 비교 매물이 없거나 적다.',
    '시장 시황의 지수와 흐름, 마켓 펄스의 판매중·신규·판매·판매율은 7월(기준기간)과 같은 수집 범위로 센다. 11/4부터 더 받는 국산 쉐보레·일부 수입 브랜드(약 7.4천 대)는 시세 산정·차종 비교·모델 리포트·마켓 펄스의 주목할 모델과 같은 매물 가격 변화에만 들어간다. 시트로엥/DS 등 수입 일부(약 400대)는 아직 조회에서 빠져 있다.',
    '목록에는 있지만 상세가 없는 매물(목록의 약 3분의 1)은 대부분 같은 차를 다시 올린 중복 매물로 보인다. 상세가 없는 매물은 성능 상태가 없어 시세 비교에서 빠진다.',
    '7/29~10/28 목록은 광주·전남 매물 대부분이 새 지역값(전남광주)으로 바뀌어 빠졌다(10/28 실측 7,000대). 11/4 수집부터 다시 받는다. 10/21·10/28 재고지수에는 실측 누락 대수를 더해 보정했고(시황판 "보정"), 7/30 재고지수는 계산에서 뺐다. 판매중 재고·신규 유입·판매는 그만큼 낮게 나온다.',
    '화물차(포터·봉고 트럭 등)는 수집하지 않는다. 묶음 산정에서 "차명 못 찾음"으로 나온다.',
    '수집이 끊긴 구간(7/30 → 10/21, 83일)은 판매속도를 계산하지 않고, 그 구간의 주간 유입·판매는 실제보다 낮게 나온다.',
    '추세는 주간 수집이 이어질수록 정확해진다. 3개월 추세가 다 차려면 13주 연속 수집이 필요하다.',
    '마켓 펄스의 지난주 대비는 수집 간격이 5~16일로 이어진 주만 낸다. 10/21은 83일 공백 뒤 첫 회차라 판매·판매율·같은 매물 가격 변화는 11/4, 신규 유입은 11/11 수집부터 나온다(전남광주가 다시 들어오는 주에는 판매중·신규·판매를 한 주 쉰다). 같은 매물 가격 변화는 10/21부터 쌓인 목록 가격으로 계산한다.',
    '잔존율의 출고가는 엔카에 적힌 값이다(옵션 포함 여부가 매물마다 다를 수 있어, 1년 안 된 차는 잔존율이 100%를 넘기도 한다). 출고가가 없는 매물(판매중의 약 5%)은 잔존율·잔존가치 지수 계산에서 빠진다.'
  ];

  function create(ctx) {
    var MI = ctx.X.mi, esc = ctx.esc, el = null, sizes = {}, DL = (ctx.root || '../') + 'downloads/';   // 사이트 뿌리는 app.js가 준다

    function md(s) { return (+s.slice(5, 7)) + '/' + (+s.slice(8, 10)); }
    function kb(n) { return n == null ? '' : n >= 1048576 ? (n / 1048576).toFixed(1) + 'MB' : Math.max(1, Math.round(n / 1024)) + 'KB'; }
    function bold(s) { return esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>'); }

    function downloads() {
      var h = '<div class="card"><div class="card-title">내려받기 <span class="hint">매주 수집 뒤 새로 만든다 · 엑셀에서 바로 열리게 CP949로 저장</span></div>' +
        '<div class="v2-tablewrap"><table class="t v2-tbl v2-dl"><thead><tr><th>파일</th><th>내용</th><th class="num">크기</th><th></th></tr></thead><tbody>';
      FILES.forEach(function (f) {
        h += '<tr><td><b>' + esc(f[0]) + '</b>' + (f[2] ? ' <span class="v2-new">새</span>' : '') + '</td><td class="v2-desc">' + esc(f[1]) + '</td>' +
          '<td class="num" data-size="' + esc(f[0]) + '">' + kb(sizes[f[0]]) + '</td>' +
          '<td><a class="v2-btn" href="' + DL + encodeURIComponent(f[0]) + '" download>내려받기</a></td></tr>';
      });
      return h + '</tbody></table></div><p class="v2-help">시세 산정·모델 요약·묶음 산정·차종 비교 화면의 [엑셀 내려받기]는 그 화면에서 보는 조건 그대로 만든다.</p></div>';
    }

    function crawls() {
      var c = MI.crawls.slice().reverse();
      var h = '<div class="card"><div class="card-title">수집 현황 <span class="hint">수집 회차별 · 날짜는 목록을 받은 날 · 최근이 위</span></div>' +
        '<div class="v2-tablewrap"><table class="t v2-tbl v2-crawl"><thead><tr><th>목록 관측일</th><th class="num">직전 간격</th><th class="num">목록 매물</th>' +
        '<th class="num">상세 확인(판매중)</th><th class="num">상세 확인 비율</th><th>메모</th></tr></thead><tbody>';
      c.forEach(function (x) {
        var gap = x.gap_days, warn = gap != null && gap > 10, ratio = x.list && x.detail != null ? x.detail / x.list : null;
        h += '<tr><td><b>' + esc(x.date) + '</b>' + (x.crawl !== x.date ? '<small class="v2-dim"> (기록 ' + md(x.crawl) + ')</small>' : '') + '</td>' +
          '<td class="num' + (warn ? ' v2-warnc' : '') + '">' + (gap == null ? '첫 수집' : gap + '일') + '</td>' +
          '<td class="num">' + (x.list != null ? x.list.toLocaleString('ko-KR') : '–') + '</td>' +
          '<td class="num">' + (x.detail != null ? x.detail.toLocaleString('ko-KR') : '–') + '</td>' +
          '<td class="num">' + (ratio != null ? (ratio * 100).toFixed(1) + '%' : '–') + '</td>' +
          '<td class="v2-desc">' + esc(x.note || '') + '</td></tr>';
      });
      return h + '</tbody></table></div><p class="v2-help">목록 매물 = 엔카 목록 조회로 받은 매물 수(판매 표시가 남은 매물 포함). 상세 확인 = 상세 화면까지 받아 판매중으로 확인한 매물. ' +
        '간격이 10일을 넘으면 공백으로 표시하고, 시장 시황의 판매속도는 5~16일 간격만 계산한다.</p></div>';
    }

    function terms() {
      var h = '<div class="card"><div class="card-title">지표·산정 방법</div><div class="v2-terms">';
      TERMS.forEach(function (g) {
        h += '<div><div class="v2-sub">' + esc(g[0]) + '</div><dl>' + g[1].map(function (t) {
          return '<dt>' + esc(t[0]) + '</dt><dd>' + esc(t[1]) + '</dd>';
        }).join('') + '</dl></div>';
      });
      return h + '</div><p class="v2-help">더 자세한 정의는 저장소의 기획안(7장 지표·산정 로직 사전)과 전처리 명세에 있다.</p></div>';
    }

    function limits() {
      return '<div class="card"><div class="card-title">알고 쓰면 좋은 한계</div><ul class="v2-notes">' +
        LIMITS.map(function (t) { return '<li>' + bold(t) + '</li>'; }).join('') + '</ul></div>';
    }

    function setSize(name, n) {
      sizes[name] = n;
      var td = el && el.querySelector('td[data-size="' + name + '"]');
      if (td) td.textContent = kb(n);
    }
    function fetchSizes() {                                  // 파일 크기 — 파이프라인이 적은 downloads.json, 없으면 응답 머리글(content-length)
      ctx.getJSON('downloads.json').then(function (j) {
        (j.files || []).forEach(function (f) { setSize(f.name, f.bytes); });
      }).catch(function () {}).then(headSizes);
    }
    function headSizes() {
      FILES.forEach(function (f) {
        if (sizes[f[0]] != null) return;
        fetch(DL + encodeURIComponent(f[0]), { method: 'HEAD', cache: 'no-store' }).then(function (r) {
          var n = Number(r.headers.get('content-length'));
          if (r.ok && n) setSize(f[0], n);
        }).catch(function () {});
      });
    }

    function show(container) {
      el = container;
      el.innerHTML = '<div class="card v2-headcard"><div class="v2-head">데이터<br><span class="sub">기준 ' + esc(MI.crawls[MI.crawls.length - 1].date) +
        ' 목록 · 엔카 매물을 매주 수집해 만든다(수요일 09:00 자동)</span></div></div>' + downloads() + crawls() + terms() + limits();
      fetchSizes();
    }
    return { show: show };
  }

  var api = { create: create };
  root.V2Data = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
