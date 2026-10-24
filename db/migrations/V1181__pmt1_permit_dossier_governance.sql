-- Authored by hand (not generated): the project permit dossier, its permits and their milestones (ST-PMT-002, PMT 3.1, BR-PMT-01).
-- The tables permit_dossier, permit and permit_milestone come from the generated schema (V002); this adds what the module relies on:
--   * a permit keeps the id of the permit type VERSION it was written under, and also the stable CODE of that type, because "one current
--     permit per type" and "one number per type" are statements about the type, not about one of its revisions: a regulation that changes
--     in the middle of a permit's life (a new revision of the same code) must not let a second current permit or a repeated number in;
--   * whether a permit was required by the rules when the dossier was opened (the readiness of the dossier counts those only);
--   * the decision that revoked a permit (revoke needs a reason AND a document);
--   * the database has the last word on the state machine of a permit, on what an issued permit may never change (BR-PMT-01: no edit of
--     valid_until, REJECTED -> ISSUED needs a new permit), on the milestones being a record that is only added to, and on the dossier
--     keeping the project it was opened for;
--   * the dossier, the permits and the milestones are kept for good (retention follows the project file): no delete for the runtime role.

ALTER TABLE machvon.permit ADD COLUMN permit_type_code text;
ALTER TABLE machvon.permit ADD COLUMN is_required boolean NOT NULL DEFAULT false;
ALTER TABLE machvon.permit ADD COLUMN revocation_document_version_id uuid;
ALTER TABLE machvon.permit
  ADD CONSTRAINT permit_revocation_document_fk FOREIGN KEY (tenant_id, revocation_document_version_id) REFERENCES machvon.document_version (tenant_id, id);
CREATE INDEX permit_revocation_document_version_id_idx ON machvon.permit (tenant_id, revocation_document_version_id);

-- The code of the type is copied from the version the permit names, once, when the permit is written.
CREATE FUNCTION machvon.fill_permit_type_code() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  SELECT t.code INTO NEW.permit_type_code
    FROM machvon.permit_type t
   WHERE t.tenant_id = NEW.tenant_id AND t.id = NEW.permit_type_id;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER permit_type_code_fill BEFORE INSERT ON machvon.permit
  FOR EACH ROW EXECUTE FUNCTION machvon.fill_permit_type_code();

-- The text of a permit as it is stored: trimmed and not empty.
ALTER TABLE machvon.permit
  ADD CONSTRAINT permit_no_text_chk CHECK (permit_no IS NULL OR (permit_no = btrim(permit_no) AND permit_no <> ''));
-- A permit without an end says so; one cannot both have a last day and have none.
ALTER TABLE machvon.permit
  ADD CONSTRAINT permit_no_expiry_chk CHECK (NOT no_expiry OR valid_until IS NULL);
ALTER TABLE machvon.permit
  ADD CONSTRAINT permit_supersedes_chk CHECK (supersedes_id IS NULL OR supersedes_id <> id);
-- A revoked permit names the decision that revoked it.
ALTER TABLE machvon.permit
  ADD CONSTRAINT permit_revoke_document_chk CHECK (status <> 'REVOKED' OR revocation_document_version_id IS NOT NULL);

-- One current permit per TYPE in a dossier (AC-ST-PMT-002-1), whichever revision of the type it was written under, and one open
-- application per type: a second permit of a type is a renewal of the first or the next attempt after a rejection, never a parallel one.
CREATE UNIQUE INDEX permit_code_current_uq ON machvon.permit (tenant_id, dossier_id, permit_type_code)
  WHERE status IN ('ISSUED', 'EXEMPTED') AND permit_type_code IS NOT NULL;
CREATE UNIQUE INDEX permit_code_open_uq ON machvon.permit (tenant_id, dossier_id, permit_type_code)
  WHERE status IN ('PLANNED', 'SUBMITTED', 'IN_APPRAISAL', 'SUPPLEMENT_REQUESTED') AND permit_type_code IS NOT NULL;
-- A number is the number of one type in the whole tenant (AC-ST-PMT-002-1); capitals and spaces around it do not make another number.
CREATE UNIQUE INDEX permit_code_no_uq ON machvon.permit (tenant_id, permit_type_code, lower(permit_no))
  WHERE permit_no IS NOT NULL AND permit_type_code IS NOT NULL;

-- The state machine of a permit (PMT 4). The application checks first and says why; this is the last word.
CREATE FUNCTION machvon.guard_permit_update() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.dossier_id IS DISTINCT FROM OLD.dossier_id
     OR NEW.permit_type_id IS DISTINCT FROM OLD.permit_type_id
     OR NEW.permit_type_code IS DISTINCT FROM OLD.permit_type_code
     OR NEW.supersedes_id IS DISTINCT FROM OLD.supersedes_id
     OR NEW.is_required IS DISTINCT FROM OLD.is_required
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'a permit keeps its dossier, the permit type version it was written under and where it came from' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'PLANNED' AND NEW.status IN ('SUBMITTED', 'EXEMPTED'))
    OR (OLD.status = 'SUBMITTED' AND NEW.status IN ('IN_APPRAISAL', 'EXEMPTED'))
    OR (OLD.status = 'IN_APPRAISAL' AND NEW.status IN ('SUPPLEMENT_REQUESTED', 'ISSUED', 'REJECTED'))
    OR (OLD.status = 'SUPPLEMENT_REQUESTED' AND NEW.status = 'IN_APPRAISAL')
    OR (OLD.status = 'ISSUED' AND NEW.status IN ('EXPIRED', 'REVOKED', 'SUPERSEDED'))
    OR (OLD.status = 'EXPIRED' AND NEW.status = 'SUPERSEDED')) THEN
    RAISE EXCEPTION 'a permit does not move from % to %', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  -- What an issued permit says never changes, in particular not its last day: a longer validity is a renewal, a new permit.
  IF OLD.status IN ('ISSUED', 'EXPIRED', 'REVOKED', 'SUPERSEDED') AND (
       NEW.permit_no IS DISTINCT FROM OLD.permit_no
    OR NEW.issued_on IS DISTINCT FROM OLD.issued_on
    OR NEW.valid_from IS DISTINCT FROM OLD.valid_from
    OR NEW.valid_until IS DISTINCT FROM OLD.valid_until
    OR NEW.no_expiry IS DISTINCT FROM OLD.no_expiry
    OR NEW.document_version_id IS DISTINCT FROM OLD.document_version_id) THEN
    RAISE EXCEPTION 'an issued permit never changes what it says: renew it instead' USING ERRCODE = '23514';
  END IF;
  IF OLD.permit_no IS NOT NULL AND NEW.permit_no IS DISTINCT FROM OLD.permit_no THEN
    RAISE EXCEPTION 'a permit keeps its number' USING ERRCODE = '23514';
  END IF;
  IF OLD.revoke_reason IS NOT NULL AND (NEW.revoke_reason IS DISTINCT FROM OLD.revoke_reason
     OR NEW.revocation_document_version_id IS DISTINCT FROM OLD.revocation_document_version_id) THEN
    RAISE EXCEPTION 'a revocation is not rewritten' USING ERRCODE = '23514';
  END IF;
  IF OLD.exemption_basis IS NOT NULL AND (NEW.exemption_basis IS DISTINCT FROM OLD.exemption_basis
     OR NEW.exemption_decision_document_version_id IS DISTINCT FROM OLD.exemption_decision_document_version_id) THEN
    RAISE EXCEPTION 'an exemption is not rewritten' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER permit_guard BEFORE UPDATE ON machvon.permit
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_permit_update();

-- A dossier belongs to the project (and component) it was opened for.
CREATE FUNCTION machvon.guard_permit_dossier_update() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.project_component_id IS DISTINCT FROM OLD.project_component_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'a permit dossier keeps the project it was opened for' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER permit_dossier_guard BEFORE UPDATE ON machvon.permit_dossier
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_permit_dossier_update();

-- The milestones of a permit are a record: they are added, never changed or taken back. A step is dated by the day it was planned or by
-- the day it happened, and a note is text.
ALTER TABLE machvon.permit_milestone
  ADD CONSTRAINT permit_milestone_dated_chk CHECK (planned_on IS NOT NULL OR actual_on IS NOT NULL);
ALTER TABLE machvon.permit_milestone
  ADD CONSTRAINT permit_milestone_note_chk CHECK (note IS NULL OR (note = btrim(note) AND note <> ''));

CREATE FUNCTION machvon.guard_permit_milestone() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  RAISE EXCEPTION 'a permit milestone is a record: it is added, never changed or removed' USING ERRCODE = '23514';
END;
$fn$;

CREATE TRIGGER permit_milestone_guard BEFORE UPDATE OR DELETE ON machvon.permit_milestone
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_permit_milestone();

-- Kept for good, like the project file they belong to.
REVOKE DELETE, TRUNCATE ON TABLE machvon.permit_dossier FROM machvon_app;
REVOKE DELETE, TRUNCATE ON TABLE machvon.permit FROM machvon_app;
REVOKE DELETE, TRUNCATE ON TABLE machvon.permit_milestone FROM machvon_app;
