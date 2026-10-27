# -*- coding: utf-8 -*-
"""
git_push.py — 아직 GitHub에 안 올라간 커밋을 올린다(push = Cloudflare 자동 재배포).

auto_update.py(주간 작업 끝)와 watchdog.py(30분마다 재시도)가 쓴다.
회사 와이파이(HQ_wifi)에서는 보안 장비(Genian NAC)가 HTTPS를 가로채 push가 실패한다.
우회하지 않고, 네트워크가 바뀐 뒤(휴대폰 핫스팟) 다음 시도에서 올라가게 둔다.

    python git_push.py    # 안 올린 커밋 보기(올리지는 않음)
"""
import os, sys, subprocess

DATA_PREFIX = "데이터 갱신"      # auto_update.py 커밋 메시지 머리 — 감시 작업은 이 커밋만 대신 올린다
PUSH_TIMEOUT = 900             # 초. 핫스팟으로 데이터 수십 MB를 올리는 시간
NO_WINDOW = 0x08000000         # CREATE_NO_WINDOW: pythonw(감시 작업)에서 콘솔 창 안 띄움

def _git(root, args, timeout=60):
    env = dict(os.environ, GIT_TERMINAL_PROMPT="0", GCM_INTERACTIVE="never")   # 무인 실행: 로그인 창을 띄우지 않고 실패
    return subprocess.run(["git"] + args, cwd=root, capture_output=True, encoding="utf-8", errors="replace",
                          timeout=timeout, env=env, creationflags=NO_WINDOW if os.name == "nt" else 0)

def pending(root):
    """upstream(origin/main)에 없는 커밋 제목, 오래된 것부터. upstream을 못 찾으면 None"""
    r = _git(root, ["log", "--reverse", "--format=%s", "@{u}..HEAD"])
    if r.returncode != 0:
        return None
    return [s for s in r.stdout.splitlines() if s.strip()]

def push(root, log, only_data=False):
    """안 올린 커밋이 있으면 git push. 결과 'none' | 'pushed' | 'skipped' | 'failed' — 예외는 내지 않는다.
       only_data=True면 안 올린 커밋이 모두 '데이터 갱신' 커밋일 때만 올린다(사람이 만든 커밋은 사람이 올린다)."""
    try:
        subs = pending(root)
        if subs is None:
            log("push 확인 실패: upstream(origin/main)을 못 찾음")
            return "failed"
        if not subs:
            return "none"
        if only_data and not all(s.startswith(DATA_PREFIX) for s in subs):
            log("안 올린 커밋 %d개 중 데이터 갱신이 아닌 커밋이 있어 자동 push 안 함: %s" % (len(subs), " / ".join(subs[-3:])))
            return "skipped"
        r = _git(root, ["push"], timeout=PUSH_TIMEOUT)
        if r.returncode == 0:
            log("git push 완료 — 커밋 %d개(마지막: %s)" % (len(subs), subs[-1]))
            return "pushed"
        out = [s for s in (r.stdout + r.stderr).splitlines() if s.strip()]
        why = next((s for s in out if s.startswith(("fatal:", "error:"))), out[-1] if out else "")   # 예: schannel: SEC_E_UNTRUSTED_ROOT
        log("git push 실패(exit=%d, 커밋 %d개 대기) — 다음에 다시 시도: %s" % (r.returncode, len(subs), why))
        return "failed"
    except subprocess.TimeoutExpired:
        log("git push 시간 초과(%d초) — 다음에 다시 시도" % PUSH_TIMEOUT)
        return "failed"
    except Exception as e:                                   # git 실행 자체가 안 되는 경우 등
        log("git push 중 오류 — 다음에 다시 시도: %s" % e)
        return "failed"

if __name__ == "__main__":
    root = os.path.dirname(os.path.abspath(__file__))
    subs = pending(root)
    if subs is None:
        print("upstream(origin/main)을 못 찾음")
        sys.exit(1)
    print("안 올린 커밋 %d개" % len(subs) + "".join("\n  " + s for s in subs))
