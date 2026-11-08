-- Authored by hand (not generated): the decisions about an item of the alert centre carry the words and the codes that governance needs (governance deepening, lane GOV-2, roadmap G2-1 and G2-2).
-- A postponement has to say why (a reason from the policy, and words when the reason is "other"), says which one of the series it is and whether it was the last one allowed; the clocks of an item can be paused, and a pause names the
-- person who allowed it (not the person who pauses), the day it lasts until and why, and can be ended early by a resume. Both are rows of `work_action`, appended and never changed, like the claims and the assignments before them.
-- `policy_version` is the version of the governance rule that decided ('builtin' when it was the default of the platform), so a decision can be explained by the rule that was in force when it was made.
-- The postponements made before this migration have no reason code: the requirement is checked for new rows only (NOT VALID), and the history stays as it was written.

ALTER TABLE machvon.work_action
  ADD COLUMN reason_code text CHECK (reason_code IS NULL OR reason_code ~ '^[A-Z][A-Z0-9_]{1,39}$'),
  ADD COLUMN allowed_by_membership_id uuid,
  ADD COLUMN paused_until timestamptz,
  ADD COLUMN snooze_ordinal integer CHECK (snooze_ordinal IS NULL OR snooze_ordinal BETWEEN 1 AND 10),
  ADD COLUMN snooze_final boolean,
  ADD COLUMN policy_version text CHECK (policy_version IS NULL OR (policy_version = btrim(policy_version) AND char_length(policy_version) BETWEEN 1 AND 40));

ALTER TABLE machvon.work_action
  ADD CONSTRAINT work_action_allowed_by_fk FOREIGN KEY (tenant_id, allowed_by_membership_id) REFERENCES machvon.membership (tenant_id, id);

DO $gov2$
DECLARE
  definition text;
  constraint_name text;
BEGIN
  -- The kinds of decision: the two new ones go after the last value of the check as it stands.
  SELECT c.conname, pg_get_constraintdef(c.oid) INTO constraint_name, definition
    FROM pg_constraint c
   WHERE c.conrelid = 'machvon.work_action'::regclass AND c.contype = 'c' AND pg_get_constraintdef(c.oid) LIKE '%''SNOOZE''%' AND pg_get_constraintdef(c.oid) LIKE '%action%' AND c.conname <> 'work_action_shape_chk'
   LIMIT 1;
  IF constraint_name IS NULL THEN
    RAISE EXCEPTION 'the check on work_action.action was not found';
  END IF;
  IF position('''PAUSE_CLOCK''' IN definition) = 0 THEN
    EXECUTE format('ALTER TABLE machvon.work_action DROP CONSTRAINT %I', constraint_name);
    EXECUTE format('ALTER TABLE machvon.work_action ADD CONSTRAINT %I %s', constraint_name, regexp_replace(definition, '\]\)\)\)\s*$', ', ''PAUSE_CLOCK''::text, ''RESUME_CLOCK''::text])))'));
  END IF;

  -- The sources: an item that is a clock of its own (a native clock of a module) is CLOCK. This reads the check as it stands and adds the value only when it is missing, as the other lanes do.
  SELECT c.conname, pg_get_constraintdef(c.oid) INTO constraint_name, definition
    FROM pg_constraint c
   WHERE c.conrelid = 'machvon.work_action'::regclass AND c.contype = 'c' AND pg_get_constraintdef(c.oid) LIKE '%''ADVANCE''%' AND pg_get_constraintdef(c.oid) LIKE '%source%'
   LIMIT 1;
  IF constraint_name IS NULL THEN
    RAISE EXCEPTION 'the check on work_action.source was not found';
  END IF;
  IF position('''CLOCK''' IN definition) = 0 THEN
    EXECUTE format('ALTER TABLE machvon.work_action DROP CONSTRAINT %I', constraint_name);
    EXECUTE format('ALTER TABLE machvon.work_action ADD CONSTRAINT %I %s', constraint_name, regexp_replace(definition, '\]\)\)\)\s*$', ', ''CLOCK''::text])))'));
  END IF;
END
$gov2$;

-- Each kind of decision says what it needs and nothing else.
ALTER TABLE machvon.work_action DROP CONSTRAINT work_action_shape_chk;
ALTER TABLE machvon.work_action ADD CONSTRAINT work_action_shape_chk CHECK (
  (action = 'CLAIM' AND assignee_membership_id IS NULL AND due_on IS NULL AND snooze_until IS NULL AND paused_until IS NULL AND allowed_by_membership_id IS NULL)
  OR (action = 'ASSIGN' AND assignee_membership_id IS NOT NULL AND snooze_until IS NULL AND paused_until IS NULL AND allowed_by_membership_id IS NULL)
  OR (action = 'SNOOZE' AND assignee_membership_id IS NULL AND due_on IS NULL AND snooze_until IS NOT NULL AND paused_until IS NULL AND allowed_by_membership_id IS NULL)
  OR (action = 'PAUSE_CLOCK' AND assignee_membership_id IS NULL AND due_on IS NULL AND snooze_until IS NULL AND paused_until IS NOT NULL AND allowed_by_membership_id IS NOT NULL AND allowed_by_membership_id <> actor_membership_id
      AND reason_code IS NOT NULL AND reason IS NOT NULL)
  OR (action = 'RESUME_CLOCK' AND assignee_membership_id IS NULL AND due_on IS NULL AND snooze_until IS NULL AND paused_until IS NULL AND allowed_by_membership_id IS NULL)
);

-- A postponement made from now on says why and which one of the series it is; the rows of before are left as they were.
ALTER TABLE machvon.work_action ADD CONSTRAINT work_action_snooze_governed_chk CHECK (
  action <> 'SNOOZE' OR (reason_code IS NOT NULL AND snooze_ordinal IS NOT NULL AND snooze_final IS NOT NULL AND policy_version IS NOT NULL)
) NOT VALID;
ALTER TABLE machvon.work_action ADD CONSTRAINT work_action_governed_only_chk CHECK (
  action = 'SNOOZE' OR (snooze_ordinal IS NULL AND snooze_final IS NULL)
);

CREATE INDEX work_action_snooze_idx ON machvon.work_action (tenant_id, snooze_until DESC, id) WHERE action = 'SNOOZE';
CREATE INDEX work_action_pause_idx ON machvon.work_action (tenant_id, source_id, source, created_at DESC, id) WHERE action IN ('PAUSE_CLOCK', 'RESUME_CLOCK');

COMMENT ON COLUMN machvon.work_action.reason_code IS 'Why: a code of the snooze policy or of the pause reasons of the clock policy.';
COMMENT ON COLUMN machvon.work_action.allowed_by_membership_id IS 'PAUSE_CLOCK: the person who allowed the pause; never the person who paused.';
COMMENT ON COLUMN machvon.work_action.snooze_ordinal IS 'SNOOZE: which one of the consecutive postponements this is (a claim or a handover starts the count again).';
COMMENT ON COLUMN machvon.work_action.policy_version IS 'The version of the governance rule that decided, or builtin when it was the default of the platform.';

-- Indexes that lead with the tenant under every foreign key and reference column, so the reads by that column and the checks of the foreign keys do not scan (rule ST-CTR-013, rls-catalog).
CREATE INDEX work_action_allowed_by_membership_idx ON machvon.work_action (tenant_id, allowed_by_membership_id) WHERE allowed_by_membership_id IS NOT NULL;
