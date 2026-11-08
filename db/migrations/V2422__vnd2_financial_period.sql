-- Authored by hand (not generated): the financial statements of a contractor year by year (VND-2, research V7; docs/vendor-controls-independence-finance.md).
--   * `vendor_financial_period`: the figures of one fiscal year as a person entered them from the audited report, and the person who checked them against the paper (another person; a paper is needed). The figures never
--     change: a corrected year is a new row, and the row it replaces is marked superseded, so the figures that stood on the day of an evaluation stay answerable. Only verified figures count in a test.

CREATE TABLE machvon.vendor_financial_period (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  contractor_id uuid NOT NULL,
  fiscal_year integer NOT NULL CHECK (fiscal_year BETWEEN 1990 AND 2200),
  revenue numeric(24,0) NOT NULL CHECK (revenue >= 0),
  total_assets numeric(24,0) NOT NULL CHECK (total_assets >= 0),
  current_assets numeric(24,0) NOT NULL CHECK (current_assets >= 0),
  current_liabilities numeric(24,0) NOT NULL CHECK (current_liabilities >= 0),
  total_debt numeric(24,0) NOT NULL CHECK (total_debt >= 0),
  equity numeric(24,0) NOT NULL,
  ebit numeric(24,0) NOT NULL,
  interest_expense numeric(24,0) NOT NULL CHECK (interest_expense >= 0),
  document_id uuid,
  verified_by uuid,
  verified_at timestamptz,
  superseded_by_id uuid,
  superseded_at timestamptz,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, contractor_id) REFERENCES machvon.contractor (tenant_id, id),
  FOREIGN KEY (tenant_id, superseded_by_id) REFERENCES machvon.vendor_financial_period (tenant_id, id) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT vendor_financial_period_assets_chk CHECK (current_assets <= total_assets),
  CONSTRAINT vendor_financial_period_verified_chk CHECK ((verified_by IS NULL) = (verified_at IS NULL) AND (verified_by IS NULL OR (verified_by <> created_by AND document_id IS NOT NULL))),
  CONSTRAINT vendor_financial_period_superseded_chk CHECK ((superseded_by_id IS NULL) = (superseded_at IS NULL))
);
CREATE UNIQUE INDEX vendor_financial_period_active_uq ON machvon.vendor_financial_period (tenant_id, contractor_id, fiscal_year) WHERE superseded_by_id IS NULL;
CREATE INDEX vendor_financial_period_contractor_idx ON machvon.vendor_financial_period (tenant_id, contractor_id, fiscal_year DESC);
CREATE INDEX vendor_financial_period_document_idx ON machvon.vendor_financial_period (tenant_id, document_id) WHERE document_id IS NOT NULL;
CREATE INDEX vendor_financial_period_superseded_idx ON machvon.vendor_financial_period (tenant_id, superseded_by_id) WHERE superseded_by_id IS NOT NULL;

-- The reference to the row that replaces a period is checked at the end of the transaction: the old row is marked first (which frees the year of the unique index), then the new row is inserted.
-- The figures, the paper and the year never change; a verification stays as it was made; a period is superseded once.
CREATE FUNCTION machvon.guard_vendor_financial_period() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a financial period of a contractor is never deleted' USING ERRCODE = '23514';
  END IF;
  IF (NEW.contractor_id, NEW.fiscal_year, NEW.revenue, NEW.total_assets, NEW.current_assets, NEW.current_liabilities, NEW.total_debt, NEW.equity, NEW.ebit, NEW.interest_expense, NEW.document_id, NEW.created_by)
     IS DISTINCT FROM
     (OLD.contractor_id, OLD.fiscal_year, OLD.revenue, OLD.total_assets, OLD.current_assets, OLD.current_liabilities, OLD.total_debt, OLD.equity, OLD.ebit, OLD.interest_expense, OLD.document_id, OLD.created_by) THEN
    RAISE EXCEPTION 'the figures of a financial period are not rewritten: a corrected year is a new row' USING ERRCODE = '23514';
  END IF;
  IF OLD.verified_by IS NOT NULL AND (NEW.verified_by IS DISTINCT FROM OLD.verified_by OR NEW.verified_at IS DISTINCT FROM OLD.verified_at) THEN
    RAISE EXCEPTION 'a verification stays as it was made' USING ERRCODE = '23514';
  END IF;
  IF OLD.superseded_by_id IS NOT NULL AND (NEW.superseded_by_id IS DISTINCT FROM OLD.superseded_by_id OR NEW.superseded_at IS DISTINCT FROM OLD.superseded_at) THEN
    RAISE EXCEPTION 'a period that was superseded stays superseded' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;
CREATE TRIGGER vendor_financial_period_guard BEFORE UPDATE OR DELETE ON machvon.vendor_financial_period FOR EACH ROW EXECUTE FUNCTION machvon.guard_vendor_financial_period();

ALTER TABLE machvon.vendor_financial_period ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.vendor_financial_period FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.vendor_financial_period AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.vendor_financial_period AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE DELETE, TRUNCATE ON TABLE machvon.vendor_financial_period FROM machvon_app;

COMMENT ON TABLE machvon.vendor_financial_period IS 'VND-2: the figures of one fiscal year of a contractor, verified by a second person; a corrected year supersedes, never rewrites.';
