# escape=`
# Build context: this directory (infra/onprem-windows/docker).
# clamd for WINDOWS containers (process isolation): the malware scan of every upload (HSKT YCK.07), the official Windows build of ClamAV, same version as the Linux
# deployment. Unlike the Linux deployment the signatures are NOT in the image: the entrypoint fetches them at the first start into the signature volume, and the host
# refreshes them every day (host/daily.ps1 runs freshclam in the container). The container needs the way out to database.clamav.net for that.
ARG WINDOWS_TAG=ltsc2025

FROM mcr.microsoft.com/windows/servercore:${WINDOWS_TAG} AS build
SHELL ["powershell", "-NoProfile", "-Command", "$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue';"]
ARG CLAMAV_URL
ARG CLAMAV_SHA256
RUN curl.exe -fsSL --retry 3 -o C:\clamav.zip $env:CLAMAV_URL; `
    if ((Get-FileHash C:\clamav.zip -Algorithm SHA256).Hash -ne $env:CLAMAV_SHA256) { throw 'the ClamAV archive does not have the pinned SHA-256' }; `
    Expand-Archive C:\clamav.zip C:\clamav-unpacked; Move-Item (Get-ChildItem C:\clamav-unpacked | Select-Object -First 1).FullName C:\clamav; Remove-Item C:\clamav.zip

FROM mcr.microsoft.com/windows/servercore:${WINDOWS_TAG}
LABEL org.opencontainers.image.title="machvon-clamav-windows" `
      org.opencontainers.image.description="clamd for Windows containers"
COPY --from=build C:\clamav C:\clamav
COPY clamd.conf freshclam.conf clamav-entrypoint.cmd C:\clamav\
USER ContainerAdministrator
RUN mkdir C:\clamav\database C:\clamav\temp && icacls C:\clamav\database /grant *S-1-5-93-2-2:(OI)(CI)M /Q && icacls C:\clamav\temp /grant *S-1-5-93-2-2:(OI)(CI)M /Q
USER ContainerUser
WORKDIR C:\clamav
EXPOSE 3310
HEALTHCHECK --interval=30s --timeout=10s --start-period=600s --retries=5 `
  CMD ["C:\\clamav\\clamdscan.exe", "--config-file=C:\\clamav\\clamd.conf", "--ping", "1"]
ENTRYPOINT ["C:\\Windows\\System32\\cmd.exe", "/S", "/C", "C:\\clamav\\clamav-entrypoint.cmd"]
