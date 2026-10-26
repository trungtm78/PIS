-- Authored by hand (not generated): the complaints of the households about the clearance of their land, the days they are answered in, and the parcels that a complaint holds as disputed while it is open (ST-LND-008, LND 3.3, BR-LND-01, UAT-AC384).
-- The table land_complaint with its unit policy, its foreign keys (the project, the household, the plan, the unit, the reply document, the issue), the check of the resolved complaint and the unique number of a complaint in a project
-- are in V002; the timers (a complaint has the timer COMPLAINT_RESOLUTION of land_deadline) are in V1680. This adds what the commands rely on: the words of the reply and who gave it, the texts and the dates of a complaint, what each status
-- holds, the guard of its edges, the number of a complaint (issued by a counter that every unit shares), and the record of the parcels a complaint holds so that they go back to where they were when it is answered.

ALTER TABLE machvon.land_complaint
  ADD COLUMN resolution_note text,
  ADD COLUMN resolved_by uuid;

ALTER TABLE machvon.land_complaint
  ADD CONSTRAINT land_complaint_text_chk CHECK (
    complaint_no = btrim(complaint_no) AND complaint_no ~ '^LC-[0-9]{6}$'
    AND description = btrim(description) AND description <> '' AND char_length(description) <= 2000
    AND (resolution_note IS NULL OR (resolution_note = btrim(resolution_note) AND resolution_note <> '' AND char_length(resolution_note) <= 2000))
  ),
  ADD CONSTRAINT land_complaint_dates_chk CHECK (due_on > filed_on AND (resolved_on IS NULL OR resolved_on >= filed_on)),
  -- What each status holds: a complaint that waits holds no answer; one that was answered, escalated or closed says when, by whom and what was answered; the reply document is the one of a complaint that was resolved.
  ADD CONSTRAINT land_complaint_status_chk CHECK (
    (status IN ('RECEIVED', 'UNDER_REVIEW') AND resolved_on IS NULL AND resolved_by IS NULL AND resolution_note IS NULL AND resolution_document_version_id IS NULL)
    OR (status IN ('RESOLVED_ACCEPTED', 'RESOLVED_REJECTED', 'ESCALATED', 'CLOSED') AND resolved_on IS NOT NULL AND resolved_by IS NOT NULL AND resolution_note IS NOT NULL)
  ),
  ADD CONSTRAINT land_complaint_resolved_by_fk FOREIGN KEY (tenant_id, resolved_by) REFERENCES machvon.membership (tenant_id, id),
  ADD CONSTRAINT land_complaint_created_by_fk FOREIGN KEY (tenant_id, created_by) REFERENCES machvon.membership (tenant_id, id);

REVOKE DELETE, TRUNCATE ON TABLE machvon.land_complaint FROM machvon_app;

-- The number of a complaint: one after another in the project, from a counter that sees every unit (a count of the rows would see only those of the unit of the caller).
CREATE TABLE machvon.land_complaint_counter (
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  last_no integer NOT NULL CHECK (last_no > 0),
  PRIMARY KEY (tenant_id, project_id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES machvon.project (tenant_id, id)
);
ALTER TABLE machvon.land_complaint_counter ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.land_complaint_counter FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.land_complaint_counter AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.land_complaint_counter AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
REVOKE DELETE, TRUNCATE ON TABLE machvon.land_complaint_counter FROM machvon_app;

-- The parcels that a complaint holds as disputed, with the state each had, so that the answer gives each back where it was (a parcel two complaints hold goes back when the last of them lets it go).
CREATE TABLE machvon.land_complaint_hold (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  complaint_id uuid NOT NULL,
  parcel_id uuid NOT NULL,
  owner_unit_id uuid NOT NULL,
  previous_status text NOT NULL CHECK (previous_status IN ('SURVEYED', 'INVENTORIED', 'PLAN_DRAFTED', 'PLAN_POSTED', 'PLAN_APPROVED')),
  held_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, complaint_id) REFERENCES machvon.land_complaint (tenant_id, id),
  FOREIGN KEY (tenant_id, parcel_id) REFERENCES machvon.land_parcel (tenant_id, id),
  FOREIGN KEY (tenant_id, owner_unit_id) REFERENCES machvon.organization_unit (tenant_id, id),
  CONSTRAINT land_complaint_hold_once_uq UNIQUE (tenant_id, complaint_id, parcel_id)
);
CREATE INDEX land_complaint_hold_complaint_idx ON machvon.land_complaint_hold (tenant_id, complaint_id);
CREATE INDEX land_complaint_hold_parcel_idx ON machvon.land_complaint_hold (tenant_id, parcel_id);
CREATE INDEX land_complaint_hold_owner_unit_idx ON machvon.land_complaint_hold (tenant_id, owner_unit_id);
ALTER TABLE machvon.land_complaint_hold ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.land_complaint_hold FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.land_complaint_hold AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.land_complaint_hold AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY scope_units_guard ON machvon.land_complaint_hold AS RESTRICTIVE FOR ALL
  USING (current_setting('app.scope_units', true) = '*' OR owner_unit_id::text = ANY (string_to_array(current_setting('app.scope_units', true), ',')))
  WITH CHECK (current_setting('app.scope_units', true) = '*' OR owner_unit_id::text = ANY (string_to_array(current_setting('app.scope_units', true), ',')));
REVOKE DELETE, TRUNCATE ON TABLE machvon.land_complaint_hold FROM machvon_app;

CREATE FUNCTION machvon.guard_land_complaint() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  h_unit uuid;
  h_project uuid;
  p_project uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'RECEIVED' THEN
      RAISE EXCEPTION 'COMPLAINT_STATE_INVALID: a complaint is received first' USING ERRCODE = '23514';
    END IF;
    SELECT h.owner_unit_id, h.project_id INTO h_unit, h_project FROM machvon.affected_household h WHERE h.tenant_id = NEW.tenant_id AND h.id = NEW.household_id;
    IF h_unit IS NULL OR h_unit <> NEW.owner_unit_id OR h_project <> NEW.project_id THEN
      RAISE EXCEPTION 'a complaint belongs to the unit and the project of its household' USING ERRCODE = '23514';
    END IF;
    IF NEW.plan_id IS NOT NULL THEN
      SELECT p.project_id INTO p_project FROM machvon.compensation_plan p WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.plan_id;
      IF p_project IS DISTINCT FROM NEW.project_id THEN
        RAISE EXCEPTION 'a complaint names a plan of its project' USING ERRCODE = '23514';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.tenant_id, NEW.id, NEW.project_id, NEW.household_id, NEW.plan_id, NEW.owner_unit_id, NEW.complaint_no, NEW.filed_on, NEW.channel, NEW.subject, NEW.description, NEW.due_on, NEW.created_at, NEW.created_by)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.id, OLD.project_id, OLD.household_id, OLD.plan_id, OLD.owner_unit_id, OLD.complaint_no, OLD.filed_on, OLD.channel, OLD.subject, OLD.description, OLD.due_on, OLD.created_at, OLD.created_by) THEN
    RAISE EXCEPTION 'what a complaint says is never changed' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT EXISTS (
    SELECT 1
      FROM (VALUES
        ('RECEIVED', 'UNDER_REVIEW'), ('RECEIVED', 'RESOLVED_ACCEPTED'), ('RECEIVED', 'RESOLVED_REJECTED'), ('RECEIVED', 'ESCALATED'),
        ('UNDER_REVIEW', 'RESOLVED_ACCEPTED'), ('UNDER_REVIEW', 'RESOLVED_REJECTED'), ('UNDER_REVIEW', 'ESCALATED'),
        ('ESCALATED', 'RESOLVED_ACCEPTED'), ('ESCALATED', 'RESOLVED_REJECTED'), ('ESCALATED', 'CLOSED'),
        ('RESOLVED_ACCEPTED', 'CLOSED'), ('RESOLVED_REJECTED', 'CLOSED')
      ) AS allowed (from_status, to_status)
     WHERE allowed.from_status = OLD.status AND allowed.to_status = NEW.status
  ) THEN
    RAISE EXCEPTION 'COMPLAINT_STATE_INVALID: this move of the status is not allowed' USING ERRCODE = '23514';
  END IF;
  -- An answer is given once for a status: what was answered is not rewritten while the status stays.
  IF NEW.status = OLD.status AND OLD.resolved_on IS NOT NULL AND (NEW.resolved_on, NEW.resolved_by, NEW.resolution_note, NEW.resolution_document_version_id) IS DISTINCT FROM (OLD.resolved_on, OLD.resolved_by, OLD.resolution_note, OLD.resolution_document_version_id) THEN
    RAISE EXCEPTION 'COMPLAINT_STATE_INVALID: an answer is not rewritten' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER land_complaint_guard BEFORE INSERT OR UPDATE ON machvon.land_complaint
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_land_complaint();

-- Whether another complaint than the one given still holds a parcel, whatever unit the caller reaches: a parcel is given back only when the last complaint that holds it lets it go. It answers only for the tenant
-- of the transaction, widens the scope while it runs and puts the caller's back before it returns, and gives a yes or no.
CREATE FUNCTION machvon.parcel_held_by_another(p_parcel uuid, p_complaint uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = machvon, pg_temp
AS $fn$
DECLARE
  previous text := current_setting('app.scope_units', true);
  held boolean;
BEGIN
  PERFORM set_config('app.scope_units', '*', true);
  SELECT EXISTS (
    SELECT 1 FROM machvon.land_complaint_hold h
     WHERE h.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid AND h.parcel_id = p_parcel AND h.released_at IS NULL AND h.complaint_id <> p_complaint
  ) INTO held;
  PERFORM set_config('app.scope_units', coalesce(previous, ''), true);
  RETURN held;
END;
$fn$;

REVOKE ALL ON FUNCTION machvon.parcel_held_by_another(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION machvon.parcel_held_by_another(uuid, uuid) TO machvon_app;
