# -*- coding: utf-8 -*-
"""
inspection_parity.py — 사이트 성능 계산기(web/lib/inspection_score.js)가 파이프라인(prep.py)과 같은 값을 내는지 검증

    python inspection_parity.py          # 판매중 · 성능점검 매물 전체 (약 9.9만 대)
    python inspection_parity.py --all    # 판매완료 포함 성능점검 매물 전체

1) web/data/inspection_model.json 이 지금 규칙·가중치와 같은지
2) 매물마다 엔카 성능점검 원문을 계산기에 넣은 결과 ↔ listings.parquet 17개 열
3) 같은 매물을 기록부식 텍스트로 바꿔 '성능 상태' 칸 읽기를 거친 결과 ↔ 같은 17개 열
4) 엑셀 표기 읽기 사례 · 계산 예시
필요: Node.js, prep.py 실행 결과(encar_output/prep/listings.parquet). 하나라도 다르면 종료 코드 1
"""
import os, sys, json, argparse, subprocess
import pandas as pd

import inspection_score as S

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(ROOT, "encar_output")
FIXTURE = os.path.join(SRC, "prep", "_parity_fixture.json")
RUNNER = os.path.join(ROOT, "tools", "inspection_parity.js")
FIELDS = ["사고단계", "사고라벨", "외판1_교환수", "외판1_판금수", "외판2_교환수", "외판2_판금수", "골격_교환수", "골격_판금수",
          "용접절단여부", "경미손상수", "손상부위", "글로비스_감점합", "글로비스_종합평가점", "글로비스_사고평가점",
          "성능감가율", "성능점검점수", "성능등급"]


def _py(v):
    """numpy·pandas 값 → JSON 값 (결측은 None)"""
    if hasattr(v, "item"):
        v = v.item()
    if v is None or (isinstance(v, float) and v != v):
        return None
    return v


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--all", action="store_true", help="판매완료 포함 성능점검 매물 전체")
    args = ap.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")

    with open(S.MODEL_PATH, encoding="utf-8") as f:
        on_disk = json.load(f)
    if on_disk != json.loads(json.dumps(S.build_model(), ensure_ascii=False)):
        print("✗ web/data/inspection_model.json 이 지금 규칙·가중치와 다릅니다 → python inspection_score.py --export")
        sys.exit(1)
    print(f"✓ 사이트 모델이 지금 규칙·가중치와 같음 (가중치 {on_disk['version']})")

    L = pd.read_parquet(os.path.join(SRC, "prep", "listings.parquet"))
    L = L[L["점검여부"].eq(True) & (L["상태"].eq("판매중") | args.all)]
    fin = (pd.read_csv(os.path.join(SRC, "encar_final.csv"), encoding="utf-8-sig", usecols=["vehicle_id", "outer_panel", "main_frame"],
                       dtype=str, low_memory=False)
           .drop_duplicates("vehicle_id").set_index("vehicle_id").reindex(L.index))
    rows = [{"id": i, "outer": _py(o), "frame": _py(fr), "simple": bool(sr == True),
             "mech": None if m != m else int(m), "exp": {k: _py(v) for k, v in zip(FIELDS, e)}}
            for i, o, fr, sr, m, e in zip(L.index, fin["outer_panel"], fin["main_frame"], L["단순수리"], L["결함단계"],
                                           L[FIELDS].itertuples(index=False, name=None))]
    with open(FIXTURE, "w", encoding="utf-8") as f:
        json.dump(rows, f, ensure_ascii=False)
    print(f"[parity] {'성능점검 매물 전체' if args.all else '판매중 · 성능점검 매물'} {len(rows):,}대")
    sys.stdout.flush()
    sys.exit(subprocess.call(["node", RUNNER, FIXTURE, S.MODEL_PATH]))


if __name__ == "__main__":
    main()
