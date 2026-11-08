# Lane GOV-10 plan

Items of docs/governance-roadmap-10of10.md: G4-3 procurement red flags (12 OCP indicators, auditors only), G2-6 channel ladder and delivery receipts, G2-8 auto-close and reopen of alerts, G2-9 "this alert is wrong" feedback and review queue, G2-11 flood protection, G2-12 new alert sources (contract clock, document review, data freshness, anomaly).

Migration block 2040-2059: V2040-V2043 red flags, V2044-V2046 channel ladder, V2048-V2050 observation, feedback, flood.

## Layers and status
- Kernel: alert-sources, red-flags, alert-ladder, alert-lifecycle, alert-flood, gov10-rule-types, gov10-screens (done, unit tested).
- DB: stores for red flags, ladder, observation, feedback, flood; alert sources (HomeGov10Sources, HomeRedFlagSources, HomeAlertFeedbackSources) wired in HomeWorkStore (done; DB tests in gov10-alert-ops and gov10-red-flags-sources).
- API: controllers (aud red-flag, home alert-ops, alert-ladder), jobs alert-observe, alert-ladder, red-flag-scan registered in jobs and workers; contract through contract-patch.
- Web: AUD-14..16, NOT-30, HOME-30, HOME-31, the FeedbackAction button; i18n part gov10.
- Gates: authz matrix, commands:check, lint, isolation, conformance, outbox consumers, dis report tests, Codex review.

## Decisions
- Thresholds only through governance rules (RED_FLAG_RULE codes, ALERT_CHANNEL_LADDER, ALERT_FLOOD_POLICY, ALERT_FEEDBACK_POLICY, CONTRACT_CLOCK_RULE, DOC_REVIEW_RULE, DATA_FRESHNESS_RULE, ANOMALY_RULE), all flagged unverified.
- A failing source never closes an alert; a report never hides or silences an alert.
- Screen ids are constants in packages/kernel/src/gov10-screens.ts (GOV-9a took HOME-13, NOT-18, ADM-25; ours are NOT-30, HOME-30, HOME-31).
