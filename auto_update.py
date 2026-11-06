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
  --full   전체 초기화 후 풀 재크롤(체크포인트·판매된 차 상세까지 삭제, 수일 소요) — 정기적으로 쓰지 않는다(AUTOMATION.md).
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
BLOCKED = os.path.join(LOGDIR, "DEPLOY_BLOCKED.txt")    # 사이트 점검(★)으로 배포를 멈춘 회차 표시 — 다음에 배포되면 지운다

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

def pid_alive(pid):
    """그 프로세스가 아직 살아 있나(Windows: OpenProcess + GetExitCodeProcess — os.kill(pid, 0)은 Windows에서 프로세스를 끝내 버린다)"""
    try:
        k = ctypes.windll.kernel32
        h = k.OpenProcess(0x1000, False, int(pid))                # PROCESS_QUERY_LIMITED_INFORMATION
        if not h:
            return False
        code = ctypes.c_ulong()
        ok = k.GetExitCodeProcess(h, ctypes.byref(code))
        k.CloseHandle(h)
        return bool(ok) and code.value == 259                     # STILL_ACTIVE
    except Exception:
        return False

def acquire_lock():
    """lock = 실행 중인 프로세스 번호 + 시작 시각. 그 프로세스가 살아 있으면 시간과 상관없이 건너뛴다(리뷰 11-05: 36시간 넘게 도는
    --full 과 주간 작업이 겹쳐 돌던 문제). 번호가 없는 예전 lock 은 시간으로만 판단"""
    if os.path.exists(LOCK):
        age_h = (time.time() - os.path.getmtime(LOCK)) / 3600
        pid = None
        try:
            with open(LOCK, encoding="utf-8") as f:
                pid = json.load(f).get("pid")
        except Exception:
            pass
        if pid and pid_alive(pid):
            log("이미 실행 중(프로세스 %s, lock %.1f시간 전) → 이번 회차 건너뜀" % (pid, age_h))
            sys.exit(0)
        if not pid and age_h < LOCK_STALE_HOURS:
            log("이미 실행 중(lock %.1f시간 전 생성) → 이번 회차 건너뜀" % age_h)
            sys.exit(0)
        log("끝난 실행의 lock(%s, %.1f시간) 발견 → 무시하고 진행" % ("프로세스 %s 없음" % pid if pid else "오래됨", age_h))
    with open(LOCK, "w", encoding="utf-8") as f:
        json.dump({"pid": os.getpid(), "at": datetime.datetime.now().isoformat()}, f)

def release_lock():
    try:
        if os.path.exists(LOCK):
            os.remove(LOCK)
    except OSError:
        pass

def restore(*paths):
    """그 폴더를 마지막 커밋 상태로(바뀐 · 지운 파일은 되돌리고 새로 생긴 파일은 지운다) — 실패한 단계의 반쯤 쓴 파일이 배포되지 않게"""
    for p in paths:
        try:
            subprocess.call(["git", "checkout", "--", p], cwd=ROOT)
            subprocess.call(["git", "clean", "-fdq", "--", p], cwd=ROOT)
            log("  %s → 마지막 커밋 상태로 되돌림" % p)
        except Exception as e:
            log("  %s 되돌리기 실패: %s" % (p, e))

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
    staged = subprocess.call(["git", "diff", "--cached", "--quiet"], cwd=ROOT) != 0   # 1 = 스테이징된 변경 있음
    if not staged:
        log("커밋할 변경 없음")
    else:
        with open(_logfile, "a", encoding="utf-8") as f:
            rc = subprocess.call(["git", "commit", "-m", msg], cwd=ROOT, stdout=f, stderr=subprocess.STDOUT)
        if rc != 0:                                                  # 변경이 있는데 커밋 실패 → '완료'로 끝내지 않는다(리뷰 11-05: 스테이징된 채 배포 안 됨)
            raise RuntimeError("git commit 실패(exit=%d) — 변경이 스테이징된 채 남았습니다" % rc)
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

        # 2.65) 이 PC에만 있는 추가 단계(encar_output/local_steps.json, 저장소 밖 — 비공개 매칭표로 차 이름 4단계(경매장 표기)를 만들어
        #       prep/names.parquet 에 쓰고 prep.py --names 로 listings 에 붙인다, 기획 v2.23) — 실패해도 계속(그때는 지난 이름 파일·엔카 이름)
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

        # 2.9) 사이트용 비교 매물 파일(WP1 시세 엔진 입력 → web/data/comps, 보정 계수·시황 지수 다음) — 실패하면 지난 판으로 되돌리고 계속
        #      (내보내기는 폴더를 비우고 새로 쓰므로, 중간에 멈추면 반쯤 지운 폴더가 배포됐다 — 리뷰 11-05)
        try:
            run([PY, "price_engine.py", "--export"], "비교 매물 파일(price_engine.py --export)")
        except Exception as e:
            log("비교 매물 파일 실패 → 지난 판으로 되돌리고 계속: %s" % e)
            restore("web/data/comps")

        # 2.91) 마켓 펄스(이번 주 숫자·주목 모델·요약 → web/data/pulse.json, 시황 지수 다음) — 실패해도 배포는 계속
        try:
            run([PY, "pulse_data.py"], "마켓 펄스(pulse_data.py)")
        except Exception as e:
            log("마켓 펄스 실패(무시하고 계속): %s" % e)

        # 2.92) 모델 리포트 데이터(잔존율·주간 흐름·인하·이상 의심 매물 → web/data/report, 비교 매물 파일 다음) — 시세 산정 감가 곡선·동급 지표와 마켓 펄스 매물 경고가 씀. 실패해도 배포는 계속
        try:
            run([PY, "model_report.py"], "모델 리포트(model_report.py)")
        except Exception as e:
            log("모델 리포트 실패 → 지난 판으로 되돌리고 계속: %s" % e)
            restore("web/data/report")

        # 2.93) 시세 점검(오차 · 사고 단계별 치우침 · 범위 적중 → web/data/audit.json 관리자 요약, 감가 옆 시장 근거 cond_market.json — 기획 v2.33). 실패해도 배포는 계속
        try:
            run([PY, os.path.join("tools", "price_audit.py"), "--write"], "시세 점검(price_audit.py)")
        except Exception as e:
            log("시세 점검 실패(무시하고 계속): %s" % e)

        # 3) 사이트 데이터 빌드
        run([PY, "build_data.py"], "사이트 빌드(build_data.py)")

        # 3.1) 사이트 점검(파일 날짜·모양·출처 이름 등) — 배포를 막는 점검(★: 화면 파일 · 비교 매물 파일 · 25MiB · 출처 이름 · 스크립트 문법 ·
        #      JSON 읽기)이 틀리면(종료 코드 2) 이번 주는 배포하지 않고 지난주 사이트를 그대로 둔다. 나머지 점검 실패(1)는 로그만 남기고 배포(리뷰 11-05)
        log("▶ 사이트 점검(site_check.mjs)")
        with open(_logfile, "a", encoding="utf-8") as f:
            rc = subprocess.call(["node", os.path.join("tools", "site_check.mjs")], cwd=ROOT, stdout=f, stderr=subprocess.STDOUT)
        if rc not in (0, 1):
            log("!! 사이트 점검에서 배포를 막는 문제(★)가 나왔습니다 → 이번 주는 배포하지 않고 지난주 사이트를 그대로 둡니다. 로그의 ★ 줄을 확인하세요")
            with open(BLOCKED, "w", encoding="utf-8") as f:
                f.write("%s 사이트 점검 실패(종료 코드 %d) — 배포 멈춤. 로그: %s\n" % (datetime.datetime.now().isoformat(), rc, _logfile))
            restore("web/data", "web/downloads")                  # 묶인 변경을 남겨 두면 감시 작업 · 다음 회차가 그대로 올릴 수 있다
            log("================ 배포 멈춤(사이트 점검) : %s ================" % mode)
            return
        if rc == 1:
            log("사이트 점검 일부 실패(★ 아님) — 배포는 계속, 로그의 ✗ 줄을 확인하세요")
        else:
            log("✔ 사이트 점검 완료")
        if os.path.exists(BLOCKED):
            os.remove(BLOCKED)

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
