# Runbook: the sealed export of the audit trail

Story: ST-ADM-016 (ADM-11). Code: `apps/api/src/modules/adm/audit-export.controller.ts` (the command),
`packages/db/src/audit-export-store.ts` (reads and builds the file), `packages/db/src/audit-export-format.ts` (the format and the
check a recipient runs), `packages/db/src/audit-seal-job.ts` (the seals and the kept verdict).

## What the command does

`POST /audit-exports` (`exportAuditLog`, permission `audit.export`, answer 202 `READY` with `resource_id` = the id of the export):

- needs a grant of `audit.export` on the **whole tenant**. The seal windows are tenant wide, and a file that proves a window complete
  carries the hash of every row of it, so a grant on a subtree is refused with 403 `SCOPE_DENIED` (audited as `command.denied:exportAuditLog`).
- takes a period `[from, to)` of at most **366 days** (422 `EXPORT_RANGE_TOO_LARGE` beyond; 422 `VALIDATION_FAILED` for an empty or
  reversed period), a format (`CSV` or `JSONL`) and optional `resource_types`.
- builds the file in the command, stores it with the shared file pipeline (purpose `audit_export`, key
  `tenants/{tenant}/audit_export/{id}`, scanned, served only when CLEAN) and writes the audit row `audit.exported` (CONFIDENTIAL) with the
  counts and the SHA-256 of the file. The file may not exceed 64 MiB (422 `EXPORT_RANGE_TOO_LARGE`): ask for a shorter period.
- is idempotent on `Idempotency-Key`: a retry returns the first export and writes no second file.
- cannot be downloaded through the API yet: no operation of the contract serves the file (see TODOS.md, ST-ADM-016 contract gaps).

## The file

One record per line (JSON lines) or per row (CSV, header first). Records, in this order:

| `record_type` | Meaning |
|---|---|
| `MANIFEST` | tenant, period, `generated_at`, the first and last `seq`, and the counts `events`, `leaf_only`, `seals`, `unsealed_events` |
| `SEAL` | a seal that touches the period: `id`, `from_seq`, `to_seq`, `merkle_root`, `prev_seal_hash`, `seal_hash`, `sealed_at` |
| `EVENT` / `LEAF` | every row of those seal windows in `seq` order. An `EVENT` is a row of the period (all columns of the audit row, `leaf_hash`, `seal_id`, `redacted`); a `LEAF` is a row of a window that is not in the period or in the type filter, reduced to `seq` and `leaf_hash` |

Rows of the period that no seal covers yet are `EVENT`s with `seal_id` empty; `unsealed_events` counts them. They prove nothing until the
next run of the sealer.

An `EVENT` carries `ip_hash` and `schema_version` because they are part of what is sealed (the keyed hash of a network address, never the
address). A `safe_diff` that still held a sensitive value is redacted on the way out and the row has `redacted: true`: its leaf cannot be
recomputed from the file, but the window still verifies because the leaf hash is that of the stored row.

CSV is for reading: a cell that begins with `=`, `+`, `-`, `@`, a tab or a carriage return is written with a leading apostrophe so a
spreadsheet does not run it, and the types of the cells are lost. Verification of the rows against their leaves needs the JSON lines form.

## What the recipient checks (no database, no trust in the sender)

`verifyAuditExport(text, format)` of `@machvon/db` is the reference implementation, and the specification is this:

1. The leaf of a row is `sha256(0x00 || canonical_json(row))`, where `row` has exactly the 17 columns `LEAF_FIELDS` (`id`, `seq` as a number,
   `actor_id`, `action`, `resource_type`, `resource_id`, `safe_diff`, `reason`, `correlation_id`, `request_id`, `outcome`, `classification`,
   `impersonator_id`, `on_behalf_of_id`, `ip_hash`, `schema_version`, `occurred_at` with microseconds) and canonical JSON sorts keys at every depth
   and has no whitespace. Each non-redacted `EVENT` (JSON lines) must hash to its `leaf_hash` (`EVENT_LEAF_MISMATCH`).
2. For each `SEAL`, the leaves of all rows with `from_seq <= seq <= to_seq` (EVENT and LEAF alike), in `seq` order, give the root with
   `node = sha256(0x01 || left || right)` and an odd last node promoted unchanged; it must equal `merkle_root` (`ROOT_MISMATCH`). A row missing from
   the window changes the root, so the check proves the window complete.
3. `seal_hash = sha256(prev_seal_hash || merkle_root || to_seq)` as text, with an empty `prev_seal_hash` for the first seal (`SEAL_HASH_MISMATCH`).
4. Consecutive seals chain: `prev_seal_hash` of a seal is the `seal_hash` of the one before (`CHAIN_LINK_MISMATCH`), and they do not overlap (`SEAL_ORDER`).
   The `prev_seal_hash` of the first seal of the file points outside it: compare it with an anchor you hold, if you have one.
5. The counts of the manifest match the file (`COUNT_MISMATCH`), and a manifest exists (`MANIFEST_MISSING`).

## The verdict in the viewer

The hourly `audit-verify` job keeps its verdict per tenant in `audit_seal_check` (V1302). ADM-11 shows it above the trail:
`BROKEN` (alert, with the failing window and reason; follow `docs/runbooks/audit-tamper-drill.md`), `STALE` (no run for three hours: the verifier
has stopped, see `docs/runbooks/jobs.md`), `UNKNOWN` (never verified) or `OK`. A broken verdict stays until a later run finds the chain whole.
