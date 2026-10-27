# -*- coding: utf-8 -*-
"""
watchdog.py — 크롤이 중간에 멈춰 있으면 자동으로 이어받아 재개하는 감시자.

Windows 작업 스케줄러(EncarWatchdog)가 30분마다 pythonw 로 실행(창 안 뜸).
테더링 인증서 가로채기·창 닫힘·PC 꺼짐 등으로 실행이 중단돼도 체크포인트부터
--resume 으로 다시 이어받아 결국 완주하게 한다.

판단 순서
  1) 크롤(auto_update/run.py/crawler) 프로세스가 살아있나? → 있으면 건너뜀
  1.5) 안 올라간 '데이터 갱신' 커밋이 있으면 git push 재시도(git_push.py)
     → 회사 와이파이(Genian NAC)에서 실패한 자동 배포를 핫스팟으로 바뀐 뒤 올린다.
       사람이 만든 커밋이 섞여 있으면 건드리지 않는다
  2) 직전 실행(logs/auto_*.log, lock 때문에 건너뛴 회차 로그는 제외)이 '완료'로 끝났나?
     → 완료면 재개 안 함 (네트워크 실패로 남은 소수 매물은 다음 주간 실행이 수집)
  3) 중단된 채 끝났으면 → stale lock 제거 후 EncarResumeOnce 작업(--resume) 실행
     단, 진척 없이 연속 MAX_NO_PROGRESS 회 재개했으면 멈추고 수동 확인을 기다림
     (진척 = 상세 완료 대수(details_done_ids.json)가 직전 자동 재개 때보다 늘었음.
      파일은 전부 실패한 배치에서도 다시 저장되므로 수정시각이 아니라 대수로 판단)

    python watchdog.py --dry-run   # 판단만 출력, 실행 안 함
"""
import os, sys, json, glob, subprocess, datetime, argparse
import git_push

try:
    import psutil
except ImportError:
    psutil = None

ROOT = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(ROOT, "encar_output")
LOGDIR = os.path.join(ROOT, "logs")
os.makedirs(LOGDIR, exist_ok=True)
LOG = os.path.join(LOGDIR, "watchdog.log")
STATE = os.path.join(LOGDIR, "watchdog_state.json")
LOCK = os.path.join(ROOT, "auto_update.lock")
DONE_IDS = os.path.join(OUT, "details_done_ids.json")
RESUME_TASK = "EncarResumeOnce"
MAX_NO_PROGRESS = 6        # 진척 없는 자동 재개 연속 한도 (약 6시간분)
NO_WINDOW = 0x08000000     # CREATE_NO_WINDOW: pythonw 에서 콘솔 창 안 띄움

def log(m):
    line = "[%s] %s" % (datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"), m)
    with open(LOG, "a", encoding="utf-8") as f:
        f.write(line + "\n")
    print(line, flush=True)

def crawl_running():
    """python 프로세스 명령행에 크롤 관련 스크립트가 있으면 실행중으로 판단."""
    try:
        if psutil:
            cmds = []
            for p in psutil.process_iter(["name", "cmdline"]):
                try:
                    if "python" in (p.info["name"] or "").lower():
                        cmds.append(" ".join(p.info["cmdline"] or []))
                except (psutil.NoSuchProcess, psutil.AccessDenied):
                    pass
        else:
            cmds = subprocess.check_output(
                ["powershell", "-NoProfile", "-Command",
                 "Get-CimInstance Win32_Process -Filter \"Name='python.exe'\" | "
                 "ForEach-Object { $_.CommandLine }"],
                text=True, stderr=subprocess.DEVNULL, timeout=90,
                creationflags=NO_WINDOW).splitlines()
    except Exception as e:
        log("프로세스 확인 실패(%s) → 안전하게 실행중으로 간주" % e)
        return True   # 불확실하면 건드리지 않음
    return any(("auto_update.py" in c) or ("run.py" in c) or ("crawler.py" in c) for c in cmds)

def last_run():
    """(상태, 로그명). 상태: 'completed' | 'interrupted' | None(로그 없음).
       lock 때문에 '이번 회차 건너뜀'으로 끝난 로그는 실제 실행이 아니므로 제외."""
    for path in sorted(glob.glob(os.path.join(LOGDIR, "auto_*.log")), key=os.path.getmtime, reverse=True):
        with open(path, "rb") as f:
            data = f.read()
        if "이번 회차 건너뜀".encode("utf-8") in data:
            continue
        done = "================ 완료 :".encode("utf-8") in data
        return ("completed" if done else "interrupted"), os.path.basename(path)
    return None, None

def load_state():
    try:
        with open(STATE, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {"attempts": 0, "lastDone": -1}

def done_count():
    try:
        with open(DONE_IDS, encoding="utf-8") as f:
            return len(json.load(f))
    except (OSError, ValueError):
        return -1

def save_state(st):
    with open(STATE, "w", encoding="utf-8") as f:
        json.dump(st, f)

def start_resume():
    """EncarResumeOnce 예약 작업으로 재개(주간 작업과 같은 bat·콘솔). 작업이 없으면 직접 실행."""
    rc = subprocess.call(["schtasks", "/Run", "/TN", RESUME_TASK],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=NO_WINDOW)
    if rc == 0:
        return "작업 스케줄러 %s" % RESUME_TASK
    DETACHED, NEWGRP = 0x00000008, 0x00000200
    py = os.path.join(os.path.dirname(sys.executable), "python.exe")
    subprocess.Popen([py, "auto_update.py", "--resume"], cwd=ROOT,
                     creationflags=DETACHED | NEWGRP, close_fds=True,
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL)
    return "직접 실행(auto_update.py --resume, 작업 %s 실행 실패 rc=%d)" % (RESUME_TASK, rc)

def push_retry(dry, tag):
    """안 올라간 '데이터 갱신' 커밋을 다시 push. 올릴 것이 없으면 로그도 남기지 않는다."""
    if dry:
        subs = git_push.pending(ROOT)
        if subs:
            log(tag + "안 올린 커밋 %d개 → push 재시도 예정(모두 데이터 갱신일 때만): %s" % (len(subs), " / ".join(subs[-3:])))
        return
    git_push.push(ROOT, log, only_data=True)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="판단만 출력하고 재개하지 않음")
    dry = ap.parse_args().dry_run
    tag = "[dry-run] " if dry else ""

    if crawl_running():
        log(tag + "크롤 실행중 → 건너뜀")
        return
    push_retry(dry, tag)
    state, name = last_run()
    st = load_state()
    if state is None:
        log(tag + "실행 로그 없음 → 건너뜀")
        return
    if state == "completed":
        if st.get("attempts") and not dry:
            save_state({"attempts": 0, "lastDone": -1})
        log(tag + "직전 실행(%s) 완료 → 재개 불필요" % name)
        return

    # 중단된 채 끝남 → 재개. 직전 자동 재개 이후 상세 완료 대수가 늘었으면 횟수 초기화
    done = done_count()
    progressed = done > st.get("lastDone", -1)
    attempts = 0 if progressed else st.get("attempts", 0)
    if attempts >= MAX_NO_PROGRESS:
        log(tag + "직전 실행(%s) 중단 상태지만 진척 없는 자동 재개가 %d회 연속 → 자동 재개 보류(수동 확인 필요)"
            % (name, attempts))
        return
    if dry:
        log(tag + "직전 실행(%s) 중단 감지 → 재개할 예정 (진척없는 연속 재개 %d/%d회)" % (name, attempts, MAX_NO_PROGRESS))
        return
    if os.path.exists(LOCK):
        try:
            os.remove(LOCK); log("stale lock 제거")
        except OSError:
            pass
    how = start_resume()
    save_state({"attempts": attempts + 1, "lastDone": done})
    log("직전 실행(%s) 중단 감지 → --resume 재개 시작: %s (진척없는 연속 재개 %d/%d회)"
        % (name, how, attempts + 1, MAX_NO_PROGRESS))

if __name__ == "__main__":
    main()
