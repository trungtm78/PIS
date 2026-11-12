-- INT-2: the audit role of the OPT-IN read-only BI port. Run by install.sh --with-bi as the owner, after the migrations, on every install and upgrade (it is idempotent), so that the views the
-- migrations added since are audited too.
--
-- The database runs pgaudit in OBJECT mode (compose.bi.yaml: pgaudit.role = machvon_bi_auditor): a statement is written to the audit log when it reads an object on which that role holds SELECT,
-- whoever the caller is. The role is granted SELECT on every view of the schema machvon_bi and on nothing else, so the log holds the reads of the BI views and not every query of the application,
-- and a BI login that reads anything else is refused by its grants before it is read at all. The role cannot log in and has no members.
DO $audit$
DECLARE
  one record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'machvon_bi_auditor') THEN
    CREATE ROLE machvon_bi_auditor NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
  FOR one IN
    SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'machvon_bi' AND c.relkind IN ('v', 'm')
  LOOP
    EXECUTE format('GRANT SELECT ON machvon_bi.%I TO machvon_bi_auditor', one.relname);
  END LOOP;
END
$audit$;

ALTER DEFAULT PRIVILEGES FOR ROLE machvon_owner IN SCHEMA machvon_bi GRANT SELECT ON TABLES TO machvon_bi_auditor;
