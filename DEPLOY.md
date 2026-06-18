# 배포 가이드 — Cloudflare Pages (무료)

이 사이트는 **DB·백엔드 없는 순수 정적 사이트**입니다. 시세조회 필터링·분위수 계산은 전부 브라우저에서 JS로 처리되므로, 상주 서버(Railway 등)가 **필요 없고 호스팅 비용이 0원**입니다.

## 구조 요약
- 배포 대상: **`web/` 폴더만** (HTML/CSS/JS + 미리 계산된 `data/*.json` + `downloads/*.csv`)
- 원천 데이터(`encar_output/` 약 1GB, `*.zip`)는 `.gitignore`로 제외 — 절대 커밋하지 않음
- 데이터 갱신: 로컬에서 `python build_data.py` → `web/data`·`web/downloads` 갱신 → 커밋·push → 자동 재배포

## 처음 1회 — GitHub 저장소 만들기
```bash
cd D:/기타작업/encar_crawler
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

## Cloudflare Pages 연결 (대시보드, 5분)
1. https://dash.cloudflare.com → **Workers & Pages → Create → Pages → Connect to Git**
2. 위 GitHub 저장소 선택
3. 빌드 설정:
   - **Framework preset**: `None`
   - **Build command**: (비움)
   - **Build output directory**: `web`
4. **Save and Deploy** → 1~2분 후 `https://<프로젝트>.pages.dev` 로 공개

압축(brotli)·HTTPS·CDN·무제한 대역폭이 자동 적용됩니다.
push할 때마다 자동 재배포됩니다.

## 데이터 업데이트 워크플로
```bash
python build_data.py          # 크롤 최신본으로 재집계
git add web/data web/downloads
git commit -m "데이터 갱신: <날짜>"
git push                      # → Cloudflare 자동 재배포
```

## (선택) 커스텀 도메인
Cloudflare Pages → 프로젝트 → Custom domains 에서 보유 도메인 연결(무료). 도메인 자체 구매 비용만 발생.

## 참고: 왜 DB가 필요 없나
- 재고/시세/트렌드/인사이트 = 빌드 시점에 `build_data.py`가 집계해 JSON으로 고정
- 시세조회의 임의 조건 필터링 = `dataset.json`(15만 행 컬럼형)을 브라우저가 받아 JS로 즉시 계산
- 따라서 쿼리용 DB·API 서버가 없음 → 정적 호스팅 무료 티어로 충분
