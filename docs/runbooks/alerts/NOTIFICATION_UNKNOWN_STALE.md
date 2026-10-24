# NOTIFICATION_UNKNOWN_STALE

**Owner:** platform-oncall · **Severity:** warning · **Rule:** `alerts/rules/NOTIFICATION_UNKNOWN_STALE.json`

## What it means

A send has been `Unknown` for more than an hour (`notification_unknown_oldest_seconds`). Unknown means the request may have reached the provider but its answer was lost (a timeout after the request left, a process that died while the provider was being called). The engine never sends it again on its own, because on a paid channel (SMS, Zalo ZNS, WhatsApp) that would be a second message at a second cost.

## What to do

1. The `notification-reconcile` job asks the provider about each Unknown send every 5 minutes for 24 hours, by the idempotency key `{notification_id}:{channel}:{attempt_no}`. If the provider answers, the send moves on by itself and the reconciliation task closes. If it says it never saw the request, the send becomes a failed one and the schedule repeats it.
2. When the adapter cannot tell (the provider keeps no idempotency keys, or is down), check the provider's own log or console for the message. Nothing in the platform records the message text or the address.
3. After 24 hours without an answer the notification can be replayed from NOT-13. The screen says that the message may then be sent twice. Decide by the cost of a second message against the cost of none, and write the reason.
4. Reconciliation tasks are listed by `ProviderCallbackStore.openTasks`; a person closes one with the status found at the provider (`resolveTask`).
