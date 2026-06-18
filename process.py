"""
엔카 데이터 전처리 파이프라인
==============================
입력 : encar_output/encar_final.csv
출력 : encar_output/encar_processed.csv

처리 항목:
  1. 타입 변환 (int / float / bool / date)
  2. condition_flags → 개별 boolean 컬럼 (has_inspection 등)
  3. year_month → model_year / model_month
  4. region → 지역_시도 / 지역_시군구
  5. outer_panel / main_frame 텍스트 파싱 → 손상 건수·부위 요약
  6. 파생 컬럼 (감가율, 차령, 사고여부 통합 flag)
  7. 주요 옵션 one-hot (전체 대비 출현율 ≥ 1% 옵션)
"""

import csv
import re
from pathlib import Path
from datetime import datetime
from collections import Counter

INPUT_FILE  = Path("encar_output/encar_final.csv")
OUTPUT_FILE = Path("encar_output/encar_processed.csv")

TODAY_YEAR = datetime.now().year

# ─────────────────────────────────────────────────────────────
#  기본 변환 헬퍼
# ─────────────────────────────────────────────────────────────

def to_int(v, default=None):
    try:
        s = str(v).strip().replace(",", "")
        return int(float(s)) if s not in ("", "None", "nan") else default
    except Exception:
        return default


def to_float(v, default=None):
    try:
        s = str(v).strip().replace(",", "")
        return float(s) if s not in ("", "None", "nan") else default
    except Exception:
        return default


def to_bool(v, default=None):
    if isinstance(v, bool):
        return v
    s = str(v).strip()
    if s in ("True", "true", "1", "TRUE", "Y"):
        return True
    if s in ("False", "false", "0", "FALSE", "N"):
        return False
    return default


def parse_date(v):
    """ISO/숫자 형식 날짜를 YYYY-MM-DD 문자열로 정규화."""
    if not v or str(v).strip() in ("", "None", "nan"):
        return ""
    v = str(v).strip()
    if "T" in v:
        return v.split("T")[0]
    if re.match(r"^\d{8}$", v):
        return f"{v[:4]}-{v[4:6]}-{v[6:]}"
    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})", v)
    if m:
        return f"{m.group(1)}-{m.group(2)}-{m.group(3)}"
    return v


def safe_col(name: str) -> str:
    """옵션 이름을 CSV 컬럼명에 안전한 문자열로 변환."""
    return re.sub(r"[^가-힣a-zA-Z0-9]", "_", name).strip("_")


# ─────────────────────────────────────────────────────────────
#  condition_flags 분해
# ─────────────────────────────────────────────────────────────

def parse_condition_flags(raw: str) -> dict:
    flags = {f.strip() for f in raw.split(",") if f.strip()}
    return {
        "검사기록있음":  "Inspection"  in flags,
        "성능기록있음":  "Record"      in flags,
        "이력서있음":    "Resume"      in flags,
        "위탁판매":      "Consignment" in flags,
    }


# ─────────────────────────────────────────────────────────────
#  지역 파싱 → 시도 / 시군구
# ─────────────────────────────────────────────────────────────

SIDO_LIST = [
    "서울", "경기", "인천", "부산", "대구", "경남", "경북",
    "광주", "대전", "전북", "전남", "충남", "충북",
    "울산", "강원", "제주", "세종",
]

def parse_region(raw: str):
    raw = (raw or "").strip()
    sido = sigungu = ""
    for s in SIDO_LIST:
        if raw.startswith(s):
            sido = s
            rest = raw[len(s):].strip()
            parts = rest.split()
            if parts:
                sigungu = parts[0]
            break
    return sido, sigungu


# ─────────────────────────────────────────────────────────────
#  외판 / 골격 파싱
#  형식: "부위(방향):상태 | 부위(방향):상태 | ..."
# ─────────────────────────────────────────────────────────────

def parse_damage(raw: str):
    """
    Returns
    -------
    count        : 손상 부위 수
    replaced     : 교환(교체) 부위 리스트
    repaired     : 판금/용접 부위 리스트
    other        : 그 외 이상 부위(상태 포함) 리스트
    clean_raw    : 공백 정리된 원본 텍스트
    """
    if not raw or raw.strip() == "":
        return 0, [], [], [], ""

    clean = raw.strip()
    items = [x.strip() for x in clean.split("|") if ":" in x.strip()]
    replaced, repaired, other = [], [], []

    for item in items:
        colon = item.index(":")
        part   = item[:colon].strip()
        status = item[colon + 1:].strip()
        if not part:
            continue
        if "교환" in status or "대체" in status:
            replaced.append(part)
        elif "판금" in status or "용접" in status:
            repaired.append(part)
        elif status and status not in ("이상없음", "없음", ""):
            other.append(f"{part}:{status}")

    count = len(replaced) + len(repaired) + len(other)
    return count, replaced, repaired, other, clean


# ─────────────────────────────────────────────────────────────
#  1st pass: 옵션 빈도 집계
# ─────────────────────────────────────────────────────────────

def collect_option_counts() -> Counter:
    counter: Counter = Counter()
    with open(INPUT_FILE, encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            for opt in row.get("options", "").split(","):
                opt = opt.strip()
                # "선택_XXXX" 같은 내부 코드 제외
                if opt and not opt.startswith("선택_") and not opt.startswith("기타_"):
                    counter[opt] += 1
    return counter


# ─────────────────────────────────────────────────────────────
#  메인 처리
# ─────────────────────────────────────────────────────────────

def process():
    print("=" * 55)
    print("엔카 데이터 전처리 파이프라인")
    print("=" * 55)

    # ── 옵션 빈도 분석 (1st pass)
    print("\n[1단계] 옵션 빈도 분석 중...")
    opt_counts = collect_option_counts()
    total_rows = sum(1 for _ in open(INPUT_FILE, encoding="utf-8-sig")) - 1
    min_count  = total_rows * 0.01          # 전체의 1% 이상
    top_options = sorted(
        [opt for opt, cnt in opt_counts.items() if cnt >= min_count]
    )
    print(f"  → 전체 {len(opt_counts)}개 옵션 중 {len(top_options)}개 선정"
          f" (≥ {min_count:.0f}대 등장)")

    # 옵션 → 컬럼명
    opt_col: dict[str, str] = {opt: f"옵션_{safe_col(opt)}" for opt in top_options}

    # ── 2nd pass: 데이터 처리
    print(f"\n[2단계] 데이터 처리 중 (총 {total_rows:,}대)...")
    processed = []

    with open(INPUT_FILE, encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        for i, row in enumerate(reader):
            if (i + 1) % 20_000 == 0:
                print(f"  {i + 1:,}/{total_rows:,}  ({(i+1)/total_rows*100:.1f}%)")

            # ── 텍스트 그대로 유지
            vid          = row.get("vehicle_id", "")
            category_raw = row.get("category", "")
            vin          = row.get("vin", "")
            vehicle_no   = row.get("vehicle_no", "")
            manufacturer = row.get("manufacturer", "")
            model_group  = row.get("model_group", "")
            model        = row.get("model", "")
            grade        = row.get("grade", "")
            grade_detail = row.get("grade_detail", "")
            body_type    = row.get("body_type", "")
            transmission = row.get("transmission", "")
            fuel         = row.get("fuel", "")
            color        = row.get("color", "")
            insp_format  = row.get("inspection_format", "")
            detail_cond  = row.get("detail_condition", "")
            insp_note    = row.get("inspector_note", "")

            # ── 카테고리 한글화
            cat_map = {"domestic": "국산", "eco": "친환경", "imported": "수입"}
            category = cat_map.get(category_raw, category_raw)

            # ── 수치형
            mileage     = to_int(row.get("mileage"))
            displace    = to_int(row.get("displacement"))
            seat_cnt    = to_int(row.get("seat_count"))
            orig_price  = to_float(row.get("origin_price"))
            sale_price  = to_float(row.get("sale_price"))
            seizing_cnt = to_int(row.get("seizing_count"), 0)
            pledge_cnt  = to_int(row.get("pledge_count"), 0)

            # ── bool
            domestic       = to_bool(row.get("domestic"))
            acc_record     = to_bool(row.get("accident_record_view"))
            acc_resume     = to_bool(row.get("accident_resume_view"))
            simple_repair  = to_bool(row.get("simple_repair"))
            insp_crawled   = to_bool(row.get("inspect_crawled"))

            # ── 날짜
            first_reg_date  = parse_date(row.get("first_reg_date", ""))
            encar_regist_dt = parse_date(row.get("encar_regist_dt", ""))

            # ── condition_flags 분해
            flags = parse_condition_flags(row.get("condition_flags", ""))

            # ── year_month 분해
            ym = str(row.get("year_month", "")).strip()
            model_year  = to_int(ym[:4]) if len(ym) >= 4 else None
            model_month = to_int(ym[4:6]) if len(ym) >= 6 else None

            # ── region 분해
            region_raw  = row.get("region", "")
            region_sido, region_sigungu = parse_region(region_raw)

            # ── 외판 파싱
            o_cnt, o_rep, o_rpd, o_other, o_raw = parse_damage(row.get("outer_panel", ""))
            # ── 골격 파싱
            f_cnt, f_rep, f_rpd, f_other, f_raw = parse_damage(row.get("main_frame", ""))

            # ── 파생 컬럼
            car_age = (TODAY_YEAR - model_year) if model_year else None

            if orig_price and orig_price > 0 and sale_price is not None:
                depr_pct = round((orig_price - sale_price) / orig_price * 100, 1)
            else:
                depr_pct = None

            has_accident    = bool(acc_record or acc_resume)
            has_outer_dmg   = o_cnt > 0
            has_frame_dmg   = f_cnt > 0

            # ── 옵션 파싱
            opts_raw = row.get("options", "")
            opt_set  = {o.strip() for o in opts_raw.split(",") if o.strip()}

            # ────────────────────────────────────────────────
            #  최종 row 구성
            # ────────────────────────────────────────────────
            out: dict = {
                # ── 식별
                "차량ID":          vid,
                "카테고리":        category,
                "차대번호":        vin,
                "차량번호":        vehicle_no,

                # ── 차량 기본 사양
                "제조사":          manufacturer,
                "모델그룹":        model_group,
                "모델":            model,
                "등급":            grade,
                "등급상세":        grade_detail,
                "연식_년":         model_year,
                "연식_월":         model_month,
                "출고연도":        to_int(row.get("form_year")),
                "국산여부":        domestic,
                "차종":            body_type,
                "변속기":          transmission,
                "연료":            fuel,
                "색상":            color,
                "좌석수":          seat_cnt,
                "배기량_cc":       displace,

                # ── 위치
                "지역_원본":       region_raw,
                "지역_시도":       region_sido,
                "지역_시군구":     region_sigungu,

                # ── 가격
                "출고가_만원":     orig_price,
                "판매가_만원":     sale_price,
                "감가율_pct":      depr_pct,

                # ── 주행
                "주행거리_km":     mileage,

                # ── 차령
                "차령_년":         car_age,

                # ── 사고 / 법적
                "사고이력":        acc_record,
                "이력서존재":      acc_resume,
                "사고있음":        has_accident,
                "압류_수":         seizing_cnt,
                "저당_수":         pledge_cnt,

                # ── 점검 flags
                "점검형식":        insp_format,
                **flags,           # 검사기록있음, 성능기록있음, 이력서있음, 위탁판매
                "성능점검완료":    insp_crawled,

                # ── 최초등록 / 단순수리
                "최초등록일":      first_reg_date,
                "단순수리":        simple_repair,

                # ── 외판
                "외판_손상건수":   o_cnt,
                "외판_교환부위":   " / ".join(o_rep)   if o_rep   else "",
                "외판_판금부위":   " / ".join(o_rpd)   if o_rpd   else "",
                "외판_기타손상":   " / ".join(o_other) if o_other else "",
                "외판이상있음":    has_outer_dmg,
                "외판_원본":       o_raw,

                # ── 골격
                "골격_손상건수":   f_cnt,
                "골격_교환부위":   " / ".join(f_rep)   if f_rep   else "",
                "골격_판금부위":   " / ".join(f_rpd)   if f_rpd   else "",
                "골격_기타손상":   " / ".join(f_other) if f_other else "",
                "골격이상있음":    has_frame_dmg,
                "골격_원본":       f_raw,

                # ── 세부 상태
                "세부상태":        detail_cond,
                "점검자의견":      insp_note,

                # ── 날짜
                "엔카등록일":      encar_regist_dt,

                # ── 옵션 원본 (풀텍스트)
                "옵션_전체":       opts_raw,
            }

            # 옵션 one-hot
            for opt, col in opt_col.items():
                out[col] = 1 if opt in opt_set else 0

            processed.append(out)

    # ── CSV 저장
    print(f"\n[3단계] CSV 저장 중 → {OUTPUT_FILE}")
    if not processed:
        print("처리된 데이터 없음")
        return

    fieldnames = list(processed[0].keys())
    with open(OUTPUT_FILE, "w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(processed)

    # ── 요약 통계
    print(f"\n{'='*55}")
    print(f"[완료]")
    print(f"  출력 파일 : {OUTPUT_FILE}")
    print(f"  총 레코드 : {len(processed):,}대")
    print(f"  총 컬럼수 : {len(fieldnames)}개  "
          f"(기본 {len(fieldnames) - len(opt_col)}개 + 옵션 {len(opt_col)}개)")

    sido_cnt  = Counter(r["지역_시도"] for r in processed if r["지역_시도"])
    fuel_cnt  = Counter(r["연료"]     for r in processed if r["연료"])
    cat_cnt   = Counter(r["카테고리"] for r in processed)
    acc_cnt   = sum(1 for r in processed if r["사고있음"])
    outer_cnt = sum(1 for r in processed if r["외판이상있음"])
    frame_cnt = sum(1 for r in processed if r["골격이상있음"])

    print(f"\n  [카테고리]")
    for k, v in cat_cnt.most_common():
        print(f"    {k:<8}: {v:>7,}대")

    print(f"\n  [지역 Top 8]")
    for k, v in sido_cnt.most_common(8):
        print(f"    {k:<6}: {v:>7,}대")

    print(f"\n  [연료 분포]")
    for k, v in fuel_cnt.most_common():
        print(f"    {k:<14}: {v:>7,}대")

    print(f"\n  [사고/손상 현황]")
    n = len(processed)
    print(f"    사고이력 있음 : {acc_cnt:>7,}대  ({acc_cnt/n*100:.1f}%)")
    print(f"    외판 이상     : {outer_cnt:>7,}대  ({outer_cnt/n*100:.1f}%)")
    print(f"    골격 이상     : {frame_cnt:>7,}대  ({frame_cnt/n*100:.1f}%)")
    print(f"{'='*55}")


if __name__ == "__main__":
    process()
