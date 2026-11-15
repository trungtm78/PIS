#!/bin/sh
# Prepares the runner for the on-prem smoke run (.github/workflows/onprem-smoke.yml): what the customer brings to an installation, made here as throw-away test services.
#
#   sudo sh scripts/onprem-smoke/prepare.sh <work directory> <edition>
#
# - a test certificate authority, the certificate of the edge (PUBLIC_HOST, CONTROL_HOST) and the one of the directory and the object store;
# - a directory over LDAPS (OpenLDAP) and an S3 compatible object store over TLS (MinIO), both on the network of the host, reached by the containers through the gateway
#   of the egress network of the compose set (172.29.250.1), exactly the way out a real installation uses;
# - the two buckets, created by the script of the product (infra/backup/bucket/create-bucket.sh);
# - every secret file of infra/onprem/secrets.json with the command the file names, the ownership the runbook asks for, and the environment file from env.template.
#
# Everything is random and lives for one job. Nothing here changes a default of the product: the product files are read, never written.
set -eu

[ "$#" -ge 2 ] || { echo "usage: sh prepare.sh <work directory> <edition>" >&2; exit 2; }
WORK="$1"
EDITION="$2"
REPO=$(cd "$(dirname "$0")/../.." && pwd)
PUBLIC_HOST=machvon.smoke.test
CONTROL_HOST=control.smoke.test
GATEWAY=172.29.250.1
SECRETS=/etc/machvon/secrets
SECRETS_GID=1900
ENV_FILE=/etc/machvon/compose.env
S3_IMAGE=docker.io/coollabsio/minio:RELEASE.2025-10-15T17-29-55Z@sha256:69b55a1c1c5dc285ce04db96689f5b2102317fc77a50680a1874ca6efd1c87f9
LDAP_IMAGE=docker.io/library/alpine:3.20

say() { printf '%s\n' "smoke-prepare: $*"; }
fail() { printf '%s\n' "smoke-prepare: FAILED $*" >&2; exit 1; }

mkdir -p "${WORK}/pki" "${WORK}/ldap-certs" "${WORK}/s3-certs"
cd "${WORK}/pki"

say "1/6 names: ${PUBLIC_HOST} and ${CONTROL_HOST} resolve to this host"
grep -q " ${PUBLIC_HOST} " /etc/hosts || printf '127.0.0.1 %s %s \n' "${PUBLIC_HOST}" "${CONTROL_HOST}" >> /etc/hosts

say "2/6 test certificate authority and certificates"
openssl req -x509 -newkey rsa:2048 -nodes -days 3 -subj "/CN=MACHVON smoke test authority" -keyout ca.key -out ca.pem \
  -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null
issue() {
  openssl req -newkey rsa:2048 -nodes -subj "/CN=$2" -keyout "$1.key" -out "$1.csr" 2>/dev/null
  printf 'subjectAltName=%s\nextendedKeyUsage=serverAuth\nkeyUsage=critical,digitalSignature,keyEncipherment\n' "$3" > "$1.ext"
  openssl x509 -req -in "$1.csr" -CA ca.pem -CAkey ca.key -CAcreateserial -days 3 -extfile "$1.ext" -out "$1.crt" 2>/dev/null
  openssl verify -CAfile ca.pem "$1.crt" >/dev/null || fail "the certificate $1 does not verify"
}
issue web "${PUBLIC_HOST}" "DNS:${PUBLIC_HOST},DNS:${CONTROL_HOST}"
# The directory and the object store are reached by address: the name form is what pgBackRest compares, the address form what Java compares.
issue services "${GATEWAY}" "DNS:${GATEWAY},IP:${GATEWAY},IP:127.0.0.1,DNS:localhost"
chmod 0644 ca.pem

say "3/6 directory over LDAPS (OpenLDAP on ${LDAP_IMAGE})"
LDAP_PASSWORD=$(openssl rand -hex 16)
cp services.crt "${WORK}/ldap-certs/dir.crt"; cp services.key "${WORK}/ldap-certs/dir.key"; cp ca.pem "${WORK}/ldap-certs/ca.pem"
cat > "${WORK}/ldap-certs/slapd.conf" <<CONF
include /etc/openldap/schema/core.schema
include /etc/openldap/schema/cosine.schema
include /etc/openldap/schema/inetorgperson.schema
modulepath /usr/lib/openldap
moduleload back_mdb.so
pidfile /run/openldap/slapd.pid
TLSCACertificateFile /smoke/ca.pem
TLSCertificateFile /smoke/dir.crt
TLSCertificateKeyFile /smoke/dir.key
TLSVerifyClient never
database mdb
maxsize 268435456
suffix "dc=smoke,dc=test"
rootdn "cn=admin,dc=smoke,dc=test"
rootpw ${LDAP_PASSWORD}
directory /var/lib/openldap/openldap-data
CONF
cat > "${WORK}/ldap-certs/base.ldif" <<'LDIF'
dn: dc=smoke,dc=test
objectClass: dcObject
objectClass: organization
dc: smoke
o: MACHVON smoke

dn: ou=Users,dc=smoke,dc=test
objectClass: organizationalUnit
ou: Users

dn: ou=Groups,dc=smoke,dc=test
objectClass: organizationalUnit
ou: Groups
LDIF
docker rm --force smoke-ldap >/dev/null 2>&1 || true
# LDAPS on every address of the host (the containers reach it through the gateway of the egress network); clear-text LDAP on the loopback address only.
docker run --detach --name smoke-ldap --network host --volume "${WORK}/ldap-certs:/smoke:ro" "${LDAP_IMAGE}" sh -c   'apk add --no-cache openldap openldap-back-mdb openldap-clients >/dev/null && mkdir -p /run/openldap /var/lib/openldap/openldap-data && slapadd -f /smoke/slapd.conf -l /smoke/base.ldif && exec slapd -f /smoke/slapd.conf -h "ldap://127.0.0.1:389/ ldaps:///" -d 256' >/dev/null
tries=0
until openssl s_client -connect 127.0.0.1:636 -CAfile ca.pem -verify_return_error </dev/null >"${WORK}/ldaps.txt" 2>&1; do
  tries=$((tries + 1))
  if [ "${tries}" -gt 45 ]; then docker logs --tail 40 smoke-ldap 2>&1 || true; tail -n 5 "${WORK}/ldaps.txt" || true; fail "the directory does not answer on LDAPS with a certificate of the test authority"; fi
  sleep 2
done
docker exec smoke-ldap ldapsearch -x -H ldap://127.0.0.1:389 -D "cn=admin,dc=smoke,dc=test" -w "${LDAP_PASSWORD}" -b "ou=Users,dc=smoke,dc=test" -s base dn >/dev/null || fail "the service account cannot bind and read the directory"
say "the directory answers on ldaps://${GATEWAY}:636 (checked on 127.0.0.1)"

say "4/6 object store over TLS (${S3_IMAGE}) and the two buckets"
S3_ACCESS_KEY="smoke$(openssl rand -hex 6)"
S3_SECRET_KEY=$(openssl rand -hex 20)
cp services.crt "${WORK}/s3-certs/public.crt"; cp services.key "${WORK}/s3-certs/private.key"; chmod 0644 "${WORK}/s3-certs/private.key"
docker rm --force smoke-s3 >/dev/null 2>&1 || true
docker run --detach --name smoke-s3 --network host \
  --env MINIO_ROOT_USER="${S3_ACCESS_KEY}" --env MINIO_ROOT_PASSWORD="${S3_SECRET_KEY}" --env MINIO_KMS_SECRET_KEY="smoke-key:$(openssl rand -base64 32)" \
  --volume "${WORK}/s3-certs:/certs:ro" \
  "${S3_IMAGE}" server /data --address :9000 --console-address :9001 --certs-dir /certs >/dev/null
tries=0
until curl --silent --fail --cacert ca.pem https://127.0.0.1:9000/minio/health/live >/dev/null 2>&1; do
  tries=$((tries + 1))
  if [ "${tries}" -gt 45 ]; then docker logs --tail 40 smoke-s3 2>&1 || true; fail "the object store does not answer over TLS"; fi
  sleep 2
done
export AWS_ACCESS_KEY_ID="${S3_ACCESS_KEY}" AWS_SECRET_ACCESS_KEY="${S3_SECRET_KEY}" AWS_CA_BUNDLE="${WORK}/pki/ca.pem" AWS_EC2_METADATA_DISABLED=true
bucket() {
  # The script of the product first. An object store that lacks one of its calls still gets a locked, versioned bucket, and the gap is reported, not hidden.
  if sh "${REPO}/infra/backup/bucket/create-bucket.sh" "$1" https://127.0.0.1:9000 us-east-1 "$2" >"${WORK}/bucket-$1.txt" 2>&1; then
    say "create-bucket.sh created $1 with every setting of the backup policy"
  else
    echo "::warning title=on-prem smoke: create-bucket.sh::infra/backup/bucket/create-bucket.sh did not finish against this object store for $1: $(tail -n 2 "${WORK}/bucket-$1.txt" | tr '\n' ' ')"
    cat "${WORK}/bucket-$1.txt"
    aws s3api --endpoint-url https://127.0.0.1:9000 --region us-east-1 head-bucket --bucket "$1" >/dev/null 2>&1 \
      || aws s3api --endpoint-url https://127.0.0.1:9000 --region us-east-1 create-bucket --bucket "$1" --object-lock-enabled-for-bucket >/dev/null \
      || fail "cannot create the bucket $1"
  fi
  aws s3api --endpoint-url https://127.0.0.1:9000 --region us-east-1 get-object-lock-configuration --bucket "$1" >/dev/null || fail "the bucket $1 has no object lock"
}
bucket machvon-backup operational
bucket machvon-archive archive

say "5/6 secret files (infra/onprem/secrets.json) under ${SECRETS}"
rm -rf "${SECRETS}"
mkdir -p "${SECRETS}"
cd "${SECRETS}"
OWNER_PASSWORD=$(openssl rand -hex 32)
printf '%s\n' "${OWNER_PASSWORD}" > db_owner_password
printf 'postgres://machvon_owner:%s@db:5432/machvon\n' "${OWNER_PASSWORD}" > database_url_owner
for role in app control outbox_relay; do
  printf 'postgres://machvon_%s:%s@db:5432/machvon\n' "${role}" "$(openssl rand -hex 32)" > "database_url_${role}"
done
openssl rand -base64 48 > outbox_signing_key
openssl ecparam -name prime256v1 -genkey -noout > tenant_token_signing_key
openssl genpkey -algorithm ed25519 > license_signing_key
printf "1:%s" "$(openssl rand -base64 32)" > field_encryption_keys
openssl rand -hex 32 > keycloak_db_password
openssl rand -base64 24 > keycloak_admin_password
printf '%s\n' "${LDAP_PASSWORD}" > ldap_bind_credential
cp "${WORK}/pki/ca.pem" ldap_ca_cert
cat "${WORK}/pki/web.crt" "${WORK}/pki/ca.pem" > tls_cert
cp "${WORK}/pki/web.key" tls_key
openssl rand -base64 48 > pgbackrest_cipher_pass
openssl rand -base64 48 > pgbackrest_archive_cipher_pass
printf '%s\n' "${S3_ACCESS_KEY}" > backup_s3_access_key
printf '%s\n' "${S3_SECRET_KEY}" > backup_s3_secret_key
printf '%s\n' "${S3_ACCESS_KEY}" > backup_archive_s3_access_key
printf '%s\n' "${S3_SECRET_KEY}" > backup_archive_s3_secret_key
cp "${WORK}/pki/ca.pem" backup_s3_ca_cert
# The ownership of the runbook (docs/runbooks/infra/onprem-install.md, Secrets).
getent group "${SECRETS_GID}" >/dev/null 2>&1 || groupadd --gid "${SECRETS_GID}" machvon-secrets
chgrp -R "${SECRETS_GID}" "${SECRETS}" && chmod 0750 "${SECRETS}" && chmod 0440 "${SECRETS}"/*
chown 999 "${SECRETS}/keycloak_db_password" "${SECRETS}/backup_s3_ca_cert"
for name in $(sed -n 's/.*"name": *"\([a-z0-9_]*\)",$/\1/p' "${REPO}/infra/onprem/secrets.json"); do
  [ -s "${SECRETS}/${name}" ] || fail "this script does not create the secret ${name} of secrets.json"
done

say "6/6 environment file ${ENV_FILE} from env.template"
sed \
  -e "s|^MACHVON_EDITION=.*|MACHVON_EDITION=${EDITION}|" \
  -e "s|^PUBLIC_HOST=.*|PUBLIC_HOST=${PUBLIC_HOST}|" \
  -e "s|^CONTROL_HOST=.*|CONTROL_HOST=${CONTROL_HOST}|" \
  -e "s|^MACHVON_SECRETS_DIR=.*|MACHVON_SECRETS_DIR=${SECRETS}|" \
  -e "s|^MACHVON_SECRETS_GID=.*|MACHVON_SECRETS_GID=${SECRETS_GID}|" \
  -e "s|^LDAP_URL=.*|LDAP_URL=ldaps://${GATEWAY}:636|" \
  -e "s|^LDAP_BIND_DN=.*|LDAP_BIND_DN=cn=admin,dc=smoke,dc=test|" \
  -e "s|^LDAP_USERS_DN=.*|LDAP_USERS_DN=ou=Users,dc=smoke,dc=test|" \
  -e "s|^LDAP_GROUPS_DN=.*|LDAP_GROUPS_DN=ou=Groups,dc=smoke,dc=test|" \
  -e "s|^BACKUP_S3_ENDPOINT=.*|BACKUP_S3_ENDPOINT=${GATEWAY}:9000|" \
  -e "s|^BACKUP_S3_REGION=.*|BACKUP_S3_REGION=us-east-1|" \
  -e "s|^BACKUP_ARCHIVE_S3_ENDPOINT=.*|BACKUP_ARCHIVE_S3_ENDPOINT=${GATEWAY}:9000|" \
  -e "s|^BACKUP_ARCHIVE_S3_REGION=.*|BACKUP_ARCHIVE_S3_REGION=us-east-1|" \
  "${REPO}/infra/onprem/compose/env.template" > "${ENV_FILE}"
chmod 0644 "${ENV_FILE}"
grep -E '^(MACHVON_EDITION|PUBLIC_HOST|CONTROL_HOST|LDAP_URL|BACKUP_S3_ENDPOINT|BACKUP_S3_BUCKET|BACKUP_ARCHIVE_S3_BUCKET|DB_MEMORY|DB_SHARED_BUFFERS)=' "${ENV_FILE}"
say "done"
