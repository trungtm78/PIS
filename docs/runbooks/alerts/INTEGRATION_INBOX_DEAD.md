# INTEGRATION_INBOX_DEAD

**Owner:** platform-oncall · **Severity:** warning · **Rule:** `alerts/rules/INTEGRATION_INBOX_DEAD.json`

## What it means

An inbound event of a provider failed ten times (waits of 1, 5 and then 30 minutes) and is parked as DEAD. Nothing was applied from it. The alert names the tenant, the provider and the event id, never the payload.

## What to do

1. Open the sync monitor of the tenant (ADM-10), find the event by the id in the alert and read its error code.
2. Fix the cause: the adapter of the provider, its endpoint or a change in the provider's format.
3. Replay the event (`replayInboxEvent`, permission `adm.integration.operate`, with a reason): it starts over with a clean count of attempts and its adapter processes it at once. An event whose payload has been purged cannot be replayed; ask the provider to send it again.
4. Never edit the payload; it is not shown and not editable.
