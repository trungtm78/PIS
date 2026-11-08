-- Authored by hand (not generated): the early-warning register of a contract (GOV-8, roadmap G1-15, docs/ctr-early-warning.md).
-- A warning is something that may delay the work, raise its price or lower its quality, raised by any party of the contract (owner, contractor, supervisor, designer). It is not the disbursement warning of DIS
-- (`early_warning`, HOME-06); the parties of one contract keep this register together:
--   * `contract_early_warning`: one row per warning, numbered per contract (`EW-001`): who raised it (the party and the member who entered it), the expected impact on time and cost (a number, or an explicit "no
--     impact expected": a warning is never assessed with the impact left blank), the likelihood, the person who answers for it, its state and how it ended;
--   * a warning closed as RESOLVED is not closed by the person who answers for it (a CHECK: the owner of the mitigation cannot also certify that the risk is gone); one that came true (MATERIALISED) names the
--     change order or the claim of the same contract it became, and exactly one of them (a CHECK);
--   * `contract_early_warning_action`: the mitigation actions, each with a person and a due day;
--   * no row of these tables is deleted by the application role.

CREATE TABLE machvon.contract_early_warning (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  contract_id uuid NOT NULL,
  code text NOT NULL,
  title text NOT NULL,
  description text NOT NULL,
  category text NOT NULL,
  raised_by_party text NOT NULL,
  raised_by uuid NOT NULL,
  raised_on date NOT NULL,
  status text NOT NULL DEFAULT 'RAISED',
  likelihood text,
  owner_membership_id uuid,
  expected_time_days integer,
  expected_cost_vnd numeric(24,0),
  no_impact_expected boolean NOT NULL DEFAULT false,
  assessed_by uuid,
  assessed_at timestamptz,
  closed_by uuid,
  closed_at timestamptz,
  closed_reason text,
  change_request_id uuid,
  claim_id uuid,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, contract_id) REFERENCES machvon.contract (tenant_id, id),
  FOREIGN KEY (tenant_id, owner_membership_id) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, change_request_id) REFERENCES machvon.change_request (tenant_id, id),
  FOREIGN KEY (tenant_id, claim_id) REFERENCES machvon.contract_claim (tenant_id, id),
  CONSTRAINT contract_early_warning_code_chk CHECK (code ~ '^EW-[0-9]{3,6}$'),
  CONSTRAINT contract_early_warning_text_chk CHECK (title = btrim(title) AND char_length(title) BETWEEN 5 AND 200 AND description = btrim(description) AND char_length(description) BETWEEN 5 AND 2000),
  CONSTRAINT contract_early_warning_category_chk CHECK (category IN ('TIME', 'COST', 'QUALITY', 'SAFETY', 'SCOPE', 'LEGAL', 'ENVIRONMENT', 'OTHER')),
  CONSTRAINT contract_early_warning_party_chk CHECK (raised_by_party IN ('OWNER', 'CONTRACTOR', 'SUPERVISOR', 'DESIGNER', 'OTHER')),
  CONSTRAINT contract_early_warning_status_chk CHECK (status IN ('RAISED', 'ASSESSED', 'MITIGATING', 'CLOSED_RESOLVED', 'CLOSED_MATERIALISED', 'CLOSED_WITHDRAWN')),
  CONSTRAINT contract_early_warning_likelihood_chk CHECK (likelihood IS NULL OR likelihood IN ('LOW', 'MEDIUM', 'HIGH')),
  CONSTRAINT contract_early_warning_impact_chk CHECK ((expected_time_days IS NULL OR expected_time_days >= 0) AND (expected_cost_vnd IS NULL OR expected_cost_vnd >= 0) AND (NOT no_impact_expected OR (expected_time_days IS NULL AND expected_cost_vnd IS NULL))),
  CONSTRAINT contract_early_warning_assessed_chk CHECK (
    (status = 'RAISED' OR status = 'CLOSED_WITHDRAWN' OR (assessed_by IS NOT NULL AND assessed_at IS NOT NULL AND likelihood IS NOT NULL AND owner_membership_id IS NOT NULL AND (no_impact_expected OR expected_time_days IS NOT NULL OR expected_cost_vnd IS NOT NULL)))
  ),
  CONSTRAINT contract_early_warning_closed_chk CHECK ((status LIKE 'CLOSED\_%') = (closed_by IS NOT NULL AND closed_at IS NOT NULL AND closed_reason IS NOT NULL)),
  CONSTRAINT contract_early_warning_reason_chk CHECK (closed_reason IS NULL OR (closed_reason = btrim(closed_reason) AND char_length(closed_reason) BETWEEN 10 AND 2000)),
  CONSTRAINT contract_early_warning_materialised_chk CHECK ((status = 'CLOSED_MATERIALISED') = ((change_request_id IS NOT NULL) <> (claim_id IS NOT NULL))),
  CONSTRAINT contract_early_warning_resolved_checker_chk CHECK (status <> 'CLOSED_RESOLVED' OR owner_membership_id IS NULL OR closed_by <> owner_membership_id),
  CONSTRAINT contract_early_warning_version_chk CHECK (version >= 1),
  CONSTRAINT contract_early_warning_code_uq UNIQUE (tenant_id, contract_id, code)
);

CREATE INDEX contract_early_warning_contract_id_idx ON machvon.contract_early_warning (tenant_id, contract_id, created_at DESC, id DESC);
CREATE INDEX contract_early_warning_owner_membership_id_idx ON machvon.contract_early_warning (tenant_id, owner_membership_id) WHERE owner_membership_id IS NOT NULL;
CREATE INDEX contract_early_warning_change_request_id_idx ON machvon.contract_early_warning (tenant_id, change_request_id) WHERE change_request_id IS NOT NULL;
CREATE INDEX contract_early_warning_claim_id_idx ON machvon.contract_early_warning (tenant_id, claim_id) WHERE claim_id IS NOT NULL;
CREATE INDEX contract_early_warning_open_idx ON machvon.contract_early_warning (tenant_id, contract_id, status) WHERE status IN ('RAISED', 'ASSESSED', 'MITIGATING');

CREATE FUNCTION machvon.guard_contract_early_warning() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.contract_id IS DISTINCT FROM OLD.contract_id OR NEW.code IS DISTINCT FROM OLD.code OR NEW.raised_by_party IS DISTINCT FROM OLD.raised_by_party
     OR NEW.raised_by IS DISTINCT FROM OLD.raised_by OR NEW.raised_on IS DISTINCT FROM OLD.raised_on THEN
    RAISE EXCEPTION 'a warning keeps its contract, its code and who raised it, and when' USING ERRCODE = '23514';
  END IF;
  IF OLD.status LIKE 'CLOSED\_%' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'a closed warning is not reopened: raise a new one' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER contract_early_warning_guard BEFORE UPDATE ON machvon.contract_early_warning FOR EACH ROW EXECUTE FUNCTION machvon.guard_contract_early_warning();

CREATE TABLE machvon.contract_early_warning_action (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  warning_id uuid NOT NULL,
  description text NOT NULL,
  owner_membership_id uuid NOT NULL,
  due_on date NOT NULL,
  status text NOT NULL DEFAULT 'OPEN',
  done_on date,
  done_by uuid,
  done_note text,
  created_by uuid NOT NULL,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, warning_id) REFERENCES machvon.contract_early_warning (tenant_id, id),
  FOREIGN KEY (tenant_id, owner_membership_id) REFERENCES machvon.membership (tenant_id, id),
  CONSTRAINT contract_early_warning_action_status_chk CHECK (status IN ('OPEN', 'DONE', 'CANCELLED')),
  CONSTRAINT contract_early_warning_action_text_chk CHECK (description = btrim(description) AND char_length(description) BETWEEN 5 AND 2000 AND (done_note IS NULL OR (done_note = btrim(done_note) AND char_length(done_note) BETWEEN 5 AND 2000))),
  CONSTRAINT contract_early_warning_action_done_chk CHECK ((status = 'OPEN') = (done_on IS NULL AND done_by IS NULL) AND (status <> 'DONE' OR done_note IS NOT NULL)),
  CONSTRAINT contract_early_warning_action_version_chk CHECK (version >= 1)
);

CREATE INDEX contract_early_warning_action_warning_id_idx ON machvon.contract_early_warning_action (tenant_id, warning_id, due_on, id);
CREATE INDEX contract_early_warning_action_owner_membership_id_idx ON machvon.contract_early_warning_action (tenant_id, owner_membership_id, due_on) WHERE status = 'OPEN';

CREATE FUNCTION machvon.guard_contract_early_warning_action() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.warning_id IS DISTINCT FROM OLD.warning_id OR NEW.description IS DISTINCT FROM OLD.description OR NEW.owner_membership_id IS DISTINCT FROM OLD.owner_membership_id
     OR NEW.due_on IS DISTINCT FROM OLD.due_on OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'an action keeps its words, its owner and its due day: agree a new one' USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'OPEN' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'an action that ended is not reopened' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER contract_early_warning_action_guard BEFORE UPDATE ON machvon.contract_early_warning_action FOR EACH ROW EXECUTE FUNCTION machvon.guard_contract_early_warning_action();

ALTER TABLE machvon.contract_early_warning ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.contract_early_warning FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.contract_early_warning AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.contract_early_warning AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE machvon.contract_early_warning_action ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.contract_early_warning_action FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.contract_early_warning_action AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.contract_early_warning_action AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE DELETE, TRUNCATE ON TABLE machvon.contract_early_warning FROM machvon_app;
REVOKE DELETE, TRUNCATE ON TABLE machvon.contract_early_warning_action FROM machvon_app;

COMMENT ON TABLE machvon.contract_early_warning IS 'GOV-8: the early-warning register of a contract: a warning raised by any party, its expected impact on time and cost, its owner and how it ended; not the disbursement warning of DIS.';
COMMENT ON TABLE machvon.contract_early_warning_action IS 'GOV-8: a mitigation action of a warning, with a person and a due day.';
