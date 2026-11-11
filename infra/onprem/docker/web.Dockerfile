# syntax=docker/dockerfile:1.7
# MACHVON web and edge image, linux/amd64 and linux/arm64: the built single-page application served by an unprivileged nginx that also terminates TLS,
# sends the security headers (infra/onprem/nginx) and proxies /api/ to the api and /idp/ to Keycloak, so the browser sees one origin.
#
# The OIDC issuer is compiled into the web build (VITE_OIDC_ISSUER), so this image is built for one public host: the offline bundle script passes
# --build-arg PUBLIC_HOST=<host>. The api, workers and db images do not depend on the host.
FROM node:24.22.2-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS build
ARG PUBLIC_HOST
ARG MACHVON_EDITION=public
ARG OIDC_REALM=machvon
ARG OIDC_CLIENT_ID=machvon-web
WORKDIR /app
COPY . .
RUN test -n "$PUBLIC_HOST" && npm ci --ignore-scripts --workspace @machvon/web --include-workspace-root=false
WORKDIR /app/apps/web
ENV VITE_EDITION=${MACHVON_EDITION} \
    VITE_API_BASE_URL=/api \
    VITE_OIDC_CLIENT_ID=${OIDC_CLIENT_ID}
RUN VITE_OIDC_ISSUER="https://${PUBLIC_HOST}/idp/realms/${OIDC_REALM}" npx vite build --outDir /app/web-dist

FROM nginxinc/nginx-unprivileged:1.30.6-alpine@sha256:f5116ed4606f3eb015dd4a8e28cb9b351476dc0ad4bc6e9f93b19cec130cdf03 AS runtime
# The base image is rebuilt only now and then; the packages of the Alpine release it is built on get their fixes earlier, so they are brought up to date here (Trivy fails on a fixable HIGH or CRITICAL finding).
USER root
RUN apk upgrade --no-cache
LABEL org.opencontainers.image.title="machvon-web" \
      org.opencontainers.image.description="MACHVON web and edge" \
      org.opencontainers.image.source="https://github.com/trungtm78/PIS"
COPY --from=build --chown=nginx:nginx /app/web-dist /usr/share/nginx/html
COPY --chown=nginx:nginx infra/onprem/nginx/snippets/ /etc/nginx/snippets/
COPY --chown=nginx:nginx infra/onprem/nginx/default.conf.template /etc/nginx/templates/default.conf.template
USER nginx
EXPOSE 8080 8443
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD ["wget", "--quiet", "--spider", "http://127.0.0.1:8080/healthz"]
