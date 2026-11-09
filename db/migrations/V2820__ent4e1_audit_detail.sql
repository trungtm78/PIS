-- Authored by hand (not generated): the full before and after values of the business objects of the enterprise edition in the audit trail (HT.06, ENT-4e).
-- `audit_event` keeps the 17 columns that the seal and the export format fix. The complete values go to a side record, one row per audit row, whose SHA-256 the
-- sealed `safe_diff` carries (`detail_ref`), so the Merkle leaf commits to the values and a later change of them is detectable. Three tables:
--   * `audit_detail_policy`: the opt-in of a tenant per class of business object (`resource_type`): off by default; on with a byte cap per row and extra
--     sensitive keys. Every change is a versioned command with a reason (history in `audit_detail_policy_event`, append-only).
--   * `audit_event_detail`: the redacted, bounded before and after of one audit row; append-only for every role.

CREATE TABLE machvon.audit_detail_policy (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  resource_type text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  max_bytes integer NOT NULL DEFAULT 16384,
  sensitive_keys text[] NOT NULL DEFAULT '{}',
  reason text NOT NULL,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT audit_detail_policy_type_chk CHECK (resource_type ~ '^[a-z][a-z0-9_]{1,79}$'),
  CONSTRAINT audit_detail_policy_bytes_chk CHECK (max_bytes BETWEEN 1024 AND 262144),
  CONSTRAINT audit_detail_policy_keys_chk CHECK (cardinality(sensitive_keys) <= 50),
  CONSTRAINT audit_detail_policy_reason_chk CHECK (reason = btrim(reason) AND char_length(reason) BETWEEN 5 AND 2000),
  CONSTRAINT audit_detail_policy_version_chk CHECK (version >= 1),
  CONSTRAINT audit_detail_policy_type_uq UNIQUE (tenant_id, resource_type)
);

CREATE TABLE machvon.audit_detail_policy_event (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  policy_id uuid NOT NULL,
  action text NOT NULL,
  reason text NOT NULL,
  actor_id uuid NOT NULL,
  snapshot jsonb NOT NULL,
  policy_version bigint NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, policy_id) REFERENCES machvon.audit_detail_policy (tenant_id, id),
  CONSTRAINT audit_detail_policy_event_action_chk CHECK (action IN ('CREATED', 'ENABLED', 'DISABLED', 'CHANGED')),
  CONSTRAINT audit_detail_policy_event_reason_chk CHECK (reason = btrim(reason) AND char_length(reason) BETWEEN 5 AND 2000)
);
CREATE INDEX audit_detail_policy_event_idx ON machvon.audit_detail_policy_event (tenant_id, policy_id, occurred_at DESC, id DESC);
CREATE INDEX audit_detail_policy_event_actor_idx ON machvon.audit_detail_policy_event (tenant_id, actor_id, occurred_at DESC);

CREATE TABLE machvon.audit_event_detail (
  tenant_id uuid NOT NULL,
  audit_event_id uuid NOT NULL,
  resource_type text NOT NULL,
  resource_id uuid NOT NULL,
  before_value jsonb NOT NULL,
  after_value jsonb NOT NULL,
  detail_sha256 text NOT NULL,
  bytes integer NOT NULL,
  redacted_paths text[] NOT NULL DEFAULT '{}',
  truncated boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, audit_event_id),
  FOREIGN KEY (tenant_id, audit_event_id) REFERENCES machvon.audit_event (tenant_id, id),
  CONSTRAINT audit_event_detail_hash_chk CHECK (detail_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT audit_event_detail_bytes_chk CHECK (bytes BETWEEN 2 AND 262144)
);
CREATE INDEX audit_event_detail_resource_idx ON machvon.audit_event_detail (tenant_id, resource_type, resource_id, created_at DESC);

CREATE FUNCTION machvon.audit_detail_append_only() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  RAISE EXCEPTION 'the history of the audit detail is append-only' USING ERRCODE = '23514';
END;
$fn$;

CREATE TRIGGER audit_detail_policy_event_append_only BEFORE UPDATE OR DELETE ON machvon.audit_detail_policy_event FOR EACH ROW EXECUTE FUNCTION machvon.audit_detail_append_only();
CREATE TRIGGER audit_event_detail_append_only BEFORE UPDATE OR DELETE ON machvon.audit_event_detail FOR EACH ROW EXECUTE FUNCTION machvon.audit_detail_append_only();

CREATE FUNCTION machvon.guard_audit_detail_policy() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.resource_type IS DISTINCT FROM OLD.resource_type OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a policy keeps its class and its origin' USING ERRCODE = '23514';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'a change of a policy moves its version by one' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER audit_detail_policy_guard BEFORE UPDATE ON machvon.audit_detail_policy FOR EACH ROW EXECUTE FUNCTION machvon.guard_audit_detail_policy();

ALTER TABLE machvon.audit_detail_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.audit_detail_policy FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.audit_detail_policy AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.audit_detail_policy AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE machvon.audit_detail_policy_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.audit_detail_policy_event FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.audit_detail_policy_event AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.audit_detail_policy_event AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE machvon.audit_event_detail ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.audit_event_detail FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.audit_event_detail AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.audit_event_detail AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE DELETE, TRUNCATE ON TABLE machvon.audit_detail_policy FROM machvon_app;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.audit_detail_policy_event FROM machvon_app;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.audit_event_detail FROM machvon_app;

COMMENT ON TABLE machvon.audit_detail_policy IS 'ENT-4e: opt-in of a tenant to keep the full before and after of the business objects of a class in the audit trail; off by default.';
COMMENT ON TABLE machvon.audit_detail_policy_event IS 'ENT-4e: what was done to an audit detail policy and why; append-only.';
COMMENT ON TABLE machvon.audit_event_detail IS 'ENT-4e: the redacted, bounded before and after of one audit row; the sealed safe_diff of the row carries detail_ref with its SHA-256; append-only.';
