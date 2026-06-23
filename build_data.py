# -*- coding: utf-8 -*-
"""
build_data.py — 엔카 크롤링 데이터를 웹 대시보드용 집계 JSON/CSV로 변환.

소스 레이어 (PLAN_웹서비스_기획안.md 3.4 참조)
  L0 (전체 재고)  : encar_output/ids_all.json        (211k, 목록 단계 = 시장 재고 모수)
  L2 (정제·시세)  : encar_output/encar_final.csv 를
                    encar_output/encar_cleaned.csv 의 clean id 집합으로 필터 (150,850대)

출력
  web/data/*.json       대시보드 집계
  web/downloads/*.csv    다운로드용 집계/요약
"""
import json, csv, math, os
from collections import Counter, defaultdict
from datetime import datetime
import pandas as pd
import numpy as np

csv.field_size_limit(10**7)

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(ROOT, "encar_output")
OUT_DATA = os.path.join(ROOT, "web", "data")
OUT_DL = os.path.join(ROOT, "web", "downloads")
os.makedirs(OUT_DATA, exist_ok=True)
os.makedirs(OUT_DL, exist_ok=True)

# 데이터 기준일(as-of)은 수집 매물의 최신 등록일을 사용 — 아래에서 동적 산출.
# (크롤 재실행일이 아니라 "시장 스냅샷이 반영하는 시점"이 신뢰성의 기준)
ASOF = "2026-04-13"   # fallback; 실제로는 max(encar_regist_dt)로 갱신됨
BUILD_YM = 2026 * 12 + 4  # 차령 계산 기준월 (as-of 기준)

# ============================================================
# 공통 정규화 헬퍼
# ============================================================
def norm_fuel(f):
    if not f or f.strip() == "":
        return "기타"
    f = f.strip()
    if "전기" in f and "+" not in f and "가솔린" not in f and "디젤" not in f and "LPG" not in f:
        return "전기"
    if "+" in f or "하이브리드" in f:
        return "하이브리드"
    if "LPG" in f:
        return "LPG"
    if "디젤" in f:
        return "디젤"
    if "가솔린" in f:
        return "가솔린"
    return "기타"

SIDO_ORDER = ["서울","경기","인천","부산","대구","광주","대전","울산","세종",
              "강원","충북","충남","전북","전남","경북","경남","제주"]

def norm_sido(r):
    if not r or str(r).strip() == "" or str(r) == "nan":
        return "기타"
    tok = str(r).strip().split()[0]
    # 풀주소 시도 표기 정규화
    mapping = {
        "서울특별시":"서울","부산광역시":"부산","대구광역시":"대구","인천광역시":"인천",
        "광주광역시":"광주","대전광역시":"대전","울산광역시":"울산","세종특별자치시":"세종",
        "경기도":"경기","강원도":"강원","강원특별자치도":"강원","충청북도":"충북","충청남도":"충남",
        "전라북도":"전북","전북특별자치도":"전북","전라남도":"전남","경상북도":"경북",
        "경상남도":"경남","제주특별자치도":"제주","제주도":"제주",
    }
    return mapping.get(tok, tok)

def year_bucket(fy):
    if fy is None or (isinstance(fy, float) and math.isnan(fy)) or fy <= 0:
        return None
    fy = int(fy)
    if fy <= 2012: return "~2012"
    if fy <= 2015: return "2013-2015"
    if fy <= 2017: return "2016-2017"
    if fy <= 2019: return "2018-2019"
    if fy <= 2021: return "2020-2021"
    if fy <= 2023: return "2022-2023"
    return "2024+"

YEAR_BUCKET_ORDER = ["~2012","2013-2015","2016-2017","2018-2019","2020-2021","2022-2023","2024+"]

def price_bucket(p):
    if p is None or (isinstance(p, float) and math.isnan(p)) or p <= 0:
        return None
    if p < 500: return "~500만"
    if p < 1000: return "500-1000만"
    if p < 2000: return "1000-2000만"
    if p < 3000: return "2000-3000만"
    if p < 5000: return "3000-5000만"
    if p < 8000: return "5000-8000만"
    return "8000만+"

PRICE_BUCKET_ORDER = ["~500만","500-1000만","1000-2000만","2000-3000만","3000-5000만","5000-8000만","8000만+"]

def mileage_bucket(m):
    if m is None or (isinstance(m, float) and math.isnan(m)) or m < 0:
        return None
    m = m / 10000.0  # km → 만km
    if m < 1: return "~1만"
    if m < 3: return "1-3만"
    if m < 6: return "3-6만"
    if m < 9: return "6-9만"
    if m < 12: return "9-12만"
    if m < 15: return "12-15만"
    return "15만+"

MILEAGE_BUCKET_ORDER = ["~1만","1-3만","3-6만","6-9만","9-12만","12-15만","15만+"]

def cat_kor(category, green):
    """국산/수입 + 친환경 플래그 분류"""
    dom = "domestic" in category
    imp = "imported" in category
    if dom: base = "국산"
    elif imp: base = "수입"
    else: base = "기타"
    return base

def to_native(o):
    if isinstance(o, (np.integer,)): return int(o)
    if isinstance(o, (np.floating,)):
        v = float(o)
        return None if math.isnan(v) else round(v, 2)
    if isinstance(o, dict): return {k: to_native(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)): return [to_native(v) for v in o]
    return o

def dump(name, obj):
    path = os.path.join(OUT_DATA, name)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(to_native(obj), f, ensure_ascii=False, separators=(",", ":"))
    print(f"  [data] {name}  ({os.path.getsize(path)/1024:.0f} KB)")

# ============================================================
# 1) clean id 집합
# ============================================================
print("[1/6] clean id 집합 로드...")
clean_ids = set()
with open(os.path.join(SRC, "encar_cleaned.csv"), encoding="utf-8-sig") as f:
    r = csv.reader(f); next(r)
    for row in r:
        if row: clean_ids.add(row[0])
print(f"      clean ids: {len(clean_ids):,}")

# ============================================================
# 2) L0 — 전체 재고 (ids_all.json)
# ============================================================
print("[2/6] L0 전체 재고 로드/집계...")
with open(os.path.join(SRC, "ids_all.json"), encoding="utf-8") as f:
    L0 = json.load(f)

# 현재 엔카에 올라와 있는 매물 id 집합 — 시세·분석은 이 '현재 매물'로만 계산(판매완료 제외)
CURRENT_IDS = set(str(x["id"]) for x in L0)

l0 = pd.DataFrame(L0)
l0["form_year"] = (pd.to_numeric(l0["year"], errors="coerce") // 100)
l0["fuel_n"] = l0["fuel_type"].map(norm_fuel)
l0["sido"] = l0["region"].map(norm_sido)
l0["cat"] = [cat_kor(c if isinstance(c, str) else "", g) for c, g in zip(l0["category"], l0["green_type"])]
l0["price"] = pd.to_numeric(l0["price"], errors="coerce")
l0["mileage"] = pd.to_numeric(l0["mileage"], errors="coerce")
l0["yb"] = l0["form_year"].map(year_bucket)
l0["pb"] = l0["price"].map(price_bucket)
l0["mb"] = l0["mileage"].map(mileage_bucket)
l0["green"] = (l0["green_type"] == "Y")
N0 = len(l0)
print(f"      L0 rows: {N0:,}")

def dim_counts(df, col, order=None, top=None, with_price=True):
    g = df.groupby(col)
    rows = []
    for key, sub in g:
        if key is None or key == "" or (isinstance(key, float) and math.isnan(key)):
            continue
        rec = {"key": str(key), "count": int(len(sub))}
        if with_price:
            pr = sub["price"].dropna()
            rec["medPrice"] = int(pr.median()) if len(pr) else None
        rows.append(rec)
    if order:
        idx = {k: i for i, k in enumerate(order)}
        rows.sort(key=lambda x: idx.get(x["key"], 999))
    else:
        rows.sort(key=lambda x: -x["count"])
    if top and not order:
        head = rows[:top]
        rest = rows[top:]
        if rest:
            head.append({"key": "기타", "count": sum(r["count"] for r in rest), "medPrice": None})
        rows = head
    return rows

inventory = {
    "total": N0,
    "byCategory": dim_counts(l0, "cat", order=["국산","수입","기타"]),
    "greenCount": int(l0["green"].sum()),
    "dims": {
        "manufacturer": dim_counts(l0, "manufacturer", top=14),
        "model": dim_counts(l0, "model", top=20),
        "fuel": dim_counts(l0, "fuel_n", order=["가솔린","디젤","하이브리드","LPG","전기","기타"]),
        "sido": dim_counts(l0, "sido", order=SIDO_ORDER),
        "yearBucket": dim_counts(l0, "yb", order=YEAR_BUCKET_ORDER),
        "priceBucket": dim_counts(l0, "pb", order=PRICE_BUCKET_ORDER),
        "mileageBucket": dim_counts(l0, "mb", order=MILEAGE_BUCKET_ORDER),
    },
}

# 교차 히트맵: 제조사(top10) × 가격대
top_makers = [r["key"] for r in inventory["dims"]["manufacturer"] if r["key"] != "기타"][:10]
cross_mp = []
for mk in top_makers:
    sub = l0[l0["manufacturer"] == mk]
    row = {"maker": mk, "cells": []}
    for pb in PRICE_BUCKET_ORDER:
        row["cells"].append(int((sub["pb"] == pb).sum()))
    cross_mp.append(row)
inventory["crossMakerPrice"] = {"cols": PRICE_BUCKET_ORDER, "rows": cross_mp}

# 교차: 지역(시도) × 연료
cross_rf = []
for sd in SIDO_ORDER:
    sub = l0[l0["sido"] == sd]
    if len(sub) == 0: continue
    row = {"sido": sd, "cells": []}
    for fu in ["가솔린","디젤","하이브리드","LPG","전기"]:
        row["cells"].append(int((sub["fuel_n"] == fu).sum()))
    cross_rf.append(row)
inventory["crossRegionFuel"] = {"cols": ["가솔린","디젤","하이브리드","LPG","전기"], "rows": cross_rf}

dump("inventory.json", inventory)

# ============================================================
# 3) L2 — 정제 시세 데이터 (encar_final ∩ clean_ids)
# ============================================================
print("[3/6] L2 정제 시세 데이터 로드/집계...")
fin = pd.read_csv(os.path.join(SRC, "encar_final.csv"), encoding="utf-8-sig",
                  dtype={"vehicle_id": str}, low_memory=False)
# 시세·분석은 '현재 매물(ids_all)에 있는' 정제 차량만 사용 (판매완료/소진 제외)
l2 = fin[fin["vehicle_id"].isin(clean_ids) & fin["vehicle_id"].isin(CURRENT_IDS)].copy()
print(f"      L2 rows: {len(l2):,}")

l2["sale_price"] = pd.to_numeric(l2["sale_price"], errors="coerce")
l2["origin_price"] = pd.to_numeric(l2["origin_price"], errors="coerce")
l2["mileage"] = pd.to_numeric(l2["mileage"], errors="coerce")
l2["form_year"] = pd.to_numeric(l2["form_year"], errors="coerce")
l2["fuel_n"] = l2["fuel"].map(norm_fuel)
l2["sido"] = l2["region"].map(norm_sido)
l2["cat"] = [cat_kor(c if isinstance(c, str) else "", None) for c in l2["category"]]
# 잔존율 (sale/origin) — raw(미클립)는 인수금 판정에 사용
l2["residual_raw"] = np.where(
    (l2["origin_price"] > 0) & (l2["sale_price"] > 0),
    l2["sale_price"] / l2["origin_price"] * 100, np.nan)
# 표시·집계용 residual은 합리 구간만 (가격역전·극단 제외)
l2["residual"] = l2["residual_raw"]
l2.loc[(l2["residual"] > 130) | (l2["residual"] < 3), "residual"] = np.nan
# 차령(개월)
ym = pd.to_numeric(l2["year_month"], errors="coerce")
fy = (ym // 100).fillna(0)
mo = (ym % 100).fillna(0)
l2["age_m"] = np.where(ym.notna(), BUILD_YM - (fy * 12 + mo), np.nan)

# ---- 데이터 기준일(as-of) = 수집 매물 최신 등록일 ----
_reg_all = pd.to_datetime(l2.get("encar_regist_dt"), errors="coerce").dropna()
ASOF = _reg_all.max().strftime("%Y-%m-%d") if len(_reg_all) else ASOF
print(f"      데이터 기준일(as-of): {ASOF}  (수집 매물 최신 등록일)")

# ---- 리스/렌탈 승계 '인수금' 및 placeholder 제외 (시세 산출 전용) ----
# 표시가격이 실제 차값이 아니라 인수금/보증금인 매물은 차령 대비 잔존율이 비정상적으로 낮음.
# 오래된 저가차(정상)는 보존하고, '신차급인데 초저가'인 경우만 정밀 타깃.
rr = l2["residual_raw"]
deposit_suspect = (
    (l2["sale_price"] < 50) |                                          # 50만원 미만(실차값 불가)
    ((rr < 25) & (l2["age_m"] <= 48)) |                               # 4년이내 잔존<25%
    ((rr < 15) & (l2["age_m"] <= 72)) |                               # 6년이내 잔존<15%
    (l2["sale_price"] >= 90000)                                        # 9억+ placeholder(99990 등)
)
N_DEPOSIT = int(deposit_suspect.sum())
l2p = l2[~deposit_suspect].copy()   # 시세/분위수/잔존율 산출용 (인수금·placeholder 제외)
print(f"      시세 산출 제외(인수금·placeholder): {N_DEPOSIT:,}건 → 시세표본 {len(l2p):,}")

valid_price = l2p["sale_price"].dropna()
valid_res = l2p["residual"].dropna()

pricing = {
    "count": int(len(l2)),
    "avgPrice": int(valid_price.mean()),
    "medPrice": int(valid_price.median()),
    "avgMileage": int(l2["mileage"].dropna().mean()),
    "avgYear": round(float(l2["form_year"].dropna().mean()), 1),
    "avgResidual": round(float(valid_res.mean()), 1),
    "medResidual": round(float(valid_res.median()), 1),
}

# 가격 분포 히스토그램 (전체)
pr = valid_price[valid_price < 12000]
bins = list(range(0, 12001, 500))
counts, edges = np.histogram(pr, bins=bins)
pricing["priceHist"] = {
    "bins": [f"{int(edges[i])//100*100}" for i in range(len(counts))],
    "labels": [f"{int(edges[i]/100)*100}~{int(edges[i+1]/100)*100}" for i in range(len(counts))],
    "edges": [int(e) for e in edges],
    "counts": [int(c) for c in counts],
}

# 제조사별 중앙 시세
mk_rows = []
for mk, sub in l2p.groupby("manufacturer"):
    p = sub["sale_price"].dropna()
    if len(p) < 30: continue
    mk_rows.append({
        "key": mk, "count": int(len(sub)),
        "medPrice": int(p.median()),
        "medResidual": round(float(sub["residual"].dropna().median()), 1) if sub["residual"].notna().any() else None,
        "avgMileage": int(sub["mileage"].dropna().mean()) if sub["mileage"].notna().any() else None,
    })
mk_rows.sort(key=lambda x: -x["count"])
pricing["byManufacturer"] = mk_rows[:20]

# 신규 유입 추이 — encar_regist_dt (최근 90일 일별, 24주 주별)
reg = pd.to_datetime(l2.get("encar_regist_dt"), errors="coerce")
reg = reg.dropna()
if len(reg):
    daily = reg.dt.date.value_counts().sort_index()
    daily = daily[-90:]
    pricing["registDaily"] = {
        "dates": [d.strftime("%m-%d") for d in daily.index],
        "counts": [int(c) for c in daily.values],
    }
    wk = reg.dt.to_period("W").value_counts().sort_index()
    wk = wk[-24:]
    pricing["registWeekly"] = {
        "weeks": [str(p.start_time.strftime("%m-%d")) for p in wk.index],
        "counts": [int(c) for c in wk.values],
    }
else:
    pricing["registDaily"] = {"dates": [], "counts": []}
    pricing["registWeekly"] = {"weeks": [], "counts": []}

dump("pricing.json", pricing)

# ============================================================
# 4) models.json — 시세조회 cascade + 분위수
# ============================================================
print("[4/6] models.json (cascade + 분위수)...")
def quantiles(series):
    s = series.dropna()
    if len(s) == 0: return None
    q = s.quantile([0.1, 0.25, 0.5, 0.75, 0.9])
    return {
        "p10": int(q.loc[0.1]), "p25": int(q.loc[0.25]), "p50": int(q.loc[0.5]),
        "p75": int(q.loc[0.75]), "p90": int(q.loc[0.9]),
        "min": int(s.min()), "max": int(s.max()),
    }

tree = {}
manuf_order = []
for mk, msub in l2p.groupby("manufacturer"):
    if len(msub) < 5: continue
    models = {}
    for md, dsub in msub.groupby("model"):
        if len(dsub) < 3: continue
        q = quantiles(dsub["sale_price"])
        if not q: continue
        node = {
            "count": int(len(dsub)),
            **q,
            "medMileage": int(dsub["mileage"].dropna().median()) if dsub["mileage"].notna().any() else None,
            "medYear": int(dsub["form_year"].dropna().median()) if dsub["form_year"].notna().any() else None,
            "avgResidual": round(float(dsub["residual"].dropna().mean()), 1) if dsub["residual"].notna().any() else None,
        }
        # 등급별
        grades = {}
        for gd, gsub in dsub.groupby("grade"):
            if len(gsub) < 3 or not isinstance(gd, str): continue
            gq = quantiles(gsub["sale_price"])
            if not gq: continue
            grades[gd] = {"count": int(len(gsub)), **gq,
                          "medMileage": int(gsub["mileage"].dropna().median()) if gsub["mileage"].notna().any() else None}
        node["grades"] = grades
        # 주행거리 밴드별 중앙가 (count>=15 모델만)
        if len(dsub) >= 15:
            mbands = []
            dsub2 = dsub.copy()
            dsub2["mb"] = dsub2["mileage"].map(mileage_bucket)
            for mb in MILEAGE_BUCKET_ORDER:
                bs = dsub2[dsub2["mb"] == mb]["sale_price"].dropna()
                if len(bs) >= 3:
                    mbands.append({"bucket": mb, "med": int(bs.median()), "count": int(len(bs))})
            node["mileageBands"] = mbands
            # 연식별 중앙가
            ybands = []
            for yb in YEAR_BUCKET_ORDER:
                ys = dsub[dsub["form_year"].map(year_bucket) == yb]["sale_price"].dropna()
                if len(ys) >= 3:
                    ybands.append({"bucket": yb, "med": int(ys.median()), "count": int(len(ys))})
            node["yearBands"] = ybands
        models[md] = node
    if not models: continue
    tree[mk] = {"count": int(len(msub)), "models": models}
    manuf_order.append((mk, len(msub)))

manuf_order.sort(key=lambda x: -x[1])
models_out = {"manufacturers": [m for m, _ in manuf_order], "tree": tree}
dump("models.json", models_out)

# ============================================================
# 5) insights.json — 감가/지역/연료/차체
# ============================================================
print("[5/6] insights.json...")
# 감가곡선: 연식별 중앙 잔존율 + 중앙가 (전체 / 국산 / 수입)
def depreciation_curve(df):
    out = []
    for fy in range(2010, 2027):
        sub = df[df["form_year"] == fy]
        res = sub["residual"].dropna()
        pr = sub["sale_price"].dropna()
        if len(pr) < 20: continue
        out.append({
            "year": fy, "count": int(len(sub)),
            "medResidual": round(float(res.median()), 1) if len(res) else None,
            "medPrice": int(pr.median()),
        })
    return out

insights = {
    "depreciation": {
        "all": depreciation_curve(l2p),
        "domestic": depreciation_curve(l2p[l2p["cat"] == "국산"]),
        "imported": depreciation_curve(l2p[l2p["cat"] == "수입"]),
    },
    # 지역별 가격/잔존율
    "region": [],
    "fuel": [],
    "bodyType": [],
}
for sd in SIDO_ORDER:
    sub = l2p[l2p["sido"] == sd]
    p = sub["sale_price"].dropna()
    if len(p) < 30: continue
    insights["region"].append({
        "key": sd, "count": int(len(sub)),
        "medPrice": int(p.median()),
        "medResidual": round(float(sub["residual"].dropna().median()), 1) if sub["residual"].notna().any() else None,
        "medMileage": int(sub["mileage"].dropna().median()) if sub["mileage"].notna().any() else None,
    })
for fu in ["가솔린","디젤","하이브리드","LPG","전기"]:
    sub = l2p[l2p["fuel_n"] == fu]
    p = sub["sale_price"].dropna()
    if len(p) < 10: continue
    insights["fuel"].append({
        "key": fu, "count": int(len(sub)),
        "share0": round(float((l0["fuel_n"] == fu).sum() / N0 * 100), 1),
        "medPrice": int(p.median()),
        "avgYear": round(float(sub["form_year"].dropna().mean()), 1),
        "medResidual": round(float(sub["residual"].dropna().median()), 1) if sub["residual"].notna().any() else None,
    })
for bt, sub in l2p.groupby("body_type"):
    if not isinstance(bt, str) or bt.strip() == "": continue
    p = sub["sale_price"].dropna()
    if len(p) < 30: continue
    insights["bodyType"].append({
        "key": bt, "count": int(len(sub)),
        "medPrice": int(p.median()),
        "medResidual": round(float(sub["residual"].dropna().median()), 1) if sub["residual"].notna().any() else None,
    })
insights["bodyType"].sort(key=lambda x: -x["count"])
dump("insights.json", insights)

# ============================================================
# 5.5) trend.json + dataset.json  (encar_cleaned.csv 기반 — 풍부한 파생 컬럼 활용)
#   · 시계열 축: 엔카등록일 (※ 별도 '크롤일' 컬럼은 데이터에 없음. 단일 스냅샷이므로
#     매물 등록월을 시간축으로 사용 — 과거월은 이미 판매되어 생존편향 있음)
#   · dataset: 클라이언트측 커스텀 시세조회용 컬럼형(dict-encode)
# ============================================================
print("[5.5/6] trend.json + dataset.json (cleaned 기반)...")
NEED = ["차량ID","제조사","모델그룹","모델","등급","등급상세","연식_년","연식_월","출고연도","차종","연료","색상",
        "차령_년","주행거리_km","판매가_만원","출고가_만원","감가율_pct","국산여부",
        "외판이상있음","골격이상있음","외판_교환부위","골격_교환부위","리스렌탈의심","엔카등록일"]
cl = pd.read_csv(os.path.join(SRC, "encar_cleaned.csv"), encoding="utf-8-sig",
                 usecols=NEED, low_memory=False)
print(f"      cleaned rows: {len(cl):,}")

# 수치 정리
for c in ["연식_년","연식_월","출고연도","차령_년","주행거리_km","판매가_만원","출고가_만원","감가율_pct"]:
    cl[c] = pd.to_numeric(cl[c], errors="coerce")
cl["연료_n"] = cl["연료"].map(norm_fuel)
# 잔존율 = 판매가/출고가 (encar_final 파이프라인과 동일 정의 — 탭 간 표본 정합성)
cl["잔존"] = np.where((cl["출고가_만원"] > 0) & (cl["판매가_만원"] > 0),
                      cl["판매가_만원"] / cl["출고가_만원"] * 100, np.nan)
cl["잔존_disp"] = np.where((cl["잔존"] >= 3) & (cl["잔존"] <= 130), cl["잔존"], np.nan)  # 표시용 합리구간
def as_bool(s):
    return s.astype(str).str.lower().isin(["true","1","1.0"])
cl["외판이상"] = as_bool(cl["외판이상있음"])
cl["골격이상"] = as_bool(cl["골격이상있음"])
cl["교환"] = cl["외판_교환부위"].notna() | cl["골격_교환부위"].notna()
cl["무사고"] = ~(cl["외판이상"] | cl["골격이상"])
cl["리스의심"] = as_bool(cl["리스렌탈의심"])
cl["국산"] = as_bool(cl["국산여부"])
# 차령(개월) — 연식년월 기반 (encar_final 파이프라인과 동일)
age_m_cl = BUILD_YM - (cl["연식_년"] * 12 + cl["연식_월"])
# 인수금/placeholder 의심 (시세 산출 제외) — encar_final 기반과 동일 기준
cl["dep"] = (
    (cl["판매가_만원"] < 50) |
    ((cl["잔존"] < 25) & (age_m_cl <= 48)) |
    ((cl["잔존"] < 15) & (age_m_cl <= 72)) |
    (cl["판매가_만원"] >= 90000)
)
reg2 = pd.to_datetime(cl["엔카등록일"], errors="coerce")
cl["_ym"] = reg2.dt.to_period("M")
clp = cl[~cl["dep"]]   # 시세표본 (인수금 제외)

# ---- trend.json : 엔카등록월 월별 시계열 (최근 24개월) ----
months_all = sorted([p for p in cl["_ym"].dropna().unique()])
recent = months_all[-24:]
tr_rows = []
for per in recent:
    m = cl[cl["_ym"] == per]
    mp = clp[clp["_ym"] == per]                     # 시세는 인수금 제외 표본
    price = mp["판매가_만원"].dropna()
    if len(m) < 30:    # 표본 적은 과거월 스킵
        continue
    fuelmix = m["연료_n"].value_counts(normalize=True) * 100
    tr_rows.append({
        "ym": str(per),
        "count": int(len(m)),
        "medPrice": int(price.median()) if len(price) else None,
        "avgResidual": round(float(mp["잔존_disp"].dropna().mean()), 1) if mp["잔존_disp"].notna().any() else None,
        "medMileage": int(m["주행거리_km"].dropna().median()) if m["주행거리_km"].notna().any() else None,
        "avgYear": round(float(m["연식_년"].dropna().mean()), 1) if m["연식_년"].notna().any() else None,
        "domesticShare": round(float(m["국산"].mean() * 100), 1),
        "fuel": {f: round(float(fuelmix.get(f, 0.0)), 1) for f in ["가솔린","디젤","하이브리드","전기","LPG"]},
    })
trend = {
    "asOf": ASOF,
    "axis": "엔카등록월",
    "note": "별도 '크롤일' 컬럼이 데이터에 없어 매물 등록월을 시간축으로 사용. 단일 스냅샷이라 과거월은 이미 판매되어 적게 남는 생존편향이 있으며, 최근 구간일수록 신규 유입에 가깝다.",
    "months": tr_rows,
}
dump("trend.json", trend)

# ---- dataset.json : 클라이언트 커스텀 시세조회용 컬럼형 (현재 매물만!) ----
# 시세조회는 '현재 엔카에 있는' 차량만 → cl을 CURRENT_IDS로 필터
cld = cl[cl["차량ID"].astype(str).isin(CURRENT_IDS)].reset_index(drop=True)
print(f"      시세조회 데이터셋: 현재 매물 {len(cld):,} (누적 {len(cl):,} 중)")

def encode(series, fill="(미상)"):
    """범주형 → (사전, 인덱스배열). 결측은 fill 토큰."""
    s = series.fillna(fill).astype(str).replace({"": fill})
    cats = pd.Categorical(s)
    return list(cats.categories), [int(x) for x in cats.codes]

dim, col = {}, {}
for short, name in [("mfr","제조사"),("mg","모델그룹"),("md","모델"),
                    ("gr","등급"),("gd","등급상세"),("cls","차종"),
                    ("fuel","연료_n"),("color","색상")]:
    cats, codes = encode(cld[name])
    dim[short] = cats
    col[short] = codes

def intcol(series, default=-1, scale=1):
    return [int(round(v/scale)) if pd.notna(v) else default for v in series]

col["yr"]   = intcol(cld["연식_년"])
col["oyr"]  = intcol(cld["출고연도"])
col["age"]  = intcol(cld["차령_년"])
col["km"]   = intcol(cld["주행거리_km"])          # km 단위
col["price"]= intcol(cld["판매가_만원"])
col["res"]  = intcol(cld["잔존_disp"])                # 잔존율(%) 합리구간만, 외 -1
col["acc"]  = [0 if v else 1 for v in cld["무사고"]]   # 0=무사고, 1=사고/이상
col["exch"] = [1 if v else 0 for v in cld["교환"]]     # 1=교환이력
col["lease"]= [1 if v else 0 for v in cld["리스의심"]]
col["dep"]  = [1 if v else 0 for v in cld["dep"]]      # 1=인수금 의심(기본 제외)

dataset = {
    "n": int(len(cld)),
    "asOf": ASOF,
    "dim": dim,
    "col": col,
    "fields": {
        "mfr":"제조사","mg":"대표모델명","md":"세부모델명","gr":"대표등급명","gd":"세부등급명",
        "cls":"차종","fuel":"연료","color":"색상","yr":"연식","oyr":"출고연도",
        "age":"차령(년)","km":"주행거리(km)","price":"판매가(만원)",
        "acc":"사고(0무사고/1사고)","exch":"교환이력","lease":"리스승계의심","dep":"인수금의심"
    },
}
dump("dataset.json", dataset)
N_DEPOSIT_CL = int(cld["dep"].sum())

# ============================================================
# 6) meta.json + 다운로드 CSV
# ============================================================
print("[6/6] meta.json + 다운로드 CSV...")
meta = {
    "collectedDate": datetime.now().strftime("%Y-%m-%d"),  # 실제 수집(크롤·빌드) 일자
    "asOf": ASOF,                       # 최신 매물 등록일 (max encar_regist_dt)
    "buildDate": datetime.now().strftime("%Y-%m-%d"),  # (하위호환) = 수집일
    "inventoryTotal": N0,
    "pricingTotal": int(len(l2)),       # L2 정제 데이터 전체
    "priceSampleTotal": int(len(l2p)),  # 시세 분위수 산출 표본(인수금·placeholder 제외)
    "depositExcluded": N_DEPOSIT,       # 시세 산출에서 제외된 인수금/placeholder 건수
    "modelCount": sum(len(v["models"]) for v in tree.values()),
    "manufacturerCount": len(tree),
    "sources": {
        "L0": {"file": "ids_all.json", "rows": N0, "desc": "엔카 전체 매물(목록 단계) = 시장 재고 모수"},
        "L2": {"file": "encar_final ∩ encar_cleaned", "rows": int(len(l2)), "desc": "더미·이상치 제거된 정제 데이터 = 시세 기준"},
    },
}
dump("meta.json", meta)

# 다운로드 CSV 1: 모델 시세 요약
rows = []
for mk, mv in tree.items():
    for md, nd in mv["models"].items():
        rows.append({
            "제조사": mk, "모델": md, "매물수": nd["count"],
            "최저(P10)": nd["p10"], "P25": nd["p25"], "중앙값(P50)": nd["p50"],
            "P75": nd["p75"], "최고(P90)": nd["p90"],
            "중앙주행km": nd["medMileage"], "중앙연식": nd["medYear"], "평균잔존율": nd["avgResidual"],
        })
pd.DataFrame(rows).sort_values("매물수", ascending=False).to_csv(
    os.path.join(OUT_DL, "model_price_summary.csv"), index=False, encoding="utf-8-sig")

# 다운로드 CSV 2: 지역 요약
pd.DataFrame(insights["region"]).rename(columns={
    "key":"시도","count":"매물수","medPrice":"중앙시세","medResidual":"중앙잔존율","medMileage":"중앙주행km"
}).to_csv(os.path.join(OUT_DL, "region_summary.csv"), index=False, encoding="utf-8-sig")

# 다운로드 CSV 3: 제조사 요약
pd.DataFrame(pricing["byManufacturer"]).rename(columns={
    "key":"제조사","count":"매물수","medPrice":"중앙시세","medResidual":"중앙잔존율","avgMileage":"평균주행km"
}).to_csv(os.path.join(OUT_DL, "manufacturer_summary.csv"), index=False, encoding="utf-8-sig")

# 다운로드 CSV 4: 컴팩트 매물 (핵심 컬럼)
# ※ Cloudflare Workers 자산 파일당 25MiB 제한 → 핵심 11개 컬럼만 유지(용량 < 25MB)
comp = l2[["vehicle_id","manufacturer","model","grade","form_year",
           "mileage","fuel","body_type","sido","sale_price","residual"]].copy()
comp["residual"] = comp["residual"].round(1)
comp.columns = ["매물ID","제조사","모델","등급","연식","주행km","연료","차체","시도","판매가","잔존율"]
comp.to_csv(os.path.join(OUT_DL, "listings_compact.csv"), index=False, encoding="utf-8-sig")

for fn in os.listdir(OUT_DL):
    print(f"  [dl] {fn}  ({os.path.getsize(os.path.join(OUT_DL, fn))/1024:.0f} KB)")

print("\n[OK] build_data 완료")
