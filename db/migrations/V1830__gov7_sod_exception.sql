-- Authored by hand (not generated): the exceptions to the separation of duties (G4-1, ADM 3.6). The matrix of conflicting duties is the governance rule `SOD_MATRIX` (V1850); this keeps what the matrix cannot: a person who asked, with a reason and
-- days, to hold both duties of a pair on one record, project, contract or package, and the other people who agreed (V1831, a second table, append-only). An exception is time-limited by the matrix (`exception_max_days` of the pair, 0 means none), needs
-- `approvers_needed` distinct approvers (at least 2, taken from the matrix when it was asked) who are neither the person who asked nor the person it covers (the guard in V1833 says so again), and ends by the calendar (`valid_to`) without a write:
-- the reader derives EXPIRED. REVOKED is a move of an administrator. Every use is kept in V1832.
-- `subject_id` is the id of the thing the exception covers in the scope of the pair (the record for SAME_RECORD, the project, the contract, the package): an exception is never wider than one subject.

CREATE TABLE machvon.sod_exception (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  action_a text NOT NULL CHECK (action_a ~ '^[a-z][a-z_]*\.[a-z][a-z_]*$'),
  action_b text NOT NULL CHECK (action_b ~ '^[a-z][a-z_]*\.[a-z][a-z_]*$' AND action_b <> action_a),
  scope text NOT NULL CHECK (scope IN ('SAME_RECORD', 'SAME_PROJECT', 'SAME_CONTRACT', 'SAME_PACKAGE')),
  subject_id uuid NOT NULL,
  member_id uuid NOT NULL,
  requested_by uuid NOT NULL,
  reason text NOT NULL CHECK (reason = btrim(reason) AND char_length(reason) BETWEEN 10 AND 500),
  valid_from date NOT NULL,
  valid_to date NOT NULL,
  rule_version integer NOT NULL CHECK (rule_version >= 0),
  approvers_needed smallint NOT NULL CHECK (approvers_needed BETWEEN 2 AND 3),
  approvals smallint NOT NULL DEFAULT 0 CHECK (approvals >= 0),
  status text NOT NULL DEFAULT 'REQUESTED' CHECK (status IN ('REQUESTED', 'APPROVED', 'REJECTED', 'REVOKED')),
  decided_at timestamptz,
  revoked_by uuid,
  revoked_at timestamptz,
  revoke_reason text CHECK (revoke_reason IS NULL OR (revoke_reason = btrim(revoke_reason) AND char_length(revoke_reason) BETWEEN 10 AND 500)),
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, member_id) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, requested_by) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, revoked_by) REFERENCES machvon.membership (tenant_id, id),
  CONSTRAINT sod_exception_days_chk CHECK (valid_to >= valid_from),
  CONSTRAINT sod_exception_approvals_chk CHECK (approvals <= approvers_needed AND (status <> 'APPROVED' OR approvals >= approvers_needed)),
  CONSTRAINT sod_exception_status_chk CHECK (
    (status = 'REQUESTED' AND decided_at IS NULL AND revoked_by IS NULL AND revoked_at IS NULL AND revoke_reason IS NULL)
    OR (status IN ('APPROVED', 'REJECTED') AND decided_at IS NOT NULL AND revoked_by IS NULL AND revoked_at IS NULL AND revoke_reason IS NULL)
    OR (status = 'REVOKED' AND revoked_by IS NOT NULL AND revoked_at IS NOT NULL AND revoke_reason IS NOT NULL)
  )
);

-- No two live exceptions (asked or approved) for the same person, pair and subject cover the same day: the second asks for a day the first does not cover, or the first is revoked.
ALTER TABLE machvon.sod_exception
  ADD CONSTRAINT sod_exception_no_overlap EXCLUDE USING gist (
    tenant_id WITH =,
    member_id WITH =,
    action_a WITH =,
    action_b WITH =,
    scope WITH =,
    subject_id WITH =,
    daterange(valid_from, valid_to, '[]') WITH &&
  ) WHERE (status IN ('REQUESTED', 'APPROVED'));

CREATE INDEX sod_exception_member_idx ON machvon.sod_exception (tenant_id, member_id, valid_to DESC);
CREATE INDEX sod_exception_list_idx ON machvon.sod_exception (tenant_id, created_at DESC, id DESC);
CREATE INDEX sod_exception_live_idx ON machvon.sod_exception (tenant_id, valid_to) WHERE status IN ('REQUESTED', 'APPROVED');

ALTER TABLE machvon.sod_exception ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.sod_exception FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.sod_exception AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.sod_exception AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
REVOKE DELETE, TRUNCATE ON TABLE machvon.sod_exception FROM machvon_app;

COMMENT ON TABLE machvon.sod_exception IS 'Time-limited exceptions to the separation of duties (G4-1): one person, one pair of duties, one subject, days, a reason, and approvers who are neither the requester nor the person covered.';
