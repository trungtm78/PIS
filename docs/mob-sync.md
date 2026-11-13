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
| `inspection.result` | `POST /inspections/{inspection_id}/result` | `If-Match` = `base_server_version` |
| `pwf.task.start` | `POST /project-tasks/{task_id}/start` | `If-Match` = `base_server_version` |
| `pwf.task.checklist.complete` | `POST /project-tasks/{task_id}/checklist/{item_code}/complete` (`item_code` in the payload) | `If-Match` = `base_server_version` |
| `pwf.task.complete` | `POST /project-tasks/{task_id}/complete` | `If-Match` = `base_server_version` |
| `pwf.task.evidence.attach` | `POST /project-tasks/{task_id}/evidence` | – |
| `pwf.task.exception.request` | `POST /project-tasks/{task_id}/exceptions` | – |

The `pwf.task.*` commands (PWF, MOB-79) carry the work of the person who does a task of a project workflow. Each of them is a version-checked change of the task except evidence and a request for an exception, which leave the version of the task as it is. A queue of several commands on one task is sent in order, and the phone bases each versioned one on the version it read plus the versioned commands queued before it (start, a checklist item and complete each add one), so a command whose predecessor was refused or whose task changed meanwhile comes back as a conflict and is never written over. An approval, a return and a signing are decisions of another person: they are not command types and are made online.

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

# Attachments uploaded in chunks (ST-MOB-009, MOB 5 BR-MOB-03, MOB-19)

A phone uploads a photo or a PDF (JPEG, PNG or PDF, 1 byte to 50 MiB) in chunks of 1 MiB, in any order and as often as it needs, so a cut network costs the chunks in flight and nothing more.

1. **Start** — `POST /sync/attachments` (`post_sync_attachments`, `sync.upload`): `device_id` (a live device of the member), `sha256`, `size_bytes`, `mime`. The answer holds `resource_id`, `chunk_bytes`, `chunk_count`, `expires_at` and `chunks`: for each chunk a link `/sync/attachments/{id}/chunks/{index}?tenant=&expires=&signature=` signed for that chunk, generation (`epoch`) and tenant, valid for 5 minutes at most. When the chunks are dropped (a checksum or type refusal) the generation goes up, so the old links stop working (409) and the cleanup of the old chunks cannot touch a new one; a chunk is kept and acknowledged with the upload row locked, the way the completion reads it. The attachment is `UPLOADING`; its storage key is `tenants/{tenant_id}/sync_attachment/{id}` (the database refuses another prefix).
2. **Send** — `PUT` the bytes of a chunk to its link (public, authenticated by the signature only, as the export links): a forged, altered, expired or foreign link (another tenant, another chunk) all answer 401 `SIGNATURE_INVALID`; a chunk has exactly its size (422 `VALIDATION_FAILED` `chunk`, 413 when longer); the same chunk twice is one; an upload that is over is 409 `ATTACHMENT_STATE_INVALID`.
3. **Resume** — `GET /sync/attachments/{id}` (`get_sync_attachments_id`, `sync.upload`, the member's own): `status`, `received` (the chunks the server holds) and fresh links for the chunks still missing, so the chunks that arrived are not sent again. Another member's upload is 404.
4. **Complete** — `POST /sync/attachments/{id}/complete` (`post_sync_attachments_id_complete`, `{sha256}`): fewer chunks than there should be is 409 `ATTACHMENT_CHUNKS_MISSING` (with the missing ones). The server puts the chunks together and compares the size and the SHA-256 with what was declared at the start and with what the phone says now (422 `CHECKSUM_MISMATCH`, and the chunks are dropped to be sent again), judges the file by its bytes against the type (422 `FILE_TYPE_NOT_ALLOWED`: a script renamed to .jpg), stores it, has it scanned, and the attachment is `CLEAN` or `INFECTED` (`reason` `FILE_INFECTED`; the user starts a new upload to try again). The path is UPLOADING → SCANNING → CLEAN | INFECTED, and the database keeps it (V1103). The chunks are removed after the commit. `sync.attachment_clean.v1` is written for a CLEAN file.

**Linking**: a record takes an attachment only when it is CLEAN — `SyncAttachmentStore.linkableKey` answers its storage key, else 409 `ATTACHMENT_NOT_CLEAN`; the file service refuses to serve an INFECTED object as well.

Audit rows: `sync.attachment_started|completed|refused` with the size, the type and the status — never the checksum, the key or a link.
