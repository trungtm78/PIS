-- ST-DIS-012: the early-warning rules (versioned data, published by someone other than the author) and the warnings they open (one open warning for a dedupe key, handled with a reason) (DIS 3 F7, BR-DIS-13).
--
-- V002 gave the two tables their columns, the four-eyes check on a rule, the unique index of the open warning and the reason a closed warning must have. This migration makes the database say what the commands rely on:
--   * a rule is a draft until someone else publishes it (a published rule has the one who approved it, a draft has none); one revision of a code is published at a time, and a rule keeps what it says for good: a
--     change is a new revision, the old one is retired; none is deleted;
--   * a warning keeps what opened it (rule, subject, period, key); while it is open the figure it is made of, its severity and the snapshot it was seen in follow the latest snapshot; it moves from OPEN to
--     ACKNOWLEDGED to EXPLANATION_REQUESTED or closes (RESOLVED, DISMISSED), a closed warning is final, and none is deleted;
--   * who acknowledged a warning, with what note, and who closed it are kept on the warning.

ALTER TABLE machvon.early_warning
  ADD COLUMN acknowledged_by uuid,
  ADD COLUMN acknowledged_at timestamptz,
  ADD COLUMN acknowledgement_note text,
  ADD COLUMN closed_by uuid;

ALTER TABLE machvon.early_warning_rule
  ADD CONSTRAINT early_warning_rule_code_chk CHECK (rule_code ~ '^[A-Z][A-Z0-9-]{0,29}$'),
  ADD CONSTRAINT early_warning_rule_effective_chk CHECK (effective_until IS NULL OR effective_until >= effective_from),
  ADD CONSTRAINT early_warning_rule_approved_chk CHECK ((status <> 'DRAFT' OR approved_by IS NULL) AND (status <> 'PUBLISHED' OR approved_by IS NOT NULL)),
  ADD CONSTRAINT early_warning_rule_legal_chk CHECK (char_length(legal_basis) >= 3);

CREATE UNIQUE INDEX early_warning_rule_published_uq ON machvon.early_warning_rule (tenant_id, rule_code) WHERE status = 'PUBLISHED';
CREATE INDEX early_warning_rule_list_idx ON machvon.early_warning_rule (tenant_id, rule_code, revision DESC);

ALTER TABLE machvon.early_warning
  ADD CONSTRAINT early_warning_explanation_chk CHECK (status <> 'EXPLANATION_REQUESTED' OR explanation_request_id IS NOT NULL),
  ADD CONSTRAINT early_warning_ack_chk CHECK ((acknowledged_by IS NULL) = (acknowledged_at IS NULL)),
  ADD CONSTRAINT early_warning_closed_by_chk CHECK (closed_by IS NULL OR status IN ('RESOLVED', 'DISMISSED')),
  ADD CONSTRAINT early_warning_key_chk CHECK (char_length(dedupe_key) BETWEEN 5 AND 400);

CREATE INDEX early_warning_open_list_idx ON machvon.early_warning (tenant_id, opened_at DESC, id DESC);
CREATE INDEX early_warning_status_idx ON machvon.early_warning (tenant_id, status, severity);

CREATE FUNCTION machvon.early_warning_rule_guard() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'an early-warning rule is kept: a change is a new revision' USING ERRCODE = '23514', CONSTRAINT = 'early_warning_rule_guard';
  END IF;
  IF NEW.rule_code <> OLD.rule_code OR NEW.revision <> OLD.revision OR NEW.name <> OLD.name OR NEW.metric_code <> OLD.metric_code OR NEW.comparator <> OLD.comparator
     OR NEW.threshold_json <> OLD.threshold_json OR NEW.severity <> OLD.severity OR NEW.scope_kind <> OLD.scope_kind OR NEW.auto_explanation <> OLD.auto_explanation
     OR NEW.legal_basis <> OLD.legal_basis OR NEW.effective_from <> OLD.effective_from OR NEW.effective_until IS DISTINCT FROM OLD.effective_until OR NEW.created_by <> OLD.created_by THEN
    RAISE EXCEPTION 'what an early-warning rule says does not change: a change is a new revision' USING ERRCODE = '23514', CONSTRAINT = 'early_warning_rule_content_guard';
  END IF;
  IF OLD.status IN ('PUBLISHED', 'RETIRED') AND NEW.approved_by IS DISTINCT FROM OLD.approved_by THEN
    RAISE EXCEPTION 'who approved a rule does not change' USING ERRCODE = '23514', CONSTRAINT = 'early_warning_rule_approval_guard';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'DRAFT' AND NEW.status IN ('PUBLISHED', 'RETIRED'))
    OR (OLD.status = 'PUBLISHED' AND NEW.status = 'RETIRED')
  ) THEN
    RAISE EXCEPTION 'a rule does not move from % to %', OLD.status, NEW.status USING ERRCODE = '23514', CONSTRAINT = 'early_warning_rule_transition_guard';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER early_warning_rule_guard BEFORE UPDATE OR DELETE ON machvon.early_warning_rule FOR EACH ROW EXECUTE FUNCTION machvon.early_warning_rule_guard();

CREATE FUNCTION machvon.early_warning_guard() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a warning is kept' USING ERRCODE = '23514', CONSTRAINT = 'early_warning_guard';
  END IF;
  IF OLD.status IN ('RESOLVED', 'DISMISSED') THEN
    RAISE EXCEPTION 'a warning that was closed is not changed' USING ERRCODE = '23514', CONSTRAINT = 'early_warning_closed_guard';
  END IF;
  IF NEW.rule_id <> OLD.rule_id OR NEW.dedupe_key <> OLD.dedupe_key OR NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.unit_id IS DISTINCT FROM OLD.unit_id
     OR NEW.period_id <> OLD.period_id OR NEW.opened_at <> OLD.opened_at OR NEW.created_by <> OLD.created_by THEN
    RAISE EXCEPTION 'what opened a warning does not change' USING ERRCODE = '23514', CONSTRAINT = 'early_warning_identity_guard';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'OPEN' AND NEW.status IN ('ACKNOWLEDGED', 'DISMISSED', 'RESOLVED'))
    OR (OLD.status = 'ACKNOWLEDGED' AND NEW.status IN ('EXPLANATION_REQUESTED', 'DISMISSED', 'RESOLVED'))
    OR (OLD.status = 'EXPLANATION_REQUESTED' AND NEW.status = 'RESOLVED')
  ) THEN
    RAISE EXCEPTION 'a warning does not move from % to %', OLD.status, NEW.status USING ERRCODE = '23514', CONSTRAINT = 'early_warning_transition_guard';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER early_warning_guard BEFORE UPDATE OR DELETE ON machvon.early_warning FOR EACH ROW EXECUTE FUNCTION machvon.early_warning_guard();
