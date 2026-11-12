# syntax=docker/dockerfile:1.7
# MACHVON database image, linux/amd64 and linux/arm64: PostgreSQL 18 with pgBackRest, pgvector and pgaudit (V001 of the migrations creates the vector and btree_gist extensions; btree_gist ships with PostgreSQL), so that archive_command (continuous WAL archive) and the backup runs
# use the same binary version. The same image runs the backup commands as a one-shot service (infra/onprem/compose/compose.yaml, profile "tools").
# pgaudit is the audit trail of the read-only BI port (INT-2, docs/runbooks/infra/bi-port.md): it is preloaded always and logs only what infra/onprem/compose/compose.bi.yaml asks for.
# It needs the network at BUILD time on the vendor build host only (apt); the customer installs the exported image from the offline bundle.
# gosu of the official image is built with an old Go whose standard library has fixed HIGH and CRITICAL advisories (Trivy fails on them), and the release of gosu has not caught up:
# the same release (1.20, commit pinned) is built here with a current Go, statically, for the platform being built. The binary replaces the one of the base image.
FROM golang:1.26.11-bookworm@sha256:dc40a13b61304647ed7e5d581d246b86413dfc29d63c6d018310feb93cd98fc0 AS gosu
RUN git clone --quiet https://github.com/tianon/gosu /src \
 && git -C /src checkout --quiet 29b939aa5bd4dc588af765b8248f6e39150d2565 \
 && cd /src && CGO_ENABLED=0 go build -trimpath -ldflags '-d -w' -o /gosu . \
 && /gosu --version

FROM postgres:18.6-bookworm@sha256:f1ea2a1a4fb7b68d4836be1fdcb8a6466a89b072158bf9d97663600538c294c5
LABEL org.opencontainers.image.title="machvon-db" \
      org.opencontainers.image.description="PostgreSQL 18 with pgBackRest, pgvector and pgaudit" \
      org.opencontainers.image.source="https://github.com/trungtm78/PIS"
RUN apt-get update \
 && apt-get install -y --no-install-recommends pgbackrest postgresql-18-pgvector postgresql-18-pgaudit \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /etc/pgbackrest /var/log/pgbackrest /var/lib/pgbackrest /var/spool/pgbackrest \
 && chown -R postgres:postgres /etc/pgbackrest /var/log/pgbackrest /var/lib/pgbackrest /var/spool/pgbackrest \
 && rm -f /etc/ssl/private/ssl-cert-snakeoil.key /etc/ssl/certs/ssl-cert-snakeoil.pem
# The "snakeoil" key of the ssl-cert package is a public throw-away key that Trivy rightly reports as a private key; TLS of the database is not configured with it.
COPY --from=gosu --chmod=0755 /gosu /usr/local/bin/gosu
COPY --chmod=0755 infra/onprem/docker/secret-env.sh /usr/local/bin/secret-env
COPY --chmod=0755 infra/onprem/docker/bi-tls-prepare.sh /usr/local/bin/bi-tls-prepare
HEALTHCHECK --interval=10s --timeout=5s --start-period=60s --retries=6 \
  CMD ["pg_isready", "--quiet", "--host", "/var/run/postgresql"]
