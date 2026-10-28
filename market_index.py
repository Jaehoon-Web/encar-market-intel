# -*- coding: utf-8 -*-
"""
market_index.py — 시황판 지수 (기획안 D4, 5.2.1): 시세·판매속도·재고·시황지수

    python market_index.py      → web/data/market_index.json(지수 + 회차별 흐름) · web/data/market_models.json(차종 비교)
                                  + web/downloads/market_index.csv · market_models.csv(데이터 탭, CP949)
                                  + encar_output/prep/market_index_report.txt
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
수집 범위(D10 이음): 지수와 흐름은 기준기간 조회로 잡히던 매물('7월 범위')로만 센다. 2026-11 크롤러가 더 받는 국산 쉐보레·
  기타 제조사·수입 브랜드(비친환경)·현대·기아 경기 기타 연료는 빼고(차종 비교에는 씀), '전남광주'는 7월에 광주·전남으로 잡히던
  매물이라 넣는다. 7/29~D10 전 목록은 전남광주가 빠졌으므로 재고에 실측 누락 대수를 더하고(JN_ADD) 흐름에는 jn_gap 표시
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
OUT_MODELS = os.path.join(ROOT, "web", "data", "market_models.json")   # 차종 비교(세부모델별 시장 숫자)
DL = os.path.join(ROOT, "web", "downloads")                             # 데이터 탭 내려받기(CSV)
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
TREND_MIN = 10                # 세부모델 시세 추세: 기준기간·회차 모두 신규 매물 10대 이상(차종 비교 pidx와 같은 기준)
TREND_MERGE = 2               # 이틀 안에 잇달아 받은 회차(6/23·6/24)는 세부모델 추세에서 한 점으로
SIG_FLOOR = 0.03              # 점 하나의 흔들림 계산에 쓰는 회차 안 퍼짐(로그)의 하한 — 같은 매매상 일괄 등록 등으로 표본이 덜 독립적인 것을 감안
OBS_FIX = {"2026-10-26": "2026-10-21"}   # 목록은 10/21 수집, 상세 수집이 10/26에 끝나 그날로 기록됨
LOG_DOMESTIC_SHARE = 0.6936              # 2026-07-01 수집 로그(조회별 대수 + 친환경 추가분): 국산 143,473 / 206,868

# 7월 범위 — 기준기간 크롤러 조회식으로 잡히는 매물. 현대·기아는 지역별(경기 비친환경만 연료 3종), 아래 제조사는 전부, 친환경은 전부
JULY_MAKERS = {"제네시스", "KG모빌리티(쌍용)", "르노코리아(삼성)", "벤츠", "BMW", "아우디",
               "볼보", "포르쉐", "렉서스", "도요타", "혼다", "포드", "랜드로버", "미니", "폭스바겐", "재규어",
               "링컨", "캐딜락", "푸조", "마세라티", "페라리", "람보르기니", "벤틀리", "롤스로이스", "시트로엥",
               "닛산", "인피니티", "쉐보레", "알파 로메오", "지프", "닷지", "크라이슬러", "사브"}
JULY_GG_FUELS = {"가솔린", "디젤", "LPG(일반인 구입)"}
GREEN_FUELS = {"하이브리드", "전기", "수소"}            # 상세 표의 친환경: 목록 친환경 조회로 잡혔거나(카테고리 eco) 이 연료
# 전남광주 누락: 7/29 목록부터 엔카가 광주·전남 매물 대부분을 '전남광주'로 표시해, 지역별로 받던 제조사의 비친환경 매물이 빠졌다.
# 목록에 이 매물이 JN_MIN대 미만인 회차(D10 크롤러 전)는 재고에 JN_ADD를 더한다 — 2026-10-28 D10 리허설 목록에서 센
# 전남광주·지역별 제조사·비친환경 매물(구분·차급별). 10/21도 같은 값을 쓴다(한 주 사이 목록 전체 변화 1% 안팎)
JN_START = "2026-07-29"
JN_SPLIT = {"현대", "기아", "제네시스", "KG모빌리티(쌍용)", "벤츠", "BMW"}
JN_MIN = 1000
JN_ADD_DATE = "2026-10-28"
JN_ADD = {("국산", "RV"): 528, ("국산", "SUV"): 2135, ("국산", "경차"): 474, ("국산", "대형"): 1362, ("국산", "소형"): 46,
          ("국산", "스포츠"): 3, ("국산", "승합"): 291, ("국산", "준중형"): 525, ("국산", "중형"): 492, ("국산", "화물"): 234,
          ("수입", "SUV"): 291, ("수입", "대형"): 203, ("수입", "소형"): 34, ("수입", "스포츠"): 39, ("수입", "승합"): 4,
          ("수입", "준중형"): 64, ("수입", "중형"): 275}   # 합계 7,000 (국산 6,090 · 수입 910)


def load():
    L = pd.read_parquet(os.path.join(PREP, "listings.parquet"),
                        columns=["상태", "첫관측일", "마지막관측일", "판매추정일", "엔카등록일", "등록연월", "첫가격", "현재가", "주행km",
                                 "제조사", "모델그룹", "모델", "등급", "세부등급", "차급", "국산", "시도", "카테고리", "연료", "연료_원문", "성능감가율", "색상계열", "번호판유형",
                                 "체류일", "더미가", "인수금의심", "주행의심", "핵심결측"])
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


# ───────── 7월 범위 (D10 수집 범위 확대 이음) ─────────
def july_scope(maker, region, fuel, green):
    """7월 범위 여부(목록·상세 공통) — 기준기간 크롤러 조회식으로 잡히는 매물. 전남광주는 7월의 광주·전남이라 지역 조건 없이 넣는다"""
    hk = maker.isin(["현대", "기아"])
    return (green | maker.isin(JULY_MAKERS) | (hk & ((region != "경기") | fuel.isin(JULY_GG_FUELS)))).values


def scope_of(L):
    green = L["카테고리"].fillna("").str.contains("eco") | L["연료"].isin(GREEN_FUELS)
    return july_scope(L["제조사"], L["시도"], L["연료_원문"], green)


def jn_add(key):
    o, s = key
    return float(sum(n for (o2, s2), n in JN_ADD.items() if o in ("전체", o2) and s in ("전체", s2)))


def jn_gap_dates(LC, dates):
    """전남광주가 빠진 목록 관측일 — JN_START 이후이면서 목록 실측의 전남광주(지역별 제조사·비친환경)가 JN_MIN대 미만이거나 기록 없음"""
    have = LC["전남광주"].astype(float).groupby(LC["관측일"]).sum(min_count=1) if "전남광주" in LC else pd.Series(dtype=float)
    return {o for o in dates if o >= JN_START and not have.get(o, np.nan) >= JN_MIN}


# ───────── 목록 실측 대수 (ids_all.json → list_counts.csv 누적) ─────────
def list_frame(ids, L):
    """목록 매물 → origin·seg(상세 표의 제조사·모델 최빈값) · 7월 범위 · 전남광주 누락 대상(지역별 제조사·비친환경)"""
    mk = L.groupby("제조사")["origin"].agg(lambda s: s.mode().iat[0])
    seg = L.groupby(["제조사", "모델"])["seg"].agg(lambda s: s.mode().iat[0])
    cat = ids["category"].fillna("")
    org = ids["manufacturer"].map(mk)
    org = org.fillna(pd.Series(np.where(cat.str.contains("imported"), "수입", "국산"), index=ids.index))
    sg = pd.Series(pd.MultiIndex.from_arrays([ids["manufacturer"], ids["model"]]).map(seg), index=ids.index).fillna("기타")
    green = ids["green_type"].eq("Y")
    return pd.DataFrame({"origin": org, "seg": sg,
                         "범위내": july_scope(ids["manufacturer"], ids["region"], ids["fuel_type"], green),
                         "전남광주": (ids["region"].eq("전남광주") & ids["manufacturer"].isin(JN_SPLIT) & ~green).values})


def record_list_counts(L):
    cols = ["관측일", "origin", "seg", "대수", "범위내", "전남광주"]     # 범위내·전남광주는 2026-10-28 실행부터(이전 행은 빈칸)
    if not os.path.exists(IDS_ALL):
        return pd.DataFrame(columns=cols)
    obs = datetime.date.fromtimestamp(os.path.getmtime(IDS_ALL)).isoformat()
    with open(IDS_ALL, encoding="utf-8") as f:
        ids = pd.DataFrame(json.load(f))
    now = (list_frame(ids, L).groupby(["origin", "seg"])
           .agg(대수=("범위내", "size"), 범위내=("범위내", "sum"), 전남광주=("전남광주", "sum")).reset_index()
           .assign(관측일=obs)[cols])
    old = pd.read_csv(LIST_COUNTS, encoding="utf-8-sig") if os.path.exists(LIST_COUNTS) else now.iloc[0:0]
    out = pd.concat([old[old["관측일"] != obs], now], ignore_index=True).sort_values(["관측일", "origin", "seg"])
    out[["범위내", "전남광주"]] = out[["범위내", "전남광주"]].astype("Int64")
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
        st = L[(L["첫관측일"] <= p) & (L["마지막관측일"] >= p)][["origin", "seg", "cell", "제조사", "모델", "엔카등록일", "판매추정일", "상태"]].copy()
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
def stock(L, crawls, obs, total, LC, ivs, keys, jn):
    """회차·세그먼트별 (지수, 대수, 구성비 추정 여부, 전남광주 보정 대수). 목록 실측은 7월 범위 대수(없으면 전체),
    전남광주가 빠진 회차(jn)는 JN_ADD를 더한다"""
    gap = {iv["c"]: iv["missing"] / iv["start_all"] for iv in ivs}
    lc_dates = set(LC["관측일"])
    tab = {}
    for c in crawls:
        o = obs[c].strftime("%Y-%m-%d")
        if gap.get(c, 0) > STOCK_GAP_MAX:
            continue
        if o in lc_dates:                                                          # 목록 실측
            d = LC[LC["관측일"] == o]
            d = d.assign(n=d["범위내"].astype(float).fillna(d["대수"]) if "범위내" in d else d["대수"])
            for key in keys:
                fx = jn_add(key) if o in jn else 0.0
                tab[(key, c)] = (float(pick(d, key)["n"].sum()) + fx, False, fx)
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
            tab[(key, c)] = (v, True, 0.0)
    base_dates = [c for c in crawls if BASE[0] <= obs[c].strftime("%Y-%m-%d") <= BASE[1]]
    out = {}
    for key in keys:
        b = [tab[(key, c)][0] for c in base_dates if (key, c) in tab]
        if not b or np.mean(b) <= 0:
            continue
        bm = np.mean(b)
        out[key] = {c: (tab[(key, c)][0] / bm * 100,) + tab[(key, c)] for c in crawls if (key, c) in tab}
    return out


# ───────── 시세 ─────────
def coef_for(C, key, seg_key):
    return C["models"].get(key) or C["segments"].get(seg_key) or C["market"]


def bad_price(L):
    return L[["더미가", "인수금의심", "주행의심", "핵심결측"]].eq(True).any(axis=1)


def price_frame(L, obs, C):
    """시세지수용 신규 매물 표 — 칸(모델·등급·세부등급) 기준값 대비 잔차 dev 포함"""
    d = L[~bad_price(L) & (L["첫가격"] >= 100) & L["성능감가율"].notna() & L["등록연월"].notna() & (L["주행km"] > 0)].copy()
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
    return d


def price(d, crawls, obs, keys):
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


def robust_sig(dev, groups):
    """회차 안 퍼짐 — (dev − 그 회차 가운데 값)의 로버스트 σ(1.4826 × MAD). 점 하나의 흔들림 = 1.2533 × σ ÷ √n"""
    r = dev - dev.groupby(groups).transform("median")
    return max(SIG_FLOOR, 1.4826 * float(np.median(np.abs(r - np.median(r))))) if len(r) else None


def price_sig(d, keys):
    """세그먼트 시세지수의 회차 안 퍼짐 — 시세 산정 '시세 추세'의 차급 비교선 방향 판정용"""
    out = {}
    for key in keys:
        g = pick(d, key)
        s = robust_sig(g["dev"], g["첫관측일"])
        if s is not None:
            out[f"{key[0]}|{key[1]}"] = round(s, 4)
    return out


def model_trend(d):
    """세부모델 회차별 시세지수(기준기간 = 100) — 시세 산정 '시세 추세'(기획 5.1.3-2 D).
    회차 신규 매물의 잔차(dev) 가운데 값을 기준기간 전체 가운데 값과 비교(차종 비교 pidx와 같은 식). 기준기간·회차 모두 TREND_MIN대 이상인 점만.
    → (날짜 목록, {제조사|모델: {ps: [[날짜 번호, 지수, 신규 대수], …], sig: 회차 안 퍼짐}})"""
    days, per, start = sorted(d["obs"].unique()), {}, None
    for o in days:                                                                 # 이틀 안에 잇단 회차는 앞 회차 날짜로 묶는다
        if start is None or (pd.Timestamp(o) - pd.Timestamp(start)).days > TREND_MERGE:
            start = o
        per[o] = start
    d = d.assign(key=d["제조사"] + "|" + d["모델"], per=d["obs"].map(per))
    base = d[d["obs"].between(*BASE)].groupby("key")["dev"].agg(["median", "size"])
    base = base.loc[base["size"] >= TREND_MIN, "median"]
    d = d[d["key"].isin(base.index)]
    g = d.groupby(["key", "per"])["dev"].agg(["median", "size"])
    g = g[g["size"] >= TREND_MIN]
    dates = sorted(set(per.values()))
    di = {o: i for i, o in enumerate(dates)}
    out = {}
    for k, s in g.groupby(level=0):
        if len(s) < 2:
            continue
        sub = d[d["key"] == k]
        out[k] = {"ps": [[di[o], round(float(np.exp(m - base[k]) * 100), 1), int(n)] for (_, o), m, n in zip(s.index, s["median"], s["size"])],
                  "sig": round(robust_sig(sub["dev"], sub["per"]), 4)}
    return dates, out


# ───────── 흐름 (핵심 숫자·트렌드, 기획안 5.2.2·5.2.3) ─────────
def flows(L, crawls, obs, ivs, keys):
    """회차별 판매중 확인 재고 · 구간 신규 유입(직전 목록 관측일 뒤 엔카 등록) · 구간 판매(재등록 제외) · 신규 매물 중앙 호가.
    모두 상세 확인 매물 기준(재고 정의 통일). 첫 회차는 유입·판매 없음. 주간 값 = 구간 값 × 7 ÷ 간격일"""
    ok = ~bad_price(L) & (L["첫가격"] >= 100)
    miss = {iv["c"]: iv["missing"] for iv in ivs if iv["bad"]}
    out = {}
    for i, c in enumerate(crawls):
        on = L[(L["첫관측일"] <= c) & (L["마지막관측일"] >= c)]
        new = sold = None
        if i:
            p = crawls[i - 1]
            new = L[(L["첫관측일"] == c) & (L["엔카등록일"] > obs[p])]
            sold = L[(L["판매추정일"] == c) & (L["상태"] != "재등록")]
            days = (obs[c] - obs[p]).days
        for key in keys:
            e = {"on": int(len(pick(on, key)))}
            if new is not None and days > 0:
                n, s = pick(new, key), pick(sold, key)
                e.update({"days": days, "new": int(len(n)), "sold": int(len(s)),
                          "new_w": round(len(n) * 7 / days), "sold_w": round(len(s) * 7 / days)})
                pr = n.loc[ok.loc[n.index], "첫가격"]
                if len(pr) >= 30:
                    e["new_med"] = int(round(pr.median()))
                if c in miss:
                    e["sold_suspect"] = True                                             # 목록 누락으로 판매가 부풀었을 수 있음
            out.setdefault(key, {})[c] = e
    return out


# ───────── 차종 비교 (기획안 5.2.4) ─────────
def model_stats(L, crawls, obs, ivs, d):
    """세부모델별: 판매중 확인 · 중앙 호가 · 가격 인하 비율 · 최근 90일 판매의 중위 체류일 · 최근 구간 주간 판매율과 재고 소진 주수
    (마지막 회차가 판매속도 구간일 때만) · 시세(신규 매물, 기준기간 = 100, 양쪽 10대 이상)"""
    c, oc = crawls[-1], obs[crawls[-1]]
    on = L[(L["첫관측일"] <= c) & (L["마지막관측일"] >= c)].copy()
    on["ok"] = ~bad_price(on) & (on["현재가"] >= 100)
    on["cut"] = on["현재가"] < on["첫가격"]
    sold = L[(L["판매추정일"] > c - pd.Timedelta(days=90)) & (L["판매추정일"] <= c) & (L["상태"] != "재등록")]
    dwell = sold.groupby(["제조사", "모델"])["체류일"].median()
    n_sold90 = sold.groupby(["제조사", "모델"]).size()
    iv = ivs[-1] if ivs and ivs[-1]["c"] == c else None
    rate = None
    if iv is not None:
        g = iv["st"].groupby(["제조사", "모델"])["sold"].agg(["size", "sum"])
        g = g[g["size"] >= 10]
        rate = (1 - (1 - g["sum"] / g["size"]) ** (7 / iv["days"])).rename("rate")
    d = d.assign(key=d["제조사"] + "|" + d["모델"])
    base = d[d["obs"].between(*BASE)].groupby("key")["dev"].agg(["median", "size"])
    now = d[d["첫관측일"] == c].groupby("key")["dev"].agg(["median", "size"])
    both = base.join(now, lsuffix="_b", rsuffix="_n", how="inner")
    both = both[(both["size_b"] >= 10) & (both["size_n"] >= 10)]
    pidx = np.exp(both["median_n"] - both["median_b"]) * 100
    grp = L.groupby(["제조사", "모델"])["모델그룹"].agg(lambda s: s.mode().iat[0] if s.notna().any() else "")
    rows = []
    for (mk, m), g in on.groupby(["제조사", "모델"]):
        k = f"{mk}|{m}"
        okp = g.loc[g["ok"], "현재가"]
        r = {"maker": mk, "group": grp.get((mk, m), ""), "model": m, "seg": g["seg"].mode().iat[0], "origin": g["origin"].mode().iat[0],
             "on": int(len(g)), "price": int(round(okp.median())) if len(okp) else None,
             "cut": round(float(g["cut"].mean()), 3), "sold90": int(n_sold90.get((mk, m), 0))}
        if (mk, m) in dwell.index and n_sold90.get((mk, m), 0) >= 5:
            r["dwell"] = int(round(dwell[(mk, m)]))
        if rate is not None and (mk, m) in rate.index:
            r["rate_w"] = round(float(rate[(mk, m)]), 4)
            if r["rate_w"] > 0:
                r["weeks"] = round(1 / r["rate_w"], 1)
        if k in pidx.index:
            r["pidx"] = round(float(pidx[k]), 1)
        rows.append(r)
    rows.sort(key=lambda x: -x["on"])
    segs = {}                                                                     # 차급 평균(시세 산정 '판매 속도'의 비교 기준) — 모델과 같은 정의
    if iv is not None:
        g = iv["st"].groupby(["seg", "origin"])["sold"].agg(["size", "sum"])
        for (s, o), r in g[g["size"] >= 30].iterrows():
            rw = 1 - (1 - r["sum"] / r["size"]) ** (7 / iv["days"])
            segs[f"{s}·{o}"] = {"rate_w": round(float(rw), 4), "weeks": round(1 / rw, 1) if rw > 0 else None, "n_start": int(r["size"])}
    sd = sold.groupby(["seg", "origin"])["체류일"].agg(["median", "size"])
    for (s, o), r in sd[sd["size"] >= 5].iterrows():
        segs.setdefault(f"{s}·{o}", {})["dwell"] = int(round(r["median"]))
    info = {"date": oc.strftime("%Y-%m-%d"), "models": len(rows), "segments": segs,
            "speed_interval": [obs[iv["p"]].strftime("%Y-%m-%d"), oc.strftime("%Y-%m-%d")] if iv is not None else None}
    return rows, info


# ───────── 합치기 ─────────
def build(L, crawls, obs, total, C):
    LC = record_list_counts(L)
    segs = sorted(s for s in L["seg"].unique() if s != "기타")
    keys = keys_of(segs)
    Lu = L[scope_of(L)]                                                             # 지수·흐름은 7월 범위, 차종 비교는 전체
    days = [obs[c].strftime("%Y-%m-%d") for c in crawls]
    jn = jn_gap_dates(LC, days)
    ivs = intervals(L, crawls, obs)
    ivu = intervals(Lu, crawls, obs) if len(Lu) < len(L) else ivs
    PF = price_frame(L, obs, C)
    PFu = PF[PF.index.isin(Lu.index)]
    SP, ST, PR = speed(ivu, keys), stock(Lu, crawls, obs, total, LC, ivu, keys, jn), price(PFu, crawls, obs, keys)
    FL = flows(Lu, crawls, obs, ivu, keys)
    series = {}
    for key in keys:
        pts = []
        for i, c in enumerate(crawls):
            e = {"date": days[i]}
            if c in PR.get(key, {}):
                v, n = PR[key][c]
                e["시세"], e["n_price"] = round(float(v), 1), n
            if c in SP.get(key, {}) and SP[key][c][0] == SP[key][c][0]:
                v, n0, n1 = SP[key][c]
                e["판매속도"], e["n_start"], e["n_sold"] = round(float(v), 1), n0, n1
            if c in ST.get(key, {}):
                v, n, est, fx = ST[key][c]
                e["재고"], e["n_stock"] = round(float(v), 1), int(round(n))
                if est: e["stock_est"] = True
                if fx: e["stock_fix"] = int(round(fx))                                  # 전남광주 누락분을 더한 대수
            if all(k in e for k in ["시세", "판매속도", "재고"]) and e["재고"] > 0:
                e["시황"] = round(float(np.exp(np.mean(np.log([e["시세"], e["판매속도"], 10000 / e["재고"]])))), 1)
                e["label"] = "강세" if e["시황"] >= 102 else ("약세" if e["시황"] <= 98 else "보합")
            ns = [e[k] for k in ["n_price", "n_start", "n_stock"] if k in e]
            e["low_sample"] = bool(ns) and min(ns) < MIN_N
            e.update(FL.get(key, {}).get(c, {}))
            if days[i] in jn and "on" in e:
                e["jn_gap"] = True                                                      # 전남광주가 빠진 목록 → 판매중·유입 낮음
            if i and days[i - 1] in jn and "sold" in e:
                e["jn_gap_sold"] = True                                                 # 시작 목록에 전남광주가 빠짐 → 판매 낮음
            if len(e) > 2: pts.append(e)
        if pts:
            series[f"{key[0]}|{key[1]}"] = pts
    gap = {iv["c"]: iv for iv in ivu}
    out_n = (LC["대수"] - LC["범위내"].astype(float)).groupby(LC["관측일"]).sum(min_count=1) if "범위내" in LC else pd.Series(dtype=float)
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
        fx = ST.get(("전체", "전체"), {}).get(c, (0, 0, 0, 0))[3]
        if days[i] in jn:
            notes.append("전남광주 누락 — " + (f"재고에 {JN_ADD_DATE[5:].replace('-', '/')} 실측 {fx:,.0f}대를 더함, " if fx else "")
                         + "판매중 재고·신규 유입은 그만큼 낮게 잡힘")
        elif i and days[i - 1] in jn:
            notes.append("전남광주 다시 수집 — 직전 회차와 판매중 재고·신규 유입 비교 주의, 판매는 시작 목록에 전남광주가 빠져 낮게 잡힘")
        if out_n.get(days[i], 0) > 0:
            notes.append(f"7월 범위 밖 {out_n[days[i]]:,.0f}대(국산 쉐보레 등)는 지수·흐름에서 뺌")
        if c.strftime("%Y-%m-%d") != days[i]:
            notes.append(f"파이프라인 기록일 {c:%m/%d}")
        on_all = int(((L["첫관측일"] <= c) & (L["마지막관측일"] >= c)).sum())
        log.append({"date": days[i], "crawl": c.strftime("%Y-%m-%d"), "gap_days": g, "note": " · ".join(notes),
                    "list": int(total[c]), "detail": on_all})                            # 목록 매물 · 상세 확인 판매중(데이터 탭 수집 현황, 전체 범위)
    MS = model_stats(L, crawls, obs, ivs, PF)
    tdates, MT = model_trend(PF)                                                   # 세부모델 추세는 차종 비교처럼 전체 범위(기준기간이 없으면 안 생김)
    for r in MS[0]:
        r.update(MT.get(f"{r['maker']}|{r['model']}", {}))
    MS[1]["trend_dates"] = tdates
    return series, log, LC, MS, price_sig(PFu, keys)


def write_csvs(series, models):
    """데이터 탭 내려받기(기획안 5.3): 시황판(회차별 지수·흐름)과 차종 비교. 엑셀에서 바로 열리게 CP949 — build_data.py 다운로드와 같은 방식"""
    rows = []
    for key, pts in series.items():
        o, s = key.split("|")
        for e in pts:
            rows.append({"구분": o, "차급": s, "목록관측일": e["date"], "시세지수": e.get("시세"), "판매속도지수": e.get("판매속도"),
                         "재고지수": e.get("재고"), "시황지수": e.get("시황"), "시황": e.get("label"), "신규비교대수": e.get("n_price"),
                         "판매속도_시작재고": e.get("n_start"), "판매속도_판매": e.get("n_sold"), "목록재고": e.get("n_stock"),
                         "재고_구성비추정": "예" if e.get("stock_est") else None, "재고_전남광주보정대수": e.get("stock_fix"),
                         "표본적음": "예" if e.get("low_sample") else None,
                         "판매중재고_상세확인": e.get("on"), "구간일": e.get("days"), "신규유입": e.get("new"), "판매": e.get("sold"),
                         "신규유입_주": e.get("new_w"), "판매_주": e.get("sold_w"), "신규매물_중앙호가_만원": e.get("new_med"),
                         "판매_누락의심": "예" if e.get("sold_suspect") else None,
                         "전남광주누락_판매중유입": "예" if e.get("jn_gap") else None, "전남광주누락_판매": "예" if e.get("jn_gap_sold") else None})
    pd.DataFrame(rows).to_csv(os.path.join(DL, "market_index.csv"), index=False, encoding="cp949", errors="replace")
    cols = ["maker", "group", "model", "seg", "origin", "on", "price", "cut", "sold90", "dwell", "rate_w", "weeks", "pidx"]   # 판매속도 구간이 없는 주에도 열은 그대로
    m = pd.DataFrame(models, columns=cols).rename(columns={"maker": "제조사", "group": "모델", "model": "세부모델", "seg": "차급", "origin": "국산수입",
                                             "on": "판매중", "price": "중앙호가_만원", "cut": "인하매물비율", "sold90": "최근90일판매",
                                             "dwell": "중위체류일", "rate_w": "주간판매율", "weeks": "재고소진주수", "pidx": "시세_기준기간100"})
    m.to_csv(os.path.join(DL, "market_models.csv"), index=False, encoding="cp949", errors="replace")


def report(series, log, LC, L, crawls, obs):
    lines = [f"시황 지수(D4) — {datetime.datetime.now():%Y-%m-%d %H:%M} · 기준기간 {BASE[0]}~{BASE[1]} = 100 · 날짜는 목록 관측일", ""]
    for x in log:
        lines.append(f"  {x['date']}" + (f" (+{x['gap_days']}일)" if x["gap_days"] else "") + (f"  {x['note']}" if x["note"] else ""))
    for key in ["전체|전체", "국산|전체", "수입|전체"]:
        lines += ["", f"[{key.split('|')[0]}] 날짜 · 시세 · 판매속도 · 재고 · 시황 (신규 비교 / 시작 재고 / 재고)"]
        for e in series.get(key, []):
            lines.append(f"  {e['date']}  {e.get('시세', '—'):>6}  {e.get('판매속도', '—'):>6}  {e.get('재고', '—'):>6}{'*' if e.get('stock_est') else '+' if e.get('stock_fix') else ' '}"
                         f"  {e.get('시황', '—'):>6} {e.get('label', '  '):<2}  ({e.get('n_price', 0):,} / {e.get('n_start', 0):,} / {e.get('n_stock', 0):,})")
    last = obs[crawls[-1]].strftime("%Y-%m-%d")
    lines += ["", "  * 재고: 목록 실측이 없는 회차는 로그 국산 비율 × 상세 차급 구성으로 추정",
              f"  + 재고: 전남광주가 빠진 회차에 {JN_ADD_DATE} 실측 누락 대수를 더함(JN_ADD)", "", f"[{last} 차급별 — 전체 기준]"]
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
    series, log, LC, (models, minfo), psig = build(L, crawls, obs, total, C)
    out = {"version": datetime.date.today().isoformat(), "base_period": list(BASE),
           "note": "엔카 매물로 계산한 시황 지수(기획안 5.2.1). 기준기간 = 100. 날짜는 목록 관측일. 매주 전체를 다시 계산한다",
           "definitions": {
               "시세": "신규 매물(등록 7일 이내) 첫 호가를 기준기간의 같은 모델·등급·세부등급 신규 매물과 비교. 성능감가율·D3 계수(차령·주행·색상·렌트)로 조건을 맞춘 뒤 차이의 중앙값",
               "판매속도": "구간 판매 ÷ 시작 재고(7일 환산). 등록 후 경과일 구간별 판매율을 기준기간 재고 구성으로 가중. 간격 5~16일 구간만, 재등록 제외, 목록 누락 칸 제외",
               "재고": "목록 매물 수(중복 제거, 7월 범위) ÷ 기준기간 평균. 세그먼트는 목록 구성비로 나눔(stock_est = 구성비 추정). "
                      "7/29~D10 전 목록은 전남광주가 빠져 실측 누락 대수를 더함(stock_fix = 더한 대수)",
               "범위": "지수와 흐름은 기준기간 크롤러 조회로 잡히던 매물(7월 범위)로만 센다. 2026-11 크롤러가 더 받는 국산 쉐보레·기타 제조사·"
                      "수입 브랜드(비친환경)·현대·기아 경기 기타 연료는 빼고(차종 비교에는 씀), 전남광주는 7월의 광주·전남이라 넣는다",
               "시황": "시세·판매속도·(10000÷재고)의 기하평균. 102 이상 강세, 98 이하 약세, 그 사이 보합",
               "흐름": "on = 판매중 확인 매물(상세 확인) · new = 직전 목록 관측일 뒤 엔카에 등록된 매물 · sold = 구간 판매(재등록 제외) · "
                      "_w = 7일 환산 · new_med = 신규 매물 첫 호가 중앙값(30대 이상) · sold_suspect = 목록 누락으로 판매가 부풀었을 수 있음 · "
                      "jn_gap = 전남광주가 빠진 목록(판매중·유입 낮음) · jn_gap_sold = 시작 목록에 전남광주가 빠짐(판매 낮음)",
               "price_sig": "세그먼트별 시세 회차 안 퍼짐(로그, 로버스트 σ). 회차 점의 흔들림 ≈ 지수 × 1.2533 × σ ÷ √n_price — 시세 산정 '시세 추세'의 방향 판정에 씀"},
           "crawls": log, "series": series, "price_sig": psig}
    with open(OUT_JSON, "w", encoding="utf-8", newline="\n") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
        f.write("\n")
    mout = {"version": out["version"], "date": minfo["date"], "speed_interval": minfo["speed_interval"],
            "note": "세부모델별 시장 숫자(기획안 5.2.4). on = 판매중 확인 · price = 중앙 호가 · cut = 첫 호가보다 내린 매물 비율 · "
                    "sold90·dwell = 최근 90일 판매 대수·중위 체류일(5대 이상) · rate_w = 최근 판매속도 구간의 주간 판매율(시작 10대 이상) · "
                    "weeks = 재고 소진 주수(1 ÷ 주간 판매율) · pidx = 신규 매물 시세(기준기간 = 100, 양쪽 10대 이상) · "
                    "segments = 차급·국산수입별 같은 정의의 rate_w·weeks(시작 30대 이상)·dwell · "
                    "ps = 세부모델 회차별 시세지수 [trend_dates 번호, 지수, 신규 대수](기준기간·회차 모두 10대 이상, 이틀 안 회차는 한 점) · "
                    "sig = 회차 안 퍼짐(로그, 로버스트 σ, 하한 0.03) — 점의 흔들림 ≈ 지수 × 1.2533 × sig ÷ √신규 대수",
            "trend_dates": minfo["trend_dates"], "segments": minfo["segments"], "models": models}
    with open(OUT_MODELS, "w", encoding="utf-8", newline="\n") as f:
        json.dump(mout, f, ensure_ascii=False, separators=(",", ":"))
        f.write("\n")
    write_csvs(series, models)
    print(report(series, log, LC, L, crawls, obs))
    print(f"→ {OUT_JSON} ({os.path.getsize(OUT_JSON) / 1024:.0f}KB) · {OUT_MODELS} 모델 {len(models):,}개 "
          f"({os.path.getsize(OUT_MODELS) / 1024:.0f}KB, 판매속도 구간 {minfo['speed_interval'] or '없음'}) · {(datetime.datetime.now() - t0).seconds}초")


if __name__ == "__main__":
    main()
