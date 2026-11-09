# Plan of lane ENT-4c: the configurable reporting calendar, real e-mail and Teams reminders, PWA-04, Edge in CI

Branch `lane/ent4c`, worktree `D:\PIS-ent4c`, migration block `ENT4C-1` 2780-2799. Gaps G9 (QT.02) and G13 (YCK.01) of the ENT-3 plan; customer spec QT.02 (deadline per step of the period) and YCK.01 (PWA, Edge, notifications).

## Decisions (owner rule 2026-11-08: deepest governance, best extensibility, no scope cut)

- D1. The calendar is a governance rule, not a table: rule type `REPORTING_SCHEDULE`, one code per period type (`MONTH`, `QUARTER`, `YEAR`, `MEETING`). Versioning, effective dates, maker-checker (proposer is not the approver) and audit come from the existing rule registry and `ADM` rule screens; nothing new to approve with. The five steps (entry, unit approval, Ban KHDT review, period close, push) each carry a deadline offset in days from the end of the period (from the meeting day for `MEETING`) and a local time.
- D2. `MONTHLY_DEADLINE_DAY = 5` becomes the built-in default of the `MONTH` entry step (offset 5 after the last day of the month = the 5th of the next month, the same instant as before). `MasterRules.calendarPeriods` reads the rule for the month and generates `reporting_period.deadline_at` from it; a period keeps the deadline it was generated with (no retroactive change, as BR-MDM-08). Quarter and year periods become generatable (`reporting_period` already allows them).
- D3. The per-input-point status board is a read model over data that exists: entry from the submission board, unit approval from the report status, period close from the period status; the Ban KHDT review and the push are `NOT_TRACKED` until ENT-3c lands the workflow facts (the hook is a plain map of step facts, no schema guess). A step is never shown as done without a fact.
- D4. Reminders ride the existing outbox and notification consumer (the pattern of `adm.approval_task.reminded.v1`): a job writes one row per (period, unit, step, kind, ordinal) in `reporting_reminder` (unique series key, so a pass run twice or by two processes records each once) and emits `dis.calendar_step.reminded.v1`; the tenant picks the channels with a notification workflow. Every kind has an `ALERT_TYPE` (owner, expected action, consequence).
- D5. Email: `SmtpChannelAdapter` (node:net/tls only, no new dependency) on the `EMAIL` channel, configured by environment (host, port, security `tls|starttls|none-for-local`, user, password reference, sender, allowlisted hosts optional). Retry, queue and the delivery log already are the delivery engine (`delivery_attempt`): the adapter only classifies replies (4xx retryable, 5xx permanent, lost answer after DATA is UNKNOWN). It is `VERIFIED`-capable only after a spike with the customer relay, so its status is `PROPOSED` in production until `MACHVON_SMTP_VERIFIED=true` is set by the operator, and `MOCK` is never registered in production (existing registry rule). Tested against a fake SMTP server (plain, STARTTLS and implicit TLS with a generated certificate).
- D6. Teams: `TeamsWebhookChannelAdapter` posts the existing Adaptive Card to an incoming-webhook URL. The host must be on an allowlist (`*.webhook.office.com`, `*.logic.azure.com`, `*.powerplatform.com` plus `MACHVON_TEAMS_WEBHOOK_ALLOWED_HOSTS`), https only, no redirects, 10 s timeout, 429/5xx retryable. The outbox adapter stays for operators who run a relay. Documented in `docs/teams-relay.md`, including the customer relay option.
- D7. PWA-04: `useDirectivesSource` over the DIR operations (`listDirectives`, `getDirective`) provided as the default source; list with status filter and overdue, detail sheet with the timeline. `progress_percent` stays null when nothing was reported.
- D8. Edge: a `msedge` project in `apps/web/e2e/support/browsers.ts` and a smoke leg in `.github/workflows/browsers.yml`, YAML checked with js-yaml.
- D9. Screens: next free ids of `ADM` (calendar rule editor) and `DIS` (calendar board); web only reads/writes through the contract.

## Steps

- [x] 0. Plan, migration block registered.
- [ ] 1. Kernel: `reporting-schedule.ts` (periods of all types, step deadlines, step status), rule type + defaults + alert types, texts; `reporting-calendar.ts` monthly deadline day parameter. Tests (jest, kernel).
- [ ] 2. DB: `reporting-schedule-reader.ts`, `MasterRules` reads the rule, quarter/year generation, board store, reminder store, migration (event type, `reporting_reminder`, RLS), job `calendar-reminder`. Tests (db lane, serialized).
- [ ] 3. API: calendar and board controller, job wiring, contract operations through `contract-patch`, authz matrix, error codes. Tests.
- [ ] 4. SMTP adapter, fake SMTP server, tests, runbook text.
- [ ] 5. Teams webhook adapter, fake server, tests, `docs/teams-relay.md`.
- [ ] 6. PWA-04 wiring and tests, `docs/pwa.md`.
- [ ] 7. Edge leg in CI and Playwright browser selection, tests.
- [ ] 8. Web screens (ADM, DIS), i18n parts `ent4c.{vi,en}.json`, routes, tests.
- [ ] 9. Docs, shared suite lists (jobs/timers, conformance counts) added but not run, lint/typecheck, independent review (Codex is rate limited until 2026-11-10 23:17: a read-only subagent reviews `git diff main...HEAD`), `git merge main`.

## Tests per step

Kernel: period codes and boundaries per type, default MONTH entry deadline equals the old constant, ordering rules refused, step status table, reminder due dates, meeting items, alert types registered with owner/action/consequence. DB: rule in force by date, generation of quarter/year, board counts, reminder idempotency, no reminder for done steps. SMTP: handshake, AUTH, dot-stuffing, 4xx/5xx, lost answer, TLS. Teams: card body, allowlist refusal, redirect refusal, retryable classes. PWA: list/empty/error/stale/detail, mapping. Edge: browser list and workflow YAML parse.

## Risks

- DB suites cannot run while the shared gate is active: DB tests are written and typechecked and run when the machine allows; the report says which ran.
- Notification delivery needs a tenant workflow for the new event type; the seed workflow is not created here (documented), as for the approval reminder.
- ENT-3c owns the Ban KHDT review and push facts: the board reports `NOT_TRACKED` for them.
