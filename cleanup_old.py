# -*- coding: utf-8 -*-
"""
cleanup_old.py — 디렉토리 정리(불필요 파일 삭제). **크롤링이 끝난 뒤 실행**할 것.

삭제 대상 (재생성 가능/오래된 것만):
  - 오래된 실행 로그: run_2026*.log, stage1_stdout.log, stage2_*.log, stage3_*.log
  - __pycache__/  (파이썬 바이트코드 캐시)
  - 엔카_크롤러.zip  (git으로 대체된 백업)

안전장치:
  - 최근 12시간 내 수정된 파일은 건드리지 않음(활성 파일 보호)
  - 기본은 미리보기(dry-run). 실제 삭제하려면  python cleanup_old.py --apply

※ 지역별 ID 캐시(ids_국산_*.json 등 ~480MB)는 주간 자동갱신(auto_update.py)이
   매 실행마다 알아서 삭제·재생성하므로 여기서 다루지 않음.
"""
import os, glob, time, sys, argparse

ROOT = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(ROOT, "encar_output")
RECENT_GUARD_H = 12

TARGETS = [
    os.path.join(OUT, "run_2026*.log"),
    os.path.join(OUT, "stage1_stdout.log"),
    os.path.join(OUT, "stage2_full.log"),
    os.path.join(OUT, "stage2_test.log"),
    os.path.join(OUT, "stage3_full.log"),
    os.path.join(ROOT, "엔카_크롤러.zip"),
]
DIRS = [os.path.join(ROOT, "__pycache__")]

def human(n):
    for u in ["B", "KB", "MB", "GB"]:
        if n < 1024: return "%.1f%s" % (n, u)
        n /= 1024
    return "%.1fTB" % n

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="실제 삭제(미지정 시 미리보기)")
    args = ap.parse_args()

    now = time.time()
    files = []
    for pat in TARGETS:
        files.extend(glob.glob(pat))
    # run_resume_* (현재 세션 디버그 로그)는 보존
    files = [f for f in files if "run_resume_" not in os.path.basename(f)]

    total = 0
    print("=== 정리 대상 ===")
    for f in files:
        try:
            age_h = (now - os.path.getmtime(f)) / 3600
            sz = os.path.getsize(f)
        except OSError:
            continue
        if age_h < RECENT_GUARD_H:
            print("  [건너뜀:최근수정] %s (%s, %.1fh)" % (os.path.basename(f), human(sz), age_h))
            continue
        total += sz
        print("  %s (%s)" % (f, human(sz)))
        if args.apply:
            try: os.remove(f)
            except OSError as e: print("    삭제실패:", e)

    for d in DIRS:
        if os.path.isdir(d):
            sz = sum(os.path.getsize(os.path.join(dp, fn))
                     for dp, _, fns in os.walk(d) for fn in fns)
            total += sz
            print("  %s/ (%s)" % (d, human(sz)))
            if args.apply:
                import shutil
                try: shutil.rmtree(d)
                except OSError as e: print("    삭제실패:", e)

    print("---")
    print("회수 가능 용량: %s" % human(total))
    if not args.apply:
        print("\n※ 미리보기입니다. 실제 삭제하려면:  python cleanup_old.py --apply")
    else:
        print("\n✔ 정리 완료")

if __name__ == "__main__":
    main()
