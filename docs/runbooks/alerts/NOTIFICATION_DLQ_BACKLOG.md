# NOTIFICATION_DLQ_BACKLOG

**Owner:** platform-oncall · **Severity:** warning · **Rule:** `alerts/rules/NOTIFICATION_DLQ_BACKLOG.json`

## What it means

More than 50 notifications of one tenant ended `Failed` or `Unknown` and are waiting in the failed queue (NOT-13). The gauge `notification_dlq_gauge{tenant_id}` is set by every pass of the `notification-dispatch` job. A message that was delivered in the application never counts: only notifications that no channel could deliver do.

## What to do

1. Open NOT-13 for the tenant (permission `delivery_attempt.read`) and read the error codes of the last sends. One code repeated many times is one cause: a provider down, a sender account that expired, a template that does not render (`TEMPLATE_RENDER_FAILED`), a recipient without an address (`NO_ADDRESS`).
2. Check the channel account of that channel and the circuit breaker (`CHANNEL_CIRCUIT_OPEN` if it fired).
3. When the cause is fixed, replay the notifications from NOT-13 (`post_notifications_id_replay`, permission `notification.replay`, a reason of 10 to 2000 characters). A replay checks the recipient, the expiry and the reconciliation again; a notification that has expired cannot be replayed.
4. Do not replay a send of unknown result before its reconciliation period is over (409 `RECONCILE_REQUIRED`): see `NOTIFICATION_UNKNOWN_STALE`.

The alert resolves when the gauge drops to 50 or fewer.
