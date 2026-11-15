# syntax=docker/dockerfile:1.7
# MACHVON api image, linux/amd64 and linux/arm64 (build: docker buildx build --platform linux/amd64,linux/arm64 -f infra/onprem/docker/api.Dockerfile .).
# The request-serving process: it publishes port 3000 to the edge only and does not run the background jobs (WORKERS_ENABLED=false).
# The API runs the TypeScript sources of the workspace through the @swc/core loader of apps/api/scripts (a runtime dependency of the API: its platform binary is an
# optional package, so optional packages are kept), so the image carries the sources and the production dependencies: no dev dependency, and the test-only
# embedded-postgres (declared in packages/db, imported by test-database.ts only) is deleted after the install.
FROM node:24.22.2-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS build
WORKDIR /app
COPY . .
# The edition is chosen when the service starts (MACHVON_EDITION), not when the image is built, and the enterprise edition is loaded from the package @machvon/edition-enterprise, which
# the API does not declare as a dependency (no public source imports it): it is installed beside the API, with its own dependencies, or the enterprise edition could not start.
RUN npm ci --omit=dev --ignore-scripts --workspace @machvon/api --workspace @machvon/edition-enterprise --include-workspace-root=false \
 && rm -rf node_modules/embedded-postgres node_modules/@embedded-postgres \
 && npm cache clean --force

FROM node:24.22.2-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS runtime
LABEL org.opencontainers.image.title="machvon-api" \
      org.opencontainers.image.description="MACHVON api" \
      org.opencontainers.image.source="https://github.com/trungtm78/PIS"
ENV NODE_ENV=production \
    PORT=3000 \
    WORKERS_ENABLED=false \
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
# The outbox of invitations (MACHVON_INVITATION_OUTBOX_DIR): the named volume mounted here takes the owner and the mode of this directory the first time it is used.
RUN mkdir -p /var/lib/machvon/invitations && chown node:node /var/lib/machvon/invitations && chmod 0700 /var/lib/machvon/invitations
# The native addon of @swc/core (the loader of the TypeScript sources) is a compressed carrier: at every start it writes the real addon into a cache directory, takes a lock file there
# and loads the addon from it, so the directory must be writable and executable. It is this one, owned by the service user; where the root file system is read-only (the compose
# file) a memory file system is mounted on it. The default places do not work there: the home directory is read-only and /tmp is not executable.
ENV SWC_NATIVE_BINDING_CACHE=/app/.swc-native
RUN mkdir -p /app/.swc-native && chown node:node /app/.swc-native && chmod 0700 /app/.swc-native
USER node
WORKDIR /app/apps/api
EXPOSE 3000
# Liveness only: it asks nothing of the database, so a database outage does not restart healthy processes (docs/runbooks/api-runtime.md).
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health/live').then((r)=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["/usr/local/bin/secret-env"]
CMD ["node", "--disable-warning=ExperimentalWarning", "--import", "./scripts/ts-register.mjs", "src/serve.ts"]
