# Runbook: backups, immutable copies, encryption and retention

Policy: `infra/backup/backup-policy.json` (schedule, retention, targets, encryption, immutability, drill). Implementation: `infra/onprem/config/pgbackrest.conf`, `infra/onprem/systemd/`, `infra/backup/bucket/`. Checks: `node scripts/backup-verify.mjs` (offline, part of `npm run infra:check`) and `node scripts/backup-verify.mjs live ...` (against the real bucket).

## Targets

RPO 15 minutes, RTO 4 hours, point-in-time recovery for 35 days (`infra/postgres/backup.json`, `infra/policies/operations.json`). The targets are configuration: the check fails when the policy or the PostgreSQL declaration drifts above them.

## Schedule

| What | When | How |
|---|---|---|
| WAL archive | continuous; a segment switch is forced at least every 60 seconds (`archive_timeout`) | `archive_command` of the database runs `pgbackrest archive-push`, asynchronous with a spool and a 4 GiB queue limit |
| Full backup (day cycle) | daily 01:30 | `machvon-backup-full.timer` runs `backup --type=full` |
| Incremental backup (day cycle) | 05:30, 09:30, 13:30, 17:30, 21:30 | `machvon-backup-incr.timer` |
| Differential backup (week cycle) | Sundays 12:30 | `machvon-backup-diff.timer` runs `backup --type=diff`; the five latest differentials are kept (`repo1-retention-diff`) |
| Full backup into the archive (month cycle) | the 1st of each month 03:00 | `machvon-backup-monthly.timer` runs `backup --type=full --repo=2`; twelve are kept (`repo2-retention-full`) |
| Verification of the repository | Sundays 03:30 | `machvon-backup-verify.timer` runs `pgbackrest verify` (reads the files and checks their checksums) |
| Restore drill | quarterly, and when a component that holds tenant data is added | `restore-drill.md` |

Manual backups (full, differential or incremental) are requested in the admin screen "Backups" (ADM), approved by a second person and run by the host runner as `docker compose ... run --rm backup backup --type=<type>`; the API never runs a backup. The screen shows the last backup of each kind and the last verification, read from the state files of `machvon-backup-info.timer` (every 15 minutes) and the verify service.

The policy keeps at least three latest backups (`retention.minimumBackups`): the daily full backups cover 35 days, the archive repository keeps twelve fulls, and the check refuses a retention value that would keep fewer than three.

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

## Archive repository (repo2) and the separated copy

Old data is archived by the monthly full backup into **repository 2**: its own bucket (`BACKUP_ARCHIVE_S3_BUCKET`), its own writer identity (`backup_archive_s3_*`, ideally an account of the archive site that the operational administrator cannot reach), its own pass phrase (`pgbackrest_archive_cipher_pass`, in escrow with two custodians) and an object lock in COMPLIANCE mode for **400 days** (twelve months plus margin), created with `sh infra/backup/bucket/create-bucket.sh <bucket> <endpoint> <region> archive`. A compromise of the operational bucket, its keys or its pass phrase does not reach the archive. WAL is archived to both repositories; the archive keeps WAL for the last two monthly fulls.

Restore from the archive: the commands of the restore drill with `--repo=2` (for example `restore --repo=2 --set=<label> --type=immutable`); the archive is also what a drill uses to prove that old data can be brought back.

Verify it live next to the operational bucket: `node scripts/backup-verify.mjs live --bucket <operational> --endpoint <url> --archive-bucket <archive> [--archive-endpoint <url>] [--probe]`.

## Offline copy

At least one copy must be separated from operations and survive ransomware that holds the administrator accounts of the installation (HSKT YCK.07). The immutable repositories above are one such copy; the offline copy is the second layer, monthly, after the monthly full backup of the 1st:

1. Two custodians together (neither is a system administrator of the production hosts) read the monthly full backup of repository 2 with the reader identity of the archive site and write it, with its `backup.info` and `archive` files, to write-once or disconnected media (an external disk or tape that is physically disconnected afterwards).
2. Record the media label, the backup label, the sha256 listing of the files and both names in the custody log; store the media in a different room than the production hosts.
3. The media is never connected to a production host. To use it, copy it to the clean host of the restore drill (`restore-drill.md`).
4. Twice a year the drill restores from the offline media instead of the bucket.

The policy declares the copy (`offlineCopy` in `infra/backup/backup-policy.json`) and `npm run infra:check` fails when the declaration or this section is missing.

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

Evidence of a restore drill is one entry in `infra/backup/restore-drill-ledger.json` (see `restore-drill.md`); `node scripts/backup-verify.mjs drill-status` says whether the last drill is current (at most 92 days old, matched). Evidence of the live bucket checks goes to `docs/runbooks/infra/evidence/`.
