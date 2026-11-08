-- Authored by hand (not generated): an administrator acting on behalf of a person (IAM-2). The administrator asks, with a reason and the few permissions needed; a second person (never the administrator, never the person
-- acted for) approves; for at most 8 hours from the approval the administrator may reach those permissions of the person, and every audit row written meanwhile names both (actor = the administrator, on_behalf_of_id = the
-- person). Data entry only: a permission that decides or signs, and any iam.*, adm.* or system.* permission, is refused by the table itself.

CREATE FUNCTION machvon.acting_permissions_ok(permissions text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE
AS $fn$
  SELECT coalesce(cardinality(permissions) BETWEEN 1 AND 50 AND NOT EXISTS (
    SELECT 1 FROM unnest(permissions) AS p
     WHERE p !~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'
        OR p ~ '^(iam|adm|system)\.'
        OR split_part(p, '.', array_length(string_to_array(p, '.'), 1)) IN ('approve', 'decide', 'sign', 'certify', 'accept', 'reject', 'return', 'issue', 'review', 'verify', 'confirm', 'lock', 'publish', 'finalize')), false)
$fn$;

CREATE TABLE machvon.acting_grant (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  requester_membership_id uuid NOT NULL,
  subject_membership_id uuid NOT NULL,
  permissions text[] NOT NULL,
  period_codes text[],
  hours smallint NOT NULL,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'Pending',
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid,
  decided_at timestamptz,
  decision_reason text,
  -- The window it works in, set by the approval: `hours` from the approval.
  window_start timestamptz,
  window_end timestamptz,
  revoked_by uuid,
  revoked_at timestamptz,
  revoke_reason text,
  version bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, requester_membership_id) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, subject_membership_id) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, decided_by) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, revoked_by) REFERENCES machvon.membership (tenant_id, id),
  CONSTRAINT acting_parties_chk CHECK (requester_membership_id <> subject_membership_id AND (decided_by IS NULL OR (decided_by <> requester_membership_id AND decided_by <> subject_membership_id))),
  CONSTRAINT acting_permissions_chk CHECK (machvon.acting_permissions_ok(permissions)),
  CONSTRAINT acting_period_chk CHECK (period_codes IS NULL OR machvon.period_codes_ok(period_codes)),
  CONSTRAINT acting_hours_chk CHECK (hours BETWEEN 1 AND 8),
  CONSTRAINT acting_reason_chk CHECK (char_length(btrim(reason)) BETWEEN 20 AND 1000),
  CONSTRAINT acting_status_chk CHECK (status IN ('Pending', 'Approved', 'Rejected', 'Cancelled', 'Revoked')),
  CONSTRAINT acting_window_chk CHECK ((window_start IS NULL) = (window_end IS NULL) AND (window_start IS NULL OR window_end = window_start + hours * interval '1 hour')),
  CONSTRAINT acting_decision_chk CHECK (
    CASE status
      WHEN 'Pending' THEN decided_by IS NULL AND decided_at IS NULL AND window_start IS NULL AND revoked_by IS NULL
      WHEN 'Approved' THEN decided_by IS NOT NULL AND decided_at IS NOT NULL AND window_start IS NOT NULL AND revoked_by IS NULL
      WHEN 'Rejected' THEN decided_by IS NOT NULL AND decided_at IS NOT NULL AND decision_reason IS NOT NULL AND window_start IS NULL AND revoked_by IS NULL
      WHEN 'Cancelled' THEN decided_at IS NOT NULL AND window_start IS NULL AND revoked_by IS NULL
      ELSE window_start IS NOT NULL AND revoked_by IS NOT NULL AND revoked_at IS NOT NULL AND revoke_reason IS NOT NULL
    END
  )
);

CREATE INDEX acting_grant_requester_idx ON machvon.acting_grant (tenant_id, requester_membership_id, requested_at DESC);
CREATE INDEX acting_grant_subject_idx ON machvon.acting_grant (tenant_id, subject_membership_id, requested_at DESC);
CREATE INDEX acting_grant_decided_by_idx ON machvon.acting_grant (tenant_id, decided_by) WHERE decided_by IS NOT NULL;
CREATE INDEX acting_grant_revoked_by_idx ON machvon.acting_grant (tenant_id, revoked_by) WHERE revoked_by IS NOT NULL;
CREATE INDEX acting_grant_status_idx ON machvon.acting_grant (tenant_id, status, requested_at DESC);

ALTER TABLE machvon.acting_grant ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.acting_grant FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.acting_grant AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.acting_grant AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE DELETE, TRUNCATE ON TABLE machvon.acting_grant FROM machvon_app;

-- What was asked never changes. A request is decided once (Pending to Approved, Rejected or Cancelled); an approved grant can only be revoked, once; a grant that is over is final.
CREATE FUNCTION machvon.guard_acting_grant() RETURNS trigger
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
    RAISE EXCEPTION 'an acting grant is never deleted (% by %)', TG_OP, current_user USING ERRCODE = '42501';
  END IF;
  IF (NEW.tenant_id, NEW.id, NEW.requester_membership_id, NEW.subject_membership_id, NEW.permissions, NEW.period_codes, NEW.hours, NEW.reason, NEW.requested_at)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.id, OLD.requester_membership_id, OLD.subject_membership_id, OLD.permissions, OLD.period_codes, OLD.hours, OLD.reason, OLD.requested_at) THEN
    RAISE EXCEPTION 'what an acting grant asks never changes' USING ERRCODE = '42501';
  END IF;
  IF OLD.status IN ('Rejected', 'Cancelled', 'Revoked') THEN
    RAISE EXCEPTION 'an acting grant that is over never changes' USING ERRCODE = '42501', DETAIL = 'ACTING_STATE_INVALID';
  END IF;
  IF OLD.status = 'Approved' AND (NEW.status <> 'Revoked' OR (NEW.window_start, NEW.window_end, NEW.decided_by, NEW.decided_at) IS DISTINCT FROM (OLD.window_start, OLD.window_end, OLD.decided_by, OLD.decided_at)) THEN
    RAISE EXCEPTION 'an approved acting grant can only be revoked' USING ERRCODE = '42501', DETAIL = 'ACTING_STATE_INVALID';
  END IF;
  IF OLD.status = 'Pending' AND NEW.status NOT IN ('Pending', 'Approved', 'Rejected', 'Cancelled') THEN
    RAISE EXCEPTION 'a request is decided before it is revoked' USING ERRCODE = '42501', DETAIL = 'ACTING_STATE_INVALID';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER acting_grant_guard BEFORE UPDATE OR DELETE ON machvon.acting_grant
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_acting_grant();
