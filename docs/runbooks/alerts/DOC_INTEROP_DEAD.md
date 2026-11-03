# DOC_INTEROP_DEAD

**Owner:** integration-admin (the integration administrators of the agency) · **Severity:** critical · **Rule:** `alerts/rules/DOC_INTEROP_DEAD.json`

## What it means

The job `doc-interop-send` (every minute, `docs/runbooks/jobs.md`) sends the documents of the distributions on the LGSP channel to the gateway of the tenant. A message that cannot be sent waits 1, 2, 4 minutes and so on up to six hours between attempts; the twentieth failure ends it as `DEAD` (about three days after the first attempt) and its distribution is `FAILED` with the reason. The gauge `doc_interop_dead_gauge` is the number of dead messages of a tenant; it fires while any tenant has one. The recipient has **not** received the document. The alert names the tenant, never the document.

## What to do

1. Open DOC-20 (Interoperability through the LGSP), filter the status `DEAD` and read the error code of the message:
   - `INTEROP_ADAPTER_NOT_ACTIVE`: the tenant has no LGSP connector in `Active` status. Open ADM-09: a connector is `Active` only with a `VERIFIED` adapter, or a `MOCK` one outside production. While the adapter of the pilot tenant is `PROPOSED` (the LGSP specification, CXN-06, is open) nothing can be sent.
   - `EGRESS_NOT_ALLOWED`: the `endpoint` of the connector is not https or its host is not in `egress_allowlist`. Correct the connector; never widen the allowlist to a host you do not own.
   - `PROVIDER_UNAVAILABLE`, `CHANNEL_ERROR` and the codes of the gateway: the gateway is down or refused. Check it with the LGSP operator.
   - `ENVELOPE_INVALID`: the envelope changed in the store after it was queued. Escalate to the security team; do not send it again.
2. Mend the cause, then send the message again from DOC-20 (`retryInteropMessage`, permission `doc.interop.manage`, the version you saw). A dead message starts over with twenty attempts; the history of the earlier attempts is in the audit trail.
3. A message the receiving agency refused is `REJECTED`, not `DEAD`: it is not sent again. Send the document on another channel (a new distribution to the same recipient on paper or e-mail).
4. When the last dead message is sent again or the reason is settled, the gauge returns to zero on the next pass and the alert resolves.
