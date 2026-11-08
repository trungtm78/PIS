-- Authored by hand (not generated): the alert centre takes the alerts of the risk register (MR-1, source PROJECT_RISK, the alerts RISK_SCORE_CRITICAL and RISK_SCORE_JUMP) and of the committee workspace (BAN-1, source COMMITTEE, the alerts COMMITTEE_*) as sources of its own (lane HUBADAPT).
-- `work_action.source` names the module an item comes from; a decision about an item of a new source (claim, assign, snooze) would be refused by the database if it were not in the check.
-- The values of the other sources that the alert centre reads and the check does not name yet are closed here too: the claim and early-warning registers (GOV-8: CONTRACT_CLAIM, CONTRACT_EARLY_WARNING) and the clocks, reviews, freshness, anomalies, red flags and feedback of GOV-10.
-- Other lanes add sources to the same check: this reads the check as it stands and adds the values only when they are missing, so no source of another lane is lost whatever the order of the migrations.

DO $hubadapt$
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
  FOREACH added IN ARRAY ARRAY['PROJECT_RISK', 'COMMITTEE', 'CONTRACT_CLAIM', 'CONTRACT_EARLY_WARNING', 'CONTRACT_CLOCK', 'DOC_REVIEW', 'DATA_FRESHNESS', 'ANOMALY', 'RED_FLAG', 'ALERT_FEEDBACK'] LOOP
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
$hubadapt$;
