-- Authored by hand (not generated): which master data types a tenant may write (ST-MDM-002, MDM 3.1 F8).
-- A type is PLATFORM_ONLY (the platform publishes it; a tenant only reads it), PLATFORM_WITH_TENANT_EXTENSION (a tenant adds child
-- entries under an entry of the platform) or TENANT_ONLY (the tenant owns it). A type with no row follows the baseline of the
-- platform in the code of the master store; a row is written by the control plane, never by the tenant it governs, so a tenant
-- cannot unlock what the platform locked.

CREATE TABLE machvon.master_type_policy (
  tenant_id uuid NOT NULL,
  master_type text NOT NULL,
  scope text NOT NULL CHECK (scope IN ('PLATFORM_ONLY', 'PLATFORM_WITH_TENANT_EXTENSION', 'TENANT_ONLY')),
  retire_requires_successor boolean NOT NULL DEFAULT false,
  updated_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, master_type)
);

ALTER TABLE machvon.master_type_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.master_type_policy FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.master_type_policy AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.master_type_policy AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- The tenant plane reads the policy that governs it and never writes it; the control plane sets it for one tenant at a time.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE machvon.master_type_policy FROM machvon_app;
GRANT SELECT, INSERT, UPDATE ON TABLE machvon.master_type_policy TO machvon_control;
