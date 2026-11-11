@echo off
REM Stop hook: chan Claude Code dung lai cho den khi PROGRESS.md co sentinel
set "PF=%~dp0..\..\PROGRESS.md"
findstr /R /C:"^STATUS: *ALL_MILESTONES_DONE" /C:"^STATUS: *BLOCKED" "%PF%" >nul 2>&1
if %ERRORLEVEL% EQU 0 exit /b 0
echo {"decision":"block","reason":"PROGRESS.md has no STATUS: ALL_MILESTONES_DONE or STATUS: BLOCKED yet. Read PROGRESS.md, identify the next task and execute it immediately. Do NOT ask the user whether to continue."}
exit /b 0
