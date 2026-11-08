# Lane MR-1 plan: risk register job (MR.02) and post-investment effectiveness (MR.03, G4-7)

Branch `lane/mr1`, migration block 2480-2499 (V2480 risk signals, V2481 effect targets, V2482 effect measurements, calendar and assessments).

## Decisions (owner rule 2026-11-08: decide by governance depth, no scope cut)

- The register of PRJ-16 (`project_risk`, written by people) is extended, not duplicated: a new table `project_risk_signal` holds the lines the job scores from live signals, and one append-only `project_risk_score_history` holds every score of both (a trigger writes the history of a register risk, so any command that moves a score is covered).
- Five kinds of signal: schedule delay (SPI shortfall, milestone slip), payment integrity (blocked drafts, requests sent with signals), claims and early warnings (CTR registers when present, critical DIS warnings), funding gap (plan of the year against allocated), procurement delay. A figure that cannot be known is `null`, never zero; a kind with no known indicator is not scored and leaves its line alone.
- Thresholds, impacts, the opening line, the critical line and the jump points are the governance rule `RISK_SIGNAL_POLICY` (starting value flagged unverified, source and as-of). Alerts `RISK_SCORE_CRITICAL` (ACTION) and `RISK_SCORE_JUMP` (WATCH) are ALERT_TYPE defaults and are raised only when a score goes UP across a line; one alert for a subject, a type and a day, one standing critical alert at a time, resolved the day the score falls.
- Job `risk-rescore` every 3 hours, idempotent (no write when nothing moved, rows locked per line).
- Effectiveness: target set drafted by one person and fixed by another (maker is not approver), immutable once fixed (replaced only by a new draft with a reason, the old set SUPERSEDED); actuals append-only with corrections; variance computed on exact decimals in the kernel (`EFFECT_POLICY`, unverified); calendar of Articles 76-77 as the rule `EFFECT_EVALUATION_CALENDAR` per project group (`GROUP_A` ...), flagged unverified, anchored on the stage history and the accepted handover; assessment record freezes the variance, decided by someone other than the submitter, approval closes the calendar entry.
- Alert-centre source wiring for `project_risk_alert` (work_action.source value, HomeIntegritySources reader) is left to the integration lane, as it was for the baseline alerts.

## Steps and state

1. Migrations V2480-V2482, block registered: done.
2. Kernel pure rules (`risk-signals.ts`, `effect-target.ts`, rule registration, texts) with tests: done.
3. Db stores, reader, job, registration in jobs/workers and the count tests: done.
4. API controllers, contract-patch (11 operations, 5 error codes, 2 screens), generated contract, authz matrix: done.
5. Web screens PRJ-28 and MNE-11 with kit, states matrix, "i" on numbers, i18n parts: in review.
6. Design records (stories, traceability, backlog), runbook, module docs: see the commits.
7. Gates: lint, typecheck, db tests, isolation, conformance, outbox consumers, dis report, Codex review.
