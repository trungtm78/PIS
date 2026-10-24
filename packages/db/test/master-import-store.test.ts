import { createHash } from 'node:crypto';
import { MasterImportStore, checkMapping } from '../src/master-import-store';
import type { ImportMapping, ImportMode } from '../src/master-import-store';
import { MasterStore } from '../src/master-store';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, id, memberId } from './support/authz-fixtures';

const shaOf = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const harness = new AuthzHarness();
const imports = new MasterImportStore();
const store = new MasterStore();
const IMPORTER = 1;
const CHECKER = 2;
const PUBLISHER = 3;
const DECISION_DOCUMENT = id(0x70, 1);
const MAPPING: ImportMapping = {
  key: 'Mã',
  label: 'Tên',
  valid_from: 'Từ ngày',
  parent_key: 'Mã cha',
  valid_until: 'Đến ngày',
  legal_basis: 'Căn cứ',
  attributes: { category: 'Loại nguồn', relation: 'Quan hệ' },
};
const HEADER = 'Mã,Tên,Từ ngày,Mã cha,Đến ngày,Căn cứ,Loại nguồn,Quan hệ';

const as = <T>(member: number, work: (tx: TenantTx) => Promise<T>, tenant = TENANT_A): Promise<T> => harness.tenants.withTenant(contextFor(tenant, memberId(member)), work);
const bytesOf = (lines: readonly string[]): Uint8Array => new TextEncoder().encode(`${HEADER}\n${lines.join('\n')}\n`);

async function refusal(work: Promise<unknown>): Promise<{ code: string; status: number; detail?: string }> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; status?: number; detail?: string };
    return { code: e.code ?? '', status: e.status ?? 0, ...(e.detail === undefined ? {} : { detail: e.detail }) };
  }
  throw new Error('expected a refusal');
}

let counter = 0;
/** A file of funding sources whose keys are new to the tenant: ten rows, the seventh a national target programme without its parent. */
function sources(prefix: string, options: { brokenRow?: boolean } = {}): string[] {
  const key = (n: number): string => `${prefix}-${n}`;
  return [
    `${key(1)},Ngân sách A,2024-01-01,,,Quyết định 1,NSTW,ADDITIVE`,
    `${key(2)},Ngân sách B,2024-01-01,${key(1)},,,NSTW,ADDITIVE`,
    `${key(3)},Ngân sách C,2024-01-01,${key(1)},,,NSDP,ADDITIVE`,
    `${key(4)},Ngân sách D,2024-01-01,,,,NSDP,ADDITIVE`,
    `${key(5)},Ngân sách E,2024-01-01,${key(4)},,,OTHER,ADDITIVE`,
    `${key(6)},Chương trình F,2024-01-01,${key(2)},,,CTMTQG,SUBSET_OF`,
    options.brokenRow === true ? `${key(7)},Chương trình G,2024-01-01,,,,CTMTQG,SUBSET_OF` : `${key(7)},Chương trình G,2024-01-01,${key(2)},,,CTMTQG,SUBSET_OF`,
    `${key(8)},Ngân sách H,2024-01-01,,2030-01-01,,OTHER,ADDITIVE`,
    `${key(9)},Ngân sách I,2024-01-01,,,,OTHER,ADDITIVE`,
    `${key(10)},Ngân sách J,2024-01-01,${key(9)},,,OTHER,ADDITIVE`,
  ];
}

const STAGE_MAPPING: ImportMapping = { key: 'Mã', label: 'Tên', valid_from: 'Từ ngày', attributes: { sequence: 'Thứ tự', allowed_next: 'Kế tiếp' } };
const stageBytesOf = (lines: readonly string[]): Uint8Array => new TextEncoder().encode(`Mã,Tên,Từ ngày,Thứ tự,Kế tiếp\n${lines.join('\n')}\n`);

describe('MasterImportStore (atomic bulk import with row-level errors, ST-MDM-006)', () => {
  const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);

  const stage = (lines: readonly string[], mode: ImportMode = 'ATOMIC', mapping: unknown = MAPPING, type = 'FUND_SOURCE') => {
    const bytes = bytesOf(lines);
    counter += 1;
    return as(IMPORTER, (tx) => imports.stage(tx, { masterType: type, fileObjectKey: `tenants/${TENANT_A}/import/${counter}`, fileSha256: shaOf(bytes), mapping, mode, bytes }, memberId(IMPORTER)));
  };
  const apply = (batchId: string, bytes: Uint8Array, member = IMPORTER) =>
    as(member, async (tx) => imports.apply(tx, batchId, ((await imports.find(tx, batchId))?.version ?? 0), bytes, memberId(member)));
  const decide = (batchId: string, decision: 'approve' | 'reject', member = CHECKER) =>
    as(member, async (tx) => imports.decide(tx, batchId, ((await imports.find(tx, batchId))?.version ?? 0), decision, memberId(member)));
  const publish = (batchId: string, member = PUBLISHER, document = DECISION_DOCUMENT) =>
    as(member, async (tx) => imports.publish(tx, batchId, ((await imports.find(tx, batchId))?.version ?? 0), document, memberId(member)));
  const recordsOf = async (prefix: string): Promise<Array<{ business_key: string; status: string }>> =>
    owner<{ business_key: string; status: string }>("select business_key, status from machvon.master_record where business_key like $1 order by business_key", [`${prefix}-%`]);

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.owner(tenant, [
        ["insert into machvon.master_type_policy (tenant_id, master_type, scope, updated_by) values ($1, 'FUND_SOURCE', 'TENANT_ONLY', $2)", [tenant, memberId(IMPORTER)]],
        ["insert into machvon.master_type_policy (tenant_id, master_type, scope, updated_by) values ($1, 'PROJECT_STAGE', 'TENANT_ONLY', $2)", [tenant, memberId(IMPORTER)]],
      ]);
      await harness.seedUnits(tenant, [{ n: 1, path: '/u1/' }]);
      for (const n of [IMPORTER, CHECKER, PUBLISHER]) await harness.seedMembership(tenant, n, 1);
      await harness.owner(tenant, [
        [
          `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by)
           values ($1, $2, 'INCOMING', 'CV', 'Decision', 'INTERNAL', $3, $3)`,
          [tenant, DECISION_DOCUMENT, memberId(IMPORTER)],
        ],
      ]);
    }
  }, 180_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  describe('staging a file', () => {
    it('judges every row and keeps the row errors, and writes nothing else', async () => {
      const prefix = 'STG';
      const batch = await stage(sources(prefix, { brokenRow: true }));
      expect(batch).toMatchObject({ status: 'VALIDATED', mode: 'ATOMIC', totalRows: 10, errorRows: 1 });
      expect(batch.errors).toEqual([{ row: 8, field: 'parent_key', code: 'INVALID_VALUE' }]);
      expect(await recordsOf(prefix)).toEqual([]);
    });

    it('accepts a file that is right, the parents of a row anywhere in the file', async () => {
      const lines = sources('OK');
      const batch = await stage([...lines.slice(1), lines[0] as string]);
      expect(batch).toMatchObject({ status: 'VALIDATED', totalRows: 10, errorRows: 0, errors: [] });
    });

    it('names the row, the field and the code for each kind of fault', async () => {
      const lines = [
        ',Không có mã,2024-01-01,,,,NSTW,ADDITIVE',
        'bad key!,Mã sai,2024-01-01,,,,NSTW,ADDITIVE',
        'DUP,Hai lần,2024-01-01,,,,NSTW,ADDITIVE',
        'DUP,Hai lần nữa,2024-01-01,,,,NSTW,ADDITIVE',
        `E-1,${'x'.repeat(501)},2024-01-01,,,,NSTW,ADDITIVE`,
        'E-2,Ngày sai,2024-02-30,,,,NSTW,ADDITIVE',
        'E-3,Thiếu ngày,,,,,NSTW,ADDITIVE',
        'E-4,Khoảng sai,2024-01-01,,2024-01-01,,NSTW,ADDITIVE',
        'E-5,Hết hiệu lực sai,2024-01-01,,hôm qua,,NSTW,ADDITIVE',
        'E-6,Cha không có,2024-01-01,NOPE,,,NSTW,ADDITIVE',
        'E-7,Tự làm cha,2024-01-01,E-7,,,NSTW,ADDITIVE',
        'E-8,Vòng một,2024-01-01,E-9,,,NSTW,ADDITIVE',
        'E-9,Vòng hai,2024-01-01,E-8,,,NSTW,ADDITIVE',
        'E-10,Loại lạ,2024-01-01,,,,LOTTERY,ADDITIVE',
        'E-11,Chương trình,2024-01-01,,,,CTMTQG,ADDITIVE',
        'E-12,Con của hàng lỗi,2024-01-01,E-6,,,NSTW,ADDITIVE',
        'E-13,Con của hàng sai loại,2024-01-01,E-10,,,NSTW,ADDITIVE',
      ];
      const batch = await stage(lines, 'PARTIAL');
      const byRow = new Map<number, string[]>();
      for (const error of batch.errors) byRow.set(error.row, [...(byRow.get(error.row) ?? []), `${error.field}:${error.code}`]);
      expect(byRow.get(2)).toEqual(['business_key:REQUIRED']);
      expect(byRow.get(3)).toEqual(['business_key:INVALID_FORMAT']);
      expect(byRow.get(5)).toEqual(['business_key:DUPLICATE_IN_FILE']);
      expect(byRow.get(6)).toEqual(['label:TOO_LONG']);
      expect(byRow.get(7)).toEqual(['valid_from:INVALID_DATE']);
      expect(byRow.get(8)).toEqual(['valid_from:REQUIRED']);
      expect(byRow.get(9)).toEqual(['valid_until:INVALID_RANGE']);
      expect(byRow.get(10)).toEqual(['valid_until:INVALID_DATE']);
      expect(byRow.get(11)).toEqual(['parent_key:PARENT_NOT_FOUND']);
      expect(byRow.get(12)).toEqual(['parent_key:PARENT_CYCLE']);
      expect(byRow.get(13)).toEqual(['parent_key:PARENT_CYCLE']);
      expect(byRow.get(14)).toEqual(['parent_key:PARENT_CYCLE']);
      expect(byRow.get(15)).toEqual(['attributes.category:INVALID_VALUE']);
      expect(byRow.get(16)).toEqual(['attributes.relation:SUBSET_SOURCE_NOT_ADDITIVE']);
      // A row under a row that cannot be created cannot be created either.
      expect(byRow.get(17)).toEqual(['parent_key:PARENT_SKIPPED']);
      expect(byRow.get(18)).toEqual(['parent_key:PARENT_SKIPPED']);
      // Only the third row (the first DUP) is right.
      expect(batch.errorRows).toBe(16);
      expect(byRow.has(4)).toBe(false);
    });

    it('refuses a key that the tenant already holds, and reads the cells that are numbers and flags', async () => {
      await as(IMPORTER, (tx) => store.propose(tx, { masterType: 'FUND_SOURCE', businessKey: 'HELD-1', content: { label: 'Held', attributes: { category: 'NSTW', relation: 'ADDITIVE' }, parentRecordId: null, validFrom: '2024-01-01', validUntil: null, legalBasis: null }, reason: 'Initial entry' }, memberId(IMPORTER)));
      const batch = await stage(['HELD-1,Trùng,2024-01-01,,,,NSTW,ADDITIVE', 'HELD-2,Mới,2024-01-01,,,,NSTW,ADDITIVE']);
      expect(batch.errors).toEqual([{ row: 2, field: 'business_key', code: 'DUPLICATE_KEY' }]);
      const mapped = { key: 'Mã', label: 'Tên', valid_from: 'Từ ngày', attributes: { category: 'Loại nguồn', relation: 'Quan hệ', onlending: 'Vay lại' } };
      const bytes = new TextEncoder().encode('Mã,Tên,Từ ngày,Loại nguồn,Quan hệ,Vay lại\nODA-1,ODA vay lại,2024-01-01,ODA,ADDITIVE,có\nODA-2,ODA không,2024-01-01,ODA,ADDITIVE,maybe\n');
      const staged = await as(IMPORTER, (tx) => imports.stage(tx, { masterType: 'FUND_SOURCE', fileObjectKey: `tenants/${TENANT_A}/import/flags`, fileSha256: shaOf(bytes), mapping: mapped, mode: 'PARTIAL', bytes }, memberId(IMPORTER)));
      expect(staged.errors).toEqual([{ row: 3, field: 'attributes.onlending', code: 'INVALID_VALUE' }]);
    });

    it('refuses a mapping that names a column the file does not have, or a field that does not exist', async () => {
      const bad = (mapping: unknown) => refusal(stage(sources('MAP'), 'ATOMIC', mapping));
      expect(await bad({ ...MAPPING, key: 'Missing' })).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'mapping.key' });
      expect(await bad({ ...MAPPING, label: undefined })).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'mapping.label' });
      expect(await bad({ ...MAPPING, valid_from: 3 })).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'mapping.valid_from' });
      expect(await bad({ ...MAPPING, parent_key: 'Missing' })).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'mapping.parent_key' });
      expect(await bad({ ...MAPPING, attributes: { category: 'Missing' } })).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'mapping.attributes' });
      expect(await bad({ ...MAPPING, attributes: { Bad: 'Loại nguồn' } })).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'mapping.attributes' });
      expect(await bad({ ...MAPPING, attributes: [] })).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'mapping.attributes' });
      expect(await bad({ ...MAPPING, surprise: 'x' })).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'mapping' });
      expect(await bad([])).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'mapping' });
      expect(checkMapping({ key: 'Mã', label: 'Tên', valid_from: 'Từ ngày' }, ['Mã', 'Tên', 'Từ ngày'])).toEqual({ key: 'Mã', label: 'Tên', valid_from: 'Từ ngày' });
    });

    it('refuses a file that is not a table, and a type that only the platform writes', async () => {
      const unreadable = new Uint8Array([0xff, 0xfe, 0x00]);
      expect(await refusal(as(IMPORTER, (tx) => imports.stage(tx, { masterType: 'FUND_SOURCE', fileObjectKey: 'k', fileSha256: shaOf(unreadable), mapping: MAPPING, mode: 'ATOMIC', bytes: unreadable }, memberId(IMPORTER))))).toEqual({
        code: 'VALIDATION_FAILED',
        status: 422,
        detail: 'file',
      });
      await owner("delete from machvon.master_type_policy where master_type = 'FUND_SOURCE'");
      expect(await refusal(stage(sources('LOCK')))).toEqual({ code: 'POLICY_LOCKED', status: 403, detail: 'master_type' });
      await owner("insert into machvon.master_type_policy (tenant_id, master_type, scope, updated_by) values ($1, 'FUND_SOURCE', 'TENANT_ONLY', $2)", [TENANT_A, memberId(IMPORTER)]);
    });
  });

  describe('applying a batch', () => {
    it('rejects an ATOMIC batch with an error row and changes nothing; after the fix the whole file appears once (AC-ST-MDM-006-1)', async () => {
      const prefix = 'ATM';
      const broken = bytesOf(sources(prefix, { brokenRow: true }));
      const batch = await stage(sources(prefix, { brokenRow: true }));
      expect(await refusal(apply(batch.id, broken))).toEqual({ code: 'IMPORT_HAS_ERRORS', status: 422 });
      expect(await recordsOf(prefix)).toEqual([]);
      expect(await owner('select count(*)::int as n from machvon.master_change_request where import_batch_id = $1', [batch.id])).toEqual([{ n: 0 }]);

      const fixed = bytesOf(sources(prefix));
      const second = await stage(sources(prefix));
      expect(second.errorRows).toBe(0);
      const applied = await apply(second.id, fixed);
      expect(applied).toMatchObject({ created: 10, skipped: 0, batch: { status: 'IN_REVIEW', totalRows: 10, errorRows: 0 } });
      const records = await recordsOf(prefix);
      expect(records).toHaveLength(10);
      expect(new Set(records.map((record) => record.status))).toEqual(new Set(['IN_REVIEW']));
      const changes = await owner<{ status: string; change_kind: string }>('select status, change_kind from machvon.master_change_request where import_batch_id = $1', [second.id]);
      expect(changes).toHaveLength(10);
      expect(new Set(changes.map((change) => `${change.change_kind}:${change.status}`))).toEqual(new Set(['CREATE:IN_REVIEW']));
      // The parents of the file are the records of the file.
      const tree = await owner<{ business_key: string; parent: string | null }>(
        `select r.business_key, p.business_key as parent from machvon.master_record r join machvon.master_record_version v on v.master_record_id = r.id left join machvon.master_record p on p.id = v.parent_id
          where r.business_key like $1 order by r.business_key`,
        [`${prefix}-%`],
      );
      expect(tree.find((row) => row.business_key === 'ATM-6')?.parent).toBe('ATM-2');
      // A batch is applied once: the second call finds it in review.
      expect(await refusal(apply(second.id, fixed))).toEqual({ code: 'STAGE_TRANSITION_DENIED', status: 409, detail: 'IN_REVIEW->apply' });
    });

    it('creates the valid rows of a PARTIAL batch and lists the rows that were left out, and the rows under them', async () => {
      const prefix = 'PRT';
      const lines = sources(prefix, { brokenRow: true });
      const bytes = bytesOf(lines);
      const staged = await stage(lines, 'PARTIAL');
      expect(staged.errorRows).toBe(1);
      const applied = await apply(staged.id, bytes);
      expect(applied).toMatchObject({ created: 9, skipped: 1, batch: { status: 'IN_REVIEW', errorRows: 1 } });
      expect(applied.batch.errors).toEqual([{ row: 8, field: 'parent_key', code: 'INVALID_VALUE' }]);
      expect((await recordsOf(prefix)).map((record) => record.business_key)).not.toContain('PRT-7');
    });

    it('judges the file again at apply: what changed in the tenant since the dry run counts', async () => {
      const prefix = 'RJG';
      const lines = sources(prefix);
      const bytes = bytesOf(lines);
      const staged = await stage(lines);
      await as(IMPORTER, (tx) => store.propose(tx, { masterType: 'FUND_SOURCE', businessKey: 'RJG-3', content: { label: 'Taken meanwhile', attributes: { category: 'NSTW', relation: 'ADDITIVE' }, parentRecordId: null, validFrom: '2024-01-01', validUntil: null, legalBasis: null }, reason: 'Initial entry' }, memberId(IMPORTER)));
      expect(await refusal(apply(staged.id, bytes))).toEqual({ code: 'IMPORT_HAS_ERRORS', status: 422 });
      expect(await owner("select count(*)::int as n from machvon.master_record where business_key like 'RJG-%'")).toEqual([{ n: 1 }]);
    });

    it('refuses to apply a version of the batch that is not the current one', async () => {
      const lines = sources('VER');
      const staged = await stage(lines);
      expect((await refusal(as(IMPORTER, (tx) => imports.apply(tx, staged.id, staged.version + 5, bytesOf(lines), memberId(IMPORTER))))).code).toBe('VERSION_CONFLICT');
      expect(await refusal(as(IMPORTER, (tx) => imports.apply(tx, id(0x7b, 1), 1, bytesOf(lines), memberId(IMPORTER))))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    });
  });

  describe('reviewing and publishing the batch as one', () => {
    async function inReview(prefix: string): Promise<{ id: string; bytes: Uint8Array }> {
      const lines = sources(prefix);
      const bytes = bytesOf(lines);
      const staged = await stage(lines);
      await apply(staged.id, bytes);
      return { id: staged.id, bytes };
    }

    it('is approved by someone who did not apply it, published by a third person, and then every record is in force (AC-ST-MDM-006-1)', async () => {
      const prefix = 'PUB';
      const { id: batchId, bytes } = await inReview(prefix);
      expect((await refusal(decide(batchId, 'approve', IMPORTER))).code).toBe('SELF_APPROVAL_DENIED');
      expect(await refusal(publish(batchId))).toEqual({ code: 'CHANGE_NOT_APPROVED', status: 409 });
      const approved = await decide(batchId, 'approve');
      expect(approved).toMatchObject({ changes: 10, batch: { status: 'IN_REVIEW', reviewedBy: memberId(CHECKER) } });
      expect(await refusal(decide(batchId, 'approve'))).toEqual({ code: 'STAGE_TRANSITION_DENIED', status: 409, detail: 'IN_REVIEW->approve' });
      expect((await refusal(publish(batchId, IMPORTER))).code).toBe('SELF_APPROVAL_DENIED');
      // One document that does not exist, and nothing is published.
      expect((await refusal(publish(batchId, PUBLISHER, id(0x7c, 9)))).code).toBe('VALIDATION_FAILED');
      expect(new Set((await recordsOf(prefix)).map((record) => record.status))).toEqual(new Set(['APPROVED']));
      const published = await publish(batchId);
      expect(published.published).toHaveLength(10);
      expect(published.batch).toMatchObject({ status: 'APPLIED', publishedBy: memberId(PUBLISHER), decisionDocumentId: DECISION_DOCUMENT });
      expect(new Set((await recordsOf(prefix)).map((record) => record.status))).toEqual(new Set(['EFFECTIVE']));
      expect(await owner("select count(*)::int as n from machvon.master_change_request where import_batch_id = $1 and status = 'APPLIED'", [batchId])).toEqual([{ n: 10 }]);
      // The same file is never applied again (AC-ST-MDM-006-2).
      expect(await refusal(as(IMPORTER, (tx) => imports.stage(tx, { masterType: 'FUND_SOURCE', fileObjectKey: 'again', fileSha256: shaOf(bytes), mapping: MAPPING, mode: 'ATOMIC', bytes }, memberId(IMPORTER))))).toEqual({
        code: 'IMPORT_FILE_ALREADY_APPLIED',
        status: 409,
      });
    });

    it('rejects the whole batch with its reason: the records go back to drafts and the batch is cancelled', async () => {
      const prefix = 'REJ';
      const { id: batchId } = await inReview(prefix);
      const rejected = await decide(batchId, 'reject');
      expect(rejected.batch.status).toBe('CANCELLED');
      expect(new Set((await recordsOf(prefix)).map((record) => record.status))).toEqual(new Set(['DRAFT']));
      expect(await owner("select distinct status from machvon.master_change_request where import_batch_id = $1", [batchId])).toEqual([{ status: 'REJECTED' }]);
      expect(await refusal(publish(batchId))).toEqual({ code: 'CHANGE_NOT_APPROVED', status: 409 });
    });

    it('does not apply the same file twice even when it was staged twice: the second batch finds the first applied (AC-ST-MDM-006-2)', async () => {
      const prefix = 'TWO';
      const lines = sources(prefix);
      const bytes = bytesOf(lines);
      const first = await stage(lines);
      const second = await stage(lines);
      await apply(first.id, bytes);
      await decide(first.id, 'approve');
      await publish(first.id);
      expect(await refusal(apply(second.id, bytes))).toEqual({ code: 'IMPORT_FILE_ALREADY_APPLIED', status: 409 });
    });
  });

  describe('rows that refer to each other (Codex finding 2)', () => {
    const stageStages = (lines: readonly string[], mode: ImportMode = 'ATOMIC') => {
      const bytes = stageBytesOf(lines);
      counter += 1;
      return as(IMPORTER, (tx) => imports.stage(tx, { masterType: 'PROJECT_STAGE', fileObjectKey: `tenants/${TENANT_A}/import/stages-${counter}`, fileSha256: shaOf(bytes), mapping: STAGE_MAPPING, mode, bytes }, memberId(IMPORTER)));
    };

    it('creates rows that name rows below them or each other: the references are judged against the file at apply, as they were at the dry run', async () => {
      const lines = ['FWD-1,One,2024-01-01,1,FWD-2|FWD-3', 'FWD-2,Two,2024-01-01,2,FWD-3', 'FWD-3,Three,2024-01-01,3,FWD-1'];
      const staged = await stageStages(lines);
      expect(staged).toMatchObject({ status: 'VALIDATED', totalRows: 3, errorRows: 0 });
      const applied = await apply(staged.id, stageBytesOf(lines));
      expect(applied).toMatchObject({ created: 3, skipped: 0, batch: { status: 'IN_REVIEW' } });
      expect((await recordsOf('FWD')).map((record) => record.status)).toEqual(['IN_REVIEW', 'IN_REVIEW', 'IN_REVIEW']);
    });

    it('still refuses a reference to an entry that is neither in the file nor held by the tenant', async () => {
      const staged = await stageStages(['GHO-1,One,2024-01-01,1,GHO-NOWHERE'], 'PARTIAL');
      expect(staged.errors).toEqual([{ row: 2, field: 'attributes.allowed_next', code: 'INVALID_VALUE' }]);
    });

    it('reports a row that names a row left out, and the rows that name that row, instead of failing at apply', async () => {
      const lines = ['SKP-1,One,2024-01-01,1,SKP-2', 'SKP-2,Two,2024-01-01,not-a-number,', 'SKP-3,Three,2024-01-01,3,SKP-1', 'SKP-4,Four,2024-01-01,4,'];
      const staged = await stageStages(lines, 'PARTIAL');
      expect(staged.errors).toEqual([
        { row: 2, field: 'attributes.allowed_next', code: 'REFERENCE_SKIPPED' },
        { row: 3, field: 'attributes.sequence', code: 'INVALID_VALUE' },
        { row: 4, field: 'attributes.allowed_next', code: 'REFERENCE_SKIPPED' },
      ]);
      expect(staged.errorRows).toBe(3);
      const applied = await apply(staged.id, stageBytesOf(lines));
      expect(applied).toMatchObject({ created: 1, skipped: 3 });
      expect((await recordsOf('SKP')).map((record) => record.business_key)).toEqual(['SKP-4']);
    });

    it('refuses the whole ATOMIC file when a row names a row that fails', async () => {
      const lines = ['ATR-1,One,2024-01-01,1,ATR-2', 'ATR-2,Two,2024-01-01,0,'];
      const staged = await stageStages(lines);
      expect(staged.errorRows).toBe(2);
      expect(await refusal(apply(staged.id, stageBytesOf(lines)))).toEqual({ code: 'IMPORT_HAS_ERRORS', status: 422 });
    });
  });

  describe('the parents of a file', () => {
    it('hangs a row under an entry the tenant already holds, and refuses one that is nowhere', async () => {
      await as(IMPORTER, (tx) => store.propose(tx, { masterType: 'FUND_SOURCE', businessKey: 'PAR-ROOT', content: { label: 'Root', attributes: { category: 'NSTW', relation: 'ADDITIVE' }, parentRecordId: null, validFrom: '2024-01-01', validUntil: null, legalBasis: null }, reason: 'Initial entry' }, memberId(IMPORTER)));
      const lines = ['PAR-1,Under the root,2024-01-01,PAR-ROOT,,,NSTW,ADDITIVE', 'PAR-2,Under nothing,2024-01-01,PAR-NOWHERE,,,NSTW,ADDITIVE'];
      const staged = await stage(lines, 'PARTIAL');
      expect(staged.errors).toEqual([{ row: 3, field: 'parent_key', code: 'PARENT_NOT_FOUND' }]);
      await apply(staged.id, bytesOf(lines));
      expect(await owner("select p.business_key as parent from machvon.master_record r join machvon.master_record_version v on v.master_record_id = r.id join machvon.master_record p on p.id = v.parent_id where r.business_key = 'PAR-1'")).toEqual([{ parent: 'PAR-ROOT' }]);
    });

    it('lets a tenant that only extends a type hang rows under the entries of the platform alone', async () => {
      await owner("update machvon.master_type_policy set scope = 'PLATFORM_WITH_TENANT_EXTENSION' where master_type = 'FUND_SOURCE'");
      try {
        const staged = await stage(['EXT-1,No parent,2024-01-01,,,,NSTW,ADDITIVE', 'EXT-2,Under a row that is left out,2024-01-01,EXT-1,,,NSTW,ADDITIVE'], 'PARTIAL');
        expect(staged.errors).toEqual([
          { row: 2, field: 'parent_key', code: 'POLICY_LOCKED' },
          { row: 3, field: 'parent_key', code: 'PARENT_SKIPPED' },
        ]);
      } finally {
        await owner("update machvon.master_type_policy set scope = 'TENANT_ONLY' where master_type = 'FUND_SOURCE'");
      }
    });
  });

  describe('a file with nothing to apply (Codex finding 3)', () => {
    it('is refused at apply, whatever the mode, and stays a dry run that creates nothing', async () => {
      const headerOnly = bytesOf([]);
      counter += 1;
      const empty = await as(IMPORTER, (tx) => imports.stage(tx, { masterType: 'FUND_SOURCE', fileObjectKey: `tenants/${TENANT_A}/import/empty-${counter}`, fileSha256: shaOf(headerOnly), mapping: MAPPING, mode: 'ATOMIC', bytes: headerOnly }, memberId(IMPORTER)));
      expect(empty).toMatchObject({ status: 'VALIDATED', totalRows: 0, errorRows: 0, errors: [] });
      expect(await refusal(apply(empty.id, headerOnly))).toEqual({ code: 'IMPORT_EMPTY', status: 422 });

      const lines = ['NIL-1,No category,2024-01-01,,,,LOTTERY,ADDITIVE', 'NIL-2,No date,,,,,NSTW,ADDITIVE'];
      const partial = await stage(lines, 'PARTIAL');
      expect(partial).toMatchObject({ status: 'VALIDATED', totalRows: 2, errorRows: 2 });
      expect(await refusal(apply(partial.id, bytesOf(lines)))).toEqual({ code: 'IMPORT_EMPTY', status: 422 });
      // ATOMIC keeps saying what is wrong with the rows.
      const atomic = await stage(lines, 'ATOMIC');
      expect(await refusal(apply(atomic.id, bytesOf(lines)))).toEqual({ code: 'IMPORT_HAS_ERRORS', status: 422 });

      for (const batch of [empty, partial, atomic]) {
        expect((await as(CHECKER, (tx) => imports.find(tx, batch.id)))?.status).toBe('VALIDATED');
        expect(await owner('select count(*)::int as n from machvon.master_change_request where import_batch_id = $1', [batch.id])).toEqual([{ n: 0 }]);
      }
      expect(await recordsOf('NIL')).toEqual([]);
    });
  });

  describe('the lines of the source (Codex finding 5)', () => {
    it('names the line of the file for a row in error: blank lines and a cell that runs over two lines count', async () => {
      const text = `${HEADER}\nSRC-1,Right,2024-01-01,,,,NSTW,ADDITIVE\n\nSRC-2,"Two\nlines",2024-13-45,,,,NSTW,ADDITIVE\nSRC-3,No date,,,,,NSTW,ADDITIVE\n`;
      const bytes = new TextEncoder().encode(text);
      counter += 1;
      const staged = await as(IMPORTER, (tx) => imports.stage(tx, { masterType: 'FUND_SOURCE', fileObjectKey: `tenants/${TENANT_A}/import/lines-${counter}`, fileSha256: shaOf(bytes), mapping: MAPPING, mode: 'PARTIAL', bytes }, memberId(IMPORTER)));
      expect(staged.errors).toEqual([
        { row: 4, field: 'valid_from', code: 'INVALID_DATE' },
        { row: 6, field: 'valid_from', code: 'REQUIRED' },
      ]);
    });
  });

  describe('who applied the batch (Codex finding 4)', () => {
    it('keeps the person who applied it, who may be another than the one who staged it, and judges four-eyes on that person', async () => {
      const lines = sources('APB');
      const bytes = bytesOf(lines);
      counter += 1;
      const staged = await as(PUBLISHER, (tx) => imports.stage(tx, { masterType: 'FUND_SOURCE', fileObjectKey: `tenants/${TENANT_A}/import/applier-${counter}`, fileSha256: shaOf(bytes), mapping: MAPPING, mode: 'ATOMIC', bytes }, memberId(PUBLISHER)));
      expect(staged).toMatchObject({ createdBy: memberId(PUBLISHER), appliedBy: null });
      const applied = await apply(staged.id, bytes, IMPORTER);
      expect(applied.batch).toMatchObject({ createdBy: memberId(PUBLISHER), appliedBy: memberId(IMPORTER), status: 'IN_REVIEW' });
      expect((await refusal(decide(staged.id, 'approve', IMPORTER))).code).toBe('SELF_APPROVAL_DENIED');
      // The person who staged the file did not create the change requests: they may decide the batch.
      const approved = await decide(staged.id, 'approve', PUBLISHER);
      expect(approved.batch).toMatchObject({ reviewedBy: memberId(PUBLISHER), appliedBy: memberId(IMPORTER) });
      expect((await refusal(publish(staged.id, IMPORTER))).code).toBe('SELF_APPROVAL_DENIED');
      const published = await publish(staged.id, CHECKER);
      expect(published.batch).toMatchObject({ status: 'APPLIED', appliedBy: memberId(IMPORTER) });
      expect((await as(CHECKER, (tx) => imports.list(tx, { status: 'APPLIED', limit: 100, after: undefined }))).find((row) => row.id === staged.id)?.appliedBy).toBe(memberId(IMPORTER));
    });
  });

  describe('change requests that a batch owns (Codex finding 1)', () => {
    it('are decided and published only through the batch: the individual commands refuse them, and the batch still works afterwards', async () => {
      const prefix = 'OWN';
      const lines = sources(prefix);
      const staged = await stage(lines);
      await apply(staged.id, bytesOf(lines));
      const denied = { code: 'STAGE_TRANSITION_DENIED', status: 409, detail: 'import_batch' };
      const change = (await owner<{ id: string; version: string; master_record_id: string }>('select id, version::text as version, master_record_id from machvon.master_change_request where import_batch_id = $1 order by id limit 1', [staged.id]))[0] as {
        id: string;
        version: string;
        master_record_id: string;
      };
      for (const decision of ['approve', 'reject', 'return'] as const) {
        expect(await refusal(as(CHECKER, (tx) => store.decide(tx, change.id, Number(change.version), decision, memberId(CHECKER))))).toEqual(denied);
      }
      expect(await refusal(as(IMPORTER, (tx) => store.submit(tx, change.id, Number(change.version), memberId(IMPORTER))))).toEqual(denied);
      expect(await owner('select status from machvon.master_change_request where id = $1', [change.id])).toEqual([{ status: 'IN_REVIEW' }]);

      await decide(staged.id, 'approve');
      const record = (await owner<{ version: string }>('select version::text as version from machvon.master_record where id = $1', [change.master_record_id]))[0] as { version: string };
      expect(await refusal(as(PUBLISHER, (tx) => store.publish(tx, change.master_record_id, Number(record.version), DECISION_DOCUMENT, memberId(PUBLISHER))))).toEqual(denied);
      expect(new Set((await recordsOf(prefix)).map((row) => row.status))).toEqual(new Set(['APPROVED']));

      const published = await publish(staged.id);
      expect(published.published).toHaveLength(10);
      expect(new Set((await recordsOf(prefix)).map((row) => row.status))).toEqual(new Set(['EFFECTIVE']));
    });
  });

  describe('reading the batches', () => {
    it('lists the batches of the tenant newest first by status in pages, and counts the change requests of one', async () => {
      const all = await as(CHECKER, (tx) => imports.list(tx, { limit: 100, after: undefined }));
      expect(all.length).toBeGreaterThan(5);
      const times = all.map((row) => row.createdAtKey);
      expect([...times].sort().reverse()).toEqual(times);
      const applied = await as(CHECKER, (tx) => imports.list(tx, { status: 'APPLIED', limit: 100, after: undefined }));
      expect(applied.every((row) => row.status === 'APPLIED')).toBe(true);
      const first = all[0];
      const next = await as(CHECKER, (tx) => imports.list(tx, { limit: 100, after: { code: first?.createdAtKey ?? '', id: first?.id ?? '' } }));
      expect(next.map((row) => row.id)).toEqual(all.slice(1).map((row) => row.id));
      const publishedBatch = applied[0];
      expect(await as(CHECKER, (tx) => imports.changeCounts(tx, publishedBatch?.id ?? ''))).toEqual({ APPLIED: 10 });
      expect(await as(CHECKER, (tx) => imports.find(tx, id(0x7b, 2)))).toBeUndefined();
    });

    it('shows another tenant nothing of these batches', async () => {
      expect(await as(CHECKER, (tx) => imports.list(tx, { limit: 100, after: undefined }), TENANT_B)).toEqual([]);
    });
  });
});
