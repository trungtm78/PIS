-- Authored by hand (not generated): the expand step for the dataset DS-CTR of BI (CA-1): a dataset may be read from the contract fact (`CONTRACT_FACT`), next to the kinds it had. The design CHECK of `bi_dataset.source_kind` is unnamed,
-- so PostgreSQL named it; it is found by what it lists, dropped and written again with the new kind in it. Nothing that was valid before is refused now (the list only grows).
DO $migration$
DECLARE
  old_name text;
BEGIN
  FOR old_name IN
    SELECT c.conname
      FROM pg_constraint c
     WHERE c.conrelid = 'machvon.bi_dataset'::regclass
       AND c.contype = 'c'
       AND pg_get_constraintdef(c.oid) LIKE '%PERIOD_SNAPSHOT%'
  LOOP
    EXECUTE format('ALTER TABLE machvon.bi_dataset DROP CONSTRAINT %I', old_name);
  END LOOP;
END;
$migration$;

ALTER TABLE machvon.bi_dataset
  ADD CONSTRAINT bi_dataset_source_kind_check CHECK (source_kind IN ('PERIOD_SNAPSHOT', 'ALLOCATION_FACT', 'TREASURY_FACT', 'LLM_USAGE_FACT', 'NOTIFICATION_FACT', 'SUBSCRIPTION_USAGE_FACT', 'AUDIT_FACT', 'DOC_FACT', 'CONTRACT_FACT'));
