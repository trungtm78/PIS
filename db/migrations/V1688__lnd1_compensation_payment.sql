-- Authored by hand (not generated): the payments of an approved plan to its households, the 30 days they are due in, the money that a household does not take and is deposited, and what a payment does to the plan, the
-- households and the parcels (ST-LND-007, LND 3.2, BR-LND-03, UAT-AC378, UAT-AC383, UAT-AC397).
-- The table compensation_payment with its unit policy, its foreign keys (the plan, the household, the unit, the treasury transaction, the advance, the voucher) and the checks of the paid and the deposited
-- payment are in V002; the timers (a payment has the timer PAYMENT_30 of land_deadline) are in V1680; the edges of the status of a plan (APPROVED to PAYING to COMPLETED) are in V1686. This adds the reason of a
-- late payment, the masked form of the bank account that is kept sealed, what each status of a payment holds and does not hold, the guard of a payment (it is scheduled on a plan that is approved, for a household
-- that has an amount in it, inside the days of the plan, and it moves only once), and two functions that answer for the whole plan what a caller who sees only the units of their households cannot add up.

ALTER TABLE machvon.compensation_payment
  ADD COLUMN late_reason text,
  ADD COLUMN bank_account_masked text;

ALTER TABLE machvon.compensation_payment
  ADD CONSTRAINT compensation_payment_text_chk CHECK (
    (deposit_reason IS NULL OR (deposit_reason = btrim(deposit_reason) AND deposit_reason <> '' AND char_length(deposit_reason) <= 2000))
    AND (late_reason IS NULL OR (late_reason = btrim(late_reason) AND late_reason <> '' AND char_length(late_reason) <= 2000))
    AND (bank_account_masked IS NULL OR (bank_account_masked <> '' AND char_length(bank_account_masked) <= 40))
    AND (bank_account_masked IS NULL) = (bank_account_enc IS NULL)
  ),
  -- What each status holds: a payment that waits or was cancelled holds nothing of a payment; a paid one says how it was paid (never as a deposit) and, when it was paid after its day, why; a deposited one says why the
  -- household did not take the money and holds no reason of lateness, no advance and no treasury transaction.
  ADD CONSTRAINT compensation_payment_status_chk CHECK (
    (status IN ('PENDING', 'CANCELLED') AND method IS NULL AND paid_on IS NULL AND voucher_document_version_id IS NULL AND deposit_reason IS NULL AND late_reason IS NULL AND advance_id IS NULL AND treasury_transaction_id IS NULL)
    OR (status = 'PAID' AND method IN ('BANK_TRANSFER', 'CASH_VOUCHER', 'TREASURY') AND deposit_reason IS NULL AND (late_reason IS NOT NULL) = (paid_on > due_on))
    OR (status = 'DEPOSITED' AND method = 'DEPOSITED' AND deposit_reason IS NOT NULL AND late_reason IS NULL AND advance_id IS NULL AND treasury_transaction_id IS NULL)
  );

REVOKE DELETE, TRUNCATE ON TABLE machvon.compensation_payment FROM machvon_app;

CREATE FUNCTION machvon.guard_compensation_payment() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  plan_status text;
  plan_project uuid;
  plan_approved date;
  plan_due date;
  plan_total numeric;
  scheduled numeric;
  h_unit uuid;
  h_project uuid;
BEGIN
  SELECT p.status, p.project_id, p.approved_on, p.payment_due_on, p.grand_total_vnd INTO plan_status, plan_project, plan_approved, plan_due, plan_total
    FROM machvon.compensation_plan p WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.plan_id;
  IF TG_OP = 'INSERT' THEN
    IF plan_status NOT IN ('APPROVED', 'PAYING') OR NEW.status <> 'PENDING' THEN
      RAISE EXCEPTION 'PLAN_STATE_INVALID: a payment is scheduled on a plan that is approved' USING ERRCODE = '23514';
    END IF;
    SELECT h.owner_unit_id, h.project_id INTO h_unit, h_project FROM machvon.affected_household h WHERE h.tenant_id = NEW.tenant_id AND h.id = NEW.household_id;
    IF h_unit IS NULL OR h_unit <> NEW.owner_unit_id OR h_project <> plan_project THEN
      RAISE EXCEPTION 'a payment belongs to the unit and the project of its household' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM machvon.compensation_plan_item i WHERE i.tenant_id = NEW.tenant_id AND i.plan_id = NEW.plan_id AND i.household_id = NEW.household_id) THEN
      RAISE EXCEPTION 'a payment is for a household that has an amount in the plan' USING ERRCODE = '23514';
    END IF;
    IF NEW.due_on <= plan_approved OR NEW.due_on > plan_due THEN
      RAISE EXCEPTION 'a payment is due inside the days that follow the approval of the plan' USING ERRCODE = '23514';
    END IF;
    SELECT t.scheduled_vnd INTO scheduled FROM machvon.plan_payment_totals(NEW.plan_id) AS t;
    IF scheduled + NEW.amount_vnd > plan_total THEN
      RAISE EXCEPTION 'PAYMENT_EXCEEDS_PLAN: the payments of a plan add up to no more than the plan holds' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.tenant_id, NEW.id, NEW.plan_id, NEW.household_id, NEW.owner_unit_id, NEW.payment_no, NEW.amount_vnd, NEW.due_on, NEW.bank_account_enc, NEW.bank_account_masked, NEW.created_at, NEW.created_by)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.id, OLD.plan_id, OLD.household_id, OLD.owner_unit_id, OLD.payment_no, OLD.amount_vnd, OLD.due_on, OLD.bank_account_enc, OLD.bank_account_masked, OLD.created_at, OLD.created_by) THEN
    RAISE EXCEPTION 'what a payment is never changes' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF OLD.status <> 'PENDING' THEN
      RAISE EXCEPTION 'PAYMENT_STATE_INVALID: a payment that was paid, deposited or cancelled does not move again' USING ERRCODE = '23514';
    END IF;
    IF NEW.status IN ('PAID', 'DEPOSITED') AND plan_status <> 'PAYING' THEN
      RAISE EXCEPTION 'PLAN_STATE_INVALID: a payment is made on a plan that is being paid' USING ERRCODE = '23514';
    END IF;
  ELSIF (NEW.method, NEW.paid_on, NEW.voucher_document_version_id, NEW.deposit_reason, NEW.late_reason, NEW.advance_id, NEW.treasury_transaction_id)
        IS DISTINCT FROM (OLD.method, OLD.paid_on, OLD.voucher_document_version_id, OLD.deposit_reason, OLD.late_reason, OLD.advance_id, OLD.treasury_transaction_id) THEN
    RAISE EXCEPTION 'PAYMENT_STATE_INVALID: how a payment was made is not rewritten' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER compensation_payment_guard BEFORE INSERT OR UPDATE ON machvon.compensation_payment
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_compensation_payment();

-- ---------------------------------------------------------------------------------------------------------------------------------------
-- What the whole plan has scheduled and settled, whoever asks: a payment is judged against the amount of the plan, not against the part of it that
-- the caller sees. The function answers only for the tenant of the transaction, widens the scope while it runs and puts the caller's back before it
-- returns, and gives numbers, never a row of a household.
-- ---------------------------------------------------------------------------------------------------------------------------------------
CREATE FUNCTION machvon.plan_payment_totals(p_plan uuid)
RETURNS TABLE (scheduled_vnd numeric, settled_vnd numeric, pending_count integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = machvon, pg_temp
AS $fn$
DECLARE
  previous text := current_setting('app.scope_units', true);
  scheduled numeric;
  settled numeric;
  pending integer;
BEGIN
  PERFORM set_config('app.scope_units', '*', true);
  SELECT coalesce(sum(p.amount_vnd) FILTER (WHERE p.status <> 'CANCELLED'), 0), coalesce(sum(p.amount_vnd) FILTER (WHERE p.status IN ('PAID', 'DEPOSITED')), 0), (count(*) FILTER (WHERE p.status = 'PENDING'))::integer
    INTO scheduled, settled, pending
    FROM machvon.compensation_payment p
   WHERE p.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid AND p.plan_id = p_plan;
  PERFORM set_config('app.scope_units', coalesce(previous, ''), true);
  RETURN QUERY SELECT scheduled, settled, pending;
END;
$fn$;

-- Moves the households and the parcels of a plan that was paid in full: a household whose payments are all paid or deposited and cover what the plan holds for it is compensated, and a parcel all of whose
-- households (in this plan) are compensated is paid. A household or a parcel that is somewhere else (objected to, enforced) stays where it is. Returns how many of each moved.
CREATE FUNCTION machvon.advance_paid_subjects(p_plan uuid, p_actor uuid)
RETURNS TABLE (households_moved integer, parcels_moved integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = machvon, pg_temp
AS $fn$
DECLARE
  tenant uuid := nullif(current_setting('app.tenant_id', true), '')::uuid;
  previous text := current_setting('app.scope_units', true);
  moved_households integer;
  moved_parcels integer;
BEGIN
  PERFORM set_config('app.scope_units', '*', true);
  UPDATE machvon.affected_household h
     SET status = 'COMPENSATED', updated_at = now(), updated_by = p_actor, version = h.version + 1
   WHERE h.tenant_id = tenant AND h.status = 'PLAN_LISTED'
     AND EXISTS (SELECT 1 FROM machvon.compensation_plan_item i WHERE i.tenant_id = tenant AND i.plan_id = p_plan AND i.household_id = h.id)
     AND NOT EXISTS (SELECT 1 FROM machvon.compensation_payment p WHERE p.tenant_id = tenant AND p.plan_id = p_plan AND p.household_id = h.id AND p.status = 'PENDING')
     AND (SELECT coalesce(sum(p.amount_vnd), 0) FROM machvon.compensation_payment p WHERE p.tenant_id = tenant AND p.plan_id = p_plan AND p.household_id = h.id AND p.status IN ('PAID', 'DEPOSITED'))
         >= (SELECT coalesce(sum(i.amount_vnd), 0) FROM machvon.compensation_plan_item i WHERE i.tenant_id = tenant AND i.plan_id = p_plan AND i.household_id = h.id);
  GET DIAGNOSTICS moved_households = ROW_COUNT;
  UPDATE machvon.land_parcel pc
     SET status = 'PAID', updated_at = now(), updated_by = p_actor, version = pc.version + 1
   WHERE pc.tenant_id = tenant AND pc.status = 'PLAN_APPROVED'
     AND EXISTS (SELECT 1 FROM machvon.compensation_plan_item i WHERE i.tenant_id = tenant AND i.plan_id = p_plan AND i.parcel_id = pc.id)
     AND NOT EXISTS (
       SELECT 1 FROM machvon.compensation_plan_item i JOIN machvon.affected_household h ON h.tenant_id = i.tenant_id AND h.id = i.household_id
        WHERE i.tenant_id = tenant AND i.plan_id = p_plan AND i.parcel_id = pc.id AND h.status NOT IN ('COMPENSATED', 'RESETTLED', 'CLOSED')
     );
  GET DIAGNOSTICS moved_parcels = ROW_COUNT;
  PERFORM set_config('app.scope_units', coalesce(previous, ''), true);
  RETURN QUERY SELECT moved_households, moved_parcels;
END;
$fn$;

REVOKE ALL ON FUNCTION machvon.plan_payment_totals(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION machvon.advance_paid_subjects(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION machvon.plan_payment_totals(uuid) TO machvon_app;
GRANT EXECUTE ON FUNCTION machvon.advance_paid_subjects(uuid, uuid) TO machvon_app;

-- The guard of the plan also holds a plan back from being paid before a payment is scheduled and from being completed before everything it holds was paid or deposited.
CREATE OR REPLACE FUNCTION machvon.guard_compensation_plan() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  unconfirmed text;
  open_opinions integer;
  paying record;
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
  -- A posting is what it was when it was posted: the days, the place and the rule version that counted them are not rewritten, and the approval is not either.
  IF OLD.posting_started_on IS NOT NULL AND (NEW.posting_started_on, NEW.posting_ends_on, NEW.posting_place_text, NEW.timer_rule_version_id) IS DISTINCT FROM (OLD.posting_started_on, OLD.posting_ends_on, OLD.posting_place_text, OLD.timer_rule_version_id) THEN
    RAISE EXCEPTION 'PLAN_STATE_INVALID: a posting is not rewritten' USING ERRCODE = '23514';
  END IF;
  IF OLD.approved_on IS NOT NULL AND (NEW.approved_on, NEW.approved_by, NEW.payment_due_on, NEW.decision_document_version_id) IS DISTINCT FROM (OLD.approved_on, OLD.approved_by, OLD.payment_due_on, OLD.decision_document_version_id) THEN
    RAISE EXCEPTION 'PLAN_STATE_INVALID: an approval is not rewritten' USING ERRCODE = '23514';
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
  IF OLD.status = 'DRAFT' AND NEW.status = 'POSTING' THEN
    IF NEW.total_compensation_vnd + NEW.total_support_vnd + NEW.total_resettlement_vnd = 0 THEN
      RAISE EXCEPTION 'PLAN_HAS_NO_ITEMS: a plan with no amount is not posted' USING ERRCODE = '23514';
    END IF;
    unconfirmed := machvon.plan_unconfirmed_inventory(NEW.id);
    IF unconfirmed IS NOT NULL THEN
      RAISE EXCEPTION 'INVENTORY_NOT_CONFIRMED: an item rests on a record that is %', unconfirmed USING ERRCODE = '23514';
    END IF;
  END IF;
  IF OLD.status = 'POSTING' AND NEW.status = 'POSTING_CLOSED' AND NEW.feedback_summary IS NULL THEN
    RAISE EXCEPTION 'a posting is closed with a summary of the opinions' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'POSTING_CLOSED' AND NEW.status = 'APPROVED' THEN
    SELECT c.open_count INTO open_opinions FROM machvon.plan_feedback_counts(NEW.id) AS c;
    IF open_opinions > 0 THEN
      RAISE EXCEPTION 'UNRESOLVED_FEEDBACK: % opinions are still open', open_opinions USING ERRCODE = '23514';
    END IF;
    unconfirmed := machvon.plan_unconfirmed_inventory(NEW.id);
    IF unconfirmed IS NOT NULL THEN
      RAISE EXCEPTION 'INVENTORY_NOT_CONFIRMED: an item rests on a record that is %', unconfirmed USING ERRCODE = '23514';
    END IF;
  END IF;
  IF OLD.status = 'APPROVED' AND NEW.status = 'PAYING' THEN
    SELECT t.scheduled_vnd INTO paying FROM machvon.plan_payment_totals(NEW.id) AS t;
    IF paying.scheduled_vnd = 0 THEN
      RAISE EXCEPTION 'PLAN_STATE_INVALID: a plan is paid once a payment is scheduled' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF OLD.status = 'PAYING' AND NEW.status = 'COMPLETED' THEN
    SELECT t.settled_vnd, t.pending_count INTO paying FROM machvon.plan_payment_totals(NEW.id) AS t;
    IF paying.pending_count > 0 OR paying.settled_vnd < NEW.total_compensation_vnd + NEW.total_support_vnd + NEW.total_resettlement_vnd THEN
      RAISE EXCEPTION 'PLAN_STATE_INVALID: a plan is completed when every amount of it was paid or deposited' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$;
