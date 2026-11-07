-- Authored by hand (not generated): the daily reconciliation of the books with the Treasury (G4-4 of docs/governance-roadmap-10of10.md, PAY). One row is one pass over one business day: what it compared, with which thresholds (the version of
-- the rule `RECONCILIATION_POLICY` that decided, or the built-in default), and whether the pass could be COMPLETE or only PARTIAL. A day whose Treasury statement is not in, or whose sources could not be read, is PARTIAL with the reason,
-- never "no difference". A row is never changed and never removed (the audit of a month reads it years later); a second pass of the same day that finds the same lines is not written again (`result_sha256`), one that finds other lines is
-- the next `run_no`. The lines are in V1841 and the items with an owner in V1842. This does not touch `reconciliation_item`, which keeps one item for each transaction.

CREATE TABLE machvon.treasury_daily_recon_run (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  recon_date date NOT NULL,
  run_no integer NOT NULL CHECK (run_no >= 1),
  status text NOT NULL CHECK (status IN ('COMPLETE', 'PARTIAL')),
  partial_reason text CHECK (partial_reason IN ('STATEMENT_MISSING', 'SOURCE_UNREADABLE')),
  -- The statement files of that day that were applied, and the Treasury transactions confirmed that day (Vietnam time): the two things a missing statement is judged by.
  statement_imports integer NOT NULL DEFAULT 0 CHECK (statement_imports >= 0),
  transaction_count integer NOT NULL DEFAULT 0 CHECK (transaction_count >= 0),
  line_count integer NOT NULL DEFAULT 0 CHECK (line_count >= 0),
  difference_line_count integer NOT NULL DEFAULT 0 CHECK (difference_line_count >= 0),
  opened_items integer NOT NULL DEFAULT 0 CHECK (opened_items >= 0),
  cleared_items integer NOT NULL DEFAULT 0 CHECK (cleared_items >= 0),
  books_total_vnd numeric(24,0) NOT NULL DEFAULT 0,
  treasury_total_vnd numeric(24,0) NOT NULL DEFAULT 0,
  -- The thresholds that decided, as they were on the day of the pass (formula and source are those of the rule type in the kernel registry).
  rule_version integer NOT NULL CHECK (rule_version >= 0),
  rule_source text NOT NULL CHECK (rule_source IN ('RULE', 'DEFAULT')),
  rule_unverified boolean NOT NULL,
  threshold_vnd numeric(24,0) NOT NULL CHECK (threshold_vnd >= 0),
  threshold_pct numeric(7,4) CHECK (threshold_pct IS NULL OR (threshold_pct >= 0 AND threshold_pct <= 100)),
  due_days integer NOT NULL CHECK (due_days BETWEEN 1 AND 60),
  partial_after_days integer NOT NULL CHECK (partial_after_days BETWEEN 0 AND 30),
  -- The due days of the items opened here were counted on the published work calendar, or by the week when a year has none (said on the screen).
  calendar_basis text NOT NULL CHECK (calendar_basis IN ('WORK_CALENDAR', 'WEEKDAYS_ASSUMED')),
  result_sha256 char(64) NOT NULL,
  origin text NOT NULL CHECK (origin IN ('JOB', 'MANUAL')),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  -- No foreign key on the author: the hourly job writes as the worker, who is not a member of any tenant (like computed_by of the early-warning score).
  CONSTRAINT treasury_daily_recon_run_no_uq UNIQUE (tenant_id, recon_date, run_no),
  CONSTRAINT treasury_daily_recon_run_partial_chk CHECK ((status = 'PARTIAL') = (partial_reason IS NOT NULL))
);

CREATE INDEX treasury_daily_recon_run_day_idx ON machvon.treasury_daily_recon_run (tenant_id, recon_date DESC, run_no DESC);

ALTER TABLE machvon.treasury_daily_recon_run ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.treasury_daily_recon_run FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.treasury_daily_recon_run AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.treasury_daily_recon_run AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- Kept for good and never edited: the application adds a row and reads it.
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.treasury_daily_recon_run FROM machvon_app;

COMMENT ON TABLE machvon.treasury_daily_recon_run IS 'Daily reconciliation passes with the Treasury (G4-4): COMPLETE or PARTIAL with the reason, with the thresholds that decided; append-only.';
