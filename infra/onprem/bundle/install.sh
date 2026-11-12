#!/bin/sh
# Installs or upgrades MACHVON from an offline bundle. No network access is used: images are loaded from the archives of this bundle.
#
#   sh install.sh [--env-file <path>] [--skip-backup] [--with-bi]
#
# Fresh install: loads the images, checks the secret files, starts the database, runs the migrations, sets the passwords of the database roles,
# starts everything and waits for the health checks. Upgrade (a database already exists): the same, after a full backup and a backup check,
# and the previous version is recorded so that rollback.sh can return to it. The schema is never rolled back (expand-contract migrations).
#
# --with-bi (or MACHVON_BI=on in the environment file) adds the OPT-IN read-only port of the database for BI tools (compose.bi.yaml, docs/runbooks/infra/bi-port.md). Without it nothing about the
# database is published. With it the script refuses to go on unless the settings are valid (config/bi-render.sh), the two TLS secret files exist and the firewall chain MACHVON-BI is in place.
set -eu

BUNDLE=$(cd "$(dirname "$0")" && pwd)
ENV_FILE="${BUNDLE}/infra/onprem/compose/.env"
SKIP_BACKUP=0
WITH_BI=0
WAIT_SECONDS=300

while [ "$#" -gt 0 ]; do
  case "$1" in
    --env-file) ENV_FILE="$2"; shift 2 ;;
    --skip-backup) SKIP_BACKUP=1; shift ;;
    --with-bi) WITH_BI=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

say() { printf '%s\n' "install: $*"; }
fail() { printf '%s\n' "install: $*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || fail "docker is required"
docker compose version >/dev/null 2>&1 || fail "docker compose v2 is required"
command -v sha256sum >/dev/null 2>&1 || fail "sha256sum is required"
[ -f "${ENV_FILE}" ] || fail "no ${ENV_FILE}: copy infra/onprem/compose/env.template to infra/onprem/compose/.env and fill it in"

cd "${BUNDLE}"
VERSION=$(cat VERSION)

say "1/8 checking the integrity of the bundle (SHA256SUMS)"
sha256sum --check --quiet SHA256SUMS || fail "the bundle does not match SHA256SUMS: do not install it"

say "2/8 loading the images for this host ($(uname -m))"
for archive in images/*.oci.tar; do
  if docker load --input "${archive}" >/dev/null 2>&1; then
    say "loaded ${archive}"
  elif command -v skopeo >/dev/null 2>&1; then
    ref=$(tar -xOf "${archive}" index.json | sed -n 's/.*"org.opencontainers.image.ref.name": *"\([^"]*\)".*/\1/p' | head -n 1)
    skopeo copy "oci-archive:${archive}:${ref}" "docker-daemon:${ref}" >/dev/null || fail "cannot load ${archive}"
    say "loaded ${archive} with skopeo"
  else
    fail "cannot load ${archive}: use Docker Engine 28 or newer with the containerd image store, or install skopeo"
  fi
done

COMPOSE="docker compose --env-file ${ENV_FILE} -f ${BUNDLE}/infra/onprem/compose/compose.yaml"
export MACHVON_VERSION="${VERSION}"

[ "$(sed -n 's/^MACHVON_BI=//p' "${ENV_FILE}" | tail -n 1 | tr -d '\r')" = "on" ] && WITH_BI=1
SECRET_NAMES=$(sed -n 's/.*"name": *"\([a-z0-9_]*\)",$/\1/p' infra/onprem/secrets.json)
if [ "${WITH_BI}" -eq 1 ]; then
  say "the OPT-IN read-only BI port is switched on (docs/runbooks/infra/bi-port.md)"
  sh infra/onprem/config/bi-render.sh --check --env-file "${ENV_FILE}" || fail "the settings of the BI port are not valid: nothing was started"
  SECRET_NAMES="${SECRET_NAMES} $(sed -n 's/.*"name": *"\([a-z0-9_]*\)",$/\1/p' infra/onprem/secrets-bi.json)"
  if command -v iptables >/dev/null 2>&1; then
    iptables -S MACHVON-BI >/dev/null 2>&1 || fail "the firewall chain MACHVON-BI does not exist: run 'sh infra/onprem/config/bi-firewall.sh --env-file ${ENV_FILE} --apply' first (the port is not started without it)"
  else
    fail "iptables is required to check the firewall chain MACHVON-BI of the BI port"
  fi
  COMPOSE="${COMPOSE} -f ${BUNDLE}/infra/onprem/compose/compose.bi.yaml"
fi

say "3/8 checking the secret files"
SECRETS_DIR=$(sed -n 's/^MACHVON_SECRETS_DIR=//p' "${ENV_FILE}" | tail -n 1)
[ -d "${SECRETS_DIR}" ] || fail "MACHVON_SECRETS_DIR is not a directory"
missing=0
for name in ${SECRET_NAMES}; do
  [ -s "${SECRETS_DIR}/${name}" ] || { say "missing or empty secret file: ${name}"; missing=1; }
done
[ "${missing}" -eq 0 ] || fail "create the secret files listed above (see infra/onprem/secrets.json)"
SECRETS_GID=$(sed -n 's/^MACHVON_SECRETS_GID=//p' "${ENV_FILE}" | tail -n 1)
[ -n "${SECRETS_GID}" ] || fail "MACHVON_SECRETS_GID is not set in the environment file"
unreadable=0
for name in ${SECRET_NAMES}; do
  group=$(stat -c '%g' "${SECRETS_DIR}/${name}")
  mode=$(stat -c '%a' "${SECRETS_DIR}/${name}")
  # Group readable, nothing for others: containers read the file through the group, nobody else may read it.
  case "${mode}" in
    [0-7][4-7]0) ;;
    *) say "secret ${name}: mode ${mode} must be 440 (group readable, nothing for others)"; unreadable=1 ;;
  esac
  [ "${group}" = "${SECRETS_GID}" ] || { say "secret ${name}: group ${group} must be ${SECRETS_GID} (MACHVON_SECRETS_GID)"; unreadable=1; }
done
[ "${unreadable}" -eq 0 ] || fail "fix the ownership of the secret files (docs/runbooks/infra/onprem-install.md, Secrets)"
${COMPOSE} config --quiet || fail "the compose file does not accept this environment"

UPGRADE=0
if [ -n "$(${COMPOSE} ps --quiet db 2>/dev/null)" ]; then UPGRADE=1; fi

if [ "${UPGRADE}" -eq 1 ]; then
  previous=$(${COMPOSE} ps --format '{{.Image}}' api 2>/dev/null | head -n 1 | sed 's/.*://')
  say "upgrade from ${previous:-unknown} to ${VERSION}"
  if [ "${SKIP_BACKUP}" -eq 0 ]; then
    say "4/8 full backup and backup check before the upgrade"
    ${COMPOSE} --profile tools run --rm backup backup --type=full
    ${COMPOSE} --profile tools run --rm backup check
  else
    say "4/8 backup skipped (--skip-backup): the operator answers for it"
  fi
  mkdir -p /var/lib/machvon 2>/dev/null || true
  [ -z "${previous}" ] || printf '%s\n' "${previous}" > /var/lib/machvon/previous-version 2>/dev/null || true
else
  say "4/8 fresh install: no backup to take"
fi

if [ "${WITH_BI}" -eq 1 ]; then
  # The file the database is started with: rendered from the allowed sources, written before the database starts (a wrong value stopped the script above and wrote nothing).
  sh infra/onprem/config/bi-render.sh --env-file "${ENV_FILE}" || fail "cannot render pg_hba.conf for the BI port"
fi

say "5/8 starting the database"
${COMPOSE} up --detach --wait --wait-timeout "${WAIT_SECONDS}" db
if [ "${UPGRADE}" -eq 0 ]; then
  ${COMPOSE} --profile tools run --rm backup stanza-create
fi

say "6/8 running the migrations"
${COMPOSE} --profile tools run --rm migrate

say "7/8 setting the passwords of the database roles from the secret files"
for role in app control outbox_relay; do
  password=$(sed -n "s#^postgres://machvon_${role}:\([^@]*\)@.*#\1#p" "${SECRETS_DIR}/database_url_${role}")
  [ -n "${password}" ] || fail "database_url_${role} is not a postgres URL for role machvon_${role}"
  # The password goes into one SQL statement: a hex or base64url string only, so that nothing in it can end the literal.
  case "${password}" in
    *[!A-Za-z0-9_.~-]*) fail "the password in database_url_${role} may only hold letters, digits and _ . ~ - (use openssl rand -hex 32)" ;;
  esac
  printf "ALTER ROLE machvon_%s PASSWORD '%s';\n" "${role}" "${password}" | ${COMPOSE} exec -T db psql --quiet --username machvon_owner --dbname machvon >/dev/null
done

if [ "${WITH_BI}" -eq 1 ]; then
  say "7b/8 the audit role of the BI port (every view of the schema machvon_bi is audited by pgaudit)"
  ${COMPOSE} exec -T db psql --quiet --set ON_ERROR_STOP=1 --username machvon_owner --dbname machvon < infra/onprem/config/bi-audit-setup.sql >/dev/null
fi

say "8/8 starting every service and waiting for the health checks"
${COMPOSE} up --detach --wait --wait-timeout "${WAIT_SECONDS}"
${COMPOSE} ps
if [ "${WITH_BI}" -eq 1 ]; then
  say "the BI port listens on $(sed -n 's/^BI_LISTEN_ADDRESS=//p' "${ENV_FILE}" | tail -n 1):$(sed -n 's/^BI_PORT=//p' "${ENV_FILE}" | tail -n 1). Enable the audit shipping: systemctl enable --now machvon-bi-audit-ship.timer"
fi

say "done: MACHVON ${VERSION} is running. Next: docs/runbooks/infra/onprem-install.md (first sign-in, MFA enrolment, backup check, restore drill)."
