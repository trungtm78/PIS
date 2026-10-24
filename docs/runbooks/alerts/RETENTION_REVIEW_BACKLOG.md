# RETENTION_REVIEW_BACKLOG

**Owner:** platform-oncall · **Severity:** warning · **Rule:** `alerts/rules/RETENTION_REVIEW_BACKLOG.json`

## What it means

The nightly retention run puts a business record whose period has run out on the review list instead of deleting it (`docs/runbooks/retention.md`). The gauge `retention_review_pending_gauge` is the number of items waiting in all tenants; it grows when nobody decides.

## What to do

1. Tell the records officer of the tenants with the most items (ADM-12 lists them); the decision belongs to the council of the Law on Archives, not to operations.
2. Check that the run is not listing a class by mistake: a policy with too short a period lists everything older than it. The policy is a version drafted by one person and published by another; correct it with a new version.
3. Do not delete the items in the database: the runtime role cannot, and a record that was due for review is evidence.
