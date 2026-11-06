# 자동화 가이드 — 주간 크롤링 → 사이트 자동 갱신

매주 **수요일 09:00**, 크롤링부터 사이트 배포까지 무인 자동 실행하는 루틴.

## 전체 흐름
```
[매주 수 09:00] Windows 작업 스케줄러
      ↓ weekly_update.bat → auto_update.py
1. ids_*.json 캐시 삭제   (신규 매물 반영 강제 — 아래 ★ 참조)
2. python run.py --fresh  (Stage1 ID → 2 상세 → 3 성능점검 → process → clean)
3. python build_data.py   (web/data·web/downloads 재생성)
4. git add/commit/push    (Cloudflare 자동 재배포 — 지난번에 못 올린 커밋도 올림)
      ↳ push 실패 시: 실행은 '완료'로 끝내고, 감시 작업(EncarWatchdog)이 30분마다 push만 다시 시도
```

### ★ 왜 캐시를 먼저 지우나 (중요)
`crawler.py`는 지역별 ID 캐시(`ids_국산_*.json` 등)가 있으면 **API를 다시 조회하지 않고 캐시를 재사용**한다(crawler.py 344~347행). 그래서 `--fresh`만으로는 **신규 매물이 반영되지 않는다.** `auto_update.py`가 매 실행 시 `ids_*.json`을 삭제해 Stage 1이 API를 새로 조회하도록 강제한다.
- 체크포인트(`details_done_ids.json`·`inspect_done_ids.json`)는 보존 → Stage 2/3은 **신규분만** 수집하므로 주간 실행은 수 시간 내 완료.

## 구성 파일
| 파일 | 역할 |
|------|------|
| `auto_update.py` | 오케스트레이터(락·로깅·에러처리·단계 실행) |
| `weekly_update.bat` | 작업 스케줄러용 런처(Python 경로 고정 호출). 파이썬을 못 찾거나 `auto_update.py`가 0이 아닌 코드로 끝나면 `logs/weekly_bat.log`에 한 줄 남긴다(로그를 만들기 전에 끝난 실행도 알 수 있게) |
| `cleanup_old.py` | 오래된 로그·캐시 정리(크롤 완료 후 1회/수시) |
| `watchdog.py` | 30분마다(작업 `EncarWatchdog`) ① 안 올라간 '데이터 갱신' 커밋이 있으면 push 재시도(사람이 만든 커밋이 섞여 있으면 안 올림) ② 직전 실행이 중단 상태면 `EncarResumeOnce`(--resume)로 자동 재개. 진척 없이 6회 연속이면 보류 → `logs/watchdog.log` 확인 ③ 직전 실행은 완료인데 마지막 목록(`ids_all.json`)이 8일 넘게 지났으면 주간 실행이 아예 시작 못 한 것 → `logs/WEEKLY_NOT_STARTED.txt` 경고 + `EncarWeeklyUpdate`를 대신 시작(6시간에 한 번까지, 새 목록이 들어오면 경고는 저절로 지워짐) |
| `git_push.py` | 안 올린 커밋 push(주간 작업 끝·감시 작업이 사용). `python git_push.py` = 안 올린 커밋 보기 |
| `status_server.py` / `status_dashboard.bat` | 진행 상황 대시보드(http://127.0.0.1:8790, 로그 읽기 전용). 맨 위 빨간 '확인 필요' 칸 = `WEEKLY_NOT_STARTED.txt` · `DEPLOY_BLOCKED.txt` · 8일 안의 `weekly_bat.log` |
| `logs/` | 실행 로그(자동 생성, git 제외) |

### 수집 상태 파일 (`encar_output/`, 주간 캐시 삭제 대상 아님)
| 파일 | 내용 |
|------|------|
| `list_query_totals.json` | 조회별 대수(첫 페이지 대수·받은 수, 회차 표시)와 급감·1만 건 상한·범위 점검 결과. 다음 회차 급감 판단의 기준값이다. 지우면 그 회차는 급감 점검 없이 진행한다 |
| `details_failed.json` | 상세 실패 매물별 사유·횟수·상태 코드·최종 URL. 목록에 남아 있으면 다음 회차에 다시 받는다(3회까지). `--full` 때 함께 지워진다 |
| `details_alias.json` | 재등록 광고(새 매물ID) → 상세가 저장된 원래 매물의 vehicleId |
| `details_incomplete.json` | 이번 목록의 처음 상세 대상 수와 '덜 받아 멈춘' 횟수. 2단계를 마쳤는데 네트워크 실패로 못 받은 차가 이번 회차 신규의 1%(최소 100대)를 넘으면 exit 4로 멈춰 이력 · 빌드 · 배포 전에 감시 작업이 --resume 으로 다시 받게 한다. 같은 목록에서 2번 멈춘 뒤에는 남아도 진행(그 주 갱신이 통째로 멈추지 않게) |
| `vehicle_state.before.json` · `history_redo.json` | 이력(append_history.py)이 마지막 크롤일을 처리하기 직전의 차량 상태와 history · trend 파일 크기. 같은 목록으로 다시 돌면(이어받기로 상세가 더 모임) 여기로 되돌린 뒤 다시 계산한다 — 건너뛰지 않음 |
| `detail_fail_samples/` | 실패 사유별 HTML 표본(사유당 3개, 회차마다 덮어씀). 원인 확인용 |

## 1회 설정 — 작업 스케줄러 등록 (관리자 명령 프롬프트)
```cmd
schtasks /Create /TN "EncarWeeklyUpdate" /TR "\"C:\개발작업\기타작업\encar_crawler\weekly_update.bat\"" /SC WEEKLY /D WED /ST 09:00 /F
```
- `/D WED` = 매주 수요일, `/ST 09:00` = 오전 9시
- 등록 확인: `schtasks /Query /TN "EncarWeeklyUpdate" /V /FO LIST`
- 수동 테스트(즉시 1회 실행): `schtasks /Run /TN "EncarWeeklyUpdate"`
- 삭제: `schtasks /Delete /TN "EncarWeeklyUpdate" /F`

> **PC 전원**: 수요일 9시에 PC가 켜져 있어야 한다(크롤 수 시간 동안 유지). 절전 사용 시 작업 스케줄러 속성 → 조건 → "이 작업을 실행하기 위해 컴퓨터의 절전 모드 해제" 체크. 가급적 상시 전원 권장.

> **Git 인증**: 이미 자격증명이 Windows 자격증명 관리자에 저장돼 무인 push가 된다. 혹시 push가 인증을 요구하기 시작하면, 수동으로 `git push` 한 번 실행해 자격증명을 갱신하면 된다.

> **회사 와이파이에서 push 실패**: PC가 HQ_wifi에 붙어 있으면 보안 장비(Genian NAC)가 HTTPS를 가로채 push가 `SEC_E_UNTRUSTED_ROOT`로 실패한다. 우회하지 않는다. 감시 작업이 30분마다 다시 올리므로, 휴대폰 핫스팟으로 바뀌면 다음 시도에 사이트가 갱신된다(`logs/watchdog.log`의 "git push 완료" 줄). 지금 안 올린 커밋은 `python git_push.py`로 본다.

## 수동 실행 (테스트/임시 갱신)
```bash
python auto_update.py            # 주간 증분 갱신
python auto_update.py --full     # ⚠ 전체 초기화 후 풀 재크롤(수일 소요) — 판매된 차의 상세 · 체크포인트가 지워진다. 평소에는 쓰지 않는다
```

## 데이터 신선도 — 누적 관리
- **재고(L0)** 는 매주 `ids_all.json`을 새로 받아 **항상 현재 기준**. ✔
- **시세(L2)** 는 증분 수집이라 판매·삭제된 매물이 누적될 수 있음.
- 판매·삭제된 매물이 쌓이는 것은 정상이다 — 판매 이력(판매추정일 · 체류일 · 시세 산정의 최근 판매 비교 매물)이 이것으로 계산된다.
- `--full` 은 **정기적으로 돌리지 않는다**: 판매된 차의 상세가 지워져 판매 비교 매물 · 판매 속도 · 체류일이 사라지고, 수일이 걸려
  다음 주간 작업과 겹칠 수 있다(겹치면 실행 중인 프로세스를 보고 주간 작업이 건너뛴다 — lock 에 프로세스 번호). 데이터가 깨졌을 때만, 상세 파일을 백업한 뒤 쓴다(리뷰 11-05).
- 디스크: `python cleanup_old.py` (미리보기) → `--apply` (실제 삭제). 오래된 로그·zip·`__pycache__` 정리.

## 실패 시 동작
- 크롤/빌드 중 실패하면 그 회차는 중단되지만 **배포된 사이트는 그대로 유지**(직전 데이터). 로그(`logs/auto_*.log`)에 사유 기록.
- 체크포인트가 있어 다음 회차에 미수집분을 **이어서** 수집.
- 중복 실행 방지 락(`auto_update.lock`): 이전 실행이 안 끝났으면 이번 회차는 건너뜀(36시간 지난 락은 비정상으로 보고 무시).

## 최초 1회 디렉토리 정리 (현재 크롤 끝난 뒤)
```bash
python cleanup_old.py            # 무엇이 지워질지 미리보기
python cleanup_old.py --apply    # 실제 정리
```
지역별 ID 캐시(~480MB)는 다음 주간 자동 실행이 알아서 삭제·재생성한다.
