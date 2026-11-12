#!/bin/sh
# Validates the settings of the OPT-IN read-only BI port and renders the pg_hba.conf of the database from them. A setting that would open the port wider than the rules of
# docs/runbooks/infra/bi-port.md allow stops the script with a message and writes nothing, so a wrong value can never become a file that is mounted.
#
#   sh bi-render.sh [--env-file <path>] [--out <directory>] [--check]
#
# Values come from the environment file (the same one install.sh reads) or, without --env-file, from the environment of the shell: BI_LISTEN_ADDRESS, BI_PORT, BI_ALLOWED_CIDRS,
# BI_MAX_CONNECTIONS_PER_ADDRESS, BI_CONFIG_DIR, BI_AUDIT_SINK, BI_AUDIT_RETENTION_DAYS. With --check only the validation runs. Without --out the file is written to BI_CONFIG_DIR.
#
# The rules: one IPv4 listen address of this host (not 0.0.0.0, not multicast); a port from 1024 to 65535; at least one allowed source, each a CIDR with its host bits zero and a prefix
# of /16 to /32 (so the whole of 10.0.0.0/8 or 0.0.0.0/0 is refused); a per-address connection limit of 1 to 1000; an audit sink (directory:<absolute path> or syslog:<host>:<port>)
# and a retention of at least 365 days: the port is never started without a place to ship its audit trail to.
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
TEMPLATE="${HERE}/pg_hba-bi.conf.template"
ENV_FILE=""
OUT=""
CHECK=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --env-file) ENV_FILE="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --check) CHECK=1; shift ;;
    *) echo "bi-render: unknown argument: $1" >&2; exit 2 ;;
  esac
done

fail() { printf '%s\n' "bi-render: $*" >&2; exit 1; }

# The value of a setting: the last assignment in the environment file, or the environment of the shell.
get() {
  if [ -n "${ENV_FILE}" ]; then
    [ -f "${ENV_FILE}" ] || fail "no ${ENV_FILE}"
    sed -n "s/^$1=//p" "${ENV_FILE}" | tail -n 1 | tr -d '\r'
  else
    eval "printf '%s' \"\${$1:-}\""
  fi
}

is_number() { case "$1" in ''|*[!0-9]*) return 1 ;; *) return 0 ;; esac; }

LISTEN=$(get BI_LISTEN_ADDRESS)
PORT=$(get BI_PORT)
CIDRS=$(get BI_ALLOWED_CIDRS)
PER_ADDRESS=$(get BI_MAX_CONNECTIONS_PER_ADDRESS)
CONFIG_DIR=$(get BI_CONFIG_DIR)
SINK=$(get BI_AUDIT_SINK)
RETENTION=$(get BI_AUDIT_RETENTION_DAYS)

[ -n "${LISTEN}" ] || fail "BI_LISTEN_ADDRESS is empty: the port stays closed until one address of this host is named"
printf '%s\n' "${LISTEN}" | awk -F. 'NF != 4 { exit 1 } { for (i = 1; i <= 4; i++) if ($i !~ /^[0-9]+$/ || length($i) > 3 || $i + 0 > 255) exit 1; if ($1 + 0 == 0 || $1 + 0 >= 224) exit 2; exit 0 }' || fail "BI_LISTEN_ADDRESS ${LISTEN} must be one unicast IPv4 address of this host (never 0.0.0.0)"

is_number "${PORT}" && [ "${PORT}" -ge 1024 ] && [ "${PORT}" -le 65535 ] || fail "BI_PORT must be a number from 1024 to 65535"
is_number "${PER_ADDRESS}" && [ "${PER_ADDRESS}" -ge 1 ] && [ "${PER_ADDRESS}" -le 1000 ] || fail "BI_MAX_CONNECTIONS_PER_ADDRESS must be a number from 1 to 1000"
is_number "${RETENTION}" && [ "${RETENTION}" -ge 365 ] || fail "BI_AUDIT_RETENTION_DAYS must be at least 365"

case "${SINK}" in
  directory:/?*) ;;
  syslog:?*:?*) ;;
  *) fail "BI_AUDIT_SINK must be directory:<absolute path> or syslog:<host>:<port>: the port is never started without a place to ship its audit trail to" ;;
esac

[ -n "${CIDRS}" ] || fail "BI_ALLOWED_CIDRS is empty: the port stays closed until the source addresses are named"
LINES=$(mktemp)
trap 'rm -f "${LINES}" "${LINES}.out"' EXIT
COUNT=0
case "${CIDRS}" in
  ,*|*,|*,,*) fail "BI_ALLOWED_CIDRS has an empty entry" ;;
esac
OLD_IFS=${IFS}
set -f
IFS=','
set -- ${CIDRS}
IFS=${OLD_IFS}
set +f
for raw in "$@"; do
  cidr=$(printf '%s' "${raw}" | tr -d ' \t')
  [ -n "${cidr}" ] || fail "BI_ALLOWED_CIDRS has an empty entry"
  rc=0
  printf '%s\n' "${cidr}" | awk -F'[./]' 'NF != 5 { exit 1 } { for (i = 1; i <= 5; i++) if ($i !~ /^[0-9]+$/) exit 1; for (i = 1; i <= 4; i++) if (length($i) > 3 || $i + 0 > 255) exit 1; n = $5 + 0; if (n < 16 || n > 32) exit 2; ip = (($1 * 256 + $2) * 256 + $3) * 256 + $4; if (ip % (2 ^ (32 - n)) != 0) exit 3; exit 0 }' || rc=$?
  case "${rc}" in
    0) ;;
    2) fail "${cidr}: the prefix must be from /16 to /32 (a network wider than that is not a list of BI tools)" ;;
    3) fail "${cidr}: the host bits of the network address must be zero" ;;
    *) fail "${cidr} is not an IPv4 CIDR such as 10.20.30.40/32" ;;
  esac
  printf 'hostssl     machvon    +machvon_bi_reader   %-17s scram-sha-256\n' "${cidr}" >> "${LINES}"
  COUNT=$((COUNT + 1))
done
[ "${COUNT}" -ge 1 ] || fail "BI_ALLOWED_CIDRS names no address"

if [ "${CHECK}" -eq 1 ]; then
  printf '%s\n' "bi-render: the settings of the BI port are valid (${COUNT} allowed source(s), listening on ${LISTEN}:${PORT})"
  exit 0
fi

[ -n "${OUT}" ] || OUT="${CONFIG_DIR}"
[ -n "${OUT}" ] || fail "no output directory: pass --out or set BI_CONFIG_DIR"
[ -f "${TEMPLATE}" ] || fail "no ${TEMPLATE}"
mkdir -p "${OUT}"
tr -d '\r' < "${TEMPLATE}" | awk -v lines="${LINES}" '/^@BI_HOSTSSL_LINES@$/ { while ((getline line < lines) > 0) print line; next } { print }' > "${LINES}.out"
grep -q '^hostssl ' "${LINES}.out" || fail "the template has no @BI_HOSTSSL_LINES@ marker"
chmod 0644 "${LINES}.out"
mv "${LINES}.out" "${OUT}/pg_hba.conf"
printf '%s\n' "bi-render: wrote ${OUT}/pg_hba.conf (${COUNT} allowed source(s), listening on ${LISTEN}:${PORT})"
