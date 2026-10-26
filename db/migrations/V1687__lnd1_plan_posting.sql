-- Authored by hand (not generated): the posting of a plan to the households, the opinions they give while it is posted, the closing of the posting and the approval of the plan (ST-LND-006, LND 3.1 steps 5-6, BR-LND-02, UAT-AC377).
-- The plan, its posting columns, the check of the posting and the check of the approval are in V002; the items, the totals and the edges of the status are in V1686; the timer table and its rows are in V1680.
-- This adds who approved a plan (never the person who drafted it), the opinions of the households (kept for good, handled one by one, seen only from inside the unit they came from like the household itself),
-- what a posting is not allowed to change afterwards, and four functions that read or advance what a caller who approves the plan cannot see row by row: the approver holds a grant on a project, which reaches no
-- household, yet the approval has to know that every record is still confirmed and every opinion handled, and moves the parcels and the households of the plan with it.

ALTER TABLE machvon.compensation_plan
  ADD COLUMN approved_by uuid;

ALTER TABLE machvon.compensation_plan
  ADD CONSTRAINT compensation_plan_approved_by_fk FOREIGN KEY (tenant_id, approved_by) REFERENCES machvon.membership (tenant_id, id),
  -- Whoever approves a plan is not the person who drafted it, and a plan that is approved says who approved it.
  ADD CONSTRAINT compensation_plan_approver_chk CHECK (
    (approved_by IS NULL OR approved_by <> created_by) AND (status NOT IN ('APPROVED', 'PAYING', 'COMPLETED') OR approved_by IS NOT NULL)
  ),
  ADD CONSTRAINT compensation_plan_posting_text_chk CHECK (
    (posting_place_text IS NULL OR (posting_place_text = btrim(posting_place_text) AND posting_place_text <> '' AND char_length(posting_place_text) <= 2000))
    AND (feedback_summary IS NULL OR (feedback_summary = btrim(feedback_summary) AND feedback_summary <> '' AND char_length(feedback_summary) <= 2000))
  ),
  -- A plan that was posted names the place it was posted at and the rule version that counted its days.
  ADD CONSTRAINT compensation_plan_posting_facts_chk CHECK (
    status IN ('DRAFT', 'CANCELLED', 'REVISED') OR (posting_place_text IS NOT NULL AND timer_rule_version_id IS NOT NULL)
  );

CREATE INDEX compensation_plan_approved_by_idx ON machvon.compensation_plan (tenant_id, approved_by);

COMMENT ON COLUMN machvon.compensation_plan.approved_by IS 'The member who approved the plan; never the member who drafted it (compensation_plan_approver_chk).';

-- ---------------------------------------------------------------------------------------------------------------------------------------
-- The opinions of the households while a plan is posted. An opinion is recorded once, never edited, and is handled once, with a note; an opinion is
-- seen inside the unit it came from (the unit of the household, or the unit that executes the plan for an opinion of nobody on the list), so the
-- people who read the plan of a project see the count of what is open, not the words.
-- ---------------------------------------------------------------------------------------------------------------------------------------
CREATE TABLE machvon.compensation_plan_feedback (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  plan_id uuid NOT NULL,
  household_id uuid,
  owner_unit_id uuid NOT NULL,
  channel text NOT NULL CHECK (channel IN ('IN_PERSON', 'LETTER', 'PORTAL', 'MEETING')),
  summary text NOT NULL CHECK (summary = btrim(summary) AND summary <> '' AND char_length(summary) <= 2000),
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'HANDLED')),
  recorded_on date NOT NULL,
  handled_on date,
  handled_by uuid,
  handling_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid NOT NULL,
  version bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, plan_id) REFERENCES machvon.compensation_plan (tenant_id, id),
  FOREIGN KEY (tenant_id, household_id) REFERENCES machvon.affected_household (tenant_id, id),
  FOREIGN KEY (tenant_id, owner_unit_id) REFERENCES machvon.organization_unit (tenant_id, id),
  FOREIGN KEY (tenant_id, handled_by) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES machvon.membership (tenant_id, id),
  -- An opinion is open or handled; a handled one says when, by whom and what was done, and not before it was recorded.
  CONSTRAINT compensation_plan_feedback_handled_chk CHECK (
    (status = 'OPEN' AND handled_on IS NULL AND handled_by IS NULL AND handling_note IS NULL)
    OR (status = 'HANDLED' AND handled_on IS NOT NULL AND handled_by IS NOT NULL AND handled_on >= recorded_on
        AND handling_note = btrim(handling_note) AND handling_note <> '' AND char_length(handling_note) <= 2000)
  )
);

CREATE INDEX compensation_plan_feedback_plan_idx ON machvon.compensation_plan_feedback (tenant_id, plan_id, status);
CREATE INDEX compensation_plan_feedback_household_idx ON machvon.compensation_plan_feedback (tenant_id, household_id);
CREATE INDEX compensation_plan_feedback_owner_unit_idx ON machvon.compensation_plan_feedback (tenant_id, owner_unit_id);

ALTER TABLE machvon.compensation_plan_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.compensation_plan_feedback FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.compensation_plan_feedback AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.compensation_plan_feedback AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY scope_units_guard ON machvon.compensation_plan_feedback AS RESTRICTIVE FOR ALL
  USING (current_setting('app.scope_units', true) = '*' OR owner_unit_id::text = ANY (string_to_array(current_setting('app.scope_units', true), ',')))
  WITH CHECK (current_setting('app.scope_units', true) = '*' OR owner_unit_id::text = ANY (string_to_array(current_setting('app.scope_units', true), ',')));

REVOKE DELETE, TRUNCATE ON TABLE machvon.compensation_plan_feedback FROM machvon_app;

CREATE FUNCTION machvon.guard_compensation_plan_feedback() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  plan_status text;
  plan_project uuid;
  plan_unit uuid;
  h_unit uuid;
  h_project uuid;
BEGIN
  SELECT p.status, p.project_id, p.executor_unit_id INTO plan_status, plan_project, plan_unit
    FROM machvon.compensation_plan p WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.plan_id;
  IF TG_OP = 'INSERT' THEN
    IF plan_status IS DISTINCT FROM 'POSTING' OR NEW.status <> 'OPEN' THEN
      RAISE EXCEPTION 'PLAN_STATE_INVALID: an opinion is recorded while the plan is posted' USING ERRCODE = '23514';
    END IF;
    IF NEW.household_id IS NULL THEN
      IF NEW.owner_unit_id <> plan_unit THEN
        RAISE EXCEPTION 'an opinion of nobody on the list belongs to the unit that executes the plan' USING ERRCODE = '23514';
      END IF;
    ELSE
      SELECT h.owner_unit_id, h.project_id INTO h_unit, h_project FROM machvon.affected_household h WHERE h.tenant_id = NEW.tenant_id AND h.id = NEW.household_id;
      IF h_unit IS NULL OR h_unit <> NEW.owner_unit_id OR h_project <> plan_project THEN
        RAISE EXCEPTION 'an opinion belongs to the unit and the project of its household' USING ERRCODE = '23514';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.tenant_id, NEW.id, NEW.plan_id, NEW.household_id, NEW.owner_unit_id, NEW.channel, NEW.summary, NEW.recorded_on, NEW.created_at, NEW.created_by)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.id, OLD.plan_id, OLD.household_id, OLD.owner_unit_id, OLD.channel, OLD.summary, OLD.recorded_on, OLD.created_at, OLD.created_by) THEN
    RAISE EXCEPTION 'what an opinion says is never changed' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'HANDLED' AND (NEW.status, NEW.handled_on, NEW.handled_by, NEW.handling_note) IS DISTINCT FROM (OLD.status, OLD.handled_on, OLD.handled_by, OLD.handling_note) THEN
    RAISE EXCEPTION 'FEEDBACK_ALREADY_HANDLED: a handled opinion is final' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'HANDLED' AND OLD.status = 'OPEN' AND plan_status NOT IN ('POSTING', 'POSTING_CLOSED') THEN
    RAISE EXCEPTION 'PLAN_STATE_INVALID: an opinion is handled while the plan is posted or its posting is closed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER compensation_plan_feedback_guard BEFORE INSERT OR UPDATE ON machvon.compensation_plan_feedback
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_compensation_plan_feedback();

-- ---------------------------------------------------------------------------------------------------------------------------------------
-- What a plan rests on, whoever asks. Each function answers only for the tenant the transaction acts as, reads with the rights of its owner over all
-- the units of that tenant (it widens the scope of the transaction while it runs and puts the caller's scope back before it returns) and gives a count or a word, never a row of a household.
-- ---------------------------------------------------------------------------------------------------------------------------------------
-- The status of the first inventory record of the plan that is not confirmed, or null when every item rests on a confirmed record.
CREATE FUNCTION machvon.plan_unconfirmed_inventory(p_plan uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = machvon, pg_temp
AS $fn$
DECLARE
  found_status text;
  previous text := current_setting('app.scope_units', true);
BEGIN
  PERFORM set_config('app.scope_units', '*', true);
  SELECT r.status INTO found_status
    FROM machvon.compensation_plan_item i
    JOIN machvon.land_inventory_record r ON r.tenant_id = i.tenant_id AND r.id = i.basis_inventory_id
   WHERE i.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid AND i.plan_id = p_plan AND r.status <> 'CONFIRMED'
   ORDER BY i.id
   LIMIT 1;
  PERFORM set_config('app.scope_units', coalesce(previous, ''), true);
  RETURN found_status;
END;
$fn$;

-- How many opinions of the plan are open and how many are handled.
CREATE FUNCTION machvon.plan_feedback_counts(p_plan uuid)
RETURNS TABLE (open_count integer, handled_count integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = machvon, pg_temp
AS $fn$
DECLARE
  previous text := current_setting('app.scope_units', true);
  opened integer;
  handled integer;
BEGIN
  PERFORM set_config('app.scope_units', '*', true);
  SELECT (count(*) FILTER (WHERE f.status = 'OPEN'))::integer, (count(*) FILTER (WHERE f.status = 'HANDLED'))::integer INTO opened, handled
    FROM machvon.compensation_plan_feedback f
   WHERE f.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid AND f.plan_id = p_plan;
  PERFORM set_config('app.scope_units', coalesce(previous, ''), true);
  RETURN QUERY SELECT opened, handled;
END;
$fn$;

-- Moves the parcels and the households of the plan to where its status puts them: a draft lists its inventoried parcels as drafted, a posted plan posts its parcels and lists its inventoried households,
-- an approved plan approves the parcels it posted. A parcel or a household that is somewhere else (objected to, paid, enforced) stays where it is. Returns how many of each moved.
CREATE FUNCTION machvon.advance_plan_subjects(p_plan uuid, p_actor uuid)
RETURNS TABLE (parcels_moved integer, households_moved integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = machvon, pg_temp
AS $fn$
DECLARE
  tenant uuid := nullif(current_setting('app.tenant_id', true), '')::uuid;
  previous text := current_setting('app.scope_units', true);
  plan_status text;
  from_statuses text[];
  to_status text;
  moved_parcels integer := 0;
  moved_households integer := 0;
BEGIN
  SELECT p.status INTO plan_status FROM machvon.compensation_plan p WHERE p.tenant_id = tenant AND p.id = p_plan;
  PERFORM set_config('app.scope_units', '*', true);
  IF plan_status = 'DRAFT' THEN
    from_statuses := ARRAY['INVENTORIED']; to_status := 'PLAN_DRAFTED';
  ELSIF plan_status = 'POSTING' THEN
    from_statuses := ARRAY['INVENTORIED', 'PLAN_DRAFTED']; to_status := 'PLAN_POSTED';
  ELSIF plan_status = 'APPROVED' THEN
    from_statuses := ARRAY['PLAN_POSTED']; to_status := 'PLAN_APPROVED';
  ELSE
    PERFORM set_config('app.scope_units', coalesce(previous, ''), true);
    RETURN QUERY SELECT 0, 0;
    RETURN;
  END IF;
  UPDATE machvon.land_parcel pc
     SET status = to_status, updated_at = now(), updated_by = p_actor, version = pc.version + 1
   WHERE pc.tenant_id = tenant AND pc.status = ANY (from_statuses)
     AND pc.id IN (SELECT i.parcel_id FROM machvon.compensation_plan_item i WHERE i.tenant_id = tenant AND i.plan_id = p_plan AND i.parcel_id IS NOT NULL);
  GET DIAGNOSTICS moved_parcels = ROW_COUNT;
  IF plan_status = 'POSTING' THEN
    UPDATE machvon.affected_household h
       SET status = 'PLAN_LISTED', updated_at = now(), updated_by = p_actor, version = h.version + 1
     WHERE h.tenant_id = tenant AND h.status = 'INVENTORIED'
       AND h.id IN (SELECT i.household_id FROM machvon.compensation_plan_item i WHERE i.tenant_id = tenant AND i.plan_id = p_plan);
    GET DIAGNOSTICS moved_households = ROW_COUNT;
  END IF;
  PERFORM set_config('app.scope_units', coalesce(previous, ''), true);
  RETURN QUERY SELECT moved_parcels, moved_households;
END;
$fn$;

REVOKE ALL ON FUNCTION machvon.plan_unconfirmed_inventory(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION machvon.plan_feedback_counts(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION machvon.advance_plan_subjects(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION machvon.plan_unconfirmed_inventory(uuid) TO machvon_app;
GRANT EXECUTE ON FUNCTION machvon.plan_feedback_counts(uuid) TO machvon_app;
GRANT EXECUTE ON FUNCTION machvon.advance_plan_subjects(uuid, uuid) TO machvon_app;

-- ---------------------------------------------------------------------------------------------------------------------------------------
-- The guard of the plan now also keeps a posting as it was posted and an approval as it was given, and refuses to post a plan that has no items,
-- that rests on a record which is no longer confirmed, or to approve one with an opinion still open.
-- ---------------------------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION machvon.guard_compensation_plan() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  unconfirmed text;
  open_opinions integer;
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
  RETURN NEW;
END;
$fn$;
