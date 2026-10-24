# Runbook: retention policy versions and the nightly retention job

Story: ST-ADM-017 (ADM-12, ADM 3.12, BR-ADM-11). Code: `packages/kernel/src/retention.ts` (the rules and the classes),
`packages/db/src/retention-policy-store.ts` (versions), `packages/db/src/retention-job.ts` and `retention-sources.ts` (the run),
`apps/api/src/modules/adm/retention-policy.controller.ts` (the two commands), `packages/db/src/jobs.ts` (the schedule),
migration `V1303__adm1_retention_policy.sql`.

## Two kinds of record class

| Kind | Classes | What the run does | Allowed `end_action` |
|---|---|---|---|
| BUSINESS | `*_dossier`, `report_revision`, `contract*`, `payment*`, `audit_event` | lists a record whose period has run out on the review list (`retention_review_item`) once. **Never deletes it.** A person (the council of the Law on Archives) decides | `REVIEW_FOR_DESTRUCTION`, `ARCHIVE_TRANSFER` |
| TECHNICAL | `idempotency_record`, `outbox_event`, `integration_event_inbox`, `user_session`, `delivery_attempt` | removes what has outlived its period | `AUTO_PURGE_TECHNICAL` |

`AUTO_PURGE_TECHNICAL` for a business class, a technical class with any other end action, and `PERMANENT` with a number of years are refused
with 422 `RETENTION_POLICY_INVALID` (`errors` lists every finding with an i18n key). The same rules are database checks
(`data_retention_policy_purge_chk` and others), and a test compares the list of technical classes in the check with the list in code.

## The technical periods

The platform period of a class is the least it is kept; a published policy of the tenant can only **lengthen** it, or keep the class for good (`PERMANENT`).

| Class | Removed when | Notes |
|---|---|---|
| `outbox_event` | `PUBLISHED` more than 30 days ago | `PENDING` and `DEAD` events are never removed: they are the evidence of an incident |
| `integration_event_inbox` | payload: finished (`PROCESSED`, `DEAD`) more than 90 days ago, the stored file is removed first and then the reference is emptied; metadata: finished and without payload more than 730 days ago | a failure to remove the file leaves the event for the next run (`retention_payload_remove_failed_total`) |
| `user_session` | revoked or last seen more than 180 days ago | |
| `delivery_attempt` | created more than 365 days ago | |
| `idempotency_record` | expired and created more than 7 days ago | a safety net of the hourly `idempotency-purge`; a policy cannot keep an expired key (it is never honoured again) |

## Legal holds come first

Every statement that removes or empties something carries `not machvon.legal_hold_blocks(resource_type, resource_id)`: a record that an Active hold
contains is skipped, not failed. A hold on the whole tenant keeps every technical row of the tenant and every business record. A hold on a
project (or a unit above it) keeps the project off the review list until it is released; the next run lists it. A seal window of the audit
trail is held as soon as one row in it is. The run counts what it skipped (`retention_skipped_held_rows`).

## How the business classes are read

`retention-sources.ts` knows where the records of a class are: `project_dossier` (table `project`: from creation, from the day it was CLOSED, or from
the last day of its contracts) and `audit_event` (by seal window, from creation). A class with a published policy and no source is reported as
`noSource` in the result of the run (the module that owns the records adds its source when its tables exist).

## Schedule and alerts

`retention-purge` is an hourly tick (`JOB_INTERVAL_SECONDS`) that does work only in the 01:00 hour of Vietnam time, once a night wherever the
process started. It runs the tenants one by one (a failing tenant does not stop the others), each class in a transaction of its own (a failing class does
not stop the others), and then fails with the names of the classes only. A failed run raises `JOB_FAILED` for `retention-purge`; read the process log for
the error class and run it again by hand after fixing the cause (the run is idempotent).

Metrics (gauges of the last run, by `record_class` and `tenant_id`): `retention_purged_rows`, `retention_review_listed_rows`,
`retention_skipped_held_rows`; `retention_review_pending_gauge` is the number of items waiting in all tenants (alert when it grows for a week without
a decision). Each run that did something writes `retention.purged` or `retention.review_listed` in the audit trail with the counts.

## Relation to master data `RETENTION_POLICY`

The platform publishes `RETENTION_POLICY` (master data, DGV, platform only: the period of a class of data, its classification, whether a hold may
cover it). It is a **baseline**, never executed by a job. The rule that jobs execute is the tenant's `data_retention_policy`, a version drafted by one
person and published by another. The two meet in one rule: when the catalogue names a class (its key in upper case, `CONTRACT_RECORD` for
`contract_record`), a tenant policy for that class cannot keep it for less than the catalogue does (422 `BELOW_PLATFORM_BASELINE` in `errors`); a class
that the catalogue keeps for good must be kept for good. A class the catalogue does not name is bound by nothing. Both are placeholders until the legal
owner confirms CXN-RET-01 to CXN-RET-03 (and CXN-05 for the catalogue); ADM-12 says so on every screen.

## Versions

- A draft is revision N+1 of its class and replaces the draft that is open for the class (superseded); one draft and one version in force per class.
- Publishing needs another person than the author (403 `SELF_APPROVAL_DENIED`), a draft whose version is the one the caller saw (409 `VERSION_CONFLICT`,
  also for a draft that a newer one replaced) and an `effective_from` that has come (422, finding `DATE_FUTURE`): a version never leaves a class without a rule.
- The version in force is superseded in the same step; versions are kept for good (the runtime role cannot delete them, a trigger keeps their content).
