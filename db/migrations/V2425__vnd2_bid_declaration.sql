-- Authored by hand (not generated): what a bidder declared in its bid about subcontracting (VND-2, research V11; docs/vendor-controls-security-subcontract.md).
-- The law forbids a prime contractor to hand over more than the part it named in its bid (Dieu 16 Luat Dau thau 22/2023). The declaration says which subcontractors the bid named and the share of the contract value it
-- declared for subcontracting in total. A declaration is never edited: a new one for the same package and bidder supersedes the one before (the older stays as the record of what the bid said).

CREATE TABLE machvon.vendor_bid_declaration (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  package_id uuid NOT NULL,
  contractor_id uuid NOT NULL,
  declared_share_pct numeric(7,4) NOT NULL CHECK (declared_share_pct >= 0 AND declared_share_pct <= 100),
  document_id uuid,
  superseded_at timestamptz,
  superseded_by uuid,
  declared_by uuid NOT NULL,
  declared_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, package_id) REFERENCES machvon.procurement_package (tenant_id, id),
  FOREIGN KEY (tenant_id, contractor_id) REFERENCES machvon.contractor (tenant_id, id),
  FOREIGN KEY (tenant_id, declared_by) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, superseded_by) REFERENCES machvon.vendor_bid_declaration (tenant_id, id) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT vendor_bid_declaration_superseded_chk CHECK ((superseded_at IS NULL) = (superseded_by IS NULL))
);
CREATE UNIQUE INDEX vendor_bid_declaration_live_uq ON machvon.vendor_bid_declaration (tenant_id, package_id, contractor_id) WHERE superseded_at IS NULL;
CREATE INDEX vendor_bid_declaration_contractor_idx ON machvon.vendor_bid_declaration (tenant_id, contractor_id, declared_at DESC);
CREATE INDEX vendor_bid_declaration_document_idx ON machvon.vendor_bid_declaration (tenant_id, document_id) WHERE document_id IS NOT NULL;
CREATE INDEX vendor_bid_declaration_declared_by_idx ON machvon.vendor_bid_declaration (tenant_id, declared_by);
CREATE INDEX vendor_bid_declaration_superseded_by_idx ON machvon.vendor_bid_declaration (tenant_id, superseded_by) WHERE superseded_by IS NOT NULL;

CREATE TABLE machvon.vendor_bid_declaration_subcontractor (
  tenant_id uuid NOT NULL,
  declaration_id uuid NOT NULL,
  subcontractor_id uuid NOT NULL,
  PRIMARY KEY (tenant_id, declaration_id, subcontractor_id),
  FOREIGN KEY (tenant_id, declaration_id) REFERENCES machvon.vendor_bid_declaration (tenant_id, id),
  FOREIGN KEY (tenant_id, subcontractor_id) REFERENCES machvon.contractor (tenant_id, id)
);
CREATE INDEX vendor_bid_declaration_sub_idx ON machvon.vendor_bid_declaration_subcontractor (tenant_id, subcontractor_id);

-- What a declaration says never changes; only the mark that a newer one supersedes it is written, once.
CREATE FUNCTION machvon.guard_vendor_bid_declaration() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a declaration of a bid is never deleted' USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME = 'vendor_bid_declaration_subcontractor' THEN
    RAISE EXCEPTION 'the subcontractors of a declaration are not rewritten' USING ERRCODE = '23514';
  END IF;
  IF (NEW.package_id, NEW.contractor_id, NEW.declared_share_pct, NEW.document_id, NEW.declared_by, NEW.declared_at)
     IS DISTINCT FROM (OLD.package_id, OLD.contractor_id, OLD.declared_share_pct, OLD.document_id, OLD.declared_by, OLD.declared_at) THEN
    RAISE EXCEPTION 'a declaration of a bid is not rewritten: a new one supersedes it' USING ERRCODE = '23514';
  END IF;
  IF OLD.superseded_at IS NOT NULL AND (NEW.superseded_at IS DISTINCT FROM OLD.superseded_at OR NEW.superseded_by IS DISTINCT FROM OLD.superseded_by) THEN
    RAISE EXCEPTION 'a superseded declaration stays so' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;
CREATE TRIGGER vendor_bid_declaration_guard BEFORE UPDATE OR DELETE ON machvon.vendor_bid_declaration FOR EACH ROW EXECUTE FUNCTION machvon.guard_vendor_bid_declaration();
CREATE TRIGGER vendor_bid_declaration_sub_guard BEFORE UPDATE OR DELETE ON machvon.vendor_bid_declaration_subcontractor FOR EACH ROW EXECUTE FUNCTION machvon.guard_vendor_bid_declaration();

ALTER TABLE machvon.vendor_bid_declaration ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.vendor_bid_declaration FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.vendor_bid_declaration AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.vendor_bid_declaration AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE machvon.vendor_bid_declaration_subcontractor ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.vendor_bid_declaration_subcontractor FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.vendor_bid_declaration_subcontractor AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.vendor_bid_declaration_subcontractor AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE DELETE, TRUNCATE ON TABLE machvon.vendor_bid_declaration FROM machvon_app;
REVOKE DELETE, TRUNCATE ON TABLE machvon.vendor_bid_declaration_subcontractor FROM machvon_app;

COMMENT ON TABLE machvon.vendor_bid_declaration IS 'VND-2: what a bid declared about subcontracting (the share and the named subcontractors); superseded, never edited.';
COMMENT ON TABLE machvon.vendor_bid_declaration_subcontractor IS 'VND-2: the subcontractors a bid named.';
