# -*- coding: utf-8 -*-
"""
market_index.py — 시황판 지수 (기획안 D4, 5.2.1): 시세·판매속도·재고·시황지수

    python market_index.py      → web/data/market_index.json + encar_output/prep/market_index_report.txt
                                  (회차별 목록 기준 세그먼트 대수는 encar_output/prep/list_counts.csv에 누적)

기준기간(=100): 2026-07-01~07-15 (주간 크롤 3회). 날짜는 목록을 수집한 날(목록 관측일)
  · 시세지수: 그 회차 신규 매물(엔카 등록 7일 이내)의 첫 호가를 기준기간의 같은 모델·등급·세부등급 신규 매물과 비교.
              잔차 = ln 호가 − ln(1−성능감가율) − D3 계수(차령·주행·색상·렌트). 칸 기준값 = 기준기간 잔차 중앙값(3대 이상)
              → (잔차 − 칸 기준값)의 중앙값을 지수로. 차령을 빼므로 시간에 따른 자연 감가는 들어가지 않는다
  · 판매속도지수: 구간 판매 ÷ 시작 재고를 7일 기준으로 환산(생존율). 등록 후 경과일 구간별로 계산해 기준기간 재고 구성으로
                  가중한다(초기 수집분의 구성 변화 제거). 간격 5~16일 구간만, 재등록은 판매에서 뺀다.
                  제조사×시도 칸의 사라짐이 평소의 3배 이상이면 목록 누락으로 보고 그 구간에서 제외(예: 7/30 광주·전남)
  · 재고지수: 목록 매물 수(중복 제거) ÷ 기준기간 평균. 세그먼트는 목록 구성비로 나눈다 — 목록 실측(list_counts)이 있는
              회차는 실측, 없는 회차는 수집 로그의 국산 비율 × 상세 확인 매물의 국산·수입 안 차급 구성.
              목록 누락으로 사라진 대수가 재고의 1%를 넘는 회차는 재고를 계산하지 않는다
  · 시황지수: 시세 · 판매속도 · (10000 ÷ 재고)의 기하평균. 102 이상 강세 / 98~102 보합 / 98 이하 약세
세그먼트: 전체·국산·수입 × 전체·차급. 표본(신규 비교·시작 재고·재고 중 하나)이 300대 미만이면 low_sample
"""
import os, sys, json, datetime
import numpy as np
import pandas as pd

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(ROOT, "encar_output")
PREP = os.path.join(SRC, "prep")
IDS_ALL = os.path.join(SRC, "ids_all.json")
LIST_COUNTS = os.path.join(PREP, "list_counts.csv")
OUT_JSON = os.path.join(ROOT, "web", "data", "market_index.json")
REPORT = os.path.join(PREP, "market_index_report.txt")
COEF = os.path.join(ROOT, "web", "data", "adj_coef.json")

BASE = ("2026-07-01", "2026-07-15")
NEW_DAYS = 7                  # 신규 매물: 엔카 등록 7일 이내
MIN_CELL = 3                  # 시세 칸 기준값에 필요한 기준기간 신규 매물 수
SPEED_DAYS = (5, 16)          # 판매속도를 계산하는 회차 간격(일)
BANDS = [-np.inf, 7, 14, 30, 60, 120, np.inf]
BAND_NAMES = ["0-7", "8-14", "15-30", "31-60", "61-120", "121+"]
ANOMALY_REL, ANOMALY_N = 3.0, 100     # 칸 사라짐이 평소의 3배 이상(시작 100대 이상)이면 목록 누락
STOCK_GAP_MAX = 0.01                  # 누락 추정 대수가 상세 재고의 1%를 넘으면 그 회차 재고 제외
MIN_N = 300
OBS_FIX = {"2026-10-26": "2026-10-21"}   # 목록은 10/21 수집, 상세 수집이 10/26에 끝나 그날로 기록됨
LOG_DOMESTIC_SHARE = 0.6936              # 2026-07-01 수집 로그(조회별 대수 + 친환경 추가분): 국산 143,473 / 206,868


def load():
    L = pd.read_parquet(os.path.join(PREP, "listings.parquet"),
                        columns=["상태", "첫관측일", "마지막관측일", "판매추정일", "엔카등록일", "등록연월", "첫가격", "주행km",
                                 "제조사", "모델", "등급", "세부등급", "차급", "국산", "시도", "성능감가율", "색상계열", "번호판유형",
                                 "더미가", "인수금의심", "주행의심", "핵심결측"])
    for c in ["첫관측일", "마지막관측일", "판매추정일", "엔카등록일"]:
        L[c] = pd.to_datetime(L[c], errors="coerce")
    L = L[L["첫관측일"].notna()].copy()                                          # 상세가 있는(판매중 확인) 매물
    mk = L.groupby("제조사")["국산"].agg(lambda s: s.mode().iat[0] if s.notna().any() else np.nan)
    dom = L["국산"].where(L["국산"].notna(), L["제조사"].map(mk))
    L["origin"] = np.where(dom.eq(False), "수입", "국산")
    L["seg"] = L["차급"].fillna("기타")
    L["cell"] = L["제조사"].fillna("?") + "·" + L["시도"].fillna("?")
    T = pd.read_csv(os.path.join(SRC, "trend_snapshots.csv"), encoding="utf-8-sig")
    T["크롤일"] = pd.to_datetime(T["크롤일"])
    crawls = [c for c in sorted(T["크롤일"]) if c <= L["마지막관측일"].max()]          # 전처리가 실패해 listings가 묵으면 새 회차는 빼고 계산
    obs = {c: pd.Timestamp(OBS_FIX.get(c.strftime("%Y-%m-%d"), c)) for c in crawls}
    return L, crawls, obs, T.set_index("크롤일")["재고수"]


def keys_of(segs):
    return [(o, s) for o in ["전체", "국산", "수입"] for s in ["전체"] + segs]


def pick(df, key):
    o, s = key
    m = np.ones(len(df), bool)
    if o != "전체": m &= (df["origin"] == o).values
    if s != "전체": m &= (df["seg"] == s).values
    return df[m]


# ───────── 목록 실측 대수 (ids_all.json → list_counts.csv 누적) ─────────
def record_list_counts(L):
    if not os.path.exists(IDS_ALL):
        return pd.DataFrame(columns=["관측일", "origin", "seg", "대수"])
    obs = datetime.date.fromtimestamp(os.path.getmtime(IDS_ALL)).isoformat()
    with open(IDS_ALL, encoding="utf-8") as f:
        ids = pd.DataFrame(json.load(f))
    mk = L.groupby("제조사")["origin"].agg(lambda s: s.mode().iat[0])
    seg = L.groupby(["제조사", "모델"])["seg"].agg(lambda s: s.mode().iat[0])
    cat = ids["category"].fillna("")
    org = ids["manufacturer"].map(mk)
    org = org.fillna(pd.Series(np.where(cat.str.contains("imported"), "수입", "국산"), index=ids.index))
    sg = pd.Series(pd.MultiIndex.from_arrays([ids["manufacturer"], ids["model"]]).map(seg), index=ids.index).fillna("기타")
    now = (pd.DataFrame({"origin": org, "seg": sg}).groupby(["origin", "seg"]).size().rename("대수").reset_index()
           .assign(관측일=obs)[["관측일", "origin", "seg", "대수"]])
    old = pd.read_csv(LIST_COUNTS, encoding="utf-8-sig") if os.path.exists(LIST_COUNTS) else now.iloc[0:0]
    out = pd.concat([old[old["관측일"] != obs], now], ignore_index=True).sort_values(["관측일", "origin", "seg"])
    out.to_csv(LIST_COUNTS, index=False, encoding="utf-8-sig")
    return out


# ───────── 판매속도 (구간별 시작 재고 · 이상 칸 제외) ─────────
def intervals(L, crawls, obs):
    ivs = []
    for i in range(1, len(crawls)):
        p, c = crawls[i - 1], crawls[i]
        days = (obs[c] - obs[p]).days
        if not SPEED_DAYS[0] <= days <= SPEED_DAYS[1]:
            continue
        st = L[(L["첫관측일"] <= p) & (L["마지막관측일"] >= p)][["origin", "seg", "cell", "엔카등록일", "판매추정일", "상태"]].copy()
        st["sold"] = (st["판매추정일"] == c) & (st["상태"] != "재등록")
        st["band"] = pd.cut((obs[p] - st["엔카등록일"]).dt.days, BANDS, labels=BAND_NAMES)
        ivs.append({"p": p, "c": c, "days": days, "st": st, "base": BASE[0] <= obs[c].strftime("%Y-%m-%d") <= BASE[1]})
    if not ivs:
        return ivs
    rel = []
    for k, iv in enumerate(ivs):                                                   # 칸 사라짐 ÷ 전체 사라짐
        g = iv["st"].groupby("cell")["sold"].agg(["size", "mean"])
        g["ratio"] = g["mean"] / iv["st"]["sold"].mean()
        rel.append(g.assign(k=k).reset_index())
    R = pd.concat(rel)
    R["rel"] = R["ratio"] / R["cell"].map(R.groupby("cell")["ratio"].median())   # 그 칸의 평소 대비
    bad = R[(R["size"] >= ANOMALY_N) & (R["rel"] >= ANOMALY_REL)]
    for k, iv in enumerate(ivs):
        st = iv["st"]
        cells = sorted(bad.loc[bad["k"] == k, "cell"])
        m = st["cell"].isin(cells).values
        iv["bad"] = cells
        iv["missing"] = float(st["sold"].values[m].sum() - m.sum() * st["sold"].values[~m].mean()) if m.any() else 0.0
        iv["start_all"] = len(st)
        iv["st"] = st[~m]
    return ivs


def speed(ivs, keys):
    out = {}
    for key in keys:
        rows = []
        for iv in ivs:
            g = pick(iv["st"], key).groupby("band", observed=False)["sold"].agg(["size", "sum"])
            h = 1 - (1 - g["sum"] / g["size"].where(g["size"] > 0)) ** (7 / iv["days"])
            rows.append((iv, g, h))
        base = [(g, h) for iv, g, h in rows if iv["base"]]
        if not base:
            continue
        bw = sum(g["size"] for g, _ in base)
        if bw.sum() == 0:
            continue
        w = bw / bw.sum()

        def std(h):
            ok = h.notna() & (w > 0)
            return (h[ok] * w[ok]).sum() / w[ok].sum() if ok.any() else np.nan

        b = np.nanmean([std(h) for _, h in base])
        if not b > 0:
            continue
        out[key] = {iv["c"]: (std(h) / b * 100, int(g["size"].sum()), int(g["sum"].sum())) for iv, g, h in rows}
    return out


# ───────── 재고 ─────────
def stock(L, crawls, obs, total, LC, ivs, keys):
    gap = {iv["c"]: iv["missing"] / iv["start_all"] for iv in ivs}
    lc_dates = set(LC["관측일"])
    tab = {}
    for c in crawls:
        o = obs[c].strftime("%Y-%m-%d")
        if gap.get(c, 0) > STOCK_GAP_MAX:
            continue
        if o in lc_dates:                                                          # 목록 실측
            d = LC[LC["관측일"] == o]
            for key in keys:
                tab[(key, c)] = (float(pick(d, key)["대수"].sum()), False)
            continue
        on = L[(L["첫관측일"] <= c) & (L["마지막관측일"] >= c)]                     # 추정: 로그 국산 비율 × 상세 차급 구성
        share = {"국산": LOG_DOMESTIC_SHARE, "수입": 1 - LOG_DOMESTIC_SHARE}
        part = {}
        for org in ["국산", "수입"]:
            sub = on[on["origin"] == org]
            n_org = float(total[c]) * share[org]
            part[(org, "전체")] = n_org
            for s, g in sub.groupby("seg"):
                part[(org, s)] = n_org * len(g) / len(sub)
        for key in keys:
            if key[0] == "전체":
                v = float(total[c]) if key[1] == "전체" else part.get(("국산", key[1]), 0) + part.get(("수입", key[1]), 0)
            else:
                v = part.get(key, 0.0)
            tab[(key, c)] = (v, True)
    base_dates = [c for c in crawls if BASE[0] <= obs[c].strftime("%Y-%m-%d") <= BASE[1]]
    out = {}
    for key in keys:
        b = [tab[(key, c)][0] for c in base_dates if (key, c) in tab]
        if not b or np.mean(b) <= 0:
            continue
        bm = np.mean(b)
        out[key] = {c: (tab[(key, c)][0] / bm * 100, tab[(key, c)][0], tab[(key, c)][1]) for c in crawls if (key, c) in tab}
    return out


# ───────── 시세 ─────────
def coef_for(C, key, seg_key):
    return C["models"].get(key) or C["segments"].get(seg_key) or C["market"]


def price(L, crawls, obs, C, keys):
    bad = L[["더미가", "인수금의심", "주행의심", "핵심결측"]].eq(True).any(axis=1)
    d = L[~bad & (L["첫가격"] >= 100) & L["성능감가율"].notna() & L["등록연월"].notna() & (L["주행km"] > 0)].copy()
    od = d["첫관측일"].map(obs)
    d = d[(od - d["엔카등록일"]).dt.days <= NEW_DAYS].copy()                         # 신규: 목록 관측일 기준 등록 7일 이내
    od = d["첫관측일"].map(obs)
    reg = (d["등록연월"] // 100) * 12 + d["등록연월"] % 100
    d["age"] = od.dt.year * 12 + od.dt.month - reg
    d = d[d["age"].between(0, 300)].copy()
    d["km"] = d["주행km"].clip(upper=250_000) / 1e4
    d["rent"] = (d["번호판유형"] == "렌트").astype(float)
    d["key"] = d["제조사"] + "|" + d["모델"]
    d["segkey"] = d["seg"] + "·" + d["origin"]
    d["r"] = np.log(d["첫가격"]) - np.log(1 - d["성능감가율"] / 100)
    for (k, sk), g in d.groupby(["key", "segkey"]):
        cf = coef_for(C, k, sk)
        col = g["색상계열"].map(cf["color"]).fillna(0.0)
        d.loc[g.index, "r"] -= cf["age"] * g["age"] + cf["km"] * g["km"] + cf["rent"] * g["rent"] + col
    d["칸"] = d["key"] + "|" + d["등급"].fillna("") + "|" + d["세부등급"].fillna("")
    d["obs"] = d["첫관측일"].map(lambda x: obs[x].strftime("%Y-%m-%d"))
    base = d[d["obs"].between(*BASE)]
    fe = base.groupby("칸")["r"].agg(["median", "size"])
    fe = fe.loc[fe["size"] >= MIN_CELL, "median"]
    d = d[d["칸"].isin(fe.index)].copy()
    d["dev"] = d["r"] - d["칸"].map(fe)
    base_c = [c for c in crawls if BASE[0] <= obs[c].strftime("%Y-%m-%d") <= BASE[1]]
    out = {}
    for key in keys:
        g = pick(d, key).groupby("첫관측일")["dev"].agg(["median", "size"])
        if g.empty:
            continue
        raw = np.exp(g["median"]) * 100
        b = raw[raw.index.isin(base_c)].mean()
        if not b > 0:
            continue
        out[key] = {c: (raw[c] / b * 100, int(g.loc[c, "size"])) for c in g.index}
    return out


# ───────── 합치기 ─────────
def build(L, crawls, obs, total, C):
    LC = record_list_counts(L)
    segs = sorted(s for s in L["seg"].unique() if s != "기타")
    keys = keys_of(segs)
    ivs = intervals(L, crawls, obs)
    SP, ST, PR = speed(ivs, keys), stock(L, crawls, obs, total, LC, ivs, keys), price(L, crawls, obs, C, keys)
    series = {}
    for key in keys:
        pts = []
        for c in crawls:
            e = {"date": obs[c].strftime("%Y-%m-%d")}
            if c in PR.get(key, {}):
                v, n = PR[key][c]
                e["시세"], e["n_price"] = round(float(v), 1), n
            if c in SP.get(key, {}) and SP[key][c][0] == SP[key][c][0]:
                v, n0, n1 = SP[key][c]
                e["판매속도"], e["n_start"], e["n_sold"] = round(float(v), 1), n0, n1
            if c in ST.get(key, {}):
                v, n, est = ST[key][c]
                e["재고"], e["n_stock"] = round(float(v), 1), int(round(n))
                if est: e["stock_est"] = True
            if all(k in e for k in ["시세", "판매속도", "재고"]) and e["재고"] > 0:
                e["시황"] = round(float(np.exp(np.mean(np.log([e["시세"], e["판매속도"], 10000 / e["재고"]])))), 1)
                e["label"] = "강세" if e["시황"] >= 102 else ("약세" if e["시황"] <= 98 else "보합")
            ns = [e[k] for k in ["n_price", "n_start", "n_stock"] if k in e]
            e["low_sample"] = bool(ns) and min(ns) < MIN_N
            if len(e) > 2: pts.append(e)
        if pts:
            series[f"{key[0]}|{key[1]}"] = pts
    gap = {iv["c"]: iv for iv in ivs}
    log = []
    for i, c in enumerate(crawls):
        g = (obs[c] - obs[crawls[i - 1]]).days if i else None
        notes = []
        if i == 0: notes.append("첫 수집 — 판매속도 없음")
        elif g > SPEED_DAYS[1]: notes.append(f"{g}일 공백 — 판매속도 계산 안 함")
        elif g < SPEED_DAYS[0]: notes.append("간격이 짧아 판매속도 계산 안 함")
        iv = gap.get(c)
        if iv and iv["bad"]:
            regs = sorted({x.split("·")[1] for x in iv["bad"]})
            notes.append(f"목록 누락 의심({'·'.join(regs)}, 상세 기준 약 {iv['missing']:,.0f}대) — 해당 칸 판매속도 제외"
                         + (", 재고 계산 제외" if iv["missing"] / iv["start_all"] > STOCK_GAP_MAX else ""))
        if c.strftime("%Y-%m-%d") != obs[c].strftime("%Y-%m-%d"):
            notes.append(f"파이프라인 기록일 {c:%m/%d}")
        log.append({"date": obs[c].strftime("%Y-%m-%d"), "crawl": c.strftime("%Y-%m-%d"), "gap_days": g, "note": " · ".join(notes)})
    return series, log, LC


def report(series, log, LC, L, crawls, obs):
    lines = [f"시황 지수(D4) — {datetime.datetime.now():%Y-%m-%d %H:%M} · 기준기간 {BASE[0]}~{BASE[1]} = 100 · 날짜는 목록 관측일", ""]
    for x in log:
        lines.append(f"  {x['date']}" + (f" (+{x['gap_days']}일)" if x["gap_days"] else "") + (f"  {x['note']}" if x["note"] else ""))
    for key in ["전체|전체", "국산|전체", "수입|전체"]:
        lines += ["", f"[{key.split('|')[0]}] 날짜 · 시세 · 판매속도 · 재고 · 시황 (신규 비교 / 시작 재고 / 재고)"]
        for e in series.get(key, []):
            lines.append(f"  {e['date']}  {e.get('시세', '—'):>6}  {e.get('판매속도', '—'):>6}  {e.get('재고', '—'):>6}{'*' if e.get('stock_est') else ' '}"
                         f"  {e.get('시황', '—'):>6} {e.get('label', '  '):<2}  ({e.get('n_price', 0):,} / {e.get('n_start', 0):,} / {e.get('n_stock', 0):,})")
    last = obs[crawls[-1]].strftime("%Y-%m-%d")
    lines += ["", "  * 재고: 목록 실측이 없는 회차는 로그 국산 비율 × 상세 차급 구성으로 추정", "", f"[{last} 차급별 — 전체 기준]"]
    for key, pts in series.items():
        o, s = key.split("|")
        if o != "전체" or s == "전체": continue
        e = next((x for x in pts if x["date"] == last), None)
        if e is None: continue
        lines.append(f"  {s:<4} 시세 {e.get('시세', '—'):>6} · 재고 {e.get('재고', '—'):>6} · 신규 비교 {e.get('n_price', 0):,}"
                     + (" (표본 적음)" if e["low_sample"] else ""))
    for o in sorted(set(LC["관측일"])):                                            # 재고 추정식 점검: 목록 실측 회차에서 비교
        cs = [c for c in crawls if obs[c].strftime("%Y-%m-%d") == o]
        if not cs: continue
        d = LC[LC["관측일"] == o]
        on = L[(L["첫관측일"] <= cs[0]) & (L["마지막관측일"] >= cs[0])]
        tot = d["대수"].sum()
        errs = []
        for org in ["국산", "수입"]:
            sub_l, sub_t = d[d["origin"] == org], on[on["origin"] == org]
            for s, g in sub_t.groupby("seg"):
                act = sub_l.loc[sub_l["seg"] == s, "대수"].sum()
                if act >= MIN_N:
                    errs.append(f"{org}{s} {sub_l['대수'].sum() * len(g) / len(sub_t) / act * 100 - 100:+.0f}%")
        lines += ["", f"[재고 추정식 점검 — {o} 목록 실측 대비] 국산 비율 실측 {d.loc[d['origin'] == '국산', '대수'].sum() / tot:.3f} "
                      f"(추정식에 쓰는 7/01 로그 값 {LOG_DOMESTIC_SHARE:.3f})", "  상세 기준 차급 구성의 오차: " + ", ".join(errs)]
    text = "\n".join(lines)
    with open(REPORT, "w", encoding="utf-8") as f:
        f.write(text + "\n")
    return text


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    t0 = datetime.datetime.now()
    L, crawls, obs, total = load()
    with open(COEF, encoding="utf-8") as f:
        C = json.load(f)
    series, log, LC = build(L, crawls, obs, total, C)
    out = {"version": datetime.date.today().isoformat(), "base_period": list(BASE),
           "note": "엔카 매물로 계산한 시황 지수(기획안 5.2.1). 기준기간 = 100. 날짜는 목록 관측일. 매주 전체를 다시 계산한다",
           "definitions": {
               "시세": "신규 매물(등록 7일 이내) 첫 호가를 기준기간의 같은 모델·등급·세부등급 신규 매물과 비교. 성능감가율·D3 계수(차령·주행·색상·렌트)로 조건을 맞춘 뒤 차이의 중앙값",
               "판매속도": "구간 판매 ÷ 시작 재고(7일 환산). 등록 후 경과일 구간별 판매율을 기준기간 재고 구성으로 가중. 간격 5~16일 구간만, 재등록 제외, 목록 누락 칸 제외",
               "재고": "목록 매물 수(중복 제거) ÷ 기준기간 평균. 세그먼트는 목록 구성비로 나눔(stock_est = 구성비 추정)",
               "시황": "시세·판매속도·(10000÷재고)의 기하평균. 102 이상 강세, 98 이하 약세, 그 사이 보합"},
           "crawls": log, "series": series}
    with open(OUT_JSON, "w", encoding="utf-8", newline="\n") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
        f.write("\n")
    print(report(series, log, LC, L, crawls, obs))
    print(f"→ {OUT_JSON} ({os.path.getsize(OUT_JSON) / 1024:.0f}KB) · {(datetime.datetime.now() - t0).seconds}초")


if __name__ == "__main__":
    main()
