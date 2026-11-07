-- Authored by hand (not generated): every time a command met a conflict of the separation of duties (G4-1): it went through by an approved exception (EXCEPTION_USED), or because the pair is only a warning (WARNED), or it was refused (BLOCKED, written in a transaction of its own after the command rolled back, so the attempt survives). The auditor reads
-- this table (AUD, `sod.audit.read`) to see which records went through and under which pair and exception; it is how the alert type SOD_EXCEPTION_USED (WATCH) is fed. EXCEPTION_USED and WARNED are written in the transaction of the command, so a command
-- that rolled back for another reason leaves no such row; append-only, never changed and never removed. `subject_id` is the key of the scope of the pair (record, project, contract or package) and `record_id` the record the command acted on.

CREATE TABLE machvon.sod_exception_use (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  outcome text NOT NULL CHECK (outcome IN ('EXCEPTION_USED', 'WARNED', 'BLOCKED')),
  exception_id uuid,
  action_a text NOT NULL,
  action_b text NOT NULL,
  scope text NOT NULL CHECK (scope IN ('SAME_RECORD', 'SAME_PROJECT', 'SAME_CONTRACT', 'SAME_PACKAGE')),
  subject_id uuid NOT NULL,
  member_id uuid NOT NULL,
  taking text NOT NULL,
  command text NOT NULL CHECK (command = btrim(command) AND char_length(command) BETWEEN 3 AND 80),
  record_id uuid NOT NULL,
  rule_version integer NOT NULL CHECK (rule_version >= 0),
  request_id text,
  used_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, exception_id) REFERENCES machvon.sod_exception (tenant_id, id),
  FOREIGN KEY (tenant_id, member_id) REFERENCES machvon.membership (tenant_id, id),
  CONSTRAINT sod_exception_use_shape_chk CHECK ((outcome = 'EXCEPTION_USED' AND exception_id IS NOT NULL) OR (outcome IN ('WARNED', 'BLOCKED') AND exception_id IS NULL))
);

CREATE INDEX sod_exception_use_exception_idx ON machvon.sod_exception_use (tenant_id, exception_id, used_at DESC) WHERE exception_id IS NOT NULL;
CREATE INDEX sod_exception_use_list_idx ON machvon.sod_exception_use (tenant_id, used_at DESC, id DESC);
CREATE INDEX sod_exception_use_member_idx ON machvon.sod_exception_use (tenant_id, member_id, used_at DESC);

ALTER TABLE machvon.sod_exception_use ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.sod_exception_use FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.sod_exception_use AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.sod_exception_use AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.sod_exception_use FROM machvon_app;

COMMENT ON TABLE machvon.sod_exception_use IS 'Commands that met a conflict of the separation of duties: went through by an exception or a warning, or refused; append-only, read by the auditor.';
