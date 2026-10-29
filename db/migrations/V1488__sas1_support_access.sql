-- ST-SAS-015 (SAS.md 3.9, BR-SAS-16): controlled support access with the consent of the tenant.
-- V002 and V1xxx gave `support_access_grant` its columns and the 8-hour window. What was missing is what makes a grant a record the tenant can trust:
--   * a read-write grant holds its two approvers only once it is approved, so the check on them must not refuse a request that has none yet;
--   * what a grant says about who asked, for what and for how long never changes after the request, and an approval is never taken back;
--   * a grant that ended (Expired, Revoked, Rejected) is final, and nothing deletes one;
--   * an operator has one open grant for a ticket of a tenant at a time (a new request after one ended is how an access is extended).
-- The control plane writes the request (it acts as the tenant), the tenant approves and revokes.

ALTER TABLE machvon.support_access_grant DROP CONSTRAINT support_access_grant_rw_ck;
ALTER TABLE machvon.support_access_grant ADD CONSTRAINT support_access_grant_rw_ck CHECK (
  access_mode = 'READ_ONLY' OR status IN ('Requested', 'Rejected', 'Revoked', 'Expired')
  OR (owner_approved_by IS NOT NULL AND second_approver_id IS NOT NULL AND second_approver_id <> owner_approved_by)
);
-- A grant in force names who approved it and when it starts.
ALTER TABLE machvon.support_access_grant ADD CONSTRAINT support_access_grant_approved_ck CHECK (
  status NOT IN ('Approved', 'Active') OR (owner_approved_by IS NOT NULL AND starts_at IS NOT NULL)
);
ALTER TABLE machvon.support_access_grant ADD CONSTRAINT support_access_grant_revoked_ck CHECK ((status = 'Revoked') = (revoked_at IS NOT NULL));
ALTER TABLE machvon.support_access_grant ADD CONSTRAINT support_access_grant_second_ck CHECK (second_approver_id IS NULL OR owner_approved_by IS NOT NULL);
ALTER TABLE machvon.support_access_grant ADD CONSTRAINT support_access_grant_ticket_ck CHECK (length(btrim(ticket_reference)) >= 3);

CREATE UNIQUE INDEX support_access_grant_open_uq ON machvon.support_access_grant (tenant_id, operator_id, lower(ticket_reference)) WHERE status IN ('Requested', 'Approved', 'Active');
CREATE INDEX support_access_grant_status_idx ON machvon.support_access_grant (tenant_id, status, expires_at);

CREATE FUNCTION machvon.guard_support_access_grant() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'SUPPORT_GRANT_IMMUTABLE: a support access grant is never deleted' USING ERRCODE = '23514';
  END IF;
  IF OLD.status IN ('Expired', 'Revoked', 'Rejected') THEN
    RAISE EXCEPTION 'SUPPORT_GRANT_IMMUTABLE: a grant that ended does not change' USING ERRCODE = '23514';
  END IF;
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.id <> OLD.id OR NEW.operator_id <> OLD.operator_id OR NEW.ticket_reference <> OLD.ticket_reference
     OR NEW.scope_json <> OLD.scope_json OR NEW.access_mode <> OLD.access_mode OR NEW.request_reason <> OLD.request_reason OR NEW.requested_at <> OLD.requested_at THEN
    RAISE EXCEPTION 'SUPPORT_GRANT_IMMUTABLE: what was asked for does not change' USING ERRCODE = '23514';
  END IF;
  -- An approval is not taken back and not handed to somebody else; the window is fixed at the approval that completes the grant.
  IF (OLD.owner_approved_by IS NOT NULL AND NEW.owner_approved_by IS DISTINCT FROM OLD.owner_approved_by)
     OR (OLD.second_approver_id IS NOT NULL AND NEW.second_approver_id IS DISTINCT FROM OLD.second_approver_id)
     OR (OLD.starts_at IS NOT NULL AND (NEW.starts_at IS DISTINCT FROM OLD.starts_at OR NEW.expires_at IS DISTINCT FROM OLD.expires_at)) THEN
    RAISE EXCEPTION 'SUPPORT_GRANT_IMMUTABLE: an approval does not change' USING ERRCODE = '23514';
  END IF;
  IF OLD.status IN ('Approved', 'Active') AND NEW.status = 'Requested' THEN
    RAISE EXCEPTION 'SUPPORT_GRANT_IMMUTABLE: a grant in force is not asked for again' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'Active' AND NEW.status = 'Approved' THEN
    RAISE EXCEPTION 'SUPPORT_GRANT_IMMUTABLE: a grant in force does not wait again' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER support_access_grant_guard BEFORE UPDATE OR DELETE ON machvon.support_access_grant FOR EACH ROW EXECUTE FUNCTION machvon.guard_support_access_grant();

REVOKE DELETE, TRUNCATE ON TABLE machvon.support_access_grant FROM machvon_app;
-- The control plane makes the request acting as the tenant, and reads the ticket it names.
GRANT SELECT, INSERT, UPDATE ON TABLE machvon.support_access_grant TO machvon_control;
REVOKE DELETE, TRUNCATE ON TABLE machvon.support_access_grant FROM machvon_control;
GRANT SELECT ON TABLE machvon.support_ticket TO machvon_control;
