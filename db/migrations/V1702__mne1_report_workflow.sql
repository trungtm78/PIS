-- ST-MNE-002: the periodic overall report, filled from a frozen snapshot with locked financial cells (MNE 3.1 F3, BR-MNE-02).
--
-- V002 gave `mne_report` its columns and the unique key of a report; V1701 took away the right to delete one. This migration keeps who handed a report in and when, and puts into the database what the
-- commands rely on: once a report leaves DRAFT, what it says (the form, the unit, the project, the period, the snapshot, the figures) never changes, whoever writes to it: a correction is a new revision.

ALTER TABLE machvon.mne_report
  ADD COLUMN submitted_by uuid,
  ADD COLUMN submitted_at timestamptz;

CREATE FUNCTION machvon.guard_mne_report() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.id IS DISTINCT FROM OLD.id OR NEW.form_id IS DISTINCT FROM OLD.form_id OR NEW.scope_unit_id IS DISTINCT FROM OLD.scope_unit_id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.report_year IS DISTINCT FROM OLD.report_year OR NEW.period_label IS DISTINCT FROM OLD.period_label
     OR NEW.revision IS DISTINCT FROM OLD.revision OR NEW.supersedes_id IS DISTINCT FROM OLD.supersedes_id THEN
    RAISE EXCEPTION 'a monitoring report keeps its form, unit, project, period and revision for good' USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'DRAFT' AND (NEW.snapshot_id IS DISTINCT FROM OLD.snapshot_id OR NEW.payload_json IS DISTINCT FROM OLD.payload_json) THEN
    RAISE EXCEPTION 'a monitoring report that left DRAFT keeps its snapshot and its figures: a correction is a new revision' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER mne_report_guard BEFORE UPDATE ON machvon.mne_report FOR EACH ROW EXECUTE FUNCTION machvon.guard_mne_report();
