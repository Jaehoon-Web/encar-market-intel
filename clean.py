"""
엔카 데이터 클리닝 파이프라인
================================
입력 : encar_output/encar_processed.csv
출력 : encar_output/encar_cleaned.csv          ← 정제된 최종 산출물
      encar_output/encar_removed.csv           ← 제거된 레코드 + 제거사유
      encar_output/cleaning_report.txt         ← 클리닝 리포트

[제거/플래그 처리 항목]
  R1  필수 필드 누락      제조사·모델·연식 중 하나라도 비어 있는 경우
  R2  가격 플레이스홀더   판매가 9999 / 99999 / 9990 / 8888 등 협의용 더미값
  R3  판매가 0원          미입력 또는 가격협의(유효 데이터 없음)
  R4  판매가 극단 고가    IQR 방식으로 동일 모델 내 상위 0.5% 초과 (단, 포르쉐·람보 등 수퍼카 제외)
  R5  판매가 비정상 저가  동일 모델 내 하위 0.5% 미만 (렌트/경매 최저가 반영 제외)
  R6  연식 오입력         숫자가 아닌 연식(문자), 1980년 미만, 내년+2년 초과
  R7  주행거리 극단값     80만km 초과 (차량 수명 한계 기준)
  R8  배기량 오입력       1cc~49cc (오토바이 이하) 또는 100000cc 초과
  R9  차령 계산 오류      연식 오입력으로 인한 비정상 차령 (50년 초과)
  R10 가격역전 심각       판매가가 출고가의 3배 이상이면서 출고가>0 (수퍼카 제외)

[플래그만 추가 - 제거 안 함]
  F1  리스/렌탈 의심      영업용 번호판 (하·허·호), 위탁판매=True
  F2  단순수리 있음       단순수리 플래그
  F3  가격역전(경미)      판매가 > 출고가 (인기모델 프리미엄 등)
  F4  주행거리 고주행     50만km~80만km (삭제는 안 하지만 플래그)
  F5  차령 고령           15년 초과
"""

import csv
import re
from pathlib import Path
from datetime import datetime
from collections import defaultdict, Counter

INPUT_FILE   = Path("encar_output/encar_processed.csv")
OUTPUT_FILE  = Path("encar_output/encar_cleaned.csv")
REMOVED_FILE = Path("encar_output/encar_removed.csv")
REPORT_FILE  = Path("encar_output/cleaning_report.txt")

TODAY_YEAR   = datetime.now().year
MAX_VALID_YEAR = TODAY_YEAR + 1        # 내년까지는 허용 (선출시 차량)

# ─────────────────────────────────────────────────────────────
#  허위/플레이스홀더 가격 패턴
# ─────────────────────────────────────────────────────────────
DUMMY_PRICES = {
    0, 1, 9999, 9990, 9900, 9000, 99999, 8888, 8880, 7777, 6666, 5555
}

# ─────────────────────────────────────────────────────────────
#  수퍼카 제조사 (가격 역전·극단값 규칙 면제)
# ─────────────────────────────────────────────────────────────
SUPERCAR_BRANDS = {
    "람보르기니", "페라리", "롤스로이스", "벤틀리", "맥라렌",
    "부가티", "파가니", "코닉세그", "마이바흐",
}

# ─────────────────────────────────────────────────────────────
#  영업용 번호판 패턴 (리스/렌탈 의심)
# ─────────────────────────────────────────────────────────────
_RENTAL_PLATE = re.compile(r"\d{2,3}[하허호]\d{4}")

# ─────────────────────────────────────────────────────────────
#  헬퍼
# ─────────────────────────────────────────────────────────────

def to_float(v, default=None):
    try:
        s = str(v).strip().replace(",", "")
        return float(s) if s not in ("", "None", "nan") else default
    except Exception:
        return default

def to_int(v, default=None):
    try:
        s = str(v).strip()
        return int(float(s)) if s not in ("", "None", "nan") else default
    except Exception:
        return default

def iqr_bounds(values: list, lo_pct=0.5, hi_pct=99.5):
    """하위/상위 퍼센타일 기반 경계값 반환."""
    if len(values) < 20:
        return None, None
    sv = sorted(values)
    n  = len(sv)
    lo = sv[max(0, int(n * lo_pct / 100))]
    hi = sv[min(n - 1, int(n * hi_pct / 100))]
    return lo, hi

# ─────────────────────────────────────────────────────────────
#  1st pass: 모델별 가격 분포 수집
# ─────────────────────────────────────────────────────────────

def collect_price_bounds():
    """모델(제조사+모델) 별로 정상 판매가 범위(0.5~99.5 퍼센타일) 계산."""
    model_prices: dict[str, list] = defaultdict(list)

    with open(INPUT_FILE, encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            price = to_float(row.get("판매가_만원"))
            mfr   = row.get("제조사", "")
            model = row.get("모델", "")
            yr    = to_int(row.get("연식_년"))

            if (price is None or price in DUMMY_PRICES
                    or price <= 0 or price > 50000):
                continue
            if not mfr or not model:
                continue
            if yr is None or yr < 1980 or yr > MAX_VALID_YEAR:
                continue
            if mfr in SUPERCAR_BRANDS:
                continue

            key = f"{mfr}|{model}"
            model_prices[key].append(price)

    bounds = {}
    for key, prices in model_prices.items():
        lo, hi = iqr_bounds(prices, 0.5, 99.5)
        if lo is not None:
            bounds[key] = (lo, hi)
    return bounds

# ─────────────────────────────────────────────────────────────
#  2nd pass: 클리닝
# ─────────────────────────────────────────────────────────────

def clean(price_bounds: dict):
    removed_rows = []
    cleaned_rows = []
    removal_counter: Counter = Counter()

    with open(INPUT_FILE, encoding="utf-8-sig", newline="") as f:
        reader     = csv.DictReader(f)
        fieldnames = reader.fieldnames[:]

        # 플래그 컬럼 추가 (cleaned에만)
        flag_cols = [
            "리스렌탈의심", "가격역전_경미", "고주행_플래그", "고령차_플래그",
        ]
        cleaned_fieldnames = fieldnames + flag_cols

        # 제거된 레코드에는 제거사유 컬럼 추가
        removed_fieldnames = fieldnames + ["제거사유"]

        for row in reader:
            vid    = row.get("차량ID", "")
            mfr    = row.get("제조사", "").strip()
            model  = row.get("모델", "").strip()
            vno    = row.get("차량번호", "").strip()
            price  = to_float(row.get("판매가_만원"))
            orig   = to_float(row.get("출고가_만원"))
            km     = to_int(row.get("주행거리_km"))
            yr     = to_int(row.get("연식_년"))
            disp   = to_int(row.get("배기량_cc"))
            car_age= to_int(row.get("차령_년"))
            위탁    = row.get("위탁판매", "")

            reasons = []

            # ── R1: 필수 필드 누락
            if not mfr or not model:
                reasons.append("R1_필수필드누락(제조사/모델)")
            elif yr is None:
                reasons.append("R1_필수필드누락(연식)")

            # ── R2: 가격 플레이스홀더
            if price is not None and int(price) in DUMMY_PRICES:
                reasons.append(f"R2_허위가격플레이스홀더({int(price)}만원)")

            # ── R3: 판매가 0원
            if price is not None and price == 0:
                reasons.append("R3_판매가0원")

            # ── R6: 연식 오입력 (R1과 겹치지 않을 때)
            if "R1" not in " ".join(reasons):
                if yr is not None:
                    if yr < 1980:
                        reasons.append(f"R6_연식오입력({yr}년)")
                    elif yr > MAX_VALID_YEAR:
                        reasons.append(f"R6_연식미래({yr}년)")

            # ── R7: 주행거리 극단값
            if km is not None and km > 800_000:
                reasons.append(f"R7_주행거리극단({km:,}km)")

            # ── R8: 배기량 오입력
            fuel = row.get("연료", "")
            is_electric = "전기" in fuel and "+" not in fuel
            if disp is not None and not is_electric:
                if 0 < disp < 50:
                    reasons.append(f"R8_배기량오입력({disp}cc)")
                elif disp > 100_000:
                    reasons.append(f"R8_배기량극단({disp:,}cc)")

            # ── R9: 차령 계산 오류
            if car_age is not None and car_age > 50:
                reasons.append(f"R9_차령오류({car_age}년)")

            # ── R10: 가격역전 심각 (수퍼카 제외)
            if (price is not None and orig is not None
                    and orig > 0 and mfr not in SUPERCAR_BRANDS):
                ratio = price / orig
                if ratio >= 3.0:
                    reasons.append(f"R10_가격역전심각({ratio:.1f}배)")

            # ── R4/R5: 모델별 가격 이상치 (앞선 규칙에 안 걸렸을 때만)
            if not reasons and price is not None and price > 0 and mfr and model:
                key = f"{mfr}|{model}"
                bounds = price_bounds.get(key)
                if bounds:
                    lo, hi = bounds
                    if price < lo * 0.3:
                        reasons.append(f"R5_모델내가격저가이상({price:.0f}만원<{lo:.0f}×0.3)")
                    elif price > hi * 3.0 and mfr not in SUPERCAR_BRANDS:
                        reasons.append(f"R4_모델내가격고가이상({price:.0f}만원>{hi:.0f}×3.0)")

            # ── 제거 처리
            if reasons:
                reason_str = " | ".join(reasons)
                removed_row = dict(row)
                removed_row["제거사유"] = reason_str
                removed_rows.append(removed_row)
                for r in reasons:
                    removal_counter[r.split("_")[0]] += 1  # R1, R2... 카운트
                continue

            # ── 플래그 추가 (제거 안 된 레코드)
            cleaned_row = dict(row)

            # F1: 리스/렌탈 의심
            is_rental = bool(
                (vno and _RENTAL_PLATE.search(vno))
                or 위탁 == "True"
            )
            cleaned_row["리스렌탈의심"] = is_rental

            # F2: 가격역전(경미)
            price_reversed = (
                price is not None and orig is not None
                and orig > 0 and price > orig
                and (price / orig) < 3.0
            )
            cleaned_row["가격역전_경미"] = price_reversed

            # F4: 고주행
            cleaned_row["고주행_플래그"] = (km is not None and km >= 500_000)

            # F5: 고령차
            cleaned_row["고령차_플래그"] = (car_age is not None and car_age > 15)

            cleaned_rows.append(cleaned_row)
            cleaned_fieldnames_set = set(cleaned_fieldnames)

        return cleaned_rows, cleaned_fieldnames, removed_rows, removed_fieldnames, removal_counter

# ─────────────────────────────────────────────────────────────
#  저장 + 리포트
# ─────────────────────────────────────────────────────────────

def save_csv(rows, path, fieldnames):
    with open(path, "w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)

def generate_report(total, cleaned, removed_rows, removal_counter, price_bounds):
    removed = len(removed_rows)
    reason_detail: Counter = Counter()
    for row in removed_rows:
        for r in row.get("제거사유", "").split(" | "):
            reason_detail[r] += 1

    lines = [
        "=" * 60,
        "  엔카 데이터 클리닝 리포트",
        f"  생성일시: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
        "=" * 60,
        "",
        f"  입력 레코드 수  : {total:>8,}대",
        f"  제거 레코드 수  : {removed:>8,}대  ({removed/total*100:.1f}%)",
        f"  최종 클린 레코드: {cleaned:>8,}대  ({cleaned/total*100:.1f}%)",
        "",
        "─" * 60,
        "  제거 사유별 건수",
        "─" * 60,
    ]

    rule_labels = {
        "R1": "필수 필드 누락 (제조사/모델/연식)",
        "R2": "가격 플레이스홀더 (9999 등 더미값)",
        "R3": "판매가 0원",
        "R4": "모델내 고가 이상치",
        "R5": "모델내 저가 이상치",
        "R6": "연식 오입력 (1980년 전 or 미래연식)",
        "R7": "주행거리 극단값 (80만km 초과)",
        "R8": "배기량 오입력",
        "R9": "차령 계산 오류",
        "R10": "가격역전 심각 (판매가≥출고가×3)",
    }

    for code in sorted(rule_labels.keys()):
        cnt = removal_counter.get(code, 0)
        if cnt:
            lines.append(f"  {code:<4}  {cnt:>6,}대   {rule_labels[code]}")

    lines += [
        "",
        "─" * 60,
        "  상세 제거사유 Top 20",
        "─" * 60,
    ]
    for reason, cnt in reason_detail.most_common(20):
        lines.append(f"  {cnt:>6,}대   {reason}")

    lines += [
        "",
        "─" * 60,
        "  플래그 현황 (제거 안 됨)",
        "─" * 60,
    ]

    lines += [
        "",
        "─" * 60,
        f"  모델별 가격범위 산출 모델 수: {len(price_bounds):,}개",
        "─" * 60,
    ]

    top_models = sorted(
        [(k, v) for k, v in price_bounds.items()],
        key=lambda x: x[1][1],
        reverse=True
    )[:15]
    for key, (lo, hi) in top_models:
        mfr, mdl = key.split("|")
        lines.append(f"  {mfr} {mdl:<25} {lo:>7,.0f}만원 ~ {hi:>7,.0f}만원")

    lines += ["", "=" * 60]
    return "\n".join(lines)


# ─────────────────────────────────────────────────────────────
#  메인
# ─────────────────────────────────────────────────────────────

def main():
    print("=" * 55)
    print("  엔카 데이터 클리닝 파이프라인")
    print("=" * 55)

    # 총 레코드 수
    with open(INPUT_FILE, encoding="utf-8-sig") as f:
        total = sum(1 for _ in f) - 1
    print(f"\n입력: {INPUT_FILE.name}  ({total:,}대)")

    # 1st pass: 모델별 가격 범위
    print("\n[1단계] 모델별 정상 가격 범위 산출 중...")
    price_bounds = collect_price_bounds()
    print(f"  -> {len(price_bounds):,}개 모델 범위 산출 완료")

    # 2nd pass: 클리닝
    print("\n[2단계] 이상치 탐지 및 제거 중...")
    cleaned_rows, cleaned_fields, removed_rows, removed_fields, removal_counter = clean(price_bounds)

    # 저장
    print(f"\n[3단계] 저장 중...")
    save_csv(cleaned_rows, OUTPUT_FILE,  cleaned_fields)
    save_csv(removed_rows, REMOVED_FILE, removed_fields)

    # 플래그 현황 계산
    flag_stats = {
        "리스렌탈의심":  sum(1 for r in cleaned_rows if r.get("리스렌탈의심") in (True, "True")),
        "가격역전_경미": sum(1 for r in cleaned_rows if r.get("가격역전_경미") in (True, "True")),
        "고주행_플래그": sum(1 for r in cleaned_rows if r.get("고주행_플래그") in (True, "True")),
        "고령차_플래그": sum(1 for r in cleaned_rows if r.get("고령차_플래그") in (True, "True")),
    }

    # 리포트
    report = generate_report(total, len(cleaned_rows), removed_rows, removal_counter, price_bounds)

    # 플래그 현황 리포트에 삽입
    flag_lines = [f"  {k:<16}: {v:>7,}대  ({v/len(cleaned_rows)*100:.1f}%)"
                  for k, v in flag_stats.items()]
    report = report.replace(
        "─" * 60 + "\n" + "  모델별 가격범위",
        "\n".join(flag_lines) + "\n\n" + "─" * 60 + "\n  모델별 가격범위"
    )

    with open(REPORT_FILE, "w", encoding="utf-8") as f:
        f.write(report)
    print(report)

    print(f"\n출력 파일:")
    print(f"  정제 데이터: {OUTPUT_FILE}  ({len(cleaned_rows):,}대, {OUTPUT_FILE.stat().st_size/1024/1024:.1f}MB)")
    print(f"  제거 데이터: {REMOVED_FILE}  ({len(removed_rows):,}대)")
    print(f"  클리닝 리포트: {REPORT_FILE}")


if __name__ == "__main__":
    main()
