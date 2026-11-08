# Plan of lane GOV-9a (alert governance), branch lane/gov9

Items of `docs/governance-roadmap-10of10.md`: G2-3 escalation (functional / hierarchical), G2-5 notification profile, G2-7 absence cover and coverage, G2-10 health page with fourteen indicators. Rules, tables and jobs are described in `docs/alert-governance.md`.

## Decisions (owner standing rule: deepest governance, best extensibility, no scope cut)

1. Items of the alert centre are computed, not stored, so a trace table (`alert_item_trace`, written by the job every 15 minutes) is the source of the health indicators and of the first-seen time; figures are as exact as a pass.
2. Four rule types (`ESCALATION_POLICY`, `ABSENCE_POLICY`, `ALERT_NOTIFY_POLICY`, `ALERT_HEALTH_TARGETS`), all unverified starting values with source and as-of; `ALERT_TYPE` gains optional `quiet_bypass` (off by default).
3. A cover routes attention, never authority; the allower is a third person; the deputy reads the absent person's work in the deputy's own scope.
4. Leadership of an owner is found from grant ranks and the unit tree; approvals keep the rank of the matrix of authority (`DoaMatrixStore.resolve`).
5. A push holds a fixed sentence, a count and a path (R7); delivery and receipts are G2-6; the delivery indicator says "no source" until then.
6. Two jobs: `alert-escalation` (trace, levels, promotion, notices, digest) and `alert-coverage` (gaps, orphans of owners who left).

## Steps

- [x] Kernel pure rules + tests (escalation, coverage, notify, health), rule registration, texts
- [x] Migrations V2000-V2005 (RLS, guards, indexes), stores, sources ESCALATION and COVERAGE, db tests
- [x] Jobs, 13 operations through contract-patch, authz matrix, isolation cases, command registry, api tests
- [x] Web screens HOME-13, NOT-18, NOT-19, ADM-28, i18n, tests
- [x] Stories, traceability, backlog, test catalogue, module specs
- [ ] Full gate (lint, typecheck, isolation, conformance, outbox, dis report), Codex review and dispositions
