-- Authored by hand (not generated): the tier of a change order and the check of the project adjustment that a large cumulative variation forces (governance deepening, lane B2, G1-8).
-- The tier (1, 2 or 3) is worked out from the thresholds of the policy of the day and is kept on the request with the cumulative variation against the original price and the version of the rule that
-- gave them. When the cumulative variation reaches the threshold of the policy a check of the project adjustment is required before the change order may be approved: it is cleared by a person who had no
-- part in the chain, on a document, and the audit is told when it is required. Additive only (expand step): no existing column changes.

ALTER TABLE machvon.change_request
  ADD COLUMN tier smallint CHECK (tier IS NULL OR tier BETWEEN 1 AND 3),
  ADD COLUMN cumulative_variation_pct numeric(9,2),
  ADD COLUMN tier_rule_version integer,
  ADD COLUMN tier_rule_source text CHECK (tier_rule_source IS NULL OR tier_rule_source IN ('DEFAULT', 'RULE')),
  ADD COLUMN classified_at timestamptz;

CREATE TABLE machvon.change_adjustment_check (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  change_request_id uuid NOT NULL,
  project_id uuid NOT NULL,
  contract_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'REQUIRED' CHECK (status IN ('REQUIRED', 'CLEARED')),
  -- What the cumulative variation was when the check was required or cleared, and the threshold it met.
  cumulative_pct numeric(9,2) NOT NULL,
  threshold_pct numeric(5,2) NOT NULL,
  basis text CHECK (basis IS NULL OR (basis = btrim(basis) AND char_length(basis) BETWEEN 1 AND 2000)),
  decision_document_version_id uuid,
  required_at timestamptz NOT NULL DEFAULT now(),
  required_by uuid NOT NULL,
  cleared_by uuid,
  cleared_at timestamptz,
  audit_notified_at timestamptz,
  version bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT change_adjustment_check_request_uq UNIQUE (tenant_id, change_request_id),
  FOREIGN KEY (tenant_id, change_request_id) REFERENCES machvon.change_request (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES machvon.project (tenant_id, id),
  FOREIGN KEY (tenant_id, contract_id) REFERENCES machvon.contract (tenant_id, id),
  FOREIGN KEY (tenant_id, required_by) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, cleared_by) REFERENCES machvon.membership (tenant_id, id),
  CONSTRAINT change_adjustment_check_cleared_chk CHECK (
    (status = 'REQUIRED' AND cleared_by IS NULL AND cleared_at IS NULL)
    OR (status = 'CLEARED' AND cleared_by IS NOT NULL AND cleared_at IS NOT NULL AND basis IS NOT NULL AND decision_document_version_id IS NOT NULL)
  )
);

CREATE INDEX change_adjustment_check_project_idx ON machvon.change_adjustment_check (tenant_id, project_id, status);

REVOKE DELETE, TRUNCATE ON TABLE machvon.change_adjustment_check FROM machvon_app;

ALTER TABLE machvon.change_adjustment_check ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.change_adjustment_check FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.change_adjustment_check AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.change_adjustment_check AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

COMMENT ON TABLE machvon.change_adjustment_check IS 'The check of the project adjustment that a cumulative variation of a contract above the threshold forces before a change order may be approved.';
