-- Authored by hand (not generated): the exception to a ceiling of disbursement (G4-2 / G4-5 of docs/governance-roadmap-10of10.md, lane D).
-- A payment request that would take the money above the capital plan line or above the price of the contract is blocked by the payment integrity checks (V1835). An exception is the one way past that block: it names the request
-- and the ceiling, the most it lets go over (allowed_amount_vnd), a day it lapses (valid_to, never later than the rule PAYMENT_INTEGRITY allows) and a reason; it is asked by one person and decided by another who did not draw up
-- or send the request (the command checks that), it is used once (the request that sends under it, in the same transaction) and it lapses on its day. EXCEEDS_ACCEPTED has no exception: the value of an acceptance is kept by the
-- ledger itself (V002 ledger checks) and a request above it needs a new acceptance.

CREATE TABLE machvon.disbursement_exception (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  payment_request_id uuid NOT NULL,
  contract_id uuid NOT NULL,
  project_id uuid NOT NULL,
  ceiling text NOT NULL CHECK (ceiling IN ('EXCEEDS_PLAN', 'EXCEEDS_CONTRACT')),
  allowed_amount_vnd numeric(24, 0) NOT NULL CHECK (allowed_amount_vnd > 0),
  valid_to date NOT NULL,
  reason text NOT NULL CHECK (reason = btrim(reason) AND char_length(reason) BETWEEN 1 AND 2000),
  status text NOT NULL DEFAULT 'REQUESTED' CHECK (status IN ('REQUESTED', 'APPROVED', 'REJECTED', 'REVOKED', 'USED')),
  requested_by uuid NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid,
  decided_at timestamptz,
  decision_note text CHECK (decision_note IS NULL OR (decision_note = btrim(decision_note) AND char_length(decision_note) BETWEEN 1 AND 2000)),
  used_at timestamptz,
  used_run_id uuid,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, payment_request_id) REFERENCES machvon.payment_request (tenant_id, id),
  FOREIGN KEY (tenant_id, contract_id) REFERENCES machvon.contract (tenant_id, id),
  FOREIGN KEY (tenant_id, requested_by) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, decided_by) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, used_run_id) REFERENCES machvon.payment_integrity_run (tenant_id, id),
  -- Four eyes: whoever asked does not decide.
  CONSTRAINT disbursement_exception_four_eyes_chk CHECK (decided_by IS NULL OR decided_by <> requested_by),
  -- A decision is one person, one moment and (for a refusal or a revocation) the words; a request has none of them; a use has its moment and its run.
  CONSTRAINT disbursement_exception_shape_chk CHECK (
    (status = 'REQUESTED' AND decided_by IS NULL AND decided_at IS NULL AND used_at IS NULL AND used_run_id IS NULL)
    OR (status = 'APPROVED' AND decided_by IS NOT NULL AND decided_at IS NOT NULL AND used_at IS NULL AND used_run_id IS NULL)
    OR (status IN ('REJECTED', 'REVOKED') AND decided_by IS NOT NULL AND decided_at IS NOT NULL AND decision_note IS NOT NULL AND used_at IS NULL)
    OR (status = 'USED' AND decided_by IS NOT NULL AND decided_at IS NOT NULL AND used_at IS NOT NULL AND used_run_id IS NOT NULL)
  )
);

-- One live exception (asked or approved) for a request and a ceiling: the second ask is told the first one stands.
CREATE UNIQUE INDEX disbursement_exception_live_uq ON machvon.disbursement_exception (tenant_id, payment_request_id, ceiling) WHERE status IN ('REQUESTED', 'APPROVED');
CREATE INDEX disbursement_exception_list_idx ON machvon.disbursement_exception (tenant_id, status, valid_to, id);
CREATE INDEX disbursement_exception_request_idx ON machvon.disbursement_exception (tenant_id, payment_request_id, created_at DESC);
CREATE INDEX disbursement_exception_contract_idx ON machvon.disbursement_exception (tenant_id, contract_id, created_at DESC);
CREATE INDEX disbursement_exception_expiring_idx ON machvon.disbursement_exception (tenant_id, valid_to) WHERE status = 'APPROVED';

ALTER TABLE machvon.disbursement_exception ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.disbursement_exception FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.disbursement_exception AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.disbursement_exception AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- An exception is never removed: its history is the evidence of why money went over a ceiling.
REVOKE DELETE, TRUNCATE ON TABLE machvon.disbursement_exception FROM machvon_app;

-- The findings of V1835 that an exception covered point at it (the table did not exist when V1835 ran).
ALTER TABLE machvon.payment_integrity_finding
  ADD CONSTRAINT payment_integrity_finding_exception_fk FOREIGN KEY (tenant_id, exception_id) REFERENCES machvon.disbursement_exception (tenant_id, id);

COMMENT ON TABLE machvon.disbursement_exception IS 'An approved, time-limited, single-use exception to a ceiling of disbursement (plan line or contract price); asked and decided by two different people (G4-2, G4-5).';

-- Indexes that lead with the tenant under every foreign key and reference column, so the reads by that column and the checks of the foreign keys do not scan (rule ST-CTR-013, rls-catalog).
CREATE INDEX disbursement_exception_project_idx ON machvon.disbursement_exception (tenant_id, project_id);
