-- Authored by hand (not generated): two new sources of the alert centre (governance deepening, lane GOV-9a): ESCALATION (an item that was sent up to the person, G2-3) and COVERAGE (a gap in the coverage of the receivers of alerts that the
-- people who manage covers must close, G2-7). People take them up like any item, so the decisions of `work_action` may name them. This reads the check as it stands and adds the values only when they are missing, as the other lanes do.

DO $gov9$
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
  FOREACH added IN ARRAY ARRAY['ESCALATION', 'COVERAGE'] LOOP
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
$gov9$;
