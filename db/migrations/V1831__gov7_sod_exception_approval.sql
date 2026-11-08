-- Authored by hand (not generated): who agreed to an exception to the separation of duties, or refused it (G4-1). One row for each person who decided, never changed and never removed: the approvals that make an exception count are the rows here, and
-- the counter on the exception (`approvals`) is checked against them by the guard of V1833. A person decides once (unique), and never the person who asked nor the person the exception covers (the guard checks that as well, whatever the application did).

CREATE TABLE machvon.sod_exception_approval (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  exception_id uuid NOT NULL,
  approver_id uuid NOT NULL,
  decision text NOT NULL CHECK (decision IN ('APPROVE', 'REJECT')),
  comment text CHECK (comment IS NULL OR (comment = btrim(comment) AND char_length(comment) BETWEEN 1 AND 500)),
  decided_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, exception_id) REFERENCES machvon.sod_exception (tenant_id, id),
  FOREIGN KEY (tenant_id, approver_id) REFERENCES machvon.membership (tenant_id, id),
  CONSTRAINT sod_exception_approval_once_uq UNIQUE (tenant_id, exception_id, approver_id)
);

CREATE INDEX sod_exception_approval_exception_idx ON machvon.sod_exception_approval (tenant_id, exception_id, decided_at);

ALTER TABLE machvon.sod_exception_approval ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.sod_exception_approval FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.sod_exception_approval AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.sod_exception_approval AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.sod_exception_approval FROM machvon_app;

COMMENT ON TABLE machvon.sod_exception_approval IS 'Decisions of the approvers of an exception to the separation of duties; append-only.';

-- Indexes that lead with the tenant under every foreign key and reference column, so the reads by that column and the checks of the foreign keys do not scan (rule ST-CTR-013, rls-catalog).
CREATE INDEX sod_exception_approval_approver_idx ON machvon.sod_exception_approval (tenant_id, approver_id);
