-- Authored by hand (not generated): who answers for a project and the task forces that press its disbursement (ST-PRJ-005, PRJ 3.1 F9, BR-PRJ-10).
-- The three tables came with the baseline; this migration makes them a record that the database itself keeps honest:
--   * the periods in which one role of one project is held do not overlap (BR-PRJ-10); the partial unique index of the baseline already allows one ACTIVE
--     LEADER_IN_CHARGE, this adds the rule for the dates and for the other roles, so a late entry cannot put two people on the same role at the same time;
--   * an assignment, a task force and a member are written once and ended once: the columns that say who, what and since when never change, and a row that has
--     ended never changes again, so the history shows what was true on any day;
--   * a dissolved task force takes no new member;
--   * the runtime role cannot delete or truncate them (retention: the assignments for good, the task forces ten years; no command erases either).

ALTER TABLE machvon.project_accountability ADD CONSTRAINT project_accountability_window_chk CHECK (valid_until IS NULL OR valid_until >= valid_from);
-- An assignment that has not ended has no end date; the end date and the reason come together when it ends (the baseline already requires them).
ALTER TABLE machvon.project_accountability ADD CONSTRAINT project_accountability_active_open_chk CHECK (status <> 'ACTIVE' OR (valid_until IS NULL AND end_reason IS NULL));
ALTER TABLE machvon.project_accountability ADD CONSTRAINT project_accountability_no_overlap
  EXCLUDE USING gist (tenant_id WITH =, project_id WITH =, accountability_role WITH =, daterange(valid_from, valid_until, '[]') WITH &&);

ALTER TABLE machvon.task_force ADD CONSTRAINT task_force_window_chk CHECK (valid_until IS NULL OR valid_until >= valid_from);
ALTER TABLE machvon.task_force ADD CONSTRAINT task_force_status_window_chk CHECK ((status = 'ACTIVE' AND valid_until IS NULL) OR (status = 'DISSOLVED' AND valid_until IS NOT NULL));
ALTER TABLE machvon.task_force ADD CONSTRAINT task_force_code_chk CHECK (code = btrim(code) AND code <> '');

ALTER TABLE machvon.task_force_member ADD CONSTRAINT task_force_member_window_chk CHECK (valid_until IS NULL OR valid_until >= valid_from);

CREATE FUNCTION machvon.guard_project_accountability() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF OLD.status = 'ENDED' THEN
    RAISE EXCEPTION 'an ended assignment is never changed' USING ERRCODE = '23514';
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.id IS DISTINCT FROM OLD.id OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.leader_membership_id IS DISTINCT FROM OLD.leader_membership_id OR NEW.accountability_role IS DISTINCT FROM OLD.accountability_role
     OR NEW.assignment_document_id IS DISTINCT FROM OLD.assignment_document_id OR NEW.valid_from IS DISTINCT FROM OLD.valid_from
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'who holds a role of a project, and since when, is never changed: end the assignment and make a new one' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER project_accountability_guard BEFORE UPDATE ON machvon.project_accountability
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_project_accountability();

CREATE FUNCTION machvon.guard_task_force() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF OLD.status = 'DISSOLVED' THEN
    RAISE EXCEPTION 'a dissolved task force is never changed' USING ERRCODE = '23514';
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.id IS DISTINCT FROM OLD.id OR NEW.code IS DISTINCT FROM OLD.code OR NEW.name IS DISTINCT FROM OLD.name
     OR NEW.purpose IS DISTINCT FROM OLD.purpose OR NEW.lead_membership_id IS DISTINCT FROM OLD.lead_membership_id OR NEW.scope_unit_id IS DISTINCT FROM OLD.scope_unit_id
     OR NEW.establishment_document_id IS DISTINCT FROM OLD.establishment_document_id OR NEW.valid_from IS DISTINCT FROM OLD.valid_from
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'the code, the scope, the lead and the founding of a task force are never changed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER task_force_guard BEFORE UPDATE ON machvon.task_force
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_task_force();

CREATE FUNCTION machvon.guard_task_force_member() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  parent_status text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT status INTO parent_status FROM machvon.task_force WHERE tenant_id = NEW.tenant_id AND id = NEW.task_force_id FOR SHARE;
    IF parent_status IS DISTINCT FROM 'ACTIVE' THEN
      RAISE EXCEPTION 'a task force that is not active takes no member' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.valid_until IS NOT NULL THEN
    RAISE EXCEPTION 'a member whose term has ended is never changed' USING ERRCODE = '23514';
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.id IS DISTINCT FROM OLD.id OR NEW.task_force_id IS DISTINCT FROM OLD.task_force_id
     OR NEW.membership_id IS DISTINCT FROM OLD.membership_id OR NEW.member_role IS DISTINCT FROM OLD.member_role OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.valid_from IS DISTINCT FROM OLD.valid_from OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'who sits in a task force, in which role and since when, is never changed: end the term and make a new one' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER task_force_member_guard BEFORE INSERT OR UPDATE ON machvon.task_force_member
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_task_force_member();

REVOKE DELETE, TRUNCATE ON TABLE machvon.project_accountability FROM machvon_app;
REVOKE DELETE, TRUNCATE ON TABLE machvon.task_force FROM machvon_app;
REVOKE DELETE, TRUNCATE ON TABLE machvon.task_force_member FROM machvon_app;
