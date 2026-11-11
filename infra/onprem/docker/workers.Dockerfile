# syntax=docker/dockerfile:1.7
# MACHVON workers image, linux/amd64 and linux/arm64 (build: docker buildx build --platform linux/amd64,linux/arm64 -f infra/onprem/docker/workers.Dockerfile .).
# The background process: the outbox relay and the scheduled jobs (WORKERS_ENABLED=true), no published port. It is the same code as the api image started with the other
# switch, so the two scale apart; the port is only the one of the health check.
# The API runs the TypeScript sources of the workspace through the @swc/core loader of apps/api/scripts (a runtime dependency of the API: its platform binary is an
# optional package, so optional packages are kept), so the image carries the sources and the production dependencies: no dev dependency, and the test-only
# embedded-postgres (declared in packages/db, imported by test-database.ts only) is deleted after the install.
FROM node:24.22.2-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS build
WORKDIR /app
COPY . .
RUN npm ci --omit=dev --ignore-scripts --workspace @machvon/api --include-workspace-root=false \
 && rm -rf node_modules/embedded-postgres node_modules/@embedded-postgres \
 && npm cache clean --force

FROM node:24.22.2-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS runtime
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
# The migration job (packages/db/src/cli.ts migrate) first checks the committed migrations against their source, the design schema.
COPY --from=build --chown=node:node /app/Design/MACHVON_Design/03_Engineering/error_codes.json ./Design/MACHVON_Design/03_Engineering/error_codes.json
COPY --from=build --chown=node:node /app/Design/MACHVON_Design/03_Engineering/schema_reference.sql ./Design/MACHVON_Design/03_Engineering/schema_reference.sql
COPY --chmod=0755 infra/onprem/docker/secret-env.sh /usr/local/bin/secret-env
# The runtime only runs node: npm and corepack (with the npm dependencies Trivy reads as findings) are not needed here and are removed.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
USER node
WORKDIR /app/apps/api
# Liveness only: it asks nothing of the database, so a database outage does not restart healthy processes (docs/runbooks/api-runtime.md).
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health/live').then((r)=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["/usr/local/bin/secret-env"]
CMD ["node", "--disable-warning=ExperimentalWarning", "--import", "./scripts/ts-register.mjs", "src/serve.ts"]
