# Commands queued offline (ST-MOB-005, MOB 4, 6, 7, MOB-41)

A phone keeps working without a network: what the person does is queued as commands, each with a key the phone made (a local UUID, 16 to 128 characters). When the network is back the phone sends them in a batch. The server side of that is here; the app, the encrypted local store and the queue states on the phone (QUEUED, SENDING, UNKNOWN, ...) are not in this repository (TODOS.md).

## `POST /sync/batches` (`post_sync_batches`, `sync.submit`, 200)

The body is `device_id` and 1 to 50 `items` (`idempotency_key`, `command_type`, `base_server_version`, `payload`). The batch has an `Idempotency-Key` of its own (7 days, as offline commands): the same batch key with another body is 409 `IDEMPOTENCY_CONFLICT`, and the same body gets the same answer back.

- **The device** must be a live registration of the member who sends (`device_registration`, ST-NOT-006): another member's device, a removed one and one that does not exist are 403 `SCOPE_DENIED`.
- **Each command is carried out by the operation it stands for, as the person who sent the batch.** The server calls its own public API (`http://127.0.0.1:{its own port}`, never the Host header) with the credentials of the batch and the key of the command as the `Idempotency-Key`, so the permission, scope, license, period, version and idempotency rules of that operation decide it exactly as online, and its audit rows and events are its own. Nothing is trusted for having been queued.

| `command_type` | Operation | Version |
|---|---|---|
| `report.submit` | `POST /reports/{report_id}/submit` | `If-Match` = `base_server_version` |
| `report.draft.save` | `POST /reports/{report_id}/revisions` | `If-Match` = `base_server_version` |
| `issue.create` | `POST /issues` | – |
| `site_diary.append` | `POST /site-diaries` (a new draft), or `POST /site-diaries/{diary_id}/draft` when the payload names `diary_id` | the second one, `If-Match` |
| `measurement.record` | `POST /contracts/{contract_id}/measurements` | – |

The ids that go into the path must be UUIDs (anything else is `VALIDATION_FAILED`, never forwarded).

- **Each command is answered on its own** (`results[]`): `accepted` (with `server_version`), `conflict` (a `VERSION_CONFLICT`/`DRAFT_VERSION_CONFLICT`, with the `server_version` the server holds; the person decides, never last write wins) or `rejected` with the code of the platform (`PERIOD_LOCKED`, `LICENSE_EXPIRED`, `SCOPE_DENIED`, `VALIDATION_FAILED`...). One refusal does not fail the batch.
- **A receipt is written for every settled command** (`sync_command_receipt`, V1100, written once and never changed, 7 days): the key, the type, the status, the code, the version, the id of the result and a hash of the command (type, version, payload) — never the payload. The key is also bound to its command (by hash) in a claim written in a transaction of its own before the command is forwarded (V1102, kept 7 days): if the answer is lost, no later batch can use the key for another command. A key sent again with the same command is answered **from the receipt**, without the command being carried out again; the same key with another command is `rejected` `IDEMPOTENCY_CONFLICT` and the first one stands.
- **The keys are claimed before anything is carried out.** The batch takes a transaction lock on each (device, key), in one sorted order for every batch, so a command with the same key in another batch at the same moment waits until this one has committed its receipts and then finds them: one key is one command, never two effects, and the same command sent twice at once gets the same answer twice.
- **What may go away is not remembered.** A 5xx, a rate limit, a lapsed session (401), a command still being carried out by another request (409 `IDEMPOTENCY_IN_PROGRESS`) or no answer comes back as `rejected` with the code (`INTERNAL_ERROR`, `RATE_LIMITED`, `SESSION_EXPIRED`, `UNAVAILABLE`) and **no receipt**: the phone sends the command again, and the operation, being idempotent on the same key, carries it out once. The lookup says `not_received` for it.
- The batch writes the audit row `sync.batch_submitted` with counts only, and `sync.command_accepted.v1` / `sync.command_rejected.v1` once for each command settled (not for a conflict, not on a repeat).

## How many batches run at once

A batch runs in one tenant transaction (one pooled connection) and each of its commands is a request that needs a connection of the same pool, so the batches are bounded: `SYNC_MAX_CONCURRENT_BATCHES` (default 3, for the pool of 10; keep it under half the pool). The others wait for a slot (up to 30 s) and are then refused with 503 `PROVIDER_UNAVAILABLE`; the slot is given back when the response is over, however it ended.

## `GET /sync/commands/{idempotencyKey}` (`get_sync_commands_key`, `sync.submit`)

For a command whose answer the phone lost (UNKNOWN on the phone): `accepted` with `result_ref`, `rejected` or `conflict` with `code`, or `not_received`. It reads the receipts of the member who asks, on any of their devices; another member's key, or another tenant's, is `not_received`.

## Permissions

`sync.submit` and `sync.upload` are held by the role MEMBER (V1101 brings the tenants seeded before this up to date). They open the door only; each queued command needs the permission of its own operation.

## Not here

The Flutter app, the encrypted store, the queue states, retry and backoff, MOB-41 and MOB-43; the PowerSync rules (ST-MOB-007); the attachments (ST-MOB-009); a `server_copy` in a conflict answer (the app reads the record through the read operation of its module).
