-- Authored by hand (not generated): the independent verification, the closure, the reopening and the bounded extension of an issue
-- (ST-ISS-003, ISS 3.1 steps 4 to 7, BR-ISS-04, BR-ISS-05).
-- V1061 holds the state machine and the parts of an issue that never change. This adds what the closure relies on, so that the database
-- holds what the application checked first:
--   * an issue is closed by the person who verified it, and only an issue that is closed carries the day and the person of the closure;
--   * an issue is closed only after a request for verification, and with evidence when the policy it was opened under asks for it;
--   * the deadline moves only by an extension: later, and counted (extension_count), so no statement can stretch a deadline in silence;
--   * a reopening is counted once, by the move from CLOSED to REOPENED, and by nothing else.
-- The limit of extensions and the window of a reopening are tenant rules that have not been signed (R-ISS-01): the application holds them, the
-- database holds the shape of the rule, not its number.

ALTER TABLE machvon.issue
  ADD COLUMN extension_count integer NOT NULL DEFAULT 0;

ALTER TABLE machvon.issue
  ADD CONSTRAINT issue_extension_count_chk CHECK (extension_count >= 0),
  -- BR-ISS-05: the person who closes is the verifier (issue_verifier_chk of the generated schema keeps the verifier apart from the assignee).
  ADD CONSTRAINT issue_closer_chk CHECK (closed_by IS NULL OR verifier_id IS NULL OR closed_by = verifier_id),
  -- Only a closed issue has a closure: a reopened issue gives its closed_at, closed_by and verifier_id back (the CLOSED event keeps them).
  ADD CONSTRAINT issue_closed_fields_chk CHECK (status = 'CLOSED' OR (closed_at IS NULL AND closed_by IS NULL AND verifier_id IS NULL));

-- The guard of V1061 with three more rules. It is replaced as a whole, so the clauses of V1061 are repeated unchanged.
CREATE OR REPLACE FUNCTION machvon.guard_issue_update() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  requested jsonb;
  evidence_required boolean;
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.code IS DISTINCT FROM OLD.code
     OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.contract_id IS DISTINCT FROM OLD.contract_id
     OR NEW.category_version_id IS DISTINCT FROM OLD.category_version_id
     OR NEW.severity IS DISTINCT FROM OLD.severity
     OR NEW.source_module IS DISTINCT FROM OLD.source_module
     OR NEW.source_ref_id IS DISTINCT FROM OLD.source_ref_id
     OR NEW.sla_policy_id IS DISTINCT FROM OLD.sla_policy_id
     OR NEW.reported_by IS DISTINCT FROM OLD.reported_by
     OR NEW.opened_at IS DISTINCT FROM OLD.opened_at
     OR NEW.response_due_at IS DISTINCT FROM OLD.response_due_at
     OR NEW.geo_lat IS DISTINCT FROM OLD.geo_lat
     OR NEW.geo_lng IS DISTINCT FROM OLD.geo_lng
     OR NEW.geo_accuracy_m IS DISTINCT FROM OLD.geo_accuracy_m
     OR NEW.geo_consent IS DISTINCT FROM OLD.geo_consent
     OR NEW.client_operation_id IS DISTINCT FROM OLD.client_operation_id
     OR NEW.client_request_hash IS DISTINCT FROM OLD.client_request_hash
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'the origin of an issue and the deadline the SLA fixed for it never change' USING ERRCODE = '23514';
  END IF;
  IF OLD.overdue_since IS NOT NULL AND NEW.overdue_since IS DISTINCT FROM OLD.overdue_since THEN
    RAISE EXCEPTION 'the day an issue became overdue is kept (BR-ISS-04)' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND (OLD.status, NEW.status) NOT IN (
    ('OPEN', 'ASSIGNED'),
    ('ASSIGNED', 'IN_PROGRESS'),
    ('ASSIGNED', 'ESCALATED'),
    ('IN_PROGRESS', 'ASSIGNED'),
    ('IN_PROGRESS', 'ESCALATED'),
    ('IN_PROGRESS', 'PENDING_VERIFICATION'),
    ('ESCALATED', 'IN_PROGRESS'),
    ('PENDING_VERIFICATION', 'CLOSED'),
    ('PENDING_VERIFICATION', 'ASSIGNED'),
    ('CLOSED', 'REOPENED'),
    ('REOPENED', 'ASSIGNED')
  ) THEN
    RAISE EXCEPTION 'an issue does not move from % to %', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;

  -- The deadline moves only by an extension: later than it was, and counted once. An extension count that moved alone is as wrong as a deadline that did.
  IF NEW.due_at IS DISTINCT FROM OLD.due_at THEN
    IF NEW.due_at <= OLD.due_at OR NEW.extension_count <> OLD.extension_count + 1 THEN
      RAISE EXCEPTION 'the deadline of an issue moves only later, by a counted extension' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.extension_count IS DISTINCT FROM OLD.extension_count THEN
    RAISE EXCEPTION 'an extension is counted only with the deadline it moves' USING ERRCODE = '23514';
  END IF;

  -- A reopening is counted by the move from CLOSED to REOPENED and by nothing else.
  IF NEW.reopen_count IS DISTINCT FROM OLD.reopen_count
     AND NOT (OLD.status = 'CLOSED' AND NEW.status = 'REOPENED' AND NEW.reopen_count = OLD.reopen_count + 1) THEN
    RAISE EXCEPTION 'a reopening is counted only by the move from CLOSED to REOPENED' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'CLOSED' AND NEW.status = 'REOPENED' AND NEW.reopen_count <> OLD.reopen_count + 1 THEN
    RAISE EXCEPTION 'a reopening is counted' USING ERRCODE = '23514';
  END IF;

  -- BR-ISS-05 and UAT-AC351: an issue is closed after a request for verification, and with evidence when its policy asks for it.
  -- (A closing that names no closer or no verifier is left to issue_close_chk, which says exactly that.)
  IF NEW.status = 'CLOSED' AND OLD.status IS DISTINCT FROM 'CLOSED' AND NEW.closed_by IS NOT NULL AND NEW.verifier_id IS NOT NULL THEN
    SELECT e.payload INTO requested
      FROM machvon.issue_event e
     WHERE e.tenant_id = NEW.tenant_id AND e.issue_id = NEW.id AND e.event_kind = 'VERIFICATION_REQUESTED'
     ORDER BY e.created_at DESC, e.id DESC
     LIMIT 1;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'an issue is closed only after a request for verification' USING ERRCODE = '23514';
    END IF;
    SELECT p.require_evidence INTO evidence_required
      FROM machvon.issue_sla_policy p
     WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.sla_policy_id;
    IF coalesce(evidence_required, true)
       AND (jsonb_typeof(requested -> 'evidence_document_version_ids') IS DISTINCT FROM 'array'
            OR jsonb_array_length(requested -> 'evidence_document_version_ids') = 0) THEN
      RAISE EXCEPTION 'the policy of this issue asks for evidence before it is closed' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$;
