@echo off
setlocal
cd /d "%~dp0"
set "NODE_RUNTIME=%CD%\vendor\node.exe"
if not exist "%NODE_RUNTIME%" set "NODE_RUNTIME=node"
echo AMISHNA MUSIC CMS: http://127.0.0.1:4175
start "" http://127.0.0.1:4175
"%NODE_RUNTIME%" "%CD%\scripts\dev.js"
if errorlevel 1 pause
