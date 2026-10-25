#!/bin/sh
# Запуск на macOS / Linux. Код доступа поменяйте на свой или удалите строку.
cd "$(dirname "$0")"
export SITE_CODE="тыква"
export PORT=8080
node server.js
