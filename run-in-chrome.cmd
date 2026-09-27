@echo off
setlocal

rem Runs the Jev Blocker extension in Chrome on Windows.
rem
rem   run-in-chrome.cmd          launch Chrome with the extension loaded
rem   run-in-chrome.cmd verify   check it loads and that blocking works, then exit
rem
rem Chrome 137 removed the --load-extension flag, so this drives the DevTools
rem Protocol command Extensions.loadUnpacked instead. A dedicated profile is
rem used so your normal Chrome profile is untouched, and your Jev API key
rem persists between runs.

set "ROOT=%~dp0"
set "EXT=%ROOT%extension"
set "PROFILE=%LOCALAPPDATA%\JevBlocker\chrome-profile"
set "SCRIPT=%ROOT%tools\chrome-load-extension.mjs"

if not exist "%EXT%\manifest.json" (
  echo Could not find the extension at:
  echo   %EXT%
  echo Run this script from the project root.
  exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js was not found on PATH, so this launcher cannot run.
  echo.
  echo Either install Node from https://nodejs.org/ , or load the extension
  echo manually:
  echo.
  echo   1. Open chrome://extensions
  echo   2. Turn on Developer mode
  echo   3. Click "Load unpacked" and choose:
  echo      %EXT%
  echo.
  exit /b 1
)

if /i "%~1"=="verify" (
  node "%SCRIPT%" "%EXT%"
  exit /b %errorlevel%
)

echo Launching Chrome with the extension loaded...
echo Profile: %PROFILE%
echo.
node "%SCRIPT%" "%EXT%" --headed --keep-open --profile="%PROFILE%"
