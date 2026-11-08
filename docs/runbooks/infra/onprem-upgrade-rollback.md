# Runbook: upgrade and rollback of an on-prem installation

Procedures: `infra/onprem/bundle/install.sh` (also the upgrade) and `rollback.sh`. Policy: `infra/pipelines/production.json` (rollback within 15 minutes), `docs/runbooks/infra/rollback.md` (expand-contract schema).

## Principles

1. An upgrade installs a **new bundle** next to the old one; the old bundle stays on the host until the next upgrade has proved itself, because the rollback needs its images and its compose file.
2. The schema is never rolled back. Migrations are expand-contract (`npm run expand-contract:check`), so release N-1 works with the schema of release N. A contract step (dropping a column) ships one release after the code stopped using it.
3. A full backup and a backup check come first. Rolling back the application is fast; recovering from a bad data change is the restore runbook, not a rollback.

## Upgrade

1. Verify the new bundle (signature, `sha256sum --check`, `node scripts/onprem-bundle.mjs verify <bundle>` if Node is available).
2. Read the release notes for migrations, new secrets (`infra/onprem/secrets.json` lists them) and new environment variables (`compose/env.template`); create the secret files and copy new variables into the `.env`.
3. Confirm the last backup is younger than 26 hours and the last restore drill is within the quarter.
4. Unpack the new bundle at `/opt/machvon/<version>`; keep `/opt/machvon/<previous version>`.
5. `sh /opt/machvon/<version>/install.sh --env-file /etc/machvon/compose.env`. On a host that already has a database the script: checks the bundle, loads the images, checks secrets, takes a **full backup and checks it**, records the previous version in `/var/lib/machvon/previous-version`, runs the migrations, then replaces the services and waits for the health checks. (`--skip-backup` exists for a lab; using it on production is a decision of the release manager, recorded in the change.)
6. Point `/opt/machvon/current` at the new directory.
7. Smoke: sign in with MFA, open one screen of each module in use, check `https://<PUBLIC_HOST>/api/health/ready`, check the alert channel is quiet for 15 minutes.

The production pipeline (`infra/pipelines/production.json`) is the vendor's own canary by tenant cohort (5 percent, 25, 100) with two approvers; an on-prem installation is one customer, so the equivalent is: staging installation first, then production in a maintenance window.

## Rollback (target: 15 minutes)

When: error rate, latency or an isolation problem after the upgrade, and the cause is the new application code.

1. If the change sits behind a feature flag, switch the flag off first: it is faster than a rollback.
2. `sh /opt/machvon/<previous version>/rollback.sh /opt/machvon/<previous version> --env-file /etc/machvon/compose.env`. It checks the previous bundle's checksums, refuses to continue if the previous images are not loaded, starts the previous release's services and waits for their health checks. The database is left as it is.
3. Point `/opt/machvon/current` back at the previous directory.
4. Record the cause; fix forward in a new release. Do not edit a migration that already ran.

When the data is damaged (a wrong migration of data, a wrong import): do not roll back. Use `restore-drill.md` (the same tooling restores a tenant to a recovery point: SAS-21) and follow the incident process.

## If the upgrade stops half way

| Where it stopped | State | Do |
|---|---|---|
| before the migrations | the old release still runs | fix the cause (missing secret, a failed health check) and run `install.sh` again: it is repeatable |
| during the migrations | PostgreSQL rolled the failing migration back (each migration is transactional) | read the error, fix forward; the old release still runs on the old schema |
| after the migrations, before the services came up | the schema is new, the services are old or stopped | run `install.sh` again, or `rollback.sh` (the old release works with the new schema) |
| the new release is unhealthy | the schema is new | `rollback.sh` |

## Checks the pipeline already did

`npm run migrations:check`, `npm run expand-contract:check`, the N-1 schema compatibility test (`packages/db/test/schema-compatibility.test.ts`), the contract compatibility check against the base, the SBOM and audit, the image scans, and the multi-platform build.
