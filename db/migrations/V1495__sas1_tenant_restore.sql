-- ST-SAS-019 (SAS.md 3.11, BR-SAS-12): the restore of one tenant to a recovery point, into a sandbox or over its own data.
-- V002 gave `tenant_restore_request` with the target, the reason, the status and the four-eyes rule that the approver is not the requester. What a restore needs to stay controlled is put into the database here,
-- whatever the application checked first:
--   * what was asked for never changes (the recovery point, the target, the reason, who asked and when), and what was decided never changes: the person who decided is not the one who asked, whichever way they decided
--     (the approver is the person who decided, and only an approved request has one);
--   * a request moves only forward (Requested to Approved or Rejected; Approved to Restoring; Restoring to Verifying; Verifying to Completed; any running state to Failed), and every other state is final; nothing deletes one;
--   * a restore is Completed only with a verification report that matched (rows, checksum and money totals of every table, no row of another tenant), whose sha256 is the reference kept with it: this is the record of the drill;
--   * a copy placed in a sandbox is named by `sandbox_ref`, and only a sandbox restore has one;
--   * at most one in-place restore of a tenant is not finished: it overwrites the data of the tenant, so the next one waits.

ALTER TABLE machvon.tenant_restore_request ADD COLUMN requested_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE machvon.tenant_restore_request ADD COLUMN decided_by uuid;
ALTER TABLE machvon.tenant_restore_request ADD COLUMN decided_at timestamptz;
ALTER TABLE machvon.tenant_restore_request ADD COLUMN decision_reason text;
ALTER TABLE machvon.tenant_restore_request ADD COLUMN started_at timestamptz;
ALTER TABLE machvon.tenant_restore_request ADD COLUMN completed_at timestamptz;
ALTER TABLE machvon.tenant_restore_request ADD COLUMN restored_to timestamptz;
ALTER TABLE machvon.tenant_restore_request ADD COLUMN sandbox_ref text;
ALTER TABLE machvon.tenant_restore_request ADD COLUMN verification_report jsonb;
ALTER TABLE machvon.tenant_restore_request ADD COLUMN error_code text;

ALTER TABLE machvon.tenant_restore_request
  ADD CONSTRAINT tenant_restore_request_decider_ck CHECK (decided_by IS NULL OR decided_by <> requested_by),
  ADD CONSTRAINT tenant_restore_request_decision_ck CHECK (
    (status = 'Requested' AND decided_by IS NULL AND decided_at IS NULL AND decision_reason IS NULL AND approved_by IS NULL)
    OR (status = 'Rejected' AND decided_by IS NOT NULL AND decided_at IS NOT NULL AND decision_reason IS NOT NULL AND approved_by IS NULL)
    OR (status NOT IN ('Requested', 'Rejected') AND decided_by IS NOT NULL AND decided_at IS NOT NULL AND decision_reason IS NOT NULL AND approved_by = decided_by)
  ),
  ADD CONSTRAINT tenant_restore_request_run_ck CHECK (
    (status NOT IN ('Restoring', 'Verifying', 'Completed') OR started_at IS NOT NULL)
    AND ((status IN ('Completed', 'Failed')) = (completed_at IS NOT NULL))
    AND ((status = 'Failed') = (error_code IS NOT NULL))
    AND (status NOT IN ('Requested', 'Approved', 'Rejected') OR (started_at IS NULL AND restored_to IS NULL AND sandbox_ref IS NULL AND verification_report IS NULL))
  ),
  ADD CONSTRAINT tenant_restore_request_report_ck CHECK (
    (status <> 'Completed' OR (verification_report IS NOT NULL AND verification_report_ref IS NOT NULL AND restored_to IS NOT NULL AND (verification_report ->> 'matched') = 'true'))
    AND ((verification_report IS NULL) = (verification_report_ref IS NULL))
  ),
  ADD CONSTRAINT tenant_restore_request_sandbox_ck CHECK (sandbox_ref IS NULL OR target = 'SANDBOX');

-- One in-place restore at a time for a tenant: a second request while one is not finished is 409 RESTORE_IN_PROGRESS. Sandbox restores are copies and run side by side.
CREATE UNIQUE INDEX tenant_restore_request_in_place_open_uq ON machvon.tenant_restore_request (tenant_id) WHERE target = 'IN_PLACE' AND status IN ('Requested', 'Approved', 'Restoring', 'Verifying');
CREATE INDEX tenant_restore_request_list_idx ON machvon.tenant_restore_request (tenant_id, requested_at DESC, id DESC);
-- The worker finds what waits for it and what runs without reading every row.
CREATE INDEX tenant_restore_request_open_idx ON machvon.tenant_restore_request (tenant_id, status, requested_at) WHERE status IN ('Approved', 'Restoring', 'Verifying');

CREATE FUNCTION machvon.guard_tenant_restore_request() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'RESTORE_IMMUTABLE: a restore request is never deleted' USING ERRCODE = '23514';
  END IF;
  IF (NEW.tenant_id, NEW.id, NEW.recovery_point, NEW.target, NEW.reason, NEW.requested_by, NEW.requested_at)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.id, OLD.recovery_point, OLD.target, OLD.reason, OLD.requested_by, OLD.requested_at) THEN
    RAISE EXCEPTION 'RESTORE_IMMUTABLE: what was asked for does not change' USING ERRCODE = '23514';
  END IF;
  IF OLD.status IN ('Completed', 'Failed', 'Rejected') THEN
    RAISE EXCEPTION 'RESTORE_IMMUTABLE: a restore that has ended does not change' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'Requested' AND NEW.status IN ('Approved', 'Rejected'))
    OR (OLD.status = 'Approved' AND NEW.status IN ('Restoring', 'Failed'))
    OR (OLD.status = 'Restoring' AND NEW.status IN ('Verifying', 'Failed'))
    OR (OLD.status = 'Verifying' AND NEW.status IN ('Completed', 'Failed'))) THEN
    RAISE EXCEPTION 'RESTORE_IMMUTABLE: a restore does not go from % to %', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'Requested' AND (NEW.decided_by, NEW.decided_at, NEW.decision_reason, NEW.approved_by) IS DISTINCT FROM (OLD.decided_by, OLD.decided_at, OLD.decision_reason, OLD.approved_by) THEN
    RAISE EXCEPTION 'RESTORE_IMMUTABLE: what was decided does not change' USING ERRCODE = '23514';
  END IF;
  IF OLD.verification_report IS NOT NULL AND (NEW.verification_report, NEW.verification_report_ref, NEW.restored_to) IS DISTINCT FROM (OLD.verification_report, OLD.verification_report_ref, OLD.restored_to) THEN
    RAISE EXCEPTION 'RESTORE_IMMUTABLE: the verification report does not change' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER tenant_restore_request_guard BEFORE UPDATE OR DELETE ON machvon.tenant_restore_request
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_tenant_restore_request();
REVOKE DELETE, TRUNCATE ON TABLE machvon.tenant_restore_request FROM machvon_app, machvon_control;

-- The control plane asks, decides and reads the restores of the tenant it acts as (SAS-21).
GRANT SELECT, INSERT, UPDATE ON TABLE machvon.tenant_restore_request TO machvon_control;

-- The decision names only the restore request: the control plane finds its tenant by the id alone, as it does for an override and a subscription.
CREATE FUNCTION machvon.restore_tenant_of(p_restore uuid)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = machvon, pg_temp
AS $fn$
DECLARE
  previous text := current_setting('app.tenant_id', true);
  one_tenant record;
  owner_id uuid;
BEGIN
  FOR one_tenant IN SELECT t.id FROM machvon.tenant t ORDER BY t.id LOOP
    PERFORM set_config('app.tenant_id', one_tenant.id::text, true);
    IF EXISTS (SELECT 1 FROM machvon.tenant_restore_request r WHERE r.tenant_id = one_tenant.id AND r.id = p_restore) THEN
      owner_id := one_tenant.id;
      EXIT;
    END IF;
  END LOOP;
  PERFORM set_config('app.tenant_id', coalesce(previous, ''), true);
  RETURN owner_id;
END;
$fn$;
REVOKE ALL ON FUNCTION machvon.restore_tenant_of(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION machvon.restore_tenant_of(uuid) TO machvon_control;
