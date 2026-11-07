-- Authored by hand (not generated): the checks of a payment request before money goes out (G4-2 of docs/governance-roadmap-10of10.md, lane D).
-- A run is one evaluation of a request against the rule PAYMENT_INTEGRITY in force on the day (duplicates, unit prices, the diary of the site, the ceilings of the plan, the contract and the accepted value). The findings of a run
-- are what the approver sees and what the auditor reads later: an INVARIANT blocks sending the request, a SIGNAL only asks the approver to look. Both are append-only, because a blocked request rolls its writes back
-- except these (the command commits the run and then answers with the refusal), and an auditor must find what stopped the money even when nobody sent it. Nothing here moves money.

CREATE TABLE machvon.payment_integrity_run (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  payment_request_id uuid NOT NULL,
  contract_id uuid NOT NULL,
  project_id uuid NOT NULL,
  -- SUBMIT is the check inside sending the request; PREVIEW is the one a person asks for on a draft.
  trigger_kind text NOT NULL CHECK (trigger_kind IN ('SUBMIT', 'PREVIEW')),
  -- BLOCKED: an invariant that no approved exception covers; SIGNALS: only signals (or invariants that an exception covers); PASSED: nothing found and every source was read; PARTIAL: nothing found but a source could not be read (never PASSED).
  outcome text NOT NULL CHECK (outcome IN ('PASSED', 'SIGNALS', 'BLOCKED', 'PARTIAL')),
  rule_version integer NOT NULL CHECK (rule_version >= 0),
  rule_source text NOT NULL CHECK (rule_source IN ('RULE', 'DEFAULT')),
  rule_unverified boolean NOT NULL,
  rule_params jsonb NOT NULL,
  as_of date NOT NULL,
  invariant_count integer NOT NULL CHECK (invariant_count >= 0),
  signal_count integer NOT NULL CHECK (signal_count >= 0),
  excused_count integer NOT NULL CHECK (excused_count >= 0),
  unavailable jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(unavailable) = 'array'),
  figures jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(figures) = 'object'),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, payment_request_id) REFERENCES machvon.payment_request (tenant_id, id),
  FOREIGN KEY (tenant_id, contract_id) REFERENCES machvon.contract (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES machvon.membership (tenant_id, id),
  CONSTRAINT payment_integrity_run_excused_chk CHECK (excused_count <= invariant_count),
  CONSTRAINT payment_integrity_run_outcome_chk CHECK (
    (outcome = 'BLOCKED' AND invariant_count > excused_count)
    OR (outcome = 'SIGNALS' AND invariant_count = excused_count AND (signal_count > 0 OR excused_count > 0))
    OR (outcome = 'PASSED' AND invariant_count = 0 AND signal_count = 0 AND jsonb_array_length(unavailable) = 0)
    OR (outcome = 'PARTIAL' AND invariant_count = 0 AND signal_count = 0 AND jsonb_array_length(unavailable) > 0)
  )
);

CREATE INDEX payment_integrity_run_request_idx ON machvon.payment_integrity_run (tenant_id, payment_request_id, created_at DESC, id);
CREATE INDEX payment_integrity_run_list_idx ON machvon.payment_integrity_run (tenant_id, created_at DESC, id);
CREATE INDEX payment_integrity_run_contract_idx ON machvon.payment_integrity_run (tenant_id, contract_id, created_at DESC);

CREATE TABLE machvon.payment_integrity_finding (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL,
  payment_request_id uuid NOT NULL,
  contract_id uuid NOT NULL,
  code text NOT NULL CHECK (code IN ('DUPLICATE_CLAIM', 'UNIT_PRICE_OUTLIER', 'QUANTITY_VS_DIARY', 'EXCEEDS_CONTRACT', 'EXCEEDS_PLAN', 'EXCEEDS_ACCEPTED')),
  kind text NOT NULL CHECK (kind IN ('INVARIANT', 'SIGNAL')),
  -- An invariant of the rule is a BLOCK; a signal (or a ceiling the rule sets to WARN) is a WARN.
  severity text NOT NULL CHECK (severity IN ('BLOCK', 'WARN')),
  -- The ceiling an approved exception covers: only an invariant can be covered.
  excused boolean NOT NULL DEFAULT false,
  exception_id uuid,
  subject jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(subject) = 'object'),
  params jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(params) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES machvon.payment_integrity_run (tenant_id, id),
  FOREIGN KEY (tenant_id, payment_request_id) REFERENCES machvon.payment_request (tenant_id, id),
  CONSTRAINT payment_integrity_finding_kind_chk CHECK ((kind = 'INVARIANT') = (severity = 'BLOCK')),
  CONSTRAINT payment_integrity_finding_excused_chk CHECK (NOT excused OR (kind = 'INVARIANT' AND exception_id IS NOT NULL))
);

CREATE INDEX payment_integrity_finding_run_idx ON machvon.payment_integrity_finding (tenant_id, run_id, created_at, id);
CREATE INDEX payment_integrity_finding_list_idx ON machvon.payment_integrity_finding (tenant_id, created_at DESC, id);
CREATE INDEX payment_integrity_finding_code_idx ON machvon.payment_integrity_finding (tenant_id, code, created_at DESC);
CREATE INDEX payment_integrity_finding_request_idx ON machvon.payment_integrity_finding (tenant_id, payment_request_id);

ALTER TABLE machvon.payment_integrity_run ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.payment_integrity_run FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.payment_integrity_run AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.payment_integrity_run AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE machvon.payment_integrity_finding ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.payment_integrity_finding FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.payment_integrity_finding AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.payment_integrity_finding AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- Append-only for the application: a run and its findings are added, never edited or removed (what stopped the money stays for the auditor).
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.payment_integrity_run FROM machvon_app;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.payment_integrity_finding FROM machvon_app;

-- The same holds for whoever else holds the right to write to the tables (as for the ledger entries of V1562).
CREATE FUNCTION machvon.guard_payment_integrity_append_only() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'a payment integrity run and its findings are kept as they were written' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER payment_integrity_run_append_only BEFORE UPDATE OR DELETE ON machvon.payment_integrity_run
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_payment_integrity_append_only();
CREATE TRIGGER payment_integrity_finding_append_only BEFORE UPDATE OR DELETE ON machvon.payment_integrity_finding
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_payment_integrity_append_only();

COMMENT ON TABLE machvon.payment_integrity_run IS 'One evaluation of a payment request against the rule PAYMENT_INTEGRITY (G4-2); append-only, read by the approver and the auditor.';
COMMENT ON TABLE machvon.payment_integrity_finding IS 'What a run found: invariants block, signals warn; append-only.';
