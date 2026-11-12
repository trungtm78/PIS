import { randomUUID } from 'node:crypto';
import { payModule } from '../../src/modules/pay';
import { TreasuryImportController, TreasuryImportReadsController } from '../../src/modules/pay/treasury-import.controller';
import { eicarBytes } from '../../src/modules/files/mock-scan';
import { TENANT_B, id, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { BRANCH_A, FAMILY, MEMBERS, PayApp, shaOf } from './pay-app';
import type { Reply } from './pay-app';

const HEADER = 'document_no,document_date,project_code,treasury_office_code,amount_vnd,confirmed_at,payee_account';
const ACCOUNT = '0123456789012';
const { IMPORTER, BRANCH_IMPORTER, IMPORT_READER, NOBODY, OTHER_IMPORTER } = MEMBERS;
const pay = new PayApp();

const csv = (...lines: string[]): Uint8Array => new TextEncoder().encode([HEADER, ...lines].join('\n') + '\n');
const line = (no: string, amount: string | number, options: { office?: string; project?: string } = {}): string =>
  `${no},2026-10-15,${options.project ?? pay.worldA.projectCodeA},${options.office ?? 'KB-1'},${amount},2026-10-16,${ACCOUNT}`;

interface ImportBody {
  file_object_id: string;
  file_sha256: string;
  source_kind: string;
  statement_date?: string;
  file_name?: string;
}

async function importFile(bytes: Uint8Array, member: number = IMPORTER, extra: Partial<ImportBody> = {}, key?: string): Promise<Reply> {
  const stored = await pay.store(bytes);
  return pay.call('POST', '/treasury-imports', {
    member,
    ...(key === undefined ? {} : { key }),
    body: { file_object_id: stored.fileObjectId, file_sha256: stored.sha256, source_kind: 'STATEMENT_FILE', ...extra },
  });
}

const importOf = (id: unknown, member: number = IMPORTER, tenantId?: string): Promise<Reply> => pay.call('GET', `/treasury-imports/${String(id)}`, { member, ...(tenantId === undefined ? {} : { tenantId }) });

describe('importTreasuryStatement and getTreasuryImport (ST-PAY-006)', () => {
  beforeAll(async () => {
    await pay.start();
  }, 240_000);

  afterAll(async () => {
    await pay.stop();
  }, 60_000);

  it('is registered in the PAY module with the controllers of the import', () => {
    expect(payModule.code).toBe('PAY');
    expect(payModule.controllers).toEqual(expect.arrayContaining([TreasuryImportController, TreasuryImportReadsController]));
    expect([...pay.app.implementedOperations]).toEqual(expect.arrayContaining(['importTreasuryStatement', 'getTreasuryImport']));
  });

  describe('the same file again (AC-ST-PAY-006-1)', () => {
    it('answers ALREADY_IMPORTED with the first import, creates nothing and does not move the total, also for a call with another key (AC-ST-PAY-006-1)', async () => {
      const bytes = csv(line('A1-1', 1000), line('A1-2', 2000));
      const stored = await pay.store(bytes);
      const body = { file_object_id: stored.fileObjectId, file_sha256: stored.sha256, source_kind: 'STATEMENT_FILE' };
      const first = await pay.call('POST', '/treasury-imports', { member: IMPORTER, body });
      expect(first.status).toBe(200);
      expect(first.json).toMatchObject({ status: 'APPLIED', result: 'APPLIED', resource_version: 1, duplicate: false, row_total: 2, row_new: 2, row_duplicate: 0, row_conflict: 0, row_error: 0, differences_opened: 0 });
      const total = ((await importOf(first.json.resource_id)).json.certified_total as { amount_vnd: string }).amount_vnd;

      const again = await pay.call('POST', '/treasury-imports', { member: IMPORTER, body });
      expect(again.status).toBe(200);
      expect(again.json).toMatchObject({ status: 'ALREADY_IMPORTED', result: 'ALREADY_IMPORTED', resource_id: first.json.resource_id, duplicate: true, row_total: 2, row_new: 2 });
      expect(((await importOf(first.json.resource_id)).json.certified_total as { amount_vnd: string }).amount_vnd).toBe(total);
      expect(await pay.count("select count(*)::text as n from machvon.treasury_transaction where external_id like 'KBNN_FILE|A1-%'")).toBe(2);
      expect(await pay.count('select count(*)::text as n from machvon.treasury_import where file_sha256 = $1', [stored.sha256])).toBe(1);
      expect(await pay.rows('select action from machvon.audit_event where resource_id = $1 order by occurred_at, id', [first.json.resource_id])).toEqual([
        { action: 'pay.treasury_import_applied' },
        { action: 'pay.treasury_import_repeated' },
      ]);
      // The framework tells that the file was read, PAY tells that the import is applied; asking again tells nothing more.
      expect((await pay.rows<{ type: string }>('select type from machvon.outbox_event where aggregate_id = $1 order by type', [first.json.resource_id])).map((event) => event.type)).toEqual(['file_import.completed', 'pay.treasury_import.applied.v1']);
    });

    it('replays the stored answer for the same idempotency key and conflicts for the same key with another request', async () => {
      const bytes = csv(line('A1K-1', 1000));
      const stored = await pay.store(bytes);
      const body = { file_object_id: stored.fileObjectId, file_sha256: stored.sha256, source_kind: 'STATEMENT_FILE' };
      const first = await pay.call('POST', '/treasury-imports', { member: IMPORTER, body, key: 'same-key-for-pay-import' });
      const replay = await pay.call('POST', '/treasury-imports', { member: IMPORTER, body, key: 'same-key-for-pay-import' });
      expect(replay.status).toBe(200);
      expect(replay.json).toEqual(first.json);
      expect(replay.headers.get('idempotency-replayed')).toBe('true');
      const other = await pay.call('POST', '/treasury-imports', { member: IMPORTER, body: { ...body, source_kind: 'EXPORT_FILE' }, key: 'same-key-for-pay-import' });
      expect([other.status, other.json.code]).toEqual([409, 'IDEMPOTENCY_CONFLICT']);
    });

    it('AC-ST-CTR-013-2, UAT-AC397: the import of a file replays with the same key, conflicts with another request, and a new key meets the file already imported without a second effect', async () => {
      const stored = await pay.store(csv(line('A1M-1', 1000), line('A1M-2', 2000)));
      const body = { file_object_id: stored.fileObjectId, file_sha256: stored.sha256, source_kind: 'STATEMENT_FILE' };
      const first = await pay.call('POST', '/treasury-imports', { member: IMPORTER, body, key: 'matrix-import-key' });
      expect(first.json.result).toBe('APPLIED');
      const effects = async () => [
        await pay.count("select count(*)::text as n from machvon.treasury_transaction where external_id like 'KBNN_FILE|A1M-%'"),
        await pay.count('select count(*)::text as n from machvon.treasury_import where file_sha256 = $1', [stored.sha256]),
        await pay.count('select count(*)::text as n from machvon.audit_event where resource_id = $1', [first.json.resource_id]),
        await pay.count('select count(*)::text as n from machvon.outbox_event where aggregate_id = $1', [first.json.resource_id]),
      ];
      const once = await effects();
      expect(once.slice(0, 2)).toEqual([2, 1]);
      const replay = await pay.call('POST', '/treasury-imports', { member: IMPORTER, body, key: 'matrix-import-key' });
      expect(replay.json).toEqual(first.json);
      expect(replay.headers.get('idempotency-replayed')).toBe('true');
      expect(await effects()).toEqual(once);
      const other = await pay.call('POST', '/treasury-imports', { member: IMPORTER, body: { ...body, source_kind: 'EXPORT_FILE' }, key: 'matrix-import-key' });
      expect([other.status, other.json.code]).toEqual([409, 'IDEMPOTENCY_CONFLICT']);
      expect(await effects()).toEqual(once);
      // The file is the identity of the import: a new key finds it already imported and creates no transaction (the one effect it has is the audit row that says the file came again).
      const again = await pay.call('POST', '/treasury-imports', { member: IMPORTER, body });
      expect(again.json).toMatchObject({ result: 'ALREADY_IMPORTED', resource_id: first.json.resource_id });
      const [transactions, imports] = await effects();
      expect([transactions, imports]).toEqual(once.slice(0, 2));
    });

    it('applies the file once when it arrives twice at the same moment (AC-ST-PAY-006-1)', async () => {
      const bytes = csv(line('A1C-1', 1500), line('A1C-2', 2500));
      const stored = await pay.store(bytes);
      const body = { file_object_id: stored.fileObjectId, file_sha256: stored.sha256, source_kind: 'STATEMENT_FILE' };
      const replies = await Promise.all([pay.call('POST', '/treasury-imports', { member: IMPORTER, body }), pay.call('POST', '/treasury-imports', { member: IMPORTER, body })]);
      expect(replies.map((reply) => reply.status)).toEqual([200, 200]);
      expect(replies.map((reply) => reply.json.result).sort()).toEqual(['ALREADY_IMPORTED', 'APPLIED']);
      expect(replies[0]?.json.resource_id).toBe(replies[1]?.json.resource_id);
      expect(await pay.count("select count(*)::text as n from machvon.treasury_transaction where external_id like 'KBNN_FILE|A1C-%'")).toBe(2);
      expect(await pay.count('select count(*)::text as n from machvon.treasury_import where file_sha256 = $1', [stored.sha256])).toBe(1);
    });
  });

  describe('the rows of a file (AC-ST-PAY-006-2, AC-ST-PAY-006-4)', () => {
    it('creates three, skips the repeat, keeps the original of the conflict and opens an item, and quarantines the malformed one, showing no account number (AC-ST-PAY-006-2)', async () => {
      await importFile(csv(line('A2-DUP', 1000), line('A2-CON', 2000)));
      const reply = await importFile(csv(line('A2-N1', 3000), line('A2-N2', 4000), line('A2-N3', 5000), line('A2-DUP', 1000), line('A2-CON', 2500), line('A2-BAD', '12x')));
      expect(reply.json).toMatchObject({ status: 'PARTIALLY_APPLIED', row_total: 6, row_new: 3, row_duplicate: 1, row_conflict: 1, row_error: 1, differences_opened: 1 });
      expect(await pay.count("select count(*)::text as n from machvon.treasury_transaction where external_id like 'KBNN_FILE|A2-N%' and source_kind = 'FILE_IMPORT'")).toBe(3);
      expect((await pay.rows<{ amount: string }>("select amount_vnd::text as amount from machvon.treasury_transaction where external_id like 'KBNN_FILE|A2-CON%'"))[0]?.amount).toBe('2000');

      const view = await importOf(reply.json.resource_id);
      expect(view.status).toBe(200);
      expect(view.json).toMatchObject({
        id: reply.json.resource_id,
        provider: 'KBNN_FILE',
        source_kind: 'STATEMENT_FILE',
        status: 'PARTIALLY_APPLIED',
        row_total: 6,
        row_new: 3,
        row_duplicate: 1,
        row_conflict: 1,
        row_error: 1,
        imported_by: expect.any(String),
        adapter: { connector_code: 'TREASURY_STATEMENT_FILE', format_version: 'ASSUMED-2026.1', file_status: 'PROPOSED', api_status: 'MISSING', connector_status: 'ACTIVE', last_error_code: null },
        rows_truncated: false,
      });
      const rows = view.json.rows as Array<Record<string, unknown>>;
      expect(rows.map((row) => [row.row_no, row.outcome, row.error_code])).toEqual([
        [2, 'NEW', null],
        [3, 'NEW', null],
        [4, 'NEW', null],
        [5, 'DUPLICATE', null],
        [6, 'CONFLICT', null],
        [7, 'ERROR', 'AMOUNT_INVALID'],
      ]);
      expect(rows[5]?.raw_masked).toMatchObject({ document_no: 'A2-BAD', amount_vnd: '12x', payee_account: '***012' });
      expect(Object.keys(rows[0] ?? {}).sort()).toEqual(['business_key', 'outcome', 'error_code', 'raw_masked', 'row_no', 'treasury_transaction_id'].sort());
      expect(view.json.differences).toEqual([
        expect.objectContaining({ code: 'DUPLICATE_CONFLICT', expected: '2000', actual: '2500', difference: '500', status: 'OPEN', owner_membership_id: expect.any(String), due_at: expect.any(String), row_no: 6 }),
      ]);
      // Nothing in the answer shows the account number, a row hash or the object key of the file.
      const text = JSON.stringify(view.json);
      expect(text).not.toContain(ACCOUNT);
      expect(text).not.toMatch(/row_hash|file_object_key|source_hash/);
      expect(Object.keys(view.json).sort()).toEqual(
        ['adapter', 'certified_total', 'differences', 'file_name', 'file_sha256', 'id', 'imported_at', 'imported_by', 'imported_by_name', 'provider', 'row_conflict', 'row_duplicate', 'row_error', 'row_new', 'row_total', 'rows', 'rows_truncated', 'source_kind', 'statement_date', 'status'].sort(),
      );
      expect(await pay.rows<{ action: string }>('select action from machvon.audit_event where resource_id = $1', [reply.json.resource_id])).toEqual([{ action: 'pay.treasury_import_applied' }]);
    });

    it('quarantines a code with no mapping as CROSSWALK_MISSING and creates no master entry (crosswalk TREASURY/AGENCY_CODE)', async () => {
      const masters = await pay.count("select count(*)::text as n from machvon.master_record where master_type = 'TREASURY_OFFICE'");
      const reply = await importFile(csv(line('A2U-1', 100, { office: 'KB-UNKNOWN' }), line('A2U-2', 100)));
      expect(reply.json).toMatchObject({ row_new: 1, row_error: 1, differences_opened: 1 });
      const view = await importOf(reply.json.resource_id);
      expect((view.json.rows as Array<Record<string, unknown>>).map((row) => [row.outcome, row.error_code])).toEqual([['ERROR', 'CROSSWALK_MISSING'], ['NEW', null]]);
      expect(view.json.differences).toEqual([expect.objectContaining({ code: 'CROSSWALK_MISSING', status: 'OPEN' })]);
      expect(await pay.count("select count(*)::text as n from machvon.master_record where master_type = 'TREASURY_OFFICE'")).toBe(masters);
    });

    it('does not increase the certified total when a file with the same rows comes again (AC-ST-PAY-006-4)', async () => {
      const rows = [line('A4-1', 10_000), line('A4-2', 20_000)];
      const first = await importFile(csv(...rows));
      const before = (await importOf(first.json.resource_id)).json.certified_total as { rows: number; amount_vnd: string };
      const again = await importFile(new TextEncoder().encode(`${HEADER}\r\n${rows.join('\r\n')}\r\n`));
      expect(again.json).toMatchObject({ status: 'APPLIED', row_new: 0, row_duplicate: 2 });
      expect((await importOf(again.json.resource_id)).json.certified_total).toEqual(before);
    });
  });

  describe('uploadTreasuryStatementFile', () => {
    const upload = (bytes: Uint8Array, member: number = IMPORTER, options: { name?: string; type?: string } = {}): Promise<Reply> => pay.upload('/treasury-imports/files', member, bytes, options);

    it('stores the file, says what it holds and whether it has the columns of the layout, and the id and hash it answers are the ones the import takes', async () => {
      const bytes = csv(line('U-1', 1000), line('U-2', 2000));
      const stored = await upload(bytes, IMPORTER, { name: 'C:\\Downloads\\sao ke 15-10.csv' });
      expect(stored.status).toBe(200);
      expect(stored.json).toMatchObject({ file_sha256: shaOf(bytes), size_bytes: bytes.length, file_name: 'sao ke 15-10.csv', format: 'CSV', columns: HEADER.split(','), row_count: 2, layout_ok: true, missing_columns: [] });
      expect(stored.json.file_object_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(Object.keys(stored.json).sort()).toEqual(['columns', 'file_name', 'file_object_id', 'file_sha256', 'format', 'layout_ok', 'missing_columns', 'row_count', 'size_bytes'].sort());
      expect(await pay.rows("select action from machvon.audit_event where action = 'pay.treasury_file_uploaded' and safe_diff->>'file_sha256' = $1", [shaOf(bytes)])).toEqual([{ action: 'pay.treasury_file_uploaded' }]);
      // Nothing was imported by the upload.
      expect(await pay.count('select count(*)::text as n from machvon.treasury_import where file_sha256 = $1', [shaOf(bytes)])).toBe(0);
      const imported = await pay.call('POST', '/treasury-imports', {
        member: IMPORTER,
        body: { file_object_id: stored.json.file_object_id, file_sha256: stored.json.file_sha256, source_kind: 'STATEMENT_FILE', file_name: ' sao ke 15-10.csv ' },
      });
      expect(imported.json.result).toBe('APPLIED');
      expect(await pay.rows('select file_name from machvon.treasury_import where id = $1', [imported.json.resource_id])).toEqual([{ file_name: 'sao ke 15-10.csv' }]);
    });

    it('names the required columns that a file lacks and the import then refuses it', async () => {
      const stored = await upload(new TextEncoder().encode('document_no,amount_vnd\nX-1,1000\n'));
      expect(stored.status).toBe(200);
      expect(stored.json).toMatchObject({ layout_ok: false, missing_columns: ['document_date', 'project_code', 'treasury_office_code', 'confirmed_at'], row_count: 1 });
      const imported = await pay.call('POST', '/treasury-imports', { member: IMPORTER, body: { file_object_id: stored.json.file_object_id, file_sha256: stored.json.file_sha256, source_kind: 'STATEMENT_FILE' } });
      expect([imported.status, imported.json.code]).toEqual([422, 'TREASURY_IMPORT_SCHEMA_INVALID']);
    });

    it('reads a file as a table only after the scan found it clean: an infected file that is not even a table is FILE_NOT_CLEAN, not a layout error', async () => {
      // The workbook reader is a parser of the sender's bytes (an archive inflater): it must never see a file the scan has not cleared.
      const infectedBrokenSheet = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, ...eicarBytes()]);
      const reply = await upload(infectedBrokenSheet, IMPORTER, { name: 'a.xlsx', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      expect([reply.status, reply.json.code]).toEqual([422, 'FILE_NOT_CLEAN']);
    });

    it('refuses what is not a table, what is infected and what is too large, and a caller who may not import', async () => {
      const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
      expect(await upload(png, IMPORTER, { name: 'a.csv', type: 'image/png' })).toMatchObject({ status: 422, json: { code: 'FILE_TYPE_NOT_ALLOWED' } });
      expect(await upload(new Uint8Array([...eicarBytes(), ...csv(line('U-3', 1))]))).toMatchObject({ status: 422, json: { code: 'FILE_NOT_CLEAN' } });
      expect(await upload(new Uint8Array(11 * 1024 * 1024))).toMatchObject({ status: 413, json: { code: 'PAYLOAD_TOO_LARGE' } });
      const brokenSheet = await upload(Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5, 6, 7, 8]), IMPORTER, { name: 'a.xlsx', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      expect([brokenSheet.status, brokenSheet.json.code]).toEqual([422, 'TREASURY_IMPORT_SCHEMA_INVALID']);
      const branch = await upload(csv(line('U-4', 1)), BRANCH_IMPORTER);
      expect([branch.status, branch.json.code]).toEqual([403, 'SCOPE_DENIED']);
      expect((await upload(csv(line('U-4', 1)), NOBODY)).status).toBe(403);
    });
  });

  describe('listTreasuryImports', () => {
    it('lists the imports of the tenant, the newest first, in pages, and none of another tenant', async () => {
      const ids: string[] = [];
      for (const n of [1, 2, 3]) ids.push(String((await importFile(csv(line(`L-${n}`, 100 * n)), IMPORTER, { file_name: `list-${n}.csv` })).json.resource_id));
      const page = await pay.call('GET', '/treasury-imports?limit=2', { member: IMPORT_READER });
      expect(page.status).toBe(200);
      const items = page.json.items as Array<Record<string, unknown>>;
      expect(items.map((item) => item.id)).toEqual([ids[2], ids[1]]);
      expect(items[0]).toMatchObject({ file_name: 'list-3.csv', source_kind: 'STATEMENT_FILE', status: 'APPLIED', row_total: 1, row_new: 1, imported_at: expect.any(String), imported_by_name: expect.any(String) });
      expect(Object.keys(items[0] ?? {}).sort()).toEqual(
        ['file_name', 'file_sha256', 'id', 'imported_at', 'imported_by', 'imported_by_name', 'row_conflict', 'row_duplicate', 'row_error', 'row_new', 'row_total', 'source_kind', 'statement_date', 'status'].sort(),
      );
      expect(page.json.next_cursor).not.toBeNull();
      const next = await pay.call('GET', `/treasury-imports?limit=1&cursor=${String(page.json.next_cursor)}`, { member: IMPORT_READER });
      expect((next.json.items as Array<Record<string, unknown>>)[0]?.id).toBe(ids[0]);
      expect(JSON.stringify(page.json)).not.toMatch(/file_object_key|row_hash/);
      expect((await pay.call('GET', '/treasury-imports', { member: OTHER_IMPORTER, tenantId: TENANT_B })).json.items).toEqual([]);
    });

    it('is empty for a caller whose read is on a branch only, refused without the permission, and refuses a bad page', async () => {
      expect((await pay.call('GET', '/treasury-imports', { member: BRANCH_IMPORTER })).json).toMatchObject({ items: [], next_cursor: null });
      expect((await pay.call('GET', '/treasury-imports', { member: NOBODY })).status).toBe(403);
      expect((await pay.call('GET', '/treasury-imports?limit=0', { member: IMPORTER })).status).toBe(422);
      expect((await pay.call('GET', '/treasury-imports?cursor=zz', { member: IMPORTER })).status).toBe(422);
    });
  });

  describe('who may import and read', () => {
    it('refuses an import to a caller whose grant is on a branch only (403 SCOPE_DENIED), and to a caller without the permission', async () => {
      const bytes = csv(line('D-1', 1));
      const stored = await pay.store(bytes);
      const body = { file_object_id: stored.fileObjectId, file_sha256: stored.sha256, source_kind: 'STATEMENT_FILE' };
      const branch = await pay.call('POST', '/treasury-imports', { member: BRANCH_IMPORTER, body });
      expect([branch.status, branch.json.code]).toEqual([403, 'SCOPE_DENIED']);
      const nobody = await pay.call('POST', '/treasury-imports', { member: NOBODY, body });
      expect(nobody.status).toBe(403);
      expect(await pay.count('select count(*)::text as n from machvon.treasury_import where file_sha256 = $1', [stored.sha256])).toBe(0);
      // The refused file did not consume its identity: a caller who may import takes it.
      expect((await pay.call('POST', '/treasury-imports', { member: IMPORTER, body })).json.result).toBe('APPLIED');
    });

    it('shows an import to a caller who holds the read on the whole tenant, and as not found to a branch-only or unauthorised caller and to another tenant', async () => {
      const reply = await importFile(csv(line('R-1', 1)));
      expect((await importOf(reply.json.resource_id, IMPORT_READER)).status).toBe(200);
      expect((await importOf(reply.json.resource_id, BRANCH_IMPORTER)).status).toBe(404);
      expect((await importOf(reply.json.resource_id, NOBODY)).status).toBe(403);
      expect((await importOf(reply.json.resource_id, OTHER_IMPORTER, TENANT_B)).status).toBe(404);
      expect((await importOf(randomUUID())).status).toBe(404);
      expect((await pay.call('GET', '/treasury-imports/not-a-uuid', { member: IMPORTER })).status).toBe(422);
    });
  });

  describe('what is refused', () => {
    it('refuses a hash that is not the hash of the stored file (422 HASH_MISMATCH) and writes nothing', async () => {
      const stored = await pay.store(csv(line('E-1', 1)));
      const reply = await pay.call('POST', '/treasury-imports', { member: IMPORTER, body: { file_object_id: stored.fileObjectId, file_sha256: shaOf(csv(line('E-2', 1))), source_kind: 'STATEMENT_FILE' } });
      expect([reply.status, reply.json.code]).toEqual([422, 'HASH_MISMATCH']);
      expect(await pay.count("select count(*)::text as n from machvon.treasury_transaction where external_id like 'KBNN_FILE|E-%'")).toBe(0);
    });

    it('refuses a file that is not in the store of the tenant (404), also the id of a file of another tenant', async () => {
      const own = await pay.store(csv(line('E-3', 1)), TENANT_B);
      const foreign = await pay.call('POST', '/treasury-imports', { member: IMPORTER, body: { file_object_id: own.fileObjectId, file_sha256: own.sha256, source_kind: 'STATEMENT_FILE' } });
      expect(foreign.status).toBe(404);
      const absent = await pay.call('POST', '/treasury-imports', { member: IMPORTER, body: { file_object_id: randomUUID(), file_sha256: 'a'.repeat(64), source_kind: 'STATEMENT_FILE' } });
      expect(absent.status).toBe(404);
    });

    it('refuses a file the scan found infected (422 FILE_NOT_CLEAN)', async () => {
      const bytes = new Uint8Array([...eicarBytes(), ...csv(line('E-4', 1))]);
      const stored = await pay.store(bytes);
      expect(stored.scan).toBe('INFECTED');
      const reply = await pay.call('POST', '/treasury-imports', { member: IMPORTER, body: { file_object_id: stored.fileObjectId, file_sha256: stored.sha256, source_kind: 'STATEMENT_FILE' } });
      expect([reply.status, reply.json.code]).toEqual([422, 'FILE_NOT_CLEAN']);
    });

    it.each([
      ['a file without the required columns', 'document_no,amount_vnd\nCT-1,1000\n'],
      ['a header and no row', `${HEADER}\n`],
    ])('refuses %s as 422 TREASURY_IMPORT_SCHEMA_INVALID, and the connector stays active so the corrected file can be taken', async (_name, content) => {
      const reply = await importFile(new TextEncoder().encode(content));
      expect([reply.status, reply.json.code]).toEqual([422, 'TREASURY_IMPORT_SCHEMA_INVALID']);
      expect(await pay.count("select count(*)::text as n from machvon.integration_cursor where connector_code = 'TREASURY_STATEMENT_FILE' and status <> 'ACTIVE'")).toBe(0);
    });

    it('refuses a request that the contract does not allow', async () => {
      const stored = await pay.store(csv(line('E-5', 1)));
      const good = { file_object_id: stored.fileObjectId, file_sha256: stored.sha256, source_kind: 'STATEMENT_FILE' };
      expect((await pay.call('POST', '/treasury-imports', { member: IMPORTER, body: { ...good, surprise: true } })).status).toBe(400);
      expect((await pay.call('POST', '/treasury-imports', { member: IMPORTER, body: { ...good, source_kind: 'OTHER' } })).status).toBe(422);
      expect((await pay.call('POST', '/treasury-imports', { member: IMPORTER, body: { ...good, file_sha256: 'ABC' } })).status).toBe(422);
      expect((await pay.call('POST', '/treasury-imports', { member: IMPORTER, body: { ...good, statement_date: '2026-02-30' } })).status).toBe(422);
      expect((await pay.call('POST', '/treasury-imports', { member: IMPORTER, body: { source_kind: 'STATEMENT_FILE' } })).status).toBe(400);
      expect((await pay.call('POST', '/treasury-imports', { member: IMPORTER, body: { ...good, file_object_id: 'not-a-uuid' } })).status).toBe(422);
    });

    it('keeps the statement date the person gave', async () => {
      const reply = await importFile(csv(line('E-6', 1)), IMPORTER, { statement_date: '2026-10-16', source_kind: 'EXPORT_FILE' });
      expect(reply.status).toBe(200);
      expect((await importOf(reply.json.resource_id)).json).toMatchObject({ statement_date: '2026-10-16', source_kind: 'EXPORT_FILE' });
    });
  });

  describe('the reconciliation total and the concurrent import (UAT-AC11, UAT-AC333)', () => {
    const certifiedOf = async (importId: unknown): Promise<{ rows: number; amount_vnd: string }> => (await importOf(importId)).json.certified_total as { rows: number; amount_vnd: string };
    const amountOf = async (prefix: string): Promise<string> =>
      (await pay.rows<{ total: string }>("select coalesce(sum(amount_vnd), 0)::text as total from machvon.treasury_transaction where external_id like $1", [`KBNN_FILE|${prefix}%`]))[0]?.total ?? '';
    const countOf = (prefix: string): Promise<number> => pay.count("select count(*)::text as n from machvon.treasury_transaction where external_id like $1", [`KBNN_FILE|${prefix}%`]);
    const importsOf = (sha: string): Promise<number> => pay.count('select count(*)::text as n from machvon.treasury_import where file_sha256 = $1', [sha]);

    it('UAT-AC11: F1 is applied with three new rows (2,670,000,000), F1 again is ALREADY_IMPORTED without a new import, F2 (F1 and one more row) makes one new row and three duplicates, and the total is 2,970,000,000 and not 5,640,000,000', async () => {
      // The total the PAY-13 screen reads is the certified total of the statements: it is read before the files and again after each, so the difference is what the files did.
      const baseline = await importFile(csv(line('AC11-BASE', 7)));
      const start = await certifiedOf(baseline.json.resource_id);
      const f1 = csv(line('AC11-CT-0001', 2_100_000_000), line('AC11-CT-0002', 450_000_000), line('AC11-CT-0003', 120_000_000));
      const f2 = csv(line('AC11-CT-0001', 2_100_000_000), line('AC11-CT-0002', 450_000_000), line('AC11-CT-0003', 120_000_000), line('AC11-CT-0004', 300_000_000));
      const hash1 = shaOf(f1);
      const hash2 = shaOf(f2);
      expect(hash1).not.toBe(hash2);

      const first = await importFile(f1);
      expect(first.status).toBe(200);
      expect(first.json).toMatchObject({ status: 'APPLIED', result: 'APPLIED', row_total: 3, row_new: 3, row_duplicate: 0, row_conflict: 0, row_error: 0 });
      expect(await countOf('AC11-CT')).toBe(3);
      expect(await amountOf('AC11-CT')).toBe('2670000000');
      const afterFirst = await certifiedOf(first.json.resource_id);
      expect([afterFirst.rows - start.rows, BigInt(afterFirst.amount_vnd) - BigInt(start.amount_vnd)]).toEqual([3, 2_670_000_000n]);

      // F1 again under a new idempotency key: the file is the identity, so nothing is created and the count of imports of that file stays one.
      const again = await importFile(f1);
      expect(again.json).toMatchObject({ status: 'ALREADY_IMPORTED', result: 'ALREADY_IMPORTED', resource_id: first.json.resource_id, duplicate: true });
      expect(await importsOf(hash1)).toBe(1);
      expect(await countOf('AC11-CT')).toBe(3);

      // F2: the three rows of F1 are duplicates (same key, same hash), the new one is created; the four transactions sum to 2,970,000,000.
      const second = await importFile(f2);
      expect(second.json).toMatchObject({ row_total: 4, row_new: 1, row_duplicate: 3, row_conflict: 0, row_error: 0 });
      expect(second.json.resource_id).not.toBe(first.json.resource_id);
      expect(await importsOf(hash2)).toBe(1);
      expect(await countOf('AC11-CT')).toBe(4);
      expect(await amountOf('AC11-CT')).toBe('2970000000');
      const afterSecond = await certifiedOf(second.json.resource_id);
      expect([afterSecond.rows - start.rows, BigInt(afterSecond.amount_vnd) - BigInt(start.amount_vnd)]).toEqual([4, 2_970_000_000n]);
      expect(BigInt(afterSecond.amount_vnd) - BigInt(start.amount_vnd)).not.toBe(5_640_000_000n);
      // The negative control: a check on the doubled total (the original and the repeat added) is not satisfied by this answer.
      expect(() => expect(BigInt(afterSecond.amount_vnd) - BigInt(start.amount_vnd)).toBe(5_640_000_000n)).toThrow();
    });

    it('UAT-AC333: of two requests for one file at the same moment (two keys, 30 rounds) one is APPLIED with five rows and the other ALREADY_IMPORTED of the same import; one import and five transactions; the file of one byte more is five duplicates; another tenant applies the same file on its own', async () => {
      const files: Uint8Array[] = [];
      for (let round = 0; round < 30; round += 1) {
        const rows = [1, 2, 3, 4, 5].map((n) => line(`AC333-R${round}-${n}`, 650_000_000));
        const bytes = csv(...rows);
        files.push(bytes);
        const stored = await pay.store(bytes);
        const body = { file_object_id: stored.fileObjectId, file_sha256: stored.sha256, source_kind: 'STATEMENT_FILE' };
        const replies = await Promise.all([
          pay.call('POST', '/treasury-imports', { member: IMPORTER, body, key: `ac333-a-${round}-${randomUUID()}` }),
          pay.call('POST', '/treasury-imports', { member: IMPORTER, body, key: `ac333-b-${round}-${randomUUID()}` }),
        ]);
        expect(replies.map((reply) => reply.status)).toEqual([200, 200]);
        expect(replies.map((reply) => reply.json.result).sort()).toEqual(['ALREADY_IMPORTED', 'APPLIED']);
        const applied = replies.find((reply) => reply.json.result === 'APPLIED') as Reply;
        const repeated = replies.find((reply) => reply.json.result === 'ALREADY_IMPORTED') as Reply;
        expect(applied.json).toMatchObject({ row_new: 5, row_total: 5 });
        expect(repeated.json.resource_id).toBe(applied.json.resource_id);
        expect(await importsOf(stored.sha256)).toBe(1);
        expect(await countOf(`AC333-R${round}-`)).toBe(5);
        expect(await amountOf(`AC333-R${round}-`)).toBe('3250000000');
      }

      // F3b: the first file with one byte more is a new file, but each of its five rows has a key and a hash that exist: five duplicates, nothing new, the total does not move.
      const original = files[0] as Uint8Array;
      const certifiedBefore = await certifiedOf((await importFile(csv(line('AC333-PROBE', 1)))).json.resource_id);
      const f3b = new Uint8Array([...original, 0x0a]);
      expect(shaOf(f3b)).not.toBe(shaOf(original));
      const variant = await importFile(f3b);
      expect(variant.json).toMatchObject({ row_total: 5, row_new: 0, row_duplicate: 5, row_conflict: 0, row_error: 0 });
      expect(await countOf('AC333-R0-')).toBe(5);
      expect(await amountOf('AC333-R0-')).toBe('3250000000');
      const certifiedAfter = await certifiedOf(variant.json.resource_id);
      expect(certifiedAfter).toEqual(certifiedBefore);

      // Tenant B: the hash is unique only inside the tenant; the same bytes are applied there (the project of the rows exists in tenant B too).
      const admin = new (await import('pg')).Client({ connectionString: pay.harness.database.adminUrl });
      await admin.connect();
      try {
        await admin.query('set session_replication_role = replica');
        await admin.query(
          `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
           values ($1, $2, $3, 'Bridge twin', $4, $5, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
          [TENANT_B, randomUUID(), pay.worldA.projectCodeA, unitId(BRANCH_A), id(FAMILY, 40)],
        );
      } finally {
        await admin.end();
      }
      const inB = await pay.store(original, TENANT_B);
      expect(inB.sha256).toBe(shaOf(original));
      const applied = await pay.call('POST', '/treasury-imports', { member: OTHER_IMPORTER, tenantId: TENANT_B, body: { file_object_id: inB.fileObjectId, file_sha256: inB.sha256, source_kind: 'STATEMENT_FILE' } });
      expect(applied.status).toBe(200);
      expect(applied.json).toMatchObject({ result: 'APPLIED', row_new: 5 });
      expect(await pay.count('select count(*)::text as n from machvon.treasury_import where file_sha256 = $1', [inB.sha256], TENANT_B)).toBe(1);
      expect(await importsOf(inB.sha256)).toBe(1);
    });
  });
});
