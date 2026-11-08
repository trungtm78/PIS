-- Authored by hand (not generated): the link of a contract to a work package and the earned value that is frozen with the snapshot of a closed period (governance deepening, lane B1, G1-4).
-- The earned value of a work package comes from the quantities accepted on the contracts that carry it, so a contract is linked to one first-level work package (or to a lower one, which is read as its first-level
-- root). The link is ended, never deleted, so the earned value of an earlier day can still be explained. The result of a closed period is written once, with its own hash, when the snapshot of the period is
-- frozen: a figure of a closed period is never recomputed from data that moved after it.

CREATE TABLE machvon.project_component_contract (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  component_id uuid NOT NULL,
  contract_id uuid NOT NULL,
  linked_by uuid NOT NULL,
  linked_at timestamptz NOT NULL DEFAULT now(),
  ended_by uuid,
  ended_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id, component_id) REFERENCES machvon.project_component (tenant_id, project_id, id),
  FOREIGN KEY (tenant_id, contract_id) REFERENCES machvon.contract (tenant_id, id),
  FOREIGN KEY (tenant_id, linked_by) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, ended_by) REFERENCES machvon.membership (tenant_id, id),
  CONSTRAINT project_component_contract_ended_chk CHECK ((ended_by IS NULL) = (ended_at IS NULL))
);

-- A contract carries one work package at a time.
CREATE UNIQUE INDEX project_component_contract_active_uq ON machvon.project_component_contract (tenant_id, contract_id) WHERE ended_at IS NULL;
CREATE INDEX project_component_contract_project_idx ON machvon.project_component_contract (tenant_id, project_id, component_id);

-- The contract and the work package are of the same project; a link keeps what it is about and is only ended, never changed otherwise or removed.
CREATE FUNCTION machvon.guard_project_component_contract() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  contract_project uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT c.project_id INTO contract_project FROM machvon.contract c WHERE c.tenant_id = NEW.tenant_id AND c.id = NEW.contract_id;
    IF contract_project IS DISTINCT FROM NEW.project_id THEN
      RAISE EXCEPTION 'a contract is linked only to a work package of its own project' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.ended_at IS NOT NULL OR (NEW.tenant_id, NEW.id, NEW.project_id, NEW.component_id, NEW.contract_id, NEW.linked_by, NEW.linked_at) IS DISTINCT FROM (OLD.tenant_id, OLD.id, OLD.project_id, OLD.component_id, OLD.contract_id, OLD.linked_by, OLD.linked_at) THEN
    RAISE EXCEPTION 'a link is only ended, never changed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER project_component_contract_guard BEFORE INSERT OR UPDATE ON machvon.project_component_contract FOR EACH ROW EXECUTE FUNCTION machvon.guard_project_component_contract();
REVOKE DELETE, TRUNCATE ON TABLE machvon.project_component_contract FROM machvon_app;
CREATE TRIGGER project_component_contract_no_delete BEFORE DELETE ON machvon.project_component_contract FOR EACH ROW EXECUTE FUNCTION machvon.forbid_gov3_change();
CREATE TRIGGER project_component_contract_no_truncate BEFORE TRUNCATE ON machvon.project_component_contract FOR EACH STATEMENT EXECUTE FUNCTION machvon.forbid_gov3_change();

-- The earned value of a project as it stood when the snapshot of a closed period was frozen. `figures` holds every number (and the reasons for the ones that could not be known), `payload_sha256` the hash of
-- them, so a figure of the closed period can be told apart from one that moved afterwards.
CREATE TABLE machvon.evm_frozen_result (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  snapshot_id uuid NOT NULL,
  project_id uuid NOT NULL,
  as_of_date date NOT NULL,
  baseline_version integer,
  eac_method text NOT NULL,
  policy_version text NOT NULL,
  status text NOT NULL CHECK (status IN ('OK', 'INSUFFICIENT')),
  figures jsonb NOT NULL,
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  frozen_by uuid NOT NULL,
  frozen_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT evm_frozen_result_snapshot_project_uq UNIQUE (tenant_id, snapshot_id, project_id),
  FOREIGN KEY (tenant_id, snapshot_id) REFERENCES machvon.period_snapshot (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES machvon.project (tenant_id, id),
  FOREIGN KEY (tenant_id, frozen_by) REFERENCES machvon.membership (tenant_id, id)
);

CREATE INDEX evm_frozen_result_project_idx ON machvon.evm_frozen_result (tenant_id, project_id, as_of_date);

CREATE TRIGGER evm_frozen_result_immutable BEFORE UPDATE OR DELETE ON machvon.evm_frozen_result FOR EACH ROW EXECUTE FUNCTION machvon.forbid_gov3_change();
CREATE TRIGGER evm_frozen_result_no_truncate BEFORE TRUNCATE ON machvon.evm_frozen_result FOR EACH STATEMENT EXECUTE FUNCTION machvon.forbid_gov3_change();
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.evm_frozen_result FROM machvon_app;

DO $rls$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['project_component_contract', 'evm_frozen_result'] LOOP
    EXECUTE format('ALTER TABLE machvon.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE machvon.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_boundary ON machvon.%I AS RESTRICTIVE FOR ALL USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
    EXECUTE format($p$CREATE POLICY tenant_access ON machvon.%I AS PERMISSIVE FOR ALL USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END
$rls$;

COMMENT ON TABLE machvon.project_component_contract IS 'Which first-level work package a contract carries: the link the earned value of a package is measured through. Ended, never deleted.';
COMMENT ON TABLE machvon.evm_frozen_result IS 'The earned value of a project as it stood when the snapshot of a closed period was frozen, with its own hash. Append-only.';

-- Indexes that lead with the tenant under every foreign key and reference column, so the reads by that column and the checks of the foreign keys do not scan (rule ST-CTR-013, rls-catalog).
CREATE INDEX project_component_contract_component_idx ON machvon.project_component_contract (tenant_id, component_id);
