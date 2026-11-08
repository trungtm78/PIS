-- Authored by hand (not generated): the comparisons of the feed with our own figures that were run (FEED-1, docs/finance-feed.md section 7).
-- A reconciliation compares, for every project of the feed that is mapped to one of ours, the plan and the disbursement of a fiscal year with the DIS snapshot in force and the Treasury statements, and opens an item
-- (`finance_feed_difference`) for each figure that differs. This table keeps what each comparison covered, so that the discrepancy rate of the data-quality indicators has its denominator (the figures compared)
-- and not only its numerator. Append-only for every role.

CREATE TABLE machvon.finance_feed_reconciliation (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  fiscal_year integer NOT NULL,
  projects_compared integer NOT NULL,
  figures_compared integer NOT NULL,
  differences_opened integer NOT NULL,
  differences_existing integer NOT NULL,
  skipped_owner_is_maker integer NOT NULL DEFAULT 0,
  owner_id uuid NOT NULL,
  run_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT finance_feed_reconciliation_year_chk CHECK (fiscal_year BETWEEN 2000 AND 2100),
  CONSTRAINT finance_feed_reconciliation_counts_chk CHECK (projects_compared >= 0 AND figures_compared >= 0 AND differences_opened >= 0 AND differences_existing >= 0 AND skipped_owner_is_maker >= 0)
);
CREATE INDEX finance_feed_reconciliation_year_idx ON machvon.finance_feed_reconciliation (tenant_id, fiscal_year, created_at DESC, id DESC);
CREATE INDEX finance_feed_reconciliation_owner_idx ON machvon.finance_feed_reconciliation (tenant_id, owner_id);
CREATE INDEX finance_feed_reconciliation_actor_idx ON machvon.finance_feed_reconciliation (tenant_id, run_by);

CREATE FUNCTION machvon.finance_feed_reconciliation_append_only() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  RAISE EXCEPTION 'a record of a reconciliation run is append-only' USING ERRCODE = '23514';
END;
$fn$;

CREATE TRIGGER finance_feed_reconciliation_append_only BEFORE UPDATE OR DELETE ON machvon.finance_feed_reconciliation FOR EACH ROW EXECUTE FUNCTION machvon.finance_feed_reconciliation_append_only();

ALTER TABLE machvon.finance_feed_reconciliation ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.finance_feed_reconciliation FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.finance_feed_reconciliation AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.finance_feed_reconciliation AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.finance_feed_reconciliation FROM machvon_app;

COMMENT ON TABLE machvon.finance_feed_reconciliation IS 'FEED-1: one comparison of the feed with our own figures: what it covered and what it opened; append-only.';
