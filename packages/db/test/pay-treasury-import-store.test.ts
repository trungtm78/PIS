import { randomUUID } from 'node:crypto';
import { fileSha256, planFileImport } from '@machvon/kernel';
import type { MetricsSink } from '@machvon/kernel';
import { IntegrationCursorStore } from '../src/integration-cursor-store';
import { PayTreasuryImportStore, TREASURY_IMPORT_ROWS_METRIC } from '../src/pay-treasury-import-store';
import { createTreasuryStatementAdapter } from '../src/pay-treasury-statement-adapter';
import { createTreasuryStatementFormat } from '../src/pay-treasury-statement-format';
import type { TreasuryImportResult } from '../src/pay-treasury-import-store';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, memberId } from './support/authz-fixtures';
import { seedCrosswalk, seedPayWorld } from './support/pay-fixtures';
import type { PayWorld } from './support/pay-fixtures';

const harness = new AuthzHarness();
const store = new PayTreasuryImportStore();
const cursors = new IntegrationCursorStore();

const IMPORTER = 1;
const NOW = new Date('2026-10-24T03:00:00.000Z');
const CORRELATION = '00000000-0000-4000-8000-0000000000aa';
const FAMILY = 0x91;
/** A tenant that has nothing: no projects, no connector. */
const TENANT_C = '00000000-0000-4000-8000-00000000000c';
const HEADER = 'document_no,document_date,project_code,treasury_office_code,amount_vnd,confirmed_at,payee_account';
const ACCOUNT = '0123456789012';

let worlds: Record<string, PayWorld>;

class CountingMetrics implements MetricsSink {
  readonly counted: Array<{ name: string; labels: Record<string, string> | undefined }> = [];

  increment(name: string, labels?: Record<string, string>): void {
    this.counted.push({ name, labels });
  }

  gauge(): void {
    // not used by the store
  }

  of(outcome: string): number {
    return this.counted.filter((entry) => entry.name === TREASURY_IMPORT_ROWS_METRIC && entry.labels?.outcome === outcome).length;
  }
}

const as = <T>(work: (tx: TenantTx) => Promise<T>, tenant = TENANT_A): Promise<T> => harness.tenants.withTenant(contextFor(tenant, memberId(IMPORTER)), work);
const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);
const count = async (sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<number> => Number((await owner<{ n: string }>(sql, params, tenant))[0]?.n);

const csv = (...lines: string[]): Buffer => Buffer.from([HEADER, ...lines].join('\n'), 'utf8');
const line = (no: string, amount: string | number, options: { project?: string; office?: string; account?: string; date?: string } = {}): string =>
  `${no},${options.date ?? '2026-10-15'},${options.project ?? worlds.A?.projectCodeA},${options.office ?? 'KB-1'},${amount},2026-10-16,${options.account ?? ACCOUNT}`;

function runImport(bytes: Buffer, extra: Partial<Parameters<PayTreasuryImportStore['import']>[1]> = {}, tenant = TENANT_A): Promise<TreasuryImportResult> {
  return as(
    (tx) =>
      store.import(tx, {
        bytes,
        fileObjectKey: `tenants/${tenant}/import/${randomUUID()}`,
        expectedSha256: fileSha256(bytes),
        sourceKind: 'STATEMENT_FILE',
        importedBy: memberId(IMPORTER),
        correlationId: CORRELATION,
        now: NOW,
        ...extra,
      }),
    tenant,
  );
}

async function refusal(work: Promise<unknown>): Promise<{ code: string; status: number }> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; status?: number };
    return { code: e.code ?? '', status: e.status ?? 0 };
  }
  throw new Error('expected a refusal');
}

const transactionsOf = (prefix: string): Promise<Array<{ id: string; external_id: string; amount_vnd: string; source_kind: string; match_status: string; import_id: string; row_hash: string }>> =>
  owner("select id, external_id, amount_vnd::text as amount_vnd, source_kind, match_status, import_id, row_hash from machvon.treasury_transaction where external_id like $1 order by external_id", [`KBNN_FILE|${prefix}%`]);

describe('PayTreasuryImportStore (the Treasury statement file import, ST-PAY-006)', () => {
  beforeAll(async () => {
    await harness.start();
    worlds = {};
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: 1, path: '/u1/' },
        { n: 2, path: '/u2/' },
      ]);
      await harness.seedMembership(tenant, IMPORTER, 1);
      worlds[tenant === TENANT_A ? 'A' : 'B'] = await seedPayWorld(harness.database.adminUrl, tenant, FAMILY, IMPORTER, 1, 2);
    }
  }, 180_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  describe('the same file twice (AC-ST-PAY-006-1)', () => {
    it('answers ALREADY_IMPORTED with the first import and creates nothing, so the totals do not add duplicates (AC-ST-PAY-006-1)', async () => {
      const bytes = csv(line('R1-A', 1000), line('R1-B', 2000), line('R1-C', 3000));
      const before = await as((tx) => store.totals(tx));
      const first = await runImport(bytes);
      expect(first).toMatchObject({ outcome: 'APPLIED', counts: { total: 3, new: 3, duplicate: 0, conflict: 0, error: 0 }, appliedAmountVnd: '6000', differencesOpened: 0 });
      const afterFirst = await as((tx) => store.totals(tx));
      expect(afterFirst).toMatchObject({ rows: before.rows + 3, amountVnd: String(Number(before.amountVnd) + 6000) });

      const again = await runImport(bytes);
      expect(again).toMatchObject({ outcome: 'ALREADY_IMPORTED', importId: first.importId, fileSha256: first.fileSha256, counts: first.counts, differencesOpened: 0, appliedAmountVnd: '0' });
      expect(await as((tx) => store.totals(tx))).toEqual(afterFirst);
      expect((await transactionsOf('R1-')).length).toBe(3);
      expect(await count('select count(*)::text as n from machvon.treasury_import where file_sha256 = $1', [first.fileSha256])).toBe(1);
      expect(await count('select count(*)::text as n from machvon.file_import where file_sha256 = $1', [first.fileSha256])).toBe(1);
      expect(await count('select count(*)::text as n from machvon.treasury_import_row where import_id = $1', [first.importId])).toBe(3);
    });

    it('applies the file exactly once when it arrives twice at the same moment (AC-ST-PAY-006-1)', async () => {
      const bytes = csv(line('R1X-A', 1500), line('R1X-B', 2500));
      const results = await Promise.all([runImport(bytes), runImport(bytes)]);
      expect(results.map((result) => result.outcome).sort()).toEqual(['ALREADY_IMPORTED', 'APPLIED']);
      expect(results[0]?.importId).toBe(results[1]?.importId);
      expect((await transactionsOf('R1X-')).length).toBe(2);
      expect(await count('select count(*)::text as n from machvon.treasury_import where file_sha256 = $1', [fileSha256(bytes)])).toBe(1);
      expect(await count('select count(*)::text as n from machvon.treasury_import_row where import_id = $1', [results[0]?.importId])).toBe(2);
    });

    it('lets the same file be taken by another tenant: the identity of a file is per tenant', async () => {
      const bytes = csv(line('R1T-A', 1000, { project: worlds.B?.projectCodeA }));
      expect((await runImport(bytes, {}, TENANT_B)).outcome).toBe('APPLIED');
      expect((await runImport(bytes, {}, TENANT_B)).outcome).toBe('ALREADY_IMPORTED');
      expect(await count("select count(*)::text as n from machvon.treasury_transaction where external_id like 'KBNN_FILE|R1T-%'")).toBe(0);
    });
  });

  describe('the rows of a file (AC-ST-PAY-006-2)', () => {
    it('creates the new rows, skips the repeat, leaves the original of a conflict and opens an item, and quarantines the malformed row (AC-ST-PAY-006-2)', async () => {
      const metrics = new CountingMetrics();
      await runImport(csv(line('R2-DUP', 1000), line('R2-CON', 2000)));
      const original = (await transactionsOf('R2-CON'))[0];
      expect(original).toBeDefined();

      const second = csv(
        line('R2-N1', 3000),
        line('R2-N2', 4000),
        line('R2-N3', 5000),
        line('R2-DUP', 1000),
        line('R2-CON', 2500),
        line('R2-BAD', '12x', { account: ACCOUNT }),
      );
      const totalsBefore = await as((tx) => store.totals(tx));
      const result = await runImport(second, { metrics });
      expect(result).toMatchObject({ outcome: 'PARTIALLY_APPLIED', counts: { total: 6, new: 3, duplicate: 1, conflict: 1, error: 1 }, differencesOpened: 1, appliedAmountVnd: '12000' });
      expect([metrics.of('NEW'), metrics.of('DUPLICATE'), metrics.of('CONFLICT'), metrics.of('ERROR')]).toEqual([3, 1, 1, 1]);

      // New rows: transactions of the source FILE_IMPORT, waiting for the match.
      const created = await transactionsOf('R2-N');
      expect(created.map((row) => [row.external_id, row.amount_vnd, row.source_kind, row.match_status, row.import_id])).toEqual([
        ['KBNN_FILE|R2-N1|2026-10-15|' + worlds.A?.projectCodeA, '3000', 'FILE_IMPORT', 'UNMATCHED', result.importId],
        ['KBNN_FILE|R2-N2|2026-10-15|' + worlds.A?.projectCodeA, '4000', 'FILE_IMPORT', 'UNMATCHED', result.importId],
        ['KBNN_FILE|R2-N3|2026-10-15|' + worlds.A?.projectCodeA, '5000', 'FILE_IMPORT', 'UNMATCHED', result.importId],
      ]);
      // The duplicate added nothing; the original of the conflict is exactly as it was.
      expect((await transactionsOf('R2-DUP')).length).toBe(1);
      expect(await transactionsOf('R2-CON')).toEqual([original]);
      expect(await as((tx) => store.totals(tx))).toMatchObject({ rows: totalsBefore.rows + 3, amountVnd: String(Number(totalsBefore.amountVnd) + 12000) });

      // The conflict is an item of the PAY register with both figures, an owner and a due time, and the same item exists in the core.
      const [item] = await owner<{ kind: string; internal: string; confirmed: string; difference: string; owner: string; due_at: Date; status: string; tx: string; row_outcome: string; project_id: string }>(
        `select i.kind, i.internal_amount_vnd::text as internal, i.confirmed_amount_vnd::text as confirmed, i.difference_vnd::text as difference, i.owner_membership_id as owner, i.due_at, i.status,
                i.treasury_transaction_id as tx, r.outcome as row_outcome, i.project_id
           from machvon.reconciliation_item i join machvon.treasury_import_row r on r.id = i.import_row_id where r.import_id = $1`,
        [result.importId],
      );
      expect(item).toMatchObject({ kind: 'DUPLICATE_CONFLICT', internal: '2000', confirmed: '2500', difference: '500', owner: memberId(IMPORTER), status: 'OPEN', tx: original?.id, row_outcome: 'CONFLICT', project_id: worlds.A?.projectA });
      expect(item?.due_at.toISOString()).toBe(new Date(NOW.getTime() + 259_200_000).toISOString());
      expect(await count("select count(*)::text as n from machvon.file_import_reconciliation_item where import_id = $1 and code = 'DUPLICATE_CONFLICT' and status = 'OPEN'", [result.importId])).toBe(1);

      // The malformed row is in the quarantine with its code and field, and nothing shows the account number.
      const quarantine = await owner<{ line: number; error_code: string; field: string; masked_preview: Record<string, string> }>(
        'select line, error_code, field, masked_preview from machvon.file_import_quarantine where import_id = $1',
        [result.importId],
      );
      expect(quarantine).toEqual([{ line: 7, error_code: 'AMOUNT_INVALID', field: 'amount_vnd', masked_preview: expect.objectContaining({ document_no: 'R2-BAD', amount_vnd: '12x', payee_account: '***012' }) }]);
      const lines = await as((tx) => store.rows(tx, result.importId));
      expect(lines.truncated).toBe(false);
      expect(lines.rows.map((row) => [row.rowNo, row.outcome, row.errorCode])).toEqual([
        [2, 'NEW', null],
        [3, 'NEW', null],
        [4, 'NEW', null],
        [5, 'DUPLICATE', null],
        [6, 'CONFLICT', null],
        [7, 'ERROR', 'AMOUNT_INVALID'],
      ]);
      expect(lines.rows.find((row) => row.outcome === 'DUPLICATE')?.treasuryTransactionId).toBe((await transactionsOf('R2-DUP'))[0]?.id);
      expect(lines.rows.find((row) => row.outcome === 'ERROR')?.treasuryTransactionId).toBeNull();
      expect(JSON.stringify(lines.rows)).not.toContain(ACCOUNT);
      expect(JSON.stringify(await owner('select raw_masked from machvon.treasury_import_row where import_id = $1', [result.importId]))).not.toContain(ACCOUNT);

      const items = await as((tx) => store.items(tx, result.importId));
      expect(items).toEqual([expect.objectContaining({ code: 'DUPLICATE_CONFLICT', businessKey: 'KBNN_FILE|R2-CON|2026-10-15|' + worlds.A?.projectCodeA, expected: '2000', actual: '2500', difference: '500', ownerMembershipId: memberId(IMPORTER), status: 'OPEN' })]);
      expect(await as((tx) => store.find(tx, result.importId))).toMatchObject({
        id: result.importId,
        provider: 'KBNN_FILE',
        sourceKind: 'STATEMENT_FILE',
        status: 'PARTIALLY_APPLIED',
        counts: { total: 6, new: 3, duplicate: 1, conflict: 1, error: 1 },
        importedBy: memberId(IMPORTER),
        fileSha256: fileSha256(second),
        fileName: `statement-${fileSha256(second).slice(0, 12)}`,
      });
    });

    it('opens one item per transaction while it is open: a second file that contradicts the same original joins it (AC-ST-PAY-006-2)', async () => {
      await runImport(csv(line('R2J-A', 1000)));
      await runImport(csv(line('R2J-A', 1100)));
      await runImport(csv(line('R2J-A', 1200)));
      expect(await count("select count(*)::text as n from machvon.reconciliation_item i join machvon.treasury_transaction t on t.id = i.treasury_transaction_id where t.external_id like 'KBNN_FILE|R2J-A%'")).toBe(1);
      expect((await transactionsOf('R2J-A'))[0]?.amount_vnd).toBe('1000');
    });

    it('judges a key that comes twice in one file: the same content repeats, other content conflicts (AC-ST-PAY-006-2)', async () => {
      const result = await runImport(csv(line('R2I-A', 1000), line('R2I-A', 1000), line('R2I-B', 2000), line('R2I-B', 2222)));
      expect(result.counts).toEqual({ total: 4, new: 2, duplicate: 1, conflict: 1, error: 0 });
      const lines = await as((tx) => store.rows(tx, result.importId));
      expect(lines.rows.map((row) => [row.rowNo, row.outcome])).toEqual([
        [2, 'NEW'],
        [3, 'DUPLICATE'],
        [4, 'NEW'],
        [5, 'CONFLICT'],
      ]);
    });

    it('is APPLIED, not partial, when every row is read and none contradicts the register (AC-ST-PAY-006-2)', async () => {
      const result = await runImport(csv(line('R2C-A', 1000), line('R2C-B', 2000)));
      expect(result.outcome).toBe('APPLIED');
      expect(await as((tx) => store.find(tx, result.importId))).toMatchObject({ status: 'APPLIED' });
    });
  });

  describe('the codes of the Treasury and the projects (crosswalk TREASURY/AGENCY_CODE)', () => {
    it('quarantines a code without a mapping as CROSSWALK_MISSING, creates no master entry, and a later file with the mapping takes the row', async () => {
      const masters = await count("select count(*)::text as n from machvon.master_record where master_type = 'TREASURY_OFFICE'");
      const first = await runImport(csv(line('X-UNM', 7000, { office: 'KB-NEW' }), line('X-OK', 1000)));
      expect(first.counts).toEqual({ total: 2, new: 1, duplicate: 0, conflict: 0, error: 1 });
      expect(await transactionsOf('X-UNM')).toEqual([]);
      expect(await count("select count(*)::text as n from machvon.master_record where master_type = 'TREASURY_OFFICE'")).toBe(masters);
      const [refused] = await owner<{ error_code: string; field: string; business_key: string }>('select error_code, field, business_key from machvon.file_import_quarantine where import_id = $1', [first.importId]);
      expect(refused).toEqual({ error_code: 'CROSSWALK_MISSING', field: 'treasury_office_code', business_key: `KBNN_FILE|X-UNM|2026-10-15|${worlds.A?.projectCodeA}` });
      // Somebody owns the gap: an open item with the code and what is missing, due in three days.
      expect(first.differencesOpened).toBe(1);
      const items = await as((tx) => store.items(tx, first.importId));
      expect(items).toEqual([expect.objectContaining({ code: 'CROSSWALK_MISSING', businessKey: refused?.business_key, ownerMembershipId: memberId(IMPORTER), status: 'OPEN' })]);
      expect(await count("select count(*)::text as n from machvon.file_import_reconciliation_item where import_id = $1 and detail = 'treasury_office_code KB-NEW'", [first.importId])).toBe(1);
      expect(await count("select count(*)::text as n from machvon.outbox_event where type = 'file_import.difference_opened' and payload->>'import_id' = $1", [first.importId])).toBe(1);

      // The row was not claimed: once the mapping exists a corrected file takes it.
      await seedCrosswalk(harness.database.adminUrl, TENANT_A, IMPORTER, worlds.A?.office ?? '', 'KB-NEW');
      const second = await runImport(csv(line('X-UNM', 7000, { office: 'KB-NEW' }), line('X-OK2', 1000)));
      expect(second.counts).toEqual({ total: 2, new: 2, duplicate: 0, conflict: 0, error: 0 });
      const [taken] = await transactionsOf('X-UNM');
      expect(taken).toMatchObject({ amount_vnd: '7000', source_kind: 'FILE_IMPORT' });
      expect(await count('select count(*)::text as n from machvon.treasury_transaction where id = $1 and treasury_office_record_id = $2', [taken?.id, worlds.A?.office])).toBe(1);
    });

    it('reads the mapping in force on the date of the voucher: a mapping that starts later does not translate an earlier voucher', async () => {
      await seedCrosswalk(harness.database.adminUrl, TENANT_A, IMPORTER, worlds.A?.office ?? '', 'KB-LATE', '2026-12-01');
      const result = await runImport(csv(line('X-LATE', 100, { office: 'KB-LATE' })));
      expect(result.counts.error).toBe(1);
      expect((await as((tx) => store.rows(tx, result.importId))).rows[0]).toMatchObject({ outcome: 'ERROR', errorCode: 'CROSSWALK_MISSING' });
    });

    it('quarantines a code that was mapped to an entry of another kind as CROSSWALK_TARGET_INVALID', async () => {
      const result = await runImport(csv(line('X-SEC', 100, { office: 'KB-SECTOR' })));
      expect((await as((tx) => store.rows(tx, result.importId))).rows[0]).toMatchObject({ outcome: 'ERROR', errorCode: 'CROSSWALK_TARGET_INVALID' });
      expect(await transactionsOf('X-SEC')).toEqual([]);
    });

    it('quarantines a row of a project the tenant does not hold as PROJECT_NOT_FOUND, and never reads the project of another tenant', async () => {
      const result = await runImport(csv(line('X-PRJ', 100, { project: 'NO-SUCH' }), line('X-FOR', 100, { project: worlds.B?.projectCodeA })));
      const lines = await as((tx) => store.rows(tx, result.importId));
      expect(lines.rows.map((row) => [row.outcome, row.errorCode])).toEqual([['ERROR', 'PROJECT_NOT_FOUND'], ['ERROR', 'PROJECT_NOT_FOUND']]);
      expect(result.differencesOpened).toBe(2);
    });

    it('keeps the ordering of the master data: a quarantined row never enters the total', async () => {
      const before = await as((tx) => store.totals(tx));
      await runImport(csv(line('X-TOT-A', 900), line('X-TOT-B', 99999, { office: 'KB-NOPE' }), line('X-TOT-C', 'oops')));
      const after = await as((tx) => store.totals(tx));
      expect(after.rows).toBe(before.rows + 1);
      expect(after.amountVnd).toBe(String(Number(before.amountVnd) + 900));
    });
  });

  describe('a repeated file and the total (AC-ST-PAY-006-4)', () => {
    it('does not increase the certified total when the file, or a file with the same keys and contents, is imported again (AC-ST-PAY-006-4)', async () => {
      const original = csv(line('R4-A', 10_000), line('R4-B', 20_000), line('R4-C', 30_000));
      const first = await runImport(original);
      const total = await as((tx) => store.totals(tx));
      const added = await as((tx) => store.totals(tx, first.importId));
      expect(added).toMatchObject({ rows: 3, amountVnd: '60000' });
      // The same bytes: nothing.
      expect((await runImport(original)).outcome).toBe('ALREADY_IMPORTED');
      expect(await as((tx) => store.totals(tx))).toEqual(total);
      // Another file (an extra blank-looking header spelling) with the same rows: every row is a repeat, so the total does not move.
      const respelled = Buffer.from(`${HEADER.toUpperCase()}\n${[line('R4-A', '10.000'), line('R4-B', '20 000'), line('R4-C', '30000')].join('\n')}\n`, 'utf8');
      const repeat = await runImport(respelled);
      expect(repeat.counts).toEqual({ total: 3, new: 0, duplicate: 3, conflict: 0, error: 0 });
      expect(repeat.appliedAmountVnd).toBe('0');
      expect(await as((tx) => store.totals(tx))).toEqual(total);
      // A row that contradicts one of them does not change it either.
      const contradiction = await runImport(csv(line('R4-A', 10_001)));
      expect(contradiction.counts.conflict).toBe(1);
      expect((await as((tx) => store.totals(tx))).amountVnd).toBe(total.amountVnd);
    });
  });

  describe('a file that cannot be taken', () => {
    it.each([
      ['a required column is missing', 'document_no,document_date,project_code,amount_vnd,confirmed_at\nCT-1,2026-10-15,PRJ,1000,2026-10-16\n'],
      ['it has a header and no row', `${HEADER}\n`],
    ])('is refused as TREASURY_IMPORT_SCHEMA_INVALID when %s, and nothing of the try is kept', async (_name, content) => {
      const bytes = Buffer.from(content, 'utf8');
      const files = await count('select count(*)::text as n from machvon.file_import');
      expect(await refusal(runImport(bytes))).toEqual({ code: 'TREASURY_IMPORT_SCHEMA_INVALID', status: 422 });
      expect(await count('select count(*)::text as n from machvon.file_import')).toBe(files);
      expect(await count("select count(*)::text as n from machvon.integration_cursor where connector_code = 'TREASURY_STATEMENT_FILE' and status <> 'ACTIVE'")).toBe(0);
    });

    it('is refused as HASH_MISMATCH before anything is written when the stored bytes are not the ones the upload hashed', async () => {
      const files = await count('select count(*)::text as n from machvon.file_import');
      expect(await refusal(runImport(csv(line('H-1', 1)), { expectedSha256: 'f'.repeat(64) }))).toEqual({ code: 'HASH_MISMATCH', status: 422 });
      expect(await count('select count(*)::text as n from machvon.file_import')).toBe(files);
    });

    it('is refused as STAGE_TRANSITION_DENIED while the connector is paused or failed, and read again once it is active', async () => {
      await owner("update machvon.integration_cursor set status = 'PAUSED' where connector_code = 'TREASURY_STATEMENT_FILE'");
      expect(await refusal(runImport(csv(line('P-1', 1))))).toEqual({ code: 'STAGE_TRANSITION_DENIED', status: 409 });
      await owner("update machvon.integration_cursor set status = 'ACTIVE' where connector_code = 'TREASURY_STATEMENT_FILE'");
      expect((await runImport(csv(line('P-1', 1)))).outcome).toBe('APPLIED');
    });

    it('refuses a membership that is not a person of the tenant', async () => {
      expect(await refusal(runImport(csv(line('M-1', 1)), { importedBy: 'not-a-uuid' }))).toEqual({ code: 'VALIDATION_FAILED', status: 422 });
    });
  });

  describe('the position of the connector', () => {
    it('keeps the last file and its time in integration_cursor TREASURY_STATEMENT_FILE, and the adapter stays PROPOSED', async () => {
      const bytes = csv(line('C-1', 1000));
      const result = await runImport(bytes);
      const connector = await as((tx) => store.connector(tx));
      expect(connector).toMatchObject({ connectorCode: 'TREASURY_STATEMENT_FILE', formatVersion: 'ASSUMED-2026.1', adapterStatus: 'PROPOSED', status: 'ACTIVE', lastErrorCode: null, lastSuccessAt: NOW.toISOString().replace('Z', '000Z') });
      const [cursor] = await owner<{ last_file_sha256: string; adapter_status: string }>("select last_file_sha256, adapter_status from machvon.integration_cursor where connector_code = 'TREASURY_STATEMENT_FILE' and source_scope = 'DEFAULT'");
      expect(cursor).toEqual({ last_file_sha256: result.fileSha256, adapter_status: 'PROPOSED' });
      // The other connectors of the baseline came with it.
      expect(await as((tx) => cursors.list(tx, { limit: 10, after: undefined }))).toHaveLength(4);
    });

    it('shows a connector that does not exist yet as PROPOSED and active, without creating it', async () => {
      expect(await as((tx) => store.connector(tx), TENANT_C)).toEqual({ connectorCode: 'TREASURY_STATEMENT_FILE', formatVersion: 'ASSUMED-2026.1', adapterStatus: 'PROPOSED', status: 'ACTIVE', lastErrorCode: null, lastSuccessAt: null });
    });
  });

  describe('what the database holds for good', () => {
    it('refuses to change what a transaction says, lets the match move it, and keeps a matched one fixed', async () => {
      await runImport(csv(line('G-1', 5000)));
      const [row] = await transactionsOf('G-1');
      const change = (sql: string) => refusal(owner(sql, [row?.id]));
      expect(await change('update machvon.treasury_transaction set amount_vnd = 1 where id = $1')).toMatchObject({ code: '23514' });
      expect(await change('update machvon.treasury_transaction set document_no = \'other\' where id = $1')).toMatchObject({ code: '23514' });
      expect(await change('update machvon.treasury_transaction set source_kind = \'MANUAL_CONFIRMED\' where id = $1')).toMatchObject({ code: '23514' });
      await owner("update machvon.treasury_transaction set match_status = 'EXCEPTION' where id = $1", [row?.id]);
      expect(await change("update machvon.treasury_transaction set match_status = 'UNMATCHED' where id = $1")).toMatchObject({ code: '23514' });
    });

    it('lets the runtime role neither delete nor update an import and its lines, nor delete a transaction', async () => {
      const result = await runImport(csv(line('G-2', 5000)));
      for (const sql of [
        'delete from machvon.treasury_import',
        "update machvon.treasury_import set status = 'FAILED'",
        'delete from machvon.treasury_import_row',
        'update machvon.treasury_import_row set row_no = row_no',
        'delete from machvon.treasury_transaction',
        'delete from machvon.reconciliation_item',
        'truncate machvon.treasury_transaction',
      ]) {
        expect({ sql, refusal: await refusal(as((tx) => tx.query(sql))) }).toEqual({ sql, refusal: expect.objectContaining({ code: '42501' }) });
      }
      expect(await count('select count(*)::text as n from machvon.treasury_import where id = $1', [result.importId])).toBe(1);
    });

    it('checks that every line and transaction of an import points at a header, when the transaction ends', async () => {
      await expect(
        as((tx) =>
          tx.query(
            `insert into machvon.treasury_transaction (tenant_id, id, project_id, external_id, provider, amount_vnd, confirmed_at, source_hash, import_id, source_kind)
             values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, 'KBNN_FILE|ORPHAN', 'KBNN_FILE', 1, now(), repeat('a', 64), gen_random_uuid(), 'FILE_IMPORT')`,
            [worlds.A?.projectA],
          ),
        ),
      ).rejects.toMatchObject({ code: '23503' });
    });

    it('refuses a transaction whose source does not match its kind', async () => {
      await expect(
        as((tx) =>
          tx.query(
            `insert into machvon.treasury_transaction (tenant_id, id, project_id, external_id, provider, amount_vnd, confirmed_at, source_hash, source_kind)
             values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, 'KBNN_FILE|NOSRC', 'KBNN_FILE', 1, now(), repeat('a', 64), 'FILE_IMPORT')`,
            [worlds.A?.projectA],
          ),
        ),
      ).rejects.toMatchObject({ code: '23514' });
    });
  });

  describe('the adapter on its own', () => {
    const entryOf = (no: string) => {
      const [planned] = planFileImport(createTreasuryStatementFormat(), csv(line(no, 1000))).rows;
      if (planned === undefined || !planned.accepted) throw new Error('the row was not accepted');
      return { line: planned.line, businessKey: planned.row.businessKey, record: planned.row.record, fields: planned.row.fields, measure: planned.row.measure, rowHash: planned.rowHash };
    };
    const context = (entry: ReturnType<typeof entryOf>) => ({ importId: randomUUID(), line: entry.line, businessKey: entry.businessKey, rowHash: entry.rowHash });

    it('refuses to write a row that was not examined first: that is a defect of the caller, not of the file', async () => {
      const adapter = createTreasuryStatementAdapter({ actor: memberId(IMPORTER) });
      const entry = entryOf('AD-1');
      await expect(as((tx) => adapter.apply(tx, entry, context(entry)))).rejects.toThrow('without being examined');
    });

    it('refuses to write a transaction whose key already exists under the provider of the files: the claim of the key is the core\'s, so that is a defect', async () => {
      const entry = entryOf('AD-2');
      await owner(
        `insert into machvon.treasury_transaction (tenant_id, id, project_id, external_id, provider, amount_vnd, confirmed_at, source_hash, source_kind, provider_event_id)
         values ($1, gen_random_uuid(), $2, $3, 'KBNN_FILE', 1, now(), repeat('a', 64), 'CALLBACK_MOCK', 'squatter')`,
        [TENANT_A, worlds.A?.projectA, entry.businessKey],
      );
      const adapter = createTreasuryStatementAdapter({ actor: memberId(IMPORTER) });
      await expect(
        as(async (tx) => {
          expect(await adapter.examine?.(tx, entry)).toBeUndefined();
          return adapter.apply(tx, entry, context(entry));
        }),
      ).rejects.toThrow('already exists');
    });
  });

  describe('reads', () => {
    it('lists the imports of the tenant, the newest first, in pages, and none of another tenant', async () => {
      const made = [];
      for (const n of [1, 2, 3]) made.push(await runImport(csv(line(`LST-${n}`, 100 * n)), { fileName: `list-${n}.csv`, now: new Date(NOW.getTime() + n * 60_000) }));
      const first = await as((tx) => store.list(tx, { limit: 2, after: undefined }));
      expect(first.map((view) => view.id)).toEqual([made[2]?.importId, made[1]?.importId]);
      expect(first[0]).toMatchObject({ fileName: 'list-3.csv', status: 'APPLIED', counts: { total: 1, new: 1 }, importedBy: memberId(IMPORTER) });
      const next = await as((tx) => store.list(tx, { limit: 2, after: { code: first[1]?.importedAtKey ?? '', id: first[1]?.id ?? '' } }));
      expect(next[0]?.id).toBe(made[0]?.importId);
      expect(await as((tx) => store.list(tx, { limit: 50, after: undefined }), TENANT_C)).toEqual([]);
    });

    it('answers nothing for an import of another tenant, and nothing for a malformed id', async () => {
      const result = await runImport(csv(line('Z-1', 1)));
      expect(await as((tx) => store.find(tx, result.importId), TENANT_B)).toBeUndefined();
      expect(await as((tx) => store.rows(tx, result.importId), TENANT_B)).toEqual({ rows: [], truncated: false });
      expect(await as((tx) => store.items(tx, result.importId), TENANT_B)).toEqual([]);
      await expect(as((tx) => store.find(tx, 'not-a-uuid'))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });

    it('shows a page of the lines and says when the file had more', async () => {
      const lines = Array.from({ length: 503 }, (_unused, n) => line(`Z-PAGE-${String(n).padStart(4, '0')}`, 10 + n));
      const result = await runImport(csv(...lines));
      expect(result.counts.new).toBe(503);
      const page = await as((tx) => store.rows(tx, result.importId));
      expect(page.rows).toHaveLength(500);
      expect(page.truncated).toBe(true);
      expect(page.rows[0]?.rowNo).toBe(2);
    });
  });
});
