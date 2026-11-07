-- Authored by hand (not generated): the reads of the alert centre for the payment integrity checks (G4-2, lane D) look for the latest run of a request that was blocked, and for runs that were made on sending and carry signals.
-- Partial indexes keep those reads on the few rows that matter instead of every run ever made (the table only grows: it is append-only).

CREATE INDEX payment_integrity_run_blocked_idx ON machvon.payment_integrity_run (tenant_id, created_at DESC, id) WHERE outcome = 'BLOCKED';
CREATE INDEX payment_integrity_run_signals_idx ON machvon.payment_integrity_run (tenant_id, created_at DESC, id) WHERE trigger_kind = 'SUBMIT' AND signal_count > 0 AND outcome <> 'BLOCKED';
-- The findings that stand (not covered by an exception) are what an alert is about.
CREATE INDEX payment_integrity_finding_standing_idx ON machvon.payment_integrity_finding (tenant_id, run_id) WHERE NOT excused;
