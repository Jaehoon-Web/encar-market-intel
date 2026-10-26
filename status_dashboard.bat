@echo off
chcp 65001 >nul
REM ============================================================
REM  엔카 크롤 진행 대시보드 — 더블클릭하면 브라우저로 진행 상황을 연다
REM  (로그만 읽음, 크롤에 영향 없음 / 이 창을 닫으면 대시보드만 꺼짐)
REM ============================================================
cd /d "%~dp0"
start "" http://127.0.0.1:8790
"%LOCALAPPDATA%\Programs\Python\Python312\python.exe" -X utf8 status_server.py