# Plan of lane VND-1 (contractor and supplier management foundation)

Branch `lane/vnd1`, worktree `D:\PIS-vnd1`, migration block 2400-2419 (V2400 to V2406). Spec: `docs/vendor-management.md`, `Design/MACHVON_Design/01_Documents/05_modules/VND.md`.

## Steps and state
| Step | State |
|---|---|
| Kernel rules (`vendor-*.ts`), governance rules, alert types, KPI definitions, messages | done, unit tests `packages/kernel/test/vendor.test.ts` |
| Migrations V2400-V2406 (profile, accounts, certificates, joint ventures, debarment case, reputation ledger, alert source) | done |
| Stores, `VendorGate` wired at bid, result, activation, payment; alert source `VENDOR` | done, `packages/db/test/vendor-store.test.ts` |
| API: 12 reads, 30 commands (module BID), authz matrix, isolation fixtures | done, `apps/api/test/bid/vendor.test.ts` |
| Contract (openapi, error codes, screens VND-01..06), generated clients | done |
| Web screens VND-01..06, i18n parts, routes | done |
| Design files (story ST-VND-001..005, backlog, traceability, tests, VND.md) | done |
| e-GP hook documented in `docs/egp-connector.md` section 10 | done |
| Gate runs: isolation, reachability, conformance, outbox consumers, dis report, lint, typecheck | see the final report |
| Codex review and triage | see the final report |

## Decisions
- Controllers live in the BID module (no new module code), operations are tagged VND.
- Gate defaults: profile and qualification gaps warn (existing records hold none of the data); restriction and unverified tax code always block.
- The check digit of the tax code is a signal only. Legal numbers are rules flagged UNVERIFIED.
- Paths with several path parameters were avoided so that the tenant isolation suite can name one id.
