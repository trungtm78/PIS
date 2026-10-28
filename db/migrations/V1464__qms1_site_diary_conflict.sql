-- QMS-1, ST-QMS-002: the conflict of two devices that edited the same diary. The columns conflict_of_id and conflict_state come from the generated schema (V002): a device that saved over a draft it had not read
-- at its version leaves a copy of its own (a draft that points at the main diary, CONFLICT_PENDING) and the main diary is not touched. This adds how a person settles it, and keeps what was set aside.
ALTER TABLE machvon.site_diary
  ADD COLUMN conflict_resolution text,
  ADD COLUMN conflict_note text,
  ADD COLUMN conflict_discarded jsonb,
  ADD COLUMN conflict_resolved_by uuid,
  ADD COLUMN conflict_resolved_at timestamptz;

ALTER TABLE machvon.site_diary ADD CONSTRAINT site_diary_conflict_resolution_chk CHECK (
  (conflict_state = 'RESOLVED') = (conflict_resolution IS NOT NULL AND conflict_note IS NOT NULL AND conflict_discarded IS NOT NULL AND conflict_resolved_by IS NOT NULL AND conflict_resolved_at IS NOT NULL)
  AND (conflict_resolution IS NULL OR conflict_resolution IN ('KEEP_PRIMARY', 'ADOPT_CONFLICT', 'MERGED'))
  AND (conflict_note IS NULL OR (conflict_note = btrim(conflict_note) AND conflict_note <> ''))
);

-- A conflict copy stays a draft that nobody signs, edits or locks; it is settled once, by recording how, and then it is kept as it is. The main diary keeps its own rules (V1463).
CREATE OR REPLACE FUNCTION machvon.guard_site_diary() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF (NEW.tenant_id, NEW.id, NEW.project_id, NEW.contract_id, NEW.record_date, NEW.author_id, NEW.correction_of_id, NEW.correction_reason, NEW.conflict_of_id, NEW.client_operation_id, NEW.created_at, NEW.created_by)
     IS DISTINCT FROM (OLD.tenant_id, OLD.id, OLD.project_id, OLD.contract_id, OLD.record_date, OLD.author_id, OLD.correction_of_id, OLD.correction_reason, OLD.conflict_of_id, OLD.client_operation_id, OLD.created_at, OLD.created_by) THEN
    RAISE EXCEPTION 'the contract, the day, the author and the revision of a diary do not change' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'SUPERSEDED' THEN
    RAISE EXCEPTION 'DIARY_STATE_INVALID' USING ERRCODE = '23514';
  END IF;
  -- The settling of a conflict: PENDING to RESOLVED, once, and only for a copy. What was settled is kept as it is.
  IF NEW.conflict_state IS DISTINCT FROM OLD.conflict_state AND NOT (OLD.conflict_state = 'CONFLICT_PENDING' AND NEW.conflict_state = 'RESOLVED') THEN
    RAISE EXCEPTION 'DIARY_STATE_INVALID' USING ERRCODE = '23514';
  END IF;
  IF OLD.conflict_state = 'RESOLVED' THEN
    RAISE EXCEPTION 'a settled conflict is kept as it is' USING ERRCODE = '23514';
  END IF;
  IF OLD.conflict_state = 'CONFLICT_PENDING' AND (NEW.status, NEW.content, NEW.weather_code, NEW.workforce_count, NEW.content_hash, NEW.supervisor_remark, NEW.owner_note)
     IS DISTINCT FROM (OLD.status, OLD.content, OLD.weather_code, OLD.workforce_count, OLD.content_hash, OLD.supervisor_remark, OLD.owner_note) THEN
    RAISE EXCEPTION 'a copy of a conflict is only settled, never edited or signed' USING ERRCODE = '23514';
  END IF;
  -- What was signed is not edited (BR-QMS-02): the content and the hash are the contractor's until the contractor signs, and the hash is set once.
  IF OLD.status <> 'DRAFT' AND (NEW.content, NEW.weather_code, NEW.workforce_count, NEW.content_hash) IS DISTINCT FROM (OLD.content, OLD.weather_code, OLD.workforce_count, OLD.content_hash) THEN
    RAISE EXCEPTION 'DIARY_STATE_INVALID' USING ERRCODE = '23514';
  END IF;
  IF OLD.supervisor_remark IS NOT NULL AND NEW.supervisor_remark IS DISTINCT FROM OLD.supervisor_remark THEN
    RAISE EXCEPTION 'the remark of the supervisor is kept as it is' USING ERRCODE = '23514';
  END IF;
  -- The note of the owner is the owner's once the owner confirmed, and the lock keeps its reason and who made it.
  IF OLD.status IN ('OWNER_CONFIRMED', 'LOCKED') AND NEW.owner_note IS DISTINCT FROM OLD.owner_note THEN
    RAISE EXCEPTION 'the note of the owner is kept as it is' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'LOCKED' AND (NEW.lock_reason, NEW.locked_at, NEW.locked_by) IS DISTINCT FROM (OLD.lock_reason, OLD.locked_at, OLD.locked_by) THEN
    RAISE EXCEPTION 'the lock of a diary is kept as it is' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT EXISTS (
    SELECT 1
      FROM (VALUES ('DRAFT', 'CONTRACTOR_SIGNED'), ('CONTRACTOR_SIGNED', 'SUPERVISED'), ('SUPERVISED', 'OWNER_CONFIRMED'), ('SUPERVISED', 'LOCKED'), ('OWNER_CONFIRMED', 'LOCKED'), ('LOCKED', 'SUPERSEDED'))
           AS allowed (from_status, to_status)
     WHERE allowed.from_status = OLD.status AND allowed.to_status = NEW.status
  ) THEN
    RAISE EXCEPTION 'DIARY_STATE_INVALID' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

-- A copy of a conflict is never signed: only a main diary or a correction is.
CREATE OR REPLACE FUNCTION machvon.guard_site_diary_signature() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  diary machvon.site_diary%ROWTYPE;
BEGIN
  IF NEW.subject_kind <> 'SITE_DIARY' THEN
    RETURN NEW;
  END IF;
  SELECT * INTO diary FROM machvon.site_diary WHERE tenant_id = NEW.tenant_id AND id = NEW.subject_id;
  IF NOT FOUND OR diary.conflict_of_id IS NOT NULL THEN
    RAISE EXCEPTION 'DIARY_STATE_INVALID' USING ERRCODE = '23514';
  END IF;
  IF NOT ((NEW.signer_role = 'CONTRACTOR' AND diary.status = 'DRAFT') OR (NEW.signer_role = 'SUPERVISOR' AND diary.status = 'CONTRACTOR_SIGNED') OR (NEW.signer_role = 'OWNER' AND diary.status = 'SUPERVISED')) THEN
    RAISE EXCEPTION 'DIARY_STATE_INVALID' USING ERRCODE = '23514';
  END IF;
  IF diary.content_hash IS NULL OR NEW.signed_content_hash IS DISTINCT FROM diary.content_hash THEN
    RAISE EXCEPTION 'a signature is over the hash of the diary' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;
