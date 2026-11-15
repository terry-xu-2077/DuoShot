@echo off
setlocal
cd /d "%~dp0frontend"
echo.
echo   UI preview only (in the browser, no Rust build): http://localhost:1420
echo   Edits under frontend\src reload automatically. Press Ctrl+C to stop.
echo.
if not exist node_modules (
  echo Installing frontend dependencies...
  call npm install --package-lock=false
  if errorlevel 1 ( pause & exit /b 1 )
)
call npm run dev
if errorlevel 1 pause
endlocal
