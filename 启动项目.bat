@echo off
setlocal
cd /d "%~dp0frontend"
echo.
echo   Dev run: compiles the Rust backend and opens the real window.
echo   The first compile takes a few minutes. For UI-only work use ui-preview.bat.
echo.
if not exist node_modules (
  echo Installing frontend dependencies...
  call npm install --package-lock=false
  if errorlevel 1 ( pause & exit /b 1 )
)
call npm run tauri -- dev
if errorlevel 1 pause
endlocal
