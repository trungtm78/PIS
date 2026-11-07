-- Authored by hand (not generated): the alert centre takes the money control as a source of its own (governance deepening, lane B2). `work_action.source` names the module an item comes from; the money
-- control (the estimate at completion above the approved total investment, the contingency below the expected value of the open risks, an advance owed that the payments left cannot recover) is MONEY_CONTROL.
-- Other lanes add sources to the same check: this reads the check as it stands and adds the value only when it is missing, so no source of another lane is lost whatever the order of the migrations.

DO $money$
DECLARE
  definition text;
  constraint_name text;
BEGIN
  SELECT c.conname, pg_get_constraintdef(c.oid) INTO constraint_name, definition
    FROM pg_constraint c
   WHERE c.conrelid = 'machvon.work_action'::regclass AND c.contype = 'c' AND pg_get_constraintdef(c.oid) LIKE '%''ADVANCE''%' AND pg_get_constraintdef(c.oid) LIKE '%source%'
   LIMIT 1;
  IF constraint_name IS NULL THEN
    RAISE EXCEPTION 'the check on work_action.source was not found';
  END IF;
  IF position('''MONEY_CONTROL''' IN definition) = 0 THEN
    EXECUTE format('ALTER TABLE machvon.work_action DROP CONSTRAINT %I', constraint_name);
    -- The definition reads CHECK ((source = ANY (ARRAY['A'::text, ...]))): the new source goes after the last value.
    EXECUTE format('ALTER TABLE machvon.work_action ADD CONSTRAINT %I %s', constraint_name, regexp_replace(definition, '\]\)\)\)\s*$', ', ''MONEY_CONTROL''::text])))'));
  END IF;
END
$money$;
