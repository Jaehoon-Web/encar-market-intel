# -*- coding: utf-8 -*-
"""
prep.py — 시세 산정·시황 분석용 전처리 (원천 → 정규화된 매물 테이블)
명세: DATA_전처리_명세.md

입력 (encar_output/): ids_all.json, encar_final.csv, vehicle_state.json, details_done_ids.json, trend_snapshots.csv
출력 (encar_output/prep/):
  listings.parquet   매물 ID 1행(누적) — 상태·정규화 속성·사고/결함 분류·품질 플래그·비교사용 여부
  price_obs.parquet  목록(1단계) 가격·주행 관측 누적 (매물ID × 관측일) — 가격 인하·추세의 원천
  prep_report.txt    실행 요약

    python prep.py
"""
import os, sys, json, re, datetime
import numpy as np
import pandas as pd

import inspection_score as S   # 글로비스 기준 재현 + 자체 성능점검점수

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(ROOT, "encar_output")
OUT = os.path.join(SRC, "prep")

# ─────────────────────────────────────────────────────
#  사전 (명세 3장)
# ─────────────────────────────────────────────────────
# 부위 등급·사고 단계 이름은 사이트 계산기와 함께 쓰므로 inspection_score.py 에 정의
PART_RANK, RANK_LEVEL, LEVEL_NAME = S.PART_RANK, S.RANK_LEVEL, S.LEVEL_NAME

MECH_MINOR = {"미세누유", "미세누수"}
MECH_DEFECT = {"누유", "누수", "불량", "부족", "있음", "과다"}

COLOR_GROUP = {
    **{c: "흰색·진주" for c in ["흰색", "진주색", "흰색투톤", "진주투톤"]},
    **{c: "검정" for c in ["검정색", "검정투톤"]},
    **{c: "회색·은색" for c in ["쥐색", "은색", "은회색", "명은색", "은하색", "은색투톤"]},
    **{c: "청색" for c in ["청색", "하늘색", "청옥색"]},
}
FUEL_MAP = {
    "가솔린": "가솔린", "디젤": "디젤", "전기": "전기", "수소": "수소",
    "가솔린+전기": "하이브리드", "디젤+전기": "하이브리드", "LPG+전기": "하이브리드",
    "LPG(일반인 구입)": "LPG", "가솔린+LPG": "LPG",
}
SEGMENT_MAP = {
    "경차": "경차", "소형차": "소형", "준중형차": "준중형", "중형차": "중형", "대형차": "대형",
    "스포츠카": "스포츠", "SUV": "SUV", "RV": "RV", "승합차": "승합", "경승합차": "승합", "화물차": "화물",
}
SIDO = {"서울", "경기", "인천", "부산", "대구", "광주", "대전", "울산", "세종", "강원",
        "충북", "충남", "전북", "전남", "경북", "경남", "제주"}
GWANGJU_GU = {"서구", "남구", "북구", "동구", "광산구"}
DUMMY_PRICES = {0, 1, 1111, 5555, 6666, 7777, 8880, 8888, 9000, 9900, 9990, 9999, 99999}


def log(msg):
    print(msg, flush=True)


def ym_to_months(ym):
    """YYYYMM(숫자) → 연*12+월 (결측은 NaN)"""
    ym = pd.to_numeric(ym, errors="coerce")
    return (ym // 100) * 12 + (ym % 100)


def date_to_months(s):
    d = pd.to_datetime(s, format="%Y-%m-%d", errors="coerce")
    return d.dt.year * 12 + d.dt.month


# ─────────────────────────────────────────────────────
#  사고 단계 (명세 3.1)
# ─────────────────────────────────────────────────────
def classify_damage(fin):
    """outer_panel·main_frame 텍스트 → 부위 등급별 교환/판금 수, 사고 단계·라벨"""
    txt = pd.concat([fin["outer_panel"], fin["main_frame"]]).dropna()
    txt = txt[txt.str.len() > 0]
    items = txt.str.split(r" \| ").explode().dropna()
    items = items[items.str.contains(":", regex=False)]
    name = items.str.split(":", n=1).str[0].str.replace(r"\(.*?\)", "", regex=True).str.strip()
    stat = items.str.split(":", n=1).str[1].fillna("")
    rank = name.map(PART_RANK).fillna("미분류")
    kind = np.select(
        [stat.str.contains("교환"), stat.str.contains("절단"), stat.str.contains("판금|용접"),
         stat.str.contains("손상|부식|요철|흠집")],
        ["교환", "용접절단", "판금", "경미"], default="기타")
    df = pd.DataFrame({"id": items.index, "name": name.values, "rank": rank.values, "kind": kind})
    serious = df[df["kind"].isin(["교환", "용접절단", "판금"])].copy()
    serious["k2"] = np.where(serious["kind"] == "교환", "교환", "판금")   # 용접절단은 판금 쪽으로 집계
    cnt = serious[serious["rank"] != "미분류"].groupby(["id", "rank", "k2"]).size().unstack(["rank", "k2"], fill_value=0)
    cnt.columns = [f"{r}_{k}수" for r, k in cnt.columns]
    for r in ["외판1", "외판2", "골격"]:
        for k in ["교환", "판금"]:
            if f"{r}_{k}수" not in cnt.columns:
                cnt[f"{r}_{k}수"] = 0
    serious["lv"] = serious["rank"].map(RANK_LEVEL).fillna(0)
    lv = serious.groupby("id")["lv"].max().astype(int)
    top = serious.merge(lv.rename("toplv"), left_on="id", right_index=True)
    top_exch = top[(top["lv"] == top["toplv"]) & (top["k2"] == "교환")].groupby("id").size()
    weld = df[df["kind"] == "용접절단"].groupby("id").size()
    minor = df[df["kind"] == "경미"].groupby("id").size()
    parts = df[df["kind"] != "기타"].assign(t=lambda x: x["name"] + "(" + x["kind"] + ")").groupby("id")["t"].agg(" / ".join)
    unknown = df[(df["rank"] == "미분류") & df["kind"].isin(["교환", "판금", "용접절단"])]["name"].value_counts()
    out = pd.DataFrame(index=fin.index)
    out = out.join(cnt[[f"{r}_{k}수" for r in ["외판1", "외판2", "골격"] for k in ["교환", "판금"]]])
    out["_lv"] = lv
    out["_top_exch"] = top_exch
    out["용접절단여부"] = weld.reindex(out.index).fillna(0) > 0
    out["경미손상수"] = minor.reindex(out.index).fillna(0).astype(int)
    out["손상부위"] = parts.reindex(out.index)
    return out, unknown


def classify_mech(fin):
    """detail_condition → 결함 단계(0 없음 / 1 경미 / 2 결함)와 항목"""
    dc = fin["detail_condition"].dropna()
    dc = dc[(dc != "이상없음") & (dc.str.len() > 0)]
    it = dc.str.split(r" \| ").explode().dropna()
    stat = it.str.rsplit(":", n=1).str[-1].str.strip()
    lvl = np.where(stat.isin(MECH_DEFECT), 2, np.where(stat.isin(MECH_MINOR), 1, 0))
    df = pd.DataFrame({"id": it.index, "lvl": lvl, "t": it.values})
    df = df[df["lvl"] > 0]
    return df.groupby("id")["lvl"].max(), df.groupby("id")["t"].agg(" / ".join)


def norm_region(addr):
    tok = addr.fillna("").str.split()
    t0, t1 = tok.str[0].fillna(""), tok.str[1].fillna("")
    t0 = t0.replace({"부산광역시": "부산"})
    sido = np.where(t0 == "전남광주", np.where(t1.isin(GWANGJU_GU), "광주", "전남"),
                    np.where(t0.isin(SIDO), t0, "기타"))
    return pd.Series(sido, index=addr.index), t1


def plate_type(plate):
    return pd.Series(np.select(
        [plate.str.match(r"^\d{2,3}[하허호]\d{4}$"), plate.str.match(r"^\d{2,3}[바사아자]\d{4}$"),
         plate.str.match(r"^\d{2,3}[가-힣]\d{4}$")],
        ["렌트", "영업용", "일반"], default="형식불명"), index=plate.index)


def main():
    sys.stdout.reconfigure(encoding="utf-8")   # 리포트의 '—' 등이 cp949 콘솔에서 출력 오류를 내지 않도록 (2026-10-28 실패 기록)
    t0 = datetime.datetime.now()
    os.makedirs(OUT, exist_ok=True)

    # ---------- 원천 로드 ----------
    ids_path = os.path.join(SRC, "ids_all.json")
    l0 = pd.DataFrame(json.load(open(ids_path, encoding="utf-8")))
    l0["id"] = l0["id"].astype(str)
    l0 = l0.drop_duplicates("id").set_index("id")
    obs_date = datetime.date.fromtimestamp(os.path.getmtime(ids_path)).isoformat()   # 목록 관측일
    ts = pd.read_csv(os.path.join(SRC, "trend_snapshots.csv"), encoding="utf-8-sig", dtype=str)
    snap = ts["크롤일"].max()                                                          # 파이프라인 크롤일
    snap_m = int(snap[:4]) * 12 + int(snap[5:7])
    log(f"[prep] 목록 {len(l0):,}대 (관측일 {obs_date}) · 크롤일 {snap}")

    use = ["vehicle_id", "category", "condition_flags", "vin", "vehicle_no", "manufacturer", "model_group", "model",
           "grade", "grade_detail", "year_month", "form_year", "mileage", "displacement", "transmission", "fuel", "color",
           "body_type", "seat_count", "origin_price", "sale_price", "region", "seizing_count", "pledge_count",
           "inspection_format", "encar_regist_dt", "simple_repair", "outer_panel", "main_frame", "detail_condition",
           "inspect_crawled", "domestic"]
    fin = pd.read_csv(os.path.join(SRC, "encar_final.csv"), encoding="utf-8-sig", usecols=use, dtype=str, low_memory=False)
    fin = fin.drop_duplicates("vehicle_id").set_index("vehicle_id")
    st = pd.DataFrame.from_dict(json.load(open(os.path.join(SRC, "vehicle_state.json"), encoding="utf-8")), orient="index")
    log(f"[prep] 상세 누적 {len(fin):,}대 · 상태 이력 {len(st):,}대")

    # ---------- 기본 속성 ----------
    L = pd.DataFrame(index=fin.index)
    L.index.name = "매물ID"
    L["차대번호"] = fin["vin"].fillna("").str.strip()
    L["번호판"] = fin["vehicle_no"].fillna("").str.replace(" ", "", regex=False)
    L["번호판유형"] = plate_type(L["번호판"])
    L["차키"] = np.where(L["차대번호"].str.len() >= 11, "V:" + L["차대번호"],
                       np.where(L["번호판유형"] != "형식불명", "P:" + L["번호판"], None))
    L["제조사"] = fin["manufacturer"]; L["모델그룹"] = fin["model_group"]; L["모델"] = fin["model"]
    L["등급"] = fin["grade"]; L["세부등급"] = fin["grade_detail"]
    bd = l0["badge_detail"].reindex(L.index).fillna("").replace("", np.nan)
    fill = L["세부등급"].isna() & bd.notna()
    L.loc[fill, "세부등급"] = bd[fill]
    L["세부등급_보충여부"] = fill
    L["국산"] = fin["domestic"].map({"True": True, "False": False})
    L["카테고리"] = fin["category"]
    L["차종_원문"] = fin["body_type"]
    L["차급"] = fin["body_type"].map(SEGMENT_MAP).fillna("기타")
    L["등록연월"] = pd.to_numeric(fin["year_month"], errors="coerce")
    L["연식"] = pd.to_numeric(fin["form_year"], errors="coerce")
    L["연료_원문"] = fin["fuel"]
    L["연료"] = fin["fuel"].map(FUEL_MAP).fillna("기타")
    L["변속기"] = fin["transmission"]
    L["배기량"] = pd.to_numeric(fin["displacement"], errors="coerce")
    L["좌석수"] = pd.to_numeric(fin["seat_count"], errors="coerce")
    L["색상_원문"] = fin["color"]
    L["색상계열"] = np.where(fin["color"].isna(), "미상", fin["color"].map(COLOR_GROUP).fillna("기타"))
    L["시도"], L["시군구"] = norm_region(fin["region"])
    L["출고가"] = pd.to_numeric(fin["origin_price"], errors="coerce").where(lambda s: s > 0)
    L["압류수"] = pd.to_numeric(fin["seizing_count"], errors="coerce").fillna(0).astype(int)
    L["저당수"] = pd.to_numeric(fin["pledge_count"], errors="coerce").fillna(0).astype(int)
    L["separation"] = l0["separation"].reindex(L.index)
    L["condition_flags"] = fin["condition_flags"]
    L["점검형식"] = fin["inspection_format"]

    # ---------- 사고·결함 (명세 3.1, 3.2) ----------
    dmg, unknown_parts = classify_damage(fin)
    inspected = fin["inspect_crawled"].eq("True")
    L["점검여부"] = inspected
    for c in [c for c in dmg.columns if c.endswith("수") and c[:2] in ("외판", "골격")]:
        L[c] = dmg[c].fillna(0).astype(int)
    lv = dmg["_lv"].fillna(0)
    L["사고단계"] = np.where(inspected, lv, np.nan)
    top_kind = np.where(dmg["_top_exch"].fillna(0) > 0, "교환", "판금")
    L["사고라벨"] = np.where(~inspected, "미상", np.where(lv == 0, "무사고",
                         pd.Series(lv).map(LEVEL_NAME).values + "·" + top_kind))
    L["용접절단여부"] = dmg["용접절단여부"] & inspected
    L["경미손상수"] = dmg["경미손상수"]
    L["손상부위"] = dmg["손상부위"]
    mech_lv, mech_items = classify_mech(fin)
    L["결함단계"] = np.where(inspected, mech_lv.reindex(L.index).fillna(0), np.nan)
    L["결함항목"] = mech_items.reindex(L.index)
    L["단순수리"] = fin["simple_repair"].map({"True": True, "False": False})

    # ---------- 성능점검 평가 (명세 3.6, inspection_score.py) ----------
    items = S.parse_items(fin)
    glv = S.glovis_eval(items, L.index)
    for col in glv.columns:
        L[col] = glv[col].where(inspected)
    if os.path.exists(S.WEIGHTS_PATH):
        w = json.load(open(S.WEIGHTS_PATH, encoding="utf-8"))
        X = S.score_features(items, L.index, L["단순수리"], L["결함단계"])
        sc = S.apply_score(X, w)
        for col in sc.columns:
            L[col] = sc[col].where(inspected)
    else:
        log("[prep] 성능점검점수 가중치 없음 → 'python inspection_score.py --fit' 필요 (점수 컬럼 생략)")
    try:
        S.export_model()                      # 사이트 계산기용 규칙·가중치 (web/data/inspection_model.json)
    except Exception as e:
        log(f"[prep] 사이트 계산기 모델 내보내기 실패(무시): {e}")

    # ---------- 상태 (명세 4.1) ----------
    in_list = L.index.isin(l0.index)
    L["엔카등록일"] = pd.to_datetime(fin["encar_regist_dt"], errors="coerce")
    L["첫관측일"] = st["first"].reindex(L.index)
    L["마지막관측일"] = st["last"].reindex(L.index)
    L["판매추정일"] = np.where(in_list, None, st["sold"].reindex(L.index) if "sold" in st else None)
    L["상태"] = np.where(in_list, "판매중", "판매완료(추정)")
    # 재등록: 판매완료(추정)였는데 같은 차키로 이후 다른 매물이 등장
    seen = L["첫관측일"].fillna(L["엔카등록일"].dt.strftime("%Y-%m-%d"))
    key_last_seen = pd.Series(seen.values, index=L["차키"].values).groupby(level=0).max()
    later = L["차키"].map(key_last_seen)
    relist = (L["상태"] == "판매완료(추정)") & L["차키"].notna() & L["판매추정일"].notna() & (later > L["판매추정일"])
    L.loc[relist, "상태"] = "재등록"
    L["재등록여부"] = relist
    # 체류일: 기준일(판매추정일 또는 크롤일) − 엔카등록일. 판매중은 같은 차키 체인의 가장 이른 등록일부터
    base = pd.Series(pd.to_datetime(np.where(L["상태"] == "판매중", snap, L["판매추정일"]), errors="coerce"), index=L.index)
    first_reg = L.groupby("차키")["엔카등록일"].transform("min")
    start = first_reg.where((L["상태"] == "판매중") & L["차키"].notna(), L["엔카등록일"])
    L["체류일"] = (base - start).dt.days

    # ---------- 차령·주행·가격 (명세 3.3, 4.3) ----------
    base_m = np.where(L["상태"] == "판매중", snap_m, date_to_months(L["판매추정일"]))
    L["차령개월"] = base_m - ym_to_months(L["등록연월"])
    km_l0 = pd.to_numeric(l0["mileage"], errors="coerce").reindex(L.index)
    L["주행km"] = km_l0.where(in_list, np.nan).fillna(pd.to_numeric(fin["mileage"], errors="coerce"))
    yrs = (L["차령개월"] / 12).clip(lower=1)
    L["연평균주행"] = (L["주행km"] / yrs).round(0)
    L["현재가"] = pd.to_numeric(l0["price"], errors="coerce").reindex(L.index).where(in_list)
    L["첫가격"] = pd.to_numeric(fin["sale_price"], errors="coerce")
    L["마지막가"] = pd.to_numeric(st["price"], errors="coerce").reindex(L.index).where(~in_list)
    L["가격변동률"] = (L["현재가"] / L["첫가격"] - 1).round(4)
    L["잔존율"] = (L["현재가"].fillna(L["마지막가"]) / L["출고가"]).round(4)

    # ---------- 중복 (명세 4.2) ----------
    cur = L[(L["상태"] == "판매중") & L["차키"].notna()]
    order = cur.assign(_r=cur["엔카등록일"].fillna(pd.Timestamp("1900-01-01"))).sort_values(["차키", "_r"], ascending=[True, False])
    primary = order.groupby("차키").head(1)
    rep = pd.Series(primary.index, index=primary["차키"].values)
    dup_ids = order.index.difference(primary.index)
    L["중복_대표ID"] = None
    L.loc[dup_ids, "중복_대표ID"] = L.loc[dup_ids, "차키"].map(rep).values

    # ---------- 품질 플래그 (명세 5장) ----------
    price = L["현재가"].fillna(L["마지막가"])
    L["더미가"] = price.isin(DUMMY_PRICES)
    res = L["잔존율"]; age = L["차령개월"]
    L["인수금의심"] = (price < 50) | ((res < 0.25) & (age <= 48)) | ((res < 0.15) & (age <= 72)) | (price >= 90000)
    L["주행의심"] = ((L["주행km"] < 100) & (age >= 12)) | ((L["연평균주행"] > 50000) & (age >= 12)) | (L["주행km"] >= 600000)
    L["핵심결측"] = L["제조사"].isna() | L["모델"].isna() | L["등록연월"].isna()
    L["중복"] = L["중복_대표ID"].notna()
    base_ok = ~(L["더미가"] | L["인수금의심"] | L["주행의심"] | L["핵심결측"] | L["중복"]) & (price > 0)
    # 가격이상: 같은 모델·차령 12개월·주행 2만km 그룹(8대 이상)에서 로그 가격이 중앙값 ± 4.5×MAD 밖
    g = L[base_ok & (L["상태"] == "판매중")].copy()
    g["lp"] = np.log(g["현재가"])
    g["ab"] = (g["차령개월"] // 12); g["kb"] = (g["주행km"] // 20000).clip(upper=12)
    grp = g.groupby(["모델", "ab", "kb"])["lp"]
    med = grp.transform("median"); n = grp.transform("size")
    mad = (g["lp"] - med).abs().groupby([g["모델"], g["ab"], g["kb"]]).transform("median") * 1.4826
    out_ = (n >= 8) & (mad > 0) & ((g["lp"] - med).abs() > 4.5 * mad)
    L["가격이상"] = False
    L.loc[out_[out_].index, "가격이상"] = True
    cutoff = (datetime.date.fromisoformat(snap) - datetime.timedelta(days=92)).isoformat()   # 최근 3개월
    recent_sold = (L["상태"] == "판매완료(추정)") & (L["판매추정일"].fillna("").astype(str) >= cutoff)
    L["비교사용"] = base_ok & ~L["가격이상"] & ((L["상태"] == "판매중") | recent_sold)

    # ---------- 목록 잔존(상세 없음) 매물 추가 ----------
    rest = l0.index.difference(L.index)
    R = pd.DataFrame(index=rest); R.index.name = "매물ID"
    R["제조사"] = l0.loc[rest, "manufacturer"]; R["모델"] = l0.loc[rest, "model"]
    R["등급"] = l0.loc[rest, "badge"]; R["세부등급"] = l0.loc[rest, "badge_detail"].replace("", np.nan)
    R["현재가"] = pd.to_numeric(l0.loc[rest, "price"], errors="coerce")
    R["주행km"] = pd.to_numeric(l0.loc[rest, "mileage"], errors="coerce")
    R["시도"] = l0.loc[rest, "region"].replace({"전남광주": "광주·전남"})
    R["separation"] = l0.loc[rest, "separation"]
    R["상태"] = "목록 잔존(판매 추정)"
    R["비교사용"] = False
    L = pd.concat([L, R], axis=0)

    # ---------- 저장 ----------
    for c in ["판매추정일", "첫관측일", "마지막관측일"]:
        L[c] = L[c].astype("string")
    L.to_parquet(os.path.join(OUT, "listings.parquet"))
    po_path = os.path.join(OUT, "price_obs.parquet")
    po_new = pd.DataFrame({"매물ID": l0.index, "관측일": obs_date,
                           "가격": pd.to_numeric(l0["price"], errors="coerce").values,
                           "주행km": pd.to_numeric(l0["mileage"], errors="coerce").values})
    if os.path.exists(po_path):
        po = pd.read_parquet(po_path)
        po = pd.concat([po[po["관측일"] != obs_date], po_new], ignore_index=True)
    else:
        po = po_new
    po.to_parquet(po_path, index=False)

    # ---------- 리포트 ----------
    cur = L[L["상태"] == "판매중"]
    lines = [f"전처리 리포트 — 크롤일 {snap} · 목록 관측일 {obs_date} · 실행 {datetime.datetime.now():%Y-%m-%d %H:%M}",
             f"전체 {len(L):,}대 · 상태: " + ", ".join(f"{k} {v:,}" for k, v in L["상태"].value_counts().items()),
             f"판매중 {len(cur):,}대 → 비교사용 {int(cur['비교사용'].sum()):,}대 · 최근 3개월 판매완료 비교사용 {int((L['비교사용'] & (L['상태']=='판매완료(추정)')).sum()):,}대",
             "판매중 플래그: " + ", ".join(f"{c} {int(cur[c].sum()):,}" for c in ["더미가", "인수금의심", "주행의심", "핵심결측", "중복", "가격이상"]),
             "판매중 사고라벨: " + ", ".join(f"{k} {v:,}" for k, v in cur["사고라벨"].value_counts().items()),
             "판매중 결함단계: " + ", ".join(f"{k} {v:,}" for k, v in cur["결함단계"].value_counts(dropna=False).items()),
             "판매중 성능등급(자체): " + ", ".join(f"{int(k)}등급 {v:,}" for k, v in cur["성능등급"].value_counts().sort_index(ascending=False).items()) if "성능등급" in cur else "성능등급 없음",
             "판매중 글로비스 종합평가점: " + ", ".join(f"{int(k)}점 {v:,}" for k, v in cur["글로비스_종합평가점"].value_counts().sort_index(ascending=False).items())
             + " · 사고평가점: " + ", ".join(f"{k} {v:,}" for k, v in cur["글로비스_사고평가점"].value_counts().sort_index().items()),
             "판매중 색상계열: " + ", ".join(f"{k} {v:,}" for k, v in cur["색상계열"].value_counts().items()),
             "판매중 번호판유형: " + ", ".join(f"{k} {v:,}" for k, v in cur["번호판유형"].value_counts().items()),
             f"세부등급 채움 {cur['세부등급'].notna().mean()*100:.1f}% (목록 값으로 보충 {int(cur['세부등급_보충여부'].sum()):,}) · 차령 채움 {cur['차령개월'].notna().mean()*100:.1f}%",
             f"재등록 정정 {int(L['재등록여부'].eq(True).sum()):,}대 · price_obs 누적 {len(po):,}행 ({po['관측일'].nunique()}회)",
             "미분류 부위(사고 단계 미반영): " + (", ".join(f"{k} {v}" for k, v in unknown_parts.head(10).items()) or "없음"),
             f"소요 {(datetime.datetime.now() - t0).seconds}초"]
    open(os.path.join(OUT, "prep_report.txt"), "w", encoding="utf-8").write("\n".join(lines) + "\n")
    for l in lines:
        log("[prep] " + l)


if __name__ == "__main__":
    main()
