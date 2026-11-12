#!/bin/sh
# The host firewall rules of the OPT-IN read-only BI port: only the allowed source addresses reach the port, each with a limit on its open connections, and everything else is dropped.
#
#   sh bi-firewall.sh [--env-file <path>] [--apply]
#
# Without --apply the rules are only printed. With it they are put into the DOCKER-USER chain (iptables), which Docker consults before its own rules and never rewrites, for the traffic that
# was addressed to BI_LISTEN_ADDRESS:BI_PORT before Docker translated it to the container. The settings are validated first by bi-render.sh (an invalid or empty setting prints nothing and
# changes nothing). pg_hba.conf names the same sources, so the port has two independent locks; install.sh refuses to start the port while the chain MACHVON-BI does not exist.
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
ENV_FILE=""
APPLY=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --env-file) ENV_FILE="$2"; shift 2 ;;
    --apply) APPLY=1; shift ;;
    *) echo "bi-firewall: unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ -n "${ENV_FILE}" ]; then
  sh "${HERE}/bi-render.sh" --check --env-file "${ENV_FILE}" >/dev/null || exit 1
else
  sh "${HERE}/bi-render.sh" --check >/dev/null || exit 1
fi

get() {
  if [ -n "${ENV_FILE}" ]; then
    sed -n "s/^$1=//p" "${ENV_FILE}" | tail -n 1 | tr -d '\r'
  else
    eval "printf '%s' \"\${$1:-}\""
  fi
}

LISTEN=$(get BI_LISTEN_ADDRESS)
PORT=$(get BI_PORT)
PER_ADDRESS=$(get BI_MAX_CONNECTIONS_PER_ADDRESS)
CIDRS=$(get BI_ALLOWED_CIDRS)

rules() {
  echo "iptables -N MACHVON-BI 2>/dev/null || iptables -F MACHVON-BI"
  echo "iptables -A MACHVON-BI -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT"
  set -f
  OLD_IFS=${IFS}
  IFS=','
  set -- ${CIDRS}
  IFS=${OLD_IFS}
  set +f
  for raw in "$@"; do
    cidr=$(printf '%s' "${raw}" | tr -d ' \t')
    echo "iptables -A MACHVON-BI -s ${cidr} -p tcp -m connlimit --connlimit-above ${PER_ADDRESS} --connlimit-mask 32 -j DROP"
    echo "iptables -A MACHVON-BI -s ${cidr} -p tcp -j ACCEPT"
  done
  echo "iptables -A MACHVON-BI -j DROP"
  echo "iptables -C DOCKER-USER -p tcp -m conntrack --ctorigdst ${LISTEN} --ctorigdstport ${PORT} -j MACHVON-BI 2>/dev/null || iptables -I DOCKER-USER 1 -p tcp -m conntrack --ctorigdst ${LISTEN} --ctorigdstport ${PORT} -j MACHVON-BI"
}

if [ "${APPLY}" -eq 1 ]; then
  rules | sh -e
  echo "bi-firewall: rules applied; make them persistent with your distribution's iptables service"
else
  rules
fi
