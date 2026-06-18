"""
엔카 크롤러 통합 실행 스크립트
================================

[사용법]

  # 전체 파이프라인 (처음 실행 or 이어서 실행)
  python run.py

  # 새 매물 반영해서 처음부터 다시 (기존 ID 캐시 무시)
  python run.py --fresh

  # 개별 단계만 실행
  python run.py --stage 1          # ID 수집만
  python run.py --stage 2          # 상세정보 수집만
  python run.py --stage 3          # 성능점검 수집만
  python run.py --stage process    # 전처리(CSV 생성)만

  # 테스트 (일부만)
  python run.py --stage 2 --limit 500

[파이프라인 설명]

  Stage 1  → 엔카 전체 매물 ID 수집          → ids_all.json
  Stage 2  → 각 차량 상세 페이지 파싱         → details.json / encar_final.csv
  Stage 3  → 성능점검기록부 API 수집          → encar_final.csv (갱신)
  Process  → 전처리 / 타입변환 / one-hot      → encar_processed.csv  ← 최종 산출물

[재실행 동작]

  - 기본(--fresh 없음): 기존에 수집된 ID/상세는 건너뛰고 미완료분만 이어서 수집
  - --fresh: Stage 1 캐시(ids_all.json)를 삭제하고 전체 ID를 새로 긁음
             → 새로 올라온 매물이 반영됨
             → Stage 2/3 체크포인트는 그대로 유지 (기존 차량은 재수집 안 함)
"""

import argparse
import subprocess
import sys
import time
from pathlib import Path

OUTPUT_DIR   = Path("encar_output")
CRAWLER_PY   = Path("crawler.py")
PROCESS_PY   = Path("process.py")

# ─────────────────────────────────────────────────────────────
#  헬퍼
# ─────────────────────────────────────────────────────────────

def run_cmd(cmd: list[str], label: str) -> bool:
    """subprocess 실행. 실패 시 False 반환."""
    sep = "=" * 55
    print(f"\n{sep}")
    print(f"  {label}")
    print(f"{sep}")
    t0 = time.time()
    result = subprocess.run(cmd, cwd=str(Path(__file__).parent))
    elapsed = time.time() - t0
    if result.returncode != 0:
        print(f"\n[오류] {label} 실패 (exit code {result.returncode})")
        return False
    print(f"\n[완료] {label}  ({elapsed/60:.1f}분 소요)")
    return True


def show_status():
    """현재 수집 상태 출력."""
    print("\n" + "=" * 55)
    print("  현재 수집 상태")
    print("=" * 55)

    def file_info(path: Path, count_lines: bool = False) -> str:
        if not path.exists():
            return "없음"
        size = path.stat().st_size
        size_str = f"{size / 1024 / 1024:.1f} MB" if size > 1024 * 1024 else f"{size / 1024:.0f} KB"
        if count_lines:
            try:
                lines = sum(1 for _ in open(path, encoding="utf-8-sig")) - 1
                return f"{lines:,}대  ({size_str})"
            except Exception:
                return size_str
        return size_str

    ids_path     = OUTPUT_DIR / "ids_all.json"
    details_path = OUTPUT_DIR / "details.json"
    final_path   = OUTPUT_DIR / "encar_final.csv"
    proc_path    = OUTPUT_DIR / "encar_processed.csv"
    done2_path   = OUTPUT_DIR / "details_done_ids.json"
    done3_path   = OUTPUT_DIR / "inspect_done_ids.json"

    import json
    def json_count(p):
        if not p.exists():
            return 0
        try:
            d = json.load(open(p, encoding="utf-8"))
            return len(d)
        except Exception:
            return 0

    ids_cnt    = json_count(ids_path)
    done2_cnt  = json_count(done2_path)
    done3_cnt  = json_count(done3_path)

    print(f"  [Stage 1] ID 수집    : {ids_cnt:>8,}대    {ids_path.name if ids_path.exists() else '파일 없음'}")
    print(f"  [Stage 2] 상세 완료  : {done2_cnt:>8,}대    {file_info(details_path)}")
    print(f"  [Stage 3] 점검 완료  : {done3_cnt:>8,}대    {file_info(final_path, count_lines=True)}")
    print(f"  [Process] 최종 CSV   :          {file_info(proc_path, count_lines=True)}")
    print()

    # 진행률
    if ids_cnt > 0:
        pct2 = done2_cnt / ids_cnt * 100
        print(f"  Stage 2 진행률: {pct2:5.1f}%  ({done2_cnt:,}/{ids_cnt:,})")
    if done2_cnt > 0:
        pct3 = done3_cnt / done2_cnt * 100
        print(f"  Stage 3 진행률: {pct3:5.1f}%  ({done3_cnt:,}/{done2_cnt:,})")
    print("=" * 55)


# ─────────────────────────────────────────────────────────────
#  메인
# ─────────────────────────────────────────────────────────────

def repair_inspect_checkpoint():
    """
    details.json에 이미 기록된 성능점검 데이터를 기반으로
    inspect_done_ids.json / inspect_results.json 체크포인트를 재동기화.

    두 번째 크롤 실행 등으로 체크포인트가 초기화됐을 때 사용.
    """
    import json

    details_path = OUTPUT_DIR / "details.json"
    done_path    = OUTPUT_DIR / "inspect_done_ids.json"
    results_path = OUTPUT_DIR / "inspect_results.json"

    if not details_path.exists():
        print("[repair] details.json 없음 → 건너뜀")
        return

    print("[repair] details.json 에서 성능점검 체크포인트 재동기화 중...")
    details = json.load(open(details_path, encoding="utf-8"))

    done_ids    = []
    inspect_map = {}

    for row in details:
        vid = str(row.get("vehicle_id", row.get("id", "")))
        if not vid:
            continue
        if row.get("inspect_crawled") in (True, "True"):
            done_ids.append(vid)
            inspect_map[vid] = {
                "vehicle_id":       vid,
                "first_reg_date":   row.get("first_reg_date", ""),
                "simple_repair":    str(row.get("simple_repair", "")),
                "outer_panel":      row.get("outer_panel", ""),
                "main_frame":       row.get("main_frame", ""),
                "detail_condition": row.get("detail_condition", ""),
                "inspector_note":   row.get("inspector_note", ""),
                "inspect_crawled":  True,
            }

    json.dump(done_ids,    open(done_path,    "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    json.dump(inspect_map, open(results_path, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    print(f"[repair] 완료: {len(done_ids):,}대 동기화 → inspect_done_ids.json / inspect_results.json")


def main():
    parser = argparse.ArgumentParser(
        description="엔카 크롤러 통합 실행",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument(
        "--stage",
        choices=["1", "2", "3", "process", "clean", "all"],
        default="all",
        help="실행할 단계 (기본: all = 1+2+3+process+clean)",
    )
    parser.add_argument(
        "--fresh",
        action="store_true",
        help="ID 캐시 삭제 후 새로 수집 (신규 매물 반영)",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="수집 대수 제한 (테스트용)",
    )
    parser.add_argument(
        "--status",
        action="store_true",
        help="현재 수집 상태만 출력하고 종료",
    )
    parser.add_argument(
        "--repair",
        action="store_true",
        help="details.json 기준으로 Stage 3 체크포인트 재동기화",
    )
    args = parser.parse_args()

    OUTPUT_DIR.mkdir(exist_ok=True)

    if args.status:
        show_status()
        return

    if args.repair:
        repair_inspect_checkpoint()
        show_status()
        return

    show_status()

    py = sys.executable  # 현재 환경의 python

    stages_to_run = {
        "all":     ["1", "2", "3", "process", "clean"],
        "1":       ["1"],
        "2":       ["2"],
        "3":       ["3"],
        "process": ["process"],
        "clean":   ["clean"],
    }[args.stage]

    ok = True
    for s in stages_to_run:
        if not ok:
            print(f"\n이전 단계 실패로 {s}단계 건너뜀")
            break

        if s == "clean":
            ok = run_cmd([py, "clean.py"], "데이터 클리닝 (clean.py)")
        elif s == "process":
            ok = run_cmd([py, str(PROCESS_PY)], "전처리 파이프라인 (process.py)")
        else:
            # Stage 3 실행 전: 체크포인트 자동 복구
            if s == "3":
                import json
                done_path = OUTPUT_DIR / "inspect_done_ids.json"
                details_path = OUTPUT_DIR / "details.json"
                if details_path.exists():
                    done_cnt  = len(json.load(open(done_path, encoding="utf-8"))) if done_path.exists() else 0
                    # details.json 기준 실제 완료 수 빠르게 체크 (메모리 효율 위해 grep 방식)
                    import subprocess as sp
                    actual_cnt = int(sp.run(
                        ["grep", "-c", '"inspect_crawled": true', str(details_path)],
                        capture_output=True, text=True
                    ).stdout.strip() or "0")
                    if actual_cnt > done_cnt * 2:  # 체크포인트가 실제보다 크게 적으면 복구
                        print(f"\n[자동 복구] 체크포인트({done_cnt:,}대) vs 실제 데이터({actual_cnt:,}대) 불일치 → 재동기화")
                        repair_inspect_checkpoint()

            cmd = [py, str(CRAWLER_PY), "--stage", s]
            if args.limit:
                cmd += ["--limit", str(args.limit)]
            if args.fresh and s == "1":
                cmd += ["--fresh"]

            labels = {
                "1": "Stage 1: 전체 매물 ID 수집",
                "2": "Stage 2: 차량 상세정보 수집",
                "3": "Stage 3: 성능점검기록부 수집",
            }
            ok = run_cmd(cmd, labels[s])

    print()
    if ok:
        show_status()
        print("[파이프라인 완료]")
        print(f"  전처리 파일: {OUTPUT_DIR / 'encar_processed.csv'}")
        print(f"  정제 파일:   {OUTPUT_DIR / 'encar_cleaned.csv'}  ← 최종 산출물")
        print(f"  제거 로그:   {OUTPUT_DIR / 'encar_removed.csv'}")
        print(f"  클리닝 리포트: {OUTPUT_DIR / 'cleaning_report.txt'}")
    else:
        print("[파이프라인 중단] 오류를 확인하고 다시 실행하세요.")
        print("  이어서 실행: python run.py")


if __name__ == "__main__":
    main()
