-- Authored by hand (not generated): the allocation of resettlement plots and flats to households (ST-LND-012, LND 3.1, UC-LND-01, LND-12, UAT-PLAN-31).
-- V002 gave `resettlement_allocation` its columns, the guard of the units of the caller (`scope_units_guard`), the rule that a handed-over unit has its two dates and the unique index that lets one unit
-- be held by one household at a time (`resettlement_unit_uq`). This adds what the command relies on, whatever the application checked first:
--   * a plan item is allocated once: the household takes the plot or the flat that its approved plan item gives it, and a second one for the same item is refused;
--   * the words are kept trimmed and bounded, the rank counts from one, and an allocation says the day it was made (and the day it was handed over, when it was);
--   * who the household is, which item it rests on, which unit answers for it and which unit it is never change: another unit is another allocation;
--   * an allocation is never deleted.

ALTER TABLE machvon.resettlement_allocation
  ADD CONSTRAINT resettlement_allocation_text_chk CHECK (
    unit_code = btrim(unit_code) AND char_length(unit_code) BETWEEN 1 AND 60 AND site_text = btrim(site_text) AND char_length(site_text) BETWEEN 1 AND 300
  ),
  ADD CONSTRAINT resettlement_allocation_rank_chk CHECK (priority_rank IS NULL OR priority_rank BETWEEN 1 AND 100000),
  ADD CONSTRAINT resettlement_allocation_allocated_chk CHECK (status NOT IN ('ALLOCATED', 'HANDED_OVER') OR allocated_on IS NOT NULL),
  ADD CONSTRAINT resettlement_allocation_dates_chk CHECK (handed_on IS NULL OR allocated_on IS NULL OR handed_on >= allocated_on);

-- One plan item gives one unit: of two allocations asked for at once, the unique index lets one in.
CREATE UNIQUE INDEX resettlement_plan_item_uq ON machvon.resettlement_allocation (tenant_id, plan_item_id) WHERE plan_item_id IS NOT NULL AND status IN ('ALLOCATED', 'HANDED_OVER');

CREATE FUNCTION machvon.guard_resettlement_allocation() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF (NEW.tenant_id, NEW.id, NEW.household_id, NEW.plan_item_id, NEW.owner_unit_id, NEW.unit_kind, NEW.unit_code, NEW.created_at, NEW.created_by)
     IS DISTINCT FROM (OLD.tenant_id, OLD.id, OLD.household_id, OLD.plan_item_id, OLD.owner_unit_id, OLD.unit_kind, OLD.unit_code, OLD.created_at, OLD.created_by) THEN
    RAISE EXCEPTION 'the household, the plan item, the unit and the unit that answers for the allocation do not change' USING ERRCODE = '23514';
  END IF;
  IF OLD.status IN ('HANDED_OVER', 'DECLINED') AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'an allocation that was handed over or declined is final' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER resettlement_allocation_guard BEFORE UPDATE ON machvon.resettlement_allocation
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_resettlement_allocation();

REVOKE DELETE, TRUNCATE ON TABLE machvon.resettlement_allocation FROM machvon_app;
