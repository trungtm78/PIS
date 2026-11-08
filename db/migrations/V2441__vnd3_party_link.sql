-- Authored by hand (not generated): the scans of the related-party graph and the projection of its links (VND-3, research V6; docs/vendor-investigation.md section 2).
-- A scan reads the keys that the register of contractors already holds (tax code head, account, representative, owner, address, telephone, e-mail) and the trace of the submissions, builds the links with the rule
-- VENDOR_LINK_RULE and writes them here with their evidence as short fingerprints (never a key, never a personal value). The links are a projection that a scan recomputes: a link a scan no longer finds becomes STALE,
-- it is not deleted, so that what the auditors saw on a day stays answerable. Auditors only: the portal path is refused every table of this file (V2446).

CREATE TABLE machvon.vendor_link_scan (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  trigger_kind text NOT NULL CHECK (trigger_kind IN ('JOB', 'MANUAL')),
  started_at timestamptz NOT NULL,
  finished_at timestamptz NOT NULL,
  parties integer NOT NULL CHECK (parties >= 0),
  links integer NOT NULL CHECK (links >= 0),
  clusters integer NOT NULL CHECK (clusters >= 0),
  ignored_keys integer NOT NULL CHECK (ignored_keys >= 0),
  packages integer NOT NULL CHECK (packages >= 0),
  leads_new integer NOT NULL CHECK (leads_new >= 0),
  leads_reopened integer NOT NULL CHECK (leads_reopened >= 0),
  leads_updated integer NOT NULL CHECK (leads_updated >= 0),
  policy_versions jsonb NOT NULL,
  note text CHECK (note IS NULL OR (note = btrim(note) AND char_length(note) BETWEEN 1 AND 500)),
  requested_by uuid,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, requested_by) REFERENCES machvon.membership (tenant_id, id),
  CONSTRAINT link_scan_period_chk CHECK (finished_at >= started_at)
);
CREATE INDEX link_scan_requester_idx ON machvon.vendor_link_scan (tenant_id, requested_by) WHERE requested_by IS NOT NULL;
CREATE INDEX link_scan_time_idx ON machvon.vendor_link_scan (tenant_id, finished_at DESC);

ALTER TABLE machvon.vendor_link_scan ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.vendor_link_scan FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.vendor_link_scan AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.vendor_link_scan AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.vendor_link_scan FROM machvon_app;
CREATE TRIGGER vendor_link_scan_append_only BEFORE UPDATE OR DELETE ON machvon.vendor_link_scan FOR EACH ROW EXECUTE FUNCTION machvon.vnd3_append_only();

COMMENT ON TABLE machvon.vendor_link_scan IS 'VND-3: one scan of the related-party graph: what it read, what it found, the versions of the rules it used.';

CREATE TABLE machvon.contractor_party_link (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  contractor_a_id uuid NOT NULL,
  contractor_b_id uuid NOT NULL,
  strength smallint NOT NULL CHECK (strength BETWEEN 0 AND 100),
  evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'array'),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'STALE')),
  scan_id uuid NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, contractor_a_id) REFERENCES machvon.contractor (tenant_id, id),
  FOREIGN KEY (tenant_id, contractor_b_id) REFERENCES machvon.contractor (tenant_id, id),
  FOREIGN KEY (tenant_id, scan_id) REFERENCES machvon.vendor_link_scan (tenant_id, id),
  CONSTRAINT party_link_order_chk CHECK (contractor_a_id < contractor_b_id),
  CONSTRAINT party_link_pair_uq UNIQUE (tenant_id, contractor_a_id, contractor_b_id)
);
CREATE INDEX party_link_b_idx ON machvon.contractor_party_link (tenant_id, contractor_b_id);
CREATE INDEX party_link_scan_idx ON machvon.contractor_party_link (tenant_id, scan_id);
CREATE INDEX party_link_status_idx ON machvon.contractor_party_link (tenant_id, status, strength DESC);

ALTER TABLE machvon.contractor_party_link ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.contractor_party_link FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.contractor_party_link AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.contractor_party_link AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
REVOKE DELETE, TRUNCATE ON TABLE machvon.contractor_party_link FROM machvon_app;

COMMENT ON TABLE machvon.contractor_party_link IS 'VND-3: a link between two contractors (smaller id first) with its strength and the short fingerprints of its evidence; recomputed by each scan, never deleted.';
