-- Authored by hand (not generated): one row for every scan of the red flags (governance deepening, lane GOV-10, roadmap G4-3): when it ran, how many subjects it looked at, how many it flagged, rescored or reopened, and whether
-- it finished. The screen says "evaluated at" from the last finished scan; a scan that did not finish is shown as such, never as "no red flags". A scan of a day and a slot is recorded once.

CREATE TABLE machvon.red_flag_scan (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  scan_key text NOT NULL CHECK (scan_key = btrim(scan_key) AND char_length(scan_key) BETWEEN 1 AND 80),
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  status text NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING', 'FINISHED', 'FAILED')),
  subjects integer NOT NULL DEFAULT 0 CHECK (subjects >= 0),
  flagged integer NOT NULL DEFAULT 0 CHECK (flagged >= 0),
  rescored integer NOT NULL DEFAULT 0 CHECK (rescored >= 0),
  reopened integer NOT NULL DEFAULT 0 CHECK (reopened >= 0),
  not_computable integer NOT NULL DEFAULT 0 CHECK (not_computable >= 0),
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT red_flag_scan_key_uq UNIQUE (tenant_id, scan_key),
  CONSTRAINT red_flag_scan_end_chk CHECK ((status = 'RUNNING') = (finished_at IS NULL))
);

CREATE INDEX red_flag_scan_time_idx ON machvon.red_flag_scan (tenant_id, started_at DESC);

ALTER TABLE machvon.red_flag_scan ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.red_flag_scan FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.red_flag_scan AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.red_flag_scan AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE DELETE, TRUNCATE ON TABLE machvon.red_flag_scan FROM machvon_app;
REVOKE UPDATE ON TABLE machvon.red_flag_scan FROM machvon_app;
GRANT UPDATE (finished_at, status, subjects, flagged, rescored, reopened, not_computable) ON TABLE machvon.red_flag_scan TO machvon_app;

COMMENT ON TABLE machvon.red_flag_scan IS 'One row per scan of the red flags: when it ran, what it looked at and whether it finished.';
