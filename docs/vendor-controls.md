# Controls of contractors and suppliers (lane VND-2)

Lane VND-2 of the governance deepening, on top of the foundation of VND-1 (`docs/vendor-management.md`). Research items V4, V5, V7, V9, V10, V11, V13 of `research-vendor.md`. Plan and decisions: `docs/plans/vnd2.md`. The three slices are described in their own documents:

| Slice | Document | Items | Screens | Migrations |
|---|---|---|---|---|
| Independence, finance, load, package controls | `docs/vendor-controls-independence-finance.md` | V5, V7, V9 | VND-07, VND-08 | V2420 to V2423 |
| Bid security, subcontracts | `docs/vendor-controls-security-subcontract.md` | V10, V11 | VND-09, VND-10 | V2424 to V2427 |
| Risk grade, performance publication | `docs/vendor-controls-risk-performance.md` | V13, V4 | VND-11, VND-12 | V2428 to V2429 |

## 1. Principles

1. **A signal is never a verdict.** The kernel computes findings, ratios, load signals and the risk grade with the figures and the codes behind them (`packages/kernel/src/vendor-independence.ts`, `vendor-finance.ts`, `vendor-security.ts`, `vendor-subcontract.ts`, `vendor-risk.ts`, `vendor-performance.ts`: pure, golden tests in `packages/kernel/test/vendor-controls.test.ts`). A person decides, and the person who decides is never the person who made the proposal (CHECK in the database too).
2. **Every number is a rule of governance.** Seven rule types (`VENDOR_INDEPENDENCE`, `VENDOR_FINANCE`, `VENDOR_CAPACITY`, `VENDOR_BID_SECURITY`, `VENDOR_SUBCONTRACT`, `VENDOR_RISK`, `VENDOR_PERFORMANCE`) are registered by `registerVendorControlsRules` in `packages/kernel/src/governance-rules.ts` with formula, source and as-of, every default flagged UNVERIFIED (the 30 and 20 percent of cross ownership, 12 months of a former official, 3 times the security, 6 months and 20 days of the performance, and all thresholds of finance, load and risk are starting values of the research). `VendorPolicyReader` reads them and every decision stores the rule version it used.
3. **Gates are opt-in by data, measured by indicators.** A package that was never checked for independence, or that asks no bid security, is not blocked at the award; the indicators `VENDOR_INDEPENDENCE_CHECKED` and `VENDOR_SECURITY_CONFIRMED` measure the work still to do, in the way the gate of VND-1 softened the profile and the certificates.
4. **Unknown is never a pass.** A finance test with too little data says `INSUFFICIENT_DATA`; a load with no revenue says `NO_DATA`; a risk factor with no reading adds a gap for the profile and half of the weight for the finance.

## 2. Where it is wired

| Hook | Where |
|---|---|
| Award of a package | `BidResultStore.assertWinner`: `VendorGate` (VND-1), then `VendorIndependenceGate.assertOpen` (422 `INDEPENDENCE_FINDING_OPEN`), then `VendorSecurityGate.assertAllowed` (422 `BID_SECURITY_NOT_VALID`) |
| Approval of a subcontract | `VendorSubcontractStore.approve` runs the gate action SUBCONTRACT of VND-1 (restriction, certificates) before the move |
| Risk grade readings | `packages/db/src/vendor-risk-signals.ts` connects finance and load, strong findings undecided, subcontract breaches and forfeited securities to the grade |
| Alert centre | `HomeVendorControlsSources` (called by `HomeVendorSources`, source `VENDOR`): nine alert types with owner, expected action and consequence in `ALERT_TYPE` |
| Indicators | `GET /vendor/control-figures` (`VendorControlFiguresController`): the seven definitions of `KPI_DEFINITION` with numerator and denominator counted now |
| Performance and e-GP | The rating is the proposal of CA-3 (`contract_rating_proposal`, response window by `EGP_POSTING_DEADLINES/CONTRACTOR_RESPONSE`); the publication record here is the receipt of the obligation `CONTRACTOR_PERFORMANCE` of EGP-2 (shown read only; writing the receipt back is a flow of the e-GP lane) |

## 3. Permissions and operations

New permissions: `vnd.independence.read`, `vnd.interest.declare`, `vnd.independence.run`, `vnd.independence.decide`, `vnd.finance.write`, `vnd.finance.verify`, `vnd.package.controls`, `vnd.security.write`, `vnd.security.confirm`, `vnd.security.forfeit.propose`, `vnd.security.forfeit.decide`, `vnd.subcontract.write`, `vnd.subcontract.approve`, `vnd.subcontract.pay`, `vnd.risk.assess`, `vnd.risk.decide`, `vnd.performance.publish`; reads use `vnd.read`. All on a grant over the whole tenant. 13 reads and 23 commands under `/vendor/...` (tag VND); each command is audited (ADM-11), idempotent and announces an outbox event with ids and codes only. Error codes added: `INDEPENDENCE_FINDING_OPEN`, `INDEPENDENCE_DECISION_INVALID`, `FINANCIAL_PERIOD_DUPLICATE`, `BID_SECURITY_NOT_VALID`, `SUBCONTRACT_STATE_INVALID`, `SUBCONTRACT_LIMIT_EXCEEDED`, `RISK_ASSESSMENT_STATE_INVALID`, `PERFORMANCE_PUBLICATION_DUPLICATE`, `RATING_NOT_ADOPTED`.

## 4. Not done here, on purpose

- **VND-3** (graph of related parties and screening for bid rigging, continuous screening against the national list, the supplier portal): the subcontractor confirmation of a payment (`confirmed_by_subcontractor`) and the answer of the contractor are the hooks of the portal.
- A recusal decision of a panel member is not copied into `bid_conflict_declaration` (that store reopens evaluation reports; wire it deliberately).
- Joint-venture finance exists in the kernel (`ventureFinance`) and is not yet used by the stores or screens.
- The `UAT-VND2-*` and `UI-VND-07..12` cases are written as `NOT_RUN`; the shared suites (isolation, reachability, command conformance, outbox consumers, DIS report, negative authorization matrix, workers and jobs lists) are run once by the lead on the merged tree.
