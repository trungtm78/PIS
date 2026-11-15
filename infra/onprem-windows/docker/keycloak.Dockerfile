# escape=`
# Build context: the `infra` directory of the build pack (docker build -f infra/onprem-windows/docker/keycloak.Dockerfile infra).
# Keycloak for WINDOWS containers (process isolation): the distribution of the Keycloak project on a Java 21 runtime of Eclipse Temurin, on Nano Server, as ContainerUser.
# Same version as the Linux deployment (infra/onprem/compose/compose.yaml). The realm of the product is copied in and imported at the first start (--import-realm).
# The login themes of the edition of the pack (keycloak/themes; the public edition ships pis-public) are copied into the themes directory of the server: a theme is
# only files, the realm selects it by name (host\install.ps1 writes the presentation of the realm with tools\keycloak-admin.mjs apply-presentation).
# The server is built here for PostgreSQL and the /idp path, so that the start does not rewrite the installation (start --optimized).
ARG WINDOWS_TAG=ltsc2025

FROM mcr.microsoft.com/windows/servercore:${WINDOWS_TAG} AS build
SHELL ["powershell", "-NoProfile", "-Command", "$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue';"]
ARG JAVA_URL
ARG JAVA_SHA256
ARG KEYCLOAK_URL
ARG KEYCLOAK_SHA256
RUN curl.exe -fsSL --retry 3 -o C:\java.zip $env:JAVA_URL; `
    if ((Get-FileHash C:\java.zip -Algorithm SHA256).Hash -ne $env:JAVA_SHA256) { throw 'the Java archive does not have the pinned SHA-256' }; `
    Expand-Archive C:\java.zip C:\java-unpacked; Move-Item (Get-ChildItem C:\java-unpacked | Select-Object -First 1).FullName C:\java; Remove-Item C:\java.zip; `
    curl.exe -fsSL --retry 3 -o C:\keycloak.zip $env:KEYCLOAK_URL; `
    if ((Get-FileHash C:\keycloak.zip -Algorithm SHA256).Hash -ne $env:KEYCLOAK_SHA256) { throw 'the Keycloak archive does not have the pinned SHA-256' }; `
    Expand-Archive C:\keycloak.zip C:\keycloak-unpacked; Move-Item (Get-ChildItem C:\keycloak-unpacked | Select-Object -First 1).FullName C:\keycloak; Remove-Item C:\keycloak.zip
ENV JAVA_HOME=C:\java
RUN & C:\keycloak\bin\kc.bat build --db=postgres --http-relative-path=/idp; if ($LASTEXITCODE -ne 0) { throw 'kc build failed' }

FROM mcr.microsoft.com/windows/nanoserver:${WINDOWS_TAG}
LABEL org.opencontainers.image.title="machvon-keycloak-windows" `
      org.opencontainers.image.description="Keycloak with the realm of MACHVON for Windows containers"
COPY --from=build C:\java C:\java
COPY --from=build C:\keycloak C:\keycloak
COPY keycloak/machvon-realm.json C:\keycloak\data\import\machvon-realm.json
COPY keycloak/themes C:\keycloak\themes
COPY onprem-windows/docker/keycloak-entrypoint.cmd C:\keycloak\bin\machvon-entrypoint.cmd
ENV JAVA_HOME=C:\java `
    KC_DB=postgres `
    KC_HTTP_RELATIVE_PATH=/idp
# The server writes below its data directory (temporary files); nothing else of the installation is writable by the service user (S-1-5-93-2-2 is ContainerUser).
USER ContainerAdministrator
RUN icacls C:\keycloak\data /grant *S-1-5-93-2-2:(OI)(CI)M /T /Q
USER ContainerUser
EXPOSE 8080
ENTRYPOINT ["C:\\Windows\\System32\\cmd.exe", "/S", "/C", "C:\\keycloak\\bin\\machvon-entrypoint.cmd"]
CMD ["start", "--optimized", "--import-realm"]
