# Alerts

One rule per file in `alerts/rules`; one runbook per rule here. `npm run alerts:check` (part of `npm run lint`) fails when a rule has no owner, points at a runbook that does not exist, repeats an id, names a metric or code that nothing in the code emits, is an operations alert routed through the notification module, or when one of the nine mandatory rules is missing.

**The operations channel is independent of the notification module.** An alert about the platform must still reach the on-call people when notifications are the thing that is broken, so `apps/api/src/alerts` has no import path to the notification code (architecture rule `operations-alerts-independent-of-notifications`).

- [OUTBOX_LAG](OUTBOX_LAG.md) · critical · platform-oncall
- [OUTBOX_EVENT_DEAD](OUTBOX_EVENT_DEAD.md) · critical · platform-oncall
- [OUTBOX_CONTEXT_TAMPERED](OUTBOX_CONTEXT_TAMPERED.md) · critical · security-oncall
- [AUDIT_CHAIN_BROKEN](AUDIT_CHAIN_BROKEN.md) · critical · security-oncall
- [JOB_FAILED](JOB_FAILED.md) · warning · platform-oncall
- [ACCESS_REVOCATION_LAG](ACCESS_REVOCATION_LAG.md) · critical · security-oncall
- [AUTHZ_DENY_SPIKE](AUTHZ_DENY_SPIKE.md) · warning · security-oncall
- [PROVISIONING_FAILED](PROVISIONING_FAILED.md) · critical · platform-oncall
- [LICENSE_EXPIRING](LICENSE_EXPIRING.md) · warning · platform-oncall
- [INTEGRATION_INBOX_DEAD](INTEGRATION_INBOX_DEAD.md) · warning · platform-oncall
- [RETENTION_REVIEW_BACKLOG](RETENTION_REVIEW_BACKLOG.md) · warning · platform-oncall
- [NOTIFICATION_DLQ_BACKLOG](NOTIFICATION_DLQ_BACKLOG.md) · warning · platform-oncall
- [NOTIFICATION_UNKNOWN_STALE](NOTIFICATION_UNKNOWN_STALE.md) · warning · platform-oncall
- [CHANNEL_CIRCUIT_OPEN](CHANNEL_CIRCUIT_OPEN.md) · warning · platform-oncall
- [CTR_ADVANCE_GUARANTEE_AT_RISK](CTR_ADVANCE_GUARANTEE_AT_RISK.md) · warning · contract-office (product channel)
- [SLO_FAST_BURN](SLO_FAST_BURN.md) · critical · platform-oncall
- [SLO_SLOW_BURN](SLO_SLOW_BURN.md) · warning · platform-oncall
- [SLO_BUDGET_EXHAUSTED](SLO_BUDGET_EXHAUSTED.md) · critical · platform-oncall
