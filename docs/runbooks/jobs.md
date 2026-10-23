# Runbook: scheduled jobs

Stories: ST-ADM-001, ST-ADM-002. Code: `packages/kernel/src/scheduler.ts` (port and timer adapter),
`packages/db/src/job-runner.ts` (lock, history, alert), `packages/db/src/jobs.ts` (the jobs).

## The jobs

| Job | Interval | What it does | Runs in |
|---|---|---|---|
| `audit-seal` | 5 minutes | seals the new audit rows of every tenant into a chained Merkle window | API process (workers) or command line |
| `audit-verify` | hourly | walks every seal chain; a broken window raises `AUDIT_CHAIN_BROKEN`, then the job itself fails | API process (workers) or command line |
| `outbox-relay` | 5 seconds | one relay batch; raises `OUTBOX_LAG` and `OUTBOX_EVENT_DEAD` | API process only (it owns the broker adapter) |
| `idempotency-purge` | hourly | deletes expired idempotency rows that no legal hold contains | API process or command line |
| `certificate-expiry` | daily | marks the signing certificates whose validity has ended as `Expired` in every tenant (reads already report them as Expired; the 30-day warning of ADM-08 is computed when the register is read) | API process only |
| `master-activation` | hourly | puts the master data versions whose date has come in force, retires the records whose retirement date has come, and sets `mdm_change_pending_gauge` to the number of change requests that wait for a reviewer in all tenants (ST-MDM-001; the pass is idempotent) | API process only |
| `access-cache-expiry` | every minute | drops the lapsed entries of the access cache of the process | API process only |

"Every tenant" is the tenant registry plus the platform tenant, which holds the audit rows of control-plane commands.
One tenant failing does not stop the others; the job then fails with `TenantJobsFailed` after the last tenant.

## One owner per job

A runner takes `pg_try_advisory_lock(hashtextextended('job:<name>', 0))` on a dedicated connection and holds it for the
run. Any number of API processes and command lines can run the same job; the one that does not get the lock records
`SKIPPED` and does nothing. The lock belongs to the database session, so a runner that dies (process killed, connection
cut, backend terminated) frees it, and the next runner of the next interval takes over. A run whose connection dies
before it ends is recorded `FAILED` with error class `JobLockLost`: another runner may have started the job meanwhile,
so check the job is idempotent for that window (all of the above are).

## Run a job by hand

```
DATABASE_URL_APP=postgres://...machvon_app...  DATABASE_URL_CONTROL=postgres://...machvon_control...  npm run jobs:run -- audit-seal
```

`audit-seal`, `audit-verify` and `idempotency-purge` are available. Exit code 0: the job succeeded, or another runner
holds it (the output says `SKIPPED`); 1: it failed (one JSON line per alert is printed before); 2: usage or
configuration. The relay and the access cache are refused with the usage line.

## Alerts

| Alert | Raised by | Context | First action |
|---|---|---|---|
| `JOB_FAILED` | the runner, once per failed run | `job`, `errorClass` (never a message) | read the process log for the job name at that time; the next interval runs again on its own |
| `AUDIT_CHAIN_BROKEN` | `audit-verify`, per tenant | `tenantId`, seal id, `fromSeq`, `toSeq`, `reason` | follow `docs/runbooks/audit-tamper-drill.md`; the `audit-verify` run also fails, so `JOB_FAILED` follows it |

A `JOB_FAILED` for `audit-verify` with error class `AuditChainBroken` is the same incident as the `AUDIT_CHAIN_BROKEN`
alert before it, not a second one.

`job_runs_total{job, outcome}` counts the runs (`SUCCESS`, `FAILED`, `SKIPPED`). A job whose counter stops moving is not
running anywhere: check the API processes and the scheduler of the deployment.

## In the API process

`npm start` (`apps/api/src/serve.ts` through `bootstrap.ts`) starts the workers once the server listens, unless
`WORKERS_ENABLED=false` (see `docs/runbooks/api-runtime.md`). The code is `apps/api/src/workers/`:

- `startWorkers` builds the job runner (one owner per job, advisory lock on a connection of the relay role), the outbox relay and
  `standardJobs`, and registers `runner.scheduled(name, JOB_INTERVAL_SECONDS[name])` for each job on the `IntervalScheduler`
  (`@machvon/kernel`) with the intervals of the table above. The next run is timed from the end of the previous one, so a slow
  job never overlaps itself. The first run of a job comes one interval after the process started (the daily job therefore
  runs only in a process that lives for a day, or in the one that took over from it).
- `createOutboxConsumers` and `createOutboxPublisher` are the `publish` of the relay: every delivery goes to the tenant provisioning
  consumer (`sas.tenant.requested.v1`), the entitlement cache consumer (`sas.entitlement.changed.v1`), the tenant status consumer
  (`sas.tenant.status_changed.v1`) and the notification consumer (only for event types registered and Active in
  `notification_event_type`). A delivery fails when any consumer fails; the relay retries it and the inbox row of each consumer makes
  the ones that succeeded a duplicate. The end-to-end stack (`apps/api/test/e2e-stack/serve.stack.ts`) runs this same code with a 1
  second relay interval.
- One alert sink (`createAlertSink`: one JSON line on standard error per alert, and the webhook `ALERT_WEBHOOK_URL` when set) is
  handed to the relay, the seal job, the job runner and the signed-context check of every consumer, so `OUTBOX_LAG`,
  `OUTBOX_EVENT_DEAD`, `OUTBOX_CONTEXT_TAMPERED`, `AUDIT_CHAIN_BROKEN` and `JOB_FAILED` leave the process.
- A tick never takes the process down. The runner records a failed run (`FAILED`) and raises `JOB_FAILED`; a failure that still
  escapes the runner is written as one line `{"level":"error","message":"worker tick failed","job":...,"errorClass":...}` (class
  only, never a message) and raised as `JOB_FAILED` as well. The schedule carries on with the next interval.
- Shutdown: on SIGTERM the HTTP server stops accepting, the timers are cleared at once and `stop()` waits for the tick in flight
  before the pools are closed. A second `stop()` is a no-op.

Several API processes can run the workers together: each job has one owner at a time, the others record `SKIPPED`. A process that
only serves requests runs with `WORKERS_ENABLED=false`. With the switch off nothing of the above is created: no timer, no pool
connection of the relay role, and the outbox events wait (`OUTBOX_LAG` fires from a process that runs the relay).

Limits that remain (TODOS.md, "Workers in the API process"): the provisioning saga runs on the MOCK infrastructure ports and the MOCK
mailer until the real adapters of Task 20 exist; a provisioning run that was in flight when its process died is not resumed after the
restart (`resumeUnfinishedRuns` is not called: it needs a single owner, which the Temporal adapter provides); the `job_runs_total`
counter has no exporter in the process yet (the history of the runner is in memory).

Tests: `apps/api/test/workers/workers-runtime.test.ts` (database lane: an event written by an HTTP command is relayed with no manual
run, a planted tamper is found by the started verify job and alerts, stop and the switch), `workers.test.ts` and
`outbox-consumers.test.ts` (no database: failing ticks, intervals, tampered deliveries).
