# Runbook: integration connectors and the inbox of inbound events

Story: ST-ADM-018 (ADM-09, ADM-10, ADM 3.13, BR-ADM-10). Code: `packages/kernel/src/connector.ts` (the rules),
`packages/db/src/integration-connector-store.ts`, `integration-inbox-store.ts`, `integration-inbox-processor.ts`,
`apps/api/src/modules/adm/integration-connector.controller.ts` and `integration-inbox.controller.ts`, migration `V1304__adm1_integration_connectors.sql`.

## Honest adapter status

The verdict on the adapter of a connector is one of four words, the same four as the integration cursors of master data (`integration_cursor`,
ST-MDM-007) and DOC (`adapter_status`): `VERIFIED` (the agency has confirmed the format), `PROPOSED` (a format waiting for a contract), `MOCK`
(a test adapter), `MISSING` (none). It is a fact about the agency, not a setting: `updateIntegrationConnector` cannot change it.

| Adapter | May be Active |
|---|---|
| `VERIFIED` | yes, if the cursor that the platform recorded for the same connector (the code in lower case) says VERIFIED too |
| `MOCK` | outside production only (`MACHVON_ENVIRONMENT` other than `production` and `dr`; unset or unknown means production) |
| `PROPOSED`, `MISSING` | never: 422 `CONNECTOR_NOT_ACTIVATABLE` (the detail says `ADAPTER_NOT_VERIFIED` or `MOCK_IN_PRODUCTION`); also a database CHECK |

A connector declared `VERIFIED` is refused (422 `VALIDATION_FAILED`, field `adapter_status`) while the platform records the cursor of that connector as
anything else. The Treasury, the national project system and the procurement site have no public API: they are declared `FILE_IMPORT` or
`FILE_EXPORT` with `PROPOSED` until a contract exists.

## Secrets

The configuration of a connector is a JSON object of at most 16 KB with no member whose name says it holds a secret (`password`, `token`, `api_key`,
`secret`, `credential`, `authorization`, `private_key`), at any depth. A credential is `credential_secret_ref`, a reference to the vault
(`secret://<environment>/<path>`). The audit trail keeps the names of the configuration members and whether a credential is referenced, never values.

## Moves

`Draft` to `Active` or `Disabled`; `Active` to `Disabled`; `Disabled` to `Active` (the gate is checked again) or back to `Draft`. A connector keeps its
code and its mode for good (another code or mode is another connector) and is never deleted. Every change carries a reason (10 to 2000 characters) in the audit row.

## The inbox

`integration_event_inbox` is shared by every inbound channel (provider callbacks of KERNEL-1, notification and omnichannel webhooks). The monitor lists an
event without its payload or the reference to it. A module that owns a provider registers its adapter in `InboxHandlerRegistry` (token `ADM_INBOX_HANDLERS`);
a provider with no adapter has its events wait as `RECEIVED` and are never failed.

The `integration-inbox` job (every minute) takes the due events (`RECEIVED`, or `FAILED` whose wait is over) of the providers that have an adapter, oldest
first, a row at a time with `for update skip locked`. The adapter and the mark `PROCESSED` share a transaction. A failing adapter costs an attempt: the wait is
1 minute, 5 minutes, then 30 minutes; the tenth failure parks the event as `DEAD` and raises `INTEGRATION_INBOX_DEAD`. Only an error code is recorded, never a message.

`replayInboxEvent` (permission `adm.integration.operate`, `If-Match`, answer 202) takes a `FAILED` or `DEAD` event up again: `RECEIVED`, no attempts, due now,
and its adapter processes it right after the command commits. Any other state, and an event whose payload was purged by the retention job, is 409
`INBOX_STATE_INVALID` whatever the version sent (so a second replay is told the state); a stale version is 409 `VERSION_CONFLICT`. The version of an event moves on every change by any writer (trigger).

Gauge `integration_inbox_waiting_gauge{tenant_id}`; counters `integration_inbox_processed_total` and `integration_inbox_failed_total` by tenant and provider.
