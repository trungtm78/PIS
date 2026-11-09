# LOG_CAPACITY_NEAR

**Owner:** tenant-administration · **Severity:** warning · **Rule:** `alerts/rules/LOG_CAPACITY_NEAR.json`

## What it means

The nightly pass of the job `retention-purge` (`docs/runbooks/retention.md`) measures every log class of every tenant and compares it with the cap the tenant set in ADM-30 (rows, bytes, and the share `warn_pct`, default 80). The gauge `log_capacity_near` is 1 for a class at or above that share, by `record_class` and `tenant_id`. The size of a class above 50,000 rows is estimated from a sample and ADM-30 says so.

## What to do

1. Open ADM-30: the class is marked, with its rows, its size, how many rows a cap may remove (older than the retention rule) and when it was measured.
2. A technical class (`outbox_event`, `delivery_attempt`, `user_session`, `idempotency_record`, `integration_event_inbox`) is archived into a hashed file and then purged down to 90 percent of the cap the next night, if it holds rows older than its retention rule. Nothing to do unless the growth is unexpected: find what writes so many rows.
3. The audit trail (`audit_event`, `audit_event_detail`) is never purged by a job. Raise the cap with a reason, or plan the archive transfer decided by the council of the Law on Archives (ADM-12).
