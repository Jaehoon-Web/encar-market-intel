@echo off
REM ============================================================
REM  엔카 주간 자동 갱신 런처 (작업 스케줄러: 매주 수요일 09:00)
REM  크롤링 -> 정제 -> 사이트 빌드 -> Git 자동 배포
REM ============================================================
cd /d D:\기타작업\encar_crawler
"C:\Users\f\AppData\Local\Programs\Python\Python312\python.exe" auto_update.py %*
