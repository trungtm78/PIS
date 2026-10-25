-- Authored by hand (not generated): the progress of the stages of land clearance, including the stages that an external unit executes (ST-LND-010, LND 3.4).
-- The table land_stage_progress comes from the generated schema (V002) with its unique index, its foreign keys and its two checks; this adds what the
-- commands rely on: the note of what holds a stage back, the arithmetic of a stage that is done, the order of its dates, the evidence of a stage that is
-- tracked from outside, the identity of a stage that no report changes, and the end of delete rights on a record that is kept for good.

ALTER TABLE machvon.land_stage_progress ADD COLUMN blocker_note text;

ALTER TABLE machvon.land_stage_progress
  ADD CONSTRAINT land_stage_blocker_note_chk CHECK (blocker_note IS NULL OR (blocker_note = btrim(blocker_note) AND blocker_note <> '' AND char_length(blocker_note) <= 2000));

-- A stage that is done has every one of its parcels done (the table already asks for its end).
ALTER TABLE machvon.land_stage_progress
  ADD CONSTRAINT land_stage_done_parcels_chk CHECK (status <> 'DONE' OR parcels_done = parcels_total);

ALTER TABLE machvon.land_stage_progress
  ADD CONSTRAINT land_stage_dates_chk CHECK (
    (planned_start IS NULL OR planned_end IS NULL OR planned_start <= planned_end)
    AND (actual_start IS NULL OR actual_end IS NULL OR actual_start <= actual_end)
  );

-- A stage tracked from outside that reports parcels done or an end has the evidence of the executing unit: the report is a claim until a document backs it.
ALTER TABLE machvon.land_stage_progress
  ADD CONSTRAINT land_stage_external_evidence_chk CHECK (mode = 'NATIVE' OR (parcels_done = 0 AND actual_end IS NULL) OR evidence_document_version_id IS NOT NULL);

-- Who reported and when go together.
ALTER TABLE machvon.land_stage_progress
  ADD CONSTRAINT land_stage_reported_chk CHECK ((last_reported_by IS NULL) = (last_reported_at IS NULL));

-- ---------------------------------------------------------------------------------------------------------------------------------------
-- A stage lies in a section of its own project and, when it names a plan, in a plan of that project. Once there it keeps its place: the project, the
-- section, the plan, the stage and the mode of tracking are what a report is about, so a report that would move them is another stage.
-- ---------------------------------------------------------------------------------------------------------------------------------------
CREATE FUNCTION machvon.guard_land_stage_place() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM machvon.land_handover_section s WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.section_id AND s.project_id = NEW.project_id) THEN
      RAISE EXCEPTION 'a stage lies in a section of its own project' USING ERRCODE = '23514';
    END IF;
    IF NEW.plan_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM machvon.compensation_plan c WHERE c.tenant_id = NEW.tenant_id AND c.id = NEW.plan_id AND c.project_id = NEW.project_id) THEN
      RAISE EXCEPTION 'a stage names a plan of its own project' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.section_id IS DISTINCT FROM OLD.section_id OR NEW.plan_id IS DISTINCT FROM OLD.plan_id
     OR NEW.stage_code IS DISTINCT FROM OLD.stage_code OR NEW.mode IS DISTINCT FROM OLD.mode THEN
    RAISE EXCEPTION 'a stage keeps its project, its section, its plan, its code and its mode' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER land_stage_place_guard BEFORE INSERT OR UPDATE ON machvon.land_stage_progress
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_land_stage_place();

-- The progress of a project is part of its dossier, kept under the retention of the project and under legal hold (LND section 6). No command deletes one.
REVOKE DELETE, TRUNCATE ON TABLE machvon.land_stage_progress FROM machvon_app;
