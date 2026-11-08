#!/bin/sh
# Runs once, when the data directory is created: the database and the role of Keycloak. The password is read by psql from the secret file, never from this repository.
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<'SQL'
\set keycloak_login `cat /run/secrets/keycloak_db_password`
CREATE ROLE keycloak LOGIN PASSWORD
  :'keycloak_login';
CREATE DATABASE keycloak OWNER keycloak;
SQL
