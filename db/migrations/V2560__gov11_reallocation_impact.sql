-- Authored by hand (not generated): the impact of a reallocation proposal on the disbursement rates, frozen when the proposal is handed in (GOV-11a, G1-12, CAP 3.1 F5).
-- A proposal moves capital between projects. Before someone decides, the system computes what the move does to the rates of the basis snapshot (province, unit, project) and to the projected year end,
-- with the policy rule version and the assumptions that were used. That computation is evidence: it is written once per proposal version and never changed, so the approver and the auditor read the same
-- numbers that the decision was made on, and a later change of the policy or of the figures cannot rewrite them.
--   * `reallocation_impact`: one row per (proposal, proposal version); `before_json` / `after_json` / `warnings_json` hold the simulation; `payload_sha256` is the digest of what was written.

CREATE TABLE machvon.reallocation_impact (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  proposal_id uuid NOT NULL,
  proposal_version bigint NOT NULL,
  basis_snapshot_id uuid NOT NULL,
  plan_year integer NOT NULL,
  policy_rule_version integer NOT NULL,
  policy_source text NOT NULL,
  assumptions_json jsonb NOT NULL,
  before_json jsonb NOT NULL,
  after_json jsonb NOT NULL,
  warnings_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  payload_sha256 text NOT NULL,
  recorded_by uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, proposal_id) REFERENCES machvon.reallocation_proposal (tenant_id, id),
  CONSTRAINT reallocation_impact_version_chk CHECK (proposal_version >= 1 AND policy_rule_version >= 0),
  CONSTRAINT reallocation_impact_year_chk CHECK (plan_year BETWEEN 1990 AND 2100),
  CONSTRAINT reallocation_impact_source_chk CHECK (policy_source IN ('RULE', 'DEFAULT')),
  CONSTRAINT reallocation_impact_hash_chk CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT reallocation_impact_shape_chk CHECK (jsonb_typeof(assumptions_json) = 'object' AND jsonb_typeof(before_json) = 'object' AND jsonb_typeof(after_json) = 'object' AND jsonb_typeof(warnings_json) = 'array')
);
CREATE UNIQUE INDEX reallocation_impact_version_uq ON machvon.reallocation_impact (tenant_id, proposal_id, proposal_version);
CREATE INDEX reallocation_impact_snapshot_idx ON machvon.reallocation_impact (tenant_id, basis_snapshot_id, recorded_at DESC);
CREATE INDEX reallocation_impact_recorder_idx ON machvon.reallocation_impact (tenant_id, recorded_by, recorded_at DESC);

CREATE FUNCTION machvon.reallocation_impact_append_only() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  RAISE EXCEPTION 'the impact of a reallocation proposal is evidence: it is written once and never changed' USING ERRCODE = '23514';
END;
$fn$;

CREATE TRIGGER reallocation_impact_append_only BEFORE UPDATE OR DELETE ON machvon.reallocation_impact FOR EACH ROW EXECUTE FUNCTION machvon.reallocation_impact_append_only();

ALTER TABLE machvon.reallocation_impact ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.reallocation_impact FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.reallocation_impact AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.reallocation_impact AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.reallocation_impact FROM machvon_app;

COMMENT ON TABLE machvon.reallocation_impact IS 'GOV-11a G1-12: the simulated impact of a reallocation proposal on the disbursement rates, frozen with its policy version when the proposal is submitted; append-only.';
