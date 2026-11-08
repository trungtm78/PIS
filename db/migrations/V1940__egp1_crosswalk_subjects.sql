-- Authored by hand (not generated): the codes of the national procurement network on the existing crosswalk (EGP-1 part 2, BID-15, BR-BID-15, docs/egp-connector.md section 5). No new table of external identities:
-- `master_crosswalk` keeps `(source_system, external_type, external_code)`, the validity range, the match method and the confidence, and is extended for what is not a master record.
--   * `subject_type` and `subject_id` name our side when it is a package, a notice, a result, a plan, a project, a contract or a contractor (a row of the BID, PRJ or CTR tables). `master_record_id` stays for the
--     entries of master data; exactly one of the two is set (the CHECK), so every row of MDM keeps its meaning and its screens.
--   * A mapping of the new kind is PROPOSED by one person (or by a file import, whose loader is the maker) and becomes ACTIVE only when ANOTHER person approves it: `created_by` is the maker, `approved_by` the checker,
--     and the CHECK `approved_by <> created_by` holds it in the database. REJECTED and RETIRED are final, with the person and the reason; a wrong mapping is replaced by a new proposal and the history stays.
--   * One external code stands for one subject at a time (the old unique index on ACTIVE rows still holds for every row); one subject holds one ACTIVE code per system and code type at a time (a new index);
--     a proposal is not repeated while it waits (a third index). Which of two proposals for the same code wins is decided at approval: the second approval is 409 CROSSWALK_DUPLICATE from the first index.
--   * A trigger keeps the identity of such a row for good (subject, code, system, maker) and lets the status move only along PROPOSED to ACTIVE or REJECTED and ACTIVE to RETIRED.

ALTER TABLE machvon.master_crosswalk
  ADD COLUMN subject_type text,
  ADD COLUMN subject_id uuid,
  ADD COLUMN proposal_reason text,
  ADD COLUMN import_id uuid,
  ADD COLUMN approved_by uuid,
  ADD COLUMN approved_at timestamptz,
  ADD COLUMN decision_reason text,
  ADD COLUMN retired_by uuid,
  ADD COLUMN retired_at timestamptz,
  ADD COLUMN retire_reason text;

ALTER TABLE machvon.master_crosswalk ALTER COLUMN master_record_id DROP NOT NULL;
ALTER TABLE machvon.master_crosswalk DROP CONSTRAINT IF EXISTS master_crosswalk_status_check;
ALTER TABLE machvon.master_crosswalk ADD CONSTRAINT master_crosswalk_status_check CHECK (status IN ('PROPOSED', 'ACTIVE', 'REJECTED', 'RETIRED'));

ALTER TABLE machvon.master_crosswalk
  ADD CONSTRAINT master_crosswalk_subject_chk CHECK (
    (subject_type IS NULL) = (subject_id IS NULL)
    AND ((master_record_id IS NOT NULL) <> (subject_type IS NOT NULL))
  ),
  ADD CONSTRAINT master_crosswalk_subject_type_chk CHECK (subject_type IS NULL OR subject_type IN ('PROJECT', 'PLAN', 'PACKAGE', 'NOTICE', 'RESULT', 'CONTRACT', 'CONTRACTOR')),
  -- The two new states belong to the new kind of row only; the rows of master data are ACTIVE or RETIRED as before.
  ADD CONSTRAINT master_crosswalk_subject_status_chk CHECK (subject_type IS NOT NULL OR status IN ('ACTIVE', 'RETIRED')),
  -- A mapping of a subject ends after it begins (the day it no longer holds is the first day after it).
  ADD CONSTRAINT master_crosswalk_subject_range_chk CHECK (subject_type IS NULL OR valid_until IS NULL OR valid_until > valid_from),
  -- The maker is not the checker, and a decided mapping says who decided it and why.
  ADD CONSTRAINT master_crosswalk_maker_checker_chk CHECK (approved_by IS NULL OR approved_by <> created_by),
  ADD CONSTRAINT master_crosswalk_subject_decision_chk CHECK (
    subject_type IS NULL
    OR (status = 'PROPOSED' AND approved_by IS NULL AND approved_at IS NULL AND decision_reason IS NULL AND retired_by IS NULL AND retired_at IS NULL AND retire_reason IS NULL)
    OR (status IN ('ACTIVE', 'REJECTED') AND approved_by IS NOT NULL AND approved_at IS NOT NULL AND char_length(btrim(decision_reason)) >= 10 AND retired_by IS NULL AND retired_at IS NULL AND retire_reason IS NULL)
    OR (status = 'RETIRED' AND approved_by IS NOT NULL AND approved_at IS NOT NULL AND char_length(btrim(decision_reason)) >= 10 AND retired_by IS NOT NULL AND retired_at IS NOT NULL AND char_length(btrim(retire_reason)) >= 10)
  ),
  ADD CONSTRAINT master_crosswalk_proposal_reason_chk CHECK (proposal_reason IS NULL OR (proposal_reason = btrim(proposal_reason) AND char_length(proposal_reason) BETWEEN 1 AND 2000)),
  ADD CONSTRAINT master_crosswalk_import_fk FOREIGN KEY (tenant_id, import_id) REFERENCES machvon.file_import (tenant_id, id);

-- One subject holds one ACTIVE code of one type of one system at a time; the code of an earlier time is RETIRED (the history of what it meant stays, so the mapping is versioned by its rows).
CREATE UNIQUE INDEX master_crosswalk_subject_active_uq ON machvon.master_crosswalk (tenant_id, source_system, external_type, subject_type, subject_id)
  WHERE status = 'ACTIVE' AND subject_type IS NOT NULL;
-- A proposal waits once: the same subject and the same code are not proposed twice while the first has not been decided.
CREATE UNIQUE INDEX master_crosswalk_subject_proposed_uq ON machvon.master_crosswalk (tenant_id, source_system, external_type, external_code, subject_id)
  WHERE status = 'PROPOSED' AND subject_type IS NOT NULL;
CREATE INDEX master_crosswalk_subject_list_idx ON machvon.master_crosswalk (tenant_id, source_system, subject_type, status, created_at DESC, id DESC) WHERE subject_type IS NOT NULL;
CREATE INDEX master_crosswalk_subject_lookup_idx ON machvon.master_crosswalk (tenant_id, subject_type, subject_id) WHERE subject_type IS NOT NULL;
CREATE INDEX master_crosswalk_import_idx ON machvon.master_crosswalk (tenant_id, import_id) WHERE import_id IS NOT NULL;

CREATE FUNCTION machvon.guard_master_crosswalk_subject() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF OLD.subject_type IS NULL AND NEW.subject_type IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.subject_type IS DISTINCT FROM OLD.subject_type OR NEW.subject_id IS DISTINCT FROM OLD.subject_id OR NEW.source_system IS DISTINCT FROM OLD.source_system
     OR NEW.external_type IS DISTINCT FROM OLD.external_type OR NEW.external_code IS DISTINCT FROM OLD.external_code OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.valid_from IS DISTINCT FROM OLD.valid_from OR NEW.match_method IS DISTINCT FROM OLD.match_method OR NEW.master_record_id IS DISTINCT FROM OLD.master_record_id THEN
    RAISE EXCEPTION 'a mapping of a subject keeps what it maps: the subject, the code, the system, the start day, the method and its maker' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'PROPOSED' AND NEW.status IN ('ACTIVE', 'REJECTED'))
    OR (OLD.status = 'ACTIVE' AND NEW.status = 'RETIRED')
  ) THEN
    RAISE EXCEPTION 'a mapping of a subject moves from PROPOSED to ACTIVE or REJECTED, and from ACTIVE to RETIRED' USING ERRCODE = '23514';
  END IF;
  IF OLD.status IN ('REJECTED', 'RETIRED') AND (NEW.valid_until IS DISTINCT FROM OLD.valid_until OR NEW.decision_reason IS DISTINCT FROM OLD.decision_reason OR NEW.retire_reason IS DISTINCT FROM OLD.retire_reason) THEN
    RAISE EXCEPTION 'a rejected or retired mapping is final' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER master_crosswalk_subject_guard BEFORE UPDATE ON machvon.master_crosswalk
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_master_crosswalk_subject();

COMMENT ON COLUMN machvon.master_crosswalk.subject_type IS 'EGP-1: what our side is when it is not a master record (PROJECT, PLAN, PACKAGE, NOTICE, RESULT, CONTRACT, CONTRACTOR); exactly one of master_record_id and subject_type/subject_id is set.';
COMMENT ON COLUMN machvon.master_crosswalk.approved_by IS 'EGP-1: the checker of a mapping of a subject; never its maker (created_by).';
