# -*- coding: utf-8 -*-
"""
watchdog.py — 크롤이 죽어 있으면 자동으로 이어받아 재개하는 감시자.

Windows 작업 스케줄러가 30분마다 실행. OOM 등으로 크롤이 죽어도
체크포인트부터 --resume 로 다시 이어받아 결국 완주하게 한다.

판단 순서 (메모리 충돌 방지를 위해 '실행중'이면 무거운 검사 안 함):
  1) 크롤(auto_update/run.py/crawler) 프로세스가 살아있나? → 있으면 건너뜀
  2) 남은 작업(pending = ids_all − done) 계산
  3) pending 이 임계치 이하면 → 완료로 보고 재개 안 함
  4) 그 외(죽었고 할 일 남음) → stale lock 제거 후 auto_update.py --resume 백그라운드 실행
"""
import os, sys, json, subprocess, datetime

ROOT = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(ROOT, "encar_output")
LOGDIR = os.path.join(ROOT, "logs")
os.makedirs(LOGDIR, exist_ok=True)
LOG = os.path.join(LOGDIR, "watchdog.log")
LOCK = os.path.join(ROOT, "auto_update.lock")
PY = sys.executable
DONE_THRESHOLD = 200   # 남은 작업이 이 이하면 완료로 간주(영구 실패 매물 여유분)

def log(m):
    line = "[%s] %s" % (datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"), m)
    with open(LOG, "a", encoding="utf-8") as f:
        f.write(line + "\n")
    print(line, flush=True)

def crawl_running():
    """python 프로세스 명령행에 크롤 관련 스크립트가 있으면 실행중으로 판단."""
    try:
        out = subprocess.check_output(
            ["powershell", "-NoProfile", "-Command",
             "Get-CimInstance Win32_Process -Filter \"Name='python.exe'\" | "
             "ForEach-Object { $_.CommandLine }"],
            text=True, stderr=subprocess.DEVNULL, timeout=90)
    except Exception as e:
        log("프로세스 확인 실패(%s) → 안전하게 실행중으로 간주" % e)
        return True   # 불확실하면 건드리지 않음
    for line in out.splitlines():
        if ("auto_update.py" in line) or ("run.py" in line) or ("crawler.py" in line):
            return True
    return False

def pending_count():
    try:
        with open(os.path.join(OUT, "details_done_ids.json")) as f:
            done = set(json.load(f))
        with open(os.path.join(OUT, "ids_all.json"), encoding="utf-8") as f:
            allids = set(x["id"] for x in json.load(f))
        return len(allids - done)
    except Exception as e:
        log("pending 계산 실패: %s" % e)
        return -1

def pipeline_incomplete():
    """details.json이 encar_cleaned.csv보다 최신이면 정제/빌드/배포가 안 끝난 것 → 재개 필요.
       (Stage2/3는 됐는데 process/clean/build가 실패한 경우를 잡는다.)"""
    try:
        det = os.path.getmtime(os.path.join(OUT, "details.json"))
        cln = os.path.getmtime(os.path.join(OUT, "encar_cleaned.csv"))
        return det > cln + 60   # details가 1분 이상 더 최신 → 정제 안 됨
    except OSError:
        return False

def main():
    if crawl_running():
        log("크롤 실행중 → 건너뜀")
        return
    pend = pending_count()
    if pend < 0:
        log("상태 불명 → 건너뜀(안전)")
        return
    stale = pipeline_incomplete()
    if pend <= DONE_THRESHOLD and not stale:
        log("남은 작업 %d건 + 정제·배포 최신 → 재개 불필요" % pend)
        return
    # 죽었고 (할 일 남았거나 정제·배포 미완료) → 재개
    if os.path.exists(LOCK):
        try:
            os.remove(LOCK); log("stale lock 제거")
        except OSError:
            pass
    reason = ("남은 %d건" % pend) if pend > DONE_THRESHOLD else "정제·배포 미완료(파이프라인 중단)"
    log("크롤 중단 감지(%s) → auto_update.py --resume 재개" % reason)
    DETACHED, NEWGRP = 0x00000008, 0x00000200
    subprocess.Popen(
        [PY, "auto_update.py", "--resume"], cwd=ROOT,
        creationflags=DETACHED | NEWGRP, close_fds=True,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL)
    log("재개 프로세스 시작됨")

if __name__ == "__main__":
    main()
