# 자동화 가이드 — 주간 크롤링 → 사이트 자동 갱신

매주 **수요일 09:00**, 크롤링부터 사이트 배포까지 무인 자동 실행하는 루틴.

## 전체 흐름
```
[매주 수 09:00] Windows 작업 스케줄러
      ↓ weekly_update.bat → auto_update.py
1. ids_*.json 캐시 삭제   (신규 매물 반영 강제 — 아래 ★ 참조)
2. python run.py --fresh  (Stage1 ID → 2 상세 → 3 성능점검 → process → clean)
3. python build_data.py   (web/data·web/downloads 재생성)
4. git add/commit/push    (Cloudflare 자동 재배포)
```

### ★ 왜 캐시를 먼저 지우나 (중요)
`crawler.py`는 지역별 ID 캐시(`ids_국산_*.json` 등)가 있으면 **API를 다시 조회하지 않고 캐시를 재사용**한다(crawler.py 344~347행). 그래서 `--fresh`만으로는 **신규 매물이 반영되지 않는다.** `auto_update.py`가 매 실행 시 `ids_*.json`을 삭제해 Stage 1이 API를 새로 조회하도록 강제한다.
- 체크포인트(`details_done_ids.json`·`inspect_done_ids.json`)는 보존 → Stage 2/3은 **신규분만** 수집하므로 주간 실행은 수 시간 내 완료.

## 구성 파일
| 파일 | 역할 |
|------|------|
| `auto_update.py` | 오케스트레이터(락·로깅·에러처리·단계 실행) |
| `weekly_update.bat` | 작업 스케줄러용 런처(Python 경로 고정 호출) |
| `cleanup_old.py` | 오래된 로그·캐시 정리(크롤 완료 후 1회/수시) |
| `logs/` | 실행 로그(자동 생성, git 제외) |

## 1회 설정 — 작업 스케줄러 등록 (관리자 명령 프롬프트)
```cmd
schtasks /Create /TN "EncarWeeklyUpdate" /TR "D:\기타작업\encar_crawler\weekly_update.bat" /SC WEEKLY /D WED /ST 09:00 /RL HIGHEST /F
```
- `/D WED` = 매주 수요일, `/ST 09:00` = 오전 9시
- 등록 확인: `schtasks /Query /TN "EncarWeeklyUpdate" /V /FO LIST`
- 수동 테스트(즉시 1회 실행): `schtasks /Run /TN "EncarWeeklyUpdate"`
- 삭제: `schtasks /Delete /TN "EncarWeeklyUpdate" /F`

> **PC 전원**: 수요일 9시에 PC가 켜져 있어야 한다(크롤 수 시간 동안 유지). 절전 사용 시 작업 스케줄러 속성 → 조건 → "이 작업을 실행하기 위해 컴퓨터의 절전 모드 해제" 체크. 가급적 상시 전원 권장.

> **Git 인증**: 이미 자격증명이 Windows 자격증명 관리자에 저장돼 무인 push가 된다. 혹시 push가 인증을 요구하기 시작하면, 수동으로 `git push` 한 번 실행해 자격증명을 갱신하면 된다.

## 수동 실행 (테스트/임시 갱신)
```bash
python auto_update.py            # 주간 증분 갱신
python auto_update.py --full     # 전체 초기화 후 풀 재크롤(수일 소요·주말 권장)
```

## 데이터 신선도 — 누적 관리
- **재고(L0)** 는 매주 `ids_all.json`을 새로 받아 **항상 현재 기준**. ✔
- **시세(L2)** 는 증분 수집이라 판매·삭제된 매물이 누적될 수 있음.
- 정리 방법(택1):
  - 월 1회 정도 `python auto_update.py --full` 실행(완전 재수집, 수일). 또는
  - 한가한 주말에 수동 1회.
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
