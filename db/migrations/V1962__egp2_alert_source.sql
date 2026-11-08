-- Authored by hand (not generated): the alert centre takes the duties of posting to the national procurement network as a source of its own (EGP-2, the alerts EGP_POSTING_DUE and EGP_POSTING_OVERDUE).
-- `work_action.source` names the module an item comes from; a decision about an item of the new source (claim, assign, snooze) would be refused by the database if EGP_POSTING were not in the check.
-- Other lanes add sources to the same check: this reads the check as it stands and adds the value only when it is missing, so no source of another lane is lost whatever the order of the migrations.

DO $egp2$
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
  FOREACH added IN ARRAY ARRAY['EGP_POSTING'] LOOP
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
$egp2$;
