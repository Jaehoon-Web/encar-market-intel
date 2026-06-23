# -*- coding: utf-8 -*-
"""
append_history.py — 매 크롤마다 '그 시점 스냅샷'을 이력으로 누적.

생성/갱신 파일 (encar_output/):
  vehicle_state.json   차량별 상태 {차량ID: {first, last, price, status}}  (SCD 추적용)
  history.csv          차량별 변경 이력 로그 (신규/가격변동/판매완료 시 행 추가)
                       컬럼: 차량ID,크롤일,제조사,모델,등급,연식,주행,판매가,연료,상태
  trend_snapshots.csv  크롤일별 시장 집계 1행 (트렌드 대시보드용)
                       컬럼: 크롤일,재고수,상세수,평균가,중앙가,신규유입,판매소진,
                             평균체류일,평균연식,중앙주행,가솔린%,디젤%,하이브리드%,전기%,LPG%

원칙
  - 시세/분석은 '현재 매물'(ids_all)만 → build_data가 담당
  - 이력/트렌드/누적다운로드는 여기서 누적
  - 같은 차의 주간 가격 변동 추적, 사라지면 '판매완료' 태깅(더는 시세에 안 들어감)
"""
import os, sys, json, csv, datetime, argparse
import pandas as pd
import numpy as np

csv.field_size_limit(10**7)
ROOT = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(ROOT, "encar_output")
STATE = os.path.join(OUT, "vehicle_state.json")
HIST = os.path.join(OUT, "history.csv")
TREND = os.path.join(OUT, "trend_snapshots.csv")
CLEANED = os.path.join(OUT, "encar_cleaned.csv")
IDS_ALL = os.path.join(OUT, "ids_all.json")

HIST_COLS = ["차량ID","크롤일","제조사","모델","등급","연식","주행","판매가","연료","상태"]
TREND_COLS = ["크롤일","재고수","상세수","평균가","중앙가","신규유입","판매소진",
              "평균체류일","평균연식","중앙주행","가솔린%","디젤%","하이브리드%","전기%","LPG%"]

def norm_fuel(f):
    f = "" if f is None else str(f).strip()
    if not f: return "기타"
    if "전기" in f and "+" not in f and "가솔린" not in f and "디젤" not in f and "LPG" not in f: return "전기"
    if "+" in f or "하이브리드" in f: return "하이브리드"
    if "LPG" in f: return "LPG"
    if "디젤" in f: return "디젤"
    if "가솔린" in f: return "가솔린"
    return "기타"

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", help="크롤일 YYYY-MM-DD (기본: 오늘)")
    args = ap.parse_args()
    crawl_date = args.date or datetime.datetime.now().strftime("%Y-%m-%d")
    print(f"[history] 크롤일: {crawl_date}")

    # 현재 매물 id
    current_ids = set(str(x["id"]) for x in json.load(open(IDS_ALL, encoding="utf-8")))
    # 현재 정제 데이터 → 현재 매물만
    use = ["차량ID","제조사","모델","등급","연식_년","주행거리_km","판매가_만원","연료"]
    df = pd.read_csv(CLEANED, encoding="utf-8-sig", usecols=use, dtype={"차량ID": str}, low_memory=False)
    df = df[df["차량ID"].isin(current_ids)].copy()
    for c in ["연식_년","주행거리_km","판매가_만원"]:
        df[c] = pd.to_numeric(df[c], errors="coerce")
    df["연료_n"] = df["연료"].map(norm_fuel)
    print(f"[history] 현재 매물 상세: {len(df):,}")

    # 기존 상태 로드
    state = {}
    if os.path.exists(STATE):
        state = json.load(open(STATE, encoding="utf-8"))
    # 이미 이 크롤일 처리했으면 중복 방지
    if os.path.exists(TREND):
        done_dates = set(pd.read_csv(TREND, encoding="utf-8-sig", usecols=["크롤일"], dtype=str)["크롤일"])
        if crawl_date in done_dates:
            print(f"[history] {crawl_date} 이미 처리됨 → 건너뜀")
            return

    new_rows = []          # history.csv 에 추가할 행
    new_cnt = 0
    cur_set = set(df["차량ID"])

    # 1) 현재 매물: 신규 / 가격변동 기록
    for r in df.itertuples(index=False):
        vid = r.차량ID
        price = None if pd.isna(r.판매가_만원) else int(r.판매가_만원)
        rec = state.get(vid)
        base = [vid, crawl_date, r.제조사, r.모델, r.등급,
                (None if pd.isna(r.연식_년) else int(r.연식_년)),
                (None if pd.isna(r.주행거리_km) else int(r.주행거리_km)),
                price, r.연료, "판매중"]
        if rec is None:
            new_rows.append(base); new_cnt += 1
            state[vid] = {"first": crawl_date, "last": crawl_date, "price": price, "status": "판매중"}
        else:
            changed = (rec.get("price") != price) or (rec.get("status") != "판매중")
            rec["last"] = crawl_date; rec["status"] = "판매중"
            if changed:
                new_rows.append(base); rec["price"] = price

    # 2) 직전까지 판매중이었는데 이번에 사라진 차 → 판매완료
    sold_cnt = 0; dwell_list = []
    for vid, rec in state.items():
        if rec.get("status") == "판매중" and vid not in cur_set:
            rec["status"] = "판매완료"; rec["sold"] = crawl_date
            sold_cnt += 1
            try:
                d0 = datetime.date.fromisoformat(rec.get("first", crawl_date))
                d1 = datetime.date.fromisoformat(crawl_date)
                dwell_list.append((d1 - d0).days)
            except Exception:
                pass
            new_rows.append([vid, crawl_date, "", "", "", None, None,
                             rec.get("price"), "", "판매완료"])

    # 3) history.csv append (utf-8-sig 내부 저장)
    write_header = not os.path.exists(HIST)
    with open(HIST, "a", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        if write_header: w.writerow(HIST_COLS)
        w.writerows(new_rows)

    # 4) trend_snapshots.csv append (집계 1행)
    price = df["판매가_만원"].dropna()
    fmix = df["연료_n"].value_counts(normalize=True) * 100
    snap = {
        "크롤일": crawl_date,
        "재고수": len(current_ids),
        "상세수": len(df),
        "평균가": int(price.mean()) if len(price) else "",
        "중앙가": int(price.median()) if len(price) else "",
        "신규유입": new_cnt,
        "판매소진": sold_cnt,
        "평균체류일": round(sum(dwell_list)/len(dwell_list), 1) if dwell_list else "",
        "평균연식": round(float(df["연식_년"].dropna().mean()), 1) if df["연식_년"].notna().any() else "",
        "중앙주행": int(df["주행거리_km"].dropna().median()) if df["주행거리_km"].notna().any() else "",
        "가솔린%": round(float(fmix.get("가솔린", 0)), 1),
        "디젤%": round(float(fmix.get("디젤", 0)), 1),
        "하이브리드%": round(float(fmix.get("하이브리드", 0)), 1),
        "전기%": round(float(fmix.get("전기", 0)), 1),
        "LPG%": round(float(fmix.get("LPG", 0)), 1),
    }
    write_header = not os.path.exists(TREND)
    with open(TREND, "a", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=TREND_COLS)
        if write_header: w.writeheader()
        w.writerow(snap)

    # 5) 상태 저장
    json.dump(state, open(STATE, "w", encoding="utf-8"), ensure_ascii=False)

    print(f"[history] 신규 {new_cnt:,} · 가격변동포함 기록 {len(new_rows):,}행 · 판매완료 {sold_cnt:,}")
    print(f"[history] 누적 상태 차량 {len(state):,} · 스냅샷 추가 완료 ({crawl_date})")

if __name__ == "__main__":
    main()
