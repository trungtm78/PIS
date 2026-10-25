-- Authored by hand (not generated): the quality acceptance minutes of an inspection (ST-QMS-005, QMS 3.2, BR-QMS-02, BR-QMS-03 and BR-QMS-05).
-- The tables quality_acceptance and qms_signature come from the generated schema (V002). This adds what the commands rely on: the hash of what the signers sign (the minutes never change
-- after they are drafted, so the hash is stored with them), whether the regime of the inspection still waits for its confirmation, who rejected and who revoked the minutes and why, the shape
-- of each status, one live set of minutes for an inspection, one signature of a person for the minutes, the guard of the edges of the status, and a signature that is kept as it is.
-- The minutes read quality_nonconformance.blocks_acceptance (V002) to know that a serious non-conformance is still open; the rest of the non-conformance is ST-QMS-006's.

ALTER TABLE machvon.quality_acceptance
  ADD COLUMN content_hash char(64) NOT NULL DEFAULT repeat('0', 64),
  ADD COLUMN regime_awaiting_confirmation boolean NOT NULL DEFAULT false,
  ADD COLUMN regime_cxn text,
  ADD COLUMN rejected_at timestamptz,
  ADD COLUMN rejected_by uuid,
  ADD COLUMN revoked_at timestamptz,
  ADD COLUMN revoked_by uuid,
  ADD COLUMN revoke_reason text;

-- The hash of the minutes is always the hash of something: the placeholder that lets the column be added is taken away at once, and no row may keep it.
ALTER TABLE machvon.quality_acceptance ALTER COLUMN content_hash DROP DEFAULT;

-- The words are trimmed and bounded; the roles are a non-empty list of the four roles that sign minutes; the paper of the minutes is always named.
ALTER TABLE machvon.quality_acceptance
  ADD CONSTRAINT quality_acceptance_text_chk CHECK (
    record_no = btrim(record_no) AND record_no <> '' AND char_length(record_no) <= 2000
    AND (decision_note IS NULL OR (decision_note = btrim(decision_note) AND decision_note <> '' AND char_length(decision_note) <= 2000))
    AND (revoke_reason IS NULL OR (revoke_reason = btrim(revoke_reason) AND revoke_reason <> '' AND char_length(revoke_reason) <= 2000))
  ),
  ADD CONSTRAINT quality_acceptance_roles_chk CHECK (
    jsonb_typeof(required_roles) = 'array' AND jsonb_array_length(required_roles) > 0
    AND NOT jsonb_path_exists(required_roles, '$[*] ? (@ != "CONTRACTOR" && @ != "SUPERVISOR" && @ != "OWNER" && @ != "DESIGNER")')
  ),
  ADD CONSTRAINT quality_acceptance_document_chk CHECK (document_version_id IS NOT NULL),
  ADD CONSTRAINT quality_acceptance_hash_chk CHECK (content_hash ~ '^[0-9a-f]{64}$' AND content_hash <> repeat('0', 64)),
  ADD CONSTRAINT quality_acceptance_regime_chk CHECK (regime_awaiting_confirmation = (regime_cxn IS NOT NULL)),
  ADD CONSTRAINT quality_acceptance_decided_chk CHECK (
    (status IN ('APPROVED', 'REJECTED', 'REVOKED')) = (decision_note IS NOT NULL)
    AND ((status = 'REJECTED') = (rejected_at IS NOT NULL AND rejected_by IS NOT NULL))
    AND (status IN ('APPROVED', 'REVOKED') OR (approved_at IS NULL AND approved_by IS NULL))
    AND ((status = 'REVOKED') = (revoked_at IS NOT NULL AND revoked_by IS NOT NULL AND revoke_reason IS NOT NULL))
    AND (status = 'REVOKED' OR (revoked_at IS NULL AND revoked_by IS NULL AND revoke_reason IS NULL))
  ),
  -- Whoever drafted the minutes does not approve them.
  ADD CONSTRAINT quality_acceptance_maker_chk CHECK (approved_by IS NULL OR approved_by <> created_by);

-- One live set of minutes for an inspection: drafted, being signed or approved. Rejected and revoked minutes make room for new ones.
CREATE UNIQUE INDEX quality_acceptance_live_uq ON machvon.quality_acceptance (tenant_id, inspection_id) WHERE status IN ('DRAFT', 'SIGNING', 'APPROVED');

-- What the minutes say never changes: the contract, the inspection, the number, the scope, the paper, the roles, the regime, the hash that is signed and who drafted them. The status moves
-- DRAFT -> SIGNING -> APPROVED | REJECTED, and APPROVED -> REVOKED; rejected and revoked minutes are kept as they are, and the decision of approved ones does not change.
CREATE FUNCTION machvon.guard_quality_acceptance() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF (NEW.tenant_id, NEW.id, NEW.project_id, NEW.contract_id, NEW.inspection_id, NEW.record_no, NEW.acceptance_scope, NEW.document_version_id, NEW.required_roles, NEW.regime_rule_version_id,
      NEW.regime_awaiting_confirmation, NEW.regime_cxn, NEW.content_hash, NEW.created_at, NEW.created_by)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.id, OLD.project_id, OLD.contract_id, OLD.inspection_id, OLD.record_no, OLD.acceptance_scope, OLD.document_version_id, OLD.required_roles, OLD.regime_rule_version_id,
      OLD.regime_awaiting_confirmation, OLD.regime_cxn, OLD.content_hash, OLD.created_at, OLD.created_by) THEN
    RAISE EXCEPTION 'what quality acceptance minutes say never changes' USING ERRCODE = '23514';
  END IF;
  IF OLD.status IN ('REJECTED', 'REVOKED') THEN
    RAISE EXCEPTION 'quality acceptance minutes that are over are kept as they are' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'APPROVED' AND (NEW.approved_at, NEW.approved_by, NEW.decision_note) IS DISTINCT FROM (OLD.approved_at, OLD.approved_by, OLD.decision_note) THEN
    RAISE EXCEPTION 'the approval of quality acceptance minutes is kept as it is' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT EXISTS (
    SELECT 1
      FROM (VALUES ('DRAFT', 'SIGNING'), ('SIGNING', 'APPROVED'), ('SIGNING', 'REJECTED'), ('APPROVED', 'REVOKED')) AS allowed (from_status, to_status)
     WHERE allowed.from_status = OLD.status AND allowed.to_status = NEW.status
  ) THEN
    RAISE EXCEPTION 'QUALITY_ACCEPTANCE_STATE_INVALID' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER quality_acceptance_guard BEFORE UPDATE ON machvon.quality_acceptance
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_quality_acceptance();

-- The minutes are part of the dossier of the contract: no command deletes them, and the runtime role no longer can.
REVOKE DELETE, TRUNCATE ON TABLE machvon.quality_acceptance FROM machvon_app;

-- A person signs the minutes once, whatever the role: one membership, one signature for a set of minutes.
CREATE UNIQUE INDEX qms_signature_person_uq ON machvon.qms_signature (tenant_id, subject_id, membership_id) WHERE subject_kind = 'QUALITY_ACCEPTANCE';

-- A signature of quality acceptance minutes is for a role the minutes require, over the hash they carry, while they are still being signed (BR-QMS-02: a signature over other content is void).
CREATE FUNCTION machvon.guard_quality_acceptance_signature() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  minutes machvon.quality_acceptance%ROWTYPE;
BEGIN
  IF NEW.subject_kind <> 'QUALITY_ACCEPTANCE' THEN
    RETURN NEW;
  END IF;
  SELECT * INTO minutes FROM machvon.quality_acceptance WHERE tenant_id = NEW.tenant_id AND id = NEW.subject_id;
  IF NOT FOUND OR minutes.status NOT IN ('DRAFT', 'SIGNING') THEN
    RAISE EXCEPTION 'QUALITY_ACCEPTANCE_STATE_INVALID' USING ERRCODE = '23514';
  END IF;
  IF NEW.signed_content_hash IS DISTINCT FROM minutes.content_hash OR NOT (minutes.required_roles ? NEW.signer_role) THEN
    RAISE EXCEPTION 'a signature is for a required role and the hash of the minutes' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER qms_signature_quality_acceptance_guard BEFORE INSERT ON machvon.qms_signature
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_quality_acceptance_signature();

-- A signature is kept as it is.
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.qms_signature FROM machvon_app;
