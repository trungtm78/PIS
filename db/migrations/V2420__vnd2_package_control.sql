-- Authored by hand (not generated): what a procurement package asks of its bidders for the controls of VND-2 (research V7, V10; docs/vendor-controls-independence-finance.md).
--   * `vendor_package_control`: the base amount of the bid security the package asks of a normal bidder, the last day the bids are valid, the estimated value and the months the work lasts. The finance test of a
--     bidder reads the yearly value from here (falling back to the budget of the package), and the bid security of a bidder is judged against the amount and the day.
-- A row is replaced in place (a version number guards it); the audit trail of the command keeps what it was.

CREATE TABLE machvon.vendor_package_control (
  tenant_id uuid NOT NULL,
  package_id uuid NOT NULL,
  security_base_amount numeric(24,0) CHECK (security_base_amount IS NULL OR security_base_amount >= 0),
  bid_valid_until date,
  estimated_value numeric(24,0) CHECK (estimated_value IS NULL OR estimated_value >= 0),
  duration_months integer CHECK (duration_months IS NULL OR duration_months BETWEEN 1 AND 600),
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid NOT NULL,
  PRIMARY KEY (tenant_id, package_id),
  FOREIGN KEY (tenant_id, package_id) REFERENCES machvon.procurement_package (tenant_id, id)
);

ALTER TABLE machvon.vendor_package_control ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.vendor_package_control FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.vendor_package_control AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.vendor_package_control AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE DELETE, TRUNCATE ON TABLE machvon.vendor_package_control FROM machvon_app;

COMMENT ON TABLE machvon.vendor_package_control IS 'VND-2: what a package asks of its bidders for the controls: bid security base amount, bid validity day, estimated value and duration.';
