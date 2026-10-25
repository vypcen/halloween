@echo off
chcp 65001 >nul
REM Запуск на Windows. Код доступа поменяйте на свой или удалите строку.
cd /d "%~dp0"
set SITE_CODE=тыква
set PORT=8080
node server.js
pause
