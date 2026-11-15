@echo off
rem Entrypoint of the Keycloak image: every NAME_FILE variable below becomes NAME with the first line of the file, then the server starts. Values are never printed.
setlocal DisableDelayedExpansion
for %%N in (KC_DB_PASSWORD KC_BOOTSTRAP_ADMIN_PASSWORD LDAP_BIND_CREDENTIAL) do call :load %%N || exit /b 78
call C:\keycloak\bin\kc.bat %*
exit /b %ERRORLEVEL%

:load
call set "SECRET_FILE=%%%1_FILE%%"
if not defined SECRET_FILE exit /b 0
if not exist "%SECRET_FILE%" (
  echo keycloak: %1_FILE names a file that cannot be read 1>&2
  exit /b 1
)
set /p %1=<"%SECRET_FILE%"
set "%1_FILE="
exit /b 0
