# AUD_RECOVERY_RECONCILE_MISMATCH

**Owner:** audit-follow-up · **Severity:** critical · **Rule:** `alerts/rules/AUD_RECOVERY_RECONCILE_MISMATCH.json`

## What it means

The job `aud-recovery-reconcile` (every night at 02:00 Vietnam time, `docs/runbooks/jobs.md`) compares, for every financial recommendation, `audit_recommendation.recovered_vnd` with the sum of the lines of its ledger (`audit_recovery_link`, a reversal counting as a negative line). The table moves the first with every line in the same transaction (`audit_recovery_link_apply`), so the two are equal by construction: a difference means that something changed `recovered_vnd` without a line, or wrote around the trigger. The gauge `aud_recovery_reconcile_mismatch_total` (labelled with the tenant) is the number of recommendations that differ; the alert fires when it is above zero and stays so until the figures agree. The job **never changes a recommendation or a line**: it reports.

For every recommendation that differs, the job writes the audit row `aud.recovery_mismatch_detected` and the event `aud.recovery.reconcile_mismatch.v1` (once a day for each), with the recommendation, its engagement and both figures.

## What to do

1. Read the audit row or the event: `recovered_vnd` of the recommendation, `ledger_vnd` of its lines and `difference_vnd` (the first less the second).
2. Read the lines: `select source_kind, source_id, amount_vnd, recorded_on, reversal_of_id, recorded_at from audit_recovery_link where recommendation_id = '<id>' order by recorded_at`. The ledger is the record: it only grows, and each line has its source (an event of PAY, a voucher of the Treasury, a document).
3. Find who changed `recovered_vnd`: the audit trail of the recommendation (`audit_event`) and the deployments of the night before. A restore from a backup of one table, a script, or a migration that touched the column are the usual causes.
4. Put the figure right with the person who owns the fact: a missing recovery is linked through `linkAuditRecovery` (with its voucher) or arrives again from PAY (the consumer is idempotent); a figure that has no line behind it is corrected by a database change approved by the data owner, written down in the incident, never by deleting a line (the table refuses it).
5. The next night's run sets the gauge back to zero once the figures agree. A recommendation that was closed on a wrong figure is reopened by the same reasoning as a reversal: it goes back to IN_PROGRESS through the command that owns the change, not by editing the status.
