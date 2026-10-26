# -*- coding: utf-8 -*-
"""
status_server.py — 크롤링 파이프라인 진행 상황을 브라우저로 보는 로컬 대시보드.

    python status_server.py            → http://127.0.0.1:8790  (30초마다 자동 새로고침)
    python status_server.py --port 9000

최신 logs/auto_*.log 만 읽어서 보여준다(읽기 전용 — 크롤에 영향 없음).
  - 단계별 상태: 1단계 ID → 2단계 상세 → 3단계 성능점검 → 정제 → 이력 → 빌드 → 배포
  - 2·3단계 진행률·속도·예상 완료 시각, 네트워크 실패 건수
  - 크롤 프로세스 생존 여부, 로그 마지막 기록 시각(멈춤 감지), 최근 경고/오류
  - 운영 사이트 데이터 날짜(meta.json collectedDate)
/api/status 는 같은 내용을 JSON으로 준다.
"""
import argparse, datetime as dt, glob, html, json, os, re, time, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

try:
    import psutil
except ImportError:
    psutil = None

ROOT = os.path.dirname(os.path.abspath(__file__))
LOGDIR = os.path.join(ROOT, "logs")
LOCK = os.path.join(ROOT, "auto_update.lock")
SITE_META = "https://encar-market-intel.fullsoup.workers.dev/data/meta.json"
STALL_MIN = 15          # 로그가 이 시간(분) 이상 갱신 안 되면 '멈춤 의심'

TS = re.compile(r"^\[?(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)")
PROG = re.compile(r"(상세|성능점검) \[(\d+)~(\d+)\]:\s+\d+%.*?\|\s*(\d+)/(\d+) \[")

STEPS = [("s1", "1단계 · 매물 ID 수집"), ("s2", "2단계 · 상세 정보"), ("s3", "3단계 · 성능점검"),
         ("proc", "정제 (process·clean)"), ("hist", "이력 누적"), ("prep", "전처리"), ("build", "사이트 빌드"),
         ("deploy", "GitHub 배포")]


def read_lines(path):
    """로그는 auto_update(UTF-8)와 하위 프로세스(cp949) 출력이 섞여 있어 줄마다 디코딩."""
    out = []
    with open(path, "rb") as f:
        for raw in f.read().split(b"\n"):
            for part in raw.split(b"\r"):           # tqdm 진행바는 \r 로 덮어씀
                if not part.strip():
                    continue
                try:
                    out.append(part.decode("utf-8"))
                except UnicodeDecodeError:
                    out.append(part.decode("cp949", "replace"))
    return out


def ts_of(line):
    m = TS.match(line)
    return dt.datetime.strptime(m.group(1), "%Y-%m-%d %H:%M:%S") if m else None


def num(s):
    return int(s.replace(",", ""))


def stage_progress(lines, start_pat, unit_save_pat, batch):
    """start_pat 줄(대상 수) 이후의 중간저장 줄로 진행률·속도 계산."""
    start_idx, target = None, None
    for i, l in enumerate(lines):
        m = re.search(start_pat, l)
        if m:
            start_idx, target = i, num(m.group(1))
    if start_idx is None:
        return None
    saves = [(ts_of(l), l) for l in lines[start_idx:] if re.search(unit_save_pat, l)]
    fails = sum(num(m.group(1)) for _, l in saves
                for m in [re.search(r"네트워크 실패: ([\d,]+)대", l)] if m)
    cur = 0
    for l in reversed(lines[start_idx:]):
        m = PROG.search(l)
        if m:
            if num(m.group(3)) > len(saves) * batch:   # 아직 저장 전인 현재 배치
                cur = int(m.group(4))
            break
    processed = min(target, len(saves) * batch + cur)
    # 속도: 최근 저장 간격 평균(최대 5개)
    per_batch = None
    stamps = [t for t, _ in saves if t]
    if len(stamps) >= 2:
        recent = stamps[-6:]
        per_batch = (recent[-1] - recent[0]).total_seconds() / (len(recent) - 1)
    elif stamps and ts_of(lines[start_idx]):
        per_batch = (stamps[0] - ts_of(lines[start_idx])).total_seconds()
    eta = None
    if per_batch and target > processed:
        eta = dt.datetime.now() + dt.timedelta(seconds=(target - processed) / batch * per_batch)
    return {"target": target, "processed": processed, "batches": len(saves),
            "netFail": fails, "secPerBatch": per_batch, "batch": batch,
            "eta": eta.strftime("%m-%d %H:%M") if eta else None,
            "pct": round(processed / target * 100, 1) if target else 100.0}


def crawl_procs():
    if not psutil:
        return None
    found = []
    for p in psutil.process_iter(["pid", "name", "cmdline", "create_time"]):
        try:
            cmd = " ".join(p.info["cmdline"] or [])
        except Exception:
            continue
        if "python" in (p.info["name"] or "").lower() and re.search(r"auto_update\.py|run\.py|crawler\.py", cmd):
            found.append(re.sub(r"^.*?python(\.exe)?\"?\s+", "", cmd))
    return found


_site_cache = {"t": 0, "v": None}
def site_date():
    if time.time() - _site_cache["t"] < 300:
        return _site_cache["v"]
    try:
        # 기본 Python-urllib UA는 Cloudflare가 403으로 막음
        req = urllib.request.Request(SITE_META, headers={"User-Agent": "Mozilla/5.0 encar-status-dashboard"})
        with urllib.request.urlopen(req, timeout=5) as r:
            _site_cache["v"] = json.loads(r.read()).get("collectedDate")
    except Exception:
        _site_cache["v"] = None
    _site_cache["t"] = time.time()
    return _site_cache["v"]


def status():
    logs = sorted(glob.glob(os.path.join(LOGDIR, "auto_*.log")), key=os.path.getmtime)
    if not logs:
        return {"error": "logs/auto_*.log 없음"}
    path = logs[-1]
    lines = read_lines(path)
    text = "\n".join(lines)
    mtime = dt.datetime.fromtimestamp(os.path.getmtime(path))
    started = ts_of(lines[0]) if lines else None
    mode = (re.search(r"자동 갱신 시작 : (.+?) =", lines[0]) or [None, "?"])[1] if lines else "?"

    has = lambda pat: re.search(pat, text) is not None
    procs = crawl_procs()
    finished = has(r"=+ 완료 :")
    aborted = has(r"!! 중단")
    alive = bool(procs) if procs is not None else os.path.exists(LOCK)

    done = {
        "s1": has(r"1단계 완료"),
        "s2": has(r"2단계 완료"),
        "s3": has(r"3단계 완료"),
        "proc": has(r"✔ 크롤링\+정제"),
        "hist": has(r"✔ 이력 스냅샷"),
        "prep": has(r"✔ 전처리"),
        "build": has(r"✔ 사이트 빌드"),
        "deploy": has(r"✔ git push") or has(r"커밋할 변경 없음"),
    }
    started_flags = {
        "s1": has(r"stage=1"), "s2": has(r"stage=2"), "s3": has(r"stage=3"),
        "proc": done["s3"], "hist": has(r"▶ 이력 스냅샷"), "prep": has(r"▶ 전처리"), "build": has(r"▶ 사이트 빌드"),
        "deploy": has(r"▶ git add"),
    }
    steps = []
    for key, label in STEPS:
        if done[key]:
            st = "done"
        elif started_flags[key]:
            st = "running" if (alive and not aborted) else "failed"
        else:
            st = "wait"
        steps.append({"key": key, "label": label, "state": st})

    s2 = stage_progress(lines, r"상세 수집 대상: ([\d,]+)대", r"중간 저장:", 1000)
    s3 = stage_progress(lines, r"성능점검 잔여: ([\d,]+)대", r"성능점검 중간저장", 500)
    ids = re.findall(r"(?:1단계 완료|전체 ID 캐시 로드): ([\d,]+)대", text)

    issues = [l.strip()[:220] for l in lines
              if re.search(r"\[(WARNING|ERROR)\]|Traceback|!! 중단|Rate limit", l)][-10:]

    if finished:
        overall = "완료"
    elif aborted or (not alive and not finished):
        overall = "중단됨"
    elif (dt.datetime.now() - mtime).total_seconds() > STALL_MIN * 60:
        overall = "멈춤 의심"
    else:
        overall = "진행 중"

    return {
        "overall": overall, "mode": mode, "log": os.path.basename(path),
        "started": started.strftime("%m-%d %H:%M") if started else None,
        "elapsedMin": int((dt.datetime.now() - started).total_seconds() // 60) if started else None,
        "lastWrite": mtime.strftime("%H:%M:%S"),
        "lastWriteAgoSec": int((dt.datetime.now() - mtime).total_seconds()),
        "procs": procs, "ids": ids[-1] if ids else None,
        "steps": steps, "stage2": s2, "stage3": s3, "issues": issues,
        "siteDate": site_date(), "now": dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    }


CSS = """
:root{--bg:#f6f4ef;--card:#fff;--tx:#1d1d1f;--tx2:#6b6b71;--line:#e4e0d8;--ok:#3e8b4c;--run:#c85a2a;--bad:#b54453;--wait:#b8b3a8;--bar:#ece8e0}
@media (prefers-color-scheme:dark){:root{--bg:#17171a;--card:#212125;--tx:#ececef;--tx2:#9a9aa3;--line:#33333a;--bar:#2c2c32;--wait:#55555e}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--tx);font:14px/1.5 "Pretendard","Malgun Gothic",system-ui,sans-serif}
.wrap{max-width:880px;margin:0 auto;padding:20px 16px 40px}
h1{font-size:20px;margin:0 0 4px}.sub{color:var(--tx2);font-size:12px;margin-bottom:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin-bottom:12px}
.hero{display:flex;gap:16px;align-items:center;flex-wrap:wrap}
.badge{font-weight:700;padding:6px 12px;border-radius:999px;color:#fff;font-size:15px}
.kv{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;flex:1}
.kv div b{display:block;font-size:16px}.kv div span{color:var(--tx2);font-size:12px}
.steps{display:flex;flex-direction:column;gap:6px}
.step{display:flex;align-items:center;gap:10px}.dot{width:12px;height:12px;border-radius:50%;flex:none}
.step .st{margin-left:auto;font-size:12px;color:var(--tx2)}
.running .dot{animation:p 1.2s infinite}@keyframes p{50%{opacity:.35}}
.bar{height:14px;background:var(--bar);border-radius:7px;overflow:hidden;margin:8px 0 6px}
.bar i{display:block;height:100%;background:var(--run)}
.meta{display:flex;flex-wrap:wrap;gap:6px 18px;color:var(--tx2);font-size:12px}.meta b{color:var(--tx)}
ul{margin:0;padding-left:18px;font-size:12px;color:var(--tx2);word-break:break-all}
h2{font-size:14px;margin:0 0 8px}
"""
COLORS = {"done": "var(--ok)", "running": "var(--run)", "failed": "var(--bad)", "wait": "var(--wait)"}
LABELS = {"done": "완료", "running": "진행 중", "failed": "중단", "wait": "대기"}
OVERALL = {"진행 중": "var(--run)", "완료": "var(--ok)", "중단됨": "var(--bad)", "멈춤 의심": "var(--bad)"}


def stage_card(title, p, unit):
    if not p:
        return ""
    spb = p["secPerBatch"]
    rate = f"{p['batch'] / spb:.1f}대/초" if spb else "-"
    fail = f" · 네트워크 실패 <b>{p['netFail']:,}</b>대 (다음 실행 때 재수집)" if p["netFail"] else ""
    return f"""<div class="card"><h2>{title}</h2>
<div class="bar"><i style="width:{p['pct']}%"></i></div>
<div class="meta"><span><b>{p['processed']:,}</b> / {p['target']:,}{unit} ({p['pct']}%)</span>
<span>속도 <b>{rate}</b></span><span>예상 완료 <b>{p['eta'] or '-'}</b></span><span>{fail}</span></div></div>"""


def render(s):
    if "error" in s:
        return f"<p>{html.escape(s['error'])}</p>"
    e = html.escape
    steps = "".join(
        f'<div class="step {x["state"]}"><span class="dot" style="background:{COLORS[x["state"]]}"></span>'
        f'{e(x["label"])}<span class="st">{LABELS[x["state"]]}</span></div>' for x in s["steps"])
    procs = (", ".join(e(p) for p in s["procs"]) or "없음") if s["procs"] is not None else "(psutil 없음)"
    ago = s["lastWriteAgoSec"]
    ago_s = f"{ago}초 전" if ago < 120 else f"{ago // 60}분 전"
    issues = "".join(f"<li>{e(i)}</li>" for i in s["issues"]) or "<li>없음</li>"
    el = s["elapsedMin"]
    return f"""<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="30">
<title>엔카 크롤 진행</title><style>{CSS}</style></head><body><div class="wrap">
<h1>엔카 크롤링 진행 상황</h1>
<div class="sub">30초마다 자동 새로고침 · {e(s['now'])} · 로그 {e(s['log'])}</div>
<div class="card hero"><span class="badge" style="background:{OVERALL.get(s['overall'], 'var(--wait)')}">{e(s['overall'])}</span>
<div class="kv"><div><span>실행 모드</span><b>{e(s['mode'])}</b></div>
<div><span>시작 · 경과</span><b>{e(s['started'] or '-')} · {el // 60 if el else 0}시간 {el % 60 if el else 0}분</b></div>
<div><span>로그 마지막 기록</span><b>{e(s['lastWrite'])} ({ago_s})</b></div>
<div><span>현재 매물 ID</span><b>{e(s['ids'] or '-')}대</b></div>
<div><span>사이트 데이터 날짜</span><b>{e(s['siteDate'] or '확인 불가')}</b></div></div></div>
<div class="card"><h2>파이프라인 단계</h2><div class="steps">{steps}</div></div>
{stage_card("2단계 · 상세 정보 수집", s["stage2"], "대")}
{stage_card("3단계 · 성능점검 수집", s["stage3"], "대")}
<div class="card"><h2>실행 중인 프로세스</h2><div class="meta">{procs}</div></div>
<div class="card"><h2>최근 경고·오류 (최대 10줄)</h2><ul>{issues}</ul></div>
</div></body></html>"""


class H(BaseHTTPRequestHandler):
    def do_GET(self):
        s = status()
        if self.path.startswith("/api/status"):
            body, ctype = json.dumps(s, ensure_ascii=False, default=str).encode("utf-8"), "application/json"
        else:
            body, ctype = render(s).encode("utf-8"), "text/html"
        self.send_response(200)
        self.send_header("Content-Type", ctype + "; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8790)
    port = ap.parse_args().port
    print(f"엔카 크롤 진행 대시보드: http://127.0.0.1:{port}  (종료: Ctrl+C)", flush=True)
    ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()
