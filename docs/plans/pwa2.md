# PWA2: the manager application, second wave (lane pwa2)

Goal: take the installed manager application (YCK.01, docs/pwa.md) from three list screens to a usable phone product: a tap-through approval detail on the real operations the phone application uses, the directive tracking over the real directive operations, phone-native versions of the two most used drill-downs, a settings page, and the registration of all of it in the design pack.

Screens (ids reserved in the design pack, module `PWA`):

| Id | Path | What |
|---|---|---|
| PWA-01..04 | `/m`, `/m/approvals`, `/m/dashboard`, `/m/directives` | exist; registered in the pack by this lane |
| PWA-05 | `/m/approvals/:taskId` | approval detail: period summary, comparison with the plan and the revision before, evidence, step history, decide |
| PWA-06 | `/m/directives/:id` | directive detail with timeline |
| PWA-07 | `/m/settings` | devices and sessions, language, notification preferences per category |
| PWA-08 | `/m/dashboard/detail` | drill-down of HOME-09 for a phone (amounts, ranking, causes, cash flow, changes) |
| PWA-09 | `/m/progress` | drill-down of BID-27 for a phone (steps of the procurement workflow, packages of a step) |

## Steps

- [ ] 1. Register PWA-01..PWA-09 (`scripts/contract-patch.mjs add-screen`, module PWA), traceability, backlog, test cases, hdsd description; `check-cli` and `baseline-cli` at 0 errors. Test: the design tools themselves.
- [ ] 2. PWA-05 approval detail. Model (`approval-detail-model.ts`: report figures, comparison with plan and revision, evidence, step history), hooks (task, report, previous revision, unit, project, instance tasks), screen with the decision sheet (If-Match version, step-up, idempotency through `useDecideTask`); the queue links to it and shows the project and unit NAMES instead of the id prefix. Tests: model (single vitest file), screen (single file).
- [ ] 3. PWA-04 directives over `listDirectives`, `getDirectiveSummary`, `getDirective` (through the hooks of DIR); filters status, overdue, unit; summary tiles with the definitions; PWA-06 detail with timeline. Correct the invented contract in docs/pwa.md and `directives-source.ts`. Tests: screen, detail.
- [ ] 4. PWA-07 settings: sessions and devices (`listMySessions`, `listMyDevices`, revoke), language (interface language, saved to the profile with If-Match), notification preferences per category (`getMyNotificationPreferences`, `updateMyNotificationPreferences`). Tests: screen.
- [ ] 5. PWA-08 and PWA-09 drill-downs and the links from PWA-03; one column, no horizontal scroll, 44 px targets. Tests: screens + a CSS contract test for the 360 px rules.
- [ ] 6. i18n parts `pwa2.{vi,en}.json` (folded), a11y (axe in the tests), shared suites entries (added, not run), docs/pwa.md, hdsd description.
- [ ] 7. Final: lint chain parts allowed by the resource rules, typecheck of the web package, independent review (Codex when available, else a read-only subagent), merge main.

## Risks

- Memory: single-file vitest only, one heavy command at a time, RAM checked first.
- The report revision and the task are separate rights; a refusal of one leaves its part out (as MOB-24 does), a lost connection fails the read.
- No operation downloads a report file, so the evidence is listed (name, type, size, hash) and not linked; recorded as a follow-up for the files lane.
- The instance's step history shows only the tasks the reader may see (the server scopes `get_resources_approval_task`); the screen says so.
- Not browser-verified at 360 px (no browsers in this lane): the layout is one column with CSS rules pinned by a test.
