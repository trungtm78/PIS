-- Authored by hand (not generated): handover sections, parcels and statutory timers of land clearance (ST-LND-001, LND 3.1 steps 1 and 2).
-- The tables land_handover_section, land_parcel and land_deadline come from the generated schema (V002); this adds what the commands rely on:
-- text checks on the identity of a section and a parcel, the evidence of the recovery notice, the guarantee that a parcel carries no owner data,
-- guards that keep a recorded notice and a started timer as they were, and the end of delete rights on records that are kept for good.

-- ---------------------------------------------------------------------------------------------------------------------------------------
-- Sections and parcels are stored as they were typed after trimming: a code that differs only by a space would defeat the unique indexes.
-- ---------------------------------------------------------------------------------------------------------------------------------------
ALTER TABLE machvon.land_handover_section
  ADD CONSTRAINT land_section_text_chk CHECK (code = btrim(code) AND code <> '' AND char_length(code) <= 50 AND name = btrim(name) AND name <> '' AND char_length(name) <= 300);

ALTER TABLE machvon.land_parcel
  ADD CONSTRAINT land_parcel_code_text_chk CHECK (parcel_code = btrim(parcel_code) AND parcel_code <> '' AND char_length(parcel_code) <= 50);
ALTER TABLE machvon.land_parcel
  ADD CONSTRAINT land_parcel_address_text_chk CHECK (address_text IS NULL OR (address_text = btrim(address_text) AND address_text <> '' AND char_length(address_text) <= 500));

-- ---------------------------------------------------------------------------------------------------------------------------------------
-- A parcel carries no owner or user of the land (LND section 1, "thửa đất không chứa thông tin chủ sử dụng"). The outline of a parcel is a
-- geometry and nothing else: a GeoJSON member such as `properties` is where a name would hide, so the column takes only `type` and `coordinates`.
-- ---------------------------------------------------------------------------------------------------------------------------------------
ALTER TABLE machvon.land_parcel
  ADD CONSTRAINT land_parcel_boundary_geometry_chk CHECK (
    boundary_geojson IS NULL OR (
      jsonb_typeof(boundary_geojson) = 'object'
      AND boundary_geojson ?& ARRAY['type', 'coordinates']
      AND (boundary_geojson - 'type' - 'coordinates') = '{}'::jsonb
      AND boundary_geojson ->> 'type' IN ('Polygon', 'MultiPolygon')
      AND jsonb_typeof(boundary_geojson -> 'coordinates') = 'array'
    )
  );

-- ---------------------------------------------------------------------------------------------------------------------------------------
-- The recovery notice (LND 3.1 step 2): the notice document is kept with the date, and a notice has its length of days or neither.
-- ---------------------------------------------------------------------------------------------------------------------------------------
ALTER TABLE machvon.land_parcel ADD COLUMN notice_document_version_id uuid;
ALTER TABLE machvon.land_parcel ADD FOREIGN KEY (tenant_id, notice_document_version_id) REFERENCES machvon.document_version (tenant_id, id);
CREATE INDEX land_parcel_notice_document_version_id_idx ON machvon.land_parcel (tenant_id, notice_document_version_id);
ALTER TABLE machvon.land_parcel
  ADD CONSTRAINT land_parcel_notice_evidence_chk CHECK (
    (recovery_notice_on IS NULL) = (notice_days_applied IS NULL) AND (recovery_notice_on IS NULL) = (notice_document_version_id IS NULL)
  );

-- ---------------------------------------------------------------------------------------------------------------------------------------
-- A timer belongs to what it counts: a parcel to a notice, a plan to its posting, a payment to its 30 days, a complaint to its answer.
-- ---------------------------------------------------------------------------------------------------------------------------------------
ALTER TABLE machvon.land_deadline
  ADD CONSTRAINT land_deadline_subject_timer_chk CHECK (
    (subject_kind = 'PARCEL' AND timer_code IN ('NOTICE_AGRICULTURAL_90', 'NOTICE_NON_AGRICULTURAL_180'))
    OR (subject_kind = 'PLAN' AND timer_code = 'PLAN_POSTING_30')
    OR (subject_kind = 'PAYMENT' AND timer_code = 'PAYMENT_30')
    OR (subject_kind = 'COMPLAINT' AND timer_code = 'COMPLAINT_RESOLUTION')
  );

-- ---------------------------------------------------------------------------------------------------------------------------------------
-- Guards. A section and a parcel stay in their project and keep their code; a recorded notice is a legal fact that is never rewritten, and the
-- land use that decided its length cannot change after it. A started timer keeps the days, the dates and the rule version it was counted by
-- (no retroactive change: a new rule only governs timers that start after it), and a timer that has ended does not start again.
-- ---------------------------------------------------------------------------------------------------------------------------------------
CREATE FUNCTION machvon.guard_land_section_identity() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.code IS DISTINCT FROM OLD.code THEN
    RAISE EXCEPTION 'a land section keeps its project and its code' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER land_section_identity_guard BEFORE UPDATE ON machvon.land_handover_section
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_land_section_identity();

CREATE FUNCTION machvon.guard_land_parcel_identity() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.parcel_code IS DISTINCT FROM OLD.parcel_code THEN
    RAISE EXCEPTION 'a land parcel keeps its project and its code' USING ERRCODE = '23514';
  END IF;
  IF OLD.recovery_notice_on IS NOT NULL AND (
       NEW.recovery_notice_on IS DISTINCT FROM OLD.recovery_notice_on
       OR NEW.notice_days_applied IS DISTINCT FROM OLD.notice_days_applied
       OR NEW.notice_document_version_id IS DISTINCT FROM OLD.notice_document_version_id
       OR NEW.land_use_group IS DISTINCT FROM OLD.land_use_group
     ) THEN
    RAISE EXCEPTION 'a recorded recovery notice is never rewritten' USING ERRCODE = '23514';
  END IF;
  IF OLD.recovery_decision_on IS NOT NULL AND NEW.recovery_decision_on IS DISTINCT FROM OLD.recovery_decision_on THEN
    RAISE EXCEPTION 'a recorded recovery decision is never rewritten' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER land_parcel_identity_guard BEFORE UPDATE ON machvon.land_parcel
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_land_parcel_identity();

CREATE FUNCTION machvon.guard_land_deadline_facts() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.subject_kind IS DISTINCT FROM OLD.subject_kind OR NEW.subject_id IS DISTINCT FROM OLD.subject_id
     OR NEW.timer_code IS DISTINCT FROM OLD.timer_code OR NEW.days_applied IS DISTINCT FROM OLD.days_applied OR NEW.started_on IS DISTINCT FROM OLD.started_on
     OR NEW.due_on IS DISTINCT FROM OLD.due_on OR NEW.rule_version_id IS DISTINCT FROM OLD.rule_version_id THEN
    RAISE EXCEPTION 'a started timer keeps its days, its dates and its rule version' USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'RUNNING' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'a timer that has ended does not start again' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER land_deadline_facts_guard BEFORE UPDATE ON machvon.land_deadline
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_land_deadline_facts();

-- ---------------------------------------------------------------------------------------------------------------------------------------
-- The sections, parcels and timers of a project are part of its dossier, kept under the retention of the project and under legal hold (LND
-- section 6). No command deletes one; the runtime role no longer can.
-- ---------------------------------------------------------------------------------------------------------------------------------------
REVOKE DELETE, TRUNCATE ON TABLE machvon.land_handover_section FROM machvon_app;
REVOKE DELETE, TRUNCATE ON TABLE machvon.land_parcel FROM machvon_app;
REVOKE DELETE, TRUNCATE ON TABLE machvon.land_deadline FROM machvon_app;
