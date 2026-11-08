# Runbook: backups, immutable copies, encryption and retention

Policy: `infra/backup/backup-policy.json` (schedule, retention, targets, encryption, immutability, drill). Implementation: `infra/onprem/config/pgbackrest.conf`, `infra/onprem/systemd/`, `infra/backup/bucket/`. Checks: `node scripts/backup-verify.mjs` (offline, part of `npm run infra:check`) and `node scripts/backup-verify.mjs live ...` (against the real bucket).

## Targets

RPO 15 minutes, RTO 4 hours, point-in-time recovery for 35 days (`infra/postgres/backup.json`, `infra/policies/operations.json`). The targets are configuration: the check fails when the policy or the PostgreSQL declaration drifts above them.

## Schedule

| What | When | How |
|---|---|---|
| WAL archive | continuous; a segment switch is forced at least every 60 seconds (`archive_timeout`) | `archive_command` of the database runs `pgbackrest archive-push`, asynchronous with a spool and a 4 GiB queue limit |
| Full backup | daily 01:30 | `machvon-backup-full.timer` runs `backup --type=full` |
| Incremental backup | 05:30, 09:30, 13:30, 17:30, 21:30 | `machvon-backup-incr.timer` |
| Verification of the repository | Sundays 03:30 | `machvon-backup-verify.timer` runs `pgbackrest verify` (reads the files and checks their checksums) |
| Restore drill | quarterly, and when a component that holds tenant data is added | `restore-drill.md` |

Alerts: `pg-wal-archive-failure` (P1, archive failing or older than 120 s), `pg-backup-age` (P1, last full older than 26 hours), both on the independent `ops-pager` channel (`infra/alerts/postgres.json`).

## Immutable copies

The repository is an S3 compatible bucket at the **second site** with:

- **object lock in COMPLIANCE mode**, default retention **36 days** (the 35-day recovery window plus one day): no one, including the bucket administrator, can delete or shorten a locked version until its retention ends;
- **versioning** on (object lock needs it); a delete only adds a marker;
- **default encryption** (server side, AES-256) and **client-side AES-256 encryption by pgBackRest** with a pass phrase that lives only in the secret file `pgbackrest_cipher_pass` and offline in escrow with two custodians;
- public access blocked, TLS 1.2 or newer to the store;
- a **writer identity that cannot weaken the lock**: `infra/backup/bucket/writer-policy.json` allows read, write and list and **denies** bypassing governance retention, changing the lock configuration, deleting object versions, deleting the bucket, changing versioning, lifecycle or the bucket policy. The bucket administrator and the writer are different identities held by different people (`adminAndWriterAreDifferentPeople`).

Create the bucket with `infra/backup/bucket/create-bucket.sh <bucket> <endpoint> [region]` as the object store administrator. Object lock can only be switched on at creation: a bucket created without it must be replaced.

Why COMPLIANCE: the threat is ransomware or an insider with administrator rights deleting the backups together with the data. GOVERNANCE mode lets a privileged identity override the lock and is refused by the check. The consequence is real: a wrong amount of data written into the bucket stays there for 36 days and is paid for; do not point test installations at the production bucket.

pgBackRest expires old backups (35-day retention): with versioning the delete becomes a marker and the space is released when the lock of those versions ends.

## Verify the immutability

Offline (every build, part of `npm run lint`): `node scripts/backup-verify.mjs` checks the policy, the bucket setting files, the writer policy, the pgBackRest configuration (client-side cipher, no secret option written in it, retention equal to the policy), the systemd timers against the schedule, the targets against the declaration and the operations limits.

Live (after creating the bucket, after every change of the object store, and monthly): from a host with the AWS CLI configured for the **writer** identity:

```
node scripts/backup-verify.mjs live --bucket <bucket> --endpoint <url> --region <region> --evidence evidence/backup-lock-<date>.json
node scripts/backup-verify.mjs live --bucket <bucket> --endpoint <url> --region <region> --probe --evidence evidence/backup-lock-probe-<date>.json
```

The first reads the lock configuration (enabled, COMPLIANCE, at least the policy's days), versioning and default encryption. The probe writes one tiny object, then tries to delete its version and to shorten its retention: **both must be refused**; if either succeeds the check fails, the object lock is not protecting the backups and the incident process starts. The probe object stays until its retention ends. The evidence file holds the time, the checks and the sha256 of the policy.

## Restore, and what the lock changes

A restore reads the repository; nothing in the lock gets in its way. Losing `pgbackrest_cipher_pass` makes every backup unreadable: that is why it is in escrow. Rotating the pass phrase means starting a new stanza or repository (pgBackRest cannot re-encrypt in place): plan it with a full backup in the new repository before the old one is retired.

## Failures

| Alert or symptom | Do |
|---|---|
| `pg-wal-archive-failure` | `SELECT * FROM pg_stat_archiver`; check the path to the second site, the bucket and the credentials (rotated?). Never delete WAL on the primary to free disk |
| `pg-backup-age` | read the pgBackRest log of the last run, fix the cause, run `backup --type=full` by hand, confirm with `info` |
| `verify` reports a bad checksum | the repository copy is damaged: the next full backup creates a good chain; investigate the object store; an immutable copy cannot be repaired in place |
| the live check or the probe fails | the lock is weaker than the policy: do not rely on the backups as immutable; recreate the bucket with the settings of `infra/backup/bucket/`, take a full backup into it, keep the old one until its retention |
| bucket full | the lock keeps versions for 36 days; extend the store or shorten nothing |

Evidence belongs to `docs/runbooks/infra/evidence/` (template in the README of this folder).
