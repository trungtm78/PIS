# Cross-total control of the disbursed money (G4-5, DIS F6a, DIS-26)

The disbursed money of a period snapshot is added up three ways: by unit, by fund and by project. The three totals must be **one number to the dong**, or the indicator is not published: the freeze of the snapshot is refused and the screen says which dimension disagrees.

## What is where

| Piece | File |
| --- | --- |
| The judgement (equal, the dimension that stands alone, the keys that differ) | `packages/kernel/src/gov-d-recon.ts` (`crossTotal`, `keyGaps`, `sumKeys`) |
| The three totals, the check that is written, the history | `packages/db/src/dis-cross-total-store.ts` (`DisCrossTotalStore`) |
| The gate at the freeze | `apps/api/src/modules/dis/period-snapshot.controller.ts` (`freeze`) |
| Read and write the control | `apps/api/src/modules/dis/cross-total.controller.ts` |
| Table | `V1843__gov7_cross_total_check.sql` (append-only) |
| Screen DIS-26 | `apps/web/src/screens/dis/crosstotal/` |
| Tests | `apps/api/test/gov/cross-total.test.ts`, kernel `gov-d-recon.test.ts`, web `crosstotal/CrossTotalScreen.test.tsx` |

## The three totals

All three are the Treasury figure of the snapshot: from the first day of its fiscal year to its Treasury cutoff, by the day in Vietnam time, a refund taking off (as `buildLines` counts it).

| Dimension | Source | Formula |
| --- | --- | --- |
| `UNIT` | the lines of the snapshot as they were built | sum of `period_snapshot_line.disbursed_treasury_vnd` by `unit_id` |
| `PROJECT` | the ledger now | sum of `treasury_transaction` by project |
| `FUND` | the ledger now | sum of `treasury_transaction` by the fund of its allocation line (the transaction's own, else the payment it is matched to); no fund is the key `UNMATCHED` |

Money that no fund can be found for stays in the fund total under `UNMATCHED` and is shown apart (`unattributed_fund_vnd`); it is already owned by the per-transaction reconciliation items of PAY. A snapshot built before a late transaction or a refund therefore disagrees with the ledger on `UNIT` and must be built again; a ledger that loses a key on the way to a fund would disagree on `FUND`.

## Which dimension disagrees

`crossTotal` groups the three totals: all equal is published. When two are equal they are the reference and the third is named, with its total less the reference (signed). When no two are equal all three are named and there is no reference. Nothing is rounded.

## The gate

`freezePeriodSnapshot` judges the control **after** the version and the state of the snapshot (a stale version is 409 `VERSION_CONFLICT`, a frozen snapshot 409 `SNAPSHOT_FROZEN`, and neither writes a check). For a snapshot that can be frozen it writes a `cross_total_check` (origin `FREEZE_GATE`) and, if the totals agree, freezes it and names the check in the audit row (`cross_total_check_id`). If they do not, the command **commits the check, its audit row (`dis.cross_total_checked`) and its event (`dis.cross_total.checked.v1`, with `alert_type` CROSS_TOTAL_MISMATCH)**, leaves the snapshot BUILDING at the same version and answers 422 `CROSS_TOTAL_MISMATCH` with `disagreeing`, `agreeing`, `totals`, `offset_vnd`, `unattributed_fund_vnd` and `cross_total_check_id` (`refuseAfterCommit`: the refusal is itself a record, and the same idempotency key gets the same refusal).

## Reads and writes

* `getCrossTotalControl` (`disbursement.control.read`): the control now (nothing is written), the latest recorded check and the last ten, the formula, the 20 largest keys of each dimension and the 20 projects on which the snapshot and the ledger differ most.
* `evaluateCrossTotal` (`disbursement.control.evaluate`): writes one check (origin `MANUAL`).
* Both need a permission that covers the whole tenant (a snapshot holds the whole tenant): 403 `SCOPE_DENIED` otherwise.

## Alert type CROSS_TOTAL_MISMATCH

Owner: the DIS data steward. Expected action: fix the dimension that disagrees (build the snapshot again, match the unmatched money) and check again. Consequence: the indicator is not published and the snapshot cannot be frozen. Severity ACTION. The alert is seeded in the registry, carried by the event and read by the alert centre as the source `CROSS_TOTAL` (`packages/db/src/home-integrity-sources.ts`, kind `CROSS_TOTAL_MISMATCH`, ACTION, opens DIS-26): one item for each snapshot that is still BUILDING and whose latest check is not published, for a reader who holds `disbursement.control.read` on the whole tenant (or was handed the item); it closes when a later check agrees or the snapshot is frozen.

## Decision recorded

A transaction with no fund does not make the fund dimension disagree: it stays in the total as `UNMATCHED` and is shown. Making it disagree would block every freeze of a tenant that has one unmatched Treasury transaction, and unmatched money is already an owned item in PAY. The control therefore catches what a stale or inconsistent figure does to the total, and names the unmatched amount for the data steward. Tighten it (refuse when `unattributed_fund_vnd` is not zero) with a rule parameter when the customer asks.
