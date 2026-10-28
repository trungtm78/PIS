-- Authored by hand (not generated): the electronic site diary (ST-QMS-001, QMS 3.1, BR-QMS-01, BR-QMS-02, BR-QMS-03).
-- The tables site_diary and qms_signature come from the generated schema (V002). This adds what the commands rely on: the owner's note, who locked the diary and why, the words kept trimmed and bounded, the number of
-- a diary, one open correction for a diary, a person signing a diary once, the guard of the edges of the status (a diary that was signed is not edited, a diary that was locked is only superseded by its correction),
-- the guard of a signature (a role signs in its turn, over the hash the diary carries now), and a diary that is never deleted.

ALTER TABLE machvon.site_diary
  ADD COLUMN owner_note text,
  ADD COLUMN lock_reason text,
  ADD COLUMN locked_by uuid;

ALTER TABLE machvon.site_diary
  ADD CONSTRAINT site_diary_text_chk CHECK (
    (diary_no IS NULL OR (diary_no = btrim(diary_no) AND diary_no <> '' AND char_length(diary_no) <= 200))
    AND (supervisor_remark IS NULL OR (supervisor_remark = btrim(supervisor_remark) AND supervisor_remark <> '' AND char_length(supervisor_remark) <= 2000))
    AND (owner_note IS NULL OR (owner_note = btrim(owner_note) AND owner_note <> '' AND char_length(owner_note) <= 2000))
    AND (lock_reason IS NULL OR (lock_reason = btrim(lock_reason) AND lock_reason <> '' AND char_length(lock_reason) <= 2000))
    AND (correction_reason IS NULL OR (correction_reason = btrim(correction_reason) AND correction_reason <> '' AND char_length(correction_reason) <= 2000))
  ),
  ADD CONSTRAINT site_diary_content_chk CHECK (jsonb_typeof(content) = 'object'),
  ADD CONSTRAINT site_diary_locked_by_chk CHECK (status NOT IN ('LOCKED', 'SUPERSEDED') OR (locked_at IS NOT NULL AND locked_by IS NOT NULL));

-- A diary has a number, and a number is one diary's.
CREATE UNIQUE INDEX site_diary_no_uq ON machvon.site_diary (tenant_id, diary_no) WHERE diary_no IS NOT NULL;

-- One correction of a diary is open at a time: the next one waits until the first is locked.
CREATE UNIQUE INDEX site_diary_correction_open_uq ON machvon.site_diary (tenant_id, correction_of_id) WHERE correction_of_id IS NOT NULL AND status NOT IN ('LOCKED', 'SUPERSEDED');

-- A person signs a diary once, whatever the role.
CREATE UNIQUE INDEX qms_signature_person_diary_uq ON machvon.qms_signature (tenant_id, subject_id, membership_id) WHERE subject_kind = 'SITE_DIARY';

CREATE FUNCTION machvon.guard_site_diary() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF (NEW.tenant_id, NEW.id, NEW.project_id, NEW.contract_id, NEW.record_date, NEW.author_id, NEW.correction_of_id, NEW.correction_reason, NEW.client_operation_id, NEW.created_at, NEW.created_by)
     IS DISTINCT FROM (OLD.tenant_id, OLD.id, OLD.project_id, OLD.contract_id, OLD.record_date, OLD.author_id, OLD.correction_of_id, OLD.correction_reason, OLD.client_operation_id, OLD.created_at, OLD.created_by) THEN
    RAISE EXCEPTION 'the contract, the day, the author and the revision of a diary do not change' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'SUPERSEDED' THEN
    RAISE EXCEPTION 'DIARY_STATE_INVALID' USING ERRCODE = '23514';
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

CREATE TRIGGER site_diary_guard BEFORE UPDATE ON machvon.site_diary
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_site_diary();

-- The diary is part of the dossier of the contract: no command deletes it, and the runtime role no longer can.
REVOKE DELETE, TRUNCATE ON TABLE machvon.site_diary FROM machvon_app;

-- A signature of a diary is for the role whose turn it is, over the hash the diary carries now: the contractor signs a draft, the supervisor a diary that the contractor signed, the owner one that the supervisor
-- remarked on.
CREATE FUNCTION machvon.guard_site_diary_signature() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  diary machvon.site_diary%ROWTYPE;
BEGIN
  IF NEW.subject_kind <> 'SITE_DIARY' THEN
    RETURN NEW;
  END IF;
  SELECT * INTO diary FROM machvon.site_diary WHERE tenant_id = NEW.tenant_id AND id = NEW.subject_id;
  IF NOT FOUND THEN
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

CREATE TRIGGER qms_signature_site_diary_guard BEFORE INSERT ON machvon.qms_signature
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_site_diary_signature();

-- The operations of a device that updated a draft: the diary keeps the operation that made it, and an update is kept here so that the retry of a successful update (with another key of the request) is told what it did
-- and not that the draft moved on (DIARY_SYNC_CONFLICT). Append-only, one row per operation of the tenant.
CREATE TABLE machvon.site_diary_operation (
  tenant_id uuid NOT NULL,
  client_operation_id uuid NOT NULL,
  diary_id uuid NOT NULL,
  resulting_version bigint NOT NULL CHECK (resulting_version > 1),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, client_operation_id),
  CONSTRAINT site_diary_operation_diary_fk FOREIGN KEY (tenant_id, diary_id) REFERENCES machvon.site_diary (tenant_id, id)
);
CREATE INDEX site_diary_operation_diary_idx ON machvon.site_diary_operation (tenant_id, diary_id);

ALTER TABLE machvon.site_diary_operation ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.site_diary_operation FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.site_diary_operation AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.site_diary_operation AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.site_diary_operation FROM machvon_app;
