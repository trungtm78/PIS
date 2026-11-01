-- Authored by hand (not generated): the shares of a dashboard (ST-BI-007, BI.md F6).
-- V002 gave the table and the one active grant per dashboard and grantee; what a share stands on is put into the database here, whatever the application checked first:
--   * a share is made once and only ends: who and what it is shared with, the permission and who shared never change, and ACTIVE moves to REVOKED once, with the moment it ended (an ACTIVE share has no such moment);
--   * a share that ended is never made active again, and nothing is deleted: a new share is a new row.

ALTER TABLE machvon.dashboard_share
  ADD CONSTRAINT dashboard_share_revoked_chk CHECK ((status = 'ACTIVE' AND revoked_at IS NULL) OR (status = 'REVOKED' AND revoked_at IS NOT NULL)) NOT VALID;

CREATE FUNCTION machvon.guard_dashboard_share() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF current_user = 'machvon_owner' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'dashboard shares are never deleted (% on %.% by %)', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME, current_user USING ERRCODE = '42501';
  END IF;
  IF (NEW.dashboard_id, NEW.grantee_kind, NEW.grantee_ref_id, NEW.permission, NEW.created_by, NEW.created_at) IS DISTINCT FROM (OLD.dashboard_id, OLD.grantee_kind, OLD.grantee_ref_id, OLD.permission, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'what a dashboard is shared with, and the permission, never change' USING ERRCODE = '42501';
  END IF;
  IF NOT (OLD.status = NEW.status OR (OLD.status = 'ACTIVE' AND NEW.status = 'REVOKED')) THEN
    RAISE EXCEPTION 'a dashboard share cannot move from % to %', OLD.status, NEW.status USING ERRCODE = '42501';
  END IF;
  IF OLD.status = 'REVOKED' AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'when a dashboard share ended is written once' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER dashboard_share_guard BEFORE UPDATE OR DELETE ON machvon.dashboard_share
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_dashboard_share();
CREATE TRIGGER dashboard_share_no_truncate BEFORE TRUNCATE ON machvon.dashboard_share
  FOR EACH STATEMENT EXECUTE FUNCTION machvon.guard_dashboard_share();

REVOKE DELETE, TRUNCATE ON TABLE machvon.dashboard_share FROM machvon_app;
