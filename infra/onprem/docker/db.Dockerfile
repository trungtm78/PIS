# syntax=docker/dockerfile:1.7
# MACHVON database image, linux/amd64 and linux/arm64: PostgreSQL 18 with pgBackRest, so that archive_command (continuous WAL archive) and the backup runs
# use the same binary version. The same image runs the backup commands as a one-shot service (infra/onprem/compose/compose.yaml, profile "tools").
# It needs the network at BUILD time on the vendor build host only (apt); the customer installs the exported image from the offline bundle.
FROM postgres:18.3-bookworm@sha256:80630f83606d8db77d30b3851b16a9f78be2d0d4dda6f7b82a1fdca5ebe3acba
LABEL org.opencontainers.image.title="machvon-db" \
      org.opencontainers.image.description="PostgreSQL 18 with pgBackRest" \
      org.opencontainers.image.source="https://github.com/trungtm78/PIS"
RUN apt-get update \
 && apt-get install -y --no-install-recommends pgbackrest \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /etc/pgbackrest /var/log/pgbackrest /var/lib/pgbackrest /var/spool/pgbackrest \
 && chown -R postgres:postgres /etc/pgbackrest /var/log/pgbackrest /var/lib/pgbackrest /var/spool/pgbackrest
COPY --chmod=0755 infra/onprem/docker/secret-env.sh /usr/local/bin/secret-env
HEALTHCHECK --interval=10s --timeout=5s --start-period=60s --retries=6 \
  CMD ["pg_isready", "--quiet", "--host", "/var/run/postgresql"]
