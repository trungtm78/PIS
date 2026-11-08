# Runbook: restore drill of the whole installation, with checksum comparison

Schedule: quarterly (`infra/backup/backup-policy.json`, `maxDaysBetweenDrills` 92), and when a component that holds tenant data is added. Tooling: `scripts/restore-drill.mjs` (entry of `packages/db/src/restore-drill-cli.ts`), which **extends the tenant restore tooling** instead of duplicating it: the manifests are measured with `TenantRestoreStore.measure` and compared by `verifyRestore`, the function that verifies the restore of one tenant (SAS-21, `docs/runbooks/tenant-restore-drill.md`), so a cluster drill and a tenant restore judge a copy the same way: same tables, same rows, same checksum, same money totals.

Targets measured by the drill: RPO 15 minutes, RTO 4 hours (`RESTORE_RPO_TARGET_SECONDS`, `RESTORE_RTO_TARGET_SECONDS`).

## Who and where

Two people (one operates, one witnesses and signs), a **clean host** at the second site (never the production host), the synchronous standby of production, the bundle of the release in production, the backup bucket credentials for reading. The restored database is never connected to the production API, the directory or the mail relay: start nothing but PostgreSQL (and the API with workers disabled for the smoke step, on an isolated network).

## Procedure

1. **Freeze the reference on the standby.** The source manifest and the restore must describe the same instant, so the reference is taken on the synchronous standby with its replay paused (production keeps taking writes; announce the drill and expect the `pg-replication-lag` alert, P2, after five minutes: keep the pause short). On the standby:

   ```
   SELECT pg_wal_replay_pause();
   SELECT pg_last_xact_replay_timestamp();   -- X: the recovery point P of the drill, in UTC
   ```

   Then take the **source manifest** from the standby (read-only snapshots, one per tenant):

   ```
   DATABASE_URL_APP=<machvon_app url of the standby> DATABASE_URL_CONTROL=<machvon_control url of the standby>      npm run restore:drill -- measure --role source --out drill/source.json --files-list drill/source-files.txt
   ```

   `source-files.txt` is the list of object keys the rows refer to (one per line, from the object store listing taken at X). The command prints `sha256 <hash>  drill/source.json`: copy it into the minutes. Resume the standby at once: `SELECT pg_wal_replay_resume();`. Make sure the WAL up to X is archived (`SELECT pg_switch_wal();` on the primary and wait for `pg_stat_archiver`).
2. **Start the clock.** Note the start time S (UTC): the RTO runs from here.
3. **Restore.** On the clean host, from the bundle: `docker compose --profile tools run --rm backup restore --type=time --target="<X>" --target-action=promote --delta` into a new data directory, start PostgreSQL, wait until it accepts connections. The instant the restore stopped at is R (read `pg_last_xact_replay_timestamp()` before promotion, or the recovery log line); R should equal X, and the RPO the report prints is X minus R.
4. **Check the cluster itself.** `pgbackrest verify`, `pg_amcheck` on the largest tables, and `docker compose run --rm migrate` must report "nothing to apply" (the schema is the current one).
5. **Restored manifest.** Against the restored cluster:

   ```
   DATABASE_URL_APP=<restored machvon_app url> DATABASE_URL_CONTROL=<restored machvon_control url> \
     npm run restore:drill -- measure --role restored --out drill/restored.json --files-list drill/restored-files.txt
   ```

   For the file references list the object keys present in the restored object store copy (or the replica of the second site).
6. **Compare.** End time V (UTC), then:

   ```
   npm run restore:drill -- compare --source drill/source.json --restored drill/restored.json \
     --recovery-point <X> --restored-to <R> --started-at <S> --verified-at <V> --out drill/report.json
   ```

   It prints the sha256 of the report and of both manifests (the **checksum comparison** of the drill: tables, rows, per-table checksum, money totals per tenant, tenants present, file references), the RPO and RTO, every difference as `MISMATCH tenant:kind:detail`, and a verdict. Exit code 0: matches and meets the targets; 1: does not match; 3: matches but misses a target; 2: wrong call.
7. **Application smoke.** On an isolated network start the API (workers off) against the restored database and the realm export import: one sign-in per client, one read per module in use.
8. **Record.** Write `docs/runbooks/infra/evidence/<component>.md` per the template of the README (and set `restoreEvidence` in the component file in the same commit): the release version restored, the recovery point, S, R, V, the elapsed time against the RTO, the three sha256 lines, the verdict, the two names. For the Keycloak component add the realm import result.
9. **Clean up.** The restored host holds real data: destroy it when the minutes are signed.

## Reading the result

| Verdict | Meaning | Do |
|---|---|---|
| matches, within targets (exit 0) | the drill passes | sign; the evidence unlocks the entry gate |
| matches, outside RPO or RTO (exit 3) | the data is whole but the targets are missed | sign with the finding; fix capacity or schedule (a longer RTO needs the owner's decision, never a silent change of the target) |
| does not match (exit 1) | `rows:`, `checksum:`, `money:`, `missing_table:`, `unexpected_table:`, `missing_tenant:`, `unexpected_tenant:`, `file_references` | the drill fails; the backup chain is not trustworthy until fixed; open an incident, take a new full backup, repeat |
| a tenant in the restored cluster that is not in the source (`unexpected_tenant`) | wrong recovery point or a mixed-up host | stop, do not use the restored cluster |

## Limits

The restore of the whole cluster needs the pgBackRest repository and a clean host: the lane that wrote this runbook could not run it (no PostgreSQL server of the product's version, no object store). The manifests and the comparison are tested against a real database (`packages/db/test/restore-drill.test.ts`); the restore step itself is proven at the first drill. A drill that used the MOCK engine or a copy of a development database is a rehearsal and says so in its minutes.
