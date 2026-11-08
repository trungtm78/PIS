-- Authored by hand (not generated): the complaint of a unit about a figure of the ranking (G3-8 of docs/governance-roadmap-10of10.md, GOV-11b).
-- One row per complaint: FILED by a person of the unit, UNDER_REVIEW once somebody takes it up, then UPHELD, REJECTED or CORRECTED with the answer in words by a person who did not file it. Until it is answered the
-- ranking marks the figure as disputed. Only the move of the status with who answered, when and what is written changes; no complaint is deleted; every move has an audit row and an event from the command.
-- The response time is the rule `RANKING_MODEL` of `machvon.governance_rule` (complaint_response_days); `due_on` keeps the day it gave when the complaint was filed.

CREATE TABLE machvon.ranking_complaint (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  unit_id uuid NOT NULL,
  metric_code text NOT NULL CHECK (metric_code ~ '^[A-Z][A-Z0-9_]{1,39}$'),
  -- The day of the snapshot the figure was on, and the snapshot when the unit named one.
  as_of_date date NOT NULL,
  snapshot_id uuid,
  claim text NOT NULL CHECK (claim = btrim(claim) AND char_length(claim) BETWEEN 10 AND 2000),
  claimed_value numeric(22, 4),
  status text NOT NULL DEFAULT 'FILED' CHECK (status IN ('FILED', 'UNDER_REVIEW', 'UPHELD', 'REJECTED', 'CORRECTED')),
  filed_by uuid NOT NULL,
  filed_at timestamptz NOT NULL DEFAULT now(),
  due_on date NOT NULL,
  reviewer_id uuid,
  review_started_at timestamptz,
  resolved_by uuid,
  resolved_at timestamptz,
  resolution text CHECK (resolution IS NULL OR (resolution = btrim(resolution) AND char_length(resolution) BETWEEN 10 AND 2000)),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, unit_id) REFERENCES machvon.organization_unit (tenant_id, id),
  FOREIGN KEY (tenant_id, snapshot_id) REFERENCES machvon.period_snapshot (tenant_id, id),
  FOREIGN KEY (tenant_id, filed_by) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, reviewer_id) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, resolved_by) REFERENCES machvon.membership (tenant_id, id),
  CONSTRAINT ranking_complaint_review_chk CHECK ((reviewer_id IS NULL) = (review_started_at IS NULL)),
  CONSTRAINT ranking_complaint_answer_chk CHECK ((status IN ('UPHELD', 'REJECTED', 'CORRECTED')) = (resolved_by IS NOT NULL AND resolved_at IS NOT NULL AND resolution IS NOT NULL)),
  CONSTRAINT ranking_complaint_sod_chk CHECK (resolved_by IS NULL OR resolved_by <> filed_by),
  CONSTRAINT ranking_complaint_open_chk CHECK (status <> 'FILED' OR reviewer_id IS NULL)
);

CREATE INDEX ranking_complaint_unit_idx ON machvon.ranking_complaint (tenant_id, unit_id, status, filed_at DESC);
CREATE INDEX ranking_complaint_status_idx ON machvon.ranking_complaint (tenant_id, status, due_on, id);
CREATE INDEX ranking_complaint_snapshot_idx ON machvon.ranking_complaint (tenant_id, snapshot_id) WHERE snapshot_id IS NOT NULL;
CREATE INDEX ranking_complaint_filed_by_idx ON machvon.ranking_complaint (tenant_id, filed_by);
CREATE INDEX ranking_complaint_reviewer_idx ON machvon.ranking_complaint (tenant_id, reviewer_id) WHERE reviewer_id IS NOT NULL;
CREATE INDEX ranking_complaint_resolved_by_idx ON machvon.ranking_complaint (tenant_id, resolved_by) WHERE resolved_by IS NOT NULL;

CREATE FUNCTION machvon.ranking_complaint_guard() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a ranking complaint is kept' USING ERRCODE = '23514', CONSTRAINT = 'ranking_complaint_guard';
  END IF;
  IF NEW.unit_id <> OLD.unit_id OR NEW.metric_code <> OLD.metric_code OR NEW.as_of_date <> OLD.as_of_date OR NEW.snapshot_id IS DISTINCT FROM OLD.snapshot_id OR NEW.claim <> OLD.claim
     OR NEW.claimed_value IS DISTINCT FROM OLD.claimed_value OR NEW.filed_by <> OLD.filed_by OR NEW.filed_at <> OLD.filed_at OR NEW.due_on <> OLD.due_on THEN
    RAISE EXCEPTION 'what a ranking complaint says does not change' USING ERRCODE = '23514', CONSTRAINT = 'ranking_complaint_identity_guard';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'FILED' AND NEW.status IN ('UNDER_REVIEW', 'UPHELD', 'REJECTED', 'CORRECTED'))
    OR (OLD.status = 'UNDER_REVIEW' AND NEW.status IN ('UPHELD', 'REJECTED', 'CORRECTED'))
  ) THEN
    RAISE EXCEPTION 'a ranking complaint does not move from % to %', OLD.status, NEW.status USING ERRCODE = '23514', CONSTRAINT = 'ranking_complaint_transition_guard';
  END IF;
  IF OLD.status IN ('UPHELD', 'REJECTED', 'CORRECTED') AND (NEW.resolved_by IS DISTINCT FROM OLD.resolved_by OR NEW.resolved_at IS DISTINCT FROM OLD.resolved_at OR NEW.resolution IS DISTINCT FROM OLD.resolution) THEN
    RAISE EXCEPTION 'the answer to a ranking complaint is not rewritten' USING ERRCODE = '23514', CONSTRAINT = 'ranking_complaint_answer_guard';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER ranking_complaint_guard BEFORE UPDATE OR DELETE ON machvon.ranking_complaint FOR EACH ROW EXECUTE FUNCTION machvon.ranking_complaint_guard();

ALTER TABLE machvon.ranking_complaint ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.ranking_complaint FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.ranking_complaint AS RESTRICTIVE FOR ALL USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.ranking_complaint AS PERMISSIVE FOR ALL USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
REVOKE DELETE, TRUNCATE ON TABLE machvon.ranking_complaint FROM machvon_app;

COMMENT ON TABLE machvon.ranking_complaint IS 'A complaint of a unit about a figure of the ranking; the figure is marked as disputed until it is answered by a person who did not file it; only the status and the answer move.';
