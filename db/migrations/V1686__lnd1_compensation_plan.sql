-- Authored by hand (not generated): the plan of compensation, support and resettlement, composed from confirmed inventory records and policy amounts, and revised into a new revision that leaves the earlier one readable (ST-LND-005, LND 3.3, BR-LND-05, UAT-AC382, UAT-PLAN-30).
-- The tables compensation_plan and compensation_plan_item, the unit policy of the items, the totals of the plan (the grand total is generated), the checks of the posting and of the approval and the unique
-- revision of a plan code in a project are in V002. This adds the reason of a revision, the quantity, the unit price and the price decision that an item counted from an inventory rests on (so that the amount
-- of the item is the quantity times the price and the decision is kept), that an item rests on an inventory exactly when it is a compensation, that an inventory record is used once in a plan, the words of the
-- texts, the guard of the edges of the status of a plan (a plan that was posted is revised, never edited), that the items and the totals are written only while the plan is a draft, that an item belongs to
-- the unit and the project of its household and rests on a confirmed record of that household, and that neither table is ever deleted from.

ALTER TABLE machvon.compensation_plan
  ADD COLUMN revision_reason text;

ALTER TABLE machvon.compensation_plan
  ADD CONSTRAINT compensation_plan_text_chk CHECK (
    plan_code = btrim(plan_code) AND plan_code <> '' AND char_length(plan_code) <= 50
    AND (revision_reason IS NULL OR (revision_reason = btrim(revision_reason) AND revision_reason <> '' AND char_length(revision_reason) <= 2000))
  ),
  -- The first revision supersedes nothing; every later one supersedes the one before and says why.
  ADD CONSTRAINT compensation_plan_revision_chk CHECK ((revision = 1) = (supersedes_id IS NULL) AND (revision = 1) = (revision_reason IS NULL)),
  ADD CONSTRAINT compensation_plan_totals_chk CHECK (total_compensation_vnd >= 0 AND total_support_vnd >= 0 AND total_resettlement_vnd >= 0),
  ADD CONSTRAINT compensation_plan_created_by_fk FOREIGN KEY (tenant_id, created_by) REFERENCES machvon.membership (tenant_id, id);

ALTER TABLE machvon.compensation_plan_item
  ADD COLUMN quantity numeric(24, 6),
  ADD COLUMN unit_code text,
  ADD COLUMN unit_price_vnd numeric(24, 0),
  ADD COLUMN price_decision_ref text,
  ADD COLUMN price_decision_version_id uuid,
  ADD COLUMN price_decision_revision integer;

ALTER TABLE machvon.compensation_plan_item
  -- A compensation rests on an inventory record and nothing else does.
  ADD CONSTRAINT compensation_plan_item_basis_chk CHECK ((item_kind IN ('COMPENSATION_LAND', 'COMPENSATION_ASSET')) = (basis_inventory_id IS NOT NULL)),
  -- What an item counted from an inventory keeps of the count: the quantity, the unit price and the decision, with the amount that is the quantity times the price to the dong.
  ADD CONSTRAINT compensation_plan_item_count_chk CHECK (
    (basis_inventory_id IS NULL AND quantity IS NULL AND unit_code IS NULL AND unit_price_vnd IS NULL AND price_decision_ref IS NULL AND price_decision_version_id IS NULL AND price_decision_revision IS NULL)
    OR (basis_inventory_id IS NOT NULL AND quantity > 0 AND unit_code IS NOT NULL AND unit_price_vnd IS NOT NULL AND price_decision_ref IS NOT NULL AND amount_vnd = round(quantity * unit_price_vnd))
  ),
  ADD CONSTRAINT compensation_plan_item_text_chk CHECK (legal_basis = btrim(legal_basis) AND legal_basis <> '' AND char_length(legal_basis) <= 500),
  ADD CONSTRAINT compensation_plan_item_created_by_fk FOREIGN KEY (tenant_id, created_by) REFERENCES machvon.membership (tenant_id, id);

-- An inventory record is used once in a plan.
CREATE UNIQUE INDEX compensation_plan_item_basis_uq ON machvon.compensation_plan_item (tenant_id, plan_id, basis_inventory_id) WHERE basis_inventory_id IS NOT NULL;
CREATE INDEX compensation_plan_item_price_decision_idx ON machvon.compensation_plan_item (tenant_id, price_decision_version_id);

REVOKE DELETE, TRUNCATE ON TABLE machvon.compensation_plan FROM machvon_app;
REVOKE DELETE, TRUNCATE ON TABLE machvon.compensation_plan_item FROM machvon_app;

CREATE FUNCTION machvon.guard_compensation_plan() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'DRAFT' OR NEW.total_compensation_vnd <> 0 OR NEW.total_support_vnd <> 0 OR NEW.total_resettlement_vnd <> 0 THEN
      RAISE EXCEPTION 'PLAN_STATE_INVALID: a plan is drafted first and empty' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.tenant_id, NEW.id, NEW.project_id, NEW.section_id, NEW.executor_unit_id, NEW.executor_kind, NEW.plan_code, NEW.revision, NEW.supersedes_id, NEW.revision_reason, NEW.created_at, NEW.created_by)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.id, OLD.project_id, OLD.section_id, OLD.executor_unit_id, OLD.executor_kind, OLD.plan_code, OLD.revision, OLD.supersedes_id, OLD.revision_reason, OLD.created_at, OLD.created_by) THEN
    RAISE EXCEPTION 'what a plan is never changes' USING ERRCODE = '23514';
  END IF;
  -- The items and the totals are written while the plan is a draft; a plan that was posted keeps the totals it was posted with.
  IF OLD.status <> 'DRAFT' AND (NEW.total_compensation_vnd, NEW.total_support_vnd, NEW.total_resettlement_vnd) IS DISTINCT FROM (OLD.total_compensation_vnd, OLD.total_support_vnd, OLD.total_resettlement_vnd) THEN
    RAISE EXCEPTION 'PLAN_STATE_INVALID: the totals of a plan that is not a draft do not change' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT EXISTS (
    SELECT 1
      FROM (VALUES
        ('DRAFT', 'POSTING'), ('DRAFT', 'CANCELLED'),
        ('POSTING', 'POSTING_CLOSED'), ('POSTING', 'REVISED'), ('POSTING', 'CANCELLED'),
        ('POSTING_CLOSED', 'APPROVED'), ('POSTING_CLOSED', 'REVISED'), ('POSTING_CLOSED', 'CANCELLED'),
        ('APPROVED', 'PAYING'), ('APPROVED', 'REVISED'), ('APPROVED', 'CANCELLED'),
        ('PAYING', 'COMPLETED')
      ) AS allowed (from_status, to_status)
     WHERE allowed.from_status = OLD.status AND allowed.to_status = NEW.status
  ) THEN
    RAISE EXCEPTION 'PLAN_STATE_INVALID: this move of the status is not allowed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER compensation_plan_guard BEFORE INSERT OR UPDATE ON machvon.compensation_plan
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_compensation_plan();

CREATE FUNCTION machvon.guard_compensation_plan_item() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  plan_status text;
  plan_project uuid;
  h_unit uuid;
  h_project uuid;
  basis record;
  expected_kind text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'what a plan item is never changes' USING ERRCODE = '23514';
  END IF;
  SELECT p.status, p.project_id INTO plan_status, plan_project FROM machvon.compensation_plan p WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.plan_id;
  IF plan_status IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'PLAN_STATE_INVALID: items are added to a plan that is a draft' USING ERRCODE = '23514';
  END IF;
  SELECT h.owner_unit_id, h.project_id INTO h_unit, h_project FROM machvon.affected_household h WHERE h.tenant_id = NEW.tenant_id AND h.id = NEW.household_id;
  IF h_unit IS NULL OR h_unit <> NEW.owner_unit_id OR h_project <> plan_project THEN
    RAISE EXCEPTION 'an item belongs to the unit and the project of its household' USING ERRCODE = '23514';
  END IF;
  IF NEW.basis_inventory_id IS NOT NULL THEN
    SELECT r.status, r.household_id, r.parcel_id, r.item_kind, r.amount_vnd INTO basis FROM machvon.land_inventory_record r WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.basis_inventory_id;
    IF basis.status IS DISTINCT FROM 'CONFIRMED' THEN
      RAISE EXCEPTION 'INVENTORY_NOT_CONFIRMED: an item rests on a record the household confirmed' USING ERRCODE = '23514';
    END IF;
    expected_kind := CASE WHEN basis.item_kind = 'LAND' THEN 'COMPENSATION_LAND' ELSE 'COMPENSATION_ASSET' END;
    IF basis.household_id <> NEW.household_id OR NEW.parcel_id IS DISTINCT FROM basis.parcel_id OR basis.amount_vnd <> NEW.amount_vnd OR NEW.item_kind <> expected_kind THEN
      RAISE EXCEPTION 'an item counts what its inventory record counts' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER compensation_plan_item_guard BEFORE INSERT OR UPDATE ON machvon.compensation_plan_item
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_compensation_plan_item();
