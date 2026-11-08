# Lane GOV-8: claim register with limitation (G1-9) and contract early-warning register (G1-15)

Branch `lane/gov8`, migration block 1980-1999 (V1980-V1985). Owner rule of 2026-11-08: open choices are decided by deepest governance, best extensibility, no scope cut.

## Decisions

1. The limitation of a claim comes from the approved term of its own contract (`contract_claim_term`, proposed by one person, approved by another, the clause named). A contract with no approved term has no clock and says `NO_TERM`; the numbers of FIDIC and NEC are templates (rule `CLAIM_TERM_TEMPLATE`, flagged unverified) that a person may copy into a proposal and that are never applied by themselves, so a domestic contract never inherits an international default.
2. A claim is its own register row with an append-only timeline (`contract_claim_step`); the dates the limits count from are kept on the claim in the transaction of each step; deadlines and limitation are computed on the day of the read by the kernel (nothing stored can go stale). Working-day periods use the published working calendar and are `CALENDAR_UNAVAILABLE` when a year is not published.
3. Maker is not checker: term approval, settlement approval (database CHECK too), bar declaration (never by the registrant, only after a missed notice or particulars day and only when the term says a miss bars the claim), and closing a warning as resolved (never by its owner, database CHECK too).
4. The early-warning register is separate from the disbursement warning of DIS: any party raises, assessment states the impact (a number or an explicit no impact), actions have a person and a day, a meeting must review every open warning, an issue of the register keeps a snapshot and a hash. The rhythm (7 / 14 / 7 days) is the rule `EARLY_WARNING_POLICY`, unverified.
5. Alerts: sources `CONTRACT_CLAIM` and `CONTRACT_EARLY_WARNING` in `HomeWorkStore`; seven kinds, each with an ALERT_TYPE (owner, expected action, consequence).
6. Report hooks for CA-3: kernel `claimRegisterReport`, `limitationHorizon`, `earlyWarningSummary`; db `CtrClaimStore.reportInputs`.

## Steps and state

- [x] Kernel pure rules and tests (`ctr-claim.ts`, `ctr-early-warning.ts`, `registerClaimRules`).
- [x] Migrations V1980-V1985, db stores, alert source, db tests.
- [x] Contract (20 operations, 6 error codes, screens CTR-32..CTR-36) through contract-patch; generated files.
- [x] API controllers, authz matrix, isolation cases, API tests.
- [x] Web screens, i18n parts, routes; docs and design rows.
- [ ] Codex review triage and the cross-cutting API suites on the merged main (lead).
