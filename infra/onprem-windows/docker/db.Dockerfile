# escape=`
# Build context: this directory (infra/onprem-windows/docker).
# MACHVON database image for WINDOWS containers (process isolation; the base must match the build of the host: ltsc2025 on Windows Server 2025).
# PostgreSQL 18 from the official Windows binaries of EDB with pgvector (V001 of the migrations creates the extension), compiled here from its source with the
# Microsoft C++ build tools against exactly these binaries (the archive is unpacked with tar: pgAdmin, which is left out, has paths Expand-Archive refuses). The build tools stay in the build stage; the runtime is Nano Server and runs as ContainerUser.
# Not in this image (they do not exist for Windows): pgBackRest and pgaudit. Backups are logical dumps (host/backup.ps1); the read-only BI port is not offered.
ARG WINDOWS_TAG=ltsc2025

FROM mcr.microsoft.com/windows/servercore:${WINDOWS_TAG} AS build
SHELL ["powershell", "-NoProfile", "-Command", "$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue';"]
ARG POSTGRES_URL
ARG POSTGRES_SHA256
RUN curl.exe -fsSL --retry 3 -o C:\pg.zip $env:POSTGRES_URL; `
    if ((Get-FileHash C:\pg.zip -Algorithm SHA256).Hash -ne $env:POSTGRES_SHA256) { throw 'the PostgreSQL archive does not have the pinned SHA-256' }; `
    New-Item -ItemType Directory C:\pg-unpacked | Out-Null; `
    tar.exe -xf C:\pg.zip -C C:\pg-unpacked --exclude 'pgsql/pgAdmin 4' --exclude pgsql/StackBuilder --exclude pgsql/doc --exclude pgsql/symbols; `
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path C:\pg-unpacked\pgsql\bin\postgres.exe)) { throw 'the PostgreSQL archive did not unpack' }; `
    Move-Item C:\pg-unpacked\pgsql C:\pgsql; Remove-Item C:\pg-unpacked, C:\pg.zip
# The C++ build tools of Microsoft (the installer is checked by its signature: the address always serves the current release).
RUN curl.exe -fsSL --retry 3 -o C:\vs_buildtools.exe https://aka.ms/vs/17/release/vs_buildtools.exe; `
    $signature = Get-AuthenticodeSignature C:\vs_buildtools.exe; `
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation') { throw 'the build tools installer is not signed by Microsoft' }; `
    $install = Start-Process -Wait -PassThru C:\vs_buildtools.exe -ArgumentList '--quiet', '--wait', '--norestart', '--nocache', '--installPath', 'C:\BuildTools', '--add', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '--add', 'Microsoft.VisualStudio.Component.Windows11SDK.22621'; `
    if ($install.ExitCode -ne 0 -and $install.ExitCode -ne 3010) { throw ('the build tools installer ended with ' + $install.ExitCode) }; `
    Remove-Item C:\vs_buildtools.exe
ARG PGVECTOR_URL
ARG PGVECTOR_SHA256
RUN curl.exe -fsSL --retry 3 -o C:\pgvector.tar.gz $env:PGVECTOR_URL; `
    if ((Get-FileHash C:\pgvector.tar.gz -Algorithm SHA256).Hash -ne $env:PGVECTOR_SHA256) { throw 'the pgvector archive does not have the pinned SHA-256' }; `
    New-Item -ItemType Directory C:\pgvector | Out-Null; tar.exe -xzf C:\pgvector.tar.gz -C C:\pgvector --strip-components 1; `
    $env:PGROOT = 'C:\pgsql'; `
    cmd /c 'call C:\BuildTools\VC\Auxiliary\Build\vcvars64.bat && cd /d C:\pgvector && nmake /NOLOGO /F Makefile.win && nmake /NOLOGO /F Makefile.win install'; `
    if ($LASTEXITCODE -ne 0) { throw 'pgvector did not build' }; `
    if (-not (Test-Path C:\pgsql\lib\vector.dll)) { throw 'vector.dll was not installed' }; `
    $runtime = @(Get-ChildItem 'C:\BuildTools\VC\Redist\MSVC\*\x64\Microsoft.VC*.CRT\*.dll'); `
    if ($runtime.Count -eq 0) { throw 'the C++ runtime libraries were not found' }; `
    foreach ($library in $runtime) { if (-not (Test-Path (Join-Path C:\pgsql\bin $library.Name))) { Copy-Item $library.FullName C:\pgsql\bin } }

FROM mcr.microsoft.com/windows/nanoserver:${WINDOWS_TAG}
LABEL org.opencontainers.image.title="machvon-db-windows" `
      org.opencontainers.image.description="PostgreSQL 18 with pgvector for Windows containers"
COPY --from=build C:\pgsql C:\pgsql
COPY db-entrypoint.cmd db-init.sql C:\pgsql\machvon\
ENV PGDATA=C:\pgdata\data
USER ContainerUser
EXPOSE 5432
HEALTHCHECK --interval=10s --timeout=5s --start-period=60s --retries=6 `
  CMD ["C:\\pgsql\\bin\\pg_isready.exe", "--quiet", "--host", "127.0.0.1", "--username", "machvon_owner", "--dbname", "machvon"]
ENTRYPOINT ["C:\\Windows\\System32\\cmd.exe", "/S", "/C", "C:\\pgsql\\machvon\\db-entrypoint.cmd"]
