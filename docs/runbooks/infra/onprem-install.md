# Runbook: on-prem installation from the offline bundle

Declaration: `infra/onprem/` (images, compose set, nginx edge, secrets list, install and rollback scripts), built into one directory by `scripts/onprem-bundle.mjs`. Nothing here touches a customer system until a person runs the install on the customer's host.

## What the bundle is

One directory, built once per release and per customer host name on the vendor build host (which has network access), installed on a host that has none:

| Item | What |
|---|---|
| `images/*.oci.tar` | the images as OCI archives, each holding **linux/amd64 and linux/arm64**: `machvon/api`, `machvon/workers`, `machvon/web`, `machvon/db` (PostgreSQL 18 with pgBackRest) and Keycloak |
| `sbom.cdx.json` | CycloneDX SBOM of the lockfile, the pub packages and the base images (`scripts/sbom.mjs`) |
| `manifest.json`, `VERSION` | version, edition, public host, build time, per-archive checksums and platforms, digests of the third-party images |
| `SHA256SUMS` | checksum of every other file of the bundle, in `sha256sum --check` format |
| `install.sh`, `rollback.sh` | the procedures below |
| `infra/onprem/`, `infra/keycloak/onprem/`, `infra/backup/` | compose set, nginx and pgBackRest configuration, systemd timers, secrets list, realm import, backup policy and bucket settings |
| `docs/runbooks/infra/` | these runbooks, so the customer's administrators have them offline |

All versions are pinned: third-party images by tag and digest (`infra/onprem/images.json`), the images of the product by the release version. There is no `latest` anywhere (`npm run infra:check` fails on one).

## Build (vendor side)

```
node scripts/onprem-bundle.mjs plan  --version 1.0.0 --public-host machvon.customer.vn          # prints the commands, runs nothing
node scripts/onprem-bundle.mjs build --version 1.0.0 --public-host machvon.customer.vn --edition public --out dist/onprem
node scripts/onprem-bundle.mjs verify dist/onprem
```

Needs Docker with buildx (and QEMU, or both architectures' runners) and `skopeo`. The web image is built for one public host because the OIDC issuer is compiled into the web build; the other images do not depend on the host. `verify` re-checks every checksum, that the files present are the files listed, and that **every image archive holds both platforms**. Sign `SHA256SUMS` (`gpg --detach-sign`) and send the signature with the bundle by a different channel than the bundle; the customer verifies it before anything else.

## Host requirements

| Item | Requirement |
|---|---|
| Operating system | Linux, amd64 or arm64 (the same bundle installs on both) |
| Docker | Docker Engine 28 or newer with the containerd image store (loads multi-platform archives and keeps digests), Compose v2.24 or newer. Without it, `skopeo` loads the archives for the host's architecture |
| Reference size, one host | 8 vCPU, 24 GB memory, 500 GB SSD for PostgreSQL and its WAL; the limits in `compose/env.template` are the starting point |
| Network | inbound 80 and 443 to the web edge only; outbound only to the directory (LDAPS) and the object store of the second site (the `egress` network, limited by `egress-firewall.sh`); the app and data networks have no route out |
| Time | NTP synchronised (tokens, TOTP and the 15-minute lock depend on it) |
| Names | DNS for `PUBLIC_HOST` and `CONTROL_HOST`; a certificate from the customer's authority valid for both |
| Directory | LDAPS reachable, a read-only service account, the groups `MACHVON-*` created by the directory team (`infra/keycloak/onprem/ad-group-role-map.json`) |
| Object store | at the second site: S3 compatible with object lock (see `backup-immutable.md`) |

Data residency: the installation, the backups and the logs stay on the customer's premises or the domestic regions of `infra/policies/residency.json`.

## Secrets

Create each file named in `infra/onprem/secrets.json` under `MACHVON_SECRETS_DIR`. Compose mounts a secret file as it is on the host, and the services run as unprivileged users (`node`, `postgres`, `nginx`, `keycloak`), so the files are owned by root with the group `MACHVON_SECRETS_GID` (1900 by default, set in the `.env`), mode 0440, and the directory 0750; every service joins that group (`group_add`). Create the group and apply the ownership as root:

```
groupadd --gid 1900 machvon-secrets
chgrp -R 1900 "$MACHVON_SECRETS_DIR" && chmod 0750 "$MACHVON_SECRETS_DIR" && chmod 0440 "$MACHVON_SECRETS_DIR"/*
chown 999 "$MACHVON_SECRETS_DIR/keycloak_db_password"     # the database init script reads it as the postgres user (uid 999)
```

`install.sh` refuses to start when a file has another group, is not group-readable or is readable by others. The file lists who reads each secret, how to generate it and its rotation period. Nothing secret is written into the compose file, the environment file or an image: services read `NAME_FILE` variables through `secret-env`. Escrow `pgbackrest_cipher_pass` offline with two custodians before the first backup: without it no backup can be read.

The images carry what the migrations and the API need and nothing else: the database image is PostgreSQL 18 with pgBackRest and **pgvector** (the first migration creates the `vector` extension), the API and workers images carry the production dependencies **including `@swc/core`** (the loader that runs the TypeScript sources) and the design schema file that the migration job checks the migrations against, and the web image renders its nginx configuration into a memory file system at start (the root file system is read-only).

## Install

1. Verify the signature of `SHA256SUMS` and run `sha256sum --check SHA256SUMS` in the bundle directory.
2. Copy `infra/onprem/compose/env.template` to `infra/onprem/compose/.env` and fill it in (host names, directory settings, backup bucket, sizing). `MACHVON_VERSION` is overwritten by the script from `VERSION`.
3. Create the secret files.
4. Limit the way out: the database (WAL archive and backups), the backup runs and Keycloak (the directory) are the only services with a route out of the host, through the `egress` network (fixed subnet 172.29.250.0/24); the app and data networks have none. Apply the host firewall rules that allow that subnet to the object store and the directory only: `sh infra/onprem/config/egress-firewall.sh <object store host> <port> <directory host> <port> --apply` (without `--apply` it prints the rules for review).
5. Create the backup bucket (`infra/backup/bucket/create-bucket.sh`) as the object store administrator; create the writer identity with `writer-policy.json`.
6. `sh install.sh`. It checks the bundle again, loads the images, checks the secret files and the compose file, starts the database, creates the pgBackRest stanza, runs the migrations, sets the passwords of the database roles from the secret files, starts every service and waits for all health checks.
7. Install the systemd units from `infra/onprem/systemd/` (`machvon-backup-full.timer`, `machvon-backup-incr.timer`, `machvon-backup-verify.timer`) and enable the timers. The backup commands use `/etc/machvon/compose.env` (a copy of the `.env`) and `/opt/machvon/current` (a link to the installed bundle).

### Optional: the read-only BI port

The database publishes nothing outside the host. For Power BI or the Data Lakehouse of the customer there is an opt-in, closed-by-default read-only port (`MACHVON_BI=on`, `sh install.sh --with-bi`): one named listen address, a host firewall allowlist, TLS 1.2 or newer, SCRAM, only the BI group role reachable from outside, a connection limit, and a pgaudit trail shipped off the host. It is not part of a normal install; read `bi-port.md` first and do not switch it on before the customer has named the addresses, the certificate and the audit sink (PX-11).

## After the install

1. First Keycloak administrator: sign in once with `KEYCLOAK_ADMIN_USER` and its secret, create named administrators with WebAuthn, then disable the bootstrap account.
2. Import check: federation test and full sync, then the cases of `docs/security/identity-test-plan.md`.
3. Health: `docker compose ps` shows every service healthy; `https://<PUBLIC_HOST>/api/health/ready` answers 200.
4. Backups: run `docker compose --profile tools run --rm backup backup --type=full`, then `check` and `info`; run `node scripts/backup-verify.mjs live --bucket <b> --endpoint <url> --probe` from an operations host.
5. Restore: the first restore drill (`restore-drill.md`) before real data is entered; its evidence unlocks the entry gate of the components.
6. TLS and headers: `docs/runbooks/infra/tls-headers.md`, the checks at the end.

## Health checks and limits (what the compose file guarantees)

Every long-running service has a health check (database `pg_isready`; Keycloak the realm discovery document; API readiness, which also fails while a migration is pending; workers liveness; web `/healthz`), resource limits and reservations, `no-new-privileges`, all capabilities dropped except what the database and the edge need, a read-only root file system for the API, workers and web, and log rotation. Only the web edge publishes ports.

## ARM (aarch64) notes

- The same bundle serves both architectures: Docker picks the platform of the host from the image index. Nothing in the product is x86-only: `npm run native-deps:check` lists the native npm packages and fails if one that reaches production has no linux arm64 build; `embedded-postgres` is **test-only** (it starts a throwaway PostgreSQL for the database test suites, is never installed in a production image) and has an arm64 build anyway.
- CI proves it: the `ARM64 build and unit tests` job of `ci.yml` runs on `ubuntu-24.04-arm`, and `images.yml` builds and scans every image natively on both architectures.
- Phone application: Flutter builds arm64 for Android (`arm64-v8a`, the default of `flutter build apk` and app bundles) and for iOS (arm64 devices; the simulator on Apple silicon is arm64 too). Keep `x86_64` Android only for emulators on x86 development machines; the store builds ship `arm64-v8a` (and `armeabi-v7a` while the minimum Android version needs it). A plugin without an arm64 binary fails the build, which `.github/workflows/mobile.yml` shows.
- Development on Windows, macOS (Intel and Apple silicon) and Linux: the scripts are plain Node 24 and POSIX shell; the lockfile resolves the platform packages of every operating system.

## Not covered by the lane that wrote this

The compose file, the Dockerfiles, the nginx configuration, the install script and the realm import were validated by static checks and unit tests only. They were not run: no Docker, no Compose, no Keycloak and no PostgreSQL server were started. The first installation on a lab host is where they are proven; fix what it shows in the files and their tests.
