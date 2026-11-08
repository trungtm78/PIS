#!/bin/sh
# Installs or upgrades MACHVON from an offline bundle. No network access is used: images are loaded from the archives of this bundle.
#
#   sh install.sh [--env-file <path>] [--skip-backup]
#
# Fresh install: loads the images, checks the secret files, starts the database, runs the migrations, sets the passwords of the database roles,
# starts everything and waits for the health checks. Upgrade (a database already exists): the same, after a full backup and a backup check,
# and the previous version is recorded so that rollback.sh can return to it. The schema is never rolled back (expand-contract migrations).
set -eu

BUNDLE=$(cd "$(dirname "$0")" && pwd)
ENV_FILE="${BUNDLE}/infra/onprem/compose/.env"
SKIP_BACKUP=0
WAIT_SECONDS=300

while [ "$#" -gt 0 ]; do
  case "$1" in
    --env-file) ENV_FILE="$2"; shift 2 ;;
    --skip-backup) SKIP_BACKUP=1; shift ;;
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

say "3/8 checking the secret files"
SECRETS_DIR=$(sed -n 's/^MACHVON_SECRETS_DIR=//p' "${ENV_FILE}" | tail -n 1)
[ -d "${SECRETS_DIR}" ] || fail "MACHVON_SECRETS_DIR is not a directory"
missing=0
for name in $(sed -n 's/.*"name": *"\([a-z0-9_]*\)",$/\1/p' infra/onprem/secrets.json); do
  [ -s "${SECRETS_DIR}/${name}" ] || { say "missing or empty secret file: ${name}"; missing=1; }
done
[ "${missing}" -eq 0 ] || fail "create the secret files listed above (see infra/onprem/secrets.json)"
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
  printf "ALTER ROLE machvon_%s PASSWORD '%s';\n" "${role}" "${password}" | ${COMPOSE} exec -T db psql --quiet --username machvon_owner --dbname machvon >/dev/null
done

say "8/8 starting every service and waiting for the health checks"
${COMPOSE} up --detach --wait --wait-timeout "${WAIT_SECONDS}"
${COMPOSE} ps

say "done: MACHVON ${VERSION} is running. Next: docs/runbooks/infra/onprem-install.md (first sign-in, MFA enrolment, backup check, restore drill)."
