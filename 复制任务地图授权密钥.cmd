@echo off
cd /d "%~dp0"
node scripts\copy-owner-key.mjs
if errorlevel 1 pause
