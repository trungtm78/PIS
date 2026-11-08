#!/bin/sh
# The host firewall rules that limit the `egress` network of the compose set (the only network with a route out: the database for the WAL archive and the backups,
# Keycloak for the directory) to the object store of the second site and the directory, and nothing else.
#
#   sh egress-firewall.sh <object store host> <object store port> <directory host> <directory port> [--apply]
#
# Without --apply the rules are only printed. With it they are inserted into the DOCKER-USER chain (iptables), which Docker consults before its own rules and never
# rewrites. Hosts are resolved now: when an address changes, run this again. Docker's embedded DNS resolves from the host, so DNS needs no rule here.
set -eu

[ "$#" -ge 4 ] || { echo "usage: sh egress-firewall.sh <object store host> <port> <directory host> <port> [--apply]" >&2; exit 2; }
STORE_HOST="$1"; STORE_PORT="$2"; DIRECTORY_HOST="$3"; DIRECTORY_PORT="$4"
APPLY="${5:-}"
SUBNET=172.29.250.0/24

resolve() {
  getent ahostsv4 "$1" | awk '{ print $1 }' | sort -u
}

rules() {
  echo "iptables -N MACHVON-EGRESS 2>/dev/null || iptables -F MACHVON-EGRESS"
  echo "iptables -A MACHVON-EGRESS -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT"
  for address in $(resolve "${STORE_HOST}"); do
    echo "iptables -A MACHVON-EGRESS -d ${address} -p tcp --dport ${STORE_PORT} -j ACCEPT"
  done
  for address in $(resolve "${DIRECTORY_HOST}"); do
    echo "iptables -A MACHVON-EGRESS -d ${address} -p tcp --dport ${DIRECTORY_PORT} -j ACCEPT"
  done
  echo "iptables -A MACHVON-EGRESS -j DROP"
  echo "iptables -C DOCKER-USER -s ${SUBNET} -j MACHVON-EGRESS 2>/dev/null || iptables -I DOCKER-USER 1 -s ${SUBNET} -j MACHVON-EGRESS"
}

if [ "${APPLY}" = "--apply" ]; then
  rules | sh -e
  echo "egress-firewall: rules applied; make them persistent with your distribution's iptables service"
else
  rules
fi
