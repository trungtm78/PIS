-- Runs once, when the data volume is created: the database of the product, and the role and the database of Keycloak. The password is read by psql from the secret
-- file (a hex string), never from this repository.
\set keycloak_login `type C:\\run\\secrets\\keycloak_db_password`
CREATE DATABASE machvon OWNER machvon_owner;
CREATE ROLE keycloak LOGIN PASSWORD :'keycloak_login';
CREATE DATABASE keycloak OWNER keycloak;
