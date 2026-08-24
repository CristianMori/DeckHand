@echo off
rem run from wherever this script lives — works on any machine/drive
cd /d %~dp0
rem optional per-machine overrides, e.g.: set HUB_PROJECTS_ROOT=D:\Projects
if exist hub-env.cmd call hub-env.cmd
if not exist data mkdir data
npm run start > data\hub.log 2>&1
