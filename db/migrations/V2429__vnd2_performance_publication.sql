-- Authored by hand (not generated): the publication of the rating of the performance of a contractor on the national system (VND-2, research V4; docs/vendor-controls-risk-performance.md).
-- The rating itself is the proposal of CA-3 (`contract_rating_proposal`); this table is the receipt of its publication, no later than the months of the rule `VENDOR_PERFORMANCE` after the contract ends. It is posted
-- by a person other than the one who adopted the rating (a trigger reads the adoption), with the reference the network gave; an update after the warranty or after a correct answer of the contractor is a new row
-- that supersedes the one before. Rows are appended, never changed or deleted.

CREATE TABLE machvon.vendor_performance_publication (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  rating_proposal_id uuid NOT NULL,
  contractor_id uuid NOT NULL,
  contract_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('INITIAL', 'UPDATE_AFTER_WARRANTY', 'UPDATE_AFTER_RESPONSE')),
  receipt text NOT NULL CHECK (receipt = btrim(receipt) AND char_length(receipt) BETWEEN 3 AND 100),
  posted_by uuid NOT NULL,
  posted_at timestamptz NOT NULL DEFAULT now(),
  posted_on date NOT NULL,
  due_on date NOT NULL,
  clock text NOT NULL CHECK (clock IN ('MET', 'MET_LATE')),
  rule_version text NOT NULL CHECK (char_length(rule_version) BETWEEN 1 AND 100),
  supersedes_id uuid,
  created_by uuid NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, rating_proposal_id) REFERENCES machvon.contract_rating_proposal (tenant_id, id),
  FOREIGN KEY (tenant_id, contractor_id) REFERENCES machvon.contractor (tenant_id, id),
  FOREIGN KEY (tenant_id, contract_id) REFERENCES machvon.contract (tenant_id, id),
  FOREIGN KEY (tenant_id, supersedes_id) REFERENCES machvon.vendor_performance_publication (tenant_id, id),
  CONSTRAINT vendor_perf_pub_supersedes_chk CHECK ((kind = 'INITIAL') = (supersedes_id IS NULL))
);
CREATE UNIQUE INDEX vendor_perf_pub_initial_uq ON machvon.vendor_performance_publication (tenant_id, rating_proposal_id) WHERE kind = 'INITIAL';
CREATE UNIQUE INDEX vendor_perf_pub_successor_uq ON machvon.vendor_performance_publication (tenant_id, supersedes_id) WHERE supersedes_id IS NOT NULL;
CREATE INDEX vendor_perf_pub_proposal_idx ON machvon.vendor_performance_publication (tenant_id, rating_proposal_id, posted_at DESC);
CREATE INDEX vendor_perf_pub_contractor_idx ON machvon.vendor_performance_publication (tenant_id, contractor_id, posted_on DESC);
CREATE INDEX vendor_perf_pub_contract_idx ON machvon.vendor_performance_publication (tenant_id, contract_id);
CREATE INDEX vendor_perf_pub_posted_by_idx ON machvon.vendor_performance_publication (tenant_id, posted_by, posted_at DESC);

CREATE FUNCTION machvon.guard_vendor_performance_publication() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  adopted_state text;
  adopter uuid;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'a publication of a rating is appended, never changed or deleted' USING ERRCODE = '23514';
  END IF;
  SELECT state, adopted_by INTO adopted_state, adopter FROM machvon.contract_rating_proposal WHERE tenant_id = NEW.tenant_id AND id = NEW.rating_proposal_id;
  IF adopted_state IS DISTINCT FROM 'ADOPTED' THEN
    RAISE EXCEPTION 'only an adopted rating is published' USING ERRCODE = '23514';
  END IF;
  IF adopter = NEW.posted_by THEN
    RAISE EXCEPTION 'the person who adopted the rating does not post it' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;
CREATE TRIGGER vendor_performance_publication_guard BEFORE INSERT OR UPDATE OR DELETE ON machvon.vendor_performance_publication FOR EACH ROW EXECUTE FUNCTION machvon.guard_vendor_performance_publication();

ALTER TABLE machvon.vendor_performance_publication ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.vendor_performance_publication FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.vendor_performance_publication AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.vendor_performance_publication AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
REVOKE DELETE, TRUNCATE ON TABLE machvon.vendor_performance_publication FROM machvon_app;

COMMENT ON TABLE machvon.vendor_performance_publication IS 'VND-2: the receipt of the publication of an adopted rating of the performance of a contractor, posted by another person than the adopter, appended only.';
