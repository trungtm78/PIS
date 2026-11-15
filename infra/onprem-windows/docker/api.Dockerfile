# escape=`
# MACHVON api and workers image for WINDOWS containers (process isolation), built on the server from the build pack of scripts/onprem-windows-pack.mjs
# (context: the root of the pack). One image serves both roles: WORKERS_ENABLED=false is the request-serving process, WORKERS_ENABLED=true runs the background jobs.
# The pack carries COMPILED JavaScript (no TypeScript source, no test, no development dependency), so the image needs Node and nothing else; it runs as ContainerUser.
ARG WINDOWS_TAG=ltsc2025

FROM mcr.microsoft.com/windows/servercore:${WINDOWS_TAG} AS node
SHELL ["powershell", "-NoProfile", "-Command", "$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue';"]
ARG NODE_URL
ARG NODE_SHA256
RUN curl.exe -fsSL --retry 3 -o C:\node.zip $env:NODE_URL; `
    if ((Get-FileHash C:\node.zip -Algorithm SHA256).Hash -ne $env:NODE_SHA256) { throw 'the Node archive does not have the pinned SHA-256' }; `
    Expand-Archive C:\node.zip C:\node-unpacked; Move-Item (Get-ChildItem C:\node-unpacked | Select-Object -First 1).FullName C:\node-full; Remove-Item C:\node.zip; `
    New-Item -ItemType Directory C:\node | Out-Null; Copy-Item C:\node-full\node.exe, C:\node-full\LICENSE C:\node
# The runtime only runs node: npm, npx and corepack are not copied.

FROM mcr.microsoft.com/windows/nanoserver:${WINDOWS_TAG}
LABEL org.opencontainers.image.title="machvon-api-windows" `
      org.opencontainers.image.description="MACHVON api and workers for Windows containers"
COPY --from=node C:\node C:\node
COPY api/app C:\app
COPY infra/onprem-windows/docker/secret-env.mjs infra/onprem-windows/docker/secret-files.mjs infra/onprem-windows/docker/link-workspaces.mjs C:\app\
COPY tools C:\app\tools
ENV NODE_ENV=production `
    PORT=3000 `
    WORKERS_ENABLED=false `
    MIGRATIONS_DIR=C:\app\db\migrations `
    ERROR_CODES_PATH=C:\app\Design\MACHVON_Design\03_Engineering\error_codes.json `
    MACHVON_OBJECT_ROOT=C:\data\objects `
    MACHVON_INVITATION_OUTBOX_DIR=C:\data\invitations
# The workspace packages are linked the way npm links them (node_modules\@machvon\<name> -> packages\<name>); the data directories are the mount points of the volumes.
USER ContainerAdministrator
RUN C:\node\node.exe C:\app\link-workspaces.mjs && mkdir C:\data\objects C:\data\invitations
USER ContainerUser
WORKDIR C:\app\apps\api
EXPOSE 3000
# Liveness only: it asks nothing of the database, so a database outage does not restart healthy processes (docs/runbooks/api-runtime.md).
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=3 `
  CMD ["C:\\node\\node.exe", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health/live').then((r)=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["C:\\node\\node.exe", "--disable-warning=ExperimentalWarning", "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--import", "file:///C:/app/secret-env.mjs"]
CMD ["--import", "./scripts/ts-register.mjs", "src/serve.ts"]
