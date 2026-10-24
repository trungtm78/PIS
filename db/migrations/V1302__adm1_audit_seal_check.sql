-- Authored by hand (not generated): the latest outcome of the verification of the audit seal chain (ST-ADM-016, ADM 3.11, BR-PLT-01).
-- The hourly `audit-verify` job walks every seal of a tenant. Its verdict used to live only in an alert and in the process log; the audit
-- viewer (ADM-11) must show a banner while the chain does not verify, so the verdict is kept: one row per tenant, replaced by each run.
-- A row older than three runs of the job is itself a finding (the verifier has stopped), which the reader reports as STALE.
--
-- The row is evidence about the chain, not part of it: the chain stays the audit_event and audit_seal rows, which remain append-only.

CREATE TABLE machvon.audit_seal_check (
  tenant_id uuid NOT NULL,
  checked_at timestamptz NOT NULL,
  ok boolean NOT NULL,
  seals integer NOT NULL CHECK (seals >= 0),
  broken_seal uuid,
  broken_from_seq bigint,
  broken_to_seq bigint,
  broken_reason text CHECK (broken_reason IS NULL OR broken_reason IN ('ROOT_MISMATCH', 'SEAL_HASH_MISMATCH', 'CHAIN_LINK_MISMATCH', 'UNSEALED_ROW_IN_GAP')),
  PRIMARY KEY (tenant_id),
  -- A verdict that failed says where; one that passed says nothing of the kind.
  CHECK ((ok AND broken_seal IS NULL AND broken_from_seq IS NULL AND broken_to_seq IS NULL AND broken_reason IS NULL)
      OR (NOT ok AND broken_seal IS NOT NULL AND broken_from_seq IS NOT NULL AND broken_to_seq IS NOT NULL AND broken_reason IS NOT NULL))
);

ALTER TABLE machvon.audit_seal_check ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.audit_seal_check FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.audit_seal_check AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.audit_seal_check AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- The verdict is replaced, never deleted: a tenant always has the last word of the verifier.
REVOKE DELETE, TRUNCATE ON TABLE machvon.audit_seal_check FROM machvon_app;

-- The viewer filters by a period and the export is cut by one: the tenant's rows by time, without reading the whole trail.
CREATE INDEX audit_event_time_idx ON machvon.audit_event (tenant_id, occurred_at, seq);
