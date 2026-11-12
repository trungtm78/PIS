#!/bin/sh
# Entrypoint step of the database when the read-only BI port is switched on (compose.bi.yaml): PostgreSQL reads its TLS key as the postgres user, which does not keep the supplementary group
# that lets the container read the secret files. This step runs as root before the server starts and copies the certificate and the key of the BI port into a tmpfs owned by postgres
# (the key 0600), so that the server can read them and nothing is kept on the data volume.
#
#   bi-tls-prepare <command...>
set -eu

SOURCE_CERT=/run/secrets/db_tls_cert
SOURCE_KEY=/run/secrets/db_tls_key
TARGET=/run/machvon-bi-tls

[ -r "${SOURCE_CERT}" ] || { echo "bi-tls-prepare: ${SOURCE_CERT} cannot be read" >&2; exit 78; }
[ -r "${SOURCE_KEY}" ] || { echo "bi-tls-prepare: ${SOURCE_KEY} cannot be read" >&2; exit 78; }
[ -s "${SOURCE_CERT}" ] && [ -s "${SOURCE_KEY}" ] || { echo "bi-tls-prepare: the certificate and the key must not be empty" >&2; exit 78; }

mkdir -p "${TARGET}"
install -o postgres -g postgres -m 0644 "${SOURCE_CERT}" "${TARGET}/server.crt"
install -o postgres -g postgres -m 0600 "${SOURCE_KEY}" "${TARGET}/server.key"
chown postgres:postgres "${TARGET}"
chmod 0700 "${TARGET}"

# The audit log directory is a volume made by root: the server (postgres) writes the daily file there, nobody else reads it.
AUDIT=/var/log/machvon-audit
if [ -d "${AUDIT}" ]; then
  chown postgres:postgres "${AUDIT}"
  chmod 0750 "${AUDIT}"
fi

exec "$@"
