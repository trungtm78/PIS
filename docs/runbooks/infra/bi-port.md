# Runbook: the read-only BI port of the database (opt-in)

Declaration: `infra/onprem/compose/compose.bi.yaml`, `infra/onprem/config/` (`bi-render.sh`, `pg_hba-bi.conf.template`, `bi-firewall.sh`, `bi-audit-setup.sql`, `bi-audit-ship.sh`), `infra/onprem/secrets-bi.json`, the timer `machvon-bi-audit-ship` in `infra/onprem/systemd/`. Rules checked by `npm run infra:check` (`scripts/infra-bi-port.mjs`, rule `BI_PORT`) and tested by `scripts/infra-bi-port.test.mjs`. Requirement: HSKT TH.02 (data to the Data Lakehouse and BI tools through the database or an API, no extra licence). What the person who builds the reports does: `docs/integration/power-bi-connection-guide.md`; what Lakehouse needs: `docs/integration/lakehouse-proposal.md`.

## What it is, and what it is not

A bundle installation publishes only the web edge (80 and 443). The database has no port outside the host. A Power BI gateway or a Lakehouse ingest job that must read the certified views of schema `machvon_bi` with a BI login (`machvon_bi_<12 hex>`, made at INT-04) needs a way in. This is that way, and it is **closed by default**: nothing below happens unless the operator sets `MACHVON_BI=on` (or passes `--with-bi`) and names the addresses.

It is not a general database port. The only role that is accepted from outside is the group role `machvon_bi_reader` (its members are the BI logins), over TLS, from the allowed source addresses, into the application database; every other role (application, control plane, outbox relay, Keycloak, owner) is accepted from the networks of the compose set only. The BI logins read views that are `security_invoker`, bound to one tenant by their own name, and that return nothing while a dataset is not switched on and certified (`machvon_bi.v_dataset_catalogue` says why). The path to the tenant data is therefore: network allowlist, TLS, SCRAM password, group role, row-level security by tenant, certification gate of the dataset.

## The locks, from the outside in

| Lock | Where | What it does |
|---|---|---|
| Listen address | `BI_LISTEN_ADDRESS` (compose `ports`) | The one address of this host the port is published on. Required, no default; `0.0.0.0`, multicast and an empty value are refused by `bi-render.sh`, and `infra:check` refuses a compose file that publishes on every address |
| Host firewall | `config/bi-firewall.sh` (chain `MACHVON-BI` in `DOCKER-USER`) | Accepts only the addresses of `BI_ALLOWED_CIDRS`, each with a limit of `BI_MAX_CONNECTIONS_PER_ADDRESS` open connections, and drops the rest. `install.sh --with-bi` does not start the port while the chain does not exist |
| pg_hba.conf | rendered by `config/bi-render.sh` from `pg_hba-bi.conf.template` | `hostssl` only, only for members of `machvon_bi_reader`, only into the database `machvon`, only from the allowed CIDRs, `scram-sha-256`; a BI login from elsewhere or without TLS is rejected before any other rule; other roles only from `samenet`; the last line rejects |
| TLS | `ssl=on`, `ssl_min_protocol_version=TLSv1.2`, ECDHE suites only | Certificate and key are the secret files `db_tls_cert` and `db_tls_key` (`secrets-bi.json`); `docker/bi-tls-prepare.sh` copies them at start to a tmpfs owned by postgres (the server user keeps no supplementary group, so it could not read the secret files directly) |
| SCRAM | `password_encryption=scram-sha-256`, `authentication_timeout=10s` | INT-04 stores only a SCRAM verifier; the password is shown once |
| Per login | `machvon_bi.provision_reader` (V2200) | `NOSUPERUSER NOBYPASSRLS`, connection limit 1 to 20, statement timeout 60 s, no write grant, one tenant per login |
| Audit | pgaudit in object mode (`pgaudit.role=machvon_bi_auditor`) plus `log_connections` and `log_disconnections` | Every read of a view of `machvon_bi` is logged with the login name and the source address, so are failed logins. See below |

`bi-render.sh` refuses: a source network wider than /16 (so `10.0.0.0/8` and `0.0.0.0/0` are refused), a network address with host bits set, a port below 1024, an audit sink that is not `directory:/absolute/path` or `syslog:host:port`, a retention below 365 days, an empty value anywhere. A wrong value stops the script and writes nothing.

## Switching it on

1. Decide with the Ban CDS&CNTT of the customer: the listen address (an address of the internal network the tools reach), the source addresses (the Power BI data gateway, the Lakehouse ingest host), the certificate (issued by the certificate authority the tools trust; the name or address in it is the one the tools connect to), the audit sink (a mount of their log store, or a syslog collector). These are PX-11 in `docs/delivery/11-pending-external-register.md`; until they answer, leave `MACHVON_BI=off`.
2. Put the two TLS files in the secrets directory like every other secret (root, group `MACHVON_SECRETS_GID`, mode 0440): `db_tls_cert` (leaf first, then intermediates) and `db_tls_key`.
3. In the environment file set `MACHVON_BI=on`, `BI_LISTEN_ADDRESS`, `BI_PORT`, `BI_ALLOWED_CIDRS`, `BI_MAX_CONNECTIONS_PER_ADDRESS`, `BI_CONFIG_DIR`, `BI_AUDIT_SINK`, `BI_AUDIT_RETENTION_DAYS`.
4. Validate, then print the firewall rules and read them: `sh infra/onprem/config/bi-render.sh --check --env-file <env>` and `sh infra/onprem/config/bi-firewall.sh --env-file <env>`.
5. Apply the firewall (as root), and make it persistent with the iptables service of the distribution: `sh infra/onprem/config/bi-firewall.sh --env-file <env> --apply`.
6. Run the installation (fresh or upgrade) with the flag: `sh install.sh --with-bi`. It validates again, checks the secret files and the chain `MACHVON-BI`, renders `pg_hba.conf` into `BI_CONFIG_DIR`, starts the database with `compose.bi.yaml`, runs the migrations, and creates the audit role with its grants on every view of `machvon_bi` (`config/bi-audit-setup.sql`, idempotent: it runs again on every upgrade, so views added by a release are audited from that release).
7. Enable the shipping of the audit trail: `systemctl enable --now machvon-bi-audit-ship.timer` (copy the two units of `infra/onprem/systemd/` as for the backup timers).
8. Only now make the BI logins at INT-04 and hand the connection details (host, port, database `machvon`, login) to the person who builds the reports; the password goes through another channel.

## Checking it (do it on UAT before Production, and keep the output)

- From an allowed host: `psql "host=<address> port=<port> dbname=machvon user=<login> sslmode=verify-full sslrootcert=<ca>" -c "select * from machvon_bi.v_dataset_catalogue"` returns the datasets and `is_open`.
- Negative checks, each must fail: the same with `sslmode=disable` (rejected by pg_hba); from a host that is not allowed (the firewall drops the connection: it times out); with `user=machvon_app` (the rule `+machvon_bi_reader` does not apply and the next rule accepts only the compose networks: rejected); `select * from machvon.period_snapshot_line` (permission denied: only the granted columns of the base tables the views use are readable, and only for the tenant of the login); `set app.tenant_id = '<another tenant>'` then a read (no rows: the tenant comes from the login, not from the setting).
- Open more connections than the limit of the login (INT-04) or than `BI_MAX_CONNECTIONS_PER_ADDRESS` from one source: the extra ones are refused or dropped.
- Audit: after the first read, a line `AUDIT: OBJECT,...,SELECT,VIEW,machvon_bi.v_dataset_catalogue,...` with the login name appears in `db-YYYY-MM-DD.log` in the volume `machvon_dbaudit`, and a failed login is in the same file. After midnight (UTC) run `sh infra/onprem/config/bi-audit-ship.sh --env-file <env>` once by hand and check the file arrived in the sink and `/var/lib/machvon/bi-audit-ledger/` has its `.shipped` entry.

## Audit trail and retention

pgaudit runs in object mode on the role `machvon_bi_auditor`, which holds SELECT on the views of `machvon_bi` and on nothing else: the log holds the reads of the BI views (statement, login, time, source address) and not every query of the application. Parameters are not logged, and the catalogue is not. With `logging_collector=on` the whole server log of the database goes to a daily file `db-YYYY-MM-DD.log` in the volume `dbaudit` while the port is on (so `docker compose logs db` shows only the start-up lines: read the file, or the copy in the sink).

`bi-audit-ship.sh` (daily timer, 01:10) ships every completed day to the sink (`directory:` copies and checks the SHA-256 of the copy, `syslog:` sends the lines over TCP), writes a ledger entry with the SHA-256, and removes a file from the host only when it is older than `BI_AUDIT_RETENTION_DAYS` (400 by default, never below 365) **and** has a ledger entry. A file that could not be shipped stays on the host, the unit fails and shows in `systemctl status`. What the sink keeps, for how long and who may read it is the customer's decision (PX-11).

## Switching it off

Set `MACHVON_BI=off`, empty `BI_LISTEN_ADDRESS`, run `sh install.sh` without the flag (the database is recreated without the port and without TLS files), remove the firewall chain (`iptables -D DOCKER-USER ... -j MACHVON-BI`, `iptables -F MACHVON-BI`, `iptables -X MACHVON-BI`), `systemctl disable --now machvon-bi-audit-ship.timer`. The logins can stay (suspend or retire them at INT-04); without the port they reach nothing. Keep the audit files and the sink for the retention.

## Rotating the certificate

Replace the two secret files, then `docker compose ... up --detach db` with the same files as at install (the copy to the tmpfs happens at start; the database restarts, so do it in the maintenance window). The password of a login is rotated at INT-04, not here.

## Limits and honest status

- **Not lab-tested.** The files are checked statically (`infra:check`) and the scripts that decide something (`bi-render.sh`, `bi-firewall.sh`, `bi-audit-ship.sh`) are run by tests with a POSIX shell, but this repository has no Docker host: the compose merge, the start of PostgreSQL with these settings, pgaudit in the image, the DOCKER-USER rules and the audit lines were not run end to end. The lab checklist (`lab-install-checklist.md`) carries the steps; do them on UAT first.
- The allowlist exists twice (firewall and pg_hba), but pg_hba sees the source address that Docker hands to the container; with the default iptables mode that is the address of the client. If the host runs Docker with an unusual setting that hides the client address (a proxy that rewrites it), the firewall is the lock that holds and the pg_hba lines for the BI group will not match: the connection fails rather than opens.
- IPv4 only. Hosts with several tenants' logins share one port and one audit file; the login name in each line says whose read it is.
- Choosing the network path (the standby of Production, a dedicated address, or the open API instead of the database) remains with the customer (PX-11): `docs/integration/lakehouse-proposal.md` section 6.
