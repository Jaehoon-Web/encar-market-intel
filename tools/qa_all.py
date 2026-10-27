# -*- coding: utf-8 -*-
"""
qa_all.py — 새 사이트 전체 점검을 한 번에 (기획안 WP3 전체 QA)

    python tools/qa_all.py            # 전부(약 4~5분)
    python tools/qa_all.py --quick    # 오래 걸리는 일치 검증 둘(시세 엔진·성능 계산기)은 빼고

하나씩 돌리고 통과·실패와 걸린 시간을 표로 보여 준다. 하나라도 실패하면 종료 코드 1.
  사이트 정적 점검   tools/site_check.mjs        파일·데이터 모양·라이브러리를 실제 데이터로 한 번씩
  저장 API           tools/worker_check.mjs      환산 비율 저장소(worker/index.js) 26개 항목
  엑셀 작성기        tools/xlsx_writer_check.py  openpyxl 로 열어 값·서식 비교
  차명 매칭          tools/name_match_check.py   판매중 3,000대 × 표기 5가지, 합격 기준(엔카 표기 99%·확신 높음 99.5%)
  성능 계산기 일치   inspection_parity.py        판매중 성능점검 매물 전체, 17개 열 100%
  시세 엔진 일치     price_engine.py --parity    판매중 매물 × 상태 입력·미상 + 사이트 입력 — 비교 매물 파일을 다시 내보낸다(매주 파이프라인과 같음)
필요: Node.js, openpyxl, 전처리 결과(encar_output/prep/listings.parquet)
"""
import os, sys, time, subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
PY = sys.executable
CHECKS = [
    ("사이트 정적 점검", ["node", os.path.join(HERE, "site_check.mjs")], False),
    ("저장 API", ["node", os.path.join(HERE, "worker_check.mjs")], False),
    ("엑셀 작성기", [PY, os.path.join(HERE, "xlsx_writer_check.py")], False),
    ("차명 매칭", [PY, os.path.join(HERE, "name_match_check.py"), "3000"], False),
    ("성능 계산기 일치", [PY, os.path.join(ROOT, "inspection_parity.py")], True),
    ("시세 엔진 일치", [PY, os.path.join(ROOT, "price_engine.py"), "--parity"], True),
]


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    quick = "--quick" in sys.argv
    env = dict(os.environ, PYTHONIOENCODING="utf-8")
    rows = []
    for name, cmd, slow in CHECKS:
        if quick and slow:
            rows.append((name, "건너뜀", 0, ""))
            continue
        print(f"\n▶ {name}: {' '.join(os.path.relpath(c, ROOT) if os.path.isabs(c) else c for c in cmd[1:])}", flush=True)
        t0 = time.time()
        p = subprocess.run(cmd, cwd=ROOT, env=env, capture_output=True, text=True, encoding="utf-8", errors="replace")
        out = (p.stdout or "") + (p.stderr or "")
        tail = [ln for ln in out.strip().splitlines() if ln.strip()][-3:]
        print("\n".join("   " + ln for ln in tail), flush=True)
        rows.append((name, "통과" if p.returncode == 0 else "실패", time.time() - t0, tail[-1] if tail else ""))
    print("\n[전체 점검 결과]")
    for name, st, sec, last in rows:
        print(f"  {'✓' if st == '통과' else '–' if st == '건너뜀' else '✗'} {name:<12} {st:<4} {sec:6.1f}초  {last[:90]}")
    bad = [r for r in rows if r[1] == "실패"]
    print(f"\n{'실패 ' + str(len(bad)) + '건' if bad else '모두 통과'}")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
