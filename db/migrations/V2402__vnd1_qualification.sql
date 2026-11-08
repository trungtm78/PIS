-- Authored by hand (not generated): the certificates and the key staff of a contractor, and what a package asks of them (VND-1, research V8; docs/vendor-management.md section 4).
--   * `contractor_qualification`: a certificate or a clearance (kind, number, grade, scope, issuer, the first and last day it holds, the paper). It is verified by a person other than the one who entered it; one that was not
--     verified satisfies no requirement. It is revoked, not deleted, and the dates and the number never change: a renewal is a new row, so the certificate that held on the day of a bid stays answerable.
--   * `contractor_key_staff`: a member of the key staff of a contractor (a project manager, a site engineer, a supervisor) with the certificate that qualifies them and the same period and verification.
--   * `package_qualification_requirement`: what a procurement package asks of its bidders (kind, lowest grade, a word the scope must contain). The evaluation reads it, and the activation of the contract checks the winner
--     against it again (a certificate may have lapsed between the award and the signature).

CREATE TABLE machvon.contractor_qualification (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  contractor_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('CONSTRUCTION_ACTIVITY', 'DESIGN_CONSULTING', 'SUPERVISION_CONSULTING', 'SAFETY_CERTIFICATE', 'QUALITY_MANAGEMENT_ISO9001', 'BUSINESS_REGISTRATION', 'TAX_CLEARANCE', 'SOCIAL_INSURANCE_CLEARANCE', 'EQUIPMENT_OWNERSHIP', 'OTHER')),
  certificate_no text NOT NULL CHECK (certificate_no = btrim(certificate_no) AND char_length(certificate_no) BETWEEN 1 AND 100),
  grade text CHECK (grade IS NULL OR grade IN ('III', 'II', 'I')),
  scope text CHECK (scope IS NULL OR (scope = btrim(scope) AND char_length(scope) BETWEEN 1 AND 500)),
  issuer text NOT NULL CHECK (issuer = btrim(issuer) AND char_length(issuer) BETWEEN 2 AND 300),
  issued_on date NOT NULL,
  expires_on date,
  document_id uuid,
  verified_by uuid,
  verified_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid,
  revoke_reason text CHECK (revoke_reason IS NULL OR (revoke_reason = btrim(revoke_reason) AND char_length(revoke_reason) BETWEEN 5 AND 500)),
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, contractor_id) REFERENCES machvon.contractor (tenant_id, id),
  CONSTRAINT contractor_qualification_period_chk CHECK (expires_on IS NULL OR expires_on >= issued_on),
  CONSTRAINT contractor_qualification_verified_chk CHECK ((verified_by IS NULL) = (verified_at IS NULL) AND (verified_by IS NULL OR verified_by <> created_by)),
  CONSTRAINT contractor_qualification_revoked_chk CHECK ((revoked_at IS NULL) = (revoked_by IS NULL) AND (revoked_at IS NULL) = (revoke_reason IS NULL))
);
CREATE INDEX contractor_qualification_contractor_idx ON machvon.contractor_qualification (tenant_id, contractor_id, kind, expires_on);
CREATE INDEX contractor_qualification_document_idx ON machvon.contractor_qualification (tenant_id, document_id) WHERE document_id IS NOT NULL;
CREATE INDEX contractor_qualification_expiry_idx ON machvon.contractor_qualification (tenant_id, expires_on) WHERE expires_on IS NOT NULL AND revoked_at IS NULL;

CREATE TABLE machvon.contractor_key_staff (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  contractor_id uuid NOT NULL,
  staff_role text NOT NULL CHECK (staff_role IN ('PROJECT_MANAGER', 'SITE_ENGINEER', 'DESIGN_LEAD', 'SUPERVISOR', 'SAFETY_OFFICER', 'QUALITY_OFFICER', 'SURVEYOR', 'OTHER')),
  person_name text NOT NULL CHECK (person_name = btrim(person_name) AND char_length(person_name) BETWEEN 2 AND 300),
  person_key char(64) NOT NULL CHECK (person_key ~ '^[0-9a-f]{64}$'),
  qualification_title text NOT NULL CHECK (qualification_title = btrim(qualification_title) AND char_length(qualification_title) BETWEEN 2 AND 300),
  certificate_no text CHECK (certificate_no IS NULL OR (certificate_no = btrim(certificate_no) AND char_length(certificate_no) BETWEEN 1 AND 100)),
  issued_on date NOT NULL,
  expires_on date,
  document_id uuid,
  verified_by uuid,
  verified_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid,
  revoke_reason text CHECK (revoke_reason IS NULL OR (revoke_reason = btrim(revoke_reason) AND char_length(revoke_reason) BETWEEN 5 AND 500)),
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, contractor_id) REFERENCES machvon.contractor (tenant_id, id),
  CONSTRAINT contractor_key_staff_period_chk CHECK (expires_on IS NULL OR expires_on >= issued_on),
  CONSTRAINT contractor_key_staff_verified_chk CHECK ((verified_by IS NULL) = (verified_at IS NULL) AND (verified_by IS NULL OR verified_by <> created_by)),
  CONSTRAINT contractor_key_staff_revoked_chk CHECK ((revoked_at IS NULL) = (revoked_by IS NULL) AND (revoked_at IS NULL) = (revoke_reason IS NULL))
);
CREATE INDEX contractor_key_staff_contractor_idx ON machvon.contractor_key_staff (tenant_id, contractor_id, staff_role, expires_on);
CREATE INDEX contractor_key_staff_document_idx ON machvon.contractor_key_staff (tenant_id, document_id) WHERE document_id IS NOT NULL;
CREATE INDEX contractor_key_staff_person_idx ON machvon.contractor_key_staff (tenant_id, person_key);
CREATE INDEX contractor_key_staff_expiry_idx ON machvon.contractor_key_staff (tenant_id, expires_on) WHERE expires_on IS NOT NULL AND revoked_at IS NULL;

CREATE TABLE machvon.package_qualification_requirement (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  package_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('CONSTRUCTION_ACTIVITY', 'DESIGN_CONSULTING', 'SUPERVISION_CONSULTING', 'SAFETY_CERTIFICATE', 'QUALITY_MANAGEMENT_ISO9001', 'BUSINESS_REGISTRATION', 'TAX_CLEARANCE', 'SOCIAL_INSURANCE_CLEARANCE', 'EQUIPMENT_OWNERSHIP', 'OTHER')),
  min_grade text CHECK (min_grade IS NULL OR min_grade IN ('III', 'II', 'I')),
  scope_keyword text CHECK (scope_keyword IS NULL OR (scope_keyword = btrim(scope_keyword) AND char_length(scope_keyword) BETWEEN 1 AND 100)),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, package_id) REFERENCES machvon.procurement_package (tenant_id, id),
  CONSTRAINT package_qualification_requirement_uq UNIQUE (tenant_id, package_id, kind)
);

-- What a certificate is (kind, number, grade, scope, issuer and period) never changes; it is verified once and revoked once. A renewal is a new certificate.
CREATE FUNCTION machvon.guard_contractor_qualification() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a certificate or a member of the key staff of a contractor is never deleted' USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME = 'contractor_qualification' THEN
    IF (NEW.contractor_id, NEW.kind, NEW.certificate_no, NEW.grade, NEW.scope, NEW.issuer, NEW.issued_on, NEW.expires_on, NEW.created_by)
       IS DISTINCT FROM (OLD.contractor_id, OLD.kind, OLD.certificate_no, OLD.grade, OLD.scope, OLD.issuer, OLD.issued_on, OLD.expires_on, OLD.created_by) THEN
      RAISE EXCEPTION 'a certificate is not rewritten: a renewal is a new certificate' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF (NEW.contractor_id, NEW.staff_role, NEW.person_name, NEW.person_key, NEW.qualification_title, NEW.certificate_no, NEW.issued_on, NEW.expires_on, NEW.created_by)
       IS DISTINCT FROM (OLD.contractor_id, OLD.staff_role, OLD.person_name, OLD.person_key, OLD.qualification_title, OLD.certificate_no, OLD.issued_on, OLD.expires_on, OLD.created_by) THEN
      RAISE EXCEPTION 'a member of the key staff is not rewritten: a renewal is a new row' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF OLD.verified_by IS NOT NULL AND (NEW.verified_by IS DISTINCT FROM OLD.verified_by OR NEW.verified_at IS DISTINCT FROM OLD.verified_at) THEN
    RAISE EXCEPTION 'a verification stays as it was made' USING ERRCODE = '23514';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at OR NEW.revoke_reason IS DISTINCT FROM OLD.revoke_reason) THEN
    RAISE EXCEPTION 'a revocation stays as it was made' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;
CREATE TRIGGER contractor_qualification_guard BEFORE UPDATE OR DELETE ON machvon.contractor_qualification FOR EACH ROW EXECUTE FUNCTION machvon.guard_contractor_qualification();
CREATE TRIGGER contractor_key_staff_guard BEFORE UPDATE OR DELETE ON machvon.contractor_key_staff FOR EACH ROW EXECUTE FUNCTION machvon.guard_contractor_qualification();

ALTER TABLE machvon.contractor_qualification ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.contractor_qualification FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.contractor_qualification AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.contractor_qualification AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE machvon.contractor_key_staff ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.contractor_key_staff FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.contractor_key_staff AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.contractor_key_staff AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE machvon.package_qualification_requirement ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.package_qualification_requirement FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.package_qualification_requirement AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.package_qualification_requirement AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE DELETE, TRUNCATE ON TABLE machvon.contractor_qualification FROM machvon_app;
REVOKE DELETE, TRUNCATE ON TABLE machvon.contractor_key_staff FROM machvon_app;

COMMENT ON TABLE machvon.contractor_qualification IS 'VND-1: a certificate or clearance of a contractor with its period, verified by a second person, revoked and never rewritten.';
COMMENT ON TABLE machvon.contractor_key_staff IS 'VND-1: a member of the key staff of a contractor with the certificate that qualifies them (PERSONAL).';
COMMENT ON TABLE machvon.package_qualification_requirement IS 'VND-1: what a procurement package asks of its bidders: kind, lowest grade, a word of the scope.';
