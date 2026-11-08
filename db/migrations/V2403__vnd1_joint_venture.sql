-- Authored by hand (not generated): joint ventures of contractors (VND-1, research V2; docs/vendor-management.md section 5).
-- A joint venture is a named group of contractors that bids and signs together, with one lead and a share each that add up to a whole. Law: a restriction on a joint venture reaches every member (Điều 133 NĐ 214/2025), so
-- the gates ask about the members and not only about the lead. A venture is not rewritten once members are in it: the members and shares are set when it is made (the agreement is the paper), and a venture ends.
--   * `joint_venture`: name, lead, the agreement document, the first and last day it exists.
--   * `joint_venture_member`: one row per member with the share. The shares add up to 100 and there is exactly one lead, held by the database too (a deferred check when the transaction ends).

CREATE TABLE machvon.joint_venture (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (name = btrim(name) AND char_length(name) BETWEEN 2 AND 300),
  lead_contractor_id uuid NOT NULL,
  agreement_document_id uuid,
  package_id uuid,
  starts_on date NOT NULL DEFAULT current_date,
  ends_on date,
  ended_reason text CHECK (ended_reason IS NULL OR (ended_reason = btrim(ended_reason) AND char_length(ended_reason) BETWEEN 5 AND 500)),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ENDED')),
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, lead_contractor_id) REFERENCES machvon.contractor (tenant_id, id),
  CONSTRAINT joint_venture_period_chk CHECK ((status = 'ENDED') = (ends_on IS NOT NULL) AND (ends_on IS NULL) = (ended_reason IS NULL) AND (ends_on IS NULL OR ends_on >= starts_on))
);
CREATE INDEX joint_venture_lead_idx ON machvon.joint_venture (tenant_id, lead_contractor_id);
CREATE INDEX joint_venture_document_idx ON machvon.joint_venture (tenant_id, agreement_document_id) WHERE agreement_document_id IS NOT NULL;
CREATE INDEX joint_venture_package_idx ON machvon.joint_venture (tenant_id, package_id) WHERE package_id IS NOT NULL;

CREATE TABLE machvon.joint_venture_member (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  joint_venture_id uuid NOT NULL,
  contractor_id uuid NOT NULL,
  share_pct numeric(5,2) NOT NULL CHECK (share_pct > 0 AND share_pct <= 100),
  is_lead boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, joint_venture_id) REFERENCES machvon.joint_venture (tenant_id, id),
  FOREIGN KEY (tenant_id, contractor_id) REFERENCES machvon.contractor (tenant_id, id),
  CONSTRAINT joint_venture_member_uq UNIQUE (tenant_id, joint_venture_id, contractor_id)
);
CREATE UNIQUE INDEX joint_venture_member_lead_uq ON machvon.joint_venture_member (tenant_id, joint_venture_id) WHERE is_lead;
CREATE INDEX joint_venture_member_contractor_idx ON machvon.joint_venture_member (tenant_id, contractor_id);

-- A venture whose members are set has shares that add up to a whole and a lead that is a member. Checked when the transaction ends, so the members can be inserted one by one.
CREATE FUNCTION machvon.check_joint_venture_shares() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  venture uuid;
  tenant uuid;
  total numeric;
  leads integer;
  members integer;
BEGIN
  IF TG_TABLE_NAME = 'joint_venture' THEN
    venture := COALESCE(NEW.id, OLD.id);
    tenant := COALESCE(NEW.tenant_id, OLD.tenant_id);
  ELSE
    venture := COALESCE(NEW.joint_venture_id, OLD.joint_venture_id);
    tenant := COALESCE(NEW.tenant_id, OLD.tenant_id);
  END IF;
  SELECT COALESCE(sum(share_pct), 0), count(*) FILTER (WHERE is_lead), count(*) INTO total, leads, members
    FROM machvon.joint_venture_member WHERE tenant_id = tenant AND joint_venture_id = venture;
  IF members > 0 AND (total <> 100 OR leads <> 1) THEN
    RAISE EXCEPTION 'the shares of a joint venture add up to 100 and it has one lead' USING ERRCODE = '23514';
  END IF;
  IF members > 0 AND NOT EXISTS (SELECT 1 FROM machvon.joint_venture v JOIN machvon.joint_venture_member m ON m.tenant_id = v.tenant_id AND m.joint_venture_id = v.id AND m.contractor_id = v.lead_contractor_id AND m.is_lead
                                  WHERE v.tenant_id = tenant AND v.id = venture) THEN
    RAISE EXCEPTION 'the lead of a joint venture is its lead member' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$fn$;
CREATE CONSTRAINT TRIGGER joint_venture_member_shares AFTER INSERT OR UPDATE OR DELETE ON machvon.joint_venture_member DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION machvon.check_joint_venture_shares();

-- The members of a venture are set once: a share or a member is never changed in place (a new venture is made instead), and a venture is never deleted.
CREATE FUNCTION machvon.guard_joint_venture() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a joint venture and its members are never deleted' USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME = 'joint_venture_member' THEN
    RAISE EXCEPTION 'the members of a joint venture are not changed: a new venture is made instead' USING ERRCODE = '23514';
  END IF;
  IF (NEW.name, NEW.lead_contractor_id, NEW.agreement_document_id, NEW.package_id, NEW.starts_on, NEW.created_by) IS DISTINCT FROM (OLD.name, OLD.lead_contractor_id, OLD.agreement_document_id, OLD.package_id, OLD.starts_on, OLD.created_by) THEN
    RAISE EXCEPTION 'a joint venture is not rewritten: it ends' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'ENDED' AND NEW.status <> 'ENDED' THEN
    RAISE EXCEPTION 'a joint venture that has ended stays ended' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;
CREATE TRIGGER joint_venture_guard BEFORE UPDATE OR DELETE ON machvon.joint_venture FOR EACH ROW EXECUTE FUNCTION machvon.guard_joint_venture();
CREATE TRIGGER joint_venture_member_guard BEFORE UPDATE OR DELETE ON machvon.joint_venture_member FOR EACH ROW EXECUTE FUNCTION machvon.guard_joint_venture();

ALTER TABLE machvon.joint_venture ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.joint_venture FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.joint_venture AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.joint_venture AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE machvon.joint_venture_member ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.joint_venture_member FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.joint_venture_member AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.joint_venture_member AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE DELETE, TRUNCATE ON TABLE machvon.joint_venture FROM machvon_app;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.joint_venture_member FROM machvon_app;

COMMENT ON TABLE machvon.joint_venture IS 'VND-1: a joint venture of contractors with one lead; a restriction on it reaches every member.';
COMMENT ON TABLE machvon.joint_venture_member IS 'VND-1: a member of a joint venture with its share; the shares add up to 100; set once.';
