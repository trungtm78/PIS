-- Authored by hand (not generated): the lines of a daily reconciliation pass (G4-4): for one business day, one line for each project code and fund, with what the books say and what the Treasury says, both signed whole dong (a refund
-- takes off). `fund_key` is the code of the fund source (`master_record_version.code`) read through the allocation line of the transaction or of the payment it is matched to; money that no fund could be found for is `UNMATCHED`.
-- The difference is generated, never written. A line that holds a difference says its kind and whether it opened an item (V1842). Append-only, with the pass.

CREATE TABLE machvon.treasury_daily_recon_line (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL,
  project_id uuid NOT NULL,
  project_code text NOT NULL,
  fund_key text NOT NULL CHECK (fund_key = btrim(fund_key) AND char_length(fund_key) BETWEEN 1 AND 100),
  fund_label text,
  books_vnd numeric(24,0) NOT NULL,
  treasury_vnd numeric(24,0) NOT NULL,
  difference_vnd numeric(24,0) GENERATED ALWAYS AS (treasury_vnd - books_vnd) STORED,
  books_count integer NOT NULL DEFAULT 0 CHECK (books_count >= 0),
  treasury_count integer NOT NULL DEFAULT 0 CHECK (treasury_count >= 0),
  kind text CHECK (kind IN ('TIMING', 'UNMATCHED', 'MISSING_ON_TREASURY', 'MISSING_INTERNAL', 'AMOUNT')),
  opens_item boolean NOT NULL DEFAULT false,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES machvon.treasury_daily_recon_run (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES machvon.project (tenant_id, id),
  CONSTRAINT treasury_daily_recon_line_uq UNIQUE (tenant_id, run_id, project_id, fund_key),
  -- A line of equal sides has no kind; a line that differs has one; only a line that differs opens an item.
  CONSTRAINT treasury_daily_recon_line_kind_chk CHECK ((books_vnd = treasury_vnd) = (kind IS NULL)),
  CONSTRAINT treasury_daily_recon_line_opens_chk CHECK (NOT opens_item OR (kind IS NOT NULL AND kind <> 'TIMING'))
);

CREATE INDEX treasury_daily_recon_line_project_idx ON machvon.treasury_daily_recon_line (tenant_id, project_id, run_id);

ALTER TABLE machvon.treasury_daily_recon_line ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.treasury_daily_recon_line FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.treasury_daily_recon_line AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.treasury_daily_recon_line AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.treasury_daily_recon_line FROM machvon_app;

COMMENT ON TABLE machvon.treasury_daily_recon_line IS 'Lines of a daily reconciliation pass: books against the Treasury for one project code and one fund on one day; append-only.';
