@echo off
rem Entrypoint of the clamav image: fetches the signatures when the volume has none yet, then runs clamd in the foreground.
setlocal
cd /d C:\clamav
if not exist C:\clamav\database\main.cvd if not exist C:\clamav\database\main.cld (
  freshclam.exe --config-file=C:\clamav\freshclam.conf --stdout
  if errorlevel 1 (
    echo clamav: the signatures could not be fetched 1>&2
    exit /b 69
  )
)
clamd.exe --config-file=C:\clamav\clamd.conf --foreground
exit /b %ERRORLEVEL%
