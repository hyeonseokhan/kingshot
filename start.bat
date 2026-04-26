@echo off
chcp 65001 > nul
cd /d "%~dp0"

REM Ruby + MSYS2 PATH 추가 (winget RubyInstaller 기본 경로 기준)
set "PATH=C:\Ruby33-x64\bin;C:\Ruby33-x64\msys64\ucrt64\bin;C:\Ruby33-x64\msys64\usr\bin;%PATH%"

REM Ruby 설치 확인
where ruby > nul 2>&1
if errorlevel 1 (
  echo.
  echo [error] Ruby 를 찾을 수 없습니다.
  echo 설치: winget install RubyInstallerTeam.RubyWithDevKit.3.3
  echo.
  pause
  exit /b 1
)

echo.
echo ================================================
echo  Kingshot Jekyll Local Server
echo  http://127.0.0.1:4000/    ^| Ctrl+C to stop
echo ================================================
echo.

bundle exec jekyll serve --host 127.0.0.1 --port 4000 --livereload

REM 서버 종료 후 창 유지 (오류 메시지 확인용)
pause
