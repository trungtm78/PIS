-- Authored by hand (not generated): the permit gate rules as dated legal data (ST-PMT-004, BR-PMT-03).
-- A gate rule says which permit a gate of the project asks for, under which legal basis and from which day: the gates are evaluated by the commands
-- of CTR, QMS, PRJ, AST and PAY in their own transactions, and the answer of a past day must be explainable, so a rule is kept for good and never
-- edited. A change of the regulation is a new revision for the same gate and the same permit type that takes over from a date. V1180 did this for the
-- permit types; the same three guarantees hold here whatever the application checked first:
--   * a rule has a legal basis (not blank), an applicability condition that is an object, and an end that is after its beginning;
--   * no two rules of one gate and one permit type CODE apply on the same day (the rule names a version of the type, but the requirement is about
--     the type: a permit written under a later version of the type satisfies it);
--   * a published rule never changes its content except that it may be ended, once and never later than before.

-- The code of the permit type, copied from the version the rule names when the rule is written (the same trigger idea as the permit).
ALTER TABLE machvon.permit_gate_rule ADD COLUMN permit_type_code text;

CREATE FUNCTION machvon.fill_permit_gate_rule_type_code() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  SELECT t.code INTO NEW.permit_type_code
    FROM machvon.permit_type t
   WHERE t.tenant_id = NEW.tenant_id AND t.id = NEW.permit_type_id;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER permit_gate_rule_type_code_fill BEFORE INSERT ON machvon.permit_gate_rule
  FOR EACH ROW EXECUTE FUNCTION machvon.fill_permit_gate_rule_type_code();

ALTER TABLE machvon.permit_gate_rule
  ADD CONSTRAINT permit_gate_rule_type_fk FOREIGN KEY (tenant_id, permit_type_id) REFERENCES machvon.permit_type (tenant_id, id);
ALTER TABLE machvon.permit_gate_rule
  ADD CONSTRAINT permit_gate_rule_legal_basis_chk CHECK (char_length(btrim(legal_basis)) > 0 AND char_length(legal_basis) <= 2000);
ALTER TABLE machvon.permit_gate_rule
  ADD CONSTRAINT permit_gate_rule_rule_chk CHECK (jsonb_typeof(applies_to_rule) = 'object');
ALTER TABLE machvon.permit_gate_rule
  ADD CONSTRAINT permit_gate_rule_milestone_chk CHECK (project_milestone_code IS NULL OR (project_milestone_code = btrim(project_milestone_code) AND project_milestone_code <> '' AND char_length(project_milestone_code) <= 100));
ALTER TABLE machvon.permit_gate_rule
  ADD CONSTRAINT permit_gate_rule_dates_chk CHECK (effective_until IS NULL OR effective_from < effective_until);
ALTER TABLE machvon.permit_gate_rule
  ADD CONSTRAINT permit_gate_rule_retired_chk CHECK (status <> 'RETIRED' OR effective_until IS NOT NULL);

-- No overlap of the effective periods of one gate and one permit type code (BR-PMT-03, GATE_RULE_OVERLAP). Both ends are inclusive days.
ALTER TABLE machvon.permit_gate_rule
  ADD CONSTRAINT permit_gate_rule_no_overlap EXCLUDE USING gist (
    tenant_id WITH =,
    gate_code WITH =,
    permit_type_code WITH =,
    daterange(effective_from, effective_until, '[]') WITH &&
  ) WHERE (status <> 'DRAFT');

-- The list: newest first; the evaluation reads the rules of a gate in force on a day.
CREATE INDEX permit_gate_rule_created_idx ON machvon.permit_gate_rule (tenant_id, created_at DESC, id DESC);
CREATE INDEX permit_gate_rule_gate_idx ON machvon.permit_gate_rule (tenant_id, gate_code, effective_from) WHERE status <> 'DRAFT';

-- Kept for good: an evaluation, an audit row and a waiver may name the rule years later.
REVOKE DELETE, TRUNCATE ON TABLE machvon.permit_gate_rule FROM machvon_app;

CREATE FUNCTION machvon.guard_permit_gate_rule_update() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.gate_code IS DISTINCT FROM OLD.gate_code
     OR NEW.project_milestone_code IS DISTINCT FROM OLD.project_milestone_code
     OR NEW.permit_type_id IS DISTINCT FROM OLD.permit_type_id
     OR NEW.permit_type_code IS DISTINCT FROM OLD.permit_type_code
     OR NEW.requirement IS DISTINCT FROM OLD.requirement
     OR NEW.applies_to_rule IS DISTINCT FROM OLD.applies_to_rule
     OR NEW.legal_basis IS DISTINCT FROM OLD.legal_basis
     OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
     OR NEW.revision IS DISTINCT FROM OLD.revision
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'a permit gate rule is immutable: publish a new revision instead' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'DRAFT' AND NEW.status = 'PUBLISHED')
    OR (OLD.status = 'PUBLISHED' AND NEW.status = 'RETIRED')) THEN
    RAISE EXCEPTION 'a permit gate rule does not move from % to %', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  IF NEW.effective_until IS DISTINCT FROM OLD.effective_until
     AND (NEW.status <> 'RETIRED' OR (OLD.effective_until IS NOT NULL AND NEW.effective_until > OLD.effective_until)) THEN
    RAISE EXCEPTION 'a permit gate rule may only be ended, and its end never moves later' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER permit_gate_rule_guard BEFORE UPDATE ON machvon.permit_gate_rule
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_permit_gate_rule_update();
