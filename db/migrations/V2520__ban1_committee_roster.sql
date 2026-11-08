-- Authored by hand (not generated): the steering committee of the province and who sits on it (BAN-1, docs/committee-workspace.md).
-- `committee` is the body itself (for example the provincial steering committee for public investment, "Ban 57"): a code, a name, the decision that set it up, and whether it is still active.
-- `committee_member` is a place on it: a membership of the tenant, the role in the committee (HEAD, DEPUTY, MEMBER or SECRETARIAT), the agency the person comes from (for the head of the committee a police unit,
-- for example PA05), the decision that appointed them, the days it holds and whether a second factor is required for this person (a hook for the infrastructure phase: the session level is recorded in the audit
-- of every view, see V2521). The roster is the register of the appointments; what a person MAY DO is given by the IAM role grant (COMMITTEE_HEAD, COMMITTEE_MEMBER, COMMITTEE_SECRETARIAT over the whole tenant).
-- At most one active HEAD per committee and one active place per person; nobody appoints themselves; an ended place says when, by whom and why and is never removed.

CREATE TABLE machvon.committee (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  code text NOT NULL CHECK (code ~ '^[A-Z][A-Z0-9_]{1,39}$'),
  name text NOT NULL CHECK (name = btrim(name) AND char_length(name) BETWEEN 1 AND 300),
  legal_basis text CHECK (legal_basis IS NULL OR (legal_basis = btrim(legal_basis) AND char_length(legal_basis) BETWEEN 1 AND 500)),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ENDED')),
  version bigint NOT NULL DEFAULT 1,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT committee_code_uq UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, created_by) REFERENCES machvon.membership (tenant_id, id)
);

CREATE INDEX committee_created_by_idx ON machvon.committee (tenant_id, created_by);

CREATE TABLE machvon.committee_member (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  committee_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  committee_role text NOT NULL CHECK (committee_role IN ('HEAD', 'DEPUTY', 'MEMBER', 'SECRETARIAT')),
  agency_code text CHECK (agency_code IS NULL OR agency_code ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$'),
  agency_name text CHECK (agency_name IS NULL OR (agency_name = btrim(agency_name) AND char_length(agency_name) BETWEEN 1 AND 300)),
  decision_ref text CHECK (decision_ref IS NULL OR (decision_ref = btrim(decision_ref) AND char_length(decision_ref) BETWEEN 1 AND 300)),
  valid_from date NOT NULL,
  valid_until date,
  -- A hook for the infrastructure phase (SSO and MFA): when true, the audit of every view carries the assurance level of the session and a tenant may refuse sessions below MFA.
  mfa_required boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ENDED')),
  appointed_by uuid NOT NULL,
  appointed_at timestamptz NOT NULL DEFAULT now(),
  ended_by uuid,
  ended_at timestamptz,
  end_reason text CHECK (end_reason IS NULL OR (end_reason = btrim(end_reason) AND char_length(end_reason) BETWEEN 5 AND 500)),
  version bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, committee_id) REFERENCES machvon.committee (tenant_id, id),
  FOREIGN KEY (tenant_id, membership_id) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, appointed_by) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, ended_by) REFERENCES machvon.membership (tenant_id, id),
  CONSTRAINT committee_member_days_chk CHECK (valid_until IS NULL OR valid_until >= valid_from),
  CONSTRAINT committee_member_self_chk CHECK (appointed_by <> membership_id),
  CONSTRAINT committee_member_end_chk CHECK ((status = 'ENDED') = (ended_by IS NOT NULL AND ended_at IS NOT NULL AND end_reason IS NOT NULL))
);

CREATE UNIQUE INDEX committee_member_one_place_uq ON machvon.committee_member (tenant_id, committee_id, membership_id) WHERE status = 'ACTIVE';
CREATE UNIQUE INDEX committee_member_one_head_uq ON machvon.committee_member (tenant_id, committee_id) WHERE status = 'ACTIVE' AND committee_role = 'HEAD';
CREATE INDEX committee_member_committee_idx ON machvon.committee_member (tenant_id, committee_id, status, committee_role);
CREATE INDEX committee_member_membership_idx ON machvon.committee_member (tenant_id, membership_id, status);
CREATE INDEX committee_member_appointed_by_idx ON machvon.committee_member (tenant_id, appointed_by);
CREATE INDEX committee_member_ended_by_idx ON machvon.committee_member (tenant_id, ended_by) WHERE ended_by IS NOT NULL;

-- An ended place is final and a place keeps who and which role it was given to: only the ending may change a row.
CREATE FUNCTION machvon.committee_member_guard() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a place in the committee is never removed' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'ENDED' THEN
    RAISE EXCEPTION 'an ended place in the committee is final' USING ERRCODE = '23514';
  END IF;
  IF NEW.committee_id IS DISTINCT FROM OLD.committee_id OR NEW.membership_id IS DISTINCT FROM OLD.membership_id OR NEW.committee_role IS DISTINCT FROM OLD.committee_role
     OR NEW.appointed_by IS DISTINCT FROM OLD.appointed_by OR NEW.valid_from IS DISTINCT FROM OLD.valid_from THEN
    RAISE EXCEPTION 'a place in the committee keeps its person, role and day of appointment' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER committee_member_guard BEFORE UPDATE OR DELETE ON machvon.committee_member FOR EACH ROW EXECUTE FUNCTION machvon.committee_member_guard();

ALTER TABLE machvon.committee ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.committee FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.committee AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.committee AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE machvon.committee_member ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.committee_member FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.committee_member AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.committee_member AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE DELETE, TRUNCATE ON TABLE machvon.committee FROM machvon_app;
REVOKE DELETE, TRUNCATE ON TABLE machvon.committee_member FROM machvon_app;

COMMENT ON TABLE machvon.committee IS 'BAN-1: the steering committee of the province; its roster is committee_member.';
COMMENT ON TABLE machvon.committee_member IS 'BAN-1: a place on the committee (role, agency, decision, days, mfa_required hook); never removed, ended with a reason.';
