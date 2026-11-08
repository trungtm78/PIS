-- Authored by hand (not generated): the frozen contract fact (CA-1, eng-review R16 and R17). When DIS freezes a close snapshot of a period, the contract fact of the same cut-off day is frozen with it: one row per contract per ACTIVE
-- party (the dataset DS-CTR of BI), the money of a contract already attributed to its parties by the largest remainder (whole dong, a joint venture counted once), the flags that belong to the contract (single bidder,
-- days late) on the line of the lead party only. A snapshot is APPEND-ONLY: it is never updated or deleted, a correction is a new snapshot.
--
-- Lineage (R17): the snapshot says which snapshot of DIS it belongs to and the revision of the period it is (1 for the first freezing, +1 each time DIS freezes the period again), and the one it replaces. A report, a read or a push
-- that carries an older revision than the latest one of the period is flagged stale, and a push of an older one is refused. The common cut-off day is the one of the DIS snapshot, so the disbursement figures and the contract
-- figures of one period are of one day.

CREATE TABLE machvon.contract_fact_snapshot (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  -- the snapshot of DIS this one belongs to (one fact snapshot per DIS snapshot) and its period
  period_snapshot_id uuid NOT NULL,
  period_id uuid NOT NULL,
  -- 1 for the first snapshot of the period, the revision of the one it replaces + 1 for a correction
  revision integer NOT NULL CHECK (revision >= 1),
  supersedes_id uuid,
  cutoff_date date NOT NULL,
  as_of_date date NOT NULL,
  contract_count integer NOT NULL CHECK (contract_count >= 0),
  row_count integer NOT NULL CHECK (row_count >= contract_count),
  payload_sha256 char(64) NOT NULL,
  built_by uuid NOT NULL,
  built_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, period_snapshot_id) REFERENCES machvon.period_snapshot (tenant_id, id),
  FOREIGN KEY (tenant_id, supersedes_id) REFERENCES machvon.contract_fact_snapshot (tenant_id, id),
  CONSTRAINT contract_fact_snapshot_lineage_chk CHECK ((revision = 1) = (supersedes_id IS NULL)),
  CONSTRAINT contract_fact_snapshot_period_snapshot_uq UNIQUE (tenant_id, period_snapshot_id),
  CONSTRAINT contract_fact_snapshot_revision_uq UNIQUE (tenant_id, period_id, revision)
);

CREATE INDEX contract_fact_snapshot_period_idx ON machvon.contract_fact_snapshot (tenant_id, period_id, revision DESC);

-- The row of `contract_fact` of every contract as it stood at the cut-off day, whole, as the view gave it (the frozen report and the frozen portfolio read it back with jsonb_populate_record over the type of the view, so a
-- frozen reading and a live one are one query).
CREATE TABLE machvon.contract_fact_snapshot_contract (
  tenant_id uuid NOT NULL,
  snapshot_id uuid NOT NULL,
  contract_id uuid NOT NULL,
  fact jsonb NOT NULL CHECK (jsonb_typeof(fact) = 'object'),
  PRIMARY KEY (tenant_id, snapshot_id, contract_id),
  FOREIGN KEY (tenant_id, snapshot_id) REFERENCES machvon.contract_fact_snapshot (tenant_id, id)
);

CREATE TABLE machvon.contract_fact_snapshot_line (
  tenant_id uuid NOT NULL,
  snapshot_id uuid NOT NULL,
  -- the snapshot of DIS: the column the query of BI pins the lines by (the version of the dataset names it as its source snapshot)
  period_snapshot_id uuid NOT NULL,
  contract_id uuid NOT NULL,
  contractor_id uuid NOT NULL,
  is_lead boolean NOT NULL,
  share_pct numeric(7, 4) NOT NULL CHECK (share_pct > 0 AND share_pct <= 100),
  project_id uuid NOT NULL,
  unit_id uuid NOT NULL,
  investor_id uuid,
  fund_source_version_id uuid,
  contract_status text NOT NULL,
  contract_type text NOT NULL,
  contract_value_vnd numeric(24, 0) NOT NULL CHECK (contract_value_vnd >= 0),
  active_value_vnd numeric(24, 0) NOT NULL CHECK (active_value_vnd >= 0),
  original_value_vnd numeric(24, 0) NOT NULL CHECK (original_value_vnd >= 0),
  approved_change_delta_vnd numeric(24, 0) NOT NULL,
  winning_bid_vnd numeric(24, 0) CHECK (winning_bid_vnd IS NULL OR winning_bid_vnd >= 0),
  bid_variance_vnd numeric(24, 0),
  requested_vnd numeric(24, 0) NOT NULL CHECK (requested_vnd >= 0),
  accepted_vnd numeric(24, 0) NOT NULL CHECK (accepted_vnd >= 0),
  paid_vnd numeric(24, 0) NOT NULL CHECK (paid_vnd >= 0),
  advance_paid_vnd numeric(24, 0),
  advance_recovered_vnd numeric(24, 0),
  advance_outstanding_vnd numeric(24, 0),
  retention_withheld_vnd numeric(24, 0),
  retention_released_vnd numeric(24, 0),
  retention_held_vnd numeric(24, 0),
  guarantee_required_vnd numeric(24, 0),
  guarantee_valid_vnd numeric(24, 0),
  -- on the line of the lead party only (a count of contracts is not split between parties)
  single_bidder_flag smallint CHECK (single_bidder_flag IS NULL OR single_bidder_flag IN (0, 1)),
  bidder_known_flag smallint CHECK (bidder_known_flag IS NULL OR bidder_known_flag IN (0, 1)),
  days_late integer CHECK (days_late IS NULL OR days_late >= 0),
  PRIMARY KEY (tenant_id, snapshot_id, contract_id, contractor_id),
  FOREIGN KEY (tenant_id, snapshot_id) REFERENCES machvon.contract_fact_snapshot (tenant_id, id),
  CONSTRAINT contract_fact_snapshot_line_flag_chk CHECK (is_lead OR (single_bidder_flag IS NULL AND bidder_known_flag IS NULL AND days_late IS NULL))
);

CREATE INDEX contract_fact_snapshot_line_pin_idx ON machvon.contract_fact_snapshot_line (tenant_id, period_snapshot_id, unit_id);
CREATE INDEX contract_fact_snapshot_line_contractor_idx ON machvon.contract_fact_snapshot_line (tenant_id, period_snapshot_id, contractor_id);
CREATE INDEX contract_fact_snapshot_line_project_idx ON machvon.contract_fact_snapshot_line (tenant_id, project_id);

-- Append-only, for everyone: the application role has no right to change or remove a row, and a trigger refuses it for any other role too.
CREATE FUNCTION machvon.contract_fact_snapshot_append_only() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  RAISE EXCEPTION 'a snapshot of the contract fact is append-only' USING ERRCODE = '23514';
END;
$fn$;

CREATE TRIGGER contract_fact_snapshot_append_only BEFORE UPDATE OR DELETE ON machvon.contract_fact_snapshot FOR EACH ROW EXECUTE FUNCTION machvon.contract_fact_snapshot_append_only();
CREATE TRIGGER contract_fact_snapshot_contract_append_only BEFORE UPDATE OR DELETE ON machvon.contract_fact_snapshot_contract FOR EACH ROW EXECUTE FUNCTION machvon.contract_fact_snapshot_append_only();
CREATE TRIGGER contract_fact_snapshot_line_append_only BEFORE UPDATE OR DELETE ON machvon.contract_fact_snapshot_line FOR EACH ROW EXECUTE FUNCTION machvon.contract_fact_snapshot_append_only();

ALTER TABLE machvon.contract_fact_snapshot ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.contract_fact_snapshot FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.contract_fact_snapshot AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.contract_fact_snapshot AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE machvon.contract_fact_snapshot_contract ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.contract_fact_snapshot_contract FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.contract_fact_snapshot_contract AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.contract_fact_snapshot_contract AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE machvon.contract_fact_snapshot_line ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.contract_fact_snapshot_line FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.contract_fact_snapshot_line AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.contract_fact_snapshot_line AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.contract_fact_snapshot FROM machvon_app;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.contract_fact_snapshot_contract FROM machvon_app;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.contract_fact_snapshot_line FROM machvon_app;

COMMENT ON TABLE machvon.contract_fact_snapshot IS 'The contract fact frozen with a DIS close snapshot (CA-1): the DIS snapshot and period revision it belongs to, the common cut-off day, the hash of its lines, the one it replaces (R17); append-only.';
COMMENT ON TABLE machvon.contract_fact_snapshot_contract IS 'The row of contract_fact of each contract at the cut-off day, whole (CA-1): what a frozen report is read from; append-only.';
COMMENT ON TABLE machvon.contract_fact_snapshot_line IS 'One line per contract per active party (DS-CTR): money attributed to the party by the largest remainder; the flags and the days late on the lead line only; append-only.';

-- Indexes that lead with the tenant under every foreign key and reference column, so the reads by that column and the checks of the foreign keys do not scan (rule ST-CTR-013, rls-catalog).
CREATE INDEX contract_fact_snapshot_supersedes_idx ON machvon.contract_fact_snapshot (tenant_id, supersedes_id) WHERE supersedes_id IS NOT NULL;
CREATE INDEX contract_fact_snapshot_contract_contract_idx ON machvon.contract_fact_snapshot_contract (tenant_id, contract_id);
CREATE INDEX contract_fact_snapshot_line_contract_idx ON machvon.contract_fact_snapshot_line (tenant_id, contract_id);
CREATE INDEX contract_fact_snapshot_line_contractor_id_ix ON machvon.contract_fact_snapshot_line (tenant_id, contractor_id);
CREATE INDEX contract_fact_snapshot_line_fund_source_version_idx ON machvon.contract_fact_snapshot_line (tenant_id, fund_source_version_id) WHERE fund_source_version_id IS NOT NULL;
CREATE INDEX contract_fact_snapshot_line_investor_idx ON machvon.contract_fact_snapshot_line (tenant_id, investor_id) WHERE investor_id IS NOT NULL;
CREATE INDEX contract_fact_snapshot_line_unit_idx ON machvon.contract_fact_snapshot_line (tenant_id, unit_id);
