@echo off
rem run from wherever this script lives — works on any machine/drive
cd /d %~dp0
rem optional per-machine overrides, e.g.: set HUB_PROJECTS_ROOT=D:\Projects
if exist hub-env.cmd call hub-env.cmd
if not exist data mkdir data
rem keep the previous run's log: a crash's last lines live there, and a
rem restart used to overwrite them before anyone could read them
if exist data\hub.prev.log del data\hub.prev.log
if exist data\hub.log move /y data\hub.log data\hub.prev.log >nul
npm run start > data\hub.log 2>&1
