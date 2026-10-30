# -*- coding: utf-8 -*-
"""
model_report.py — 모델 리포트 데이터 (기획안 v2.21 5.5.2): "이 세부모델은 지금 시장에서 어떤가?"

    python model_report.py      → web/data/report/index.json(세부모델 목록 · 동급 잔존율 곡선 · 이상 매물 수)
                                  + web/data/report/<모델그룹 파일>.json(시세 산정 comps 와 같은 이름, 모델그룹마다)
                                  + web/downloads/residual_curves.csv(데이터 탭 내려받기, CP949)
                                  매주 auto_update 2.92단계(비교 매물 파일 다음). 끝에 출력 계약을 검사한다(어긋나면 종료 코드 1)

날짜는 목록 관측일(market_index.json crawls 의 crawl → date: 10/26 크롤 = 10/21 목록). 차급 = '대형·국산'(차급·국산수입 —
세부모델의 판매중 최빈값, market_models와 같음). 국산 결측은 제조사 최빈값. 가격 통계에서 더미가·인수금의심·가격이상·핵심결측·중복은 뺀다
  · 잔존율 rv: 판매중 현재가 ÷ 출고가(출고가 > 0, 0.05~1.5만). 차령 연차(차령개월 ÷ 12, 12 = 12년 이상)별 중앙·25~75%·중앙 호가.
               세부모델은 연차당 10대 이상(화면은 20대 미만을 흐리게), 차급 seg_rv는 20대 이상
  · 잔존가치 지수 rvi: 판매중 매물마다 잔존율 ÷ 같은 차급·국산수입 × 정확한 차령 연차(0~30년) 중앙(20대 이상 — 모자라면 앞뒤 1년을
               묶은 칸, 그래도 모자라면 그 매물은 뺌), 그 가운데 값 × 100(동급 = 100). 계산 대수 20대 미만이면 없음. 화면용 seg_rv(0~12+)와 따로 센다
  · 잔존율 변화 rv_chg: 신규 매물(목록 관측일 − 엔카 등록일 ≤ 7일)의 첫 호가 ÷ 출고가를 같은 연차끼리
               기준기간(7/01~7/15 목록)과 최근 4주(마지막 목록 관측일에서 28일 안)로 비교. 양쪽 10대 이상
  · 흐름 flows: market_index.flows()와 같은 정의를 세부모델로(전체 범위) — 판매중 확인 · 신규 유입/주 · 판매/주(재등록 제외) · 간격일.
               수집 품질(목록 누락·전남광주 누락) 회차는 market_index.json series '전체|전체' 표시를 rules.flows 문장으로 옮긴다
  · 가격 인하 cut: w = 이번 주 같은 매물(price_obs 직전·마지막 목록에 모두 있는 상세 확인 판매중 매물) · on = 판매중의 첫 호가 대비 ·
               first_cut_days = 등록 후 첫 인하까지 중위 일수(price_obs 3회 이상부터, 생존 분석). 변화액·변화율은 음수(내림).
               한 주 가격이 이번 ÷ 지난 < 0.5 또는 > 2.0 이면 호가 오타·자리값으로 보고 뺀다(w 는 그 관측, first_cut_days 는 그 매물 — pulse_data.py 와 같은 규칙)
  · 이상 의심 low: 판매중 비교 후보(price_engine.load_pool)마다 자신·같은 차를 빼고 추정(validate와 같은 입력, 성능 상태 입력 기준,
               계수 adj_coef.json). 호가 ÷ 추정 < 0.75 이고 신뢰도 A·B(확인이 필요한 매물 — 판매자 잘못으로 단정하지 않음). 세부모델마다 비율 낮은 순 20대
  · 오래 안 팔리는 old: 판매중 · 체류 365일 이상 · 현재가 < 첫 호가. 체류일 긴 순 20대
"""
import os, re, sys, json, glob, time, datetime
import numpy as np
import pandas as pd
import market_index as MX
import price_engine as PE

ROOT = os.path.dirname(os.path.abspath(__file__))
PREP = os.path.join(ROOT, "encar_output", "prep")
DATA = os.path.join(ROOT, "web", "data")
OUT = os.path.join(DATA, "report")                                  # 모델 리포트 — 매주 auto_update가 web/data와 함께 커밋
CSV = os.path.join(ROOT, "web", "downloads", "residual_curves.csv")

BASE, NEW_DAYS = MX.BASE, MX.NEW_DAYS     # 기준기간(7/01~7/15 목록) · 신규 매물(엔카 등록 7일 이내) — 시황 지수와 같게
RECENT_DAYS = 28                          # 잔존율 변화의 최근 4주(마지막 목록 관측일에서 28일 안)
RV_RANGE = (0.05, 1.5)                    # 잔존율로 쓰는 범위(출고가 이상값 거름)
AGE_TOP = 12                              # 연차 12 = 12년 이상
RV_MIN, SEG_MIN, RVI_MIN = 10, 20, 20     # 세부모델 연차 · 차급 연차 · 잔존가치 지수 최소 대수
RVI_AGE = 30                              # 잔존가치 지수 기준 칸의 정확한 연차 0~30(30 = 30년 이상)
LOW_RATIO, LOW_GRADES = 0.75, ("A", "B")
ON_CHG_MIN = 20                           # 판매중 지난주 대비(on_chg): 지난 목록 판매중 20대 이상 · 간격 5~16일 · 전남광주 누락·수집 범위가 두 목록에서 같을 때만
OLD_DAYS = 365                            # 체류 365일 이상 + 첫 호가보다 내림(판매중의 약 2.4%)
PX_RATIO = (0.5, 2.0)                     # 한 주 가격 이번 ÷ 지난이 이 밖이면 호가 오타·자리값(경계 포함, pulse_data.PX_RATIO 와 같음)
TOP = 20                                  # 매물 목록 최대 대수
CUT_OBS, CUT_MIN = 3, 20                  # 첫 인하까지 일수: price_obs 3회 이상 · 세부모델 20대 이상
FLAGS = ["더미가", "인수금의심", "가격이상", "핵심결측", "중복"]
CSV_COLS = ["구분", "제조사", "모델", "세부모델", "차급", "국산수입", "차령(년)", "잔존율 중앙(%)", "25%(%)", "75%(%)", "중앙 호가(만원)", "대수"]


def r1(x):
    return None if x is None or pd.isna(x) else round(float(x), 1)


def r3(x):
    return None if x is None or pd.isna(x) else round(float(x), 3)


def num(x):
    """JSON 숫자 — 결측은 None, 정수 값은 int"""
    if x is None or pd.isna(x):
        return None
    x = float(x)
    return int(x) if x.is_integer() else x


def ymd(t):
    return t.strftime("%Y-%m-%d")


def md(s):
    """'2026-07-30' → '7/30'"""
    return f"{int(s[5:7])}/{int(s[8:10])}"


# ───────── 읽기 ─────────
def read_mi():
    with open(os.path.join(DATA, "market_index.json"), encoding="utf-8") as f:
        return json.load(f)


def to_obs_map(mi):
    """크롤일 → 목록 관측일(10/26 → 10/21)"""
    return {x["crawl"]: x["date"] for x in mi["crawls"]}


def load(mi):
    """상세가 있는 매물 — 첫관측일·마지막관측일·판매추정일을 목록 관측일(Timestamp)로. → (L, 목록 관측일 목록)"""
    L = pd.read_parquet(os.path.join(PREP, "listings.parquet"),
                        columns=["상태", "첫관측일", "마지막관측일", "판매추정일", "엔카등록일", "제조사", "모델", "등급", "국산", "차급",
                                 "등록연월", "차령개월", "주행km", "출고가", "현재가", "첫가격", "체류일"] + FLAGS)
    L = L[L["첫관측일"].notna()].copy()
    to_obs = to_obs_map(mi)
    for c in ["첫관측일", "마지막관측일", "판매추정일"]:
        s = L[c].astype(object).map(lambda v: to_obs.get(v, v) if isinstance(v, str) else None)
        L[c] = pd.to_datetime(s, errors="coerce")
    mk = L.groupby("제조사")["국산"].agg(lambda s: s.mode().iat[0] if s.notna().any() else np.nan)
    dom = L["국산"].where(L["국산"].notna(), L["제조사"].map(mk))
    L["origin"] = np.where(dom.eq(False), "수입", "국산")
    L["seg"] = L["차급"].fillna("기타")
    L["key"] = L["제조사"] + "|" + L["모델"]
    days = sorted(set(L["첫관측일"].dropna()) | set(L["마지막관측일"].dropna()))
    return L, days


def model_seg(L, on):
    """세부모델 차급 '대형·국산' — 판매중의 차급·국산수입 최빈값(market_models와 같음), 판매중이 없으면 전체 최빈값"""
    mode = lambda s: s.mode().iat[0]
    f = lambda d: d.groupby("key")["seg"].agg(mode) + "·" + d.groupby("key")["origin"].agg(mode)
    a, b = f(on), f(L)
    return pd.concat([a, b[~b.index.isin(a.index)]])


def price_ok(d):
    return ~d[FLAGS].eq(True).any(axis=1)


# ───────── 잔존율 ─────────
def resid_frame(on, segk):
    """판매중 잔존율 표 — 가격 플래그 제외 · 출고가 > 0 · 잔존율 0.05~1.5 · 연차(12 = 12년 이상) · 세부모델 차급(sk)"""
    d = on[price_ok(on) & on["출고가"].gt(0) & on["현재가"].gt(0) & on["차령개월"].between(0, 600)].copy()
    d["r"] = d["현재가"] / d["출고가"]
    d = d[d["r"].between(*RV_RANGE)].copy()
    d["yr"] = (d["차령개월"] // 12).clip(upper=AGE_TOP).astype(int)
    d["yx"] = (d["차령개월"] // 12).clip(upper=RVI_AGE).astype(int)               # 잔존가치 지수용 정확한 연차
    d["sk"] = d["key"].map(segk)
    return d


def curve(d, by, n_min):
    """연차별 잔존율 중앙·25%·75%·중앙 호가·대수(n_min대 이상)"""
    g = d.groupby(by)
    t = pd.DataFrame({"med": g["r"].median(), "q1": g["r"].quantile(0.25), "q3": g["r"].quantile(0.75),
                      "price": g["현재가"].median(), "n": g.size()})
    return t[t["n"] >= n_min]


def rvi_ref(d):
    """잔존가치 지수 기준 — {(차급, 정확한 연차): (중앙 잔존율, 'x'|'p')}. 그 칸이 20대 이상이면 그 칸('x'),
    모자라면 앞뒤 1년을 묶은 칸이 20대 이상일 때 그 중앙('p'), 그래도 모자라면 없음"""
    ref = {}
    for sk, g in d.groupby("sk"):
        by = {int(y): x["r"].values for y, x in g.groupby("yx")}
        for y, v in by.items():
            if len(v) >= SEG_MIN:
                ref[(sk, y)] = (float(np.median(v)), "x")
                continue
            w = np.concatenate([by[z] for z in (y - 1, y, y + 1) if z in by])
            if len(w) >= SEG_MIN:
                ref[(sk, y)] = (float(np.median(w)), "p")
    return ref


def rv_index(d):
    """잔존가치 지수 — 매물 잔존율 ÷ 같은 차급·정확한 연차 기준(rvi_ref)의 세부모델 가운데 값 × 100. 계산 대수 20대 미만이면 NaN.
    → (표 {rvi, rvn}, 집계 {x 정확한 칸, p 앞뒤 묶음, out 기준 없음})"""
    rf = rvi_ref(d)
    hit =[rf.get((s, y)) for s, y in zip(d["sk"], d["yx"])]
    ref = pd.Series([h[0] if h else np.nan for h in hit], index=d.index)
    kind = pd.Series([h[1] if h else "out" for h in hit], index=d.index)
    x = (d["r"] / ref).dropna()
    g = x.groupby(d.loc[x.index, "key"]).agg(["median", "size"])
    stat = {k: int((kind == k).sum()) for k in ["x", "p", "out"]}
    return pd.DataFrame({"rvi": (g["median"] * 100).where(g["size"] >= RVI_MIN), "rvn": g["size"]}), stat


def rv_change(L, last):
    """잔존율 변화 — 신규 매물(목록 관측일 − 엔카 등록일 ≤ 7일)의 첫 호가 ÷ 출고가. 같은 세부모델·연차의
    기준기간 vs 최근 4주 중앙(양쪽 10대 이상). 연차는 처음 본 목록 관측일 기준"""
    d = L[price_ok(L) & L["출고가"].gt(0) & L["첫가격"].gt(0) & L["등록연월"].notna()]
    d = d[(d["첫관측일"] - d["엔카등록일"]).dt.days <= NEW_DAYS].copy()
    reg = (d["등록연월"] // 100) * 12 + d["등록연월"] % 100
    age = d["첫관측일"].dt.year * 12 + d["첫관측일"].dt.month - reg
    d["r"] = d["첫가격"] / d["출고가"]
    d["yr"] = (age // 12).clip(upper=AGE_TOP)
    d = d[age.between(0, 600) & d["r"].between(*RV_RANGE)]
    agg = lambda x: x.groupby(["key", "yr"])["r"].agg(["median", "size"])
    b = agg(d[d["첫관측일"].between(pd.Timestamp(BASE[0]), pd.Timestamp(BASE[1]))])
    n = agg(d[(last - d["첫관측일"]).dt.days < RECENT_DAYS])
    j = b.join(n, lsuffix="_b", rsuffix="_n", how="inner")
    return j[(j["size_b"] >= RV_MIN) & (j["size_n"] >= RV_MIN)]


# ───────── 흐름 ─────────
def flows(L, days):
    """market_index.flows()와 같은 정의를 세부모델로(전체 범위) — 목록 관측일마다 (날짜, 판매중, 신규 유입, 판매, 간격일).
    판매중 = 그 목록에 있던 상세 확인 매물 · 유입 = 직전 목록 관측일 뒤 엔카 등록 · 판매 = 그 목록에서 사라짐(재등록 제외)"""
    out = []
    for i, c in enumerate(days):
        on = L.loc[(L["첫관측일"] <= c) & (L["마지막관측일"] >= c), "key"].value_counts()
        if not i:
            out.append((c, on, None, None, None))
            continue
        p = days[i - 1]
        new = L.loc[(L["첫관측일"] == c) & (L["엔카등록일"] > p), "key"].value_counts()
        sold = L.loc[(L["판매추정일"] == c) & (L["상태"] != "재등록"), "key"].value_counts()
        out.append((c, on, new, sold, (c - p).days))
    return out


def flow_quality(mi):
    """흐름 수집 품질 문장 — market_index.json series '전체|전체'의 sold_suspect(목록 누락으로 판매 부풂)·jn_gap(전남광주가 빠진 목록)·
    jn_gap_sold(시작 목록에 전남광주가 빠짐)를 목록 관측일로. 표시가 없으면 빈 문자열"""
    pts = mi.get("series", {}).get("전체|전체", [])
    pick = lambda f: [e["date"] for e in pts if f(e)]
    jd = lambda ds: "·".join(md(s) for s in ds)
    ss = pick(lambda e: e.get("sold_suspect"))
    jg = pick(lambda e: e.get("jn_gap"))
    jgs = pick(lambda e: e.get("jn_gap") and e.get("jn_gap_sold"))
    back = pick(lambda e: e.get("jn_gap_sold") and not e.get("jn_gap"))
    out = []
    if ss:
        out.append(f"{jd(ss)} 판매/주는 목록 일부(지역)가 빠져 부풀었을 수 있음")
    if jg:
        out.append(f"{jd(jg)} 목록은 전남광주 매물이 빠져 판매중·신규/주가 낮게 잡힘" + (f"({jd(jgs)}은 시작 목록도 빠져 판매/주도)" if jgs else ""))
    if back:
        out.append(f"{jd(back)} 목록에서 전남광주를 다시 수집 — 판매중이 그만큼 늘어 보이고, 판매/주는 시작 목록에 전남광주가 빠져 낮게 잡힘")
    return " · ".join(out)


def on_change_ok(mi):
    """판매중 지난주 대비(on_chg)를 낼 수 있는 주인지 — 마지막 두 목록 간격 5~16일, 전남광주 누락(jn_gap)이 같고,
    수집 범위가 넓어진 첫 회차(crawls note '7월 범위 밖'이 이번에 처음)가 아닐 때"""
    cr = mi.get("crawls", [])
    if len(cr) < 2 or not (5 <= (cr[-1].get("gap_days") or 0) <= 16):
        return False
    jn = {e["date"]: bool(e.get("jn_gap")) for e in mi.get("series", {}).get("전체|전체", [])}
    wide = lambda c: "7월 범위 밖" in (c.get("note") or "")
    return jn.get(cr[-1]["date"]) == jn.get(cr[-2]["date"]) and wide(cr[-1]) == wide(cr[-2])


def on_change(fr, ok):
    """세부모델 판매중의 지난 목록 대비 변화율(소수 3) — flows 마지막 두 행(같은 전체 범위 정의). 못 내면 None"""
    if not ok or len(fr) < 2 or fr[-2][1] < ON_CHG_MIN:
        return None
    return r3(fr[-1][1] / fr[-2][1] - 1)


def flow_rows(F, k):
    """[[목록 관측일, 판매중, 신규/주, 판매/주, 간격일], …] — 주간 값 = 구간 값 × 7 ÷ 간격일(소수 1). 첫 회차는 유입·판매 없음"""
    wk = lambda s, gap: None if s is None else num(round(s.get(k, 0) * 7 / gap, 1))
    return [[ymd(c), int(on.get(k, 0)), wk(new, gap), wk(sold, gap), gap] for c, on, new, sold, gap in F]


# ───────── 가격 인하 ─────────
def week_moves(on, P):
    """이번 주 같은 매물 — price_obs 직전·마지막 목록에 모두 있는 상세 확인 판매중 매물(가격 플래그·제조사 없음 제외)의 가격 변화.
    이번 ÷ 지난이 PX_RATIO 밖(가격 0·없음 포함)인 관측은 호가 오타·자리값으로 보고 뺀다. → (표 | None, 두 날짜, 뺀 관측 수)"""
    dates = sorted(P["관측일"].unique())
    if len(dates) < 2:
        return None, dates, 0
    px = lambda o: P.loc[P["관측일"] == o].drop_duplicates("매물ID").set_index("매물ID")["가격"]
    base = on.loc[price_ok(on) & on["상태"].eq("판매중") & on["제조사"].notna(), ["key"]]
    d = base.join(px(dates[-2]).rename("p0"), how="inner").join(px(dates[-1]).rename("p1"), how="inner")
    ok = (d["p1"] / d["p0"].where(d["p0"] > 0)).between(*PX_RATIO)
    d = d[ok].copy()
    d["chg"], d["amt"] = d["p1"] / d["p0"] - 1, d["p1"] - d["p0"]
    return d, dates[-2:], int((~ok).sum())


def move_stats(g):
    """{n, cut(내린 비율), up(올린 비율), med_pct(내린 매물의 중앙 변화율 %, 음수), med_amt(중앙 변화액 만원, 음수)}"""
    c = g["chg"] < 0
    return {"n": int(len(g)), "cut": r3(c.mean()), "up": r3((g["chg"] > 0).mean()),
            "med_pct": r1(g.loc[c, "chg"].median() * 100) if c.any() else None,
            "med_amt": num(round(float(g.loc[c, "amt"].median()))) if c.any() else None}


def on_cut(g):
    """판매중 매물 중 첫 호가보다 내린 비율 · 내린 매물의 중앙 변화액(만원)·변화율(%) — 음수"""
    c = g["현재가"] < g["첫가격"]
    x = g[c]
    return {"n": int(len(g)), "share": r3(c.mean()) if len(g) else None,
            "med_amt": num(round(float((x["현재가"] - x["첫가격"]).median()))) if len(x) else None,
            "med_pct": r1(((x["현재가"] / x["첫가격"] - 1) * 100).median()) if len(x) else None}


def km_median(t, e):
    """카플란-마이어 중위 시간 — t 일수, e 사건(인하) 여부. 생존이 0.5 이하로 내려가지 않으면 None"""
    s, n = 1.0, len(t)
    for u in np.unique(t):                                                          # 오름차순
        m = t == u
        d = int(e[m].sum())
        if d:
            s *= 1 - d / n
            if s <= 0.5:
                return float(u)
        n -= int(m.sum())
    return None


def first_cut_days(L, P):
    """등록 후 첫 인하까지 중위 일수(세부모델별) — price_obs가 3회 이상 쌓인 뒤부터. 첫 관측이 엔카 등록 7일 안인 매물(처음 호가부터 본 매물)이
    첫 관측 가격보다 내린 것을 처음 본 목록 관측일까지 일수. 아직 안 내렸거나 내리기 전에 사라진 매물은 마지막 관측에서 끊는다(카플란-마이어). 20대 이상.
    연속 관측 사이 가격이 이번 ÷ 지난 PX_RATIO 밖으로 바뀐 매물(호가 오타·자리값 — 990 → 399 등)은 통째로 뺀다"""
    if P["관측일"].nunique() < CUT_OBS:
        return {}
    P = P[P["가격"] > 0].sort_values(["매물ID", "관측일"])
    q = P["가격"] / P.groupby("매물ID")["가격"].shift()
    P = P[~P["매물ID"].isin(P.loc[q.notna() & ~q.between(*PX_RATIO), "매물ID"])]
    p0 = P.groupby("매물ID")["가격"].transform("first")
    g = P.groupby("매물ID")["관측일"]
    S = pd.DataFrame({"d0": g.first(), "d1": g.last(), "dc": P[P["가격"] < p0].groupby("매물ID")["관측일"].first()})
    S = S.apply(pd.to_datetime).join(L.loc[price_ok(L), ["key", "엔카등록일"]], how="inner")
    S = S[(S["d0"] - S["엔카등록일"]).dt.days <= NEW_DAYS]
    t = S["dc"].fillna(S["d1"]) - S["엔카등록일"]
    S = S.assign(t=t.dt.days.clip(lower=0), e=S["dc"].notna())
    out = {}
    for k, s in S.groupby("key"):
        if len(s) >= CUT_MIN:
            m = km_median(s["t"].values, s["e"].values)
            if m is not None:
                out[k] = num(m)
    return out


# ───────── 매물 목록 ─────────
def low_flags():
    """이상 의심 — 판매중 비교 후보마다 자신·같은 차를 빼고 추정(price_engine.validate의 t, 성능 상태 입력 기준, 계수 adj_coef.json).
    → (호가 ÷ 추정 < 0.75 · 신뢰도 A·B 매물 표, 집계 {후보, 추정, 75% 미만(신뢰도 무관)}, 비교 후보 차급)"""
    pool = PE.load_pool()
    with open(os.path.join(DATA, "adj_coef.json"), encoding="utf-8") as f:
        C = PE.coef_from_json(json.load(f))
    rows, n_est, n_any = [], 0, 0
    for k, g in pool.groupby("key"):
        tg = g[~g["sold"]]
        if tg.empty:
            continue
        G = PE.Group(g, C)
        for r in tg.itertuples():
            t = {"등급": r.등급, "세부": r.세부, "age": r.age, "km": r.km, "rent": r.rent,
                 "color": r.색상계열 if r.색상계열 in PE.COLORS or r.색상계열 == "흰색·진주" else None,
                 "dep": r.dep, "perf": float(r.성능등급), "exclude_id": r.Index, "carkey": r.차키 if isinstance(r.차키, str) else None}
            res = PE.estimate_one(G, t)
            if res is None:
                continue
            n_est += 1
            ratio = r.price / res["est"]
            if ratio >= LOW_RATIO:
                continue
            n_any += 1
            if res["grade"] in LOW_GRADES:
                rows.append((k, r.Index, r.price, res["est"], ratio, r.등록연월, r.주행km, r.등급, r.사고라벨))
    D = pd.DataFrame(rows, columns=["key", "id", "price", "est", "ratio", "reg", "km", "grade", "label"])
    stat = {"cand": int((~pool["sold"]).sum()), "est": n_est, "any": n_any}
    return D, stat, pool.groupby("key")["seg"].agg(lambda s: s.mode().iat[0])


def low_row(r):
    """[매물ID, 호가, 추정, 비율(소수 3, 버림 — 0.7496이 0.750으로 보이지 않게), 등록연월, 주행km, 등급, 사고라벨]"""
    return [int(r.id), num(round(float(r.price))), num(round(float(r.est))), r3(np.floor(r.ratio * 1000) / 1000), num(r.reg), num(r.km),
            r.grade if isinstance(r.grade, str) else "", r.label if isinstance(r.label, str) else "미상"]


def old_list(on):
    """오래 안 팔리는 — 판매중 · 체류 365일(OLD_DAYS) 이상 · 현재가 < 첫 호가(가격 플래그 제외). 체류일 긴 순"""
    d = on[price_ok(on) & on["현재가"].gt(0) & (on["현재가"] < on["첫가격"]) & (on["체류일"] >= OLD_DAYS)]
    return d.sort_index().sort_values("체류일", ascending=False, kind="stable")


def old_row(i, r):
    """[매물ID, 호가, 첫 호가, 체류일, 등록연월, 주행km, 등급]"""
    return [int(i), num(r["현재가"]), num(r["첫가격"]), num(r["체류일"]), num(r["등록연월"]), num(r["주행km"]),
            r["등급"] if isinstance(r["등급"], str) else ""]


# ───────── 합치기 ─────────
def rows_by_key(t, fn):
    """(세부모델, 연차) 색인 표 → {세부모델: [fn(연차, 행), …]}(연차 오름차순)"""
    out = {}
    for (k, y), x in t.iterrows():
        out.setdefault(k, []).append(fn(int(y), x))
    return out


def build():
    T = {"start": time.time()}
    mi = read_mi()
    L, days = load(mi)
    last = days[-1]
    on = L[(L["첫관측일"] <= last) & (L["마지막관측일"] >= last)]
    with open(os.path.join(DATA, "comps", "index.json"), encoding="utf-8") as f:
        I = json.load(f)
    with open(os.path.join(DATA, "market_models.json"), encoding="utf-8") as f:
        mm_on = {f"{m['maker']}|{m['model']}": int(m["on"]) for m in json.load(f)["models"]}
    segk = model_seg(L, on)
    R = resid_frame(on, segk)
    rv, seg = curve(R, ["key", "yr"], RV_MIN), curve(R, ["sk", "yr"], SEG_MIN)
    rvi, rvi_stat = rv_index(R)
    chg = rv_change(L, last)
    F = flows(L, days)
    chg_ok = on_change_ok(mi)
    P = pd.read_parquet(os.path.join(PREP, "price_obs.parquet"))
    P["관측일"] = P["관측일"].map(lambda v, m=to_obs_map(mi): m.get(v, v))                 # 크롤일로 적힌 회차도 목록 관측일로
    W, wd, n_bad = week_moves(on, P)
    fcd = first_cut_days(L, P)
    onc = on[price_ok(on) & on["첫가격"].gt(0) & on["현재가"].gt(0)]
    old = old_list(on)
    T["data"] = time.time()
    low, low_stat, pool_seg = low_flags()
    T["low"] = time.time()

    rv_by = rows_by_key(rv, lambda y, x: [y, r3(x["med"]), r3(x["q1"]), r3(x["q3"]), num(round(float(x["price"]))), int(x["n"])])
    chg_by = rows_by_key(chg, lambda y, x: [y, r3(x["median_b"]), r3(x["median_n"]), int(x["size_b"]), int(x["size_n"])])
    w_by = {k: move_stats(g) for k, g in W.groupby("key")} if W is not None else {}
    onc_by = {k: on_cut(g) for k, g in onc.groupby("key")}
    low = low.sort_values(["ratio", "id"], kind="stable")
    low_n, low_by = low["key"].value_counts(), {k: [low_row(r) for r in g.head(TOP).itertuples()] for k, g in low.groupby("key", sort=False)}
    old_n, old_by = old["key"].value_counts(), {k: [old_row(i, r) for i, r in g.head(TOP).iterrows()] for k, g in old.groupby("key", sort=False)}
    on_n = on["key"].value_counts()
    empty_on = {"n": 0, "share": None, "med_amt": None, "med_pct": None}

    version, date = datetime.date.today().isoformat(), ymd(last)
    models, files, miss_seg = {}, {}, []
    for mk in I["makers"]:
        for gr in mk["groups"]:
            body = {}
            for m in gr["models"]:
                k = f"{mk['name']}|{m['name']}"
                sk = segk.get(k) or pool_seg.get(k)
                if not isinstance(segk.get(k), str):
                    miss_seg.append(k)
                w = w_by.get(k)
                fr = flow_rows(F, k)
                body[m["name"]] = {"seg": sk, "rv": rv_by.get(k, []), "rv_chg": chg_by.get(k, []), "flows": fr,
                                   "cut": {"w": w, "on": onc_by.get(k, empty_on), "first_cut_days": fcd.get(k)},
                                   "low": low_by.get(k, []), "old": old_by.get(k, [])}
                models[k] = {"group": gr["name"], "file": gr["file"], "seg": sk, "on": mm_on.get(k, int(on_n.get(k, 0))),
                             "rvi": r1(rvi["rvi"].get(k)), "rvn": int(rvi["rvn"].get(k, 0)),
                             "low": int(low_n.get(k, 0)), "old": int(old_n.get(k, 0)),
                             "cut_w": w["cut"] if w else None, "cut_w_n": w["n"] if w else 0, "on_chg": on_change(fr, chg_ok)}
            files[gr["file"]] = {"version": version, "date": date, "maker": mk["name"], "group": gr["name"], "models": body}
    seg_rv = {}
    for (sk, y), x in seg.iterrows():
        seg_rv.setdefault(sk, []).append([int(y), r3(x["med"]), r3(x["q1"]), r3(x["q3"]), int(x["n"])])
    wtxt = f"직전 목록({md(wd[0])}) → 마지막 목록({md(wd[1])})" if W is not None else "직전 → 마지막 목록"
    fq = flow_quality(mi)
    index = {"version": version, "date": date,
             "rules": {
                 "low": "추정 시세의 75% 미만 · 신뢰도 A·B(추정보다 크게 싼 매물 — 사고·상태·호가 입력 오류 등 확인 필요)",
                 "old": f"체류 {OLD_DAYS}일 이상 · 첫 호가보다 내린 판매중 매물",
                 "rvi": "판매중 매물마다 잔존율 ÷ 같은 차급·국산수입 × 정확한 차령 연차(0~30년)의 중앙 잔존율(그 칸이 20대 미만이면 앞뒤 1년을 묶은 칸, "
                        "그래도 20대 미만이면 그 매물은 뺌), 그 가운데 값 × 100(동급 = 100). 계산 대수가 20대 미만이면 없음 — "
                        "출고가가 없거나 동급 매물이 적은 연차(아주 오래된 차·수입 화물 등)라 기준 칸이 없는 매물은 계산 대수에서 빠짐. "
                        "기준 칸은 정확한 연차라 화면용 동급 곡선(seg_rv, 12년 이상 한 칸·20대 이상)이 없는 차급에도 지수가 있을 수 있음",
                 "rv": "잔존율 = 판매중 매물의 현재 호가 ÷ 출고가(출고가가 있고 0.05~1.5인 매물). 차령 연차별 중앙·25~75%·중앙 호가, 연차 12 = 12년 이상. "
                       "세부모델은 연차당 10대 이상(20대 미만은 참고), 차급은 20대 이상",
                 "rv_chg": "신규 매물(엔카 등록 7일 안에 목록에서 처음 본 매물)의 첫 호가 ÷ 출고가를 같은 연차끼리 기준기간(7/01~7/15 목록)과 "
                           "최근 4주(마지막 목록 관측일에서 28일 안)로 비교. 양쪽 10대 이상",
                 "flows": "목록 관측일마다 판매중 확인 매물 · 신규 유입/주(직전 목록 관측일 뒤 엔카 등록) · 판매/주(목록에서 사라짐, 재등록 제외) · 간격일. "
                          "첫 회차는 유입·판매 없음, 간격이 5~16일이 아니면 참고용" + (f". 수집 품질: {fq}" if fq else "") +
                          f". index on_chg = 판매중(flows) 지난 목록 대비 변화율 — 지난 목록 {ON_CHG_MIN}대 이상, 간격 5~16일, "
                          "전남광주 누락·수집 범위가 두 목록에서 같을 때만",
                 "cut": f"w = 이번 주 같은 매물({wtxt}에 모두 있는 상세 확인 판매중 매물)의 내린·올린 비율과 내린 매물의 중앙 변화율(%)·변화액(만원, 음수). "
                        f"한 주 가격이 절반 미만·2배 초과로 바뀐 관측은 호가 오타·자리값으로 보고 뺌(이번 주 {n_bad:,}대) · "
                        "on = 판매중 매물 중 첫 호가보다 내린 비율과 내린 매물의 중앙 변화액·변화율 · "
                        f"first_cut_days = 등록 후 첫 인하까지 중위 일수(주간 목록 가격이 3회 이상 쌓인 뒤, {CUT_MIN}대 이상 — "
                        "연속 관측 사이 가격이 절반 미만·2배 초과로 바뀐 매물은 뺌)",
                 "price": "가격 통계에서 더미가·인수금 의심·가격 이상·핵심 결측·중복 매물은 뺀다. 날짜는 목록 관측일. "
                          "세부모델은 시세 산정 목록에 있는 것만 담아 flags_total 등 합계는 시장 전체보다 조금 작을 수 있음"},
             "seg_rv": seg_rv,
             "flags_total": {"low": sum(m["low"] for m in models.values()), "old": sum(m["old"] for m in models.values())},
             "models": models}
    info = {"T": T, "low_stat": low_stat, "miss_seg": miss_seg, "wd": wd, "fcd": len(fcd), "rv": rv, "seg": seg,
            "on": len(on), "R": len(R), "W": 0 if W is None else len(W), "n_bad": n_bad, "rvi_stat": rvi_stat, "fq": fq,
            "mm_on": mm_on, "days": days}
    return index, files, info


def write(index, files, rv, seg, I):
    os.makedirs(OUT, exist_ok=True)
    dump = lambda name, obj: _dump(os.path.join(OUT, name), obj)
    dump("index.json", index)
    for fname, obj in files.items():
        dump(fname, obj)
    keep = set(files) | {"index.json"}
    stale = [p for p in glob.glob(os.path.join(OUT, "*.json")) if os.path.basename(p) not in keep]
    for p in stale:                                                                # 없어진 모델그룹 파일
        os.remove(p)
    write_csv(index, rv, seg, I)
    return len(stale)


def _dump(path, obj):
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
        f.write("\n")


def write_csv(index, rv, seg, I):
    """데이터 탭 내려받기: 세부모델·차급 감가 곡선. 엑셀에서 바로 열리게 CP949 — market_index.write_csvs와 같은 방식"""
    yr = lambda y: f"{AGE_TOP} 이상" if y >= AGE_TOP else y
    pct = lambda v: round(float(v) * 100, 1)
    rows, have = [], set(rv.index.get_level_values(0))
    for mk in I["makers"]:
        for gr in mk["groups"]:
            for m in gr["models"]:
                k = f"{mk['name']}|{m['name']}"
                if k not in have:
                    continue
                s, o = index["models"][k]["seg"].split("·")
                for y, x in rv.loc[k].iterrows():
                    rows.append(["세부모델", mk["name"], gr["name"], m["name"], s, o, yr(y), pct(x["med"]), pct(x["q1"]), pct(x["q3"]),
                                 int(round(float(x["price"]))), int(x["n"])])
    for (sk, y), x in seg.iterrows():
        s, o = sk.split("·")
        rows.append(["차급", None, None, None, s, o, yr(y), pct(x["med"]), pct(x["q1"]), pct(x["q3"]), int(round(float(x["price"]))), int(x["n"])])
    pd.DataFrame(rows, columns=CSV_COLS).to_csv(CSV, index=False, encoding="cp949", errors="replace")
    return len(rows)


# ───────── 출력 계약 검사 (명세 2.2~2.4) ─────────
def _read_strict(path):
    def bad(c):
        raise ValueError(f"{c} 값")
    with open(path, encoding="utf-8") as f:
        txt = f.read()
    return json.loads(txt, parse_constant=bad), txt


def check(I, mm_on, wd=()):
    """모든 그룹 파일 존재 · 키 · 형식 · 합계 · price_obs 마지막 회차 = 목록 관측일 · CSV 이름(CP949 대체 없음). → (문제 목록, 주의 목록)"""
    err, warn = [], []
    E = lambda cond, msg: cond or err.append(msg)
    isint = lambda v: isinstance(v, int) and not isinstance(v, bool)
    isnum = lambda v: isinstance(v, (int, float)) and not isinstance(v, bool)
    rate = lambda v: isnum(v) and RV_RANGE[0] - 1e-9 <= v <= RV_RANGE[1] + 1e-9
    ratio01 = lambda v: v is None or (isnum(v) and 0 <= v <= 1)
    try:
        X, txt = _read_strict(os.path.join(OUT, "index.json"))
    except Exception as e:
        return [f"index.json 읽기 실패: {e}"], warn
    E(set(X) == {"version", "date", "rules", "seg_rv", "flags_total", "models"}, f"index 키 {sorted(X)}")
    E("환산" not in txt, "index.json 에 '환산'")
    E(len(wd) < 2 or wd[-1] == X["date"], f"같은 매물 가격(price_obs) 마지막 회차 {wd[-1] if wd else None} ≠ 목록 관측일 {X['date']} — "
                                          "크롤일→목록 관측일 연결(market_index OBS_FIX) 확인")
    E(all(isinstance(X["rules"].get(k), str) for k in ["low", "old", "rvi"]), "rules low·old·rvi")
    for sk, rows in X["seg_rv"].items():
        E(re.fullmatch(r".+·(국산|수입)", sk) is not None, f"seg_rv 키 {sk}")
        ys = [r[0] for r in rows]
        E(ys == sorted(set(ys)), f"seg_rv {sk} 연차 순서")
        for r in rows:
            E(len(r) == 5 and isint(r[0]) and 0 <= r[0] <= AGE_TOP and all(rate(v) for v in r[1:4]) and r[1] >= r[2] - 1e-9
              and r[1] <= r[3] + 1e-9 and isint(r[4]) and r[4] >= SEG_MIN, f"seg_rv {sk} 행 {r}")
    want = {f"{mk['name']}|{m['name']}": (gr, m) for mk in I["makers"] for gr in mk["groups"] for m in gr["models"]}
    E(set(X["models"]) == set(want), f"models 키 수 {len(X['models'])} ≠ comps {len(want)}")
    mkeys = {"group", "file", "seg", "on", "rvi", "rvn", "low", "old", "cut_w", "cut_w_n", "on_chg"}
    for k, m in X["models"].items():
        E(set(m) == mkeys, f"{k} 키 {sorted(m)}")
        if set(m) != mkeys:
            continue
        E(re.fullmatch(r"g[0-9a-f]{8}\.json", m["file"]) is not None and k in want and m["file"] == want[k][0]["file"], f"{k} file")
        E(isinstance(m["seg"], str) and re.fullmatch(r".+·(국산|수입)", m["seg"]) is not None, f"{k} seg {m['seg']}")
        E(all(isint(m[c]) and m[c] >= 0 for c in ["on", "rvn", "low", "old", "cut_w_n"]), f"{k} 정수 칸")
        E((m["rvi"] is None) == (m["rvn"] < RVI_MIN) and (m["rvi"] is None or isnum(m["rvi"]) and m["rvi"] > 0), f"{k} rvi {m['rvi']}/{m['rvn']}")
        E(ratio01(m["cut_w"]) and (m["cut_w"] is None) == (m["cut_w_n"] == 0), f"{k} cut_w")
        E(m["on_chg"] is None or (isnum(m["on_chg"]) and m["on_chg"] >= -1), f"{k} on_chg {m['on_chg']}")
    E(X["flags_total"] == {"low": sum(m["low"] for m in X["models"].values()), "old": sum(m["old"] for m in X["models"].values())},
      "flags_total 합계")
    dkeys, ckeys = {"seg", "rv", "rv_chg", "flows", "cut", "low", "old"}, {"w", "on", "first_cut_days"}
    n_flow_diff, csv_want, csv_n = 0, set(), 0
    for mk in I["makers"]:
        for gr in mk["groups"]:
            path = os.path.join(OUT, gr["file"])
            if not os.path.exists(path):
                err.append(f"그룹 파일 없음 {gr['file']}")
                continue
            try:
                G, gtxt = _read_strict(path)
            except Exception as e:
                err.append(f"{gr['file']} 읽기 실패: {e}")
                continue
            E("환산" not in gtxt, f"{gr['file']} 에 '환산'")
            E(set(G) == {"version", "date", "maker", "group", "models"} and G["maker"] == mk["name"] and G["group"] == gr["name"]
              and G["date"] == X["date"], f"{gr['file']} 머리")
            E(set(G["models"]) == {m["name"] for m in gr["models"]}, f"{gr['file']} 세부모델 목록")
            for name, d in G["models"].items():
                k, tag = f"{mk['name']}|{name}", f"{gr['file']} {name}"
                if set(d) != dkeys:
                    err.append(f"{tag} 키 {sorted(d)}")
                    continue
                xm = X["models"].get(k, {})
                E(d["seg"] == xm.get("seg"), f"{tag} seg")
                if d["rv"]:
                    csv_want.add((mk["name"], gr["name"], name))
                    csv_n += len(d["rv"])
                ys = [r[0] for r in d["rv"]]
                E(ys == sorted(set(ys)), f"{tag} rv 연차 순서")
                for r in d["rv"]:
                    E(len(r) == 6 and isint(r[0]) and 0 <= r[0] <= AGE_TOP and all(rate(v) for v in r[1:4]) and r[2] - 1e-9 <= r[1] <= r[3] + 1e-9
                      and isnum(r[4]) and r[4] > 0 and isint(r[5]) and r[5] >= RV_MIN, f"{tag} rv 행 {r}")
                for r in d["rv_chg"]:
                    E(len(r) == 5 and isint(r[0]) and rate(r[1]) and rate(r[2]) and isint(r[3]) and isint(r[4]) and min(r[3], r[4]) >= RV_MIN,
                      f"{tag} rv_chg 행 {r}")
                fl = d["flows"]
                E(len(fl) >= 1 and fl[0][2:] == [None, None, None], f"{tag} flows 첫 회차")
                E([r[0] for r in fl] == sorted({r[0] for r in fl}), f"{tag} flows 날짜")
                for r in fl[1:]:
                    E(len(r) == 5 and isint(r[1]) and isnum(r[2]) and isnum(r[3]) and isint(r[4]) and r[4] > 0, f"{tag} flows 행 {r}")
                if fl and k in mm_on and fl[-1][1] != mm_on[k]:
                    n_flow_diff += 1
                c = d["cut"]
                E(set(c) == ckeys, f"{tag} cut 키")
                if set(c) == ckeys:
                    w = c["w"]
                    E(w is None or (set(w) == {"n", "cut", "up", "med_pct", "med_amt"} and isint(w["n"]) and w["n"] > 0 and ratio01(w["cut"])
                                    and ratio01(w["up"]) and (w["med_pct"] is None or w["med_pct"] <= 0) and (w["med_amt"] is None or w["med_amt"] < 0)),
                      f"{tag} cut.w {w}")
                    E(xm.get("cut_w") == (w["cut"] if w else None) and xm.get("cut_w_n") == (w["n"] if w else 0), f"{tag} index cut_w")
                    o = c["on"]
                    E(set(o) == {"n", "share", "med_amt", "med_pct"} and isint(o["n"]) and ratio01(o["share"])
                      and (o["med_pct"] is None or o["med_pct"] <= 0) and (o["med_amt"] is None or o["med_amt"] < 0), f"{tag} cut.on {o}")
                    E(c["first_cut_days"] is None or (isnum(c["first_cut_days"]) and c["first_cut_days"] >= 0), f"{tag} first_cut_days")
                lo, ol = d["low"], d["old"]
                E(len(lo) <= TOP and len(lo) == min(TOP, xm.get("low", -1)), f"{tag} low 수 {len(lo)}/{xm.get('low')}")
                E(all(len(r) == 8 and isint(r[0]) and isnum(r[3]) and r[3] < LOW_RATIO and isinstance(r[6], str) and isinstance(r[7], str) for r in lo)
                  and [r[3] for r in lo] == sorted(r[3] for r in lo), f"{tag} low 행")
                E(len(ol) <= TOP and len(ol) == min(TOP, xm.get("old", -1)), f"{tag} old 수 {len(ol)}/{xm.get('old')}")
                E(all(len(r) == 7 and isint(r[0]) and r[3] >= OLD_DAYS and r[1] < r[2] for r in ol)
                  and [r[3] for r in ol] == sorted((r[3] for r in ol), reverse=True), f"{tag} old 행")
    extra = sorted(set(os.listdir(OUT)) - {gr["file"] for mk in I["makers"] for gr in mk["groups"]} - {"index.json"})
    E(not extra, f"report 폴더에 다른 파일 {extra[:5]}")
    try:                                                                            # CP949 밖 글자는 '?'로 바뀌므로 이름 집합으로 확인
        C = pd.read_csv(CSV, encoding="cp949", dtype=str, keep_default_na=False)
        E(list(C.columns) == CSV_COLS, f"CSV 열 {list(C.columns)}")
        if list(C.columns) == CSV_COLS:
            sm = C[C["구분"] == "세부모델"]
            got = set(zip(sm["제조사"], sm["모델"], sm["세부모델"]))
            E(got == csv_want, f"CSV 세부모델 이름이 그룹 파일과 다름(CP949 밖 글자 '?' 대체 등) {sorted(got ^ csv_want)[:3]}")
            E(len(sm) == csv_n, f"CSV 세부모델 행 {len(sm)} ≠ 그룹 파일 rv 행 {csv_n}")
            sg = C[C["구분"] == "차급"]
            E(set(sg["차급"] + "·" + sg["국산수입"]) == set(X["seg_rv"]) and len(sg) == sum(len(v) for v in X["seg_rv"].values()),
              "CSV 차급 행이 seg_rv 와 다름")
    except Exception as e:
        err.append(f"CSV 읽기 실패: {e}")
    if n_flow_diff:
        warn.append(f"flows 마지막 판매중이 market_models on 과 다른 세부모델 {n_flow_diff}개(market_models.json 이 묵었을 수 있음)")
    return err, warn


# ───────── 확인 출력 ─────────
SHOW = ["더 뉴 그랜저 IG", "카니발 4세대", "5시리즈 (G30)", "그랜저 (GN7)"]


def show(index, files):
    lines = []
    for name in SHOW:
        k = next((k for k in index["models"] if k.split("|", 1)[1] == name), None)
        if k is None:
            lines.append(f"[{name}] 없음")
            continue
        m = index["models"][k]
        d = files[m["file"]]["models"][name]
        lines.append(f"[{k}] {m['seg']} · 판매중 {m['on']:,} · 잔존가치 지수 {m['rvi']} ({m['rvn']:,}대) · 이상 의심 {m['low']} · 오래 안 팔림 {m['old']}"
                     f" · 이번 주 인하 {m['cut_w']} ({m['cut_w_n']:,}대) · 파일 {m['file']}")
        lines.append("   잔존율 연차: " + " · ".join(f"{r[0]}년 {r[1] * 100:.0f}%({r[5]})" for r in d["rv"]))
        if d["rv_chg"]:
            lines.append("   잔존율 변화(기준 → 최근 4주): " + " · ".join(f"{r[0]}년 {r[1] * 100:.1f}→{r[2] * 100:.1f}%({r[3]}/{r[4]})" for r in d["rv_chg"]))
        lines.append("   흐름(판매중·신규/주·판매/주·간격): " + " | ".join(f"{r[0][5:]} {r[1]:,}·{r[2]}·{r[3]}·{r[4]}" for r in d["flows"]))
        lines.append(f"   인하: 이번 주 {d['cut']['w']} · 첫 호가 대비 {d['cut']['on']} · 첫 인하까지 {d['cut']['first_cut_days']}")
        if d["low"]:
            lines.append("   이상 의심 앞 3대: " + " · ".join(f"{r[0]} 호가 {r[1]:,}/추정 {r[2]:,}({r[3]}) {r[4]} {r[5]:,}km {r[7]}" for r in d["low"][:3]))
        if d["old"]:
            lines.append("   오래 안 팔림 앞 3대: " + " · ".join(f"{r[0]} {r[1]:,}(첫 {r[2]:,}) {r[3]}일" for r in d["old"][:3]))
    return lines


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    index, files, info = build()
    with open(os.path.join(DATA, "comps", "index.json"), encoding="utf-8") as f:
        I = json.load(f)
    stale = write(index, files, info["rv"], info["seg"], I)
    T = info["T"]
    T["write"] = time.time()
    err, warn = check(I, info["mm_on"], info["wd"])
    T["check"] = time.time()
    ls = info["low_stat"]
    ms = index["models"].values()
    rvi = np.array([m["rvi"] for m in ms if m["rvi"] is not None and m["on"] >= 100])
    sizes = {p: os.path.getsize(p) for p in glob.glob(os.path.join(OUT, "*.json"))}
    gs = {p: v for p, v in sizes.items() if os.path.basename(p) != "index.json"}
    big = max(gs, key=gs.get)
    print(f"모델 리포트 — {datetime.datetime.now():%Y-%m-%d %H:%M} · 목록 관측일 {index['date']} ({len(info['days'])}회: "
          + ", ".join(ymd(d)[5:] for d in info["days"]) + ")")
    print(f"  판매중 {info['on']:,}대 · 잔존율 계산 {info['R']:,}대 · 세부모델 곡선 연차 {len(info['rv']):,}칸 · 차급 곡선 {len(index['seg_rv'])}개 "
          f"{len(info['seg']):,}칸 · 이번 주 같은 매물 {info['W']:,}대({' → '.join(info['wd'][-2:])}, 절반 미만·2배 초과 {info['n_bad']}대 뺌)"
          f" · 첫 인하 일수 {info['fcd']}개 모델" + ("" if info["fcd"] else "(price_obs 3회 전이라 없음)"))
    rs = info["rvi_stat"]
    print(f"  잔존가치 지수 기준: 정확한 연차 칸 {rs['x']:,}대 · 앞뒤 1년 묶음 {rs['p']:,}대 · 기준 없음(뺌) {rs['out']:,}대")
    if info["fq"]:
        print(f"  흐름 수집 품질: {info['fq']}")
    print(f"  이상 의심: 판매중 비교 후보 {ls['cand']:,}대 중 추정 {ls['est']:,}대 · 추정의 75% 미만 {ls['any']:,}대 → 신뢰도 A·B {index['flags_total']['low']:,}대"
          f" · 오래 안 팔림 {index['flags_total']['old']:,}대")
    print(f"  잔존가치 지수(판매중 100대 이상 {len(rvi)}개): 10~90% {np.percentile(rvi, 10):.0f}~{np.percentile(rvi, 90):.0f} · "
          f"계산 모델 {sum(m['rvi'] is not None for m in ms)}/{len(index['models'])}")
    if info["miss_seg"]:
        print(f"  ! 상세 매물에 없는 세부모델 {len(info['miss_seg'])}개 — 비교 후보 차급으로 채움: {info['miss_seg'][:5]}")
    print("\n".join(show(index, files)))
    print(f"  시간: 데이터 {T['data'] - T['start']:.0f}초 · 이상 의심 {T['low'] - T['data']:.0f}초 · 쓰기 {T['write'] - T['low']:.0f}초 · "
          f"검사 {T['check'] - T['write']:.0f}초 · 합계 {T['check'] - T['start']:.0f}초")
    print(f"→ {OUT} 파일 {len(sizes)}개(그룹 {len(files)} + index) 합계 {sum(sizes.values()) / 1024 / 1024:.2f}MB · "
          f"index.json {sizes[os.path.join(OUT, 'index.json')] / 1024:.0f}KB · 가장 큰 그룹 {files[os.path.basename(big)]['maker']} "
          f"{files[os.path.basename(big)]['group']} {sizes[big] / 1024:.0f}KB · 그룹 중위 {np.median(list(gs.values())) / 1024:.1f}KB"
          + (f" · 없어진 그룹 파일 {stale}개 지움" if stale else "") + f" · {CSV} ({os.path.getsize(CSV) / 1024:.0f}KB)")
    for w in warn:
        print("  주의:", w)
    if err:
        print(f"출력 계약 검사 실패 {len(err)}건:")
        for e in err[:30]:
            print("  ✗", e)
        sys.exit(1)
    print("출력 계약 검사 통과(그룹 파일 %d개 · 세부모델 %d개)" % (len(files), len(index["models"])))


if __name__ == "__main__":
    main()
