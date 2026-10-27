# 배포 가이드 — Cloudflare Workers 정적 자산 (무료)

## 운영 사이트
**https://encar-market-intel.fullsoup.workers.dev/**

> 실제 배포 형태는 **Cloudflare Workers Static Assets** (`*.workers.dev`)이며, Pages(`*.pages.dev`)가 아니다.
> 설정은 [wrangler.toml](wrangler.toml)의 `[assets] directory = "./web"`. GitHub 연동(Workers Builds)으로 **`git push` 시 자동 재배포**된다 — 파이프라인에 `wrangler` 호출 단계는 없다.
> `web/_headers`의 캐시 규칙(데이터/다운로드 5분, 코드 자산 1일)은 Workers 정적 자산에서도 정상 적용된다(2026-07-30 라이브 확인).

**주소 구조 (2026-10-27 교체)**
- `/` = **새 사이트**(시세 산정·묶음 산정·⚙ 환산 비율·시장 시황·데이터). 진입 파일은 `web/index.html`, 화면 코드는 `web/v2/`. `/v2/`도 같은 화면이다(검색 제외).
- `/old.html` = **이전 사이트**(같은 데이터로 매주 갱신, 위쪽에 새 사이트 안내 띠, 검색 제외). 이전 즐겨찾기 주소(`/#/overview` 등)는 `/old.html#/…`로 자동으로 넘어간다.
- 되돌리려면 교체 커밋을 `git revert`해 push한다(`web/index.html` ↔ `web/old.html`).

이 사이트는 **DB 없는 정적 사이트**입니다. 시세 산정·필터링·분위수 계산은 전부 브라우저에서 JS로 처리되므로, 상주 서버(Railway 등)가 **필요 없고 호스팅 비용이 0원**입니다. 서버 코드는 환산 비율 팀 수정을 Workers KV에 저장하는 작은 Worker(`/api/rates`, `worker/index.js`) 하나뿐입니다.

## 배포 반영 확인 (1줄)
```bash
curl -s https://encar-market-intel.fullsoup.workers.dev/data/meta.json | head -c 120
```
`collectedDate` 가 방금 크롤한 날짜면 반영 완료. (캐시 5분이라 push 후 최대 몇 분 지연)

## 구조 요약
- 배포 대상: **`web/` 폴더만** (HTML/CSS/JS + 미리 계산된 `data/*.json` + `downloads/*.csv`)
- 원천 데이터(`encar_output/` 약 1GB, `*.zip`)는 `.gitignore`로 제외 — 절대 커밋하지 않음
- 데이터 갱신: 로컬에서 `python build_data.py` → `web/data`·`web/downloads` 갱신 → 커밋·push → 자동 재배포

## 처음 1회 — GitHub 저장소 만들기
```bash
cd C:/개발작업/기타작업/encar_crawler
git init
git add .                     # .gitignore가 encar_output/·zip 자동 제외
git commit -m "엔카 마켓 인텔 정적 대시보드"
# GitHub에서 빈 저장소 생성 후:
git remote add origin https://github.com/<계정>/<레포명>.git
git branch -M main
git push -u origin main
```
> 커밋 전 확인: `git status` 에 `encar_output/` 나 `*.zip` 이 **안 보여야** 정상.
> 커밋 용량은 약 30MB(주로 매물 CSV 21MB + dataset.json 8.7MB) — GitHub 한도(파일당 100MB) 내.

## Cloudflare 연결 (이미 완료 — 재구축 시 참고)
1. https://dash.cloudflare.com → **Workers & Pages → Create → Workers → Connect to Git**
2. 위 GitHub 저장소 선택
3. 빌드 설정:
   - **Build command**: (비움 — 빌드 없음)
   - **Deploy command**: `npx wrangler deploy`
   - 자산 경로는 [wrangler.toml](wrangler.toml)의 `[assets] directory = "./web"` 가 결정
4. 저장 → 1~2분 후 `https://<worker>.<계정>.workers.dev` 로 공개

압축(brotli)·HTTPS·CDN이 자동 적용됩니다. push할 때마다 자동 재배포됩니다.

> **파일 크기 한도 25MiB**: 정적 자산 개별 파일이 25MiB를 넘으면 배포가 실패한다.
> 과거 `listings_compact.csv`가 29MB로 배포를 깨뜨린 사례 있음(커밋 `ccd3dc2`에서 컬럼 축소로 해결).
> 누적 이력은 주간 누적으로 계속 커지므로(2026-10 기준 CSV 21MB) `build_data.py`가 **`history_accumulated.zip`으로 압축**해 제공한다(2026-10-19 전환).
> 현재 최대 파일은 `listings_compact.csv` 약 11MB.

## 데이터 업데이트 워크플로
```bash
python build_data.py          # 크롤 최신본으로 재집계
git add web/data web/downloads
git commit -m "데이터 갱신: <날짜>"
git push                      # → Cloudflare 자동 재배포
```

## 사이트 점검 — 코드를 바꾼 뒤

```bash
python tools/qa_all.py
```
- 사이트 정적 점검, 저장 API, 엑셀 작성기, 차명 매칭, 성능 계산기 일치, 시세 엔진 일치를 한 번에 돌린다(약 4~5분).
- `--quick`은 일치 검증 둘을 빼고 1분 안에 끝난다.
- 하나라도 실패하면 종료 코드 1이다.
- 화면은 `site-worker` 미리보기(`node tools/dev_server.mjs`, http://127.0.0.1:8792/ · 이전 사이트 /old.html)로 본다.

## 환산 비율 저장소 연결 (기획안 D6 · 5.1.6) — ✅ 2026-10-27 연결함

- **연결한 것**
  - KV 저장소 `encar-rates`(ID `560f410dafd740fba1e8a624fe428f3e`)를 `wrangler.toml`에 넣었다. `main = "worker/index.js"`, `run_worker_first = ["/api/*"]`.
  - 수정 비밀번호는 Worker 비밀값 `RATES_PASSWORD`로 사용자가 직접 넣었다.
- **이 PC의 wrangler 로그인**: `npx.cmd wrangler@4 login`으로 했다(OAuth, 이 PC에 토큰 저장).
  - PowerShell 실행 정책 때문에 `npx` 대신 `npx.cmd`로 부른다.
  - 그만 쓰려면 `npx.cmd wrangler@4 logout`.
- **비밀번호를 바꾸려면**: `npx.cmd wrangler@4 secret put RATES_PASSWORD`로 새 값을 직접 입력한다.
- 아래는 처음 연결할 때의 절차다(다시 만들 때 참고).

### 처음 1회 절차(참고)

새 사이트의 ⚙ 환산 비율 화면은 팀이 고친 비율을 Cloudflare **Workers KV**에 저장한다.
- 코드: Worker `worker/index.js`(`/api/rates`), 사이트 `web/lib/rates_store.js` · `web/v2/rates.js`.
- 연결 전에는 초기값(`web/data/conversion_rates.json`)만 쓰고 [수정하기]가 막혀 있다.
- 사이트는 연결 전에도 그대로 동작한다.

**사용자가 Cloudflare 대시보드에서 할 일**(로그인 필요)
1. **Storage & Databases → Workers KV → Create**로 이름 `encar-rates` 저장소를 만든다. **Namespace ID**를 복사한다.
2. **Workers & Pages → encar-market-intel → Settings → Variables and Secrets → Add**에서 수정 비밀번호를 넣는다.
   - Type `Secret`, Name `RATES_PASSWORD`, Value = 팀이 쓸 비밀번호.
   - 비밀값은 배포해도 지워지지 않는다.
   - 메뉴가 안 보이면 3단계 배포 뒤에 넣는다. 그동안 저장은 "비밀번호 미설정" 안내가 뜬다.

**그다음(코드)** — Namespace ID를 받아 `wrangler.toml`을 아래처럼 바꾸고 커밋·push하면 Workers Builds가 배포한다.
```toml
name = "encar-market-intel"
main = "worker/index.js"
compatibility_date = "2025-01-01"

[assets]
directory = "./web"
binding = "ASSETS"
not_found_handling = "single-page-application"
run_worker_first = ["/api/*"]      # /api 는 Worker가 먼저 받는다(나머지는 지금처럼 정적 자산)

[[kv_namespaces]]
binding = "RATES"
id = "<1단계 Namespace ID>"
```

**확인**:
```bash
curl -s https://encar-market-intel.fullsoup.workers.dev/api/rates
```
- `{"ok":true,"store":true,"writable":true,"team":null}`가 나오면 연결된 것이다.
- `/#/price?view=rates`에서 [수정하기]가 열린다.
- 문제가 생기면 `wrangler.toml`을 이전 판으로 되돌려 push한다(정적 사이트로 돌아감).

**로컬 시험**:
- `node tools/worker_check.mjs`: API 시험(가짜 KV).
- `node tools/dev_server.mjs`: 미리보기 `http://127.0.0.1:8792/`. Worker 코드를 그대로 쓰고, 가짜 KV는 `encar_output/dev_kv.json`, 비밀번호는 `dev`다.

## (선택) 커스텀 도메인
Cloudflare → Workers & Pages → 해당 Worker → Settings → **Domains & Routes** 에서 보유 도메인 연결(무료). 도메인 자체 구매 비용만 발생.

## 참고: 왜 DB가 필요 없나
- 재고/시세/트렌드/인사이트 = 빌드 시점에 `build_data.py`가 집계해 JSON으로 고정
- 시세조회의 임의 조건 필터링 = `dataset.json`(15만 행 컬럼형)을 브라우저가 받아 JS로 즉시 계산
- 따라서 쿼리용 DB·API 서버가 없음 → 정적 호스팅 무료 티어로 충분
