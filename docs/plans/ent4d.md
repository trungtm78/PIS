# Plan of lane ENT-4d (presentation mode, enterprise rates and tiles, scheduled delivery of issued forms)

Branch `lane/ent4d`, worktree `D:\PIS-ent4d`, migration block 2820-2839. Source: HSKT v0.3 BC.02 and CN.03; plan section ENT-3 gap G10 and G12 (the tiles of DIR.md section 12, R2). The enterprise parts follow the ENT-2 pattern: rules and stores in `packages/edition-enterprise`, controllers in `apps/api/src/editions/enterprise`, screens in `apps/web/src/editions/enterprise`.

## Decisions (owner rule 2026-11-08: deepest governance, best extensibility, no scope cut)

- D1. Presentation mode is one generic web component (`ui/PresentationMode`), not four copies: boards are passed in, the component owns full screen, auto-advance, keyboard, pause, live announcement and the wake lock. Edit chrome is hidden by construction (only the boards render). It is edition independent (public dashboards get it too); the clip step `dir.dashboard.presentation-mode` binds to the button on DIR-05.
- D2. Auto-advance never runs for a person who asked for reduced motion and always has a visible pause (WCAG 2.2.2); a board never changes while the pointer or focus is inside a control that needs time; the interval is chosen from a fixed list (10, 20, 30, 60 s).
- D3. Enterprise rates are a pure function over two sets of `RateSums` (the same type DIS-19 and HOME use, so `rateOfSums` stays the single definition of a rate): the current frozen snapshot and the snapshot of the same period one year before. The levels are the three of BC.02: the whole company, the unit, the project. The sums come through a port `EnterpriseRateSource`; until ENT-3a lands `EnterpriseFigureReader` the default source reads `period_snapshot_line` through `DisSnapshotStore.rateSums`; the adapter to the reader is the only file to change. The public edition has no such operation (module mounted for the enterprise edition only), so HOME-01/03 golden figures cannot move.
- D4. The two tiles of the leadership dashboard are counts with a drill list and a formula, not new data: projects blocked on procedure = projects with at least one open issue of a procedural kind (ISS), permit (PMT) or land (LND) item past its due day; overdue directives = directives of DIR whose due day is past and which are not closed (same rule as DIR-05 `overdue_at_end`). A figure that cannot be read is null with its reason, never 0.
- D5. Scheduled delivery of issued forms: a schedule names an issued form series (layout code and period kind), a cron in the time zone of Vietnam, a recipient list (members of the tenant; external addresses are refused: the address is read from the member at send time, never stored in the schedule), a format (XLSX or PDF) and a message note. The runner sends the HEAD issued copy of the series that was issued after the last delivery; the message carries the sha256 of the attached file; the attachment is the stored XLSX or the PDF made from the same document. A DEMO form is never delivered. Every attempt is a row of the delivery log (append only): recipient, copy, hash, status, error code. The send uses the channel port (`ChannelAdapter`, ENT-4c brings the SMTP one); the port gets one optional field `attachments`.
- D6. One delivery per (schedule, copy, recipient): a unique key keeps a re-run of the minute from sending twice.

## Steps

- [x] 1. Plan (this file).
- [ ] 2. Web: `ui/PresentationMode` + hook, tests (keyboard, auto-advance with fake timers, pause, reduced motion, fullscreen fallback, accessibility roles); i18n part `ent4d.{vi,en}.json`.
- [ ] 3. Web: presentation buttons and boards on HOME-09, BAN-01, BI-02 and DIR-05; tests.
- [ ] 4. Enterprise package: `leader/rates.ts` (rates board, same period last year), `leader/tiles.ts` (blocked on procedure, overdue directives), tests including a mutation-detecting test (a wrong sign in the delta is caught).
- [ ] 5. Enterprise package: `delivery/` rules (schedule validation, due test, message, recipient rules), tests.
- [ ] 6. Database: block 2820, `V2820__ent4d_report_delivery.sql` (schedule, log), store, db tests (run only when the machine is free).
- [ ] 7. API: enterprise module `LEADER` (rates, tiles) and `RDL` (schedules, log), runner `report-delivery-runner`, channel port attachment field, authz matrix, command registry, contract patch, tests.
- [ ] 8. Web: enterprise panel (rates by company, unit, project; tiles) on HOME-09/BAN-01, screen RDL-01 (schedules and log); tests.
- [ ] 9. Docs (`docs/ent-leader-dashboard.md`), suite entries for the shared suites (not run), `git merge main`, review by an independent subagent (Codex is limited until 2026-11-10 23:17), triage and fixes.

## Tests per step

Step 2/3 vitest single files; 4/5 node test via the package runner (pure); 6/7 jest through `scripts/lane.mjs db` only once no `verify-cli` process exists; 8 vitest single files.

## Risks

- ENT-3a has no commit yet: the source port isolates the dependency; merge when its first commit exists.
- Memory is tight: only single-file runs, one at a time.
- Shared files (openapi, screen catalog, authz matrix, kernel and db index) are touched with small anchored edits through `contract-patch`.
