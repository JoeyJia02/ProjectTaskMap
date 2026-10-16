@echo off
cd /d "%~dp0"
node scripts\start-local.mjs
if errorlevel 1 (
  echo Task Map could not start. Please share the error above, without .env contents.
  pause
  exit /b 1
)
