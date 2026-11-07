-- Authored by hand (not generated): the guard of the exceptions to the separation of duties (G4-1). Whatever the application does, an exception keeps who it is for, which pair, which subject, which days and why (only its status, its counter and
-- the revocation move change); it is approved only when `approvers_needed` distinct approvers said yes; it never leaves REJECTED or REVOKED; and an approver is never the person who asked nor the person it covers, and decides only while the
-- exception is asked. The owner role (migrations, repairs) passes.

CREATE FUNCTION machvon.guard_sod_exception() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_mutable constant text[] := ARRAY['status', 'approvals', 'decided_at', 'revoked_by', 'revoked_at', 'revoke_reason', 'version', 'updated_at'];
  v_yes integer;
BEGIN
  IF current_user = 'machvon_owner' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'an exception to the separation of duties is never deleted (% by %)', TG_OP, current_user USING ERRCODE = '42501';
  END IF;
  IF (to_jsonb(NEW) - v_mutable) IS DISTINCT FROM (to_jsonb(OLD) - v_mutable) THEN
    RAISE EXCEPTION 'the content of an exception to the separation of duties never changes: ask for a new one' USING ERRCODE = '42501';
  END IF;
  IF NOT (
    OLD.status = NEW.status
    OR (OLD.status = 'REQUESTED' AND NEW.status IN ('APPROVED', 'REJECTED', 'REVOKED'))
    OR (OLD.status = 'APPROVED' AND NEW.status = 'REVOKED')
  ) THEN
    RAISE EXCEPTION 'an exception cannot move from % to %', OLD.status, NEW.status USING ERRCODE = '42501';
  END IF;
  IF NEW.approvals < OLD.approvals THEN
    RAISE EXCEPTION 'the approvals of an exception never go down' USING ERRCODE = '42501';
  END IF;
  SELECT count(*) INTO v_yes FROM machvon.sod_exception_approval a WHERE a.tenant_id = NEW.tenant_id AND a.exception_id = NEW.id AND a.decision = 'APPROVE';
  IF NEW.approvals <> v_yes THEN
    RAISE EXCEPTION 'the counter of approvals (%) does not agree with the approvals kept (%)', NEW.approvals, v_yes USING ERRCODE = '42501';
  END IF;
  IF NEW.status = 'APPROVED' AND OLD.status <> 'APPROVED' AND v_yes < NEW.approvers_needed THEN
    RAISE EXCEPTION 'an exception needs % approvers, % agreed', NEW.approvers_needed, v_yes USING ERRCODE = '42501';
  END IF;
  IF NEW.status = 'REJECTED' AND OLD.status <> 'REJECTED' AND NOT EXISTS (
    SELECT 1 FROM machvon.sod_exception_approval a WHERE a.tenant_id = NEW.tenant_id AND a.exception_id = NEW.id AND a.decision = 'REJECT'
  ) THEN
    RAISE EXCEPTION 'an exception is rejected by a decision of an approver' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER sod_exception_guard BEFORE UPDATE OR DELETE ON machvon.sod_exception
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_sod_exception();

CREATE FUNCTION machvon.guard_sod_exception_approval() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_exception machvon.sod_exception%ROWTYPE;
BEGIN
  IF current_user = 'machvon_owner' THEN
    RETURN NEW;
  END IF;
  SELECT * INTO v_exception FROM machvon.sod_exception e WHERE e.tenant_id = NEW.tenant_id AND e.id = NEW.exception_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the exception is not there' USING ERRCODE = '23503';
  END IF;
  IF v_exception.status <> 'REQUESTED' THEN
    RAISE EXCEPTION 'only an exception that is asked takes a decision (it is %)', v_exception.status USING ERRCODE = '42501';
  END IF;
  IF NEW.approver_id = v_exception.requested_by OR NEW.approver_id = v_exception.member_id THEN
    RAISE EXCEPTION 'the person who asked and the person an exception covers do not decide it' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER sod_exception_approval_guard BEFORE INSERT ON machvon.sod_exception_approval
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_sod_exception_approval();
