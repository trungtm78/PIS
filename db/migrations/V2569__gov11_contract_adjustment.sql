-- Authored by hand (not generated): the adjustment version of a contract and its impact on the baseline of the project (GOV-11a, G1-18, CTR 3.3, PRJ baseline).
-- When a revision of a contract takes effect (a change order, a retroactive adjustment) the contract has a new version. `contract_adjustment` is the evidence of what that version did: the value of the original
-- contract, of the version before and of the new one, the change and its shares (of the previous value, of the original, of the baseline cost of the project), and whether the baseline has to be looked at again
-- (rule `CONTRACT_BASELINE_IMPACT`). A version that has to be looked at waits for a review by a person other than who made the change; the review keeps the baseline or asks for a new one.
--   * one row for a revision: the takeover is idempotent for the same revision;
--   * what the version did never changes; only the review moves, once, from PENDING to DECIDED, with the reviewer, the decision and the words;
--   * a review by the person who made the change is refused by the database;
--   * the rows are kept for good: the runtime role cannot delete or truncate them.

CREATE TABLE machvon.contract_adjustment (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  contract_id uuid NOT NULL,
  project_id uuid NOT NULL,
  owner_unit_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  revision integer NOT NULL,
  change_request_id uuid,
  original_vnd numeric(24, 0) NOT NULL,
  previous_vnd numeric(24, 0) NOT NULL,
  new_vnd numeric(24, 0) NOT NULL,
  delta_vnd numeric(24, 0) NOT NULL,
  delta_pct_of_previous numeric(12, 2),
  cumulative_delta_vnd numeric(24, 0) NOT NULL,
  cumulative_pct_of_original numeric(12, 2),
  baseline_id uuid,
  baseline_version integer,
  baseline_bac_vnd numeric(24, 0),
  share_of_baseline_pct numeric(12, 2),
  classification text NOT NULL,
  reasons text[] NOT NULL DEFAULT '{}',
  policy_version integer NOT NULL DEFAULT 0,
  made_by uuid NOT NULL,
  review_status text NOT NULL,
  review_decision text,
  reviewed_by uuid,
  reviewed_at timestamptz,
  review_note text,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, contract_id) REFERENCES machvon.contract (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES machvon.project (tenant_id, id),
  FOREIGN KEY (tenant_id, revision_id) REFERENCES machvon.contract_revision (tenant_id, id),
  CONSTRAINT contract_adjustment_revision_uq UNIQUE (tenant_id, revision_id),
  CONSTRAINT contract_adjustment_class_chk CHECK (classification IN ('NONE', 'WITHIN_TOLERANCE', 'REVIEW_REQUIRED', 'NO_BASELINE')),
  CONSTRAINT contract_adjustment_review_chk CHECK (
    review_status IN ('NOT_NEEDED', 'PENDING', 'DECIDED')
    AND ((classification IN ('REVIEW_REQUIRED', 'NO_BASELINE')) = (review_status IN ('PENDING', 'DECIDED')))
    AND ((review_status = 'DECIDED') = (review_decision IS NOT NULL AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL))
    AND (review_decision IS NULL OR review_decision IN ('KEEP_BASELINE', 'REBASELINE'))
    AND (reviewed_by IS NULL OR reviewed_by <> made_by)
  ),
  CONSTRAINT contract_adjustment_amounts_chk CHECK (original_vnd >= 0 AND previous_vnd >= 0 AND new_vnd >= 0 AND delta_vnd = new_vnd - previous_vnd AND cumulative_delta_vnd = new_vnd - original_vnd),
  CONSTRAINT contract_adjustment_version_chk CHECK (version >= 1 AND revision >= 2 AND policy_version >= 0)
);

CREATE INDEX contract_adjustment_contract_idx ON machvon.contract_adjustment (tenant_id, contract_id, revision DESC);
CREATE INDEX contract_adjustment_project_idx ON machvon.contract_adjustment (tenant_id, project_id, created_at DESC, id DESC);
CREATE INDEX contract_adjustment_unit_idx ON machvon.contract_adjustment (tenant_id, owner_unit_id, created_at DESC, id DESC);
CREATE INDEX contract_adjustment_change_idx ON machvon.contract_adjustment (tenant_id, change_request_id);
CREATE INDEX contract_adjustment_baseline_idx ON machvon.contract_adjustment (tenant_id, baseline_id);
CREATE INDEX contract_adjustment_pending_idx ON machvon.contract_adjustment (tenant_id, created_at, id) WHERE review_status = 'PENDING';

CREATE FUNCTION machvon.guard_contract_adjustment() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'an adjustment version is kept' USING ERRCODE = '23514', CONSTRAINT = 'contract_adjustment_guard';
  END IF;
  IF (NEW.tenant_id, NEW.id, NEW.contract_id, NEW.project_id, NEW.owner_unit_id, NEW.revision_id, NEW.revision, NEW.change_request_id, NEW.original_vnd, NEW.previous_vnd, NEW.new_vnd, NEW.delta_vnd,
      NEW.cumulative_delta_vnd, NEW.baseline_id, NEW.baseline_bac_vnd, NEW.classification, NEW.reasons, NEW.policy_version, NEW.made_by, NEW.created_at)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.id, OLD.contract_id, OLD.project_id, OLD.owner_unit_id, OLD.revision_id, OLD.revision, OLD.change_request_id, OLD.original_vnd, OLD.previous_vnd, OLD.new_vnd, OLD.delta_vnd,
      OLD.cumulative_delta_vnd, OLD.baseline_id, OLD.baseline_bac_vnd, OLD.classification, OLD.reasons, OLD.policy_version, OLD.made_by, OLD.created_at) THEN
    RAISE EXCEPTION 'what an adjustment version did does not change' USING ERRCODE = '23514', CONSTRAINT = 'contract_adjustment_identity_guard';
  END IF;
  IF OLD.review_status = 'DECIDED' THEN
    RAISE EXCEPTION 'a review of an adjustment version is final' USING ERRCODE = '23514', CONSTRAINT = 'contract_adjustment_review_final_guard';
  END IF;
  IF OLD.review_status <> 'PENDING' AND NEW.review_status <> OLD.review_status THEN
    RAISE EXCEPTION 'a version that needs no review is not reviewed' USING ERRCODE = '23514', CONSTRAINT = 'contract_adjustment_review_guard';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER contract_adjustment_guard BEFORE UPDATE OR DELETE ON machvon.contract_adjustment FOR EACH ROW EXECUTE FUNCTION machvon.guard_contract_adjustment();

ALTER TABLE machvon.contract_adjustment ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.contract_adjustment FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.contract_adjustment AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.contract_adjustment AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE DELETE, TRUNCATE ON TABLE machvon.contract_adjustment FROM machvon_app;

COMMENT ON TABLE machvon.contract_adjustment IS 'GOV-11a G1-18: the evidence of what a new version of a contract did to its value and to the baseline of the project; a version that needs a review waits for a person other than its maker.';
