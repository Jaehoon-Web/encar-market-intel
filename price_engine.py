# -*- coding: utf-8 -*-
"""
price_engine.py — 시세 산정 엔진 (기획안 WP1, 5.1.2): "가장 비슷한 매물 + 조건 보정"

    python price_engine.py --validate     # 판매중 매물 하나씩을 나머지 매물로 추정해 정확도를 잰다
                                          # → encar_output/prep/price_engine_report.txt
    python price_engine.py --demo         # 판매중 매물 몇 대로 한 대 산정 결과(비교 매물·보정 근거·환산가)를 보여 준다
    python price_engine.py --export       # 사이트용 모델그룹별 비교 매물 파일 + index.json → web/data/comps (매주 auto_update 2.9단계)
    python price_engine.py --parity       # --export 후, 사이트 엔진(web/lib/price_engine.js)이 같은 값을 내는지 판매중 전체로 검증

산정 순서 (대상 차 1대)
  1 후보: 같은 모델(엔카 '모델' = 기획안의 세부모델)의 비교 가능 매물 중 성능점검이 있는 것.
          판매중(현재가) + 최근 3개월 판매(마지막 호가). 같은 차(차키)는 뺀다
  2 단계별 매칭: 비교 매물이 5대 이상 모이는 첫 단계를 쓴다
          1 정확(등급 일치·차령 ±6개월·주행 ±2만km·성능등급 ±1) → 2 차령 ±12개월 → 3 주행 ±4만km → 4 등급 무관 → 5 모델 전체
          상태 미상이면 성능등급 조건을 쓰지 않는다
  3 조건 보정: 가격 × (1−대상 감가율)/(1−비교 감가율) × exp(D3 계수: 차령·주행·렌트·색상 차이 + 등급·세부등급 차이)
               × 시점(판매 매물의 마지막 호가 → 지금, D4 시세지수 국산·수입별).
               상태 미상이면 성능 보정 없이 계산하고, 무사고 기준 값(대상 감가율 0)을 따로 낸다
  4 이상치: 로그 보정가가 가중 중앙값에서 3×MAD(최소 15%)보다 멀면 뺀다. 남는 매물이 5대 미만이면 빼지 않는다
  5 대표값: 유사도 가중 중앙값. 범위는 가중 25~75%
  6 신뢰도: A 10대 이상·2단계 이내·범위가 대표값 ±8% 안 / B 4단계 이내 / C 5단계(참고용)
  7 환산가: 대표값 × (1 − 환산 비율: 직접 입력 → 팀 수정(모델) → 모델 예외 → 호가대×차령 기준표). 수리비는 시세·환산가에서 전액 뺀다
"""
import os, re, sys, json, zlib, glob, argparse, datetime, subprocess
import numpy as np
import pandas as pd
import adjust_coef as AC

ROOT = os.path.dirname(os.path.abspath(__file__))
PREP = os.path.join(ROOT, "encar_output", "prep")
DATA = os.path.join(ROOT, "web", "data")
REPORT = os.path.join(PREP, "price_engine_report.txt")
SITE = os.path.join(DATA, "comps")                               # 사이트용 비교 매물 파일 — 매주 auto_update가 web/data와 함께 커밋
PARITY = os.path.join(PREP, "_engine_parity.json")
RUNNER = os.path.join(ROOT, "tools", "price_engine_parity.js")

STEPS = AC.STEPS                      # (이름, 등급 일치, 차령 ±개월, 주행 ±만km, 성능등급 ±)
COLORS, FEATS, KM_CAP = AC.COLORS, AC.FEATS, AC.KM_CAP
MIN_COMPS, GOOD_COMPS = 5, 10
OUT_MAD, OUT_FLOOR = 3.0, 0.15        # 이상치: 3×MAD, 최소 15%
A_WIDTH = 0.08                        # 신뢰도 A: 범위(25~75%)가 대표값 ±8% 안
SIM = {"age": 12.0, "km": 4.0, "grade": 0.5, "trim": 0.25, "perf": 0.25, "sold": 1.0}    # 유사도 거리(차령 12개월·주행 4만km = 1)
# 판매 매물 감점 1.0: 0.25 대비 오차 5.6→5.5%, 편향 +0.8→+0.4%(1겹 시험). 판매 매물은 마지막 호가라 조금 높게 남는다
OPTS = {"sold": True, "time": True, "weight": True, "outlier": True, "adjust": True}
ENGINE = {"steps": [list(s) for s in STEPS], "colors": COLORS, "km_cap": KM_CAP, "min_comps": MIN_COMPS, "good_comps": GOOD_COMPS,
          "out_mad": OUT_MAD, "out_floor": OUT_FLOOR, "a_width": A_WIDTH, "sim": SIM}       # 사이트 엔진이 읽는 설정(한곳에서 관리)
ROW_FIELDS = ["id", "m", "g", "t", "reg", "om", "km", "rent", "col", "perf", "dep", "price", "sold", "tk",
              "acc", "gv", "gp", "ds", "p0", "sd", "fu"]
# 행에는 매물이 바뀌지 않으면 그대로인 값만 둔다 — 매주 바뀌는 값(현재 월·시점 보정 배수)은 파일 머리말(now_ym·tf)에.
#   om: 가격을 본 달(yyyymm, 판매중은 null → now_ym) · tk: 시점 보정 키('국산|크롤일', 판매중은 null → 1)
#   ds: 체류 시작일(yyyymmdd, 체류일 = 판매일 또는 now_date − ds) · sd: 판매 추정일 · p0: 첫 호가 · fu: 연료(환산 비율 모델 예외용)


# ───────── 데이터 ─────────
def load_pool():
    """비교 후보: 비교사용(판매중 + 최근 3개월 판매, 품질 플래그·중복 제외) 중 성능점검이 있는 매물"""
    L = pd.read_parquet(os.path.join(PREP, "listings.parquet"),
                        columns=["상태", "비교사용", "점검여부", "제조사", "모델그룹", "모델", "등급", "세부등급", "차급", "국산", "연료",
                                 "연식", "등록연월", "주행km", "현재가", "첫가격", "마지막가", "마지막관측일", "판매추정일", "체류일",
                                 "번호판유형", "색상계열", "성능감가율", "성능등급", "사고라벨", "글로비스_종합평가점", "글로비스_감점합", "차키"])
    sold = L["상태"] != "판매중"
    price = L["현재가"].where(~sold, L["마지막가"])
    ok = (L["비교사용"].eq(True) & L["점검여부"].eq(True) & L["성능감가율"].notna() & price.gt(0) & L["주행km"].gt(0)
          & L["번호판유형"].isin(["일반", "렌트"]) & L["등록연월"].notna())
    d = L[ok].copy()
    d["price"], d["sold"] = price[ok].astype(float), sold[ok].values
    seen = pd.to_datetime(d["마지막관측일"])
    reg = (d["등록연월"] // 100) * 12 + d["등록연월"] % 100
    d["age"] = (seen.dt.year * 12 + seen.dt.month - reg).astype(float)              # 그 가격을 본 때의 차령
    d = d[d["age"].between(0, 300)].copy()
    d["km"] = d["주행km"].clip(upper=KM_CAP) / 1e4
    d["rent"] = (d["번호판유형"] == "렌트").astype(float)
    for c in COLORS:
        d[f"c_{c}"] = (d["색상계열"] == c).astype(float)
    d["등급"], d["세부"] = d["등급"].fillna(""), d["세부등급"].fillna("")
    d["origin"] = np.where(d["국산"].eq(True), "국산", "수입")
    d["seg"] = d["차급"].fillna("기타") + "·" + d["origin"]
    d["key"] = d["제조사"] + "|" + d["모델"]
    d["dep"] = d["성능감가율"] / 100
    d["tf"] = time_factor(d)
    return d


def time_factor(d):
    """판매 매물의 마지막 호가를 지금 시세로 옮기는 배수(D4 시세지수, 국산·수입별). 판매중은 1"""
    f = pd.Series(1.0, index=d.index)
    path = os.path.join(DATA, "market_index.json")
    if not os.path.exists(path):
        return f
    with open(path, encoding="utf-8") as fp:
        J = json.load(fp)
    to_obs = {x["crawl"]: x["date"] for x in J["crawls"]}
    for org in ["국산", "수입"]:
        pts = {p["date"]: p["시세"] for p in J["series"].get(f"{org}|전체", []) if "시세" in p}
        if not pts:
            continue
        now = pts[max(pts)]
        m = d["origin"] == org
        f[m] = (now / d.loc[m, "마지막관측일"].astype(str).map(to_obs).map(pts)).fillna(1.0).values
    return f


def coef_from_est(est):
    """adjust_coef.estimate() 결과 → {"models": {key: (b, grade, trim)}, "segments": {seg: b}, "market": b}"""
    return {"models": {k: (m["b"], m["grade"], m["trim"]) for k, m in est["models"].items()},
            "segments": {s: v["b"] for s, v in est["segments"].items()}, "market": est["market"]["b"]}


def coef_from_json(J):
    """web/data/adj_coef.json → 같은 형태(운영·사이트용)"""
    vec = lambda e: np.array([e["age"], e["km"], e["rent"]] + [e["color"].get(c, 0.0) for c in COLORS])
    return {"models": {k: (vec(m), m.get("grade", {}), m.get("trim", {})) for k, m in J["models"].items()},
            "segments": {s: vec(v) for s, v in J["segments"].items()}, "market": vec(J["market"])}


class Group:
    """한 모델의 비교 후보(배열). 보정 계수는 모델 값, 없으면 차급 → 시장 값"""

    def __init__(self, g, C):
        key, seg = g["key"].iat[0], g["seg"].mode().iat[0]
        if key in C["models"]:
            self.b, self.grade, self.trim = C["models"][key]
            self.coef_level = "모델"
        else:
            self.b, self.grade, self.trim = C["segments"].get(seg, C["market"]), {}, {}
            self.coef_level = "차급" if seg in C["segments"] else "시장"
        self.g = g
        self.ids = g.index.values
        self.age, self.km, self.x = g["age"].values, g["km"].values, g[FEATS].values
        self.grades, self.trims = g["등급"].values, g["세부"].values
        self.perf, self.dep = g["성능등급"].values.astype(float), g["dep"].values
        self.price, self.sold, self.tf = g["price"].values, g["sold"].values.astype(bool), g["tf"].values
        self.carkey = g["차키"].values
        self.fe = np.array([self.grade.get(a, 0.0) + self.trim.get(a, {}).get(t, 0.0) for a, t in zip(self.grades, self.trims)])


def wquantile(v, w, q):
    """가중 분위수: 값을 정렬해 누적 가중치가 처음으로 q에 닿는 값(사이트 JS도 같은 규칙)"""
    o = np.argsort(v, kind="stable")
    c = np.cumsum(w[o])
    return v[o][min(np.searchsorted(c, q * c[-1]), len(v) - 1)]


# ───────── 한 대 산정 ─────────
def estimate_one(G, t, opts=None, detail=False):
    """대상 차 t → 결과 dict. 비교 매물이 5대 미만이면 None
    t: 등급, 세부, age(개월), km(만km, 25 상한), rent(0/1), color(계열 | None=모름),
       dep(성능감가율 0~1 | None=상태 미상), perf(성능등급 | None), exclude_id, carkey"""
    o = dict(OPTS, **(opts or {}))
    known = t.get("dep") is not None
    n0 = len(G.ids)
    base = np.ones(n0, bool)
    if t.get("exclude_id") is not None:
        base &= G.ids != t["exclude_id"]
    if t.get("carkey") is not None:
        base &= G.carkey != t["carkey"]
    if not o["sold"]:
        base &= ~G.sold
    dage, dkm = np.abs(G.age - t["age"]), np.abs(G.km - t["km"])
    same_g = G.grades == t["등급"]
    dperf = np.abs(G.perf - t["perf"]) if known else np.zeros(n0)
    for step, (name, need_g, da, dk, ds) in enumerate(STEPS, 1):
        sel = base & (dage <= da) & (dkm <= dk)
        if need_g:
            sel &= same_g
        if known:
            sel &= dperf <= ds
        if sel.sum() >= MIN_COMPS:
            break
    else:
        return None
    idx = np.flatnonzero(sel)
    tx = np.array([t["age"], t["km"], t["rent"]] + [float(t.get("color") == c) for c in COLORS])
    b = G.b.copy()
    if t.get("color") is None:
        b[3:] = 0.0                                                                  # 색상을 모르면 색상 보정 안 함
    tfe = G.grade.get(t["등급"], 0.0) + G.trim.get(t["등급"], {}).get(t["세부"], 0.0)
    parts = (tx - G.x[idx]) * b                                                      # 항목별 로그 보정(차령·주행·렌트·색상)
    lin = parts[:, 0].copy()
    for j in range(1, parts.shape[1]):                                               # 사이트 JS와 같은 순서로 더한다
        lin += parts[:, j]
    lin = lin + tfe - G.fe[idx]
    tf = G.tf[idx] if o["time"] else np.ones(len(idx))
    if not o["adjust"]:
        lin, tf = np.zeros(len(idx)), np.ones(len(idx))
    p = G.price[idx] * np.exp(lin) * tf
    cond = (1 - t["dep"]) / (1 - G.dep[idx]) if known and o["adjust"] else np.ones(len(idx))
    adj = p * cond
    dist = (dage[idx] / SIM["age"] + dkm[idx] / SIM["km"] + SIM["grade"] * ~same_g[idx]
            + SIM["trim"] * ((t["세부"] != "") & (G.trims[idx] != "") & (G.trims[idx] != t["세부"]))
            + SIM["perf"] * dperf[idx] + SIM["sold"] * G.sold[idx])
    w = np.exp(-dist) if o["weight"] else np.ones(len(idx))
    la = np.log(adj)
    dev = np.abs(la - wquantile(la, w, 0.5))
    keep = np.ones(len(idx), bool)
    if o["outlier"]:
        keep = dev <= max(OUT_MAD * 1.4826 * np.median(dev), OUT_FLOOR)
        if keep.sum() < MIN_COMPS:
            keep[:] = True
    lk, wk = la[keep], w[keep]
    est, lo, hi = (float(np.exp(wquantile(lk, wk, q))) for q in (0.5, 0.25, 0.75))
    n = int(keep.sum())
    tight = hi / est - 1 <= A_WIDTH and 1 - lo / est <= A_WIDTH
    grade = "A" if n >= GOOD_COMPS and step <= 2 and tight else ("B" if step <= 4 else "C")
    r = {"est": est, "lo": lo, "hi": hi, "n": n, "out": int((~keep).sum()), "step": step, "step_name": STEPS[step - 1][0], "grade": grade}
    if not known:                                                                    # 무사고 기준 값(대상 감가율 0)
        r["est0"] = float(np.exp(wquantile(np.log(p / (1 - G.dep[idx]))[keep], wk, 0.5)))
    if detail:
        logs = {"차령": parts[:, 0], "주행": parts[:, 1], "렌트": parts[:, 2], "색상": parts[:, 3:].sum(axis=1),
                "등급": tfe - G.fe[idx], "성능": np.log(cond), "시점": np.log(tf)}
        r["보정근거"] = {k: round(est * (np.exp(np.average(v[keep], weights=wk)) - 1)) for k, v in logs.items()}
        r["coef_level"] = G.coef_level
        c = G.g.iloc[idx].assign(보정가=adj.round(0), 유사도=(w / w.max() * 100).round(0), 이상치=~keep)
        r["comps"] = c.sort_values("유사도", ascending=False)
    return r


def conversion_rate(R, est, age_years, maker=None, model=None, fuel=None, team=None):
    """환산 비율(%)과 출처 — 직접 입력 → 팀 수정(모델) → 모델 예외(기준표 + 가감) → 호가대×차령 기준표
    팀 수정(team_models: 모델별 비율, team_cells: 팀이 고친 기준표 칸)은 사이트 저장소(D6)에서 R에 합쳐 넣는다. 파일 R에는 없다"""
    if team is not None:
        return float(team), "직접 입력"
    for e in R.get("team_models") or []:
        if e["제조사"] == maker and e["모델"] == model and (not e.get("연료") or e["연료"] == fuel):
            return float(e["비율"]), "팀 수정(모델)"
    pi = next(i for i, b in enumerate(R["price_bands"]) if b["max_manwon"] is None or est <= b["max_manwon"])
    ai = next(i for i, b in enumerate(R["age_bands"]) if b["max_years"] is None or age_years <= b["max_years"])
    cells = R.get("team_cells")
    cell = cells[pi][ai] if cells and pi < len(cells) and ai < len(cells[pi]) else None
    base = R["rates"][pi][ai] if cell is None else cell
    for e in R.get("model_exceptions", []):
        if e["제조사"] == maker and e["모델"] == model and (not e.get("연료") or e["연료"] == fuel):
            return round(base + e["가감"], 1), "모델 예외"
    return float(base), "호가대×차령 기준표" if cell is None else "기준표(팀 수정)"


def estimate_car(groups, R, car, opts=None):
    """사이트 입력과 같은 형태 → 결과(비교 매물 표·보정 근거·환산가 포함)
    car: 제조사, 모델, 등급, 세부등급(선택), 등록연월(yyyymm), 주행km, 색상계열(선택), 렌트(bool),
         성능(None=상태 미상 | {"감가율": %, "등급": 1~9}), 수리비(만원, 선택), 연료·연식(환산 비율 모델 예외용, 선택),
         기준연월(yyyymm, 기본 이번 달), exclude_id(검증용)"""
    G = groups.get(f"{car['제조사']}|{car['모델']}")
    if G is None:
        return None
    ym = car.get("기준연월") or int(datetime.date.today().strftime("%Y%m"))
    age = (ym // 100) * 12 + ym % 100 - ((car["등록연월"] // 100) * 12 + car["등록연월"] % 100)
    perf = car.get("성능")
    t = {"등급": car["등급"], "세부": car.get("세부등급") or "", "age": float(age), "km": min(car["주행km"], KM_CAP) / 1e4,
         "rent": float(bool(car.get("렌트"))), "color": car.get("색상계열"), "exclude_id": car.get("exclude_id"),
         "dep": None if perf is None else perf["감가율"] / 100, "perf": None if perf is None else perf["등급"]}
    r = estimate_one(G, t, opts, detail=True)
    if r is None:
        return None
    yrs = ym // 100 - (car.get("연식") or car["등록연월"] // 100)
    rate, src = conversion_rate(R, r["est"], yrs, car["제조사"], car["모델"], car.get("연료"), car.get("팀환산"))
    fix = float(car.get("수리비") or 0)
    r.update({"수리비": fix, "시세": r["est"] - fix, "범위": (r["lo"] - fix, r["hi"] - fix),
              "환산비율": rate, "환산출처": src, "환산가": r["est"] * (1 - rate / 100) - fix})
    return r


# ───────── 검증: 판매중 매물 하나씩을 나머지로 추정 ─────────
def validate(pool, folds=5):
    """5겹: 보정 계수(D3)는 대상이 속하지 않은 4겹으로 추정하고, 비교 후보는 전체(대상 자신·같은 차는 뺌)"""
    tr = AC.load()
    tr_fold = np.array([zlib.crc32(str(i).encode()) % folds for i in tr.index])
    T = pool[~pool["sold"]]
    t_fold = np.array([zlib.crc32(str(i).encode()) % folds for i in T.index])
    main = {"기본(상태 입력)": {}, "상태 미상": {"unknown": True}}
    ablation = {"판매중만": {"sold": False}, "시점 보정 없음": {"time": False}, "유사도 가중 없음": {"weight": False},
                "이상치 제외 없음": {"outlier": False}, "보정 없음(단계 매칭만)": {"adjust": False}}
    rows = []
    for f in range(folds):
        C = coef_from_est(AC.estimate(tr[tr_fold != f]))
        groups = {k: Group(g, C) for k, g in pool.groupby("key")}
        variants = dict(main, **(ablation if f == 0 else {}))
        for k, tg in T[t_fold == f].groupby("key"):
            G = groups[k]
            for r in tg.itertuples():
                for vname, v in variants.items():
                    unknown = v.get("unknown", False)
                    t = {"등급": r.등급, "세부": r.세부, "age": r.age, "km": r.km, "rent": r.rent,
                         "color": r.색상계열 if r.색상계열 in COLORS or r.색상계열 == "흰색·진주" else None,
                         "dep": None if unknown else r.dep, "perf": None if unknown else float(r.성능등급),
                         "exclude_id": r.Index, "carkey": r.차키 if isinstance(r.차키, str) else None}
                    res = estimate_one(G, t, {kk: vv for kk, vv in v.items() if kk != "unknown"})
                    rows.append({"variant": vname, "fold": f, "id": r.Index, "actual": r.price, "origin": r.origin,
                                 **(res or {"est": np.nan, "grade": "산정 불가", "step": 0, "n": 0})})
        print(f"  {f + 1}/{folds}겹 완료 ({len(rows):,}건)", flush=True)
    return pd.DataFrame(rows)


def summarize(P):
    err = P["est"] / P["actual"] - 1
    ape = err.abs()
    ok = P["est"].notna()
    s = {"대상": len(P), "산정%": ok.mean() * 100, "오차중위%": ape.median() * 100, "편향%": err.median() * 100,
         "±5%안%": (ape <= 0.05).sum() / len(P) * 100, "±10%안%": (ape <= 0.10).sum() / len(P) * 100,
         "범위적중%": ((P["actual"] >= P["lo"]) & (P["actual"] <= P["hi"]))[ok].mean() * 100 if "lo" in P else np.nan}
    for g in ["A", "B", "C"]:
        m = P["grade"] == g
        s[f"{g}%"] = m.mean() * 100
        s[f"{g} 오차%"] = ape[m].median() * 100 if m.any() else np.nan
    s["A·B%"] = s["A%"] + s["B%"]
    return s


def report(P, secs):
    pd.set_option("display.width", 250)
    fmt = lambda df: df.round(1).to_string()
    lines = [f"시세 산정 엔진(WP1) 검증 — {datetime.datetime.now():%Y-%m-%d %H:%M} · {secs}초",
             "방법: 판매중 매물(성능점검·비교사용) 하나씩을 대상 차로 두고 나머지 매물로 그 차의 호가를 추정(5겹, 보정 계수는 다른 4겹으로)",
             "목표(기획안 WP1): 추정 오차 중위 8% 이내 · 신뢰도 A·B 80% 이상", ""]
    S = pd.DataFrame({v: summarize(g) for v, g in P.groupby("variant", sort=False)}).T
    lines += ["[방식별 — '기본'과 '상태 미상'은 전체, 나머지는 1겹(20%)]", fmt(S), ""]
    B = P[P["variant"] == "기본(상태 입력)"]
    err = (B["est"] / B["actual"] - 1).abs()
    by = lambda col: B.assign(e=err).groupby(col).agg(대수=("e", "size"), 오차중위=("e", lambda x: x.median() * 100),
                                                     구성비=("e", lambda x: len(x) / len(B) * 100))
    band = pd.cut(B["actual"], [0, 1000, 2000, 3000, 5000, 1e9], labels=["1천 미만", "1~2천", "2~3천", "3~5천", "5천 이상"])
    lines += ["[기본 — 신뢰도별]", fmt(by("grade")), "", "[기본 — 매칭 단계별]", fmt(by("step")), "",
              "[기본 — 국산·수입]", fmt(by("origin")), "", "[기본 — 호가대]", fmt(B.assign(e=err, band=band).groupby("band", observed=True)
                                                                         .agg(대수=("e", "size"), 오차중위=("e", lambda x: x.median() * 100))), ""]
    text = "\n".join(lines)
    with open(REPORT, "w", encoding="utf-8") as f:
        f.write(text + "\n")
    return text


def demo(pool, n=3):
    """판매중 매물 몇 대를 대상 차로(자기 자신은 빼고) 한 대 산정"""
    with open(os.path.join(DATA, "adj_coef.json"), encoding="utf-8") as f:
        C = coef_from_json(json.load(f))
    with open(os.path.join(DATA, "conversion_rates.json"), encoding="utf-8") as f:
        R = json.load(f)
    groups = {k: Group(g, C) for k, g in pool.groupby("key")}
    cur = pool[~pool["sold"]]
    picks = [cur[cur["모델"] == "그랜저 IG"].iloc[100], cur[cur["모델"] == "5시리즈 (G30)"].iloc[50], cur.sample(1, random_state=3).iloc[0]]
    for r in picks[:n]:
        for unknown in (False, True):
            car = {"제조사": r["제조사"], "모델": r["모델"], "등급": r["등급"], "세부등급": r["세부"], "등록연월": int(r["등록연월"]),
                   "주행km": float(r["주행km"]), "색상계열": r["색상계열"], "렌트": r["rent"] > 0, "연료": r["연료"], "연식": r["연식"],
                   "성능": None if unknown else {"감가율": r["성능감가율"], "등급": int(r["성능등급"])},
                   "수리비": 30, "기준연월": 202610, "exclude_id": r.name}
            x = estimate_car(groups, R, car)
            head = (f"{r['제조사']} {r['모델']} · {r['등급']} {r['세부']} · {int(r['등록연월'])} · {r['주행km']:,.0f}km · {r['색상계열']} · "
                    + ("상태 미상" if unknown else f"{r['사고라벨']} · 성능 {int(r['성능등급'])}등급(감가율 {r['성능감가율']:.1f}%)"))
            print(head, f"\n  실제 호가 {r['price']:,.0f}만")
            if x is None:
                print("  산정 불가(비교 매물 5대 미만)\n"); continue
            print(f"  추정 시세 {x['est']:,.0f}만 (범위 {x['lo']:,.0f}~{x['hi']:,.0f}) · 신뢰도 {x['grade']} · 비교 {x['n']}대 · {x['step_name']}"
                  + (f" · 무사고라면 {x['est0']:,.0f}만" if 'est0' in x else "")
                  + f"\n  수리비 −{x['수리비']:.0f}만 → 시세 {x['시세']:,.0f}만 · 환산가 {x['환산가']:,.0f}만 (비율 {x['환산비율']}%, {x['환산출처']})"
                  + f"\n  보정 근거(만원, 계수 {x['coef_level']}): " + " · ".join(f"{k} {v:+,}" for k, v in x["보정근거"].items() if v))
            c = x["comps"].head(5)
            for _, q in c.iterrows():
                print(f"    유사도 {q['유사도']:>3.0f} · {int(q['등록연월'])} · {q['주행km'] / 1e4:4.1f}만 · {q['색상계열']} · {q['등급']} {q['세부']} · "
                      f"성능 {int(q['성능등급'])}등급(글로비스 {q['글로비스_종합평가점']}) · 호가 {q['price']:,.0f} → 보정 {q['보정가']:,.0f}"
                      + (" · 판매" if q["sold"] else "") + (" · 이상치" if q["이상치"] else ""))
            print()


# ───────── 사이트용 파일 · 일치 검증 ─────────
def _num(v):
    """JSON 숫자: 정수 값이면 int, 결측이면 None. 실수는 그대로 둔다(사이트에서 같은 값으로 읽힌다)"""
    if v is None or v is pd.NA:
        return None
    if hasattr(v, "item"):
        v = v.item()
    if isinstance(v, float):
        if v != v:
            return None
        if v.is_integer():
            return int(v)
    return v


KEY_SKIP = re.compile(r"^(?:\d+WD|AWD|FWD|RWD|4MATIC|\d+인승|\d+\.\d+T?|\d+세대|\d+)$")


def grade_keys(grades, limit=30):
    """등급명에서 영문과 숫자가 섞인 코드(520D·530I·E300·A645 등). 구동·배기량·인승 표시는 뺀다. 많이 쓰인 순"""
    cnt = {}
    for gname, n in grades.value_counts().items():
        for tok in re.split(r"[\s/()·,+]+", str(gname).upper()):                   # 띄어쓰기 단위 낱말 중 영문+숫자
            tok = tok.strip(".-")
            if len(tok) >= 3 and re.search(r"\d", tok) and re.search(r"[A-Z]", tok) and not KEY_SKIP.match(tok):
                cnt[tok] = cnt.get(tok, 0) + int(n)
    return [k for k, _ in sorted(cnt.items(), key=lambda x: -x[1])[:limit]]


def site_groups(pool):
    """파일을 나누는 모델그룹. 비어 있으면 같은 모델의 가장 흔한 모델그룹, 그것도 없으면 모델 이름"""
    grp = pool["모델그룹"].fillna("").astype(str)
    known = pool[grp != ""].groupby(["제조사", "모델"])["모델그룹"].agg(lambda s: s.mode().iat[0])
    fill = pd.Series([known.get((a, b), b) for a, b in zip(pool["제조사"], pool["모델"])], index=pool.index)
    return grp.where(grp != "", fill)


def export(pool):
    """모델그룹별 비교 매물 파일 + index.json(선택 목록·엔진 설정). 차대번호·번호판·표준 모델명은 넣지 않는다
    파일 안 행 순서 = 비교 후보 순서(같은 세부모델끼리의 순서가 파이썬 엔진과 같아야 동률 처리가 같다).
    매물 한 대를 한 줄에 써서, 매주 커밋할 때 바뀐 매물만 차이로 쌓이게 한다"""
    os.makedirs(SITE, exist_ok=True)
    for f in glob.glob(os.path.join(SITE, "*.json")):
        os.remove(f)
    seen = pool["마지막관측일"].astype(str)
    now_date = seen.max()                                                            # 최신 크롤일(판매중 매물이 마지막으로 보인 날)
    now_ym = int(now_date[:4]) * 100 + int(now_date[5:7])
    base = pd.to_datetime(pd.Series(np.where(pool["sold"], pool["판매추정일"].astype(str), now_date), index=pool.index))
    start = base - pd.to_timedelta(pool["체류일"], unit="D")
    pool = pool.assign(grp=site_groups(pool),
                       om=np.where(pool["sold"], seen.str[:4].astype(int) * 100 + seen.str[5:7].astype(int), 0),
                       tk=np.where(pool["sold"], pool["origin"] + "|" + seen, ""),
                       ds=start.dt.strftime("%Y%m%d").where(start.notna(), ""))
    allon = pd.read_parquet(os.path.join(PREP, "listings.parquet"), columns=["상태", "제조사", "모델", "중복"])
    allon = allon[(allon["상태"] == "판매중") & ~allon["중복"].eq(True)].groupby(["제조사", "모델"]).size()   # 성능점검 없는 매물까지
    segs = {}                                                                        # 모델 요약의 차급 평균(비교 매물 기준)
    for s, g in pool.groupby("seg"):
        on, so = g[~g["sold"]], g[g["sold"]]
        dw = so["체류일"].median()
        segs[s] = {"onsale": int(len(on)), "sold": int(len(so)), "cut": round(float((on["첫가격"] > on["price"]).mean()), 4) if len(on) else None,
                   "dwell": None if dw != dw else int(round(dw))}
    labels = sorted(pool["사고라벨"].fillna("미상").unique())
    fuels = sorted(pool["연료"].fillna("기타").unique())
    colors = ["흰색·진주"] + COLORS
    ci, li, fi_ = {v: i for i, v in enumerate(colors)}, {v: i for i, v in enumerate(labels)}, {v: i for i, v in enumerate(fuels)}
    version = datetime.date.today().isoformat()
    makers, file_of, sizes = {}, {}, []
    for (mk, gname), g in pool.groupby(["제조사", "grp"], sort=True):
        fname = f"g{zlib.crc32(f'{mk}|{gname}'.encode()):08x}.json"
        models = list(dict.fromkeys(g["모델"]))
        mi = {v: i for i, v in enumerate(models)}
        gi = {v: i for i, v in enumerate(sorted(g["등급"].unique()))}
        ti = {v: i for i, v in enumerate(sorted(g["세부"].unique()))}
        rows = [[int(r.Index), mi[r.모델], gi[r.등급], ti[r.세부], int(r.등록연월), int(r.om) or None, _num(r.주행km), int(r.rent),
                 ci.get(r.색상계열, 0), _num(r.성능등급), _num(r.성능감가율), _num(r.price), int(r.sold), r.tk or None,
                 li[r.사고라벨 if isinstance(r.사고라벨, str) else "미상"], _num(r.글로비스_종합평가점), _num(r.글로비스_감점합),
                 int(r.ds) if r.ds else None, _num(r.첫가격), str(r.판매추정일) if r.sold else None,
                 fi_[r.연료 if isinstance(r.연료, str) else "기타"]] for r in g.itertuples()]
        tf = {k: float(v) for k, v in g[g["sold"]].groupby("tk")["tf"].first().items()}   # 같은 키는 같은 배수
        minfo = [{"name": m, "seg": s["seg"].mode().iat[0], "n": len(s), "onsale": int((~s["sold"]).sum()),
                  "onsale_all": int(allon.get((mk, m), 0)),
                  "y0": int((s["등록연월"] // 100).quantile(0.02)), "y1": int((s["등록연월"] // 100).quantile(0.98)),   # 등록 연도 범위
                  "gk": grade_keys(s["등급"])}                       # 등급명의 영문·숫자 코드(520d·E300 등) — 모델명 매칭용
                 for m, s in ((m, g[g["모델"] == m]) for m in models)]
        head = json.dumps({"version": version, "maker": mk, "group": gname, "now_ym": now_ym, "now_date": now_date, "tf": tf,
                           "fields": ROW_FIELDS, "models": [{k: v for k, v in m.items() if k != "gk"} for m in minfo],   # 등급 코드는 index.json에만
                           "grades": list(gi), "trims": list(ti), "colors": colors,
                           "labels": labels, "fuels": fuels}, ensure_ascii=False, separators=(",", ":"))
        body = ",\n".join(json.dumps(r, ensure_ascii=False, separators=(",", ":")) for r in rows)
        path = os.path.join(SITE, fname)
        with open(path, "w", encoding="utf-8", newline="\n") as f:
            f.write(head[:-1] + ',"rows":[\n' + body + "\n]}\n")
        sizes.append(os.path.getsize(path))
        makers.setdefault(mk, {"name": mk, "origin": g["origin"].mode().iat[0], "groups": []})["groups"].append(
            {"name": gname, "file": fname, "n": len(g), "onsale": int((~g["sold"]).sum()),
             "models": [{k: v for k, v in m.items() if k != "seg"} for m in minfo]})
        for m in models:
            file_of[(mk, m)] = fname
    index = {"version": version, "engine": ENGINE, "segments": segs,
             "makers": sorted(makers.values(), key=lambda x: -sum(g["n"] for g in x["groups"]))}
    with open(os.path.join(SITE, "index.json"), "w", encoding="utf-8", newline="\n") as f:
        json.dump(index, f, ensure_ascii=False, separators=(",", ":"))
        f.write("\n")
    sz = np.array(sizes) / 1024
    print(f"[내보내기] {SITE} — 모델그룹 파일 {len(sizes):,}개 · 합계 {sz.sum() / 1024:.1f}MB · 중위 {np.median(sz):.0f}KB · "
          f"최대 {sz.max() / 1024:.2f}MB · index.json {os.path.getsize(os.path.join(SITE, 'index.json')) / 1024:.0f}KB")
    return file_of


def parity(pool):
    """사이트 엔진(web/lib/price_engine.js)이 이 엔진과 같은 값을 내는지: 판매중 매물 전체 × (상태 입력 · 상태 미상)
    같은 입력 = 내보낸 파일 + web/data/adj_coef.json + conversion_rates.json. 다르면 종료 코드 1"""
    file_of = export(pool)
    with open(os.path.join(DATA, "adj_coef.json"), encoding="utf-8") as f:
        C = coef_from_json(json.load(f))
    with open(os.path.join(DATA, "conversion_rates.json"), encoding="utf-8") as f:
        R = json.load(f)
    groups = {k: Group(g, C) for k, g in pool.groupby("key")}
    year = datetime.date.today().year
    cases = []
    for r in pool[~pool["sold"]].itertuples():
        color = r.색상계열 if r.색상계열 in COLORS or r.색상계열 == "흰색·진주" else None
        yrs = year - int(r.연식 if r.연식 == r.연식 and r.연식 else r.등록연월 // 100)
        for unknown in (False, True):
            t = {"등급": r.등급, "세부": r.세부, "age": r.age, "km": r.km, "rent": r.rent, "color": color,
                 "dep": None if unknown else r.dep, "perf": None if unknown else float(r.성능등급), "exclude_id": r.Index}
            res = estimate_one(groups[r.key], t)
            exp = None
            if res is not None:
                exp = {k: res[k] for k in ["est", "lo", "hi", "n", "out", "step", "grade"] + (["est0"] if unknown else [])}
                exp["rate"], exp["src"] = conversion_rate(R, res["est"], yrs, r.제조사, r.모델, r.연료)
            cases.append({"f": file_of[(r.제조사, r.모델)], "m": r.모델, "id": int(r.Index), "grade": r.등급, "trim": r.세부,
                          "age": _num(r.age), "km": _num(r.주행km), "rent": int(r.rent), "color": color,
                          "dep": None if unknown else _num(r.성능감가율), "perf": None if unknown else int(r.성능등급),
                          "yrs": yrs, "maker": r.제조사, "fuel": r.연료 if isinstance(r.연료, str) else None, "exp": exp})
    cars = []                                                                        # 사이트 입력 형태(환산가·수리비 포함)
    cur = pool[~pool["sold"]]
    for r in [cur[cur["모델"] == "그랜저 IG"].iloc[100], cur[cur["모델"] == "5시리즈 (G30)"].iloc[50]] + \
             [x for _, x in cur.sample(6, random_state=11).iterrows()]:
        for unknown in (False, True):
            car = {"제조사": r["제조사"], "모델": r["모델"], "등급": r["등급"], "세부등급": r["세부"], "등록연월": int(r["등록연월"]),
                   "주행km": _num(r["주행km"]), "색상계열": r["색상계열"], "렌트": bool(r["rent"] > 0),
                   "연료": r["연료"] if isinstance(r["연료"], str) else None, "연식": _num(r["연식"]),
                   "성능": None if unknown else {"감가율": _num(r["성능감가율"]), "등급": int(r["성능등급"])},
                   "수리비": 30, "기준연월": 202610, "exclude_id": r.name}
            x = estimate_car(groups, R, car)
            exp = None if x is None else {k: x[k] for k in ["est", "lo", "hi", "n", "step", "grade", "시세", "환산가", "환산비율", "환산출처"]
                                          + (["est0"] if unknown else [])}
            cars.append({"f": file_of[(r["제조사"], r["모델"])], "car": dict(car, exclude_id=None, excludeId=int(r.name)), "exp": exp})
    with open(PARITY, "w", encoding="utf-8") as f:
        json.dump({"cases": cases, "cars": cars}, f, ensure_ascii=False, separators=(",", ":"))
    print(f"[일치 검증] 사례 {len(cases):,}건(판매중 {len(cases) // 2:,}대 × 상태 입력·미상) + 사이트 입력 {len(cars)}건 → "
          f"node {os.path.relpath(RUNNER, ROOT)}", flush=True)
    return subprocess.call(["node", RUNNER, PARITY, SITE, os.path.join(DATA, "adj_coef.json"), os.path.join(DATA, "conversion_rates.json")])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--validate", action="store_true")
    ap.add_argument("--demo", action="store_true")
    ap.add_argument("--export", action="store_true")
    ap.add_argument("--parity", action="store_true")
    a = ap.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")
    t0 = datetime.datetime.now()
    pool = load_pool()
    print(f"[엔진] 비교 후보 {len(pool):,}대 (판매중 {int((~pool['sold']).sum()):,} · 최근 판매 {int(pool['sold'].sum()):,}) · 모델 {pool['key'].nunique():,}개")
    if a.demo:
        demo(pool)
    if a.validate:
        P = validate(pool)
        P.to_parquet(os.path.join(PREP, "price_engine_validation.parquet"))
        print(report(P, (datetime.datetime.now() - t0).seconds))
    if a.export and not a.parity:
        export(pool)
    if a.parity:
        sys.exit(parity(pool))


if __name__ == "__main__":
    main()
