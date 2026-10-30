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
  4) git add/commit/push  (Cloudflare 자동 재배포 — 지난번에 못 올린 커밋도 올린다.
     push가 실패해도 '완료'로 끝내고, watchdog.py가 30분마다 다시 올린다: git_push.py)

옵션:
  --full   전체 초기화 후 풀 재크롤(체크포인트·상세까지 삭제, 수일 소요·주말 권장).
           누적된 '판매 완료' 매물을 비우고 완전히 새로 수집.
"""
import sys, os, subprocess, glob, datetime, argparse, time, ctypes, json
import git_push

# 크롤 중 PC 절전 방지 (런타임 요청 — 시스템 설정 변경 아님, 프로세스 종료 시 자동 해제)
ES_CONTINUOUS = 0x80000000
ES_SYSTEM_REQUIRED = 0x00000001
def prevent_sleep():
    try: ctypes.windll.kernel32.SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)
    except Exception: pass
def allow_sleep():
    try: ctypes.windll.kernel32.SetThreadExecutionState(ES_CONTINUOUS)
    except Exception: pass

ROOT = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(ROOT, "encar_output")
LOGDIR = os.path.join(ROOT, "logs")
LOCK = os.path.join(ROOT, "auto_update.lock")
LOCK_STALE_HOURS = 36          # 이 시간 지난 lock은 비정상 종료로 보고 무시
PY = sys.executable            # 현재 파이썬 인터프리터 재사용
LOCAL_STEPS = os.path.join(OUT, "local_steps.json")   # 이 PC에만 있는 추가 단계(저장소 밖): [{"label", "script", "args"}]

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

def local_steps():
    """encar_output/local_steps.json의 추가 단계 목록. 없거나 읽지 못하면 빈 목록"""
    if not os.path.exists(LOCAL_STEPS):
        return []
    try:
        with open(LOCAL_STEPS, encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        log("local_steps.json 읽기 실패(무시): %s" % e)
        return []

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

def git_deploy(full):
    """web/data·web/downloads 커밋 → 안 올린 커밋이 있으면 push(Cloudflare 자동 재배포).
       커밋할 변경이 없어도 지난번에 못 올린 커밋은 올린다(이어받기 회차가 push를 건너뛰던 문제).
       push가 실패해도 예외를 내지 않는다 — 수집·빌드는 끝났으니 '완료'로 끝내야 감시 작업이 수집부터
       다시 돌리지 않고, 대신 30분마다 push만 다시 시도한다(watchdog.py)."""
    run(["git", "add", "web/data", "web/downloads"], "git add")
    today = datetime.date.today().isoformat()
    msg = "%s %s%s" % (git_push.DATA_PREFIX, today, " (전체 재크롤)" if full else " (주간)")
    # 변경 없으면 commit가 실패(비정상 아님) → 분기 처리
    with open(_logfile, "a", encoding="utf-8") as f:
        rc = subprocess.call(["git", "commit", "-m", msg], cwd=ROOT, stdout=f, stderr=subprocess.STDOUT)
    if rc != 0:
        log("커밋할 변경 없음(또는 commit 스킵)")
    log("▶ git push(자동 배포)")
    res = git_push.push(ROOT, log)
    if res == "none":
        log("올릴 커밋 없음 → push 생략")
    elif res != "pushed":
        log("push 못 함 — 수집·빌드는 끝났다. 감시 작업(EncarWatchdog)이 30분마다 다시 올린다")

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--full", action="store_true", help="전체 초기화 후 풀 재크롤(수일 소요)")
    ap.add_argument("--resume", action="store_true", help="캐시 삭제 없이 중단된 크롤 이어받기(Stage1 재조회 안 함)")
    args = ap.parse_args()

    mode = "전체 재크롤(--full)" if args.full else ("이어받기(--resume)" if args.resume else "주간 증분 갱신")
    log("================ 자동 갱신 시작 : %s ================" % mode)
    acquire_lock()
    prevent_sleep()
    try:
        # 1) 신규 매물 반영 (resume이면 캐시 보존 → 이어받기)
        if args.full:
            purge_full()
        elif args.resume:
            log("이어받기 모드: ID 캐시 보존(Stage1 건너뜀), 체크포인트부터 계속")
        else:
            purge_id_caches()

        # 2) 크롤 + 정제 (resume이면 --fresh 없이 → 기존 ids_all.json 재사용)
        run([PY, "run.py"] + ([] if args.resume else ["--fresh"]), "크롤링+정제(run.py)")

        # 2.5) 이력 스냅샷 누적 (크롤일·판매상태 태깅, 트렌드/누적다운로드용) — 실패해도 배포는 계속
        try:
            run([PY, "append_history.py"], "이력 스냅샷 누적(append_history.py)")
        except Exception as e:
            log("이력 누적 실패(무시하고 계속): %s" % e)

        # 2.6) 전처리 (시세 산정·시황용 매물 테이블 + 목록 가격 관측 누적, DATA_전처리_명세.md) — 실패해도 배포는 계속
        try:
            run([PY, "prep.py"], "전처리(prep.py)")
        except Exception as e:
            log("전처리 실패(무시하고 계속): %s" % e)

        # 2.65) 이 PC에만 있는 추가 단계(encar_output/local_steps.json, 저장소 밖 — 예: 비공개 매칭표로 표준 모델명 붙이기) — 실패해도 계속
        for st in local_steps():
            try:
                run([PY, st["script"]] + st.get("args", []), st.get("label", "로컬 단계"))
            except Exception as e:
                log("로컬 단계 실패(무시하고 계속): %s" % e)

        # 2.7) 시세 보정 계수(D3: 차령·주행·렌트·색상·등급 → web/data/adj_coef.json, 검증 포함) — 실패해도 배포는 계속
        try:
            run([PY, "adjust_coef.py", "--validate"], "보정 계수(adjust_coef.py)")
        except Exception as e:
            log("보정 계수 실패(무시하고 계속): %s" % e)

        # 2.8) 시황 지수(D4: 시세·판매속도·재고·시황 → web/data/market_index.json) — 실패해도 배포는 계속
        try:
            run([PY, "market_index.py"], "시황 지수(market_index.py)")
        except Exception as e:
            log("시황 지수 실패(무시하고 계속): %s" % e)

        # 2.9) 사이트용 비교 매물 파일(WP1 시세 엔진 입력 → web/data/comps, 보정 계수·시황 지수 다음) — 실패해도 배포는 계속
        try:
            run([PY, "price_engine.py", "--export"], "비교 매물 파일(price_engine.py --export)")
        except Exception as e:
            log("비교 매물 파일 실패(무시하고 계속): %s" % e)

        # 2.91) 마켓 펄스(이번 주 숫자·주목 모델·요약 → web/data/pulse.json, 시황 지수 다음) — 실패해도 배포는 계속
        try:
            run([PY, "pulse_data.py"], "마켓 펄스(pulse_data.py)")
        except Exception as e:
            log("마켓 펄스 실패(무시하고 계속): %s" % e)

        # 2.92) 모델 리포트(잔존율·주간 흐름·인하·이상 의심 매물 → web/data/report, 비교 매물 파일 다음) — 실패해도 배포는 계속
        try:
            run([PY, "model_report.py"], "모델 리포트(model_report.py)")
        except Exception as e:
            log("모델 리포트 실패(무시하고 계속): %s" % e)

        # 3) 사이트 데이터 빌드
        run([PY, "build_data.py"], "사이트 빌드(build_data.py)")

        # 3.1) 사이트 점검(파일 날짜·모양·'환산' 문구 등) — 결과는 로그에만, 실패해도 배포는 계속(2.91·2.92가 실패해 묵은 파일이 남으면 여기서 보임)
        try:
            run(["node", os.path.join("tools", "site_check.mjs")], "사이트 점검(site_check.mjs)")
        except Exception as e:
            log("사이트 점검 실패(배포는 계속, 로그 확인): %s" % e)

        # 4) Git 배포
        git_deploy(args.full)

        log("================ 완료 : %s ================" % mode)
    except Exception as e:
        log("!! 중단: %s" % e)
        log("   → 체크포인트가 있어 다음 회차에 이어서 수집됩니다. 로그: %s" % _logfile)
        allow_sleep()
        release_lock()
        sys.exit(1)
    allow_sleep()
    release_lock()
    sys.exit(0)

if __name__ == "__main__":
    main()
