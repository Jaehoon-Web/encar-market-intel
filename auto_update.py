# -*- coding: utf-8 -*-
"""
auto_update.py — 엔카 크롤링 → 사이트 빌드 → 자동 배포 무인 오케스트레이터.

매주 수요일 09:00 Windows 작업 스케줄러가 weekly_update.bat 을 통해 이 스크립트를 실행한다.

단계:
  0) 중복 실행 방지(lock)
  1) [핵심] encar_output/ids_*.json 캐시 삭제
     → crawler.py가 지역별 캐시를 재사용하는 구조라, 삭제해야 Stage 1이 API를 새로
       조회해 '신규 매물'을 반영함. (details_done_ids.json / inspect_done_ids.json
       체크포인트는 보존 → Stage 2/3은 신규분만 수집하므로 빠름)
  2) python run.py  (Stage1→2→3→process→clean 자동, encar_cleaned.csv 생성)
  3) python build_data.py  (web/data·web/downloads 재생성)
  4) git add/commit/push  (Cloudflare 자동 재배포)

옵션:
  --full   전체 초기화 후 풀 재크롤(체크포인트·상세까지 삭제, 수일 소요·주말 권장).
           누적된 '판매 완료' 매물을 비우고 완전히 새로 수집.
"""
import sys, os, subprocess, glob, datetime, argparse, time

ROOT = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(ROOT, "encar_output")
LOGDIR = os.path.join(ROOT, "logs")
LOCK = os.path.join(ROOT, "auto_update.lock")
LOCK_STALE_HOURS = 36          # 이 시간 지난 lock은 비정상 종료로 보고 무시
PY = sys.executable            # 현재 파이썬 인터프리터 재사용

os.makedirs(LOGDIR, exist_ok=True)
_logfile = os.path.join(LOGDIR, "auto_%s.log" % datetime.datetime.now().strftime("%Y%m%d_%H%M%S"))

def log(msg):
    line = "[%s] %s" % (datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"), msg)
    print(line, flush=True)
    with open(_logfile, "a", encoding="utf-8") as f:
        f.write(line + "\n")

def run(cmd, step):
    """하위 프로세스 실행 + 로그 + 실패 시 예외."""
    log("▶ %s : %s" % (step, " ".join(cmd)))
    with open(_logfile, "a", encoding="utf-8") as f:
        rc = subprocess.call(cmd, cwd=ROOT, stdout=f, stderr=subprocess.STDOUT)
    if rc != 0:
        raise RuntimeError("%s 실패 (exit=%d)" % (step, rc))
    log("✔ %s 완료" % step)

def acquire_lock():
    if os.path.exists(LOCK):
        age_h = (time.time() - os.path.getmtime(LOCK)) / 3600
        if age_h < LOCK_STALE_HOURS:
            log("이미 실행 중(lock %.1f시간 전 생성) → 이번 회차 건너뜀" % age_h)
            sys.exit(0)
        log("오래된 lock(%.1f시간) 발견 → 무시하고 진행" % age_h)
    with open(LOCK, "w", encoding="utf-8") as f:
        f.write(datetime.datetime.now().isoformat())

def release_lock():
    try:
        if os.path.exists(LOCK):
            os.remove(LOCK)
    except OSError:
        pass

def purge_id_caches():
    """지역별 ID 캐시 + 병합본 삭제 → Stage 1 API 재조회 강제 (신규 매물 반영).
       체크포인트(details_done_ids / inspect_done_ids)는 'ids_'로 시작하지 않아 안전."""
    n = 0
    for p in glob.glob(os.path.join(OUT, "ids_*.json")):
        try:
            os.remove(p); n += 1
        except OSError as e:
            log("  캐시 삭제 실패: %s (%s)" % (p, e))
    log("ID 캐시 %d개 삭제(신규 매물 재조회 강제)" % n)

def purge_full():
    """--full: 상세·체크포인트·CSV까지 삭제 → 완전 새 수집(누적 매물 제거)."""
    pats = ["ids_*.json", "details*.json", "inspect*.json", "encar_*.csv", "cleaning_report.txt"]
    n = 0
    for pat in pats:
        for p in glob.glob(os.path.join(OUT, pat)):
            try:
                os.remove(p); n += 1
            except OSError as e:
                log("  삭제 실패: %s (%s)" % (p, e))
    log("[--full] %d개 파일 삭제(완전 초기화)" % n)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--full", action="store_true", help="전체 초기화 후 풀 재크롤(수일 소요)")
    args = ap.parse_args()

    mode = "전체 재크롤(--full)" if args.full else "주간 증분 갱신"
    log("================ 자동 갱신 시작 : %s ================" % mode)
    acquire_lock()
    try:
        # 1) 신규 매물 반영
        if args.full:
            purge_full()
        else:
            purge_id_caches()

        # 2) 크롤 + 정제
        run([PY, "run.py", "--fresh"], "크롤링+정제(run.py)")

        # 3) 사이트 데이터 빌드
        run([PY, "build_data.py"], "사이트 빌드(build_data.py)")

        # 4) Git 배포
        run(["git", "add", "web/data", "web/downloads"], "git add")
        today = datetime.date.today().isoformat()
        msg = "데이터 갱신 %s%s" % (today, " (전체 재크롤)" if args.full else " (주간)")
        # 변경 없으면 commit가 실패(비정상 아님) → 분기 처리
        rc = subprocess.call(["git", "commit", "-m", msg], cwd=ROOT,
                             stdout=open(_logfile, "a", encoding="utf-8"),
                             stderr=subprocess.STDOUT)
        if rc != 0:
            log("커밋할 변경 없음(또는 commit 스킵) → push 생략")
        else:
            run(["git", "push"], "git push(자동 배포)")

        log("================ 완료 : %s ================" % mode)
    except Exception as e:
        log("!! 중단: %s" % e)
        log("   → 체크포인트가 있어 다음 회차에 이어서 수집됩니다. 로그: %s" % _logfile)
        release_lock()
        sys.exit(1)
    release_lock()
    sys.exit(0)

if __name__ == "__main__":
    main()
