#!/bin/sh
# Returns MACHVON to the previous release, from the bundle of that release (kept on the host after every upgrade).
#
#   sh rollback.sh <directory of the previous bundle> [--env-file <path>]
#
# The application rolls back by starting the previous images (target: 15 minutes, infra/pipelines/production.json). The database schema is NOT rolled back:
# migrations are expand-contract, so the previous release works with the current schema. If data itself is damaged, use the restore runbook instead.
set -eu

[ "$#" -ge 1 ] || { echo "usage: sh rollback.sh <previous bundle directory> [--env-file <path>]" >&2; exit 2; }
PREVIOUS=$(cd "$1" && pwd)
shift
ENV_FILE="${PREVIOUS}/infra/onprem/compose/.env"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --env-file) ENV_FILE="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

say() { printf '%s\n' "rollback: $*"; }
fail() { printf '%s\n' "rollback: $*" >&2; exit 1; }

[ -f "${PREVIOUS}/VERSION" ] || fail "${PREVIOUS} is not a bundle"
[ -f "${ENV_FILE}" ] || fail "no ${ENV_FILE}"
cd "${PREVIOUS}"
VERSION=$(cat VERSION)

say "checking the integrity of the previous bundle"
sha256sum --check --quiet SHA256SUMS || fail "the previous bundle does not match SHA256SUMS"

for image in api workers web db; do
  docker image inspect "machvon/${image}:${VERSION}" >/dev/null 2>&1 || fail "image machvon/${image}:${VERSION} is not loaded: load the archives of the previous bundle (docker load --input images/<name>.oci.tar) first"
done

COMPOSE="docker compose --env-file ${ENV_FILE} -f ${PREVIOUS}/infra/onprem/compose/compose.yaml"
export MACHVON_VERSION="${VERSION}"
# The OPT-IN BI port stays as the operator left it: with MACHVON_BI=on the same override is used, so the database is not recreated without its port (and never with one it did not have).
if [ "$(sed -n 's/^MACHVON_BI=//p' "${ENV_FILE}" | tail -n 1 | tr -d '\r')" = "on" ] && [ -f "${PREVIOUS}/infra/onprem/compose/compose.bi.yaml" ]; then
  COMPOSE="${COMPOSE} -f ${PREVIOUS}/infra/onprem/compose/compose.bi.yaml"
fi

say "starting release ${VERSION} (the database is left as it is)"
${COMPOSE} up --detach --wait --wait-timeout 300 api workers web keycloak
${COMPOSE} ps

say "done: release ${VERSION} is serving. Record the cause and fix forward (docs/runbooks/infra/onprem-upgrade-rollback.md)."
