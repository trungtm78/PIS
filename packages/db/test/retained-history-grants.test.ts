import { resolve } from 'node:path';
import { Client } from 'pg';
import { startMigratedTestDatabase } from '../src/migrated-test-database';
import type { TestDatabase } from '../src/test-database';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');

/**
 * Tables whose module document gives a retention of "permanent" (or whose migration says the row is kept for good) and whose commands only
 * insert and update. The runtime role must not be able to delete a row of them: no command does, and a statement that bypassed the
 * commands (a defect, an injection) must not be able to erase the history that a report, an audit row or a ledger refers to.
 */
const KEPT_FOR_GOOD = [
  'project',
  'project_revision',
  'project_stage_change',
  'project_appraisal',
  'project_accountability',
  'task_force',
  'task_force_member',
  'master_record',
  'master_record_version',
  'master_crosswalk',
  'outgoing_document',
  'outgoing_document_event',
  'doc_issue_request',
  'document_distribution',
  'period_reopen',
  'capital_plan',
  'allocation_balance',
  'disbursement_schedule_line',
  'capital_ledger_entry',
  'mne_report',
  'contractor',
  'procurement_plan',
  'procurement_package',
  'procurement_plan_event',
  'criteria_version',
  'contract',
  'contract_revision',
  'boq_item',
  'boq_import',
  'guarantee',
  'permit_dossier',
  'permit',
  'permit_milestone',
  'permit_gate_rule',
  'issue',
  'issue_event',
  'issue_escalation',
  'file_import',
  'file_import_row',
  'file_import_quarantine',
  'file_import_reconciliation_item',
  'treasury_import',
  'treasury_import_row',
  'treasury_transaction',
  'reconciliation_item',
  'contact_consent',
  'quality_rule_version',
  'quality_run',
  'quality_rule_result',
  'land_handover_section',
  'land_parcel',
  'land_deadline',
];

describe('the runtime role cannot delete or truncate the records that are kept for good (retention "permanent")', () => {
  let database: TestDatabase;
  let admin: Client;

  beforeAll(async () => {
    database = await startMigratedTestDatabase(REPO_ROOT, { tempPrefix: 'machvon-pg-keep-' });
    admin = new Client({ connectionString: database.adminUrl });
    await admin.connect();
  }, 180_000);

  afterAll(async () => {
    await admin?.end();
    if (database) await database.stop();
  }, 60_000);

  it.each(KEPT_FOR_GOOD)('%s: machvon_app may neither delete from it nor truncate it', async (table) => {
    const { rows } = await admin.query<{ can_delete: boolean; can_truncate: boolean; exists: boolean }>(
      `select true as exists,
              has_table_privilege('machvon_app', c.oid, 'DELETE') as can_delete,
              has_table_privilege('machvon_app', c.oid, 'TRUNCATE') as can_truncate
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'machvon' and c.relname = $1 and c.relkind = 'r'`,
      [table],
    );
    expect(rows).toEqual([{ exists: true, can_delete: false, can_truncate: false }]);
  });

  it('keeps the other roles of the platform away from deleting them too', async () => {
    const { rows } = await admin.query<{ relname: string; role: string }>(
      `select c.relname, r.rolname as role
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
         cross join (select rolname from pg_roles where rolname in ('machvon_control', 'machvon_reporting', 'machvon_sync', 'machvon_outbox_relay')) r
        where n.nspname = 'machvon' and c.relname = any($1::text[]) and c.relkind = 'r'
          and (has_table_privilege(r.rolname, c.oid, 'DELETE') or has_table_privilege(r.rolname, c.oid, 'TRUNCATE'))`,
      [KEPT_FOR_GOOD],
    );
    expect(rows).toEqual([]);
  });
});
