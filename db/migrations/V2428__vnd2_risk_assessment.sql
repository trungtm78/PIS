-- Authored by hand (not generated): the risk grade of a contractor (VND-2, research V13; docs/vendor-controls-risk-performance.md).
--   * `vendor_risk_assessment`: a snapshot of the grade with its explanation (the points of every factor and the reading they came from), the rule version that decided, and the inputs it was computed from. A snapshot is
--     PROPOSED by one person and CONFIRMED or REJECTED by a decision; a grade that needs a dual check (the rule says from which tier) is confirmed by a person other than the one who assessed it (CHECK). The facts of
--     a snapshot never change; a confirmed snapshot is SUPERSEDED when a newer one is confirmed. At most one snapshot is waiting and at most one is confirmed for a contractor.
--   * `contractor` gains the grade in force (`risk_tier`, `risk_next_review_on`, `risk_assessment_id`), written only by a confirmation; it is separate from the review day of the profile (`next_review_due` of VND-1).
-- The grade never decides whether a contractor may bid (that stays with the gate and the people): it decides how deep the checking goes.

CREATE TABLE machvon.vendor_risk_assessment (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  contractor_id uuid NOT NULL,
  score integer NOT NULL CHECK (score BETWEEN 0 AND 10000),
  tier text NOT NULL CHECK (tier IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
  score_tier text NOT NULL CHECK (score_tier IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
  floored boolean NOT NULL,
  factors jsonb NOT NULL CHECK (jsonb_typeof(factors) = 'array'),
  reasons text[] NOT NULL,
  inputs jsonb NOT NULL CHECK (jsonb_typeof(inputs) = 'object'),
  rule_version text NOT NULL CHECK (rule_version = btrim(rule_version) AND char_length(rule_version) BETWEEN 1 AND 100),
  rule_unverified boolean NOT NULL,
  review_months integer NOT NULL CHECK (review_months BETWEEN 1 AND 120),
  next_review_on date NOT NULL,
  dual_check boolean NOT NULL,
  as_of date NOT NULL,
  state text NOT NULL DEFAULT 'PROPOSED' CHECK (state IN ('PROPOSED', 'CONFIRMED', 'SUPERSEDED', 'REJECTED')),
  assessed_by uuid NOT NULL,
  assessed_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid,
  decided_at timestamptz,
  decision_reason text CHECK (decision_reason IS NULL OR (decision_reason = btrim(decision_reason) AND char_length(decision_reason) BETWEEN 1 AND 2000)),
  superseded_by_id uuid,
  version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, contractor_id) REFERENCES machvon.contractor (tenant_id, id),
  FOREIGN KEY (tenant_id, superseded_by_id) REFERENCES machvon.vendor_risk_assessment (tenant_id, id),
  CONSTRAINT vendor_risk_decided_chk CHECK ((decided_by IS NULL) = (decided_at IS NULL) AND ((state = 'PROPOSED') = (decided_by IS NULL))),
  CONSTRAINT vendor_risk_reject_reason_chk CHECK (state <> 'REJECTED' OR (decision_reason IS NOT NULL AND char_length(decision_reason) >= 20)),
  CONSTRAINT vendor_risk_dual_chk CHECK (NOT dual_check OR decided_by IS NULL OR decided_by <> assessed_by OR state = 'REJECTED'),
  CONSTRAINT vendor_risk_superseded_chk CHECK ((state = 'SUPERSEDED') = (superseded_by_id IS NOT NULL))
);
CREATE UNIQUE INDEX vendor_risk_pending_uq ON machvon.vendor_risk_assessment (tenant_id, contractor_id) WHERE state = 'PROPOSED';
CREATE UNIQUE INDEX vendor_risk_confirmed_uq ON machvon.vendor_risk_assessment (tenant_id, contractor_id) WHERE state = 'CONFIRMED';
CREATE INDEX vendor_risk_contractor_idx ON machvon.vendor_risk_assessment (tenant_id, contractor_id, assessed_at DESC, id);
CREATE INDEX vendor_risk_superseded_idx ON machvon.vendor_risk_assessment (tenant_id, superseded_by_id) WHERE superseded_by_id IS NOT NULL;
CREATE INDEX vendor_risk_state_idx ON machvon.vendor_risk_assessment (tenant_id, state, tier, next_review_on);
CREATE INDEX vendor_risk_assessed_by_idx ON machvon.vendor_risk_assessment (tenant_id, assessed_by, assessed_at DESC);
CREATE INDEX vendor_risk_decided_by_idx ON machvon.vendor_risk_assessment (tenant_id, decided_by, decided_at DESC) WHERE decided_by IS NOT NULL;

-- The facts of a snapshot never change; it moves PROPOSED to CONFIRMED or REJECTED once, and CONFIRMED to SUPERSEDED once; it is never deleted.
CREATE FUNCTION machvon.guard_vendor_risk_assessment() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a risk assessment is never deleted' USING ERRCODE = '23514';
  END IF;
  IF (NEW.contractor_id, NEW.score, NEW.tier, NEW.score_tier, NEW.floored, NEW.factors, NEW.reasons, NEW.inputs, NEW.rule_version, NEW.rule_unverified, NEW.review_months, NEW.next_review_on, NEW.dual_check, NEW.as_of, NEW.assessed_by, NEW.assessed_at, NEW.created_by)
     IS DISTINCT FROM
     (OLD.contractor_id, OLD.score, OLD.tier, OLD.score_tier, OLD.floored, OLD.factors, OLD.reasons, OLD.inputs, OLD.rule_version, OLD.rule_unverified, OLD.review_months, OLD.next_review_on, OLD.dual_check, OLD.as_of, OLD.assessed_by, OLD.assessed_at, OLD.created_by) THEN
    RAISE EXCEPTION 'a risk assessment keeps its figures and its rule: a new reading is a new assessment' USING ERRCODE = '23514';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state AND (OLD.state, NEW.state) NOT IN (('PROPOSED', 'CONFIRMED'), ('PROPOSED', 'REJECTED'), ('CONFIRMED', 'SUPERSEDED')) THEN
    RAISE EXCEPTION 'a risk assessment does not move from % to %', OLD.state, NEW.state USING ERRCODE = '23514';
  END IF;
  IF OLD.decided_by IS NOT NULL AND (NEW.decided_by IS DISTINCT FROM OLD.decided_by OR NEW.decided_at IS DISTINCT FROM OLD.decided_at OR NEW.decision_reason IS DISTINCT FROM OLD.decision_reason) THEN
    RAISE EXCEPTION 'a decision on a risk assessment stays as it was made' USING ERRCODE = '23514';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'a change of a risk assessment raises its version by one' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;
CREATE TRIGGER vendor_risk_assessment_guard BEFORE UPDATE OR DELETE ON machvon.vendor_risk_assessment FOR EACH ROW EXECUTE FUNCTION machvon.guard_vendor_risk_assessment();

ALTER TABLE machvon.vendor_risk_assessment ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.vendor_risk_assessment FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.vendor_risk_assessment AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.vendor_risk_assessment AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
REVOKE DELETE, TRUNCATE ON TABLE machvon.vendor_risk_assessment FROM machvon_app;

ALTER TABLE machvon.contractor
  ADD COLUMN risk_tier text,
  ADD COLUMN risk_next_review_on date,
  ADD COLUMN risk_assessment_id uuid,
  ADD CONSTRAINT contractor_risk_tier_chk CHECK (risk_tier IS NULL OR risk_tier IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
  ADD CONSTRAINT contractor_risk_consistent_chk CHECK ((risk_tier IS NULL) = (risk_assessment_id IS NULL) AND (risk_tier IS NULL) = (risk_next_review_on IS NULL)),
  ADD CONSTRAINT contractor_risk_assessment_fk FOREIGN KEY (tenant_id, risk_assessment_id) REFERENCES machvon.vendor_risk_assessment (tenant_id, id);
CREATE INDEX contractor_risk_tier_idx ON machvon.contractor (tenant_id, risk_tier, risk_next_review_on) WHERE risk_tier IS NOT NULL;
CREATE INDEX contractor_risk_assessment_idx ON machvon.contractor (tenant_id, risk_assessment_id) WHERE risk_assessment_id IS NOT NULL;

COMMENT ON TABLE machvon.vendor_risk_assessment IS 'VND-2: a snapshot of the risk grade of a contractor with the points of each factor, the rule version, and a decision (a high grade is confirmed by a second person).';
COMMENT ON COLUMN machvon.contractor.risk_tier IS 'VND-2: the confirmed risk grade in force; written only by a confirmation of a risk assessment.';
