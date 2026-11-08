-- Authored by hand (not generated): the lock of a report period and the digital signature of an issued copy (GOV-12, G4-6, on the report engine of RPT-1).
--   * report_period_lock: a period of a form is locked when its copy is signed (or accepted, by the rule PERIOD_REPORT_RULE). One open lock for a series and period; it is released by a SECOND person with a reason, and the lock
--     row stays (released, never deleted). While a period is locked the engine refuses a new revision (PERIOD_LOCKED).
--   * report_issue_signature: the detached signature (CMS) over the package digest of an issued copy, made by the approver through the signing port of DOC. Insert only: a trigger checks that the digest is the copy's own and that
--     the signer is its approver; a signature of the MOCK provider is kept as a test signature and never counts for delivery to a receiver that requires a signature (the API refuses that delivery).
--   * report_signature_session: the open signing session at the provider; it is the link between the start and the completion of a signature.

CREATE TABLE machvon.report_period_lock (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  layout_code text NOT NULL CHECK (layout_code ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,59}$'),
  period_code text NOT NULL CHECK (period_code = btrim(period_code) AND char_length(period_code) BETWEEN 1 AND 80),
  issue_id uuid NOT NULL,
  digest_sha256 char(64) NOT NULL CHECK (digest_sha256 ~ '^[0-9a-f]{64}$'),
  locked_by uuid NOT NULL,
  locked_at timestamptz NOT NULL DEFAULT now(),
  unlocked_by uuid,
  unlocked_at timestamptz,
  unlock_reason text CHECK (unlock_reason IS NULL OR (unlock_reason = btrim(unlock_reason) AND char_length(unlock_reason) BETWEEN 5 AND 1000)),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, issue_id) REFERENCES machvon.report_issue (tenant_id, id),
  FOREIGN KEY (tenant_id, locked_by) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, unlocked_by) REFERENCES machvon.membership (tenant_id, id),
  CONSTRAINT report_period_lock_unlock_chk CHECK ((unlocked_at IS NULL) = (unlocked_by IS NULL) AND (unlocked_at IS NULL) = (unlock_reason IS NULL) AND (unlocked_by IS NULL OR unlocked_by <> locked_by))
);
CREATE UNIQUE INDEX report_period_lock_open_uq ON machvon.report_period_lock (tenant_id, layout_code, period_code) WHERE unlocked_at IS NULL;
CREATE INDEX report_period_lock_series_idx ON machvon.report_period_lock (tenant_id, layout_code, period_code, locked_at DESC);
CREATE INDEX report_period_lock_issue_idx ON machvon.report_period_lock (tenant_id, issue_id);
CREATE INDEX report_period_lock_locked_by_idx ON machvon.report_period_lock (tenant_id, locked_by);
CREATE INDEX report_period_lock_unlocked_by_idx ON machvon.report_period_lock (tenant_id, unlocked_by) WHERE unlocked_by IS NOT NULL;
ALTER TABLE machvon.report_period_lock ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.report_period_lock FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.report_period_lock AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.report_period_lock AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE DELETE, TRUNCATE, UPDATE ON TABLE machvon.report_period_lock FROM machvon_app;
GRANT UPDATE (unlocked_by, unlocked_at, unlock_reason, version) ON TABLE machvon.report_period_lock TO machvon_app;

CREATE FUNCTION machvon.report_period_lock_guard() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF OLD.unlocked_at IS NOT NULL THEN
    RAISE EXCEPTION 'a released lock does not change' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;
CREATE TRIGGER report_period_lock_guard BEFORE UPDATE ON machvon.report_period_lock FOR EACH ROW EXECUTE FUNCTION machvon.report_period_lock_guard();

CREATE TABLE machvon.report_signature_session (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  issue_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('REMOTE_CA', 'LOCAL_AGENT', 'MOCK')),
  provider_session_ref text NOT NULL CHECK (char_length(provider_session_ref) BETWEEN 1 AND 200),
  certificate_id uuid NOT NULL,
  certificate_fingerprint char(64) NOT NULL CHECK (certificate_fingerprint ~ '^[0-9a-f]{64}$'),
  digest_sha256 char(64) NOT NULL CHECK (digest_sha256 ~ '^[0-9a-f]{64}$'),
  state text NOT NULL DEFAULT 'OPEN' CHECK (state IN ('OPEN', 'COMPLETED', 'CANCELLED', 'EXPIRED')),
  started_by uuid NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, issue_id) REFERENCES machvon.report_issue (tenant_id, id),
  FOREIGN KEY (tenant_id, started_by) REFERENCES machvon.membership (tenant_id, id),
  CONSTRAINT report_signature_session_expiry_chk CHECK (expires_at > started_at)
);
CREATE UNIQUE INDEX report_signature_session_open_uq ON machvon.report_signature_session (tenant_id, issue_id) WHERE state = 'OPEN';
CREATE INDEX report_signature_session_issue_idx ON machvon.report_signature_session (tenant_id, issue_id, started_at DESC);
CREATE INDEX report_signature_session_certificate_idx ON machvon.report_signature_session (tenant_id, certificate_id);
CREATE INDEX report_signature_session_started_by_idx ON machvon.report_signature_session (tenant_id, started_by);
ALTER TABLE machvon.report_signature_session ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.report_signature_session FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.report_signature_session AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.report_signature_session AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE DELETE, TRUNCATE, UPDATE ON TABLE machvon.report_signature_session FROM machvon_app;
GRANT UPDATE (state, version) ON TABLE machvon.report_signature_session TO machvon_app;

CREATE TABLE machvon.report_issue_signature (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  issue_id uuid NOT NULL,
  session_id uuid NOT NULL,
  digest_sha256 char(64) NOT NULL CHECK (digest_sha256 ~ '^[0-9a-f]{64}$'),
  provider text NOT NULL CHECK (provider IN ('REMOTE_CA', 'LOCAL_AGENT', 'MOCK')),
  signer_membership_id uuid NOT NULL,
  certificate_fingerprint char(64) NOT NULL CHECK (certificate_fingerprint ~ '^[0-9a-f]{64}$'),
  cms bytea NOT NULL CHECK (octet_length(cms) BETWEEN 16 AND 1048576),
  cms_sha256 char(64) NOT NULL,
  counts_for_delivery boolean NOT NULL,
  signed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, issue_id) REFERENCES machvon.report_issue (tenant_id, id),
  FOREIGN KEY (tenant_id, session_id) REFERENCES machvon.report_signature_session (tenant_id, id),
  FOREIGN KEY (tenant_id, signer_membership_id) REFERENCES machvon.membership (tenant_id, id),
  CONSTRAINT report_issue_signature_issue_uq UNIQUE (tenant_id, issue_id),
  CONSTRAINT report_issue_signature_hash_chk CHECK (cms_sha256 = encode(sha256(cms), 'hex')),
  CONSTRAINT report_issue_signature_count_chk CHECK (counts_for_delivery = (provider <> 'MOCK'))
);
CREATE INDEX report_issue_signature_session_idx ON machvon.report_issue_signature (tenant_id, session_id);
CREATE INDEX report_issue_signature_signer_idx ON machvon.report_issue_signature (tenant_id, signer_membership_id);
ALTER TABLE machvon.report_issue_signature ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.report_issue_signature FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.report_issue_signature AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.report_issue_signature AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.report_issue_signature FROM machvon_app;

CREATE FUNCTION machvon.report_issue_signature_guard() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  copy machvon.report_issue%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'a signature of a report copy is kept as it was made' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO copy FROM machvon.report_issue WHERE tenant_id = NEW.tenant_id AND id = NEW.issue_id;
  IF NOT FOUND OR copy.sha256 <> NEW.digest_sha256 THEN
    RAISE EXCEPTION 'a signature covers the package digest of its own copy' USING ERRCODE = '23514';
  END IF;
  IF copy.approved_by <> NEW.signer_membership_id THEN
    RAISE EXCEPTION 'the approver of the copy is the one who signs it' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;
CREATE TRIGGER report_issue_signature_guard BEFORE INSERT OR UPDATE OR DELETE ON machvon.report_issue_signature FOR EACH ROW EXECUTE FUNCTION machvon.report_issue_signature_guard();

COMMENT ON TABLE machvon.report_period_lock IS 'The lock of a report period: opened when the copy is signed, released by a second person with a reason; never deleted.';
COMMENT ON TABLE machvon.report_issue_signature IS 'The detached signature of an issued report copy over its package digest; insert only; a MOCK signature is a test signature and never counts for delivery.';
