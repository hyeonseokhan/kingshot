@echo off
chcp 65001 > nul
cd /d "%~dp0"

REM Ruby + MSYS2 PATH (winget RubyInstaller default)
set "PATH=C:\Ruby33-x64\bin;C:\Ruby33-x64\msys64\ucrt64\bin;C:\Ruby33-x64\msys64\usr\bin;%PATH%"

where ruby > nul 2>&1
if errorlevel 1 (
  echo.
  echo [error] Ruby not found in PATH.
  echo Install with: winget install RubyInstallerTeam.RubyWithDevKit.3.3
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

pause