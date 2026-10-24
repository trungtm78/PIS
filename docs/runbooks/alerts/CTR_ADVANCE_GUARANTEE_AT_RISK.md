# CTR_ADVANCE_GUARANTEE_AT_RISK

**Owner:** contract-office · **Severity:** warning · **Rule:** `alerts/rules/CTR_ADVANCE_GUARANTEE_AT_RISK.json`

## What it means

The job `guarantee-expiry` (every morning at 06:00 Vietnam time, `docs/runbooks/jobs.md`) counts the ACTIVE advance guarantees that expire within 30 days of a contract that still owes an advance (`advance_paid_vnd` above `advance_recovered_vnd`). The gauge `ctr_advance_guarantee_at_risk` is that number over all tenants; the gauge `ctr_guarantee_expiring{days}` counts every ACTIVE guarantee within 30, 15, 7 and 0 days of its expiry.

An advance guarantee must stay valid until the advance is recovered (BR-CTR-10). When it lapses first, a new advance is refused (`ADVANCE_GUARANTEE_REQUIRED`) and an issue is opened for the contract (`ctr.guarantee.expired.v1`, answered by the issue intake of ISS).

## What to do

1. Open CTR-05 on the "expiring" tab: the guarantees are listed soonest first, with the days left and, for the readers of the ledger, the advance still owed.
2. Ask the contractor for the replacement. The contract officer registers it with `extendGuarantee`; a second person (the chief accountant) verifies it with the issuer. A guarantee is never renewed by the job and never extended in place.
3. Do not edit the expiry in the database: the guard trigger refuses it, and the old guarantee stays on file as SUPERSEDED with the expiry it had.
