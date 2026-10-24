-- Authored by hand (not generated): the permit type catalogue as dated legal data (ST-PMT-001, BR-PMT-03).
-- A permit type version is a statement of law with the date it applies from: a permit keeps the id of the version it was written
-- under, so a version is kept for good and its content never changes. A change of the regulation is a new revision of the same code
-- that takes over from a date, and the database has the last word on three things whatever the application checked first:
--   * a version has a legal basis (not blank) and a working-assumption reference that looks like a confirmation id (CXN-...);
--   * no two versions of one code apply on the same day (the effective period is inclusive: effective_until is the last day);
--   * a published version never changes except that it may be ended, once and never later than before.

-- The code is the stable name of the type across revisions (ENV_EIA, BUILDING_PERMIT).
ALTER TABLE machvon.permit_type
  ADD CONSTRAINT permit_type_code_chk CHECK (code ~ '^[A-Z][A-Z0-9_]{0,59}$');
ALTER TABLE machvon.permit_type
  ADD CONSTRAINT permit_type_legal_basis_chk CHECK (char_length(btrim(legal_basis)) > 0);
ALTER TABLE machvon.permit_type
  ADD CONSTRAINT permit_type_cxn_ref_chk CHECK (cxn_ref IS NULL OR cxn_ref ~ '^CXN-[A-Z0-9]+(-[A-Z0-9]+)*$');
ALTER TABLE machvon.permit_type
  ADD CONSTRAINT permit_type_rule_chk CHECK (jsonb_typeof(applies_to_rule) = 'object');
-- A retired version has the day it stopped applying; a revision after the first supersedes an earlier one.
ALTER TABLE machvon.permit_type
  ADD CONSTRAINT permit_type_retired_chk CHECK (status <> 'RETIRED' OR effective_until IS NOT NULL);
ALTER TABLE machvon.permit_type
  ADD CONSTRAINT permit_type_supersedes_chk CHECK (supersedes_id IS NULL OR (revision > 1 AND supersedes_id <> id));

-- No overlap of the effective periods of one code (BR-PMT-03, PERMIT_TYPE_OVERLAP). Both ends are inclusive days; a missing end is open-ended.
ALTER TABLE machvon.permit_type
  ADD CONSTRAINT permit_type_no_overlap EXCLUDE USING gist (
    tenant_id WITH =,
    code WITH =,
    daterange(effective_from, effective_until, '[]') WITH &&
  ) WHERE (status <> 'DRAFT');

-- The list: newest first.
CREATE INDEX permit_type_created_idx ON machvon.permit_type (tenant_id, created_at DESC, id DESC);

-- Kept for good: a permit, an audit row and a gate evaluation may name the version years later.
REVOKE DELETE, TRUNCATE ON TABLE machvon.permit_type FROM machvon_app;

-- A published version never changes its content. It may be ended (status RETIRED with the last day of effect) and the end may only move
-- earlier; a retired version never returns to PUBLISHED.
CREATE FUNCTION machvon.guard_permit_type_update() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.code IS DISTINCT FROM OLD.code
     OR NEW.revision IS DISTINCT FROM OLD.revision
     OR NEW.name IS DISTINCT FROM OLD.name
     OR NEW.category IS DISTINCT FROM OLD.category
     OR NEW.authority_text IS DISTINCT FROM OLD.authority_text
     OR NEW.legal_basis IS DISTINCT FROM OLD.legal_basis
     OR NEW.cxn_ref IS DISTINCT FROM OLD.cxn_ref
     OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
     OR NEW.applies_to_rule IS DISTINCT FROM OLD.applies_to_rule
     OR NEW.default_validity_months IS DISTINCT FROM OLD.default_validity_months
     OR NEW.default_processing_days IS DISTINCT FROM OLD.default_processing_days
     OR NEW.exemption_allowed IS DISTINCT FROM OLD.exemption_allowed
     OR NEW.supersedes_id IS DISTINCT FROM OLD.supersedes_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'a permit type version is immutable: publish a new revision instead' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'DRAFT' AND NEW.status = 'PUBLISHED')
    OR (OLD.status = 'PUBLISHED' AND NEW.status = 'RETIRED')) THEN
    RAISE EXCEPTION 'a permit type version does not move from % to %', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  IF NEW.effective_until IS DISTINCT FROM OLD.effective_until
     AND (NEW.status <> 'RETIRED' OR (OLD.effective_until IS NOT NULL AND NEW.effective_until > OLD.effective_until)) THEN
    RAISE EXCEPTION 'a permit type version may only be ended, and its end never moves later' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER permit_type_guard BEFORE UPDATE ON machvon.permit_type
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_permit_type_update();
