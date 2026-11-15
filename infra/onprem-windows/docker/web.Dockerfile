# escape=`
# MACHVON web and edge image for WINDOWS containers (process isolation), built on the server from the build pack (context: the root of the pack).
# nginx for Windows serves the built single-page application, terminates TLS with the certificate mounted from the host, sends the security headers of the product
# (the pack renders infra/onprem/nginx for Windows) and proxies /api/ to the api and /idp/ to Keycloak, so that a browser and the mobile application see one origin.
# The web build names one public origin (the OIDC issuer is compiled in): another origin is another pack and another image.
ARG WINDOWS_TAG=ltsc2025

FROM mcr.microsoft.com/windows/servercore:${WINDOWS_TAG} AS nginx
SHELL ["powershell", "-NoProfile", "-Command", "$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue';"]
ARG NGINX_URL
ARG NGINX_SHA256
RUN curl.exe -fsSL --retry 3 -o C:\nginx.zip $env:NGINX_URL; `
    if ((Get-FileHash C:\nginx.zip -Algorithm SHA256).Hash -ne $env:NGINX_SHA256) { throw 'the nginx archive does not have the pinned SHA-256' }; `
    Expand-Archive C:\nginx.zip C:\nginx-unpacked; Move-Item (Get-ChildItem C:\nginx-unpacked | Select-Object -First 1).FullName C:\nginx; Remove-Item C:\nginx.zip; `
    Remove-Item -Recurse -Force C:\nginx\html, C:\nginx\contrib, C:\nginx\docs -ErrorAction SilentlyContinue; `
    Get-ChildItem C:\nginx\conf -Exclude mime.types | Remove-Item -Recurse -Force

FROM mcr.microsoft.com/windows/nanoserver:${WINDOWS_TAG}
LABEL org.opencontainers.image.title="machvon-web-windows" `
      org.opencontainers.image.description="MACHVON web and edge for Windows containers"
COPY --from=nginx C:\nginx C:\nginx
COPY web/dist C:\nginx\html
COPY web/nginx C:\nginx\conf
COPY infra/onprem-windows/docker/nginx.conf C:\nginx\conf\nginx.conf
# nginx writes its pid, its temporary files and the access log only (S-1-5-93-2-2 is ContainerUser); the logs directory is the mount point of a volume.
USER ContainerAdministrator
RUN (if not exist C:\nginx\temp mkdir C:\nginx\temp) && (if not exist C:\nginx\logs mkdir C:\nginx\logs) && icacls C:\nginx\temp /grant *S-1-5-93-2-2:(OI)(CI)M /Q && icacls C:\nginx\logs /grant *S-1-5-93-2-2:(OI)(CI)M /Q
USER ContainerUser
WORKDIR C:\nginx
EXPOSE 8080 8443
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 `
  CMD ["C:\\Windows\\System32\\curl.exe", "--fail", "--silent", "--output", "NUL", "http://127.0.0.1:8080/healthz"]
ENTRYPOINT ["C:\\nginx\\nginx.exe", "-p", "C:\\nginx"]
