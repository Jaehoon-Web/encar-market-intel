/* ============================================================
   ENCAR MARKET INTEL — SPA (vanilla JS · Chart.js)
   디자인: SKR Nike-DNA 라이트(웜 베이지) 계승
   데이터: web/data/*.json (실데이터 집계, L0 재고 / L2 시세)
   ============================================================ */
(() => {
  'use strict';

  // ----- 전역 데이터 -----
  const DATA = {};
  const charts = [];
  const track = c => { charts.push(c); return c; };
  const disposeCharts = () => { while (charts.length) { try { charts.pop().destroy(); } catch (e) {} } };

  // ----- 팔레트 (reference와 동일 톤) -----
  const PAL = {
    accent: '#C85A2A', accentW: 'rgba(200,90,42,0.16)',
    blue: '#3A7AAF', purple: '#7D5AA8', green: '#3E8B4C',
    muted: '#9A9286', up: '#3E8B4C', down: '#B54453', warn: '#C89A2E',
    grid: '#E2D8BE', axis: '#6B655C', fg: '#1C1915', card: '#FFFFFF',
  };
  // 디멘젼 차트용 순환 팔레트
  const SERIES = ['#C85A2A','#3A7AAF','#3E8B4C','#7D5AA8','#C89A2E','#B54453','#5B8C9E','#A0703C','#6B8E5A','#9A9286','#806A9E','#3D6E8C','#B07A3A','#7A9A6E'];
  const withAlpha = (hex, a) => {
    const h = hex.replace('#',''); const r = parseInt(h.substr(0,2),16), g = parseInt(h.substr(2,2),16), b = parseInt(h.substr(4,2),16);
    return `rgba(${r},${g},${b},${a})`;
  };

  // ----- 포맷 헬퍼 -----
  const nf = n => (n == null || isNaN(n)) ? '–' : Number(n).toLocaleString('ko-KR');
  const won = v => {                       // 만원 단위 값 → 보기 좋은 문자열
    if (v == null || isNaN(v)) return '–';
    v = Math.round(v);
    if (v >= 10000) { const eok = Math.floor(v/10000); const man = v % 10000; return man ? `${eok}억 ${nf(man)}만` : `${eok}억`; }
    return `${nf(v)}만`;
  };
  const pct = v => (v == null || isNaN(v)) ? '–' : `${Number(v).toFixed(1)}%`;
  const kmF = v => (v == null || isNaN(v)) ? '–' : `${nf(Math.round(v/1000))},${String(Math.round(v%1000)).padStart(3,'0')}`.replace(/,(\d{3})$/, (m,p)=>p==='000'?',000':m) ;
  const kmShort = v => (v == null || isNaN(v)) ? '–' : `${(v/10000).toFixed(1)}만km`;

  // ----- DOM 헬퍼 -----
  const app = () => document.getElementById('app');
  const mount = html => { const t = document.createElement('template'); t.innerHTML = html.trim(); const a = app(); a.innerHTML = ''; while (t.content.firstChild) a.appendChild(t.content.firstChild); };
  const $ = (sel, root) => (root||document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root||document).querySelectorAll(sel));

  // ============================================================
  // 라우트 정의
  // ============================================================
  const ROUTES = [
    { hash: '#/overview',  title: '시장 개요',     render: renderOverview },
    { hash: '#/inventory', title: '시장 재고',     render: renderInventory, badge: 'CORE' },
    { hash: '#/trend',     title: '시기별 트렌드', render: renderTrend },
    { hash: '#/lookup',    title: '시세 조회',     render: renderLookup, badge: 'PRO' },
    { hash: '#/model',     title: '모델 분석',     render: renderModel },
    { hash: '#/insights',  title: '인사이트',      render: renderInsights },
    { hash: '#/download',  title: '데이터',        render: renderDownload },
  ];

  function renderNav() {
    const cur = location.hash || '#/overview';
    const bs = { CORE: 'rgba(200,90,42,0.15);color:#C85A2A', NEW: 'rgba(62,139,76,0.15);color:#3E8B4C', PRO: 'rgba(58,122,175,0.15);color:#3A7AAF' };
    $('#mainNav').innerHTML = ROUTES.map(r => `
      <a class="nav-tab ${r.hash===cur?'on':''}" href="${r.hash}">
        <span>${r.title}</span>
        ${r.badge ? `<span class="badge" style="background:${bs[r.badge]}">${r.badge}</span>` : ''}
      </a>`).join('');
  }

  function route() {
    disposeCharts();
    renderNav();
    const r = ROUTES.find(x => x.hash === (location.hash || '#/overview')) || ROUTES[0];
    try { r.render(); } catch (e) { console.error(e); app().innerHTML = `<div class="card" style="color:var(--down)">렌더 오류: ${e.message}</div>`; }
    window.scrollTo(0, 0);
  }

  // ============================================================
  // Chart.js 공통 옵션
  // ============================================================
  function setupChartDefaults() {
    Chart.defaults.color = '#3D3832';
    Chart.defaults.font.family = 'Inter, Pretendard Variable, Pretendard, system-ui, sans-serif';
    Chart.defaults.font.size = 13;
    Chart.defaults.font.weight = 500;
    Chart.defaults.borderColor = PAL.grid;
    Chart.defaults.plugins.legend.position = 'bottom';
    Chart.defaults.plugins.legend.align = 'start';
    Chart.defaults.plugins.legend.labels.usePointStyle = true;
    Chart.defaults.plugins.legend.labels.pointStyle = 'circle';
    Chart.defaults.plugins.legend.labels.boxWidth = 13;
    Chart.defaults.plugins.legend.labels.padding = 14;
    Chart.defaults.plugins.legend.labels.font = { size: 13, weight: 600 };
    Chart.defaults.plugins.legend.labels.color = PAL.fg;
    Chart.defaults.plugins.tooltip.backgroundColor = '#FFFFFF';
    Chart.defaults.plugins.tooltip.titleColor = PAL.fg;
    Chart.defaults.plugins.tooltip.bodyColor = PAL.fg;
    Chart.defaults.plugins.tooltip.borderColor = PAL.grid;
    Chart.defaults.plugins.tooltip.borderWidth = 1;
    Chart.defaults.plugins.tooltip.padding = 10;
  }
  const axX = (opts={}) => Object.assign({ grid: { display: false }, ticks: { color: PAL.axis, font: { size: 12, weight: 500 } } }, opts);
  const axY = (opts={}) => Object.assign({ grid: { color: PAL.grid }, ticks: { color: PAL.axis, font: { size: 12 } } }, opts);
  const barChart = (ctx, labels, data, { color=PAL.accent, horizontal=false, label='', valueFmt=null, multi=null }={}) => {
    const datasets = multi || [{ label, data, backgroundColor: Array.isArray(color)?color:data.map((_,i)=>color), borderRadius: 3, borderWidth: 0 }];
    return track(new Chart(ctx, {
      type: 'bar',
      data: { labels, datasets },
      options: {
        indexAxis: horizontal ? 'y' : 'x',
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: !!multi },
          tooltip: { callbacks: valueFmt ? { label: c => `${c.dataset.label||''} ${valueFmt(c.parsed[horizontal?'x':'y'])}` } : {} } },
        scales: horizontal
          ? { x: axY({ beginAtZero:true }), y: axX() }
          : { x: axX(), y: axY({ beginAtZero:true }) }
      }
    }));
  };

  // ============================================================
  // 공통 컴포넌트
  // ============================================================
  const srcBadge = lv => lv==='L0'
    ? '<span class="src-badge src-l0" title="전체 재고 · ids_all">재고 L0</span>'
    : lv==='HIST'
    ? '<span class="src-badge" style="background:rgba(125,90,168,0.14);color:#7D5AA8;border:1px solid rgba(125,90,168,0.35)" title="누적 이력 · history">누적 이력</span>'
    : '<span class="src-badge src-l2" title="정제 시세 · cleaned">시세 L2</span>';

  const kpiCard = (label, value, unit, sub, src) => `
    <div class="card">
      <div class="card-title">${label} ${src?srcBadge(src):''}</div>
      <div class="flex items-baseline gap-1 mt-2">
        <div class="kpi-value">${value}</div><div class="text-xs" style="color:var(--tx-3)">${unit||''}</div>
      </div>
      ${sub?`<div class="text-[12px] mt-2" style="color:var(--tx-3)">${sub}</div>`:''}
    </div>`;

  const barlines = (rows, valFmt, maxKey='count') => {
    const max = Math.max(...rows.map(r => r[maxKey] || 0)) || 1;
    return rows.map((r,i) => `
      <div class="barline">
        <div class="bl-label">${r.key}</div>
        <div class="bl-track"><div class="bl-fill" style="width:${(r[maxKey]/max*100).toFixed(1)}%;background:${SERIES[i%SERIES.length]}"></div></div>
        <div class="bl-val">${valFmt(r)}</div>
      </div>`).join('');
  };

  function heatmap(cols, rows, getCells, getLabel) {
    const all = rows.flatMap(getCells);
    const max = Math.max(...all, 1);
    const color = v => { const t = Math.sqrt(v/max); return withAlpha(PAL.accent, 0.08 + t*0.82); };
    let h = `<div class="grid gap-1" style="grid-template-columns: 92px repeat(${cols.length}, 1fr); overflow-x:auto">`;
    h += '<div></div>' + cols.map(c => `<div class="text-[11px] text-center py-1" style="color:var(--tx-3);font-weight:600">${c}</div>`).join('');
    rows.forEach(r => {
      h += `<div class="text-[12px] py-2" style="color:var(--tx-2);font-weight:600;white-space:nowrap">${getLabel(r)}</div>`;
      getCells(r).forEach(v => { h += `<div class="heat-cell" style="background:${color(v)}">${v?nf(v):''}</div>`; });
    });
    h += '</div>';
    return h;
  }

  // ============================================================
  // 1. 시장 개요
  // ============================================================
  function renderOverview() {
    const inv = DATA.inventory, pr = DATA.pricing, meta = DATA.meta;
    const cat = Object.fromEntries(inv.byCategory.map(c => [c.key, c.count]));
    const makers = inv.dims.manufacturer.filter(m => m.key !== '기타').slice(0, 10);
    const fuels = inv.dims.fuel;
    const topModels = inv.dims.model.filter(m => m.key !== '기타').slice(0, 10);

    mount(`
      <section class="grid grid-cols-12 gap-4 mb-4">
        <div class="col-span-12 lg:col-span-8 hero-index">
          <div class="text-xs font-medium flex items-center gap-2" style="color:var(--tx-3)">
            전체 시장 재고 (Market Inventory) ${srcBadge('L0')}
            <span class="tag tag-live">SNAPSHOT</span>
          </div>
          <div class="text-[11px] mt-0.5" style="color:var(--tx-3)">데이터 수집일 ${meta.collectedDate||meta.asOf} · 최신 매물 등록 ${meta.asOf} · 엔카 전체 매물 목록</div>
          <div class="flex items-baseline gap-4 mt-4">
            <div class="hero-value">${nf(inv.total)}</div>
            <div class="text-sm" style="color:var(--tx-3)">대</div>
          </div>
          <div class="grid grid-cols-3 gap-2 mt-6">
            ${[['국산', cat['국산'], PAL.accent], ['수입', cat['수입'], PAL.blue], ['미분류', cat['기타']||0, PAL.muted]].map(([k,v,c]) => `
              <div class="rounded-lg border px-3 py-3" style="border-color:var(--line);background:var(--bg-2)">
                <div class="text-[11px] font-semibold tracking-wider" style="color:var(--tx-3)">${k}</div>
                <div class="text-2xl font-bold mt-1" style="color:${c}">${nf(v)}<span class="text-xs" style="color:var(--tx-3)"> 대</span></div>
                <div class="text-[11px] mt-0.5" style="color:var(--tx-4)">${(v/inv.total*100).toFixed(1)}%</div>
              </div>`).join('')}
          </div>
          <div class="text-[11px] mt-3" style="color:var(--tx-3)">
            <span class="src-badge src-l0" style="background:rgba(62,139,76,0.12);color:#3E8B4C;border-color:rgba(62,139,76,0.3)">친환경</span>
            <b style="color:var(--green,#3E8B4C)"> ${nf(inv.greenCount)}대</b> (${(inv.greenCount/inv.total*100).toFixed(1)}%) — 전기·하이브리드 등, 국산·수입에 <b>교차 포함</b>
          </div>
        </div>
        <div class="col-span-12 lg:col-span-4 card">
          <div class="card-title">정제 시세 데이터 ${srcBadge('L2')}</div>
          <div class="card-sub">더미·이상치 제거 후 시세 분석 대상</div>
          <div class="flex items-baseline gap-3 mt-4">
            <div class="text-4xl font-bold" style="color:var(--accent)">${nf(pr.count)}</div><div class="text-sm" style="color:var(--tx-3)">대</div>
          </div>
          <div class="mt-4 text-[12px]">
            <div class="flex justify-between py-1.5" style="border-bottom:1px solid var(--line)"><span style="color:var(--tx-3)">평균 판매가</span><b>${won(pr.avgPrice)}원</b></div>
            <div class="flex justify-between py-1.5" style="border-bottom:1px solid var(--line)"><span style="color:var(--tx-3)">중앙 판매가</span><b>${won(pr.medPrice)}원</b></div>
            <div class="flex justify-between py-1.5" style="border-bottom:1px solid var(--line)"><span style="color:var(--tx-3)">평균 연식</span><b>${pr.avgYear}년</b></div>
            <div class="flex justify-between py-1.5"><span style="color:var(--tx-3)">평균 잔존율</span><b style="color:var(--accent)">${pct(pr.avgResidual)}</b></div>
          </div>
        </div>
      </section>

      <div class="divider-label">핵심 지표</div>
      <section class="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
        ${kpiCard('전체 재고', nf(inv.total), '대', `국산 ${(cat['국산']/inv.total*100).toFixed(0)}% · 수입 ${(cat['수입']/inv.total*100).toFixed(0)}%`, 'L0')}
        ${kpiCard('제조사 수', nf(meta.manufacturerCount), '개사', `분석 모델 ${nf(meta.modelCount)}종`, 'L2')}
        ${kpiCard('중앙 시세', won(pr.medPrice).replace('만',''), '만원', `평균 ${won(pr.avgPrice)}원`, 'L2')}
        ${kpiCard('평균 잔존율', pr.avgResidual, '%', '출고가 대비 판매가', 'L2')}
      </section>

      <section class="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
        <div class="card">
          <div class="card-title mb-3">제조사별 재고 TOP 10 ${srcBadge('L0')}</div>
          <div style="height:300px"><canvas id="ovMaker"></canvas></div>
        </div>
        <div class="card">
          <div class="card-title mb-3">연료별 재고 비중 ${srcBadge('L0')}</div>
          <div style="height:300px"><canvas id="ovFuel"></canvas></div>
        </div>
      </section>

      <div class="divider-label">재고 많은 모델 TOP 10</div>
      <section class="card mb-4">
        <table class="t">
          <thead><tr><th style="width:32px"></th><th>모델</th><th class="num">재고 대수</th><th class="num">비중</th><th class="num">중앙 시세(L0)</th></tr></thead>
          <tbody>
            ${topModels.map((m,i) => `
              <tr>
                <td style="color:var(--tx-4)" class="text-xs">${i+1}</td>
                <td class="font-medium">${m.key}</td>
                <td class="num">${nf(m.count)}</td>
                <td class="num" style="color:var(--tx-3)">${(m.count/inv.total*100).toFixed(1)}%</td>
                <td class="num">${m.medPrice?won(m.medPrice)+'원':'–'}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </section>

      <div class="notebox">
        <b>📌 데이터 레이어 안내.</b> 재고·점유·분포 지표는 <b>전체 매물(L0, ${nf(inv.total)}대)</b> 기준,
        시세·가격·잔존율 지표는 <b>정제 데이터(L2, ${nf(pr.count)}대)</b> 기준으로 산출됩니다.
        시세 분위수는 리스승계 인수금·placeholder 매물 <b>${nf(meta.depositExcluded||0)}건</b>을 제외한 <b>${nf(meta.priceSampleTotal||pr.count)}대</b> 표본으로 계산합니다.
        본 데이터는 <b>${meta.collectedDate||meta.asOf} 수집 스냅샷</b>(최신 매물 등록 ${meta.asOf})이며, 실시간 매물 현황과 다를 수 있습니다.
      </div>
    `);

    barChart($('#ovMaker'), makers.map(m=>m.key), makers.map(m=>m.count),
      { horizontal: true, label: '재고', valueFmt: v => nf(v)+'대' });

    track(new Chart($('#ovFuel'), {
      type: 'doughnut',
      data: { labels: fuels.map(f=>f.key), datasets: [{ data: fuels.map(f=>f.count), backgroundColor: SERIES, borderColor: '#fff', borderWidth: 2 }] },
      options: { responsive:true, maintainAspectRatio:false, cutout: '58%',
        plugins: { legend: { position:'right' }, tooltip: { callbacks: { label: c => ` ${c.label}: ${nf(c.parsed)}대 (${(c.parsed/inv.total*100).toFixed(1)}%)` } } } }
    }));
  }

  // ============================================================
  // 2. 시장 재고 (CORE)
  // ============================================================
  const INV_DIMS = [
    { key: 'manufacturer', label: '제조사', kind: 'bar' },
    { key: 'model', label: '모델', kind: 'bar' },
    { key: 'fuel', label: '연료', kind: 'donut' },
    { key: 'sido', label: '지역', kind: 'bar' },
    { key: 'yearBucket', label: '연식', kind: 'bar' },
    { key: 'priceBucket', label: '가격대', kind: 'bar' },
    { key: 'mileageBucket', label: '주행거리', kind: 'bar' },
  ];
  let invDim = 'manufacturer';

  function renderInventory() {
    const inv = DATA.inventory, meta = DATA.meta;
    mount(`
      <section class="card mb-4">
        <div class="flex items-center justify-between mb-1 flex-wrap gap-2">
          <div class="card-title">디멘젼별 재고 현황 ${srcBadge('L0')}</div>
          <div class="text-[11px]" style="color:var(--tx-3)">데이터 수집일 ${meta.collectedDate||meta.asOf} · 전체 ${nf(inv.total)}대</div>
        </div>
        <div class="card-sub mb-3">분석 축(디멘젼)을 선택하면 해당 기준으로 재고를 분해합니다</div>
        <div class="dim-bar mb-4" id="dimBar">
          ${INV_DIMS.map(d => `<button class="seg-chip ${d.key===invDim?'on':''}" data-dim="${d.key}">${d.label}</button>`).join('')}
        </div>
        <div class="grid grid-cols-1 lg:grid-cols-3 gap-5">
          <div class="lg:col-span-2" style="height:360px"><canvas id="invChart"></canvas></div>
          <div class="self-start">
            <div class="text-[11px] font-semibold tracking-wider mb-2" style="color:var(--tx-3)">상세 (재고 · 중앙시세)</div>
            <div id="invTable" style="max-height:340px;overflow-y:auto"></div>
          </div>
        </div>
      </section>

      <div class="divider-label">교차 분석 · 제조사 × 가격대 (재고 히트맵)</div>
      <section class="card mb-4">
        <div class="card-sub mb-3">색이 진할수록 해당 제조사·가격대 조합의 재고가 많음</div>
        ${heatmap(inv.crossMakerPrice.cols, inv.crossMakerPrice.rows,
          r => r.cells, r => r.maker)}
      </section>

      <section class="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
        <div class="card">
          <div class="card-title mb-3">교차 · 지역 × 연료 ${srcBadge('L0')}</div>
          ${heatmap(inv.crossRegionFuel.cols, inv.crossRegionFuel.rows, r => r.cells, r => r.sido)}
        </div>
        <div class="card">
          <div class="card-title mb-3">신규 매물 유입 추이 ${srcBadge('L2')}</div>
          <div class="card-sub mb-2">최근 24주 · 매물 등록일(encar_regist_dt) 기준</div>
          <div style="height:240px"><canvas id="invRegist"></canvas></div>
        </div>
      </section>

      <div class="divider-label">재고 분포</div>
      <section class="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-4">
        <div class="card"><div class="card-title mb-3">가격대별</div><div style="height:200px"><canvas id="distPrice"></canvas></div></div>
        <div class="card"><div class="card-title mb-3">연식별</div><div style="height:200px"><canvas id="distYear"></canvas></div></div>
        <div class="card"><div class="card-title mb-3">주행거리별</div><div style="height:200px"><canvas id="distMile"></canvas></div></div>
      </section>

      <div class="notebox">
        <b>📈 재고 추이(시계열)에 대하여.</b> 현재 데이터는 <b>${meta.collectedDate||meta.asOf} 수집 단일 스냅샷</b>입니다.
        일자별 재고 증감 추이는 <b>정기 재수집으로 스냅샷이 누적</b>되면 활성화됩니다(기획안 4.1 단계 B).
        위 "신규 매물 유입 추이"는 매물 등록일 기반으로 단일 스냅샷에서도 산출 가능한 근사 지표입니다.
      </div>
    `);

    // dim 버튼
    $$('#dimBar [data-dim]').forEach(b => b.addEventListener('click', () => {
      invDim = b.dataset.dim;
      $$('#dimBar [data-dim]').forEach(x => x.classList.toggle('on', x.dataset.dim === invDim));
      drawInvDim();
    }));
    drawInvDim();

    // 유입 추이
    const rw = DATA.pricing.registWeekly;
    track(new Chart($('#invRegist'), {
      type: 'line',
      data: { labels: rw.weeks, datasets: [{ label: '주간 신규 등록', data: rw.counts, borderColor: PAL.accent, backgroundColor: withAlpha(PAL.accent,0.12), fill: true, tension: 0.3, pointRadius: 0, borderWidth: 2 }] },
      options: { responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false}}, scales: { x: axX(), y: axY({beginAtZero:true}) } }
    }));

    // 분포 차트
    const distBar = (id, dim, color) => {
      const rows = inv.dims[dim];
      barChart($('#'+id), rows.map(r=>r.key), rows.map(r=>r.count), { color, valueFmt: v=>nf(v)+'대' });
    };
    distBar('distPrice', 'priceBucket', PAL.accent);
    distBar('distYear', 'yearBucket', PAL.blue);
    distBar('distMile', 'mileageBucket', PAL.green);
  }

  function drawInvDim() {
    const inv = DATA.inventory;
    const dimDef = INV_DIMS.find(d => d.key === invDim);
    const rows = inv.dims[invDim];
    // 차트
    const old = charts.find(c => c.canvas && c.canvas.id === 'invChart');
    if (old) { try { old.destroy(); } catch(e){} charts.splice(charts.indexOf(old),1); }
    const ctx = $('#invChart');
    if (dimDef.kind === 'donut') {
      track(new Chart(ctx, {
        type: 'doughnut',
        data: { labels: rows.map(r=>r.key), datasets: [{ data: rows.map(r=>r.count), backgroundColor: SERIES, borderColor:'#fff', borderWidth:2 }] },
        options: { responsive:true, maintainAspectRatio:false, cutout:'56%',
          plugins:{ legend:{position:'right'}, tooltip:{callbacks:{label:c=>` ${c.label}: ${nf(c.parsed)}대 (${(c.parsed/inv.total*100).toFixed(1)}%)`}} } }
      }));
    } else {
      const horiz = rows.length > 7;
      barChart(ctx, rows.map(r=>r.key), rows.map(r=>r.count), { horizontal: horiz, label:'재고', color: PAL.accent, valueFmt: v=>nf(v)+'대' });
    }
    // 테이블
    const total = rows.reduce((s,r)=>s+r.count,0);
    $('#invTable').innerHTML = `<table class="t"><tbody>${rows.map(r=>`
      <tr><td class="font-medium">${r.key}</td>
      <td class="num">${nf(r.count)}<span style="color:var(--tx-4)"> (${(r.count/total*100).toFixed(1)}%)</span></td>
      <td class="num" style="color:var(--tx-3)">${r.medPrice?won(r.medPrice):'–'}</td></tr>`).join('')}</tbody></table>`;
  }

  // ============================================================
  // 2.5 시기별 트렌드 (엔카등록월 시계열)
  // ============================================================
  function renderTrend() {
    const tr = DATA.trend, m = tr.months;
    const labels = m.map(x => x.ym);
    const cs = tr.crawlSnapshots || [];
    const last = cs[cs.length - 1] || {};
    const crawlReady = cs.length >= 2;
    const crawlSection = crawlReady ? `
      <section class="card mb-4">
        <div class="card-title mb-1">크롤일별 시장 추세 ${srcBadge('HIST')}</div>
        <div class="card-sub mb-3">크롤(수집) 시점별 시장 변화 · ${cs.length}회 누적</div>
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div style="height:240px"><canvas id="csVol"></canvas></div>
          <div style="height:240px"><canvas id="csPrice"></canvas></div>
        </div>
      </section>` : `
      <section class="card mb-4">
        <div class="card-title mb-1">크롤일별 시장 추세 ${srcBadge('HIST')}</div>
        <div class="card-sub mb-3">크롤 ${cs.length}회 누적 — 매주 수요일 쌓여 <b>추세 그래프가 자동 활성화</b>됩니다 (2회차부터)</div>
        <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
          ${[['재고수', last.inventory!=null?nf(last.inventory)+'대':'–'],
             ['신규 유입', last.newIn!=null?nf(last.newIn)+'대':'–'],
             ['판매 소진', last.soldOut!=null?nf(last.soldOut)+'대':'–'],
             ['평균 체류일', last.avgDwell!=null?last.avgDwell+'일':'–']].map(([k,v])=>`
            <div class="rounded-lg border p-3" style="border-color:var(--line);background:var(--bg-2)">
              <div class="text-[11px]" style="color:var(--tx-3)">${k}</div>
              <div class="text-lg font-bold mt-1">${v}</div></div>`).join('')}
        </div>
        <div class="text-[11px] mt-2" style="color:var(--tx-4)">최신 크롤: ${last.date||'–'} · 다음 누적: 매주 수 09:00</div>
      </section>`;
    mount(`
      ${crawlSection}
      <section class="card mb-4">
        <div class="flex items-center justify-between mb-1 flex-wrap gap-2">
          <div class="card-title">보조: 엔카 등록월 기준 추이 ${srcBadge('L2')}</div>
          <div class="text-[11px]" style="color:var(--tx-3)">최근 24개월 · 데이터 수집일 ${DATA.meta.collectedDate||DATA.meta.asOf}</div>
        </div>
        <div class="notebox mt-2" style="border-left-color:var(--warn)">
          <b>⏱ 안내.</b> 위 '크롤일별 추세'가 누적될 때까지의 보조 지표입니다. 매물 <b>엔카 등록월</b>을 시간축으로 하며,
          과거 월일수록 이미 판매돼 적게 남는 <b>생존편향</b>이 있습니다(최근 구간일수록 신규 유입에 가까움).
        </div>
      </section>

      <section class="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
        <div class="card">
          <div class="card-title mb-1">월별 등록(유입) 매물 수</div>
          <div class="card-sub mb-2">해당 월 등록되어 현재 거래 중인 매물</div>
          <div style="height:240px"><canvas id="trCount"></canvas></div>
        </div>
        <div class="card">
          <div class="card-title mb-1">월별 중앙 시세 추이</div>
          <div class="card-sub mb-2">등록월별 판매가 중앙값 (인수금 제외)</div>
          <div style="height:240px"><canvas id="trPrice"></canvas></div>
        </div>
      </section>

      <section class="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
        <div class="card">
          <div class="card-title mb-1">연료 구성 변화</div>
          <div class="card-sub mb-2">등록월별 연료 비중(%) · 전기·하이브리드 추세</div>
          <div style="height:260px"><canvas id="trFuel"></canvas></div>
        </div>
        <div class="card">
          <div class="card-title mb-1">평균 잔존율 · 국산 비중 추이</div>
          <div class="card-sub mb-2">등록월별 잔존율(%)과 국산차 비중(%)</div>
          <div style="height:260px"><canvas id="trMix"></canvas></div>
        </div>
      </section>

      <section class="card mb-4">
        <div class="card-title mb-3">월별 상세 지표</div>
        <div style="max-height:340px;overflow-y:auto">
        <table class="t">
          <thead><tr><th>등록월</th><th class="num">매물수</th><th class="num">중앙시세</th><th class="num">평균잔존율</th><th class="num">중앙주행</th><th class="num">평균연식</th><th class="num">전기%</th><th class="num">국산%</th></tr></thead>
          <tbody>
            ${m.slice().reverse().map(x => `
              <tr>
                <td class="font-medium">${x.ym}</td>
                <td class="num">${nf(x.count)}</td>
                <td class="num"><b>${x.medPrice?won(x.medPrice):'–'}</b></td>
                <td class="num">${x.avgResidual!=null?pct(x.avgResidual):'–'}</td>
                <td class="num" style="color:var(--tx-3)">${x.medMileage?kmShort(x.medMileage):'–'}</td>
                <td class="num" style="color:var(--tx-3)">${x.avgYear||'–'}</td>
                <td class="num">${x.fuel['전기']}%</td>
                <td class="num">${x.domesticShare}%</td>
              </tr>`).join('')}
          </tbody>
        </table>
        </div>
      </section>
    `);

    if (crawlReady) {
      const cl_ = cs.map(s=>s.date);
      track(new Chart($('#csVol'), {
        type:'line',
        data:{ labels: cl_, datasets:[
          { label:'재고수', data: cs.map(s=>s.inventory), borderColor:PAL.blue, backgroundColor:PAL.blue, tension:0.3, pointRadius:2, borderWidth:2, yAxisID:'y' },
          { label:'신규 유입', data: cs.map(s=>s.newIn), borderColor:PAL.green, backgroundColor:PAL.green, tension:0.3, pointRadius:2, borderWidth:2, yAxisID:'y1' },
          { label:'판매 소진', data: cs.map(s=>s.soldOut), borderColor:PAL.down, backgroundColor:PAL.down, tension:0.3, pointRadius:2, borderWidth:2, yAxisID:'y1' },
        ]},
        options:{ responsive:true, maintainAspectRatio:false, scales:{ x:axX(),
          y:axY({position:'left',title:{display:true,text:'재고',color:PAL.fg}}),
          y1:axY({position:'right',grid:{display:false},title:{display:true,text:'유입/소진',color:PAL.fg}}) } }
      }));
      track(new Chart($('#csPrice'), {
        type:'line',
        data:{ labels: cl_, datasets:[
          { label:'중앙 시세(만원)', data: cs.map(s=>s.medPrice), borderColor:PAL.accent, backgroundColor:withAlpha(PAL.accent,0.1), fill:true, tension:0.3, pointRadius:2, borderWidth:2.5 },
        ]},
        options:{ responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false}}, scales:{ x:axX(), y:axY({ticks:{callback:v=>nf(v)+'만',color:PAL.axis}}) } }
      }));
    }

    barChart($('#trCount'), labels, m.map(x=>x.count), { color: PAL.accent, label:'등록 매물수', valueFmt:v=>nf(v)+'대' });

    track(new Chart($('#trPrice'), {
      type:'line',
      data:{ labels, datasets:[{ label:'중앙 시세(만원)', data:m.map(x=>x.medPrice), borderColor:PAL.accent, backgroundColor:withAlpha(PAL.accent,0.1), fill:true, tension:0.3, pointRadius:2, borderWidth:2.5 }]},
      options:{ responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false}}, scales:{ x:axX(), y:axY({ticks:{callback:v=>nf(v)+'만',color:PAL.axis}}) } }
    }));

    const fuels=['가솔린','디젤','하이브리드','전기','LPG'];
    const fcol={ '가솔린':PAL.accent,'디젤':PAL.muted,'하이브리드':PAL.green,'전기':PAL.blue,'LPG':PAL.warn };
    track(new Chart($('#trFuel'), {
      type:'line',
      data:{ labels, datasets: fuels.map(f=>({ label:f, data:m.map(x=>x.fuel[f]), borderColor:fcol[f], backgroundColor:fcol[f], tension:0.3, pointRadius:0, borderWidth:2 })) },
      options:{ responsive:true, maintainAspectRatio:false, scales:{ x:axX(), y:axY({beginAtZero:true,ticks:{callback:v=>v+'%',color:PAL.axis}}) } }
    }));

    track(new Chart($('#trMix'), {
      type:'line',
      data:{ labels, datasets:[
        { label:'평균 잔존율 %', data:m.map(x=>x.avgResidual), borderColor:PAL.accent, backgroundColor:PAL.accent, tension:0.3, pointRadius:2, borderWidth:2.5, yAxisID:'y' },
        { label:'국산 비중 %', data:m.map(x=>x.domesticShare), borderColor:PAL.blue, backgroundColor:PAL.blue, tension:0.3, pointRadius:2, borderWidth:2, yAxisID:'y', borderDash:[5,4] },
      ]},
      options:{ responsive:true, maintainAspectRatio:false, scales:{ x:axX(), y:axY({ticks:{callback:v=>v+'%',color:PAL.axis}}) } }
    }));
  }

  // ============================================================
  // 3. 시세 조회 (간이 cascade — 모델 분석/하위 호환용 내부 유지)
  // ============================================================
  let lookupSel = { mk: null, md: null, gd: null };

  // ----- 고급 시세조회 (클라이언트 커스텀 필터 · dataset.json) -----
  const CASC = ['mfr','mg','md','gr','gd'];
  const CASC_LABEL = { mfr:'제조사', mg:'대표모델명', md:'세부모델명', gr:'대표등급명', gd:'세부등급명' };
  const KM_STOPS = [0,10000,30000,50000,70000,100000,130000,150000,200000,300000,99999999];
  let LF = null, DSX = null;

  function destroyByPrefix(prefix) {
    for (let i=charts.length-1;i>=0;i--){ const c=charts[i]; if(c.canvas&&c.canvas.id&&c.canvas.id.startsWith(prefix)){ try{c.destroy();}catch(e){} charts.splice(i,1);} }
  }
  const quant = (sorted,q) => { if(!sorted.length) return null; const p=(sorted.length-1)*q, lo=Math.floor(p), hi=Math.ceil(p); return lo===hi?sorted[lo]:Math.round(sorted[lo]+(sorted[hi]-sorted[lo])*(p-lo)); };

  function initLF() {
    const ds = DATA.dataset, C = ds.col;
    const ext = arr => { let mn=Infinity,mx=-Infinity; for(const v of arr){ if(v>=0){ if(v<mn)mn=v; if(v>mx)mx=v; } } return [mn,mx]; };
    DSX = { N: ds.n, C, dim: ds.dim, ext: { yr:ext(C.yr), oyr:ext(C.oyr), age:ext(C.age) } };
    LF = { mfr:null,mg:null,md:null,gr:null,gd:null,
      cls:new Set(), fuel:new Set(), color:new Set(),
      yr:[...DSX.ext.yr], oyr:[...DSX.ext.oyr], age:[...DSX.ext.age], km:[0,99999999],
      acc:'all', dep:true };
  }

  function passFilters(i) {
    const C = DSX.C;
    if (LF.cls.size && !LF.cls.has(C.cls[i])) return false;
    if (LF.fuel.size && !LF.fuel.has(C.fuel[i])) return false;
    if (LF.color.size && !LF.color.has(C.color[i])) return false;
    const yr=C.yr[i]; if(yr>=0 && (yr<LF.yr[0]||yr>LF.yr[1])) return false;
    const oyr=C.oyr[i]; if(oyr>=0 && (oyr<LF.oyr[0]||oyr>LF.oyr[1])) return false;
    const age=C.age[i]; if(age>=0 && (age<LF.age[0]||age>LF.age[1])) return false;
    const km=C.km[i]; if(km>=0 && (km<LF.km[0]||km>LF.km[1])) return false;
    if(LF.acc==='none' && C.acc[i]!==0) return false;
    if(LF.acc==='exch' && C.exch[i]!==1) return false;
    return true;
  }
  function matchRows() {
    const C = DSX.C, out = [];
    for (let i=0;i<DSX.N;i++){
      if (LF.dep && C.dep[i]) continue;
      let ok=true;
      for (let k=0;k<5;k++){ const f=CASC[k]; if(LF[f]!=null && C[f][i]!==LF[f]){ ok=false; break; } }
      if(!ok) continue;
      if(!passFilters(i)) continue;
      out.push(i);
    }
    return out;
  }
  function cascadeOptions(level) {
    const C = DSX.C, f = CASC[level], cnt = new Map();
    let total = 0;
    for (let i=0;i<DSX.N;i++){
      if (LF.dep && C.dep[i]) continue;
      let ok=true;
      for (let k=0;k<level;k++){ const ff=CASC[k]; if(LF[ff]!=null && C[ff][i]!==LF[ff]){ ok=false; break; } }
      if(!ok) continue;
      total++;
      const v=C[f][i]; cnt.set(v,(cnt.get(v)||0)+1);
    }
    const dimArr = DSX.dim[f];
    const list = [...cnt.entries()].map(([idx,c])=>({idx,name:dimArr[idx],count:c}))
      .filter(o=>o.name && o.name!=='(미상)')
      .sort((a,b)=>b.count-a.count);
    return { list, total };
  }
  // 카테고리(차종/연료/색상) 칩 옵션 — 현재 cascade+dep 적용 분포
  function catOptions(field) {
    const C = DSX.C, cnt = new Map();
    for (let i=0;i<DSX.N;i++){
      if (LF.dep && C.dep[i]) continue;
      let ok=true;
      for (let k=0;k<5;k++){ const f=CASC[k]; if(LF[f]!=null && C[f][i]!==LF[f]){ ok=false; break; } }
      if(!ok) continue;
      const v=C[field][i]; cnt.set(v,(cnt.get(v)||0)+1);
    }
    const dimArr = DSX.dim[field];
    return [...cnt.entries()].map(([idx,c])=>({idx,name:dimArr[idx],count:c}))
      .filter(o=>o.name && o.name!=='(미상)').sort((a,b)=>b.count-a.count);
  }

  async function renderLookup() {
    if (!DATA.dataset) {
      mount(`<div class="loading-wrap"><div><div class="spinner mx-auto"></div><div class="text-center">시세 데이터셋 로딩 중… (최초 1회)</div></div></div>`);
      try { const r = await fetch('data/dataset.json'); if(!r.ok) throw new Error('dataset.json '+r.status); DATA.dataset = await r.json(); }
      catch(e){ app().innerHTML = `<div class="card" style="color:var(--down)">데이터셋 로딩 실패: ${e.message}</div>`; return; }
    }
    if (location.hash !== '#/lookup' && location.hash !== '') return; // 로딩 중 탭 이동 방지
    if (!LF) initLF();

    mount(`
      <section class="grid grid-cols-12 gap-4">
        <aside class="col-span-12 lg:col-span-3 space-y-3 lk-aside" id="lkFilters"></aside>
        <div class="col-span-12 lg:col-span-9 space-y-4" id="lkResult"></div>
      </section>
    `);
    renderLkFilters();
    updateLookup();
  }

  function rangeSelect(key, label, unit, stops, fmt) {
    // stops: array of values; min/max selects
    const opt = (v,sel)=>`<option value="${v}" ${v===sel?'selected':''}>${fmt(v)}${unit}</option>`;
    return `
      <div class="mb-3">
        <div class="text-[11px] font-semibold tracking-wider mb-1" style="color:var(--tx-3)">${label}</div>
        <div class="flex items-center gap-2">
          <select class="filter-select" data-range="${key}" data-end="0">${stops.map(v=>opt(v,LF[key][0])).join('')}</select>
          <span style="color:var(--tx-4)">~</span>
          <select class="filter-select" data-range="${key}" data-end="1">${stops.map(v=>opt(v,LF[key][1])).join('')}</select>
        </div>
      </div>`;
  }

  function renderLkFilters() {
    const yrs = []; for(let y=DSX.ext.yr[1]; y>=DSX.ext.yr[0]; y--) yrs.push(y);
    const oyrs = []; for(let y=DSX.ext.oyr[1]; y>=DSX.ext.oyr[0]; y--) oyrs.push(y);
    const ages = []; for(let a=DSX.ext.age[0]; a<=DSX.ext.age[1]; a++) ages.push(a);
    const cascHtml = CASC.map((f,lv) => {
      const { list, total } = cascadeOptions(lv);
      const cur = LF[f];
      return `
        <div class="mb-2">
          <div class="text-[11px] font-semibold tracking-wider mb-1" style="color:var(--tx-3)">${CASC_LABEL[f]}</div>
          <select class="filter-select" data-casc="${lv}">
            <option value="-1">전체 (${nf(total)})</option>
            ${list.map(o=>`<option value="${o.idx}" ${o.idx===cur?'selected':''}>${o.name} (${nf(o.count)})</option>`).join('')}
          </select>
        </div>`;
    }).join('');

    const chipGroup = (field, label) => {
      const opts = catOptions(field).slice(0, 24);
      return `
        <div class="mb-3">
          <div class="text-[11px] font-semibold tracking-wider mb-1.5" style="color:var(--tx-3)">${label}</div>
          <div class="flex flex-wrap gap-1.5">
            ${opts.map(o=>`<button class="seg-chip ${LF[field].has(o.idx)?'on':''}" data-cat="${field}" data-idx="${o.idx}">${o.name} <span style="opacity:.6">${nf(o.count)}</span></button>`).join('')}
          </div>
        </div>`;
    };

    $('#lkFilters').innerHTML = `
      <div class="card">
        <div class="flex items-center justify-between mb-2">
          <div class="card-title">조건 선택 ${srcBadge('L2')}</div>
          <button class="seg-chip" id="lkReset">↺ 초기화</button>
        </div>
        ${cascHtml}
      </div>
      <div class="card">
        ${rangeSelect('yr','연식(년)','', yrs, v=>v)}
        ${rangeSelect('oyr','출고연도','', oyrs, v=>v)}
        ${rangeSelect('age','차령(년)','년', ages, v=>v)}
        ${rangeSelect('km','주행거리','', KM_STOPS, v=> v>=99999999?'무제한':(v/10000)+'만km')}
        <div class="mb-1">
          <div class="text-[11px] font-semibold tracking-wider mb-1.5" style="color:var(--tx-3)">사고/교환</div>
          <div class="segmented" id="lkAcc">
            <button data-acc="all" class="${LF.acc==='all'?'on':''}">전체</button>
            <button data-acc="none" class="${LF.acc==='none'?'on':''}">무사고</button>
            <button data-acc="exch" class="${LF.acc==='exch'?'on':''}">교환이력</button>
          </div>
        </div>
      </div>
      <div class="card">
        ${chipGroup('cls','차종')}
        ${chipGroup('fuel','연료')}
        ${chipGroup('color','색상')}
      </div>
      <div class="card">
        <label class="flex items-center gap-2 text-[12px]" style="color:var(--tx-2);cursor:pointer">
          <input type="checkbox" id="lkDep" ${LF.dep?'checked':''}> 리스승계 인수금·이상치 제외 (권장)
        </label>
      </div>
      <div class="notebox" style="border-left-color:var(--warn)">
        <b>옵션 필터 미제공.</b> 수집된 옵션 데이터가 개별 차량의 <b>실제 장착 옵션이 아니라 모델 카탈로그(선택가능 옵션)</b> 수준이라
        신뢰할 수 없어(예: 2010년식에도 차선유지보조 98%) 옵션 조건 필터는 제공하지 않습니다.
        실제 장착 옵션 재수집 후 활성화 예정입니다.
      </div>
    `;

    // 바인딩
    $$('#lkFilters [data-casc]').forEach(sel => sel.addEventListener('change', () => {
      const lv = +sel.dataset.casc, v = +sel.value;
      LF[CASC[lv]] = v<0 ? null : v;
      for (let k=lv+1;k<5;k++) LF[CASC[k]] = null;     // 하위 cascade 초기화
      renderLkFilters(); updateLookup();
    }));
    $$('#lkFilters [data-range]').forEach(sel => sel.addEventListener('change', () => {
      const key = sel.dataset.range, end = +sel.dataset.end;
      LF[key][end] = +sel.value;
      if (LF[key][0] > LF[key][1]) { if(end===0) LF[key][1]=LF[key][0]; else LF[key][0]=LF[key][1]; renderLkFilters(); }
      updateLookup();
    }));
    $$('#lkFilters [data-cat]').forEach(b => b.addEventListener('click', () => {
      const field = b.dataset.cat, idx = +b.dataset.idx;
      if (LF[field].has(idx)) LF[field].delete(idx); else LF[field].add(idx);
      b.classList.toggle('on');
      updateLookup();
    }));
    $$('#lkAcc [data-acc]').forEach(b => b.addEventListener('click', () => {
      LF.acc = b.dataset.acc; $$('#lkAcc [data-acc]').forEach(x=>x.classList.toggle('on',x.dataset.acc===LF.acc)); updateLookup();
    }));
    $('#lkDep').addEventListener('change', e => { LF.dep = e.target.checked; renderLkFilters(); updateLookup(); });
    $('#lkReset').addEventListener('click', () => { initLF(); renderLkFilters(); updateLookup(); });
  }

  function activeFilterSummary() {
    const s = [];
    CASC.forEach(f => { if(LF[f]!=null) s.push(DSX.dim[f][LF[f]]); });
    if (LF.cls.size) s.push([...LF.cls].map(i=>DSX.dim.cls[i]).join('/'));
    if (LF.fuel.size) s.push([...LF.fuel].map(i=>DSX.dim.fuel[i]).join('/'));
    if (LF.color.size) s.push(`색상 ${LF.color.size}종`);
    if (LF.yr[0]!==DSX.ext.yr[0] || LF.yr[1]!==DSX.ext.yr[1]) s.push(`연식 ${LF.yr[0]}~${LF.yr[1]}`);
    if (LF.km[1]<99999999 || LF.km[0]>0) s.push(`주행 ${(LF.km[0]/10000)}~${LF.km[1]>=99999999?'∞':(LF.km[1]/10000)}만km`);
    if (LF.acc!=='all') s.push(LF.acc==='none'?'무사고':'교환이력');
    return s.length ? s.join(' · ') : '전체 조건';
  }

  function updateLookup() {
    destroyByPrefix('lk');
    const C = DSX.C;
    const idx = matchRows();
    const prices = []; const ress = []; const miles = []; const years = [];
    for (const i of idx) { const p=C.price[i]; if(p>0){ prices.push(p); } const r=C.res[i]; if(r>0) ress.push(r); const m=C.km[i]; if(m>=0) miles.push(m); const y=C.yr[i]; if(y>0) years.push(y); }
    prices.sort((a,b)=>a-b);
    const box = $('#lkResult');
    if (prices.length < 3) {
      box.innerHTML = `<div class="card"><div class="card-title mb-2">시세 결과</div>
        <div class="text-[13px]" style="color:var(--tx-3)">조건: <b>${activeFilterSummary()}</b></div>
        <div class="text-center py-12" style="color:var(--tx-4)">매칭 매물이 <b>${nf(idx.length)}건</b>으로 부족합니다. 조건을 완화해 주세요. (시세 산출 최소 3건)</div></div>`;
      return;
    }
    const Q = q => quant(prices, q);
    const bands = [['최저 P10',Q(.1),false],['P25',Q(.25),false],['중앙값 P50',Q(.5),true],['P75',Q(.75),false],['최고 P90',Q(.9),false]];
    const avg = arr => arr.length? arr.reduce((a,b)=>a+b,0)/arr.length : null;
    const med = arr => { if(!arr.length) return null; const s=arr.slice().sort((a,b)=>a-b); return quant(s,.5); };

    box.innerHTML = `
      <div class="card">
        <div class="flex items-center justify-between mb-3 flex-wrap gap-2">
          <div><div class="card-title">시세 분위수 밴드</div>
            <div class="card-sub">${activeFilterSummary()}</div></div>
          <div class="text-[12px]" style="color:var(--tx-3)">매칭 매물 <b style="color:var(--accent)">${nf(idx.length)}건</b></div>
        </div>
        <div class="band-grid mt-2">
          ${bands.map(([l,v,hi])=>`<div class="band-cell ${hi?'hi':''}"><div class="lab">${l}</div><div class="val">${nf(v)}</div><div class="unit">만원</div></div>`).join('')}
        </div>
        <div class="grid grid-cols-2 md:grid-cols-5 gap-3 mt-4">
          ${[['평균 시세', won(Math.round(avg(prices)))+'원'],
             ['중앙 주행거리', kmShort(med(miles))],
             ['중앙 연식', med(years)?med(years)+'년':'–'],
             ['평균 잔존율', ress.length?pct(avg(ress)):'–'],
             ['가격 범위', `${won(prices[0])}~${won(prices[prices.length-1])}`]].map(([k,v])=>`
            <div class="rounded-lg border p-3" style="border-color:var(--line);background:var(--bg-2)">
              <div class="text-[11px]" style="color:var(--tx-3)">${k}</div><div class="text-base font-bold mt-1">${v}</div></div>`).join('')}
        </div>
      </div>
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div class="card"><div class="card-title mb-2">가격 분포</div><div style="height:240px"><canvas id="lkHist"></canvas></div></div>
        <div class="card"><div class="card-title mb-2">연식별 중앙 시세</div><div style="height:240px"><canvas id="lkYear"></canvas></div></div>
      </div>
      <div class="card"><div class="card-title mb-2">주행거리 구간별 중앙 시세</div><div style="height:240px"><canvas id="lkMile"></canvas></div></div>
    `;

    // 가격 히스토그램
    const pmin=prices[0], pmax=Math.min(prices[prices.length-1], Q(.5)*3);
    const nb=14, step=Math.max(1,(pmax-pmin)/nb), hbins=new Array(nb).fill(0), hlab=[];
    for (let b=0;b<nb;b++) hlab.push(`${Math.round((pmin+step*b)/100)*100}`);
    for (const p of prices){ let b=Math.floor((p-pmin)/step); if(b<0)b=0; if(b>=nb)b=nb-1; hbins[b]++; }
    barChart($('#lkHist'), hlab, hbins, { color: PAL.accent, label:'매물수', valueFmt:v=>nf(v)+'대' });

    // 연식별 중앙가
    const byYear = new Map();
    for (const i of idx){ const y=C.yr[i], p=C.price[i]; if(y>0&&p>0){ if(!byYear.has(y))byYear.set(y,[]); byYear.get(y).push(p);} }
    const yk=[...byYear.keys()].sort((a,b)=>a-b).filter(y=>byYear.get(y).length>=3);
    barChart($('#lkYear'), yk, yk.map(y=>med(byYear.get(y))), { color: PAL.blue, label:'중앙시세', valueFmt:v=>won(v)+'원' });

    // 주행구간별 중앙가
    const MB=['~1만','1-3만','3-6만','6-9만','9-12만','12-15만','15만+'];
    const mbIdx = km => { const m=km/10000; return m<1?0:m<3?1:m<6?2:m<9?3:m<12?4:m<15?5:6; };
    const byMb=Array.from({length:7},()=>[]);
    for (const i of idx){ const m=C.km[i], p=C.price[i]; if(m>=0&&p>0) byMb[mbIdx(m)].push(p); }
    const mbK=[], mbV=[]; MB.forEach((lab,j)=>{ if(byMb[j].length>=3){ mbK.push(lab); mbV.push(med(byMb[j])); } });
    barChart($('#lkMile'), mbK, mbV, { color: PAL.accent, label:'중앙시세', valueFmt:v=>won(v)+'원' });
  }

  // ============================================================
  // 4. 모델 분석
  // ============================================================
  let modelSort = 'count';
  function renderModel() {
    const tree = DATA.models.tree;
    const rows = [];
    for (const mk in tree) for (const md in tree[mk].models) {
      const n = tree[mk].models[md];
      rows.push({ mk, md, count: n.count, p10: n.p10, p50: n.p50, p90: n.p90, res: n.avgResidual, mile: n.medMileage, year: n.medYear });
    }
    const sorters = {
      count: (a,b)=>b.count-a.count, price: (a,b)=>b.p50-a.p50, res: (a,b)=>(b.res||0)-(a.res||0),
    };
    rows.sort(sorters[modelSort]);
    const top = rows.slice(0, 40);

    mount(`
      <section class="card mb-4">
        <div class="flex items-center justify-between mb-3 flex-wrap gap-2">
          <div class="card-title">모델 심층 분석 ${srcBadge('L2')}</div>
          <div class="segmented" id="mdSort">
            <button data-s="count" class="${modelSort==='count'?'on':''}">재고순</button>
            <button data-s="price" class="${modelSort==='price'?'on':''}">시세순</button>
            <button data-s="res" class="${modelSort==='res'?'on':''}">잔존율순</button>
          </div>
        </div>
        <div class="card-sub mb-3">정제 데이터 기준 · 모델별 분위수 시세 (상위 40)</div>
        <div style="max-height:620px;overflow-y:auto">
        <table class="t">
          <thead><tr><th style="width:28px"></th><th>제조사 / 모델</th><th class="num">재고</th><th class="num">P10</th><th class="num">중앙(P50)</th><th class="num">P90</th><th class="num">평균잔존율</th><th class="num">중앙주행</th></tr></thead>
          <tbody>
            ${top.map((r,i) => `
              <tr>
                <td style="color:var(--tx-4)" class="text-xs">${i+1}</td>
                <td><span style="color:var(--tx-3)">${r.mk}</span> · <b>${r.md}</b></td>
                <td class="num">${nf(r.count)}</td>
                <td class="num" style="color:var(--tx-3)">${won(r.p10)}</td>
                <td class="num"><b>${won(r.p50)}</b></td>
                <td class="num" style="color:var(--tx-3)">${won(r.p90)}</td>
                <td class="num">${r.res!=null?`<span class="zbadge ${r.res>=60?'mid':r.res>=40?'lo':'hi'}">${pct(r.res)}</span>`:'–'}</td>
                <td class="num" style="color:var(--tx-3)">${r.mile?kmShort(r.mile):'–'}</td>
              </tr>`).join('')}
          </tbody>
        </table>
        </div>
      </section>

      <div class="divider-label">연식별 감가 곡선 (잔존율)</div>
      <section class="card mb-4">
        <div class="card-sub mb-3">출고가 대비 중앙 잔존율 · 전체 / 국산 / 수입 비교 ${srcBadge('L2')}</div>
        <div style="height:320px"><canvas id="mdDep"></canvas></div>
      </section>
    `);

    $$('#mdSort [data-s]').forEach(b => b.addEventListener('click', () => { modelSort = b.dataset.s; renderModel(); }));

    const dep = DATA.insights.depreciation;
    const years = dep.all.map(d => d.year);
    const line = (label, arr, color, dash) => ({
      label, data: years.map(y => { const f = arr.find(d=>d.year===y); return f?f.medResidual:null; }),
      borderColor: color, backgroundColor: color, borderWidth: 2.5, tension: 0.3, pointRadius: 2, spanGaps: true,
      borderDash: dash||[],
    });
    track(new Chart($('#mdDep'), {
      type: 'line',
      data: { labels: years, datasets: [
        line('전체', dep.all, PAL.accent),
        line('국산', dep.domestic, PAL.blue),
        line('수입', dep.imported, PAL.purple, [5,4]),
      ]},
      options: { responsive:true, maintainAspectRatio:false,
        scales: { x: axX(), y: axY({ beginAtZero:true, ticks:{ callback:v=>v+'%', color:PAL.axis } }) },
        plugins: { tooltip: { callbacks: { label: c => ` ${c.dataset.label}: ${c.parsed.y!=null?c.parsed.y.toFixed(1)+'%':'–'}` } } } }
    }));
  }

  // ============================================================
  // 5. 인사이트
  // ============================================================
  function renderInsights() {
    const ins = DATA.insights, inv = DATA.inventory;
    const reg = ins.region.slice().sort((a,b)=>b.medPrice-a.medPrice);
    mount(`
      <section class="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
        <div class="card">
          <div class="card-title mb-3">연식별 감가 곡선 ${srcBadge('L2')}</div>
          <div class="card-sub mb-2">출고가 대비 중앙 잔존율</div>
          <div style="height:280px"><canvas id="insDep"></canvas></div>
        </div>
        <div class="card">
          <div class="card-title mb-3">연료/친환경 트렌드 ${srcBadge('L2')}</div>
          <div class="card-sub mb-2">연료별 재고 비중 · 중앙 시세 · 평균 연식</div>
          <table class="t mt-1">
            <thead><tr><th>연료</th><th class="num">재고비중</th><th class="num">중앙시세</th><th class="num">평균연식</th><th class="num">잔존율</th></tr></thead>
            <tbody>${ins.fuel.map(f=>`
              <tr><td class="font-medium">${f.key}</td>
              <td class="num">${pct(f.share0)}</td>
              <td class="num"><b>${won(f.medPrice)}</b></td>
              <td class="num" style="color:var(--tx-3)">${f.avgYear}</td>
              <td class="num">${f.medResidual!=null?pct(f.medResidual):'–'}</td></tr>`).join('')}
            </tbody>
          </table>
        </div>
      </section>

      <div class="divider-label">지역별 가격차 (시도)</div>
      <section class="card mb-4">
        <div class="card-sub mb-3">시도별 중앙 시세 · 정렬: 높은 순 ${srcBadge('L2')}</div>
        <div style="height:300px"><canvas id="insRegion"></canvas></div>
      </section>

      <section class="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
        <div class="card">
          <div class="card-title mb-3">차체 형태별 ${srcBadge('L2')}</div>
          <table class="t">
            <thead><tr><th>차체</th><th class="num">매물수</th><th class="num">중앙시세</th><th class="num">잔존율</th></tr></thead>
            <tbody>${ins.bodyType.slice(0,10).map(b=>`
              <tr><td class="font-medium">${b.key}</td><td class="num">${nf(b.count)}</td>
              <td class="num"><b>${won(b.medPrice)}</b></td>
              <td class="num">${b.medResidual!=null?pct(b.medResidual):'–'}</td></tr>`).join('')}
            </tbody>
          </table>
        </div>
        <div class="card">
          <div class="card-title mb-3">지역별 상세 ${srcBadge('L2')}</div>
          <table class="t">
            <thead><tr><th>시도</th><th class="num">매물수</th><th class="num">중앙시세</th><th class="num">중앙주행</th><th class="num">잔존율</th></tr></thead>
            <tbody>${reg.map(r=>`
              <tr><td class="font-medium">${r.key}</td><td class="num">${nf(r.count)}</td>
              <td class="num"><b>${won(r.medPrice)}</b></td>
              <td class="num" style="color:var(--tx-3)">${r.medMileage?kmShort(r.medMileage):'–'}</td>
              <td class="num">${r.medResidual!=null?pct(r.medResidual):'–'}</td></tr>`).join('')}
            </tbody>
          </table>
        </div>
      </section>
    `);

    const dep = DATA.insights.depreciation;
    const years = dep.all.map(d=>d.year);
    track(new Chart($('#insDep'), {
      type: 'line',
      data: { labels: years, datasets: [
        { label:'전체', data: dep.all.map(d=>d.medResidual), borderColor:PAL.accent, backgroundColor:withAlpha(PAL.accent,0.1), fill:true, tension:0.3, pointRadius:2, borderWidth:2.5 },
      ]},
      options: { responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false}},
        scales: { x: axX(), y: axY({ beginAtZero:true, ticks:{callback:v=>v+'%',color:PAL.axis} }) } }
    }));

    barChart($('#insRegion'), reg.map(r=>r.key), reg.map(r=>r.medPrice),
      { color: PAL.accent, label:'중앙시세', valueFmt: v=>won(v)+'원' });
  }

  // ============================================================
  // 6. 데이터 다운로드
  // ============================================================
  function renderDownload() {
    const meta = DATA.meta, inv = DATA.inventory, pr = DATA.pricing;
    const files = [
      ['listings_compact.csv', '현재 매물 (컴팩트)', `${nf(pr.count)}행 · 현재 엔카 매물 · 핵심 11개 컬럼 (제조사·모델·등급·연식·주행·연료·차체·시도·판매가·잔존율)`, 'L2'],
      ['model_price_summary.csv', '모델별 시세 요약', `${nf(meta.modelCount)}개 모델 · 분위수(P10~P90)·중앙주행·잔존율`, 'L2'],
      ['manufacturer_summary.csv', '제조사별 요약', '제조사별 재고·중앙시세·잔존율·평균주행', 'L2'],
      ['region_summary.csv', '지역별 요약', '시도별 매물수·중앙시세·잔존율·중앙주행', 'L2'],
      ['history_accumulated.csv', '누적 이력 (전체 크롤)', '판매완료 포함 · 차량별 가격변동/판매상태 이력 · 크롤일 태깅', 'HIST'],
      ['trend_snapshots.csv', '크롤일별 시장 추세 집계', '재고·평균/중앙시세·신규유입·판매소진·평균체류일·연료믹스 (주간 누적)', 'HIST'],
    ];
    mount(`
      <section class="card mb-4">
        <div class="card-title mb-1">데이터 다운로드</div>
        <div class="card-sub mb-4">집계·요약 데이터를 CSV로 내려받을 수 있습니다. <b>엑셀(한국어)에서 바로 열려도 한글이 깨지지 않도록 CP949로 저장</b>됩니다.</div>
        <div class="space-y-3">
          ${files.map(([fn,t,d,src]) => `
            <div class="dl-card">
              <div class="dl-ic">CSV</div>
              <div class="dl-meta"><div class="t">${t} ${srcBadge(src)}</div><div class="d">${d}</div></div>
              <a class="dl-btn" href="downloads/${fn}" download>다운로드</a>
            </div>`).join('')}
        </div>
      </section>

      <div class="divider-label">데이터 명세 · 소스 레이어</div>
      <section class="card mb-4">
        <table class="t">
          <thead><tr><th>레이어</th><th>모집단</th><th class="num">건수</th><th>용도</th></tr></thead>
          <tbody>
            <tr><td>${srcBadge('L0')}</td><td>엔카 전체 매물 (목록 단계)</td><td class="num"><b>${nf(meta.inventoryTotal)}</b></td><td style="color:var(--tx-2)">시장 재고 현황·분포</td></tr>
            <tr><td>${srcBadge('L2')}</td><td>더미·이상치 제거 정제 데이터</td><td class="num"><b>${nf(meta.pricingTotal)}</b></td><td style="color:var(--tx-2)">시세·가격·잔존율 분석</td></tr>
          </tbody>
        </table>
        <div class="notebox mt-4">
          <b>소스 선택 원칙.</b> "몇 대가 시장에 있나"(재고·점유·분포)는 <b>L0(전체 매물)</b> 기준,
          "얼마에 팔리나"(시세·잔존율)는 <b>L2(정제)</b> 기준으로 산출됩니다.
          본 데이터는 <b>${meta.collectedDate||meta.asOf} 수집 스냅샷</b>(최신 매물 등록 ${meta.asOf})이며 실시간 매물 현황과 다를 수 있습니다.
          시세 분위수는 리스승계 인수금·placeholder ${nf(meta.depositExcluded||0)}건을 제외한 ${nf(meta.priceSampleTotal||meta.pricingTotal)}대 표본 기준입니다.
        </div>
      </section>
    `);
  }

  // ============================================================
  // 부트스트랩
  // ============================================================
  async function loadData() {
    const names = ['meta','inventory','pricing','models','insights','trend'];
    const results = await Promise.all(names.map(n => fetch(`data/${n}.json`).then(r => {
      if (!r.ok) throw new Error(`data/${n}.json (${r.status})`);
      return r.json();
    })));
    names.forEach((n,i) => DATA[n] = results[i]);
  }

  async function boot() {
    setupChartDefaults();
    try {
      await loadData();
    } catch (e) {
      app().innerHTML = `<div class="card" style="color:var(--down)">
        <b>데이터 로딩 실패:</b> ${e.message}<br>
        <span class="text-[12px]" style="color:var(--tx-3)">정적 서버에서 실행 중인지 확인하세요. (file:// 로는 fetch가 차단됩니다)</span></div>`;
      console.error(e);
      return;
    }
    $('#buildDateLbl').textContent = (DATA.meta.collectedDate || DATA.meta.asOf);
    $('#footMeta').textContent = `재고 L0 ${nf(DATA.meta.inventoryTotal)}대 · 시세 L2 ${nf(DATA.meta.pricingTotal)}대 · ${DATA.meta.collectedDate||DATA.meta.asOf} 수집`;
    window.addEventListener('hashchange', route);
    route();
  }

  boot();
})();
