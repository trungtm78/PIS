@echo off
rem Entrypoint of the database image. The first start creates the cluster on the data volume (owner role and its password from the secret file, the database of the
rem product, the role and the database of Keycloak); every start then runs the server in the foreground. Passwords are read from files and never printed.
setlocal
set "PATH=C:\pgsql\bin;%PATH%"
set "SECRETS=C:\run\secrets"
set "READY=C:\pgdata\machvon-initialised"

if exist "%READY%" goto serve
if exist "%PGDATA%\PG_VERSION" (
  echo db: the data volume holds a cluster whose first start did not finish. Remove the volume and start again. 1>&2
  exit /b 70
)
for %%S in (db_owner_password keycloak_db_password) do (
  if not exist "%SECRETS%\%%S" (
    echo db: the secret file %%S is missing 1>&2
    exit /b 78
  )
)
rem UTF-8, ICU collation en-US (the same order on every host), passwords stored as SCRAM-SHA-256.
initdb --pgdata="%PGDATA%" --username=machvon_owner --pwfile="%SECRETS%\db_owner_password" --encoding=UTF8 --locale=C --locale-provider=icu --icu-locale=en-US --auth-host=scram-sha-256 --auth-local=scram-sha-256 > nul
if errorlevel 1 exit /b 71
rem Inside the container the loopback address is trusted (the health check and the host scripts through `docker exec`); every other address must give a password.
(
  echo host all all 127.0.0.1/32 trust
  echo host all all ::1/128 trust
  echo host all all all scram-sha-256
) > "%PGDATA%\pg_hba.conf"
pg_ctl --pgdata="%PGDATA%" --options="-c listen_addresses=127.0.0.1" --wait --silent start > nul
if errorlevel 1 exit /b 72
psql --quiet --set ON_ERROR_STOP=1 --host=127.0.0.1 --username=machvon_owner --dbname=postgres --file=C:\pgsql\machvon\db-init.sql
if errorlevel 1 (
  pg_ctl --pgdata="%PGDATA%" --wait --silent --mode=fast stop > nul
  exit /b 73
)
pg_ctl --pgdata="%PGDATA%" --wait --silent --mode=fast stop > nul
if errorlevel 1 exit /b 74
echo initialised> "%READY%"

:serve
postgres -D "%PGDATA%" -c listen_addresses=* %*
exit /b %ERRORLEVEL%
