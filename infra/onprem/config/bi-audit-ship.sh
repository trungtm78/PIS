#!/bin/sh
# Ships the daily audit log files of the database (pgaudit and the connections of the BI port) off this host, and removes a file from the host only after the retention AND only once it was shipped.
#
#   sh bi-audit-ship.sh [--env-file <path>] [--directory <audit log directory>] [--ledger <directory>] [--today YYYY-MM-DD]
#
# Run daily by the timer machvon-bi-audit-ship (infra/onprem/systemd). A file db-YYYY-MM-DD.log is complete once its day is over, so only the files of days before today are shipped. The sink is
# BI_AUDIT_SINK: `directory:<absolute path>` copies the file there (the log store of the customer, a mount) and checks the copy against the SHA-256 of the original, `syslog:<host>:<port>` sends the
# lines over TCP with logger. A shipped file is recorded in the ledger (the SHA-256 of what was shipped); a file without a ledger entry is never removed. The retention is
# BI_AUDIT_RETENTION_DAYS (at least 365, bi-render.sh). The exit status is 1 when any file could not be shipped, so the timer unit shows the failure.
set -eu

ENV_FILE=""
DIRECTORY=""
LEDGER=/var/lib/machvon/bi-audit-ledger
TODAY=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --env-file) ENV_FILE="$2"; shift 2 ;;
    --directory) DIRECTORY="$2"; shift 2 ;;
    --ledger) LEDGER="$2"; shift 2 ;;
    --today) TODAY="$2"; shift 2 ;;
    *) echo "bi-audit-ship: unknown argument: $1" >&2; exit 2 ;;
  esac
done

say() { printf '%s\n' "bi-audit-ship: $*"; }
fail() { printf '%s\n' "bi-audit-ship: $*" >&2; exit 1; }

get() {
  if [ -n "${ENV_FILE}" ]; then
    [ -f "${ENV_FILE}" ] || fail "no ${ENV_FILE}"
    sed -n "s/^$1=//p" "${ENV_FILE}" | tail -n 1 | tr -d '\r'
  else
    eval "printf '%s' \"\${$1:-}\""
  fi
}

SINK=$(get BI_AUDIT_SINK)
RETENTION=$(get BI_AUDIT_RETENTION_DAYS)
[ -n "${SINK}" ] || fail "BI_AUDIT_SINK is empty: there is nowhere to ship the audit trail to"
case "${RETENTION}" in ''|*[!0-9]*) fail "BI_AUDIT_RETENTION_DAYS must be a number" ;; esac
[ "${RETENTION}" -ge 365 ] || fail "BI_AUDIT_RETENTION_DAYS must be at least 365"
[ -n "${TODAY}" ] || TODAY=$(date -u +%Y-%m-%d)
if [ -z "${DIRECTORY}" ]; then
  DIRECTORY=$(docker volume inspect machvon_dbaudit --format '{{.Mountpoint}}' 2>/dev/null) || fail "cannot find the volume machvon_dbaudit: pass --directory"
fi
[ -d "${DIRECTORY}" ] || fail "${DIRECTORY} is not a directory"
mkdir -p "${LEDGER}"

# Whether the day $1 is before the day $2 (both YYYY-MM-DD, so the order of the text is the order of the days).
before() { [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort | head -n 1)" = "$1" ]; }

sha_of() { sha256sum "$1" | awk '{ sub(/^\\/, "", $1); print $1 }'; }

ship_one() {
  file="$1"
  name=$(basename "${file}")
  case "${SINK}" in
    directory:*)
      target="${SINK#directory:}"
      [ -d "${target}" ] || { say "${target} is not a directory"; return 1; }
      cp "${file}" "${target}/${name}.part" || return 1
      if [ "$(sha_of "${target}/${name}.part")" != "$(sha_of "${file}")" ]; then
        rm -f "${target}/${name}.part"
        say "the copy of ${name} does not match the original"
        return 1
      fi
      mv "${target}/${name}.part" "${target}/${name}" || return 1
      ;;
    syslog:*)
      rest="${SINK#syslog:}"
      host="${rest%:*}"
      port="${rest##*:}"
      command -v logger >/dev/null 2>&1 || { say "logger is not installed"; return 1; }
      logger --tcp --server "${host}" --port "${port}" --tag machvon-bi-audit --file "${file}" || return 1
      ;;
    *) say "BI_AUDIT_SINK ${SINK} is neither directory: nor syslog:"; return 1 ;;
  esac
  printf '%s  %s\n' "$(sha_of "${file}")" "${name}" > "${LEDGER}/${name}.shipped"
  say "shipped ${name}"
}

failed=0
for file in "${DIRECTORY}"/db-????-??-??.log; do
  [ -f "${file}" ] || continue
  name=$(basename "${file}")
  day=${name#db-}
  day=${day%.log}
  before "${day}" "${TODAY}" || continue
  [ -f "${LEDGER}/${name}.shipped" ] && continue
  ship_one "${file}" || failed=1
done

# Retention: only a file that is in the ledger, and only once it is older than the retention.
LIMIT=$(date -u -d "${TODAY} - ${RETENTION} days" +%Y-%m-%d)
for file in "${DIRECTORY}"/db-????-??-??.log; do
  [ -f "${file}" ] || continue
  name=$(basename "${file}")
  day=${name#db-}
  day=${day%.log}
  if before "${day}" "${LIMIT}" && [ -f "${LEDGER}/${name}.shipped" ]; then
    rm -f "${file}"
    say "removed ${name} (shipped, older than ${RETENTION} days)"
  fi
done

[ "${failed}" -eq 0 ] || fail "some files could not be shipped; they stay on this host"
