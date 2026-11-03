-- The login of the PowerSync service (ST-KERNEL-045, AC-ST-KERNEL-045-3, UAT-AC500): the role machvon_sync may replicate and read
-- the tables of the publication `powersync`, and nothing else. Run it as a superuser once after the migrations (REPLICATION cannot
-- be granted by anyone else) and again whenever the list of published tables changes; it can be run any number of times.
-- It carries no password: deployment sets the credential from the secret store (`infra/secrets`), never from this file.
--
-- The list below is the whole list of tables that go to a phone: the tables of the sync contract of the weekly report
-- (DIS_SYNC_TABLES in packages/contracts/src/dis-sync.ts) and the scope table that the bucket parameters read. A test
-- (apps/api/test/dis/powersync-role.test.ts) fails when this list and the contract differ.

ALTER ROLE machvon_sync WITH LOGIN REPLICATION NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;

DO $publication$
DECLARE published text := 'machvon.sync_membership_scope, machvon.project, machvon.reporting_period, machvon.report_revision, machvon.funding_snapshot_line, machvon.progress_snapshot, machvon.report_narrative';
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'powersync') THEN
    EXECUTE 'ALTER PUBLICATION powersync SET TABLE ' || published;
  ELSE
    EXECUTE 'CREATE PUBLICATION powersync FOR TABLE ' || published;
  END IF;
END
$publication$;

-- Whatever the role held before is taken away, so a table that left the publication stops being readable at once.
REVOKE ALL ON ALL TABLES IN SCHEMA machvon FROM machvon_sync;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA machvon FROM machvon_sync;

-- SELECT is granted from the publication itself, so the grants cannot name a table that is not published.
DO $grants$
DECLARE published record;
BEGIN
  FOR published IN SELECT schemaname, tablename FROM pg_publication_tables WHERE pubname = 'powersync' LOOP
    EXECUTE format('GRANT SELECT ON TABLE %I.%I TO machvon_sync', published.schemaname, published.tablename);
  END LOOP;
END
$grants$;
