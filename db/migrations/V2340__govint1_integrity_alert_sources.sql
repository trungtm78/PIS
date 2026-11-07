-- Authored by hand (not generated): the alert centre takes the integrity of the money and of the duties, and the alert of the baseline, as sources of their own (governance deepening, integration GOV-INT). `work_action.source`
-- names the module an item comes from; the sources added here are TREASURY_RECON (the items of difference with the Treasury past their day, lane D G4-4), CROSS_TOTAL (the three totals of the disbursed money that disagree, G4-5),
-- SOD_EXCEPTION (the exceptions to the separation of duties that end soon or were used, G4-1), PAYMENT_INTEGRITY (a payment request that a check blocked or sent with signals, G4-2), DISBURSEMENT_EXCEPTION (an exception to a ceiling
-- of disbursement that lapses, G4-2) and PROJECT_GOVERNANCE (a milestone or a project end moved as many times as the rule says, sent to the auditors, lane B1 G1-3). PROCUREMENT_WORKFLOW (the monitoring of the procurement
-- workflow, lane PRC-1) was read by the alert centre but was never added to the check, so that a decision about one of its items (claim, assign, snooze) was refused by the database: it is added here.

-- Other lanes add sources to the same check: this reads the check as it stands and adds each value only when it is missing, so no source of another lane is lost whatever the order of the migrations.

DO $govint$
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
  FOREACH added IN ARRAY ARRAY['PROCUREMENT_WORKFLOW', 'TREASURY_RECON', 'CROSS_TOTAL', 'SOD_EXCEPTION', 'PAYMENT_INTEGRITY', 'DISBURSEMENT_EXCEPTION', 'PROJECT_GOVERNANCE'] LOOP
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
$govint$;
