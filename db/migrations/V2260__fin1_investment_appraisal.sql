-- Authored by hand (not generated): the appraisal of the economic and financial effectiveness of an investment (lane FIN-1, customer requirement AI.06, PRJ F09, screens PRJ-23 and PRJ-24).
-- An appraisal is a record with inputs that people answer for (a cash flow per period, the discount rate, the convention, scenarios, and for each input its source and its owner), and results that nobody types
-- in: the server computes them with the formula module of the kernel (packages/kernel/src/fin-analysis.ts) and keeps them with the hash of the inputs they came from and the version of the formula. It moves
-- DRAFT -> SUBMITTED -> APPROVED, or from SUBMITTED back to DRAFT with a reason. The maker is not the checker: whoever made, edited or submitted it cannot approve it. At approval the results are computed once more
-- from the stored inputs and frozen with their hash and the formula version; an approved appraisal never changes again (a new version is a new row that points to the one it replaces). The weights of the
-- non-financial criteria are not here: they are rules of the governance platform (rule type FIN_CRITERIA), and the appraisal keeps the set and the rule version it was scored with.

CREATE TABLE machvon.investment_appraisal (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  -- One code for all the versions of an appraisal: FIN-<year>-<number>; a new version has the same code and the next revision.
  code text NOT NULL CHECK (code ~ '^FIN-[0-9]{4}-[0-9]{4,}$'),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  supersedes_id uuid,
  title text NOT NULL CHECK (title = btrim(title) AND char_length(title) BETWEEN 1 AND 300),
  kind text NOT NULL CHECK (kind IN ('FINANCIAL', 'NON_FINANCIAL')),
  -- The unit that answers for the appraisal and whose scope sees it; for an appraisal tied to a project it is the owner unit of the project.
  owner_unit_id uuid NOT NULL,
  project_id uuid,
  package_id uuid,
  contract_id uuid,
  period_unit text NOT NULL DEFAULT 'YEAR' CHECK (period_unit IN ('YEAR', 'QUARTER', 'MONTH')),
  -- Percent per period, up to four decimals (the formula module refuses more); a rate of -100% or below is accepted as an input and makes the discounted measures not applicable.
  discount_rate_pct numeric(9,4) NOT NULL DEFAULT 0 CHECK (discount_rate_pct BETWEEN -1000 AND 1000),
  convention text NOT NULL DEFAULT 'END' CHECK (convention IN ('END', 'MID')),
  -- How the sensitivity tables are cut (points of each parameter, swing of the tornado); empty means the defaults of the formula module.
  sensitivity jsonb CHECK (sensitivity IS NULL OR jsonb_typeof(sensitivity) = 'object'),
  criteria_category text CHECK (criteria_category IS NULL OR criteria_category IN ('SAFETY', 'COMPLIANCE', 'MAINTENANCE')),
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'SUBMITTED', 'APPROVED')),
  -- The number the commands send back in If-Match.
  version bigint NOT NULL DEFAULT 1,
  -- The latest computation (a draft may be edited after it, and then it no longer belongs to the inputs: `results_inputs_hash` tells).
  results jsonb CHECK (results IS NULL OR jsonb_typeof(results) = 'object'),
  results_inputs_hash text CHECK (results_inputs_hash IS NULL OR results_inputs_hash ~ '^[0-9a-f]{64}$'),
  result_hash text CHECK (result_hash IS NULL OR result_hash ~ '^[0-9a-f]{64}$'),
  formula_version text,
  computed_at timestamptz,
  computed_by uuid,
  -- The scored non-financial criteria: the set and the rule version they were scored with (frozen with the result), and what they came to.
  criteria_rule_version integer,
  criteria_rule_source text CHECK (criteria_rule_source IS NULL OR criteria_rule_source IN ('RULE', 'DEFAULT')),
  criteria_snapshot jsonb,
  criteria_result jsonb,
  -- What approval froze: the results computed again from the stored inputs, their hash and the formula version.
  frozen_results jsonb,
  frozen_result_hash text CHECK (frozen_result_hash IS NULL OR frozen_result_hash ~ '^[0-9a-f]{64}$'),
  frozen_formula_version text,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  submitted_by uuid,
  submitted_at timestamptz,
  approved_by uuid,
  approved_at timestamptz,
  decision_reason text CHECK (decision_reason IS NULL OR (decision_reason = btrim(decision_reason) AND char_length(decision_reason) BETWEEN 1 AND 2000)),
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT investment_appraisal_revision_uq UNIQUE (tenant_id, code, revision),
  FOREIGN KEY (tenant_id, supersedes_id) REFERENCES machvon.investment_appraisal (tenant_id, id),
  FOREIGN KEY (tenant_id, owner_unit_id) REFERENCES machvon.organization_unit (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES machvon.project (tenant_id, id),
  FOREIGN KEY (tenant_id, package_id) REFERENCES machvon.procurement_package (tenant_id, id),
  FOREIGN KEY (tenant_id, contract_id) REFERENCES machvon.contract (tenant_id, id),
  FOREIGN KEY (tenant_id, computed_by) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, updated_by) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, submitted_by) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, approved_by) REFERENCES machvon.membership (tenant_id, id),
  -- A result carries its hash and its formula version, or it is not there.
  CONSTRAINT investment_appraisal_result_chk CHECK (
    (results IS NULL AND results_inputs_hash IS NULL AND result_hash IS NULL AND formula_version IS NULL AND computed_at IS NULL AND computed_by IS NULL)
    OR (results IS NOT NULL AND results_inputs_hash IS NOT NULL AND result_hash IS NOT NULL AND formula_version IS NOT NULL AND computed_at IS NOT NULL AND computed_by IS NOT NULL)
  ),
  CONSTRAINT investment_appraisal_submitted_chk CHECK (status <> 'SUBMITTED' OR (submitted_by IS NOT NULL AND submitted_at IS NOT NULL AND result_hash IS NOT NULL)),
  -- An approved appraisal names its approver, who is not the maker, the last editor or the submitter, and carries the frozen result with its hash and formula version.
  CONSTRAINT investment_appraisal_approved_chk CHECK (
    status <> 'APPROVED'
    OR (approved_by IS NOT NULL AND approved_at IS NOT NULL AND submitted_by IS NOT NULL AND frozen_results IS NOT NULL AND frozen_result_hash IS NOT NULL AND frozen_formula_version IS NOT NULL
        AND approved_by <> created_by AND approved_by <> updated_by AND approved_by <> submitted_by)
  ),
  CONSTRAINT investment_appraisal_scores_chk CHECK ((criteria_result IS NULL) = (criteria_snapshot IS NULL))
);

CREATE INDEX investment_appraisal_unit_idx ON machvon.investment_appraisal (tenant_id, owner_unit_id, status, updated_at DESC);
CREATE INDEX investment_appraisal_project_idx ON machvon.investment_appraisal (tenant_id, project_id) WHERE project_id IS NOT NULL;
CREATE INDEX investment_appraisal_contract_idx ON machvon.investment_appraisal (tenant_id, contract_id) WHERE contract_id IS NOT NULL;
CREATE INDEX investment_appraisal_package_idx ON machvon.investment_appraisal (tenant_id, package_id) WHERE package_id IS NOT NULL;

-- The cash flow: one row per period, the five kinds of line, exact to two decimals (the unit is the one of the currency of the tenant, whole dong or more).
CREATE TABLE machvon.appraisal_cash_line (
  tenant_id uuid NOT NULL,
  appraisal_id uuid NOT NULL,
  period integer NOT NULL CHECK (period BETWEEN 0 AND 100),
  benefit_vnd numeric(24,2) NOT NULL DEFAULT 0 CHECK (benefit_vnd >= 0),
  capex_vnd numeric(24,2) NOT NULL DEFAULT 0 CHECK (capex_vnd >= 0),
  opex_vnd numeric(24,2) NOT NULL DEFAULT 0 CHECK (opex_vnd >= 0),
  maintenance_vnd numeric(24,2) NOT NULL DEFAULT 0 CHECK (maintenance_vnd >= 0),
  residual_vnd numeric(24,2) NOT NULL DEFAULT 0 CHECK (residual_vnd >= 0),
  PRIMARY KEY (tenant_id, appraisal_id, period),
  FOREIGN KEY (tenant_id, appraisal_id) REFERENCES machvon.investment_appraisal (tenant_id, id)
);

-- Who answers for each input and where the figure comes from: the horizon, the rate, each kind of line, each scenario. A legal number (source kind LAW) is configuration to be confirmed, never a rule.
CREATE TABLE machvon.appraisal_assumption (
  tenant_id uuid NOT NULL,
  appraisal_id uuid NOT NULL,
  input_key text NOT NULL CHECK (input_key ~ '^(HORIZON|DISCOUNT_RATE|BENEFIT|CAPEX|OPEX|MAINTENANCE|RESIDUAL|SCENARIO:[A-Z][A-Z0-9_]{1,31})$'),
  value_text text NOT NULL CHECK (value_text = btrim(value_text) AND char_length(value_text) BETWEEN 1 AND 500),
  unit text NOT NULL CHECK (unit = btrim(unit) AND char_length(unit) BETWEEN 1 AND 500),
  source_kind text NOT NULL CHECK (source_kind IN ('DOCUMENT', 'ESTIMATE', 'MARKET', 'STANDARD', 'LAW', 'OTHER')),
  source_text text NOT NULL CHECK (source_text = btrim(source_text) AND char_length(source_text) BETWEEN 1 AND 500),
  owner_id uuid NOT NULL,
  PRIMARY KEY (tenant_id, appraisal_id, input_key),
  FOREIGN KEY (tenant_id, appraisal_id) REFERENCES machvon.investment_appraisal (tenant_id, id),
  FOREIGN KEY (tenant_id, owner_id) REFERENCES machvon.membership (tenant_id, id)
);

-- The scenarios as parameter deltas to the inputs (never as numbers for the results); the base case is not a row, it is the inputs.
CREATE TABLE machvon.appraisal_scenario (
  tenant_id uuid NOT NULL,
  appraisal_id uuid NOT NULL,
  code text NOT NULL CHECK (code ~ '^[A-Z][A-Z0-9_]{1,31}$' AND code <> 'BASE'),
  position integer NOT NULL CHECK (position >= 0),
  label text NOT NULL CHECK (label = btrim(label) AND char_length(label) BETWEEN 1 AND 120),
  deltas jsonb NOT NULL CHECK (jsonb_typeof(deltas) = 'object'),
  PRIMARY KEY (tenant_id, appraisal_id, code),
  FOREIGN KEY (tenant_id, appraisal_id) REFERENCES machvon.investment_appraisal (tenant_id, id)
);

-- The scores of the non-financial criteria: a whole number from 1 to 5 and the evidence it rests on.
CREATE TABLE machvon.appraisal_criteria_score (
  tenant_id uuid NOT NULL,
  appraisal_id uuid NOT NULL,
  criterion_key text NOT NULL CHECK (criterion_key ~ '^[a-z][a-z0-9_]{1,39}$'),
  score smallint NOT NULL CHECK (score BETWEEN 1 AND 5),
  evidence text NOT NULL CHECK (evidence = btrim(evidence) AND char_length(evidence) BETWEEN 1 AND 1000),
  PRIMARY KEY (tenant_id, appraisal_id, criterion_key),
  FOREIGN KEY (tenant_id, appraisal_id) REFERENCES machvon.investment_appraisal (tenant_id, id)
);

-- The next number of the code of an appraisal in a year, taken under the lock of the row.
CREATE TABLE machvon.appraisal_code_counter (
  tenant_id uuid NOT NULL,
  year integer NOT NULL CHECK (year BETWEEN 2000 AND 9999),
  last_number integer NOT NULL DEFAULT 0 CHECK (last_number >= 0),
  PRIMARY KEY (tenant_id, year)
);

-- The record moves only along DRAFT -> SUBMITTED -> APPROVED (or back to DRAFT), what it is about never changes, and an approved record never changes at all, from the application or from anyone else.
CREATE FUNCTION machvon.guard_investment_appraisal() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'an appraisal is never removed' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'an appraisal starts as a draft' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'APPROVED' THEN
    RAISE EXCEPTION 'an approved appraisal never changes: a change is a new version' USING ERRCODE = '23514';
  END IF;
  IF (NEW.tenant_id, NEW.id, NEW.code, NEW.revision, NEW.supersedes_id, NEW.created_at, NEW.created_by) IS DISTINCT FROM (OLD.tenant_id, OLD.id, OLD.code, OLD.revision, OLD.supersedes_id, OLD.created_at, OLD.created_by) THEN
    RAISE EXCEPTION 'what an appraisal is about never changes' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'SUBMITTED' AND NEW.status NOT IN ('APPROVED', 'DRAFT') THEN
    RAISE EXCEPTION 'a submitted appraisal is decided, not edited' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'DRAFT' AND NEW.status = 'APPROVED' THEN
    RAISE EXCEPTION 'an appraisal is approved only after it was submitted' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER investment_appraisal_guard BEFORE INSERT OR UPDATE OR DELETE ON machvon.investment_appraisal
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_investment_appraisal();

REVOKE DELETE, TRUNCATE ON TABLE machvon.investment_appraisal FROM machvon_app;

-- The inputs of an appraisal change only while it is a draft.
CREATE FUNCTION machvon.guard_appraisal_input() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  held text;
  held_tenant uuid;
  held_parent uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    held_tenant := OLD.tenant_id;
    held_parent := OLD.appraisal_id;
  ELSE
    held_tenant := NEW.tenant_id;
    held_parent := NEW.appraisal_id;
  END IF;
  SELECT a.status INTO held FROM machvon.investment_appraisal a WHERE a.tenant_id = held_tenant AND a.id = held_parent;
  IF held IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'the inputs of an appraisal change only while it is a draft' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER appraisal_cash_line_guard BEFORE INSERT OR UPDATE OR DELETE ON machvon.appraisal_cash_line FOR EACH ROW EXECUTE FUNCTION machvon.guard_appraisal_input();
CREATE TRIGGER appraisal_assumption_guard BEFORE INSERT OR UPDATE OR DELETE ON machvon.appraisal_assumption FOR EACH ROW EXECUTE FUNCTION machvon.guard_appraisal_input();
CREATE TRIGGER appraisal_scenario_guard BEFORE INSERT OR UPDATE OR DELETE ON machvon.appraisal_scenario FOR EACH ROW EXECUTE FUNCTION machvon.guard_appraisal_input();
CREATE TRIGGER appraisal_criteria_score_guard BEFORE INSERT OR UPDATE OR DELETE ON machvon.appraisal_criteria_score FOR EACH ROW EXECUTE FUNCTION machvon.guard_appraisal_input();

DO $rls$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['investment_appraisal', 'appraisal_cash_line', 'appraisal_assumption', 'appraisal_scenario', 'appraisal_criteria_score', 'appraisal_code_counter'] LOOP
    EXECUTE format('ALTER TABLE machvon.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE machvon.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_boundary ON machvon.%I AS RESTRICTIVE FOR ALL USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
    EXECUTE format($p$CREATE POLICY tenant_access ON machvon.%I AS PERMISSIVE FOR ALL USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END
$rls$;

COMMENT ON TABLE machvon.investment_appraisal IS 'An appraisal of the economic and financial effectiveness of an investment: inputs that people answer for, results that only the server computes, frozen with their hash and formula version at approval by someone other than the maker.';
COMMENT ON TABLE machvon.appraisal_cash_line IS 'The cash flow of an appraisal: one row per period with benefit, capex, opex, maintenance and residual, exact to two decimals.';
COMMENT ON TABLE machvon.appraisal_assumption IS 'Who answers for each input of an appraisal and the source of its figure.';
COMMENT ON TABLE machvon.appraisal_scenario IS 'The scenarios of an appraisal as parameter deltas to its inputs.';
COMMENT ON TABLE machvon.appraisal_criteria_score IS 'The scores (1 to 5, with evidence) of the non-financial criteria of an appraisal.';
COMMENT ON TABLE machvon.appraisal_code_counter IS 'The last number of the code FIN-year-number of an appraisal in a year.';

-- Indexes that lead with the tenant under every foreign key and reference column, so the reads by that column and the checks of the foreign keys do not scan (rule ST-CTR-013, rls-catalog).
CREATE INDEX appraisal_assumption_owner_idx ON machvon.appraisal_assumption (tenant_id, owner_id);
CREATE INDEX investment_appraisal_supersedes_idx ON machvon.investment_appraisal (tenant_id, supersedes_id) WHERE supersedes_id IS NOT NULL;
