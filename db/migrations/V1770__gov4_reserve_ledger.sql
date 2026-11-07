-- Authored by hand (not generated): the contingency and the management reserve of a project as two separate funds with an immutable ledger (governance deepening, lane B2, G1-7).
-- A fund holds a balance for one project and one kind (CONTINGENCY, owned by the project board for the risks that were identified; MGMT_RESERVE, owned by the level above for the risks that are not
-- known). The balance is never written by the application: every movement is an entry of the ledger and the database moves the balance with it, under the lock of the fund, so the balance is always
-- what the entries add up to and never negative. A drawdown is for exactly one risk or one change order, is asked for by one person and decided by another (maker is not checker), and the entry that
-- it posts is never changed or removed. The expected value of the open risks (probability times cost) is kept apart from the risk register, in `risk_exposure`, so the register keeps its own shape.

CREATE TABLE machvon.reserve_fund (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('CONTINGENCY', 'MGMT_RESERVE')),
  balance_vnd numeric(24,0) NOT NULL DEFAULT 0 CHECK (balance_vnd >= 0),
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT reserve_fund_project_kind_uq UNIQUE (tenant_id, project_id, kind),
  FOREIGN KEY (tenant_id, project_id) REFERENCES machvon.project (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES machvon.membership (tenant_id, id)
);

CREATE TABLE machvon.reserve_drawdown (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  fund_id uuid NOT NULL,
  project_id uuid NOT NULL,
  amount_vnd numeric(24,0) NOT NULL CHECK (amount_vnd > 0),
  risk_id uuid,
  change_request_id uuid,
  status text NOT NULL DEFAULT 'REQUESTED' CHECK (status IN ('REQUESTED', 'APPROVED', 'REJECTED', 'WITHDRAWN')),
  reason text NOT NULL CHECK (reason = btrim(reason) AND char_length(reason) BETWEEN 1 AND 2000),
  requested_by uuid NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid,
  decided_at timestamptz,
  decision_reason text CHECK (decision_reason IS NULL OR (decision_reason = btrim(decision_reason) AND char_length(decision_reason) BETWEEN 1 AND 2000)),
  ledger_entry_id uuid,
  version bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, fund_id) REFERENCES machvon.reserve_fund (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES machvon.project (tenant_id, id),
  FOREIGN KEY (tenant_id, risk_id) REFERENCES machvon.project_risk (tenant_id, id),
  FOREIGN KEY (tenant_id, change_request_id) REFERENCES machvon.change_request (tenant_id, id),
  FOREIGN KEY (tenant_id, requested_by) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, decided_by) REFERENCES machvon.membership (tenant_id, id),
  -- Tied to a risk or to a change order, and to exactly one of them.
  CONSTRAINT reserve_drawdown_link_chk CHECK ((risk_id IS NULL) <> (change_request_id IS NULL)),
  -- A decision names who made it and why, and is not made by whoever asked.
  CONSTRAINT reserve_drawdown_decision_chk CHECK (
    (status IN ('REQUESTED', 'WITHDRAWN') AND ledger_entry_id IS NULL)
    OR (status = 'APPROVED' AND decided_by IS NOT NULL AND decided_at IS NOT NULL AND ledger_entry_id IS NOT NULL)
    OR (status = 'REJECTED' AND decided_by IS NOT NULL AND decided_at IS NOT NULL AND decision_reason IS NOT NULL AND ledger_entry_id IS NULL)
  ),
  CONSTRAINT reserve_drawdown_maker_checker_chk CHECK (decided_by IS NULL OR status = 'WITHDRAWN' OR decided_by <> requested_by)
);

CREATE INDEX reserve_drawdown_fund_idx ON machvon.reserve_drawdown (tenant_id, fund_id, status);
CREATE INDEX reserve_drawdown_change_idx ON machvon.reserve_drawdown (tenant_id, change_request_id) WHERE change_request_id IS NOT NULL;
CREATE INDEX reserve_drawdown_risk_idx ON machvon.reserve_drawdown (tenant_id, risk_id) WHERE risk_id IS NOT NULL;

CREATE TABLE machvon.reserve_ledger_entry (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  fund_id uuid NOT NULL,
  project_id uuid NOT NULL,
  entry_kind text NOT NULL CHECK (entry_kind IN ('FUND', 'DRAWDOWN')),
  amount_vnd numeric(24,0) NOT NULL CHECK (amount_vnd > 0),
  -- Set by the database from the balance of the fund and the entry: never taken from the application.
  balance_after_vnd numeric(24,0),
  risk_id uuid,
  change_request_id uuid,
  drawdown_id uuid,
  authority_document_version_id uuid,
  reason text NOT NULL CHECK (reason = btrim(reason) AND char_length(reason) BETWEEN 1 AND 2000),
  requested_by uuid NOT NULL,
  approved_by uuid,
  posted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, fund_id) REFERENCES machvon.reserve_fund (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES machvon.project (tenant_id, id),
  FOREIGN KEY (tenant_id, risk_id) REFERENCES machvon.project_risk (tenant_id, id),
  FOREIGN KEY (tenant_id, change_request_id) REFERENCES machvon.change_request (tenant_id, id),
  FOREIGN KEY (tenant_id, drawdown_id) REFERENCES machvon.reserve_drawdown (tenant_id, id),
  FOREIGN KEY (tenant_id, requested_by) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, approved_by) REFERENCES machvon.membership (tenant_id, id),
  -- A drawdown is tied to one risk or one change order, and has an approver who is not whoever asked; funding rests on the document that allots the reserve (a return of unused money is a later story).
  CONSTRAINT reserve_ledger_entry_shape_chk CHECK (
    (entry_kind = 'DRAWDOWN' AND ((risk_id IS NULL) <> (change_request_id IS NULL)) AND approved_by IS NOT NULL AND approved_by <> requested_by AND drawdown_id IS NOT NULL)
    OR (entry_kind = 'FUND' AND risk_id IS NULL AND change_request_id IS NULL AND drawdown_id IS NULL AND authority_document_version_id IS NOT NULL)
  )
);

CREATE INDEX reserve_ledger_entry_fund_idx ON machvon.reserve_ledger_entry (tenant_id, fund_id, posted_at, id);

-- The balance is the database's: an entry takes the lock of its fund, moves the balance and keeps the balance it left; a drawdown that would take the balance below nothing is refused.
CREATE FUNCTION machvon.post_reserve_ledger_entry() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  held machvon.reserve_fund%ROWTYPE;
  moved numeric(24,0);
BEGIN
  SELECT f.* INTO held FROM machvon.reserve_fund f WHERE f.tenant_id = NEW.tenant_id AND f.id = NEW.fund_id FOR UPDATE;
  IF NOT FOUND OR held.project_id <> NEW.project_id THEN
    RAISE EXCEPTION 'an entry belongs to the fund of its project' USING ERRCODE = '23514';
  END IF;
  moved := CASE NEW.entry_kind WHEN 'DRAWDOWN' THEN -NEW.amount_vnd ELSE NEW.amount_vnd END;
  IF held.balance_vnd + moved < 0 THEN
    RAISE EXCEPTION 'RESERVE_BALANCE_INSUFFICIENT: the balance of the fund does not carry the drawdown' USING ERRCODE = '23514';
  END IF;
  NEW.balance_after_vnd := held.balance_vnd + moved;
  UPDATE machvon.reserve_fund SET balance_vnd = NEW.balance_after_vnd, updated_at = now(), version = version + 1 WHERE tenant_id = held.tenant_id AND id = held.id;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER reserve_ledger_entry_post BEFORE INSERT ON machvon.reserve_ledger_entry
  FOR EACH ROW EXECUTE FUNCTION machvon.post_reserve_ledger_entry();

-- A fund balance moves only through an entry: a direct change of it is refused, from the application and from anyone else who is not the posting trigger.
CREATE FUNCTION machvon.guard_reserve_fund() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.balance_vnd <> 0 THEN
      RAISE EXCEPTION 'a fund starts empty: it is filled by an entry of the ledger' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.tenant_id, NEW.id, NEW.project_id, NEW.kind, NEW.created_at, NEW.created_by) IS DISTINCT FROM (OLD.tenant_id, OLD.id, OLD.project_id, OLD.kind, OLD.created_at, OLD.created_by) THEN
    RAISE EXCEPTION 'what a fund is about never changes' USING ERRCODE = '23514';
  END IF;
  IF NEW.balance_vnd IS DISTINCT FROM OLD.balance_vnd AND pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'the balance of a fund moves only through an entry of the ledger' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER reserve_fund_guard BEFORE INSERT OR UPDATE ON machvon.reserve_fund
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_reserve_fund();

-- The ledger is never edited or removed, by the application or by anyone with a statement.
CREATE FUNCTION machvon.forbid_reserve_ledger_change() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  RAISE EXCEPTION 'the reserve ledger is append-only' USING ERRCODE = '23514';
END;
$fn$;

CREATE TRIGGER reserve_ledger_entry_immutable BEFORE UPDATE OR DELETE ON machvon.reserve_ledger_entry
  FOR EACH ROW EXECUTE FUNCTION machvon.forbid_reserve_ledger_change();
CREATE TRIGGER reserve_ledger_entry_no_truncate BEFORE TRUNCATE ON machvon.reserve_ledger_entry
  FOR EACH STATEMENT EXECUTE FUNCTION machvon.forbid_reserve_ledger_change();

REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.reserve_ledger_entry FROM machvon_app;
REVOKE DELETE, TRUNCATE ON TABLE machvon.reserve_fund FROM machvon_app;
REVOKE DELETE, TRUNCATE ON TABLE machvon.reserve_drawdown FROM machvon_app;

-- What a risk would cost and how likely it is: the numbers the expected value of the open risks is made of. One row for each risk, changed in place with a version.
CREATE TABLE machvon.risk_exposure (
  tenant_id uuid NOT NULL,
  risk_id uuid NOT NULL,
  project_id uuid NOT NULL,
  probability_pct numeric(5,2) NOT NULL CHECK (probability_pct >= 0 AND probability_pct <= 100),
  cost_impact_vnd numeric(24,0) NOT NULL CHECK (cost_impact_vnd >= 0),
  set_by uuid NOT NULL,
  set_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, risk_id),
  FOREIGN KEY (tenant_id, risk_id) REFERENCES machvon.project_risk (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES machvon.project (tenant_id, id),
  FOREIGN KEY (tenant_id, set_by) REFERENCES machvon.membership (tenant_id, id)
);

CREATE INDEX risk_exposure_project_idx ON machvon.risk_exposure (tenant_id, project_id);

DO $rls$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['reserve_fund', 'reserve_drawdown', 'reserve_ledger_entry', 'risk_exposure'] LOOP
    EXECUTE format('ALTER TABLE machvon.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE machvon.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_boundary ON machvon.%I AS RESTRICTIVE FOR ALL USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
    EXECUTE format($p$CREATE POLICY tenant_access ON machvon.%I AS PERMISSIVE FOR ALL USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END
$rls$;

COMMENT ON TABLE machvon.reserve_fund IS 'The contingency and the management reserve of a project: two funds, one balance each, moved only by entries of the ledger.';
COMMENT ON TABLE machvon.reserve_ledger_entry IS 'Append-only ledger of a reserve fund: funding, drawdowns (each for one risk or one change order, with an approver who is not the requester).';
COMMENT ON TABLE machvon.reserve_drawdown IS 'A request to draw on a reserve fund for one risk or one change order, decided by someone other than the requester.';
COMMENT ON TABLE machvon.risk_exposure IS 'Probability and cost of a risk: the expected value of the open risks that the contingency is measured against.';
