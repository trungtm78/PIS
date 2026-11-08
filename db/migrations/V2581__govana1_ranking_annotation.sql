-- Authored by hand (not generated): the note "this unit is held back by something outside its control" on the ranking of the units (G3-8 of docs/governance-roadmap-10of10.md, GOV-11b).
-- One row per note. A note is PROPOSED by one person and APPROVED or REJECTED by a different one (maker is not checker, enforced here as well as by the command); an approved note may be WITHDRAWN. Nothing else about
-- a note changes after it is written, and no note is deleted: the guard below allows only the move of the status with who decided, when and why, and every move has an audit row and an event from the command.
-- The closed list of reasons, the longest period and whether an approved note takes the measure out of the composite are the rule `RANKING_MODEL` of `machvon.governance_rule`, never columns here.

CREATE TABLE machvon.ranking_annotation (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  unit_id uuid NOT NULL,
  reason_code text NOT NULL CHECK (reason_code ~ '^[A-Z][A-Z0-9_]{1,39}$'),
  metric_codes text[] NOT NULL CHECK (cardinality(metric_codes) BETWEEN 1 AND 5),
  evidence text NOT NULL CHECK (evidence = btrim(evidence) AND char_length(evidence) BETWEEN 10 AND 1000),
  valid_from date NOT NULL,
  valid_to date NOT NULL,
  status text NOT NULL DEFAULT 'PROPOSED' CHECK (status IN ('PROPOSED', 'APPROVED', 'REJECTED', 'WITHDRAWN')),
  proposed_by uuid NOT NULL,
  proposed_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid,
  decided_at timestamptz,
  decision_note text CHECK (decision_note IS NULL OR (decision_note = btrim(decision_note) AND char_length(decision_note) BETWEEN 5 AND 1000)),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, unit_id) REFERENCES machvon.organization_unit (tenant_id, id),
  FOREIGN KEY (tenant_id, proposed_by) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, decided_by) REFERENCES machvon.membership (tenant_id, id),
  CONSTRAINT ranking_annotation_period_chk CHECK (valid_to >= valid_from),
  CONSTRAINT ranking_annotation_decided_chk CHECK ((status = 'PROPOSED') = (decided_by IS NULL AND decided_at IS NULL AND decision_note IS NULL)),
  CONSTRAINT ranking_annotation_sod_chk CHECK (status NOT IN ('APPROVED', 'REJECTED') OR decided_by <> proposed_by)
);

CREATE INDEX ranking_annotation_unit_idx ON machvon.ranking_annotation (tenant_id, unit_id, status, valid_to DESC);
CREATE INDEX ranking_annotation_status_idx ON machvon.ranking_annotation (tenant_id, status, proposed_at DESC, id);
CREATE INDEX ranking_annotation_proposed_by_idx ON machvon.ranking_annotation (tenant_id, proposed_by);
CREATE INDEX ranking_annotation_decided_by_idx ON machvon.ranking_annotation (tenant_id, decided_by) WHERE decided_by IS NOT NULL;

CREATE FUNCTION machvon.ranking_annotation_guard() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a ranking annotation is kept' USING ERRCODE = '23514', CONSTRAINT = 'ranking_annotation_guard';
  END IF;
  IF NEW.unit_id <> OLD.unit_id OR NEW.reason_code <> OLD.reason_code OR NEW.metric_codes <> OLD.metric_codes OR NEW.evidence <> OLD.evidence OR NEW.valid_from <> OLD.valid_from OR NEW.valid_to <> OLD.valid_to
     OR NEW.proposed_by <> OLD.proposed_by OR NEW.proposed_at <> OLD.proposed_at THEN
    RAISE EXCEPTION 'what a ranking annotation says does not change' USING ERRCODE = '23514', CONSTRAINT = 'ranking_annotation_identity_guard';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'PROPOSED' AND NEW.status IN ('APPROVED', 'REJECTED', 'WITHDRAWN'))
    OR (OLD.status = 'APPROVED' AND NEW.status = 'WITHDRAWN')
  ) THEN
    RAISE EXCEPTION 'a ranking annotation does not move from % to %', OLD.status, NEW.status USING ERRCODE = '23514', CONSTRAINT = 'ranking_annotation_transition_guard';
  END IF;
  IF NEW.status = OLD.status AND (NEW.decided_by IS DISTINCT FROM OLD.decided_by OR NEW.decided_at IS DISTINCT FROM OLD.decided_at OR NEW.decision_note IS DISTINCT FROM OLD.decision_note) THEN
    RAISE EXCEPTION 'a decision on a ranking annotation is not rewritten' USING ERRCODE = '23514', CONSTRAINT = 'ranking_annotation_decision_guard';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER ranking_annotation_guard BEFORE UPDATE OR DELETE ON machvon.ranking_annotation FOR EACH ROW EXECUTE FUNCTION machvon.ranking_annotation_guard();

ALTER TABLE machvon.ranking_annotation ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.ranking_annotation FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.ranking_annotation AS RESTRICTIVE FOR ALL USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.ranking_annotation AS PERMISSIVE FOR ALL USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
REVOKE DELETE, TRUNCATE ON TABLE machvon.ranking_annotation FROM machvon_app;

COMMENT ON TABLE machvon.ranking_annotation IS 'A note on the ranking: this unit is held back by something outside its control; proposed by one person, approved or rejected by another; only the status moves.';
