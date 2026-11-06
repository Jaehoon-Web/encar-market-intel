@echo off
chcp 65001 >nul
REM ============================================================
REM  엔카 주간 자동 갱신 런처 (작업 스케줄러: 매주 수요일 09:00)
REM  크롤링 -> 정제 -> 사이트 빌드 -> Git 자동 배포
REM  chcp 65001: 이 파일(UTF-8)의 한글 주석이 cp949로 잘못 읽히지 않도록
REM  %~dp0 = 이 bat 파일이 있는 폴더 (한글 경로를 직접 쓰지 않기 위해)
REM ============================================================
REM  파이썬이 없거나 auto_update.py 가 0이 아닌 코드로 끝나면 logs\weekly_bat.log 에 한 줄 남긴다
REM  (로그를 만들기 전에 끝난 실행도 알 수 있게 — 감시 작업의 '주간 실행 시작 못 함' 경고와 함께, 리뷰 D6-10)
cd /d "%~dp0"
if not exist logs mkdir logs
set "PYEXE=%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
if not exist "%PYEXE%" goto nopython
"%PYEXE%" auto_update.py %*
set "RC=%errorlevel%"
if not "%RC%"=="0" >>logs\weekly_bat.log echo [%date% %time%] auto_update.py %* 종료 코드 %RC%
exit /b %RC%

:nopython
>>logs\weekly_bat.log echo [%date% %time%] 파이썬을 찾지 못해 시작하지 못함: %PYEXE%
exit /b 9
