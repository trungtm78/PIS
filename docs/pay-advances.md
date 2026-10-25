# The advance of a contract (ST-PAY-004)

PAY 3.2, BR-PAY-04, BR-PAY-10, BR-PAY-11. Screens PAY-07 (advances and recovery) and CTR-06 (their schedule). The request form (PAY-11) and the overdue board (PAY-12) belong to ST-PAY-011.

## The life of an advance

```
requestAdvance          PLANNED ──cancelAdvance──▶ CANCELLED
   │                       │  ▲
   │   an ADVANCE payment  ▼  │ the request is returned
   │   request is sent   REQUESTED ──cancelAdvance (no request open)──▶ CANCELLED
   │                       │
   │   the Treasury pays   ▼   (ST-PAY-005, ST-PAY-006)
   │                     PAID ◀──────────────┐
   │                       │ a payment recovers it, or recordAdvanceRecovery
   ▼                       ▼                 │ a payment is returned
 (no entry)           RECOVERING ────────────┘
                           │ recovered = paid
                           ▼
                     FULLY_RECOVERED
```

`requestAdvance` moves no money and writes nothing to the journal (`advance_ledger_entry`); an advance moves money when the Treasury pays it and when it is recovered.

## Asking for an advance (`PayAdvanceStore.request`)

The contract is locked first (the order of the locks of the product), so two requests for one member are decided one after the other and the second sees the first under the cap. The conditions, in the order they are met:

1. The contract is `ACTIVE` and `effective_from` is not after today (Vietnam time): 422 `ADVANCE_CONTRACT_NOT_EFFECTIVE`.
2. The member is an active party of the contract: 422 `VALIDATION_FAILED` (`party_id`, reason `NOT_A_MEMBER`).
3. A **contract** advance (`kind = CONTRACT`) is covered by a guarantee of the kind ADVANCE that is `ACTIVE`, `VERIFIED`, not expired, at least as large as the advance and the member's or the whole contract's. The one named is judged as it is; when none is named the smallest that covers is taken. 422 `ADVANCE_GUARANTEE_REQUIRED` carries the reason (`NO_GUARANTEE`, `NOT_FOUND`, `NOT_VERIFIED`, `NOT_ACTIVE`, `EXPIRED`, `TOO_SMALL`, `OTHER_MEMBER`). A land clearance advance (`GPMB`) needs none.
4. **The cap** (BR-PAY-10): the rule `PAY_ADVANCE_CAP` of the category of the contract in force today gives the tier the contract's value reaches (`cap_pct`); `cap = floor(cap_pct × work value of the member / 100) − what is already advanced to the member` (planned, asked for, paid, recovering or recovered; a cancelled one gives its place back). The amount may be equal to the cap, not a dong more: 422 `ADVANCE_CAP_EXCEEDED` with `cap_vnd`, `cap_pct`, `cap_rule_version_id`, `rule_awaiting_confirmation` and `cxn`. No rule for the category, or none for the value: 422 `ADVANCE_RULE_UNCONFIRMED` (the platform never guesses a cap).
5. A member whose earlier advance is overdue is not advanced again (422 `ADVANCE_OUTSTANDING_PRIOR`): a land clearance advance past its deadline, or a contract advance whose member has already asked to be paid up to the threshold and still owes it.
6. The cash that leaves the contract (advances unrecovered, planned or asked for, plus the payments) stays within the value of the contract: 409 `VALUE_EXCEEDED` (`contract_cash_out_chk`).
7. The line of capital is the project's, in force and open for payment: 422 `ALLOCATION_UNAVAILABLE`.

The advance keeps the cap that was worked out (`cap_vnd`), the version of the rule that gave it (`cap_rule_version_id`), the threshold of the recovery (`recovery_threshold_pct`, from the rule) and the guarantee that covers it. No API takes any of these from the client.

## The rules (`master_record`, MDM)

| Type (key) | Attributes | Fixture of the platform |
|---|---|---|
| `PAY_ADVANCE_CAP` (`CONSTRUCTION`, `CONSULTING`, `EQUIPMENT`, `EPC`, `LAND_CLEARANCE`, `OTHER`) | `tiers`: list of `{min_value_vnd, cap_pct}` (once each; the tier with the highest minimum the value reaches decides), `recovery_threshold_pct` (the share of the work after which the advance is recovered in full) | `CONSTRUCTION`: from 10bn, 20 percent; `CONSULTING`: from 0, 30 percent; threshold 80. The other categories have no row until the owner publishes one |
| `PAY_ADVANCE_GPMB` (`GPMB`) | `recovery_days` (1..366) | 30 |

Both are flagged `awaiting_confirmation` (CXN-02 and CXN-12): they are working figures labelled "fixture – not a regulation" until the legal owner signs them, and every answer and screen that rests on them says so (`RULE_AWAITING_CONFIRMATION`, the banner of CTR-06).

## Recovery

* **By payments** (BR-PAY-04): in the sending of a request (ST-PAY-003), per tranche, from the work value and the gross asked for by that member only. Another member of the joint venture never changes it (UAT-AC327: M1 recovers 450m, then 450m and is recovered in full at 4.8bn; M2 recovers 187.5m of 600m).
* **Outside the payments** (`recordAdvanceRecovery`): a compensation paid to the one who owes the advance, a refund, anything else — with its basis, optionally the document or payment it comes from, and **evidence** (a file version scanned clean). Up to what is still owed: 422 `ADVANCE_RECOVERY_EXCEEDED` with `outstanding_vnd` and `exceeds_by_vnd`; the CHECK `recovered <= paid` says the same behind the application (UAT-AC61). The advance, the totals of the contract and the journal move together; the entry keeps `outstanding_after_vnd`.
* **`getAdvanceRecoveryPlan`** gives where the recovery stands and goes: the threshold in dong (`threshold% × work value`), what the member has asked to be paid so far (from the cumulative ledger), what remains to reach it, what should have been recovered by the formula, how far behind the advance is, and the milestones at a quarter, a half, three quarters and all of the threshold.

## What the database keeps (V1565)

* a planned advance is on a contract in force, under a covering guarantee (contract kind) and carries the version of the rule that capped it; its member is an active party of the contract;
* the status moves only along the edges above, agrees with the amounts (`PAID` ⇒ nothing recovered, `RECOVERING` ⇒ some, `FULLY_RECOVERED` ⇒ all) and the amount paid is set once, when the advance goes from asked for to paid;
* what an advance is about (contract, member, tranche, kind, amount, cap, rule, guarantee, line of capital, threshold) never changes; it is never deleted;
* a recovery that no payment makes says its basis and has evidence (`advance_ledger_entry_outside_chk`); the journal is append-only (V1564).

## An advance and its payment request

A planned advance is paid through a payment request of the ADVANCE kind (ST-PAY-002): sending it takes the advance from `PLANNED` to `REQUESTED` (a second request for the same advance is 409 `PAYMENT_STATE_INVALID`, reason `ADVANCE_NOT_PLANNED`), and returning it plans the advance again. An advance a payment request still stands on is cancelled only after the request is returned or cancelled.

## Operations and events

| Operation | Permission | Event |
|---|---|---|
| `requestAdvance` `POST /contracts/{id}/advances` | `advance.request` | `pay.advance.planned.v1` |
| `cancelAdvance` `POST /advances/{id}/cancel` | `advance.cancel` | `pay.advance.cancelled.v1` |
| `recordAdvanceRecovery` `POST /advances/{id}/recoveries` | `advance.recover` | `pay.advance.recovered.v1` |
| `listAdvances` `GET /advances` | `advance.read` | — |
| `getAdvanceRecoveryPlan` `GET /advances/{id}/recovery-plan` | `advance.read` | — |

Every command is audited and idempotent by its key; the cancel and the recovery need the version (`If-Match`). `/resources/advance_ledger_entry` stays internal.

Browser flow `apps/web/e2e/pay-advance-flows.spec.ts`; visual regions PAY-07 and CTR-06.
