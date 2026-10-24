import { createHash, randomUUID } from 'node:crypto';
import { DomainError, accept, fileSha256, readTabularFile, reject, sourceRowsOfTable } from '@machvon/kernel';
import type { Difference, MetricsSink } from '@machvon/kernel';
import { Client } from 'pg';
import { FILE_IMPORT_COMPLETED_EVENT, FILE_IMPORT_DIFFERENCE_EVENT, FILE_IMPORT_FAILED_EVENT, FileImportStore } from '../src/file-import-store';
import type { FileImportAdapter, ImportEntry, RunFileImportInput } from '../src/file-import-store';
import { DEFAULT_ITEM_DUE_SECONDS, FileImportItemStore } from '../src/file-import-item-store';
import { IntegrationCursorStore } from '../src/integration-cursor-store';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, memberId } from './support/authz-fixtures';

const harness = new AuthzHarness();
const imports = new FileImportStore();
const items = new FileImportItemStore();
const cursors = new IntegrationCursorStore();

const IMPORTER = 1;
const RECON_OFFICER = 2;
const REVOKED = 3;
const NOW = new Date('2026-10-24T03:00:00.000Z');
const CORRELATION = '00000000-0000-4000-8000-0000000000aa';
const CONNECTOR = 'TEST_STATEMENT_FILE';

const inTenant = <T>(work: (tx: TenantTx) => Promise<T>, tenant = TENANT_A, member = IMPORTER): Promise<T> =>
  harness.tenants.withTenant(contextFor(tenant, memberId(member)), work);

class CountingMetrics implements MetricsSink {
  readonly counted: Array<{ name: string; labels: Record<string, string> | undefined }> = [];

  increment(name: string, labels?: Record<string, string>): void {
    this.counted.push({ name, labels });
  }

  gauge(): void {
    // not used by the store
  }
}

interface Statement {
  project: string;
  amount: string;
}

interface AdapterOptions {
  connectorCode?: string;
  /** Business keys whose apply step throws, to prove the whole import rolls back. */
  failApplyFor?: string;
  /** Who owns an AMOUNT_MISMATCH: a member of the tenant, or nobody. */
  mismatchOwner?: string | undefined;
  /** The amounts the module expects per statement; a row that differs is an AMOUNT_MISMATCH. */
  expected?: Record<string, string>;
  dueAfterSeconds?: number;
}

const HEADER = 'statement_no,project_code,amount,account\n';
const amountOf = (n: number): string => String(n * 1000);
const statementNo = (n: number): string => `S${String(n).padStart(3, '0')}`;

/**
 * The reference adapter of these tests, and the shape of the one a module writes (docs/file-import.md): a CSV layout read with
 * the kernel's table reader, rows judged by pure rules, the project checked against what the tenant holds, the row written to the module's
 * table, and the differences it finds reported with an owner.
 */
function statementAdapter(options: AdapterOptions = {}): FileImportAdapter<Statement> {
  return {
    connectorCode: options.connectorCode ?? CONNECTOR,
    formatVersion: '2026.1',
    parse(bytes) {
      const table = readTabularFile(bytes);
      if (!['statement_no', 'project_code', 'amount'].every((header) => table.headers.includes(header))) throw new DomainError('IMPORT_SCHEMA_INVALID', 422, 'file');
      return sourceRowsOfTable(table);
    },
    judge(row) {
      const { statement_no: no = '', project_code: project = '', amount = '' } = row.values;
      if (no === '') return reject('MISSING_STATEMENT_NO', 'statement_no');
      if (project === '') return reject('MISSING_PROJECT_CODE', 'project_code', no);
      return accept({ businessKey: no, fields: { statement_no: no, project_code: project, amount }, record: { project, amount }, measure: amount });
    },
    mask: (values) => ({ statement_no: values.statement_no ?? '', account: `***${(values.account ?? '').slice(-3)}` }),
    async examine(tx, entry) {
      const found = await tx.query("select 1 from machvon.zz_import_project where tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid and code = $1", [entry.record.project]);
      return found.length === 0 ? { code: 'UNKNOWN_PROJECT', field: 'project_code' } : undefined;
    },
    async apply(tx, entry: ImportEntry<Statement>, context) {
      if (entry.businessKey === options.failApplyFor) throw new Error('the module could not write the row');
      expect(context).toMatchObject({ businessKey: entry.businessKey, line: entry.line, rowHash: entry.rowHash });
      await tx.query(
        "insert into machvon.zz_import_target (tenant_id, business_key, project_code, amount, import_id) values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1, $2, $3::numeric, $4::uuid)",
        [entry.businessKey, entry.record.project, entry.record.amount, context.importId],
      );
      const expected = options.expected?.[entry.businessKey];
      if (expected === undefined || expected === entry.record.amount) return [];
      const difference: Difference = { code: 'AMOUNT_MISMATCH', expected, actual: entry.record.amount, ...(options.dueAfterSeconds === undefined ? {} : { dueAfterSeconds: options.dueAfterSeconds }) };
      return [difference];
    },
    async ownerFor(_tx, subject) {
      return subject.code === 'AMOUNT_MISMATCH' ? options.mismatchOwner : undefined;
    },
  };
}

/** The CSV of rows 1..count; `missing` rows have no project code. Its line count is `count + 1` (the header is line 1). */
function statementFile(rows: ReadonlyArray<{ n: number; project?: string; amount?: string }>): Uint8Array {
  const lines = rows.map((row) => `${statementNo(row.n)},${row.project ?? `P${row.n % 5}`},${row.amount ?? amountOf(row.n)},ACC${String(row.n).padStart(9, '0')}`);
  return Buffer.from(HEADER + lines.join('\n') + '\n', 'utf8');
}

const range = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, index) => from + index);

/** The file of UAT-NFR-OPERABILITY-06: 120 lines with the header, 2 rows without a project code, 1 amount that differs from the request. */
const baseFile = (): Uint8Array =>
  statementFile(range(1, 119).map((n) => ({ n, ...(n === 10 || n === 20 ? { project: '' } : {}) })));

let admin: Client;

async function sql<T extends object = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  return (await admin.query(text, params)).rows as T[];
}

const target = async (tenant = TENANT_A): Promise<number> => Number((await sql<{ n: string }>('select count(*)::text as n from machvon.zz_import_target where tenant_id = $1', [tenant]))[0]?.n);

function runFile(bytes: Uint8Array, adapter = statementAdapter(), overrides: Partial<RunFileImportInput<Statement>> = {}, tenant = TENANT_A) {
  return inTenant(
    (tx) =>
      imports.run(tx, {
        adapter,
        bytes,
        fileObjectKey: `object://imports/${randomUUID()}.csv`,
        importedBy: memberId(IMPORTER),
        fallbackOwnerId: memberId(IMPORTER),
        correlationId: CORRELATION,
        now: NOW,
        ...overrides,
      }),
    tenant,
  );
}

async function refusal(work: Promise<unknown>): Promise<{ code: string; status: number; detail?: string }> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; status?: number; detail?: string };
    return { code: e.code ?? '', status: e.status ?? 0, ...(e.detail === undefined ? {} : { detail: e.detail }) };
  }
  throw new Error('expected a refusal');
}

describe('FileImportStore (idempotent file-import framework, ST-KERNEL-070)', () => {
  beforeAll(async () => {
    await harness.start();
    admin = new Client({ connectionString: harness.database.adminUrl });
    await admin.connect();
    // The module's own tables: what an adapter writes to and reads from. They are not part of the framework.
    await sql(`create table machvon.zz_import_target (tenant_id uuid not null, business_key text not null, project_code text not null, amount numeric not null, import_id uuid not null)`);
    await sql(`create table machvon.zz_import_project (tenant_id uuid not null, code text not null)`);
    await sql('grant select, insert, update, delete on machvon.zz_import_target, machvon.zz_import_project to machvon_app');
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [{ n: 1, path: '/u1/' }]);
      await harness.seedMembership(tenant, IMPORTER, 1);
      await harness.seedMembership(tenant, RECON_OFFICER, 1);
      await harness.seedMembership(tenant, REVOKED, 1, { status: 'Suspended' });
    }
  }, 180_000);

  afterAll(async () => {
    await admin?.end();
    await harness.stop();
  }, 60_000);

  beforeEach(async () => {
    await sql('delete from machvon.file_import_reconciliation_item');
    await sql('delete from machvon.file_import_quarantine');
    await sql('delete from machvon.file_import_row');
    await sql('delete from machvon.file_import');
    await sql('delete from machvon.outbox_event');
    await sql('delete from machvon.integration_cursor');
    await sql('delete from machvon.zz_import_target');
    await sql('delete from machvon.zz_import_project');
    for (const tenant of [TENANT_A, TENANT_B]) {
      for (const code of ['P0', 'P1', 'P2', 'P3', 'P4']) await sql('insert into machvon.zz_import_project (tenant_id, code) values ($1, $2)', [tenant, code]);
    }
  });

  describe('a first import', () => {
    it('loads 117 rows, quarantines 2 with MISSING_PROJECT_CODE and opens 1 AMOUNT_MISMATCH item that has an owner (AC-ST-KERNEL-070-1, UAT-NFR-OPERABILITY-06)', async () => {
      const metrics = new CountingMetrics();
      const adapter = statementAdapter({ expected: { [statementNo(30)]: '31000' }, mismatchOwner: memberId(RECON_OFFICER) });
      const result = await runFile(baseFile(), adapter, { metrics });

      expect(result).toEqual({ outcome: 'APPLIED', importId: expect.any(String), counts: { total: 119, applied: 117, duplicate: 0, conflict: 0, quarantined: 2, differencesOpened: 1 }, errorCode: null });
      expect(await target()).toBe(117);

      // Every refused row has its line, field and reason; the account number is masked and never stored whole.
      const quarantined = await inTenant((tx) => imports.quarantined(tx, result.importId, 50));
      expect(quarantined).toEqual([
        { id: expect.any(String), line: 11, businessKey: statementNo(10), errorCode: 'MISSING_PROJECT_CODE', field: 'project_code', maskedPreview: { statement_no: statementNo(10), account: '***010' } },
        { id: expect.any(String), line: 21, businessKey: statementNo(20), errorCode: 'MISSING_PROJECT_CODE', field: 'project_code', maskedPreview: { statement_no: statementNo(20), account: '***020' } },
      ]);
      expect(JSON.stringify(await sql('select * from machvon.file_import_quarantine'))).not.toContain('ACC000000010');

      // The difference is owned and due.
      const open = await inTenant((tx) => items.list(tx, { limit: 10, after: undefined }));
      expect(open).toHaveLength(1);
      expect(open[0]).toMatchObject({
        importId: result.importId,
        line: 31,
        connectorCode: CONNECTOR,
        businessKey: statementNo(30),
        code: 'AMOUNT_MISMATCH',
        expected: '31000',
        actual: '30000',
        difference: '-1000',
        ownerMembershipId: memberId(RECON_OFFICER),
        dueAt: '2026-10-27T03:00:00.000000Z',
        status: 'OPEN',
        version: 1,
      });
      expect(DEFAULT_ITEM_DUE_SECONDS).toBe(3 * 86_400);

      const record = await inTenant((tx) => imports.find(tx, result.importId));
      expect(record).toMatchObject({
        connectorCode: CONNECTOR,
        formatVersion: '2026.1',
        fileSha256: fileSha256(baseFile()),
        status: 'APPLIED',
        errorCode: null,
        counts: result.counts,
        importedBy: memberId(IMPORTER),
        completedAt: '2026-10-24T03:00:00.000000Z',
      });
      expect(metrics.counted.filter((entry) => entry.name === 'file_import_rows_quarantined_total')).toEqual([
        { name: 'file_import_rows_quarantined_total', labels: { connector: CONNECTOR, reason: 'MISSING_PROJECT_CODE' } },
        { name: 'file_import_rows_quarantined_total', labels: { connector: CONNECTOR, reason: 'MISSING_PROJECT_CODE' } },
      ]);
      expect(metrics.counted.at(-1)).toEqual({ name: 'file_import_finished_total', labels: { connector: CONNECTOR, outcome: 'APPLIED' } });
    });

    it('tells the module, through the outbox, that the import is done and that a difference has an owner', async () => {
      const adapter = statementAdapter({ expected: { [statementNo(30)]: '31000' }, mismatchOwner: memberId(RECON_OFFICER) });
      const result = await runFile(baseFile(), adapter);
      const events = await sql<{ type: string; aggregate_id: string; payload: Record<string, unknown>; event_key: string }>('select type, aggregate_id, payload, event_key from machvon.outbox_event order by type');
      expect(events.map((event) => event.type)).toEqual([FILE_IMPORT_COMPLETED_EVENT, FILE_IMPORT_DIFFERENCE_EVENT]);
      expect(events[0]).toMatchObject({ aggregate_id: result.importId, event_key: `file-import:${result.importId}`, payload: { connector_code: CONNECTOR, rows_total: 119, rows_applied: 117, rows_quarantined: 2, differences_opened: 1 } });
      const [item] = await inTenant((tx) => items.list(tx, { limit: 5, after: undefined }));
      expect(events[1]).toMatchObject({ aggregate_id: item?.id, payload: { import_id: result.importId, code: 'AMOUNT_MISMATCH', owner_membership_id: memberId(RECON_OFFICER), due_at: '2026-10-27T03:00:00.000000Z' } });
      // Nothing of the row (project, amount, account) travels in an event.
      expect(JSON.stringify(events)).not.toMatch(/ACC0|P1/);
    });

    it('gives a difference to the fallback owner when nobody is named or the one named cannot take it', async () => {
      const expected = { [statementNo(30)]: '31000', [statementNo(31)]: '1' };
      await runFile(statementFile(range(30, 31).map((n) => ({ n }))), statementAdapter({ expected, mismatchOwner: memberId(REVOKED) }), { fallbackOwnerId: memberId(RECON_OFFICER) });
      const owners = await sql<{ owner_membership_id: string }>('select owner_membership_id from machvon.file_import_reconciliation_item');
      expect(owners.map((row) => row.owner_membership_id)).toEqual([memberId(RECON_OFFICER), memberId(RECON_OFFICER)]);

      await sql('delete from machvon.file_import_reconciliation_item');
      await sql('delete from machvon.file_import_quarantine');
      await sql('delete from machvon.file_import_row');
      await sql('delete from machvon.file_import');
      await runFile(statementFile([{ n: 30 }]), statementAdapter({ expected, mismatchOwner: undefined }), { fallbackOwnerId: memberId(RECON_OFFICER) });
      expect((await sql<{ owner_membership_id: string }>('select owner_membership_id from machvon.file_import_reconciliation_item'))[0]?.owner_membership_id).toBe(memberId(RECON_OFFICER));
    });

    it('lets a difference and a run set how long the owner has', async () => {
      const expected = { [statementNo(30)]: '1', [statementNo(31)]: '1' };
      await runFile(statementFile([{ n: 30 }]), statementAdapter({ expected, dueAfterSeconds: 3600 }), { dueAfterSeconds: 7200 });
      await runFile(statementFile([{ n: 31 }]), statementAdapter({ expected }), { dueAfterSeconds: 7200 });
      const due = await sql<{ business_key: string; due_at: Date }>('select business_key, due_at from machvon.file_import_reconciliation_item order by business_key');
      expect(due.map((row) => [row.business_key, row.due_at.toISOString()])).toEqual([
        [statementNo(30), '2026-10-24T04:00:00.000Z'],
        [statementNo(31), '2026-10-24T05:00:00.000Z'],
      ]);
    });

    it('quarantines a row that the module refuses after it looked at the tenant data, and does not claim its key', async () => {
      const file = statementFile([{ n: 1, project: 'P1' }, { n: 2, project: 'PX' }]);
      const first = await runFile(file);
      expect(first.counts).toMatchObject({ total: 2, applied: 1, quarantined: 1 });
      const [row] = await inTenant((tx) => imports.quarantined(tx, first.importId, 10));
      expect(row).toMatchObject({ line: 3, businessKey: statementNo(2), errorCode: 'UNKNOWN_PROJECT', field: 'project_code', maskedPreview: { statement_no: statementNo(2) } });
      // The project becomes known; the corrected file takes the row, because the refused key was never claimed.
      await sql("insert into machvon.zz_import_project (tenant_id, code) values ($1, 'PX')", [TENANT_A]);
      const second = await runFile(statementFile([{ n: 1, project: 'P1' }, { n: 2, project: 'PX' }, { n: 3 }]));
      expect(second.counts).toMatchObject({ total: 3, applied: 2, duplicate: 1, quarantined: 0 });
      expect(await target()).toBe(3);
    });

    it('refuses a malformed examine rejection as a defect', async () => {
      const adapter = { ...statementAdapter(), examine: async () => ({ code: 'unknown project', field: 'project_code' }) };
      await expect(runFile(statementFile([{ n: 1 }]), adapter)).rejects.toThrow('malformed rejection');
      expect(await sql('select 1 from machvon.file_import')).toHaveLength(0);
    });

    it('works without a mask, an examine step or an owner hook, and keeps nothing of a refused row then', async () => {
      const bare: FileImportAdapter<Statement> = { ...statementAdapter() };
      delete (bare as { mask?: unknown }).mask;
      delete (bare as { examine?: unknown }).examine;
      delete (bare as { ownerFor?: unknown }).ownerFor;
      const result = await runFile(statementFile([{ n: 1, project: '' }, { n: 2, project: 'PX' }]), bare);
      expect(result.counts).toMatchObject({ applied: 1, quarantined: 1 });
      expect((await inTenant((tx) => imports.quarantined(tx, result.importId, 10)))[0]?.maskedPreview).toBeNull();
    });

    it('quarantines a row whose key or amount the framework cannot store, with the code that says why', async () => {
      const file = statementFile([{ n: 1 }, { n: 2, amount: '12345678901234567890123456' }, { n: 3, amount: 'abc' }]);
      const result = await runFile(file);
      expect(result.counts).toMatchObject({ total: 3, applied: 1, quarantined: 2 });
      const rows = await inTenant((tx) => imports.quarantined(tx, result.importId, 10));
      expect(rows.map((row) => [row.line, row.errorCode, row.field])).toEqual([
        [3, 'MEASURE_INVALID', 'measure'],
        [4, 'MEASURE_INVALID', 'measure'],
      ]);
    });

    it('rolls the whole import back when the module fails to write a row, so the same file can be tried again', async () => {
      const file = statementFile(range(1, 8).map((n) => ({ n })));
      await expect(runFile(file, statementAdapter({ failApplyFor: statementNo(5) }))).rejects.toThrow('could not write');
      expect(await sql('select 1 from machvon.file_import')).toHaveLength(0);
      expect(await sql('select 1 from machvon.file_import_row')).toHaveLength(0);
      expect(await sql('select 1 from machvon.outbox_event')).toHaveLength(0);
      expect(await target()).toBe(0);
      expect((await runFile(file)).outcome).toBe('APPLIED');
      expect(await target()).toBe(8);
    });
  });

  describe('the same file again', () => {
    it('answers ALREADY_IMPORTED with the first import, creates 0 new rows and keeps the certified totals, which leave out the refused rows (AC-ST-KERNEL-070-2, DQ01)', async () => {
      const first = await runFile(baseFile());
      const totalsAfterFirst = await inTenant((tx) => imports.totals(tx, CONNECTOR));
      // 117 accepted rows: the sum of 1000 * n for n = 1..119 without rows 10 and 20.
      const everyRow = (119 * 120) / 2;
      expect(totalsAfterFirst).toEqual({ rows: 117, measure: String((everyRow - 10 - 20) * 1000), openDifferences: 0 });

      const again = await runFile(baseFile());
      expect(again).toEqual({ outcome: 'ALREADY_IMPORTED', importId: first.importId, counts: first.counts, errorCode: null });
      expect(await target()).toBe(117);
      expect(await inTenant((tx) => imports.totals(tx, CONNECTOR))).toEqual(totalsAfterFirst);
      expect(await sql('select 1 from machvon.file_import')).toHaveLength(1);
      expect(await sql('select 1 from machvon.file_import_quarantine')).toHaveLength(2);
      expect(await sql('select 1 from machvon.outbox_event')).toHaveLength(1);
    });

    it('does not add a row twice when another file carries it again, and adds only the new ones (a corrected file adds exactly the 2 fixed rows)', async () => {
      await runFile(baseFile());
      const corrected = statementFile(range(1, 119).map((n) => ({ n })));
      const result = await runFile(corrected);
      expect(result.counts).toEqual({ total: 119, applied: 2, duplicate: 117, conflict: 0, quarantined: 0, differencesOpened: 0 });
      expect(await target()).toBe(119);
      expect((await inTenant((tx) => imports.totals(tx, CONNECTOR))).rows).toBe(119);
      expect((await inTenant((tx) => imports.totals(tx, CONNECTOR, result.importId))).rows).toBe(2);
      expect((await inTenant((tx) => imports.totals(tx, CONNECTOR, result.importId))).measure).toBe(String(10_000 + 20_000));
    });

    it('treats a key that comes twice in one file as a repeat of its first row', async () => {
      const file = Buffer.from(`${HEADER}S1,P1,100,A\nS1,P1,100,A\nS1,P1,999,A\n`, 'utf8');
      const result = await runFile(file);
      expect(result.counts).toMatchObject({ applied: 1, duplicate: 1, conflict: 1, differencesOpened: 1 });
      expect(await target()).toBe(1);
    });

    it('is a file of the connector: the same bytes under another connector are another file', async () => {
      const file = statementFile([{ n: 1 }]);
      expect((await runFile(file)).outcome).toBe('APPLIED');
      expect((await runFile(file, statementAdapter({ connectorCode: 'OTHER_FILE' }))).outcome).toBe('APPLIED');
      expect(await target()).toBe(2);
    });
  });

  describe('a key that comes back with other content', () => {
    it('leaves the original as it is and opens one DUPLICATE_CONFLICT item, which a later conflicting file joins', async () => {
      await runFile(statementFile([{ n: 1, amount: '1000' }]));
      const second = await runFile(statementFile([{ n: 1, amount: '1500' }]));
      expect(second.counts).toEqual({ total: 1, applied: 0, duplicate: 0, conflict: 1, quarantined: 0, differencesOpened: 1 });
      expect((await sql<{ amount: string }>('select amount::text from machvon.zz_import_target'))[0]?.amount).toBe('1000');
      const [item] = await inTenant((tx) => items.list(tx, { limit: 5, after: undefined }));
      expect(item).toMatchObject({ code: 'DUPLICATE_CONFLICT', businessKey: statementNo(1), expected: '1000', actual: '1500', difference: '500', ownerMembershipId: memberId(IMPORTER), importId: second.importId });
      expect(item?.detail).toMatch(/^first applied in import [0-9a-f-]{36} line 2$/);

      const third = await runFile(statementFile([{ n: 1, amount: '1700' }]));
      expect(third.counts).toMatchObject({ conflict: 1, differencesOpened: 0 });
      expect(await sql('select 1 from machvon.file_import_reconciliation_item')).toHaveLength(1);
      // The certified total still counts the original row once.
      expect((await inTenant((tx) => imports.totals(tx, CONNECTOR)))).toEqual({ rows: 1, measure: '1000', openDifferences: 1 });
    });
  });

  describe('imports at the same time', () => {
    it('lets exactly one of two concurrent imports of the same file win: APPLIED once, ALREADY_IMPORTED for the other (AC-ST-KERNEL-070-3, UAT-AC333)', async () => {
      for (let round = 0; round < 5; round += 1) {
        const file = statementFile(range(1, 6).map((n) => ({ n: n + round * 10 })));
        const results = await Promise.all([runFile(file), runFile(file)]);
        expect(results.map((result) => result.outcome).sort()).toEqual(['ALREADY_IMPORTED', 'APPLIED']);
        expect(new Set(results.map((result) => result.importId)).size).toBe(1);
        expect(results.find((result) => result.outcome === 'APPLIED')?.counts.applied).toBe(6);
      }
      expect(await sql('select 1 from machvon.file_import')).toHaveLength(5);
      expect(await target()).toBe(30);
    });

    it('applies each key once when two different files carry the same keys, even in opposite orders', async () => {
      const forward = statementFile(range(1, 40).map((n) => ({ n })));
      const backward = statementFile([...range(1, 40).reverse(), 41].map((n) => ({ n })));
      const [a, b] = await Promise.all([runFile(forward), runFile(backward)]);
      expect(a.counts.applied + b.counts.applied).toBe(41);
      expect(a.counts.duplicate + b.counts.duplicate).toBe(40);
      expect(await target()).toBe(41);
      expect(await sql('select 1 from machvon.file_import_row')).toHaveLength(41);
    });
  });

  describe('a file that cannot be read', () => {
    it('ends FAILED with the reason, writes nothing else, and may be tried again', async () => {
      const metrics = new CountingMetrics();
      const noColumns = Buffer.from('a,b\n1,2\n', 'utf8');
      const failed = await runFile(noColumns, statementAdapter(), { metrics });
      expect(failed).toEqual({ outcome: 'FAILED', importId: expect.any(String), counts: { total: 0, applied: 0, duplicate: 0, conflict: 0, quarantined: 0, differencesOpened: 0 }, errorCode: 'IMPORT_SCHEMA_INVALID' });
      expect(await inTenant((tx) => imports.find(tx, failed.importId))).toMatchObject({ status: 'FAILED', errorCode: 'IMPORT_SCHEMA_INVALID' });
      expect(metrics.counted).toEqual([{ name: 'file_import_finished_total', labels: { connector: CONNECTOR, outcome: 'FAILED' } }]);
      const [event] = await sql<{ type: string; payload: Record<string, unknown> }>('select type, payload from machvon.outbox_event');
      expect(event).toMatchObject({ type: FILE_IMPORT_FAILED_EVENT, payload: { connector_code: CONNECTOR, error_code: 'IMPORT_SCHEMA_INVALID', file_sha256: fileSha256(noColumns) } });

      // The same bytes are a new try, not ALREADY_IMPORTED: a FAILED file was never applied.
      const again = await runFile(noColumns);
      expect(again.outcome).toBe('FAILED');
      expect(again.importId).not.toBe(failed.importId);
      expect(await sql('select 1 from machvon.file_import')).toHaveLength(2);
    });

    it('says IMPORT_EMPTY for a file with only a header and IMPORT_SCHEMA_INVALID for a file over the row limit', async () => {
      expect((await runFile(Buffer.from(HEADER, 'utf8'))).errorCode).toBe('IMPORT_EMPTY');
      const result = await runFile(statementFile(range(1, 5).map((n) => ({ n }))), statementAdapter(), { maxRows: 4 });
      expect(result).toMatchObject({ outcome: 'FAILED', errorCode: 'IMPORT_SCHEMA_INVALID' });
      expect(await target()).toBe(0);
    });
  });

  describe('what the caller must state', () => {
    it('refuses a file whose hash is not the one the upload recorded', async () => {
      const file = statementFile([{ n: 1 }]);
      expect(await refusal(runFile(file, statementAdapter(), { expectedSha256: createHash('sha256').update('other').digest('hex') }))).toEqual({ code: 'HASH_MISMATCH', status: 422, detail: 'file' });
      expect(await refusal(runFile(file, statementAdapter(), { expectedSha256: 'not-a-hash' }))).toMatchObject({ code: 'HASH_MISMATCH' });
      expect((await runFile(file, statementAdapter(), { expectedSha256: fileSha256(file) })).outcome).toBe('APPLIED');
    });

    it('refuses a fallback owner who is not an active member of the tenant, a malformed id and a bad object key or cursor scope', async () => {
      const file = statementFile([{ n: 1 }]);
      expect(await refusal(runFile(file, statementAdapter(), { fallbackOwnerId: memberId(REVOKED) }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'owner_membership_id' });
      expect(await refusal(runFile(file, statementAdapter(), { fallbackOwnerId: randomUUID() }))).toMatchObject({ detail: 'owner_membership_id' });
      expect(await refusal(runFile(file, statementAdapter(), { fallbackOwnerId: 'nobody' }))).toMatchObject({ detail: 'owner_membership_id' });
      expect(await refusal(runFile(file, statementAdapter(), { importedBy: 'nobody' }))).toMatchObject({ detail: 'imported_by' });
      expect(await refusal(runFile(file, statementAdapter(), { fileObjectKey: '  ' }))).toMatchObject({ detail: 'file_object_key' });
      expect(await refusal(runFile(file, statementAdapter(), { fileObjectKey: 'k'.repeat(501) }))).toMatchObject({ detail: 'file_object_key' });
      expect(await refusal(runFile(file, statementAdapter(), { cursorScope: 'bad scope' }))).toMatchObject({ detail: 'cursor_scope' });
      expect(await refusal(runFile(file, statementAdapter(), { dueAfterSeconds: -5 }))).toMatchObject({ detail: 'due_after_seconds' });
      expect(await sql('select 1 from machvon.file_import')).toHaveLength(0);
    });

    it('keeps the people it was given in lower case', async () => {
      const upper = memberId(IMPORTER).toUpperCase();
      const result = await runFile(statementFile([{ n: 1 }]), statementAdapter(), { importedBy: upper, fallbackOwnerId: upper });
      expect((await inTenant((tx) => imports.find(tx, result.importId)))?.importedBy).toBe(memberId(IMPORTER));
    });
  });

  describe('the position of the connector (integration_cursor)', () => {
    const SCOPE = 'DEFAULT';
    const TREASURY = 'TREASURY_STATEMENT_FILE';
    const cursorRow = async () =>
      (await sql<{ status: string; last_file_sha256: string | null; last_error_code: string | null; version: string; last_success_at: Date | null }>(
        'select status, last_file_sha256, last_error_code, version::text, last_success_at from machvon.integration_cursor where connector_code = $1',
        [TREASURY],
      ))[0];

    beforeEach(async () => {
      await inTenant((tx) => cursors.ensureDefaults(tx, memberId(IMPORTER)));
    });

    it('records the last file and the time of success of an ACTIVE connector', async () => {
      const file = statementFile([{ n: 1 }]);
      await runFile(file, statementAdapter({ connectorCode: TREASURY }), { cursorScope: SCOPE });
      const row = await cursorRow();
      expect(row).toMatchObject({ status: 'ACTIVE', last_file_sha256: fileSha256(file), last_error_code: null, version: '2' });
      expect(row?.last_success_at?.toISOString()).toBe(NOW.toISOString());
      // A file taken before changes nothing, not even the version.
      await runFile(file, statementAdapter({ connectorCode: TREASURY }), { cursorScope: SCOPE });
      expect((await cursorRow())?.version).toBe('2');
    });

    it('refuses to take a file while the connector is paused or failed, and writes nothing', async () => {
      await sql("update machvon.integration_cursor set status = 'PAUSED' where connector_code = $1", [TREASURY]);
      expect(await refusal(runFile(statementFile([{ n: 1 }]), statementAdapter({ connectorCode: TREASURY }), { cursorScope: SCOPE }))).toEqual({ code: 'STAGE_TRANSITION_DENIED', status: 409, detail: 'connector' });
      await sql("update machvon.integration_cursor set status = 'FAILED' where connector_code = $1", [TREASURY]);
      expect(await refusal(runFile(statementFile([{ n: 1 }]), statementAdapter({ connectorCode: TREASURY }), { cursorScope: SCOPE }))).toMatchObject({ code: 'STAGE_TRANSITION_DENIED' });
      expect(await sql('select 1 from machvon.file_import')).toHaveLength(0);
    });

    it('marks the connector FAILED when a file cannot be read, until a reset starts it again', async () => {
      const failed = await runFile(Buffer.from('a,b\n1,2\n', 'utf8'), statementAdapter({ connectorCode: TREASURY }), { cursorScope: SCOPE });
      expect(failed.outcome).toBe('FAILED');
      expect(await cursorRow()).toMatchObject({ status: 'FAILED', last_error_code: 'IMPORT_SCHEMA_INVALID', version: '2' });
      expect(await refusal(runFile(statementFile([{ n: 1 }]), statementAdapter({ connectorCode: TREASURY }), { cursorScope: SCOPE }))).toMatchObject({ code: 'STAGE_TRANSITION_DENIED' });

      const position = (await inTenant((tx) => cursors.list(tx, { limit: 10, after: undefined }))).find((row) => row.connectorCode === TREASURY);
      await inTenant((tx) => cursors.reset(tx, position?.id ?? '', position?.version ?? 0, { reason: 'the agency sent a corrected layout', cursor: {} }, memberId(IMPORTER)));
      expect((await runFile(statementFile([{ n: 1 }]), statementAdapter({ connectorCode: TREASURY }), { cursorScope: SCOPE })).outcome).toBe('APPLIED');
    });

    it('leaves a tenant without that position as it was', async () => {
      const result = await runFile(statementFile([{ n: 1 }]), statementAdapter({ connectorCode: TREASURY }), { cursorScope: 'NO_SUCH_SCOPE' });
      expect(result.outcome).toBe('APPLIED');
      expect((await cursorRow())?.version).toBe('1');
      const failed = await runFile(Buffer.from('a,b\n1,2\n', 'utf8'), statementAdapter({ connectorCode: TREASURY }), { cursorScope: 'NO_SUCH_SCOPE' });
      expect(failed.outcome).toBe('FAILED');
      expect((await cursorRow())?.status).toBe('ACTIVE');
    });
  });

  describe('tenants', () => {
    it('keeps the files, rows, refusals and items of one tenant away from another, and lets each tenant take the same file', async () => {
      const adapter = statementAdapter({ expected: { [statementNo(30)]: '1' } });
      const a = await runFile(baseFile(), adapter);
      expect((await runFile(baseFile(), adapter, {}, TENANT_B)).outcome).toBe('APPLIED');
      expect(await target(TENANT_A)).toBe(117);
      expect(await target(TENANT_B)).toBe(117);
      expect(await inTenant((tx) => imports.find(tx, a.importId), TENANT_B)).toBeUndefined();
      expect(await inTenant((tx) => imports.quarantined(tx, a.importId, 10), TENANT_B)).toEqual([]);
      expect(await inTenant((tx) => imports.list(tx, { limit: 10, after: undefined }), TENANT_B)).toHaveLength(1);
      const itemsOfA = await inTenant((tx) => items.list(tx, { limit: 10, after: undefined }));
      expect(await inTenant((tx) => items.find(tx, itemsOfA[0]?.id ?? ''), TENANT_B)).toBeUndefined();
      expect(await refusal(inTenant((tx) => items.resolve(tx, { itemId: itemsOfA[0]?.id ?? '', resolvedBy: memberId(IMPORTER), note: 'a foreign item must not be reachable' }), TENANT_B))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await inTenant((tx) => imports.totals(tx, CONNECTOR), TENANT_B)).toMatchObject({ rows: 117, openDifferences: 1 });
    });
  });

  describe('the reads', () => {
    it('lists the imports of a connector, the newest first, by cursor', async () => {
      const first = await runFile(statementFile([{ n: 1 }]), statementAdapter(), { now: new Date('2026-10-24T01:00:00Z') });
      const second = await runFile(statementFile([{ n: 2 }]), statementAdapter(), { now: new Date('2026-10-24T02:00:00Z') });
      await runFile(statementFile([{ n: 3 }]), statementAdapter({ connectorCode: 'OTHER_FILE' }), { now: new Date('2026-10-24T03:00:00Z') });
      const page = await inTenant((tx) => imports.list(tx, { connectorCode: CONNECTOR, limit: 1, after: undefined }));
      expect(page.map((row) => row.id)).toEqual([second.importId]);
      const next = await inTenant((tx) => imports.list(tx, { connectorCode: CONNECTOR, limit: 5, after: { key: page[0]?.createdAtKey ?? '', id: page[0]?.id ?? '' } }));
      expect(next.map((row) => row.id)).toEqual([first.importId]);
      expect(await inTenant((tx) => imports.list(tx, { limit: 10, after: undefined }))).toHaveLength(3);
      expect(await inTenant((tx) => imports.find(tx, randomUUID()))).toBeUndefined();
      expect(await refusal(inTenant((tx) => imports.find(tx, 'x')))).toMatchObject({ code: 'VALIDATION_FAILED' });
    });

    it('adds a total of nothing as 0 for a connector with no row', async () => {
      expect(await inTenant((tx) => imports.totals(tx, 'NO_SUCH_FILE'))).toEqual({ rows: 0, measure: '0', openDifferences: 0 });
    });

    it('adds the measures exactly, with no float error', async () => {
      const file = Buffer.from(`${HEADER}S1,P1,0.1,A\nS2,P1,0.2,A\nS3,P1,1234567890123456789.123456,A\n`, 'utf8');
      await runFile(file);
      expect((await inTenant((tx) => imports.totals(tx, CONNECTOR))).measure).toBe('1234567890123456789.423456');
    });
  });

  describe('reconciliation items', () => {
    async function openThree(): Promise<string[]> {
      const expected = { [statementNo(1)]: '1', [statementNo(2)]: '1', [statementNo(3)]: '1' };
      await runFile(statementFile([{ n: 1 }]), statementAdapter({ expected, mismatchOwner: memberId(RECON_OFFICER), dueAfterSeconds: 300 }), { now: new Date('2026-10-24T01:00:00Z') });
      await runFile(statementFile([{ n: 2 }]), statementAdapter({ expected, dueAfterSeconds: 100 }), { now: new Date('2026-10-24T01:00:00Z') });
      await runFile(statementFile([{ n: 3 }]), statementAdapter({ expected, mismatchOwner: memberId(RECON_OFFICER), dueAfterSeconds: 900 }), { now: new Date('2026-10-24T01:00:00Z') });
      return (await inTenant((tx) => items.list(tx, { limit: 10, after: undefined }))).map((row) => row.id);
    }

    it('lists the open items by due time, filtered by owner, connector and overdue, and pages by cursor', async () => {
      const ids = await openThree();
      const all = await inTenant((tx) => items.list(tx, { limit: 10, after: undefined }));
      expect(all.map((row) => row.businessKey)).toEqual([statementNo(2), statementNo(1), statementNo(3)]);
      expect((await inTenant((tx) => items.list(tx, { ownerId: memberId(RECON_OFFICER), limit: 10, after: undefined }))).map((row) => row.businessKey)).toEqual([statementNo(1), statementNo(3)]);
      expect((await inTenant((tx) => items.list(tx, { ownerId: memberId(RECON_OFFICER).toUpperCase(), limit: 10, after: undefined }))).length).toBe(2);
      expect(await inTenant((tx) => items.list(tx, { connectorCode: 'OTHER_FILE', limit: 10, after: undefined }))).toEqual([]);
      expect((await inTenant((tx) => items.list(tx, { dueBefore: new Date('2026-10-24T01:06:00Z'), limit: 10, after: undefined }))).map((row) => row.businessKey)).toEqual([statementNo(2), statementNo(1)]);
      const page = await inTenant((tx) => items.list(tx, { limit: 2, after: undefined }));
      const rest = await inTenant((tx) => items.list(tx, { limit: 2, after: { key: page[1]?.dueAtKey ?? '', id: page[1]?.id ?? '' } }));
      expect([...page, ...rest].map((row) => row.id)).toEqual([all[0]?.id, all[1]?.id, all[2]?.id]);
      expect(ids).toHaveLength(3);
    });

    it('closes an item once, with a note and the person who found it out, and answers 409 the second time', async () => {
      const [first] = await openThree();
      expect(await refusal(inTenant((tx) => items.resolve(tx, { itemId: first ?? '', resolvedBy: memberId(RECON_OFFICER), note: 'short' })))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'resolution_note' });
      const closed = await inTenant((tx) => items.resolve(tx, { itemId: first ?? '', resolvedBy: memberId(RECON_OFFICER).toUpperCase(), note: '  The Treasury confirmed the corrected amount.  ' }));
      expect(closed.before.status).toBe('OPEN');
      expect(closed.row).toMatchObject({ status: 'RESOLVED', resolvedBy: memberId(RECON_OFFICER), resolutionNote: 'The Treasury confirmed the corrected amount.', version: 2 });
      expect(closed.row.resolvedAt).not.toBeNull();
      expect(await refusal(inTenant((tx) => items.resolve(tx, { itemId: first ?? '', resolvedBy: memberId(RECON_OFFICER), note: 'closing it a second time here' })))).toEqual({ code: 'STAGE_TRANSITION_DENIED', status: 409 });
      expect(await refusal(inTenant((tx) => items.resolve(tx, { itemId: randomUUID(), resolvedBy: memberId(RECON_OFFICER), note: 'there is no such item at all' })))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await inTenant((tx) => items.list(tx, { limit: 10, after: undefined }))).toHaveLength(2);
      expect(await inTenant((tx) => items.list(tx, { status: 'RESOLVED', limit: 10, after: undefined }))).toHaveLength(1);
    });

    it('opens a new item when the same kind of conflict comes back after the earlier item was resolved', async () => {
      await runFile(statementFile([{ n: 1, amount: '1000' }]));
      await runFile(statementFile([{ n: 1, amount: '1500' }]));
      const [earlier] = await inTenant((tx) => items.list(tx, { limit: 10, after: undefined }));
      await inTenant((tx) => items.resolve(tx, { itemId: earlier?.id ?? '', resolvedBy: memberId(IMPORTER), note: 'settled with the Treasury office' }));
      const third = await runFile(statementFile([{ n: 1, amount: '1700' }]));
      expect(third.counts).toMatchObject({ conflict: 1, differencesOpened: 1 });
      expect(await sql('select 1 from machvon.file_import_reconciliation_item')).toHaveLength(2);
      expect(await sql("select 1 from machvon.file_import_reconciliation_item where status = 'OPEN'")).toHaveLength(1);
    });

    it('hands an open item to another active member, with the version check, and keeps its due time', async () => {
      const [first] = await openThree();
      const before = await inTenant((tx) => items.find(tx, first ?? ''));
      expect(await refusal(inTenant((tx) => items.reassign(tx, { itemId: first ?? '', ownerId: memberId(RECON_OFFICER), expectedVersion: 7 })))).toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
      expect(await refusal(inTenant((tx) => items.reassign(tx, { itemId: first ?? '', ownerId: memberId(REVOKED), expectedVersion: 1 })))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'owner_membership_id' });
      expect(await refusal(inTenant((tx) => items.reassign(tx, { itemId: first ?? '', ownerId: randomUUID(), expectedVersion: 1 })))).toMatchObject({ detail: 'owner_membership_id' });
      const moved = await inTenant((tx) => items.reassign(tx, { itemId: first ?? '', ownerId: memberId(RECON_OFFICER).toUpperCase(), expectedVersion: 1 }));
      expect(moved.row).toMatchObject({ ownerMembershipId: memberId(RECON_OFFICER), version: 2, dueAt: before?.dueAt });
      expect(moved.before.ownerMembershipId).toBe(before?.ownerMembershipId);
      expect(await refusal(inTenant((tx) => items.reassign(tx, { itemId: randomUUID(), ownerId: memberId(RECON_OFFICER), expectedVersion: 1 })))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      await inTenant((tx) => items.resolve(tx, { itemId: first ?? '', resolvedBy: memberId(IMPORTER), note: 'closed before a second handover' }));
      expect(await refusal(inTenant((tx) => items.reassign(tx, { itemId: first ?? '', ownerId: memberId(RECON_OFFICER), expectedVersion: 3 })))).toEqual({ code: 'STAGE_TRANSITION_DENIED', status: 409 });
    });
  });

  describe('what the database holds even if a statement goes round the store', () => {
    it('refuses to rewrite a try, a claimed row, a refusal, or what an item says, and to delete any of them', async () => {
      const result = await runFile(baseFile(), statementAdapter({ expected: { [statementNo(30)]: '1' } }));
      const owner = (text: string) => harness.owner(TENANT_A, [[text, []]]);
      await expect(owner(`update machvon.file_import set file_sha256 = repeat('a', 64) where id = '${result.importId}'`)).rejects.toThrow('keeps its identity');
      await expect(owner(`update machvon.file_import set rows_total = 1 where id = '${result.importId}'`)).rejects.toThrow('finished file import');
      await expect(owner("update machvon.file_import_reconciliation_item set code = 'OTHER'")).rejects.toThrow('keeps what it says');
      await expect(owner('update machvon.file_import_reconciliation_item set due_at = due_at + interval \'1 day\'')).rejects.toThrow('keeps what it says');
      await expect(owner('update machvon.file_import_reconciliation_item set owner_membership_id = owner_membership_id')).rejects.toThrow('grows by one');
      await expect(owner('update machvon.file_import_reconciliation_item set owner_membership_id = owner_membership_id, version = version + 5')).rejects.toThrow('grows by one');
      await expect(owner(`update machvon.file_import_reconciliation_item set owner_membership_id = '${randomUUID()}', version = version + 1`)).rejects.toThrow('foreign key');
      await expect(owner("update machvon.file_import_reconciliation_item set status = 'RESOLVED', version = version + 1")).rejects.toThrow('resolved_chk');
      for (const table of ['file_import', 'file_import_row', 'file_import_quarantine', 'file_import_reconciliation_item']) {
        await expect(inTenant((tx) => tx.query(`delete from machvon.${table}`))).rejects.toThrow('permission denied');
        await expect(inTenant((tx) => tx.query(`truncate machvon.${table} cascade`))).rejects.toThrow('permission denied');
      }
      for (const table of ['file_import_row', 'file_import_quarantine']) await expect(inTenant((tx) => tx.query(`update machvon.${table} set row_hash = row_hash`))).rejects.toThrow('permission denied');
      // A resolved item cannot be reopened or rewritten.
      const [item] = await inTenant((tx) => items.list(tx, { limit: 1, after: undefined }));
      await inTenant((tx) => items.resolve(tx, { itemId: item?.id ?? '', resolvedBy: memberId(IMPORTER), note: 'resolved for the guard test' }));
      await expect(owner("update machvon.file_import_reconciliation_item set status = 'OPEN', version = version + 1")).rejects.toThrow('resolved reconciliation item');
    });

    it('lets only one business key per connector exist, and one open item per key and kind', async () => {
      await runFile(statementFile([{ n: 1 }]));
      const owner = harness.owner.bind(harness, TENANT_A);
      const [row] = await sql<{ first_import_id: string }>('select first_import_id from machvon.file_import_row');
      await expect(
        owner([[`insert into machvon.file_import_row (tenant_id, connector_code, business_key, row_hash, first_import_id, first_line) values ('${TENANT_A}', '${CONNECTOR}', '${statementNo(1)}', repeat('b', 64), '${row?.first_import_id}', 9)`]]),
      ).rejects.toThrow('file_import_row_key_uq');
      await expect(owner([[`insert into machvon.file_import (tenant_id, connector_code, format_version, file_sha256, file_object_key, imported_by) select tenant_id, connector_code, format_version, file_sha256, 'k', imported_by from machvon.file_import`]])).rejects.toThrow('file_import_file_uq');
    });
  });
});
