# syntax=docker/dockerfile:1.7
# MACHVON workers image, linux/amd64 and linux/arm64 (build: docker buildx build --platform linux/amd64,linux/arm64 -f infra/onprem/docker/workers.Dockerfile .).
# The background process: the outbox relay and the scheduled jobs (WORKERS_ENABLED=true), no published port. It is the same code as the api image started with the other
# switch, so the two scale apart; the port is only the one of the health check.
# The API runs the TypeScript sources of the workspace (apps/api/scripts/ts-register.mjs), so the image carries the sources and the
# production dependencies only: no dev dependency and no optional platform binary (embedded-postgres and the build tools never ship).
FROM node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8 AS build
WORKDIR /app
COPY . .
RUN npm ci --omit=dev --omit=optional --ignore-scripts --workspace @machvon/api --include-workspace-root=false \
 && npm cache clean --force

FROM node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8 AS runtime
LABEL org.opencontainers.image.title="machvon-workers" \
      org.opencontainers.image.description="MACHVON workers" \
      org.opencontainers.image.source="https://github.com/trungtm78/PIS"
ENV NODE_ENV=production \
    PORT=3000 \
    WORKERS_ENABLED=true \
    MIGRATIONS_DIR=/app/db/migrations \
    ERROR_CODES_PATH=/app/Design/MACHVON_Design/03_Engineering/error_codes.json
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/apps/api ./apps/api
COPY --from=build --chown=node:node /app/packages ./packages
COPY --from=build --chown=node:node /app/db/migrations ./db/migrations
COPY --from=build --chown=node:node /app/Design/MACHVON_Design/03_Engineering/error_codes.json ./Design/MACHVON_Design/03_Engineering/error_codes.json
COPY --chmod=0755 infra/onprem/docker/secret-env.sh /usr/local/bin/secret-env
USER node
WORKDIR /app/apps/api
# Liveness only: it asks nothing of the database, so a database outage does not restart healthy processes (docs/runbooks/api-runtime.md).
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health/live').then((r)=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["/usr/local/bin/secret-env"]
CMD ["node", "--disable-warning=ExperimentalWarning", "--import", "./scripts/ts-register.mjs", "src/serve.ts"]
