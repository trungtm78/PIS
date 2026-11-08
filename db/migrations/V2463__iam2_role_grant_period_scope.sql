-- Authored by hand (not generated): the limit of a role grant to report periods (IAM-2). A role grant without a row here is not limited (the behaviour that existed before). With an Active row the holder uses the role only on
-- the reports of the listed periods (`2026-Q3`, `2026-M03`, `2026-H1`, `2026`); the commands that handle a report ask the kernel `assertPeriodAllowed`. Lifting the limit widens authority, so it is a recorded
-- command with a reason, and the one who lifts it is not the holder (decided in the command, by the person).

CREATE TABLE machvon.role_grant_period_scope (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  role_grant_id uuid NOT NULL,
  period_codes text[] NOT NULL,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'Active',
  set_by uuid NOT NULL,
  set_at timestamptz NOT NULL DEFAULT now(),
  lifted_by uuid,
  lifted_at timestamptz,
  lift_reason text,
  version bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, role_grant_id) REFERENCES machvon.role_grant (tenant_id, id),
  FOREIGN KEY (tenant_id, set_by) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, lifted_by) REFERENCES machvon.membership (tenant_id, id),
  CONSTRAINT period_scope_codes_chk CHECK (machvon.period_codes_ok(period_codes)),
  CONSTRAINT period_scope_reason_chk CHECK (char_length(btrim(reason)) BETWEEN 10 AND 2000),
  CONSTRAINT period_scope_status_chk CHECK (status IN ('Active', 'Lifted')),
  CONSTRAINT period_scope_lift_chk CHECK ((status = 'Lifted') = (lifted_by IS NOT NULL AND lifted_at IS NOT NULL AND lift_reason IS NOT NULL))
);

-- One limit at a time for a grant: changing the periods is lifting the old limit and setting a new one, both on the trail.
CREATE UNIQUE INDEX period_scope_one_active_idx ON machvon.role_grant_period_scope (tenant_id, role_grant_id) WHERE status = 'Active';
CREATE INDEX period_scope_grant_idx ON machvon.role_grant_period_scope (tenant_id, role_grant_id);
CREATE INDEX period_scope_set_by_idx ON machvon.role_grant_period_scope (tenant_id, set_by);
CREATE INDEX period_scope_lifted_by_idx ON machvon.role_grant_period_scope (tenant_id, lifted_by) WHERE lifted_by IS NOT NULL;
CREATE INDEX period_scope_status_idx ON machvon.role_grant_period_scope (tenant_id, status, set_at DESC);

ALTER TABLE machvon.role_grant_period_scope ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.role_grant_period_scope FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.role_grant_period_scope AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.role_grant_period_scope AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE DELETE, TRUNCATE ON TABLE machvon.role_grant_period_scope FROM machvon_app;

-- What a limit lists never changes; it is lifted once and then it is final.
CREATE FUNCTION machvon.guard_role_grant_period_scope() RETURNS trigger
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
    RAISE EXCEPTION 'a period limit is never deleted (% by %)', TG_OP, current_user USING ERRCODE = '42501';
  END IF;
  IF (NEW.tenant_id, NEW.id, NEW.role_grant_id, NEW.period_codes, NEW.reason, NEW.set_by, NEW.set_at) IS DISTINCT FROM (OLD.tenant_id, OLD.id, OLD.role_grant_id, OLD.period_codes, OLD.reason, OLD.set_by, OLD.set_at) THEN
    RAISE EXCEPTION 'what a period limit lists never changes' USING ERRCODE = '42501';
  END IF;
  IF OLD.status = 'Lifted' THEN
    RAISE EXCEPTION 'a period limit that was lifted never changes' USING ERRCODE = '42501', DETAIL = 'PERIOD_SCOPE_STATE_INVALID';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER role_grant_period_scope_guard BEFORE UPDATE OR DELETE ON machvon.role_grant_period_scope
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_role_grant_period_scope();
