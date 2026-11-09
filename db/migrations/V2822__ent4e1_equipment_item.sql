-- Authored by hand (not generated): the register of the equipment lines of the investment plan (CN.02, ENT-4e). A line is a thing the project buys as equipment ("mua sam trang thiet bi du an"):
-- its planned value, and once they exist the procurement package (BID) and the contract (CTR) it became. The view of the Ban Thuong mai reads the choice of contractor, the contract value and the
-- payments from the modules that own them (eng-review R21); this table only says which packages and contracts are equipment lines and what the plan expected. The unit scope is the owner unit of
-- the project: a caller sees a line when the project is in the scope of the grant.
--   * a line keeps its project, its code and its planned value for good (a change of the plan is a new line and the old one CANCELLED);
--   * the package and the contract are linked once each and must belong to the same project; a contract must be of the package that is linked;
--   * `source` says how the line got here: typed by a person (MANUAL) or taken from the plan file of the national bidding network (EGP_FILE, PENDING-EXTERNAL layout).

CREATE TABLE machvon.equipment_procurement_item (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  planned_value_vnd numeric(24, 0) NOT NULL,
  plan_ref text,
  package_id uuid,
  contract_id uuid,
  status text NOT NULL DEFAULT 'ACTIVE',
  cancel_reason text,
  source text NOT NULL DEFAULT 'MANUAL',
  source_ref text,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES machvon.project (tenant_id, id),
  FOREIGN KEY (tenant_id, package_id) REFERENCES machvon.procurement_package (tenant_id, id),
  FOREIGN KEY (tenant_id, contract_id) REFERENCES machvon.contract (tenant_id, id),
  CONSTRAINT equipment_item_code_chk CHECK (code = btrim(code) AND code ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,59}$'),
  CONSTRAINT equipment_item_name_chk CHECK (name = btrim(name) AND char_length(name) BETWEEN 3 AND 500),
  CONSTRAINT equipment_item_value_chk CHECK (planned_value_vnd > 0),
  CONSTRAINT equipment_item_status_chk CHECK (status IN ('ACTIVE', 'CANCELLED')),
  CONSTRAINT equipment_item_cancel_chk CHECK ((status = 'CANCELLED') = (cancel_reason IS NOT NULL) AND (cancel_reason IS NULL OR (cancel_reason = btrim(cancel_reason) AND char_length(cancel_reason) BETWEEN 5 AND 2000))),
  CONSTRAINT equipment_item_source_chk CHECK (source IN ('MANUAL', 'EGP_FILE')),
  CONSTRAINT equipment_item_contract_needs_package_chk CHECK (contract_id IS NULL OR package_id IS NOT NULL),
  CONSTRAINT equipment_item_version_chk CHECK (version >= 1),
  CONSTRAINT equipment_item_code_uq UNIQUE (tenant_id, project_id, code)
);
CREATE INDEX equipment_item_project_idx ON machvon.equipment_procurement_item (tenant_id, project_id, status, code);
CREATE INDEX equipment_item_package_idx ON machvon.equipment_procurement_item (tenant_id, package_id) WHERE package_id IS NOT NULL;
CREATE INDEX equipment_item_contract_idx ON machvon.equipment_procurement_item (tenant_id, contract_id) WHERE contract_id IS NOT NULL;
-- a package is one line of the plan at most while the line is live
CREATE UNIQUE INDEX equipment_item_package_uq ON machvon.equipment_procurement_item (tenant_id, package_id) WHERE package_id IS NOT NULL AND status = 'ACTIVE';

CREATE FUNCTION machvon.guard_equipment_item() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  linked_project uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.code IS DISTINCT FROM OLD.code OR NEW.planned_value_vnd IS DISTINCT FROM OLD.planned_value_vnd
       OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'a line keeps its project, its code, its planned value and its origin' USING ERRCODE = '23514';
    END IF;
    IF OLD.status = 'CANCELLED' THEN
      RAISE EXCEPTION 'a cancelled line is never changed' USING ERRCODE = '23514';
    END IF;
    IF OLD.package_id IS NOT NULL AND NEW.package_id IS DISTINCT FROM OLD.package_id THEN
      RAISE EXCEPTION 'a line is linked to its package once' USING ERRCODE = '23514';
    END IF;
    IF OLD.contract_id IS NOT NULL AND NEW.contract_id IS DISTINCT FROM OLD.contract_id THEN
      RAISE EXCEPTION 'a line is linked to its contract once' USING ERRCODE = '23514';
    END IF;
    IF NEW.version <> OLD.version + 1 THEN
      RAISE EXCEPTION 'a change of a line moves its version by one' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.package_id IS NOT NULL THEN
    SELECT project_id INTO linked_project FROM machvon.procurement_package WHERE tenant_id = NEW.tenant_id AND id = NEW.package_id;
    IF linked_project IS DISTINCT FROM NEW.project_id THEN
      RAISE EXCEPTION 'the package of a line belongs to the project of the line' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.contract_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM machvon.contract c WHERE c.tenant_id = NEW.tenant_id AND c.id = NEW.contract_id AND c.project_id = NEW.project_id AND c.package_id = NEW.package_id) THEN
      RAISE EXCEPTION 'the contract of a line is a contract of its package and its project' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER equipment_item_guard BEFORE INSERT OR UPDATE ON machvon.equipment_procurement_item FOR EACH ROW EXECUTE FUNCTION machvon.guard_equipment_item();

ALTER TABLE machvon.equipment_procurement_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.equipment_procurement_item FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.equipment_procurement_item AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.equipment_procurement_item AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE DELETE, TRUNCATE ON TABLE machvon.equipment_procurement_item FROM machvon_app;

COMMENT ON TABLE machvon.equipment_procurement_item IS 'ENT-4e: a line of the investment plan bought as equipment, with the package (BID) and the contract (CTR) it became; the view reads the rest from the modules that own it.';
