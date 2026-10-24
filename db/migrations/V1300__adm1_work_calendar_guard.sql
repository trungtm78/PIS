-- Authored by hand (not generated): guards for the working calendar versions (ST-ADM-010, ADM 3.8).
-- A published calendar is the legal basis of every deadline counted from it, so a version is kept for good and never
-- edited: a correction is a new revision that supersedes it.
REVOKE DELETE, TRUNCATE ON TABLE machvon.work_calendar_version FROM machvon_app;

ALTER TABLE machvon.work_calendar_version
  ADD CONSTRAINT work_calendar_json_shape_ck CHECK (
    jsonb_typeof(working_days) = 'array' AND jsonb_typeof(holidays) = 'array' AND jsonb_typeof(compensated_workdays) = 'array'),
  ADD CONSTRAINT work_calendar_published_ck CHECK (status = 'Draft' OR (published_by IS NOT NULL AND published_at IS NOT NULL));

-- Content and identity never change after the draft is written. A draft only becomes Published, a Published version only
-- becomes Superseded (and keeps who published it and when), and a Superseded version never changes again.
CREATE FUNCTION machvon.guard_work_calendar_update() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.calendar_code IS DISTINCT FROM OLD.calendar_code
     OR NEW.year IS DISTINCT FROM OLD.year
     OR NEW.revision IS DISTINCT FROM OLD.revision
     OR NEW.working_days IS DISTINCT FROM OLD.working_days
     OR NEW.holidays IS DISTINCT FROM OLD.holidays
     OR NEW.compensated_workdays IS DISTINCT FROM OLD.compensated_workdays
     OR NEW.legal_basis_ref IS DISTINCT FROM OLD.legal_basis_ref
     OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'a working calendar version is immutable: create a new revision instead' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'Superseded' THEN
    RAISE EXCEPTION 'a superseded working calendar version never changes' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'Published' AND (NEW.status <> 'Superseded'
     OR NEW.published_by IS DISTINCT FROM OLD.published_by OR NEW.published_at IS DISTINCT FROM OLD.published_at) THEN
    RAISE EXCEPTION 'a published working calendar version can only become superseded' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'Draft' AND NEW.status = 'Superseded' THEN
    RAISE EXCEPTION 'a draft working calendar version cannot be superseded before it is published' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER work_calendar_guard BEFORE UPDATE ON machvon.work_calendar_version
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_work_calendar_update();
