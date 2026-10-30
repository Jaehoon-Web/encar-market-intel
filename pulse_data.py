# -*- coding: utf-8 -*-
"""
pulse_data.py — 마켓 펄스 (기획안 5.5.1): 이번 주 시장 숫자 · 같은 매물 가격 변화 · 주목할 모델 · 요약 문장

    python pulse_data.py      → web/data/pulse.json (market_index.py 다음에 돈다 — auto_update 2.91)

입력: web/data/market_index.json(회차·세그먼트별 흐름과 지수) · web/data/market_models.json(세부모델 판매율·시세 추세)
      · encar_output/prep/price_obs.parquet(주간 목록 가격) · listings.parquet(상태·구분·차급·가격 플래그)
비교는 지난주 대비. 이번 목록(date)과 직전 목록(prev)의 간격이 5~16일이면 weekly — 이번 주 흐름(신규·판매·판매율)과
  같은 매물 가격 변화를 내고, 판매중·지수의 지난주 값을 붙인다. 그 앞 간격도 5~16일이면 prev_weekly — 흐름과
  같은 매물 가격 변화의 지난주 값(*_prev)도 붙인다
  · 판매율: series 점의 판매 ÷ 시작 재고를 1주 기준으로 = 1 − (1 − n_sold ÷ n_start)^(7 ÷ 간격일), 재고 소진 주수 = 1 ÷ 판매율
  · 같은 매물 가격 변화(px): 두 목록에 모두 있고 상세까지 확인한 매물의 목록 가격 변화 — 상세 없는 '목록 잔존'은 뺀다(이번 주 쌍에서는
    상태 '판매중'과 같고, 지난주 쌍에서는 그사이 팔린 매물도 남는다). 가격 플래그(더미가·인수금의심·가격이상·핵심결측·중복)·제조사 없는
    매물은 빼고, 한 주 가격이 이번 ÷ 지난 < 0.5 또는 > 2.0 인 관측(호가 오타·자리값, 가격 0 포함)도 뺀다(뺀 대수 n_bad).
    모델 리포트(model_report.py) cut.w 와 같은 규칙. 지난주 값(px_prev)은 두 구간 길이 차이가 2일 이하일 때만(구간 길이로 맞추지 않는 값)
  · 주목할 모델: 판매중 100대 이상 세부모델 — 빨리 팔리는(판매율이 차급의 1.15배 이상) · 쌓이는(0.87배 이하, 소진 주수 큰 순)
    · 가격 내리는·오르는(1주 시세 변화가 흔들림 기준 |d| ≥ max(0.5, 2·se)를 넘는 것 — 시세 산정 '시세 추세'와 같은 기준)
  · 요약: 시장·속도·가격 한 줄씩, 기준을 넘는 것만. 속도·가격 줄에는 모델 이름도(판매중 100대 이상, 가격은 같은 매물 50대 이상).
    순위는 '표본이 충분한 차급·모델 가운데'라고 밝히고, 간격이 7일이 아니면 기간을 밝힌다. 지난주 값이 없으면 '이번 주' 사실 문장
전남광주 누락(jn_gap) 여부가 지난주와 다른 주는 판매중·신규(판매는 jn_gap_sold)의 지난주 값을 비우고 notes 에 적는다. notes 에는
  지표마다 지난주 대비가 언제부터 나오는지도 적는다(앞으로 두 회차를 7일 간격으로 보고, 전남광주 누락은 JN_BACK 회차에 끝난다고 봄)
"""
import os, sys, json, re, datetime
import numpy as np
import pandas as pd

ROOT = os.path.dirname(os.path.abspath(__file__))
PREP = os.path.join(ROOT, "encar_output", "prep")
DATA = os.path.join(ROOT, "web", "data")
MI_JSON = os.path.join(DATA, "market_index.json")
MM_JSON = os.path.join(DATA, "market_models.json")
OUT_JSON = os.path.join(DATA, "pulse.json")

WEEK_DAYS = (5, 16)                  # 주간 비교가 되는 목록 간격(일) — market_index.py SPEED_DAYS 와 같음
NO_DETAIL = "목록 잔존(판매 추정)"     # 상세 페이지가 없는 목록 매물 — 같은 매물 가격 변화에서 뺀다
PX_FLAGS = ["더미가", "인수금의심", "가격이상", "핵심결측", "중복"]   # 가격 통계에서 빼는 매물 — model_report.py FLAGS 와 같음
PX_RATIO = (0.5, 2.0)                # 한 주 가격 이번 ÷ 지난이 이 밖이면 호가 오타·자리값으로 보고 뺀다(n_bad)
PX_GAP_DIFF = 2                      # 같은 매물 가격 변화의 지난주 값: 이번·지난 구간 길이 차이가 2일 이하일 때만
MOVER_ON, MOVER_N = 100, 5           # 주목할 모델: 판매중 100대 이상, 구분마다 5개
FAST, SLOW = 1.15, 0.87              # 빨리 팔리는 · 쌓이는: 모델 판매율 ÷ 차급 판매율
TREND_MIN_D, TREND_K = 0.5, 2.0      # 시세 오름·내림: |d| ≥ max(0.5, 2·se)
SE_MED = 1.2533                      # 가운데 값의 흔들림 계수 — 점 하나의 se = 지수 × 1.2533 × σ ÷ √n
MIN_N = 300                          # 요약에서 차급을 들 표본(시작 재고·같은 매물) — market_index.py MIN_N 과 같음
MODEL_PX_N = 50                      # 요약 가격 줄의 모델: 같은 매물 50대 이상
SUM_ON_PCT, SUM_FLOW_PCT = 1.0, 5.0  # 요약 기준: 판매중 재고 ±1% · 신규·판매 대수 ±5%
SUM_RATE_PP = (1.0, 2.0)             # 판매율 지난주 대비(%p) — 전체 · 차급 (흔들림 2배도 넘어야)
SUM_SEG_PP = 2.0                     # 차급·모델을 가장 빠른·느린·인하 많은 곳으로 들 때 견줄 곳과의 차이(%p, 흔들림 2배도 넘어야)
SUM_CUT_PP = 2.0                     # 같은 매물 인하 비율 지난주 대비(%p, 흔들림 2배도 넘어야)
JN_BACK = "2026-11-04"               # 전남광주를 다시 받는 수집 첫 회차(D10 크롤러, 예정) — notes 의 앞으로 안내에만 쓴다(지난 회차는 jn_gap)
IDX_KEYS = ["시세", "판매속도", "재고", "시황", "label"]
PX_KEYS = ["n", "n_bad", "chg_med", "chg_avg", "chg_wtd", "cut", "up", "cut_med_pct", "cut_med_amt"]   # 명세 2.1 + n_bad·chg_avg
ORIGINS = ["전체", "국산", "수입"]
IND = [("판매중", "on_prev"), ("신규 유입", "new_w_prev"), ("판매", "sold_w_prev"), ("판매율", "rate_w_prev"), ("같은 매물 가격 변화", "px_prev")]


# ───────── 도움 함수 ─────────
def rnd(x, k):
    """반올림(None·NaN → None, −0.0 → 0.0)"""
    return None if x is None or x != x else round(float(x), k) + 0.0


def is_week(days):
    return days is not None and WEEK_DAYS[0] <= days <= WEEK_DAYS[1]


def day(d, add=0):
    return datetime.date.fromisoformat(d) + datetime.timedelta(days=add)


def gap(a, b):
    return (day(b) - day(a)).days if a and b else None


def md(d):
    """'2026-11-04' → '11/4'"""
    return f"{int(d[5:7])}/{int(d[8:10])}"


def point(pts, date):
    return next((e for e in pts if e["date"] == date), None) if date else None


def josa(word, a, b):
    """받침 있으면 a(이·은·이라), 없으면 b(가·는·라) — 괄호 앞 낱말 기준, 영문·숫자는 읽는 소리로(K3 → 삼, L → 엘)"""
    w = re.sub(r"\s*\([^)]*\)\s*$", "", word).strip() or word
    c = w[-1]
    if "가" <= c <= "힣":
        has = (ord(c) - 0xAC00) % 28 != 0
    else:
        has = c.upper() in "LMNR0136780"
    return word + (a if has else b)


def pct(r, k=1):
    """비율 → '13.0%'"""
    return f"{r * 100:.{k}f}%"


def signed(v, k=1):
    return ("−" if v < 0 else "+" if v > 0 else "") + f"{abs(v):,.{k}f}"


def last_word(days, prev):
    """지난 값을 이르는 말 — 7일 간격이면 '지난주', 아니면 '지난 목록(10/21)'"""
    return "지난주" if days == 7 else f"지난 목록({md(prev)})"


# ───────── 같은 매물 가격 변화 (price_obs) ─────────
def listing_info():
    """매물ID → origin(국산·수입) · seg(차급) · key(제조사|모델) · ok(같은 매물 가격 변화에 쓰는 매물) · on(상태 판매중).
    ok = 상세가 있는 매물(목록 잔존 제외) · 가격 플래그 없음 · 제조사 있음. 국산 결측은 제조사 최빈값(market_index.py load()와 같은 방식)"""
    L = pd.read_parquet(os.path.join(PREP, "listings.parquet"), columns=["상태", "제조사", "모델", "차급", "국산"] + PX_FLAGS)
    mk = L.groupby("제조사")["국산"].agg(lambda s: s.mode().iat[0] if s.notna().any() else np.nan)
    dom = L["국산"].where(L["국산"].notna(), L["제조사"].map(mk))
    ok = L["상태"].ne(NO_DETAIL) & ~L[PX_FLAGS].eq(True).any(axis=1) & L["제조사"].notna()
    return pd.DataFrame({"origin": np.where(dom.eq(False), "수입", "국산"), "seg": L["차급"].fillna("기타").values,
                         "key": (L["제조사"].fillna("") + "|" + L["모델"].fillna("")).values,
                         "ok": ok.values, "on": L["상태"].eq("판매중").values}, index=L.index)


def price_obs(dates):
    """목록 관측일별 매물 가격(매물ID → 만원) — 필요한 날짜만 읽는다"""
    P = pd.read_parquet(os.path.join(PREP, "price_obs.parquet"), columns=["매물ID", "관측일", "가격"],
                        filters=[("관측일", "in", sorted(set(dates)))])
    return {d: g.drop_duplicates("매물ID").set_index("매물ID")["가격"] for d, g in P.groupby("관측일")}


def same_listing(po, a, b, info):
    """두 목록(a → b)에 모두 있는 매물(info.ok)의 가격 p0·p1 + origin·seg·key·on. odd = 한 주 변화가 PX_RATIO 밖(가격 0·없음 포함).
    관측이 없으면 None"""
    if a not in po or b not in po:
        return None
    S = pd.concat([po[a].rename("p0"), po[b].rename("p1")], axis=1, join="inner").join(info, how="inner")
    S = S[S["ok"].values].copy()
    S["odd"] = ~(S["p1"] / S["p0"].where(S["p0"] > 0)).between(*PX_RATIO)
    return S


def pick(S, key):
    o, s = key.split("|")
    m = np.ones(len(S), bool)
    if o != "전체": m &= (S["origin"] == o).values
    if s != "전체": m &= (S["seg"] == s).values
    return S[m]


def px_stats(S):
    """같은 매물 가격 변화(odd 관측 뺌) — chg_med·chg_avg = 매물별 변화율의 가운데 값·평균(%), chg_wtd = Σ이번 ÷ Σ지난 − 1(%),
    cut·up = 내린·올린 매물 비율(0~1), cut_med_pct·cut_med_amt = 내린 매물의 가운데 인하율(%, 음수)·인하액(만원, 양수), n_bad = 뺀 관측 수"""
    if S is None or not len(S):
        return None
    T = S[~S["odd"].values]
    if not len(T):
        return None
    r = T["p1"] / T["p0"] - 1
    cut = (T["p1"] < T["p0"]).values
    out = {"n": int(len(T)), "n_bad": int(S["odd"].sum()), "chg_med": rnd(r.median() * 100, 1), "chg_avg": rnd(r.mean() * 100, 1),
           "chg_wtd": rnd((T["p1"].sum() / T["p0"].sum() - 1) * 100, 1),
           "cut": rnd(cut.mean(), 4), "up": rnd((T["p1"] > T["p0"]).mean(), 4), "cut_med_pct": None, "cut_med_amt": None}
    if cut.any():
        out["cut_med_pct"] = rnd(r[cut].median() * 100, 1)
        out["cut_med_amt"] = int(round(float((T["p0"] - T["p1"])[cut].median())))
    return out


# ───────── 세그먼트별 이번 주 숫자 (market_index series) ─────────
def week_rate(e):
    """series 점 → 주간 판매율(판매속도가 없으면 None)"""
    if not e or e.get("판매속도") is None or not e.get("n_start") or not e.get("days"):
        return None
    return 1 - (1 - e["n_sold"] / e["n_start"]) ** (7 / e["days"])


def weeks_of(r):
    return round(1 / r, 1) if r else None


def group(pts, date, prev, wk, pwk, px, px_prev):
    """세그먼트 하나 — 이번 주 흐름·같은 매물은 weekly 일 때만, 판매중·지수의 지난주 값도 weekly 일 때만,
    흐름의 지난주 값은 prev_weekly 일 때만. 전남광주 누락 여부가 지난주와 다르면 판매중·신규(판매는 jn_gap_sold)의 지난주 값을 비운다.
    같은 매물의 지난주 값은 이번 주 값이 있을 때만"""
    e = point(pts, date)
    p = point(pts, prev) if wk else None
    q = p if pwk else None
    same_on = p is not None and bool(e.get("jn_gap")) == bool(p.get("jn_gap"))
    same_sold = (q is not None and bool(e.get("jn_gap_sold")) == bool(q.get("jn_gap_sold"))
                 and not e.get("sold_suspect") and not q.get("sold_suspect"))
    r, rp = (week_rate(e) if wk else None), week_rate(q)
    px = px if wk else None
    return {"on": int(e["on"]), "on_prev": int(p["on"]) if same_on else None,
            "new_w": e.get("new_w") if wk else None, "new_w_prev": q.get("new_w") if q is not None and same_on else None,
            "sold_w": e.get("sold_w") if wk else None, "sold_w_prev": q.get("sold_w") if same_sold else None,
            "rate_w": rnd(r, 4), "rate_w_prev": rnd(rp, 4), "weeks": weeks_of(r), "weeks_prev": weeks_of(rp),
            "idx": {k: e.get(k) for k in IDX_KEYS}, "idx_prev": {k: p.get(k) for k in IDX_KEYS} if p is not None else None,
            "px": px, "px_prev": px_prev if px is not None else None, "low_sample": bool(e.get("low_sample"))}


# ───────── 주목할 모델 (market_models) ─────────
def week_trend(m, td, prev, date):
    """세부모델 1주 시세 변화 — ps 마지막 두 점이 (prev, date)이고 |d| ≥ max(0.5, 2·se)일 때만.
    se = √(se0² + se1²), se_i = 지수 × 1.2533 × sig ÷ √신규 대수 (시세 산정 '시세 추세'와 같은 식)"""
    ps, sig = m.get("ps") or [], m.get("sig")
    if len(ps) < 2 or not sig or td[ps[-2][0]] != prev or td[ps[-1][0]] != date:
        return None
    (_, p0, n0), (_, p1, n1) = ps[-2], ps[-1]
    se = float(np.hypot(p0 * SE_MED * sig / np.sqrt(n0), p1 * SE_MED * sig / np.sqrt(n1)))
    d = round(p1 - p0, 1)
    if d == 0 or abs(d) < max(TREND_MIN_D, TREND_K * se) - 1e-9:
        return None
    return {"p0": p0, "p1": p1, "d": d, "se": round(se, 2)}


def movers(mm, prev, date, wk):
    """구분(전체·국산·수입)별 주목할 모델 각 5개 — 판매중 100대 이상 세부모델. market_models 날짜가 이번 목록과 같을 때만,
    판매율은 판매속도 구간이 이번 주(prev → date)일 때만 쓴다. 동점은 판매중이 많은 순"""
    segs, td = mm.get("segments", {}), mm.get("trend_dates", [])
    use = wk and mm.get("date") == date
    speed_ok = use and mm.get("speed_interval") == [prev, date]
    L = {"fast": [], "slow": [], "down": [], "up": []}
    for m in mm["models"] if use else []:
        if m.get("on", 0) < MOVER_ON:
            continue
        base = {"maker": m["maker"], "group": m.get("group", ""), "model": m["model"], "seg": m["seg"], "origin": m["origin"], "on": m["on"]}
        sr = segs.get(f"{m['seg']}·{m['origin']}", {})
        if speed_ok and m.get("rate_w") is not None and sr.get("rate_w"):
            ratio = m["rate_w"] / sr["rate_w"]
            if ratio >= FAST:
                L["fast"].append(dict(base, rate_w=m["rate_w"], seg_rate=sr["rate_w"], ratio=round(ratio, 2), _k=-ratio))
            elif ratio <= SLOW:
                w = m.get("weeks")                                                       # 판매 0대면 소진 주수 없음 → 맨 앞
                L["slow"].append(dict(base, weeks=w, rate_w=m["rate_w"], seg_weeks=sr.get("weeks"), _k=-(w if w is not None else np.inf)))
        t = week_trend(m, td, prev, date)
        if t:
            L["down" if t["d"] < 0 else "up"].append(dict(base, **t, _k=-abs(t["d"])))
    out = {}
    for o in ORIGINS:
        out[o] = {}
        for k, rows in L.items():
            rs = sorted((x for x in rows if o == "전체" or x["origin"] == o), key=lambda x: (x["_k"], -x["on"], x["model"]))
            out[o][k] = [{a: v for a, v in x.items() if a != "_k"} for x in rs[:MOVER_N]]
    return out


# ───────── 요약 문장 (시장 · 속도 · 가격) ─────────
def seg_name(key):
    o, s = key.split("|")
    return f"{o} {s}"


def seg_keys(G):
    """요약에서 견줄 차급(국산·수입 × 차급) — 시세·판매속도·재고 표본 적음 제외"""
    return [k for k, g in G.items() if not k.startswith("전체|") and not k.endswith("|전체") and not g["low_sample"]]


def rate_se(r, n):
    return np.sqrt(r * (1 - r) / n) if r is not None and n else np.inf


def beats(a, na, b, nb, pp):
    """비율 a(표본 na)가 b(표본 nb)보다 pp%p 이상, 흔들림 2배 이상 큰가"""
    return a - b >= max(pp / 100, 2 * np.hypot(rate_se(a, na), rate_se(b, nb)))


def fast_model(mm, prev, date, wk):
    """요약 속도 줄의 모델 — 판매중 100대 이상 중 판매율이 같은 차급의 1.15배 이상이고, 차이가 흔들림 2배(시작 재고는 판매중으로 어림)를
    넘는 곳 가운데 배수가 가장 큰 모델"""
    if not (wk and mm.get("date") == date and mm.get("speed_interval") == [prev, date]):
        return None
    segs, best = mm.get("segments", {}), None
    for m in mm["models"]:
        sr = segs.get(f"{m['seg']}·{m['origin']}", {})
        r, rs = m.get("rate_w"), sr.get("rate_w")
        if m.get("on", 0) < MOVER_ON or r is None or not rs or r / rs < FAST or not beats(r, m["on"], rs, sr.get("n_start"), 0):
            continue
        if best is None or (r / rs, m["on"]) > (best["ratio"], best["on"]):
            best = dict(m, ratio=r / rs, seg_rate=rs)
    return best


def model_cut(S, mm, G, date):
    """요약 가격 줄의 모델 — 판매중 100대 이상 · 같은 매물 50대 이상 세부모델 중 인하 비율이 같은 차급보다 2%p·흔들림 2배 넘게 높은
    곳 가운데 인하 비율이 가장 큰 모델"""
    if S is None or mm.get("date") != date:
        return None
    T = S[~S["odd"].values]
    cut = (T["p1"] < T["p0"]).groupby(T["key"].values)
    n, c = cut.size(), cut.mean()
    best = None
    for m in mm["models"]:
        k = f"{m['maker']}|{m['model']}"
        sx = (G.get(f"{m['origin']}|{m['seg']}") or {}).get("px")
        if m.get("on", 0) < MOVER_ON or k not in n.index or n[k] < MODEL_PX_N or not sx:
            continue
        if beats(c[k], n[k], sx["cut"], sx["n"], SUM_SEG_PP) and (best is None or (c[k], n[k]) > (best["cut"], best["n"])):
            best = {"name": f"{m['maker']} {m['model']}", "seg": f"{m['origin']} {m['seg']}", "n": int(n[k]), "cut": float(c[k]), "seg_cut": sx["cut"]}
    return best


def market_line(a, pwk, days, prev):
    """시장 — 지난주 값이 없으면 이번 주 신규·판매 사실 문장(+ 판매중 ±1% 넘는 변화), 있으면 판매중 ±1%·신규·판매 ±5% 넘는 변화만"""
    ch = lambda v, v0: (v / v0 - 1) * 100 if v is not None and v0 else None
    if a["new_w"] is None or a["sold_w"] is None:
        return None
    on = ch(a["on"], a["on_prev"])
    on_s = (f"판매중 매물이 {a['on']:,}대로 {last_word(days, prev)}보다 {abs(on):.1f}% {'늘었' if on > 0 else '줄었'}습니다."
            if on is not None and abs(on) >= SUM_ON_PCT else None)
    if not pwk:
        span = "이번 주" if days == 7 else f"지난 {days}일 동안 주 평균"
        s = f"{span} 신규 매물 {a['new_w']:,}대가 올라오고 {a['sold_w']:,}대가 팔렸습니다(판매는 목록에서 사라진 매물)."
        return s + (" " + on_s if on_s else "")
    parts = [on_s] if on_s else []
    unit = "주" if days == 7 else f"이번 {days}일 구간 주 평균"
    for name, v, v0 in [("신규 매물이", a["new_w"], a["new_w_prev"]), ("판매가", a["sold_w"], a["sold_w_prev"])]:
        c = ch(v, v0)
        if c is not None and abs(c) >= SUM_FLOW_PCT:
            parts.append(f"{name} {unit} {v:,}대로 지난주보다 {abs(c):.1f}% {'늘었' if c > 0 else '줄었'}습니다.")
    return " ".join(parts) or None


def speed_line(G, ser, date, prev, fm, pwk, days):
    """속도 — 지난주 값이 없으면 이번 주 판매율 + 전체와 2%p(흔들림 2배) 넘게 다른 차급, 있으면 판매율 변화(전체 1%p · 차급 2%p,
    흔들림 2배)를 넘는 것만. 둘 다 차급 대비 가장 빨리 팔린 모델(fast_model)을 붙인다"""
    a, n = G["전체|전체"], (point(ser["전체|전체"], date) or {}).get("n_start")
    r = a["rate_w"]
    if r is None:
        return None
    ns = {k: (point(ser[k], date) or {}).get("n_start") or 0 for k in seg_keys(G)}
    cand = [k for k in ns if G[k]["rate_w"] is not None and ns[k] >= MIN_N]
    s = []
    if not pwk:
        s.append(f"지난주 판매중이던 매물의 {pct(r)}가 이번 주에 팔렸습니다(재고 소진 {a['weeks']}주)." if days == 7 else
                 f"지난 목록에서 판매중이던 매물이 {days}일 동안 주 평균 {pct(r)}씩 팔렸습니다(재고 소진 {a['weeks']}주).")
        hi = max((k for k in cand if beats(G[k]["rate_w"], ns[k], r, n, SUM_SEG_PP)), key=lambda k: G[k]["rate_w"], default=None)
        lo = min((k for k in cand if beats(r, n, G[k]["rate_w"], ns[k], SUM_SEG_PP)), key=lambda k: G[k]["rate_w"], default=None)
        c = []
        if hi: c.append(f"{josa(seg_name(hi), '이', '가')} 주 {pct(G[hi]['rate_w'])}로 가장 빨랐")
        if lo: c.append(f"{josa(seg_name(lo), '이', '가')} 주 {pct(G[lo]['rate_w'])}로 가장 느렸")
        if c:
            s.append("표본이 충분한 차급 가운데 " + "고 ".join(c) + "습니다.")
    else:
        unit = "주" if days == 7 else f"이번 {days}일 구간 주 평균"
        rp, npv = a["rate_w_prev"], (point(ser["전체|전체"], prev) or {}).get("n_start")
        if rp is not None:
            d = r - rp
            if abs(d) >= max(SUM_RATE_PP[0] / 100, 2 * np.hypot(rate_se(r, n), rate_se(rp, npv))):
                s.append(f"판매율이 {unit} {pct(r)}로 지난주({pct(rp)})보다 {abs(d) * 100:.1f}%p {'올랐' if d > 0 else '내렸'}습니다.")
        best, bd = None, 0.0
        for k in cand:
            g, n0 = G[k], (point(ser[k], prev) or {}).get("n_start") or 0
            if g["rate_w_prev"] is None or n0 < MIN_N:
                continue
            d = g["rate_w"] - g["rate_w_prev"]
            if abs(d) >= max(SUM_RATE_PP[1] / 100, 2 * np.hypot(rate_se(g["rate_w"], ns[k]), rate_se(g["rate_w_prev"], n0))) and abs(d) > abs(bd):
                best, bd = k, d
        if best:
            g = G[best]
            s.append(f"표본이 충분한 차급 가운데 {seg_name(best)} 판매율이 {unit} {pct(g['rate_w'])}로 지난주({pct(g['rate_w_prev'])})보다 "
                     f"가장 크게 {'올랐' if bd > 0 else '내렸'}습니다.")
    if fm:
        s.append(f"판매중 100대 이상 모델 가운데 같은 차급에 견줘 가장 빨리 팔린 모델은 {fm['maker']} {fm['model']}입니다"
                 f"(주 {pct(fm['rate_w'])}, {fm['origin']} {fm['seg']} {pct(fm['seg_rate'])}의 {fm['ratio']:.1f}배).")
    return " ".join(s) or None


def price_line(G, ser, psig, date, prev, pwk, days, pdays, mc):
    """가격 — 같은 매물 인하(지난주 값이 없으면 사실 문장, 있으면 2%p·흔들림 2배 넘는 변화만) + 인하가 전체보다 2%p(흔들림 2배) 넘게
    많은 차급(같은 매물 300대 이상) · 같은 차급보다 많은 모델(model_cut) 중 가장 많은 곳 + 신규 매물 시세 지수의 지난주 대비"""
    a = G["전체|전체"]
    px, pp, s = a["px"], a["px_prev"], []
    if px is not None and px["cut_med_pct"] is not None:
        tail = f"(내린 매물 중앙 {signed(px['cut_med_pct'])}%·{signed(-px['cut_med_amt'], 0)}만원)"
        if pp is None:
            s.append(("" if days == 7 else f"지난 {days}일 동안 ") + f"같은 매물의 {pct(px['cut'])}가 가격을 내렸습니다{tail}.")
        else:
            d = px["cut"] - pp["cut"]
            if abs(d) >= max(SUM_CUT_PP / 100, 2 * np.hypot(rate_se(px["cut"], px["n"]), rate_se(pp["cut"], pp["n"]))):
                week = days == pdays == 7
                s.append(("가격을 내린 같은 매물이" if week else f"이번 {days}일 구간에 가격을 내린 같은 매물이") + f" {pct(px['cut'])}로 "
                         + ("지난주" if week else f"지난 {pdays}일 구간") + f"({pct(pp['cut'])})보다 {abs(d) * 100:.1f}%p "
                         f"{'늘었' if d > 0 else '줄었'}습니다{tail}.")
    top = []
    if px is not None:
        cand = [k for k, g in G.items() if not k.startswith("전체|") and not k.endswith("|전체") and g["px"] and g["px"]["n"] >= MIN_N]
        k = max((k for k in cand if beats(G[k]["px"]["cut"], G[k]["px"]["n"], px["cut"], px["n"], SUM_SEG_PP)),
                key=lambda k: G[k]["px"]["cut"], default=None)
        if k: top.append(f"표본이 충분한 차급 가운데 {seg_name(k)} {pct(G[k]['px']['cut'])}")
        if mc: top.append(f"같은 매물 {MODEL_PX_N}대 이상 모델 가운데 {mc['name']} {pct(mc['cut'])}(같은 차급 {mc['seg']} {pct(mc['seg_cut'])})")
    if top:
        s.append("인하 비율이 가장 높은 곳은 " + ", ".join(top) + "입니다.")
    e, p = point(ser["전체|전체"], date) or {}, point(ser["전체|전체"], prev) or {}
    v1, v0, sig = a["idx"]["시세"], (a["idx_prev"] or {}).get("시세"), psig.get("전체|전체")
    if v1 is not None and v0 is not None and sig and e.get("n_price") and p.get("n_price"):
        se = float(np.hypot(v1 * SE_MED * sig / np.sqrt(e["n_price"]), v0 * SE_MED * sig / np.sqrt(p["n_price"])))
        d = round(v1 - v0, 1)
        if d != 0 and abs(d) >= max(TREND_MIN_D, TREND_K * se) - 1e-9:
            s.append(f"신규 매물 시세 지수는 {last_word(days, prev)}보다 {abs(d):.1f} {'올랐' if d > 0 else '내렸'}습니다({v0:.1f} → {v1:.1f}, 7월 초 = 100).")
    return " ".join(s) or None


def summary(G, ser, psig, fm, mc, date, prev, wk, pwk, days, pdays):
    if not wk:
        return []
    lines = [market_line(G["전체|전체"], pwk, days, prev), speed_line(G, ser, date, prev, fm, pwk, days),
             price_line(G, ser, psig, date, prev, pwk, days, pdays, mc)]
    return [x for x in lines if x]


# ───────── 화면에 붙일 주의 ─────────
def comparable(gp, gq, gpp, wk, pwk, susp=False):
    """지표별 지난주 대비가 되는지(group()과 같은 규칙) — gp·gq·gpp = 이번·지난·그 앞 목록의 전남광주 누락 여부,
    susp = 지난 회차 판매 누락 의심"""
    return {"판매중": wk and gp == gq, "신규 유입": pwk and gp == gq, "판매": pwk and gq == gpp and not susp,
            "판매율": pwk, "같은 매물 가격 변화": pwk}


def ahead(a, g0, date, prev, days, wk):
    """앞으로 두 회차(7일 간격으로 봄)의 [(날짜, 지표별 지난주 대비 됨, 전남광주를 빼고 본 것)] — 전남광주 누락은 지금 상태가
    이어지다 아직 오지 않은 JN_BACK 회차부터 끝난다고 본다. g0 = 이번 주 그룹(이번 값이 없으면 다음 주 지난주 값도 없음)"""
    g = lambda d: bool((point(a, d) or {}).get("jn_gap"))
    now = g(date)
    fut = lambda d: now and not (date < JN_BACK <= d)
    d1, d2 = day(date, 7).isoformat(), day(date, 14).isoformat()
    susp = bool((point(a, date) or {}).get("sold_suspect"))
    have = {"판매율": g0["rate_w"] is not None,
            "같은 매물 가격 변화": g0["px"] is not None and days is not None and abs(7 - days) <= PX_GAP_DIFF}   # 다음 주(7일)와 구간 길이가 맞아야
    c1 = comparable(fut(d1), now, g(prev), True, wk, susp)
    c1.update({k: c1[k] and v for k, v in have.items()})
    n1 = comparable(False, False, False, True, wk, susp)
    n1.update({k: n1[k] and v for k, v in have.items()})
    return [(d1, c1, n1), (d2, comparable(fut(d2), fut(d1), now, True, True), comparable(False, False, False, True, True))]


def names(ks, a, b):
    return josa("·".join(ks), a, b)


def starts_of(G, fut):
    """지금 지난주 대비가 없는 지표마다 처음 나오는 수집 회차 {'신규 유입': '2026-11-11', …} — 두 회차 안에 없으면 None(그 뒤)"""
    a = G["전체|전체"]
    return {k: next((d for d, c, _ in fut if c[k]), None) for k, f in IND if a[f] is None}


def when_note(G, fut, why):
    """지금 지난주 대비가 없는 지표가 언제부터 나오는지 — '지난주 대비는 판매·판매율이 11/4 수집부터, 신규 유입이 11/11 수집부터 나옵니다(이유).'"""
    a = G["전체|전체"]
    miss = [k for k, f in IND if a[f] is None]
    if not miss:
        return None
    first = {k: next((d for d, c, _ in fut if c[k]), None) for k in miss}
    parts = [f"{names([k for k in miss if first[k] == d], '이', '가')} {md(d)} 수집부터" for d, _, _ in fut if any(first[k] == d for k in miss)]
    rest = [k for k in miss if first[k] is None]
    if rest:
        parts.append(f"{names(rest, '은', '는')} 그 뒤 회차부터")
    return "지난주 대비는 " + ", ".join(parts) + " 나옵니다" + (f"({why})." if why else ".")


def pause_note(date, fut):
    """앞으로 전남광주 누락 여부가 바뀌는 회차에 지난주 대비를 쉬는 지표 — '판매중·신규 유입은 11/4, 판매는 11/11'"""
    rows = [(d, [k for k, _ in IND if n[k] and not c[k]]) for d, c, n in fut]
    rows = [(d, ks) for d, ks in rows if ks]
    if not rows:
        return None
    head = (f"{md(JN_BACK)} 수집부터 전남광주 매물을 다시 받을 예정입니다. " if date < JN_BACK <= rows[-1][0] else "")
    return (head + "전남광주 매물이 빠진 목록과 빠지지 않은 목록을 견주게 되는 주에는 그 대수를 지난주와 비교하지 않습니다 — "
            + ", ".join(f"{names(ks, '은', '는')} {md(d)}" for d, ks in rows) + ".")


def jn_notes(e, p, q, date, wk, pwk):
    """전남광주 누락(jn_gap)·판매 시작 목록 누락(jn_gap_sold)·판매 누락 의심 — 이번 회차 사실과 지난주와 비교하지 않는 이유"""
    out = []
    if e.get("jn_gap"):
        fx = e.get("stock_fix")
        s = (f"{md(date)} 목록은 엔카 지역 표시가 바뀌어 " + (f"전남광주 매물 약 {fx:,}대가" if fx else "전남광주 매물이") + " 수집에서 빠졌습니다. "
             + ("판매중·신규·판매" if e.get("jn_gap_sold") else "판매중·신규") + " 대수가 실제보다 적게 잡혔습니다"
             + ("(재고 지수에는 이 대수를 더해 계산)." if fx else "."))
        if wk and p.get("jn_gap"):
            s += " 지난주 목록도 같아 지난주 대비에는 영향이 적습니다."
        elif wk:
            s += " 지난주 목록에는 전남광주 매물이 있어 판매중·신규 대수를 지난주와 비교하지 않습니다."
        out.append(s)
    else:
        if wk and p.get("jn_gap"):
            out.append(f"{md(date)} 목록부터 전남광주 매물이 다시 들어와 판매중·신규 대수를 지난주와 비교하지 않습니다.")
        if e.get("jn_gap_sold"):
            out.append("이번 주 판매 대수는 시작 목록(지난 목록)에 전남광주 매물이 빠져 있어 실제보다 적게 잡혔습니다(판매율은 영향이 적음).")
    if pwk and bool(e.get("jn_gap_sold")) != bool(q.get("jn_gap_sold")):
        out.append("판매 대수는 시작 목록의 전남광주 누락 여부가 지난주와 달라 지난주와 비교하지 않습니다.")
    if wk and e.get("sold_suspect"):
        out.append("이번 주는 목록 누락이 의심돼 판매가 실제보다 많게 잡혔을 수 있어 판매 대수를 지난주와 비교하지 않습니다.")
    elif pwk and q.get("sold_suspect"):
        out.append("지난주 판매가 목록 누락 의심으로 많게 잡혔을 수 있어 판매 대수를 지난주와 비교하지 않습니다.")
    return out


def px_note(po, date, prev, pp, wk, pwk, days, pdays, has_px, has_pxp):
    """같은 매물 가격 변화가 없거나 지난주와 비교하지 않는 이유"""
    if wk and not has_px:
        miss = [md(d) for d in [prev, date] if d not in po]
        return f"{'·'.join(miss)} 목록의 가격 관측이 없어 같은 매물 가격 변화를 내지 않습니다." if miss else None
    if pwk and has_px and not has_pxp:
        if abs(days - pdays) > PX_GAP_DIFF:
            return f"같은 매물 가격 변화는 이번 구간({days}일)과 지난 구간({pdays}일)의 길이가 달라 지난주와 비교하지 않습니다."
        if pp not in po:
            return f"같은 매물 가격 변화의 지난주 값은 {md(pp)} 목록의 가격 관측이 없어 비교하지 않습니다."
    return None


def notes_of(mi, G, po, date, prev, pp, days, pdays, wk, pwk):
    cr, a = mi["crawls"], mi["series"]["전체|전체"]
    e, p = point(a, date) or {}, (point(a, prev) or {}) if wk else {}
    q = p if pwk else {}
    g0 = G["전체|전체"]
    fut = ahead(a, g0, date, prev, days, wk)
    out, why = [], None
    if prev is None:
        out.append("첫 수집이라 지난주와 비교할 숫자가 없습니다.")
    elif not wk:
        out.append(f"이번 목록은 지난 목록({md(prev)})과 {days}일 간격이라 이번 주 신규·판매·판매율과 같은 매물 가격 변화를 내지 않습니다.")
    elif not pwk:
        g = gap(cr[-3]["date"], prev) if len(cr) >= 3 else None
        w = "첫 수집" if g is None else (f"{g}일 공백 뒤 첫 회차" if g > WEEK_DAYS[1] else f"직전 목록과 {g}일 간격")
        why = f"{md(prev)} 목록은 {josa(w, '이라', '라')} 그 앞 구간과 비교하지 않습니다"
    out.append(when_note(G, fut, why))
    starts = starts_of(G, fut)
    out += jn_notes(e, p, q, date, wk, pwk)
    out.append(pause_note(date, fut))
    out.append(px_note(po, date, prev, pp, wk, pwk, days, pdays, g0["px"] is not None, g0["px_prev"] is not None))
    m = re.search(r"7월 범위 밖 ([\d,]+)대", cr[-1].get("note") or "")
    if m:
        both = len(cr) >= 2 and "7월 범위 밖" in (cr[-2].get("note") or "")
        out.append(f"판매중·신규·판매·판매율과 지수는 7월부터 받던 수집 범위로만 셉니다(새로 받는 국산 쉐보레 등 {m.group(1)}대 제외). "
                   + ("같은 매물 가격 변화와 주목할 모델에는 들어갑니다." if both else
                      "이 매물은 이번 주 같은 매물 가격 변화와 주목할 모델의 판매 속도에는 아직 없고, 다음 수집부터 들어갑니다."))
    return [x for x in out if x], starts


# ───────── 합치기 · 검사 ─────────
def build(mi, mm):
    cr = mi["crawls"]
    date = cr[-1]["date"]
    prev = cr[-2]["date"] if len(cr) >= 2 else None
    days = gap(prev, date)
    wk = is_week(days)
    pwk = wk and len(cr) >= 3 and is_week(gap(cr[-3]["date"], prev))
    pp = cr[-3]["date"] if pwk else None
    pdays = gap(pp, prev)
    info = listing_info()
    po = price_obs([d for d in [pp, prev, date] if d])
    S = same_listing(po, prev, date, info) if wk else None
    Sp = same_listing(po, pp, prev, info) if pwk and S is not None and abs(days - pdays) <= PX_GAP_DIFF else None   # 그 앞 주
    ser = mi["series"]
    G = {k: group(pts, date, prev, wk, pwk, px_stats(pick(S, k)) if S is not None else None,
                  px_stats(pick(Sp, k)) if Sp is not None else None) for k, pts in ser.items()}
    mv = movers(mm, prev, date, wk)
    fm, mc = fast_model(mm, prev, date, wk), model_cut(S, mm, G, date)
    out = {"version": datetime.date.today().isoformat(), "date": date, "prev": prev, "days": days, "weekly": bool(wk), "prev_weekly": bool(pwk),
           "note": "마켓 펄스(기획안 5.5.1) — 이번 목록(date)과 지난 목록(prev) 비교. groups = market_index series 와 같은 세그먼트: "
                   "on = 판매중 확인 · new_w·sold_w = 주간 신규·판매(판매 = 목록에서 사라짐) · rate_w = 주간 판매율 · weeks = 재고 소진 주수(1 ÷ 판매율) · "
                   "idx = 지수(7월 초 = 100) · px = 같은 매물 가격 변화(두 목록에 모두 있는 상세 확인 판매중 매물 — 가격 플래그·제조사 없는 매물과 "
                   "한 주 가격이 절반 미만·2배 초과로 바뀐 관측은 뺌(n_bad = 뺀 관측 수), chg_* %, cut·up 비율, cut_med_pct %(음수), cut_med_amt 만원(양수, 내린 금액)) · "
                   "*_prev = 지난주 값(없으면 null). movers = 판매중 100대 이상 세부모델: fast·slow(차급 판매율 대비 1.15배 이상·0.87배 이하), "
                   "down·up(1주 시세 변화가 흔들림 기준을 넘는 것). starts = 지금 지난주 대비가 없는 지표(판매중·신규 유입·판매·판매율·"
                   "같은 매물 가격 변화)가 처음 나오는 수집 회차(앞으로 두 회차 안에 없으면 null)",
           "groups": G, "movers": mv,
           "summary": summary(G, ser, mi.get("price_sig", {}), fm, mc, date, prev, wk, pwk, days, pdays),
           "notes": None, "starts": None}
    out["notes"], out["starts"] = notes_of(mi, G, po, date, prev, pp, days, pdays, wk, pwk)
    if wk and mm.get("date") != date:
        out["notes"].append(f"주목할 모델은 시황 지수와 날짜가 달라({md(mm.get('date') or date)} 기준) 이번 주에는 고르지 않았습니다.")
    return out, (S, Sp)


def check(out, keys):
    """출력 계약(tabs_spec 2.1) 검사 — 어긋나면 파일을 쓰지 않고 멈춘다"""
    date_re = re.compile(r"^\d{4}-\d{2}-\d{2}$")
    assert all(k in out for k in ["version", "date", "prev", "days", "weekly", "prev_weekly", "groups", "movers", "summary", "notes", "starts"])
    assert isinstance(out["starts"], dict) and set(out["starts"]) <= {k for k, _ in IND} \
        and all(v is None or (date_re.match(v) and v > out["date"]) for v in out["starts"].values()), "starts"
    assert date_re.match(out["version"]) and date_re.match(out["date"]) and (out["prev"] is None or date_re.match(out["prev"]))
    assert isinstance(out["weekly"], bool) and isinstance(out["prev_weekly"], bool) and (out["weekly"] or not out["prev_weekly"])
    assert set(out["groups"]) == set(keys), "groups 는 market_index series 키 전부"
    num = (int, float)
    for k, g in out["groups"].items():
        assert set(g) == {"on", "on_prev", "new_w", "new_w_prev", "sold_w", "sold_w_prev", "rate_w", "rate_w_prev", "weeks", "weeks_prev",
                          "idx", "idx_prev", "px", "px_prev", "low_sample"}, k
        assert isinstance(g["on"], int) and isinstance(g["low_sample"], bool), k
        for f in ["on_prev", "new_w", "new_w_prev", "sold_w", "sold_w_prev"]:
            assert g[f] is None or isinstance(g[f], int), (k, f)
        for f in ["rate_w", "rate_w_prev"]:
            assert g[f] is None or 0 <= g[f] <= 1, (k, f)
        for f in ["weeks", "weeks_prev"]:
            assert g[f] is None or (isinstance(g[f], num) and g[f] > 0), (k, f)
        assert set(g["idx"]) == set(IDX_KEYS) and (g["idx_prev"] is None or set(g["idx_prev"]) == set(IDX_KEYS)), k
        assert g["px_prev"] is None or g["px"] is not None, (k, "px_prev 는 px 가 있을 때만")
        for f in ["px", "px_prev"]:
            x = g[f]
            if x is None: continue
            assert set(x) == set(PX_KEYS) and isinstance(x["n"], int) and x["n"] > 0 and isinstance(x["n_bad"], int) and x["n_bad"] >= 0, (k, f)
            assert 0 <= x["cut"] <= 1 and 0 <= x["up"] <= 1 and x["cut"] + x["up"] <= 1 + 1e-9, (k, f)
            assert x["cut_med_pct"] is None or x["cut_med_pct"] <= 0, (k, f)
            assert x["cut_med_amt"] is None or (isinstance(x["cut_med_amt"], int) and x["cut_med_amt"] >= 0), (k, f)
            if k.endswith("|전체") and k.split("|")[0] in ORIGINS and x["n"] >= MIN_N and x["cut"] > 2 * x["up"]:
                assert x["chg_wtd"] <= 0 and x["chg_avg"] <= 0, (k, f, "인하가 인상의 2배 넘는데 평균 변화가 플러스 — 이상값 확인")
    for o in ORIGINS:
        M = out["movers"][o]
        assert set(M) == {"fast", "slow", "down", "up"}, o
        base = {"maker", "group", "model", "seg", "origin", "on"}
        for k, extra in [("fast", {"rate_w", "seg_rate", "ratio"}), ("slow", {"weeks", "rate_w", "seg_weeks"}), ("down", {"p0", "p1", "d", "se"}), ("up", {"p0", "p1", "d", "se"})]:
            rows = M[k]
            assert len(rows) <= MOVER_N and all(set(x) == base | extra for x in rows), (o, k)
            assert all(x["on"] >= MOVER_ON and (o == "전체" or x["origin"] == o) for x in rows), (o, k)
        assert all(x["ratio"] >= FAST for x in M["fast"]) and all(x["rate_w"] * x["seg_weeks"] <= SLOW + 0.02 for x in M["slow"])
        assert [x["ratio"] for x in M["fast"]] == sorted((x["ratio"] for x in M["fast"]), reverse=True)
        assert all(x["d"] < 0 for x in M["down"]) and all(x["d"] > 0 for x in M["up"])
        assert all(abs(x["d"]) >= max(TREND_MIN_D, TREND_K * x["se"]) - 0.011 for x in M["down"] + M["up"])
    assert isinstance(out["summary"], list) and len(out["summary"]) <= 3 and all(isinstance(s, str) and s for s in out["summary"])
    assert isinstance(out["notes"], list) and all(isinstance(s, str) and s for s in out["notes"])
    txt = out["summary"] + out["notes"] + [out["note"]]
    assert not any("환산" in s for s in txt), "새 탭에는 '환산'을 쓰지 않는다"
    assert not any(re.search(r"None|NaN|(?<![A-Za-z])nan(?![A-Za-z])|매물가 수집", s) for s in txt), "문장에 빈 값·조사 오류"
    json.dumps(out, ensure_ascii=False, allow_nan=False)                                # NaN·Infinity 없음


def report(out, S):
    """확인용 출력 — 전체·국산·수입 숫자와 주목할 모델 이름"""
    f = lambda v, k=0: "—" if v is None else (f"{v:,.{k}f}" if isinstance(v, (int, float)) else str(v))
    lines = [f"마켓 펄스 — {out['date']} (지난 목록 {out['prev']}, {out['days']}일) · weekly {out['weekly']} · prev_weekly {out['prev_weekly']}"]
    if S is not None:
        lines.append(f"같은 매물: 두 목록·상세 확인·플래그 없음 {len(S):,}대(상태 판매중 {int(S['on'].sum()):,}) · 한 주 절반 미만·2배 초과로 뺌 {int(S['odd'].sum()):,}")
    for key in ["전체|전체", "국산|전체", "수입|전체"]:
        g = out["groups"][key]
        i, ip = g["idx"], g["idx_prev"] or {}
        lines.append(f"[{key}] 판매중 {f(g['on'])} (지난주 {f(g['on_prev'])}) · 신규/주 {f(g['new_w'])} · 판매/주 {f(g['sold_w'])} · "
                     f"판매율 {f(g['rate_w'] and g['rate_w'] * 100, 1)}% · 소진 {f(g['weeks'], 1)}주")
        lines.append(f"    지수 시세 {f(i['시세'], 1)}({f(ip.get('시세'), 1)}) · 판매속도 {f(i['판매속도'], 1)} · 재고 {f(i['재고'], 1)}({f(ip.get('재고'), 1)}) · "
                     f"시황 {f(i['시황'], 1)} {i['label'] or ''}")
        x = g["px"]
        if x:
            lines.append(f"    같은 매물 {x['n']:,}대(뺀 관측 {x['n_bad']}): 인하 {x['cut'] * 100:.1f}% (중앙 {f(x['cut_med_pct'], 1)}%, {f(x['cut_med_amt'])}만원) · "
                         f"인상 {x['up'] * 100:.1f}% · 변화 중앙 {x['chg_med']:+.1f}% · 평균 {x['chg_avg']:+.1f}% · 가중 {x['chg_wtd']:+.1f}%")
    lines.append("[차급별 같은 매물 인하 비율] " + " · ".join(f"{k} {g['px']['cut'] * 100:.1f}%({g['px']['n']:,})" for k, g in out["groups"].items()
                                                  if g["px"] and not k.endswith("|전체") and not k.startswith("전체|") and g["px"]["n"] >= MIN_N))
    for o in ORIGINS:
        M = out["movers"][o]
        lines.append(f"[주목할 모델 — {o}]")
        lines.append("    빨리: " + ", ".join(f"{x['model']} {x['rate_w'] * 100:.1f}%(×{x['ratio']:.2f})" for x in M["fast"]))
        lines.append("    쌓임: " + ", ".join(f"{x['model']} {f(x['weeks'], 1)}주" for x in M["slow"]))
        lines.append("    내림: " + ", ".join(f"{x['model']} {x['d']:+.1f}(±{x['se']:.1f})" for x in M["down"]))
        lines.append("    오름: " + ", ".join(f"{x['model']} {x['d']:+.1f}(±{x['se']:.1f})" for x in M["up"]))
    lines.append("[요약]")
    lines += [f"  · {s}" for s in out["summary"]] or ["  (기준을 넘는 문장 없음)"]
    lines.append("[주의]")
    lines += [f"  · {s}" for s in out["notes"]]
    return "\n".join(lines)


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    t0 = datetime.datetime.now()
    with open(MI_JSON, encoding="utf-8") as f:
        mi = json.load(f)
    with open(MM_JSON, encoding="utf-8") as f:
        mm = json.load(f)
    out, (S, _) = build(mi, mm)
    check(out, mi["series"].keys())
    with open(OUT_JSON, "w", encoding="utf-8", newline="\n") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
        f.write("\n")
    print(report(out, S))
    print(f"→ {OUT_JSON} ({os.path.getsize(OUT_JSON) / 1024:.0f}KB) · {(datetime.datetime.now() - t0).total_seconds():.1f}초")


if __name__ == "__main__":
    main()
