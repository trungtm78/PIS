-- Authored by hand (not generated): the alert centre takes the look-ahead plans and the lessons learned of projects as sources of its own (GOV-11a, G1-19, the alerts LOOK_AHEAD_NOT_READY, LOOK_AHEAD_MISSING and LESSONS_LEARNED_MISSING).
-- `work_action.source` names the module an item comes from; a decision about an item of a new source (claim, assign, snooze) would be refused by the database if it were not in the check.
-- Other lanes add sources to the same check: this reads the check as it stands and adds the values only when they are missing, so no source of another lane is lost whatever the order of the migrations.

DO $gov11prj$
DECLARE
  definition text;
  constraint_name text;
  added text;
BEGIN
  SELECT c.conname, pg_get_constraintdef(c.oid) INTO constraint_name, definition
    FROM pg_constraint c
   WHERE c.conrelid = 'machvon.work_action'::regclass AND c.contype = 'c' AND pg_get_constraintdef(c.oid) LIKE '%''ADVANCE''%' AND pg_get_constraintdef(c.oid) LIKE '%source%'
   LIMIT 1;
  IF constraint_name IS NULL THEN
    RAISE EXCEPTION 'the check on work_action.source was not found';
  END IF;
  FOREACH added IN ARRAY ARRAY['LOOK_AHEAD', 'LESSONS_LEARNED'] LOOP
    IF position(format('''%s''', added) IN definition) = 0 THEN
      -- The definition reads CHECK ((source = ANY (ARRAY['A'::text, ...]))): the new source goes after the last value.
      definition := regexp_replace(definition, '\]\)\)\)\s*$', format(', ''%s''::text])))', added));
    END IF;
  END LOOP;
  IF definition <> pg_get_constraintdef((SELECT c.oid FROM pg_constraint c WHERE c.conrelid = 'machvon.work_action'::regclass AND c.conname = constraint_name)) THEN
    EXECUTE format('ALTER TABLE machvon.work_action DROP CONSTRAINT %I', constraint_name);
    EXECUTE format('ALTER TABLE machvon.work_action ADD CONSTRAINT %I %s', constraint_name, definition);
  END IF;
END
$gov11prj$;
