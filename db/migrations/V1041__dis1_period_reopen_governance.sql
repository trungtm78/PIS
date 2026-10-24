-- Authored by hand (not generated): the governance of the reopening of a locked reporting period (ST-DIS-002, DIS 3 F4, BR-DIS-09).
-- V002 gave period_reopen its scope, reason, requester, approver and window. What a request still lacked is the window the requester asked
-- for, the person and the reason of the decision (an approval and a rejection are both decisions), the rules that make the status machine
-- the one way a request moves (REQUESTED to APPROVED or REJECTED, APPROVED to EXPIRED or CLOSED) and the evidence kept for good.
-- A reopening never changes reporting_period: a locked period stays LOCKED and the reopening only lets the named scope submit until the window ends.

-- The window the requester asked for, in hours (the contract allows 1 to 168). The window that was granted is window_until less decided_at.
ALTER TABLE machvon.period_reopen ADD COLUMN requested_window_hours integer;
ALTER TABLE machvon.period_reopen
  ADD CONSTRAINT period_reopen_requested_window_chk CHECK (requested_window_hours IS NOT NULL AND requested_window_hours BETWEEN 1 AND 168);

-- Who decided, when and why. For an approval decided_by is the approver (approved_by keeps the name the module document uses), for a rejection
-- approved_by stays empty.
ALTER TABLE machvon.period_reopen ADD COLUMN decided_by uuid;
ALTER TABLE machvon.period_reopen ADD COLUMN decided_at timestamptz;
ALTER TABLE machvon.period_reopen ADD COLUMN decision_reason text;

-- The texts are kept as they were typed after trimming; V002 already requires a reason of 20 characters.
ALTER TABLE machvon.period_reopen
  ADD CONSTRAINT period_reopen_reason_text_chk CHECK (reason = btrim(reason) AND length(reason) <= 2000);
ALTER TABLE machvon.period_reopen
  ADD CONSTRAINT period_reopen_decision_reason_chk CHECK (decision_reason IS NULL OR (decision_reason = btrim(decision_reason) AND length(decision_reason) BETWEEN 5 AND 2000));

-- A request for the whole period names no project, a request for projects names at least one (V002) and a bounded number.
ALTER TABLE machvon.period_reopen
  ADD CONSTRAINT period_reopen_scope_projects_chk CHECK ((scope_kind = 'PERIOD' AND scope_project_ids IS NULL) OR (scope_kind = 'PROJECTS' AND cardinality(scope_project_ids) BETWEEN 1 AND 500));

-- The shape of each status. A request waits with no decision; a rejection has a decision and no window; an approval, and the expiry or closing
-- that follows it, has a decision, an approver who is the decider and a window that starts after the decision and lasts at most 168 hours.
ALTER TABLE machvon.period_reopen
  ADD CONSTRAINT period_reopen_status_shape_chk CHECK (
    (status = 'REQUESTED' AND approved_by IS NULL AND decided_by IS NULL AND decided_at IS NULL AND decision_reason IS NULL AND window_until IS NULL)
    OR (status = 'REJECTED' AND approved_by IS NULL AND decided_by IS NOT NULL AND decided_at IS NOT NULL AND decision_reason IS NOT NULL AND window_until IS NULL)
    OR (status IN ('APPROVED', 'EXPIRED', 'CLOSED') AND approved_by IS NOT NULL AND approved_by = decided_by AND decided_at IS NOT NULL AND decision_reason IS NOT NULL
        AND window_until IS NOT NULL AND window_until > decided_at AND window_until <= decided_at + interval '168 hours')
  );

-- Separation of duties (BR-DIS-09) for an approval and for a rejection alike: whoever asked does not decide.
ALTER TABLE machvon.period_reopen
  ADD CONSTRAINT period_reopen_decider_sod_chk CHECK (decided_by IS NULL OR decided_by <> requested_by);

-- The job that marks the lapsed windows looks only at the approved ones.
CREATE INDEX period_reopen_approved_window_idx ON machvon.period_reopen (tenant_id, window_until) WHERE status = 'APPROVED';

-- Kept for good (retention in the module document: 10 years, and an audit row or a report names the request later).
REVOKE DELETE, TRUNCATE ON TABLE machvon.period_reopen FROM machvon_app;

-- A request is born REQUESTED, for a period that is locked, naming each project once.
CREATE FUNCTION machvon.guard_period_reopen_insert() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  period_status text;
BEGIN
  IF NEW.status IS DISTINCT FROM 'REQUESTED' OR NEW.version IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'a request to reopen a period is born REQUESTED at version 1' USING ERRCODE = '23514';
  END IF;
  SELECT p.status INTO period_status FROM machvon.reporting_period p WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.period_id;
  IF period_status IS DISTINCT FROM 'LOCKED' THEN
    RAISE EXCEPTION 'only a locked reporting period is reopened' USING ERRCODE = '23514';
  END IF;
  IF NEW.scope_project_ids IS NOT NULL THEN
    IF array_position(NEW.scope_project_ids, NULL) IS NOT NULL
       OR (SELECT count(DISTINCT id) FROM unnest(NEW.scope_project_ids) AS u(id)) <> cardinality(NEW.scope_project_ids) THEN
      RAISE EXCEPTION 'a request names each project once' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER period_reopen_insert_guard BEFORE INSERT ON machvon.period_reopen
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_period_reopen_insert();

-- What was asked for never changes; a request moves only REQUESTED to APPROVED or REJECTED and APPROVED to EXPIRED or CLOSED, each step
-- raising the version by one; a decision is never rewritten.
CREATE FUNCTION machvon.guard_period_reopen_update() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.period_id IS DISTINCT FROM OLD.period_id
     OR NEW.scope_kind IS DISTINCT FROM OLD.scope_kind
     OR NEW.scope_project_ids IS DISTINCT FROM OLD.scope_project_ids
     OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
     OR NEW.requested_window_hours IS DISTINCT FROM OLD.requested_window_hours
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'what was asked for in a request to reopen a period never changes' USING ERRCODE = '23514';
  END IF;
  IF NOT ((OLD.status = 'REQUESTED' AND NEW.status IN ('APPROVED', 'REJECTED')) OR (OLD.status = 'APPROVED' AND NEW.status IN ('EXPIRED', 'CLOSED'))) THEN
    RAISE EXCEPTION 'a request to reopen a period moves only from REQUESTED to APPROVED or REJECTED and from APPROVED to EXPIRED or CLOSED' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'APPROVED' AND (NEW.approved_by IS DISTINCT FROM OLD.approved_by
     OR NEW.decided_by IS DISTINCT FROM OLD.decided_by
     OR NEW.decided_at IS DISTINCT FROM OLD.decided_at
     OR NEW.decision_reason IS DISTINCT FROM OLD.decision_reason
     OR NEW.window_until IS DISTINCT FROM OLD.window_until) THEN
    RAISE EXCEPTION 'the decision on a request to reopen a period never changes' USING ERRCODE = '23514';
  END IF;
  IF NEW.version IS DISTINCT FROM OLD.version + 1 THEN
    RAISE EXCEPTION 'a change of a request to reopen a period raises its version by one' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER period_reopen_update_guard BEFORE UPDATE ON machvon.period_reopen
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_period_reopen_update();
