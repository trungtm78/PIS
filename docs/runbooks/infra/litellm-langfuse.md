# Runbook: LiteLLM and Langfuse

Story: ST-LLM-002. Declaration: `infra/components/litellm-langfuse.json`; alert rules `infra/alerts/litellm-langfuse.json`.

LiteLLM is the gateway to models; Langfuse records traces and cost. Only approved routes exist; a foreign model host
may receive PUBLIC data only, with an approved transfer assessment (`infra/policies/residency.json`).

## Entering use

The component stays `PLANNED` until `npm run infra:check -- --require-entered litellm-langfuse` passes: this runbook,
the alert rules and a restore test (restore the Langfuse database and show the route table loads from the repository).
See [README](README.md).

## Cost

Alert `llm-cost-spike`: daily spend is above 2 times the 7 day average.

1. Group the spend by tenant, route and feature in Langfuse.
2. A runaway loop shows as one feature with many calls; disable that route in the gateway, then fix the caller.
3. Report the spend to the tenant administrator if a tenant budget was exceeded.

## Routes

Alert `llm-route-errors`: the error rate of a route is above 5%.

1. Check the provider status and the credential reference after the last rotation.
2. Fail over to the next approved route only if the data class allows it; otherwise the feature degrades to its non-AI path.

## Keys

Story ST-LLM-002 (`docs/llm-keys.md`). The virtual keys are made at LiteLLM through its admin API on the internal network and their secrets are written to the vault under `secret://tenants/{tenant}/litellm/{key}`; the application keeps the fingerprint only.

- **A key leaked** (it appears in a ticket, a log or a trace): revoke it in LLM-06 (it stops at LiteLLM at once), then create or rotate the key that replaces it; search the logs and traces of the day for its fingerprint, not for its secret.
- **A key at LiteLLM that the application does not know**: list the keys of the gateway by alias and compare with LLM-06; an alias that LLM-06 does not show was made by a command whose commit failed at the very end. Stop it at LiteLLM.
- **The sweep** (`llm-key-sweep`, every 5 minutes) revokes the old key of a rotation at the end of its last day and records keys past their expiry. A key it cannot stop at LiteLLM is retried at the next pass; if the same key fails for an hour, check the admin API and its credential reference.
- **Restore** of the Langfuse database does not restore any secret: the secrets are in the vault, and a restored host needs its reference to the vault, not a copy of the keys.

## Traces: personal data is masked before Langfuse (ST-KERNEL-046, AC-2)

A trace holds the text of the request and of the answer, so it can hold a national id, an email address or a phone number. Nothing may reach Langfuse except through `SanitisingTraceExporter` (`packages/kernel/src/llm-trace.ts`), which masks the text of every field, at every depth and under every name, before the store sees it: a national id of 12 digits (or the old 9 digits) becomes `[NATIONAL_ID]`, an email `[EMAIL]`, a Vietnamese phone number `[PHONE]`, and the value under a name that holds a credential (`authorization`, `api_key`, `password`, a token of a session) becomes `[REDACTED]`. A trace that cannot be copied is not exported at all.

1. Compose the exporter as `new SanitisingTraceExporter(new LangfuseTraceExporter({ baseUrl, publicKey, secretKey }))`; the keys come from the secret store. `LangfuseTraceExporter` sends one `trace-create` event to `/api/public/ingestion` and reports a refusal by its status only.
2. Check: `piiMatches(text)` lists what the patterns find in a text; it must return nothing for the stored traces. A 9-digit number in a trace is masked too, even when it is an amount: the safe side for a trace.
3. A pattern that is missing (a new kind of identifier) is added to `DETECTORS` with a test in `packages/kernel/test/llm-trace.test.ts`; traces that were already stored are not rewritten by this.
4. The exporter is the application's half. LiteLLM's own Langfuse callback (the proxy sends traces too) must be configured to go through the same masking or to send no text; that is a setting of the deployment (TK-KERNEL-046-1) and is not checked by the repository.
