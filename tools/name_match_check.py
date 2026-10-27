# -*- coding: utf-8 -*-
"""
name_match_check.py — 차명 매칭(web/lib/name_match.js)의 정확도를 판매중 매물로 잰다 (기획안 D5)

    python tools/name_match_check.py [표본 수=3000]        (Node.js 필요, price_engine.py --export 결과를 쓴다)

판매중 매물의 엔카 분류를 사람이 엑셀에 적을 법한 꼴로 바꿔 넣고, 원래 세부모델·등급·세부등급을 맞히는지 본다.
  A 엔카 표기 그대로        "더 뉴 그랜저 IG 2.5 캘리그래피"
  B 띄어쓰기 없이          "더뉴그랜저IG2.5캘리그래피"
  C 세대 접두어 빼기       "그랜저 IG 2.5 캘리그래피"      (연도로 세대를 가려야 함)
  D 줄여 쓰기             "그랜저IG 2.5 캘리"            (세부등급은 앞 두 글자)
  E 수입차 제조사+등급만   "BMW 520d M 스포츠"            (모델그룹 이름 없이)
"""
import os, re, sys, json, random, subprocess
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CASES = os.path.join(ROOT, "encar_output", "prep", "_name_match_cases.json")
PREFIX_RE = re.compile(r"^(디\s*올\s*뉴|더\s*올\s*뉴|올\s*뉴|더\s*뉴|신형|뉴)\s*")


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 3000
    L = pd.read_parquet(os.path.join(ROOT, "encar_output", "prep", "listings.parquet"),
                        columns=["상태", "비교사용", "점검여부", "제조사", "모델그룹", "모델", "등급", "세부등급", "국산", "등록연월"])
    L = L[(L["상태"] == "판매중") & L["비교사용"].eq(True) & L["점검여부"].eq(True) & L["등록연월"].notna()]
    S = L.sample(min(n, len(L)), random_state=7)
    cases = []
    for r in S.itertuples():
        grp, model, grade, trim = str(r.모델그룹 or ""), r.모델, str(r.등급 or ""), str(r.세부등급 or "") if isinstance(r.세부등급, str) else ""
        year = int(r.등록연월 // 100)
        exp = {"maker": r.제조사, "model": model, "grade": grade, "trim": trim}
        short_model = PREFIX_RE.sub("", model)
        variants = {"A": f"{model} {grade} {trim}", "B": f"{model}{grade}{trim}".replace(" ", ""),
                    "C": f"{short_model} {grade} {trim}",
                    "D": (short_model.replace(" ", "") + " " + grade + " " + " ".join(w[:2] for w in trim.split())).strip()}
        if r.국산 is False or r.국산 == False:
            variants["E"] = f"{r.제조사} {grade} {trim}"
        for k, text in variants.items():
            cases.append({"v": k, "text": text.strip(), "year": year, "exp": exp})
    with open(CASES, "w", encoding="utf-8") as f:
        json.dump(cases, f, ensure_ascii=False)
    print(f"[차명 매칭] 표본 {len(S):,}대 → 사례 {len(cases):,}건", flush=True)
    sys.exit(subprocess.call(["node", os.path.join(HERE, "name_match_check.js"), CASES, os.path.join(ROOT, "web", "data", "comps")]))


if __name__ == "__main__":
    main()
