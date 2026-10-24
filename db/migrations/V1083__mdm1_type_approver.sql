-- Authored by hand (not generated): who may decide and publish the changes of a rule type (ST-MDM-003, BR-MDM-09).
-- Rule data is approved by the owner of the module that applies it, not by any data checker. The control plane names the
-- memberships that own a rule type for one tenant; the tenant plane only reads the list, so a tenant cannot name its own
-- approver. A rule type with no approver cannot be approved at all.

CREATE TABLE machvon.master_type_approver (
  tenant_id uuid NOT NULL,
  master_type text NOT NULL,
  membership_id uuid NOT NULL,
  granted_by uuid NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, master_type, membership_id)
);

CREATE INDEX master_type_approver_membership_idx ON machvon.master_type_approver (tenant_id, membership_id);

ALTER TABLE machvon.master_type_approver ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.master_type_approver FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.master_type_approver AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.master_type_approver AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE machvon.master_type_approver FROM machvon_app;
GRANT SELECT, INSERT, DELETE ON TABLE machvon.master_type_approver TO machvon_control;
