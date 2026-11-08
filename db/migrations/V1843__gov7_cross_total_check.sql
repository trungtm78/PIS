-- Authored by hand (not generated): the cross-total control of the disbursed money (G4-5): the same figure added up by unit (the lines of the period snapshot), by fund and by project (the ledger of the Treasury) must be one number to the
-- dong. A row is one check of one snapshot. A check that is not `published` stops the freeze of the snapshot (the indicator is not published) and says which dimension disagrees and by how much; the largest gaps by key are kept as the
-- evidence. Append-only: the checks of a snapshot are the history of why it was or was not frozen.

CREATE TABLE machvon.cross_total_check (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  snapshot_id uuid NOT NULL,
  period_id uuid,
  fiscal_year integer NOT NULL CHECK (fiscal_year BETWEEN 2000 AND 2100),
  treasury_cutoff_date date NOT NULL,
  published boolean NOT NULL,
  total_unit_vnd numeric(24,0) NOT NULL,
  total_fund_vnd numeric(24,0) NOT NULL,
  total_project_vnd numeric(24,0) NOT NULL,
  disagreeing text[] NOT NULL DEFAULT '{}',
  agreeing text[] NOT NULL DEFAULT '{}',
  -- Money of the Treasury that no fund could be found for (a part of the fund total, shown apart).
  unattributed_fund_vnd numeric(24,0) NOT NULL DEFAULT 0,
  detail jsonb NOT NULL CHECK (jsonb_typeof(detail) = 'object'),
  origin text NOT NULL CHECK (origin IN ('FREEZE_GATE', 'MANUAL')),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, snapshot_id) REFERENCES machvon.period_snapshot (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES machvon.membership (tenant_id, id),
  CONSTRAINT cross_total_check_dimensions_chk CHECK (disagreeing <@ ARRAY['UNIT', 'FUND', 'PROJECT']::text[] AND agreeing <@ ARRAY['UNIT', 'FUND', 'PROJECT']::text[]),
  -- Published means the three agree to the dong and nobody disagrees; not published means somebody is named.
  CONSTRAINT cross_total_check_published_chk CHECK (
    published = (cardinality(disagreeing) = 0 AND total_unit_vnd = total_fund_vnd AND total_fund_vnd = total_project_vnd)
  )
);

CREATE INDEX cross_total_check_snapshot_idx ON machvon.cross_total_check (tenant_id, snapshot_id, created_at DESC, id);

ALTER TABLE machvon.cross_total_check ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.cross_total_check FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.cross_total_check AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.cross_total_check AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.cross_total_check FROM machvon_app;

COMMENT ON TABLE machvon.cross_total_check IS 'Cross-total checks of a period snapshot (G4-5): unit = fund = project to the dong or the indicator is not published; append-only.';

-- Indexes that lead with the tenant under every foreign key and reference column, so the reads by that column and the checks of the foreign keys do not scan (rule ST-CTR-013, rls-catalog).
CREATE INDEX cross_total_check_period_idx ON machvon.cross_total_check (tenant_id, period_id) WHERE period_id IS NOT NULL;
