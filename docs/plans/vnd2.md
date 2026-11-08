# Plan of lane VND-2 (contractor and supplier controls)

Branch `lane/vnd2`, worktree `D:\PIS-vnd2`, migration block 2420-2439 (registered in `db/migrations/blocks.json`). Research items V4, V5, V7, V9, V10, V11, V13 of `research-vendor.md`; stands on VND-1 (`docs/vendor-management.md`, `packages/kernel/src/vendor-*.ts`, `packages/db/src/vendor-*.ts`, `apps/api/src/modules/bid/vendor*.ts`, `apps/web/src/screens/vnd/`) and extends it. Spec: `docs/vendor-controls.md`, `Design/MACHVON_Design/01_Documents/05_modules/VND.md` (section VND-2).

## Decisions (owner rule 2026-11-08: deepest governance, best extensibility, no cut of scope)

1. **A signal is never a verdict.** Independence findings, finance ratios, load signals and the risk grade are computed from data with an explanation per figure; a person decides (maker-checker where it blocks). Nothing disqualifies a bidder by itself except the existing gate and the decision of a finding with BLOCKED.
2. **Every threshold is a governance rule** registered through `registerVendorControlsRules` (types `VENDOR_INDEPENDENCE`, `VENDOR_FINANCE`, `VENDOR_CAPACITY`, `VENDOR_BID_SECURITY`, `VENDOR_SUBCONTRACT`, `VENDOR_RISK`, `VENDOR_PERFORMANCE`), flagged UNVERIFIED with formula, source and as-of; the policy reader `VendorPolicyReader` gets one method per type and every decision stores the rule version it used.
3. **Independence (V5)** compares the bidders of a package with the panel (evaluators), the project staff named by the chair and the owner organisation. Facts: the profile keys of VND-1 (tax head, address, telephone, e-mail, representative, owners) and the interests that a person declares about themselves (`vendor_person_interest`: a relative who represents or owns a bidder, a share held, a former employer, an advisory role). Findings are append-only rows with a decision CLEARED / RECUSED / BLOCKED by a person other than the one who ran the check; an undecided finding of strength STRONG blocks the award gate. Cross ownership limits (30 and 20 percent) are rule data.
4. **Finance (V7)** keeps one verified period per contractor and year (revenue, assets, current assets and liabilities, debt, equity, EBIT, interest); a joint venture is judged by the share of each member. Ratios (current ratio, debt to assets, interest cover, average revenue) are judged against thresholds of the rule and, when given, against what the package asks.
5. **Load (V9)** is computed on read from open contracts, late contracts and awarded packages not yet signed, against the average revenue of the finance periods; the signal says OVER when the multiple of the rule is exceeded.
6. **Bid security (V10)** is a register: received, confirmed with the issuer by a second person, then released, expired or forfeited. A forfeiture is proposed by one person and decided by another, on a decision paper. The amount the package asks is multiplied by `bidSecurityFactor` of VND-1 (3 times for a contractor with a posted event). Forfeiture and non-submission raise the hook for the ledger of bid conduct (event, never an automatic posting).
7. **Subcontracts (V11)**: a subcontract is proposed, approved by another person (the gate action SUBCONTRACT of VND-1 runs at approval), and may be terminated. The sum of the shares of the approved subcontracts may not pass the share declared in the bid, or the limit of the rule when none was declared; a subcontract not declared in the bid needs the approval to say so. Each payment request is followed by the confirmation of what the prime paid the subcontractor (amount, day, reference), confirmed by the subcontractor through the supplier portal later (VND-3 hook) or by the contract manager now.
8. **Risk grade (V13)**: a snapshot (append-only) with the points of every factor, the explanation text keys, the rule version and the tier LOW / MEDIUM / HIGH / CRITICAL; HIGH and above need a second person to confirm and set the next review (6 months by rule). The tier is written on the contractor (`contractor.risk_tier`) only by a confirmed snapshot.
9. **Performance (V4)** builds on CA-3 (`contract_rating_proposal`, rule `CONTRACT_PERFORMANCE_RATING`, response window by `EGP_POSTING_DEADLINES/CONTRACTOR_RESPONSE`) and EGP-2 (obligation `CONTRACTOR_PERFORMANCE`): the vendor view joins an adopted rating with its response clock and its publication clock (6 months, rule `VENDOR_PERFORMANCE`), counts consecutive POOR ratings (a suggestion for the debarment register at the third, never an action), and adds the record of the publication (`contractor_performance_publication`, posted once by a person other than the one who adopted, with the receipt of the network, update after the warranty).
10. **Alerts** use the existing source `VENDOR` (the check of `work_action.source` already holds it): V-A4 independence, V-A7 security expiry, V-A9 subcontract, V-A10/V-A11 performance publication and response, V-A12 consecutive POOR, V-A13 load and finance, and the grade review overdue. KPI entries are registered with a numerator, a denominator and a source.

## Steps

| # | Step | Tests | State |
|---|---|---|---|
| 1 | Plan, block 2420, commit | `npm run migrations:check` | [x] |
| 2 | Kernel: `vendor-independence.ts`, `vendor-finance.ts`, `vendor-security.ts`, `vendor-subcontract.ts`, `vendor-risk.ts`, `vendor-performance.ts`, rule types, alert types, KPI, texts | golden tests `packages/kernel/test/vendor-controls.test.ts` | [x] |
| 3 | Migrations V2420-V2427 (tables, guards, RLS, tenant-leading indexes) | rls-catalog, migrations:check | [x] |
| 4 | Stores and policy reader methods, alert source extension | `packages/db/test/vendor-controls-store.test.ts` | [x] |
| 5 | Contract (operations, schemas, error codes, screens) through `scripts/contract-patch.mjs`, generated clients | `contracts:check`, `lint-error-codes` | [x] |
| 6 | API controllers, authz matrix, command registry, isolation entries and counts | `apps/api/test/bid/vendor-controls.test.ts` | [x] |
| 7 | Web screens VND-07 to VND-12, i18n parts `vnd2.{vi,en}.json`, routes | vitest of the screens | [x] |
| 8 | Design rows (story, backlog, traceability, test cases), module doc, `docs/vendor-controls.md`, UAT ids | `check-cli.mjs`, `baseline-cli.mjs` | [x] |
| 9 | Lint, typecheck, scan, Codex review and triage | whole chain | [x] Codex review: 4 findings, all valid and fixed with regression tests; shared suites left to the lead |

## Risks

- Shared files conflict at merge: edits are anchored and one line per item; generated files only through the generators.
- Resources are tight: heavy commands one at a time, DB jest only through the lane.
- Legal numbers (30/20 percent cross ownership, 3 times security, 6 months, 20 days, thresholds of finance and load) are starting values of the research, flagged UNVERIFIED.
