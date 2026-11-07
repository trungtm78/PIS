# Governance deepening: design and delivery rules

Written for: the engineers (and agents) who build the items of `docs/governance-roadmap-10of10.md`. The owner asked to stop the guide filming and build the missing functions; the owner's earlier directions stand: deepest governance, best extensibility, **no scope reduction (scope may grow)**, order may change, research-backed. The owner opted out of the question round, so the decisions below are my calls; they are marked **[call]** and are meant to be corrected in review, not defended.

## Intent
Make the system the strongest governance tool for public investment that the research supports: every alert is owned, timed, escalated, measured; every number has one definition and a source; money is controlled from plan to payment; integrity is checked where the data allows. All of it as **configuration data with versions and approvals**, so a province can tune thresholds without code changes.

## Goals
- Deliver the MUST items of the roadmap in rounds; each item ships end to end: spec text, migration, API, kernel rules, web screens (and phone where stated), tests, audit trail.
- A shared `governance_rule` store and port so no threshold, definition or policy is a constant in code.
- Every new screen follows `design.md` and `apps/web/src/ui/CONTRACT.md`: tokens only, the kit, the whole states matrix, 3-layer header, ContextBar on numbers, Vietnamese strings through i18n keys.

## Non-goals
- Guide clips, screenshots, seeds for the guide (stopped by the owner).
- Direct integration with the national system or other external systems (file-based import/export only, as the roadmap says).
- Machine-learning scores; every rule is explicit and explainable. No AI or photo decides a payment.
- Sound or blinking alerts.

## Anti-goals (a failure even if tests pass)
- A threshold or definition hard-coded in code or a screen. A screen number without formula, source and as-of time. A command that is not audited, not idempotent, or lets the maker approve their own item. An empty state that says "no work" when a source failed. A new alert type without owner, expected action and consequence.

## Constraints (read before coding)
- Repo conventions: follow the end-to-end pattern of commit `47db69a2` (alert centre backend: kernel rules → db store → controller → authz matrix → command registry → tests) and `4d4db89c`, `5c677960` (web). Contract files, `commands:check`, error-code registry (`Design/MACHVON_Design/03_Engineering/error_codes.json`), authz matrix, RLS, audit, outbox, `Idempotency-Key`, `If-Match` versions apply as there.
- Migrations: numbers live in blocks of 20 owned by a slice (`db/migrations/blocks.json`, `npm run migrations:check`); the highest used is V1706. Round 1 blocks: gov1 1710-1729 (lane A1), gov2 1730-1749 (A2), gov3 1750-1769 (B1), gov4 1770-1789 (B2), gov5 1790-1809 (B3), gov6 1810-1829 (C), gov7 1830-1849 (D). Register your block the way the other slices are; expand/contract rules apply (`npm run expand-contract:check`).
- Spec text lives in `Design/MACHVON_Design/01_Documents/05_modules/<MODULE>.md` (change in place, keep ids and style) and screens in `Design/MACHVON_Design/03_Engineering/screen_catalog.json` (new screens get the next free id of their module; re-read the file right before every edit: several lanes edit it).
- i18n: new keys go to `apps/web/src/i18n/parts/<lane>.vi.json` and `.en.json` (identical key sets, flat); the lead folds them. Mobile strings in the feature's `*_strings.dart`.
- Shared files (`openapi.json`, `screen_catalog.json`, `blocks.json`, `error_codes.json`, authz matrix, `index.ts` barrels): edit with small, anchored edits, re-read before editing, verify the JSON parses after. Do not reformat them.
- Memory is tight: no browsers, servers, emulators or e2e stacks. DB tests only through the serialized lane: `node ../../scripts/lane.mjs db -- node --experimental-vm-modules ../../node_modules/jest/bin/jest.js --testPathPatterns <p> --forceExit --coverage=false`; one at a time per agent; check free RAM first (`powershell -NoProfile -ExecutionPolicy Bypass -File D:\tmp\claude\014be244a4f0a618\0b1c0877-9aa3-4841-92e9-158bbc5f01c7\scratchpad\procs.ps1`, first line ≥ 2.5 GB). Web: `cd apps/web && npx vitest run <paths>`, `npx tsc -p tsconfig.json --noEmit`, from repo root `npx eslint <paths>`, `node scripts/i18n-lint.mjs`. Flutter sequentially only.
- No `git add/commit/stash/checkout/reset/push`: the lead commits by path. Other lanes edit the same tree: touch only your files; if you must change a shared source file of another lane (e.g. `home-work-store.ts`), make a minimal additive hook and report it.

## The shared platform (lane A1 builds it first; others consume)
- **`governance_rule`** **[call]**: one table, `(tenant_id, id, rule_type, code, version, status DRAFT|SUBMITTED|APPROVED|RETIRED, params jsonb, effective_from, effective_to, reason, created_by, submitted_by, approved_by, approved_at)`, append-only versions (a change is a new version; the old one keeps its history), maker ≠ checker, audited (ADM-11), outbox event on approval. Params are validated by a per-`rule_type` schema in the kernel.
- **Kernel module** `packages/kernel/src/governance-rules.ts`: the list of `rule_type`s with their param schema and **built-in default params** (the research thresholds as starting values), pure `resolveRule(rules, type, code, asOf)`. **Port** `GovernancePolicyPort.get(tx, type, code, asOf)` (db) returns the approved rule in force or the built-in default, plus its version (stored on the decisions that used it, e.g. alert, health score, gate review). Lane A1 publishes the kernel module and the port first and writes `D:\tmp\claude\014be244a4f0a618\0b1c0877-9aa3-4841-92e9-158bbc5f01c7\scratchpad\gov-port-ready.txt` (file paths and the call signature). Other lanes start with the pure rules and the defaults, and wire `get(...)` when that file exists; until then they read the defaults through the same function name so wiring is a one-line change.
- **Admin screens** for rules (list, versions, draft, submit, approve, diff) in ADM with the kit; alert-type registry (G0-3) is one `rule_type` (`ALERT_TYPE`) with its own screen (owner, expected action, consequence, response time, reason to exist, review date; a type without an expected action can only be Theo dõi).

## Round 1 (7 lanes, then round 2 continues the roadmap by the order in section 4 of it)
| Lane | Roadmap items | Notes |
|---|---|---|
| A1 governance platform | G0-1, G0-3 | publishes the port first |
| A2 clocks and alert core | G0-2 (clock engine, working-day calendar, hook existing clocks), G2-1 (snooze reason/caps/limit), G2-2 (two clocks, re-claim), G2-4 (reminder cadence) | builds on `HomeWorkStore`, `work_action` (`home-work-*` files, V1660); thresholds from the port/defaults |
| B1 lifecycle and EVM | G1-2 (no plan on the system → no disbursement), G1-3 (baseline deviation, reschedule count), G1-4 (EVM), G1-5 (S-curve) | PRJ, CAP, PAY, CTR, DIS, BI |
| B2 money control | G1-6 (AVC to contract and change), G1-7 (contingency ledger), G1-8 (tiered change orders), G1-11 (advance policy and recovery) | CAP, CTR, PAY |
| B3 gates, appraisal, risk | G1-1 (stage gates), G1-13 (appraisal scoring), G1-14 (risk register with triggers) | PRJ, ADM |
| C analytics | G0-4 (KPI register), G3-1 (certified datasets), G3-2 (explainable RAG), G3-3 (drill-through), G3-4 ("what changed since last week") | BI, HOME; the two ratios of HOME-01 read the register |
| D integrity | G4-1 (separation-of-duties matrix at commit), G4-2 (payment integrity checks), G4-4/G4-5 (reconciliation and cross-total controls) | ADM, CTR, PAY, DGV |

## Definition of done (per item, in the report)
1. Spec text updated (module md + screen catalogue) with the rule, the states and the error codes.
2. Migration in the lane's block (RLS, audit, outbox, idempotency as in `V1660`), `migrations:check` clean.
3. Kernel rule (pure, unit-tested), db store, controller, authz matrix entries, command registry (`commands:check`), error codes registered (`lint:error-codes`), contract regenerated (`contracts:generate`, `contracts:check`) if the repo's flow requires it.
4. API tests through the db lane covering: happy path, each refusal, maker ≠ checker, idempotent replay, scope/permission, a failing source not reported as "none".
5. Web: screens/components with the kit; loading skeleton (never 0), empty kinds, error with retry, partial, stale, denied, submitting; keyboard and labels; vitest for each screen; `tsc`, `eslint`, `i18n-lint` clean for your files. Phone only where the item names MOB.
6. Alerts: a new source/condition registers an `ALERT_TYPE` (once A1 lands; before that, record the type in your report) with owner, expected action, consequence; no new alert without them.
7. Numbers on screens carry formula/source/as-of; any threshold is read through the port, never inlined.

## What is left to the builder
Table shapes inside the lane, endpoint names (follow neighbours), screen layout inside the kit, test fixtures, how to split the work into commits-by-path for the lead. Anything the roadmap marks "chưa kiểm chứng" (legal numbers) is configuration with a flagged default, never a hard rule; say so in the screen help text.
