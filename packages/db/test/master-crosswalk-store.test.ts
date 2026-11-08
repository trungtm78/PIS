import { createHash, randomUUID } from 'node:crypto';
import { vietnamDateOf } from '@machvon/kernel';
import { MasterCrosswalkStore } from '../src/master-crosswalk-store';
import type { CrosswalkInput } from '../src/master-crosswalk-store';
import { MasterImportStore } from '../src/master-import-store';
import type { ImportMapping } from '../src/master-import-store';
import { MasterStore } from '../src/master-store';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, memberId } from './support/authz-fixtures';

const harness = new AuthzHarness();
const crosswalks = new MasterCrosswalkStore();
const imports = new MasterImportStore();
const masters = new MasterStore();
const ACTOR = 1;
const SYSTEM = 'TREASURY';
const TYPE = 'AGENCY_CODE';

const as = <T>(work: (tx: TenantTx) => Promise<T>, tenant = TENANT_A): Promise<T> => harness.tenants.withTenant(contextFor(tenant, memberId(ACTOR)), work);
const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);

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
/** An entry of the tenant (proposed, so it has a version) that a code can be mapped to. */
async function entry(masterType = 'FUND_SOURCE', status?: string): Promise<string> {
  counter += 1;
  const created = await as((tx) =>
    masters.propose(tx, { masterType, businessKey: `XW-${counter}-${randomUUID().slice(0, 6)}`, content: { label: `Entry ${counter}`, attributes: masterType === 'FUND_SOURCE' ? { category: 'NSTW', relation: 'ADDITIVE' } : { level: 'PROVINCE' }, parentRecordId: null, validFrom: '2024-01-01', validUntil: null, legalBasis: null }, reason: 'Initial entry' }, memberId(ACTOR)),
  );
  if (status !== undefined) await owner('update machvon.master_record set status = $2 where id = $1::uuid', [created.recordId, status]);
  return created.recordId;
}

const input = (masterRecordId: string, code: string, extra: Partial<CrosswalkInput> = {}): CrosswalkInput => ({
  masterRecordId,
  sourceSystem: SYSTEM,
  externalType: TYPE,
  externalCode: code,
  validFrom: '2024-01-01',
  matchMethod: 'MANUAL',
  ...extra,
});
const create = (data: CrosswalkInput, tenant = TENANT_A) => as((tx) => crosswalks.create(tx, data, memberId(ACTOR)), tenant);

describe('MasterCrosswalkStore (codes of other systems mapped to master data, ST-MDM-007)', () => {
  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [{ n: 1, path: '/u1/' }]);
      await harness.seedMembership(tenant, ACTOR, 1);
      await harness.owner(tenant, [["insert into machvon.master_type_policy (tenant_id, master_type, scope, updated_by) values ($1, 'FUND_SOURCE', 'TENANT_ONLY', $2)", [tenant, memberId(ACTOR)]]]);
    }
  }, 180_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  describe('mapping a code', () => {
    it('maps a code to an entry, and refuses a second ACTIVE mapping of the same code (AC-ST-MDM-007-1)', async () => {
      const record = await entry();
      const created = await create(input(record, 'KB-100', { confidence: 0.75, matchMethod: 'RULE' }));
      expect(created.version).toBe(1);
      const row = await as((tx) => crosswalks.find(tx, created.id));
      expect(row).toMatchObject({ masterRecordId: record, sourceSystem: SYSTEM, externalType: TYPE, externalCode: 'KB-100', status: 'ACTIVE', matchMethod: 'RULE', confidence: 0.75, validUntil: null, version: 1 });
      // The same code for another entry, and for the same one, are both the same fault.
      expect(await refusal(create(input(await entry(), 'KB-100')))).toEqual({ code: 'CROSSWALK_DUPLICATE', status: 409 });
      expect(await refusal(create(input(record, 'KB-100')))).toEqual({ code: 'CROSSWALK_DUPLICATE', status: 409 });
      // Another system, another code type and another tenant each have a code space of their own.
      await create(input(record, 'KB-100', { sourceSystem: 'NATIONAL_PIM' }));
      await create(input(record, 'KB-100', { externalType: 'ORGANIZATION_CODE' }));
      await expect(create(input(await entry(), 'KB-100'), TENANT_B)).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    });

    it('trims the code and refuses a code or a name that is empty, long or holds control characters', async () => {
      const record = await entry();
      const created = await create(input(record, '  KB-TRIM  ', { sourceSystem: ' TREASURY ' }));
      expect(await as((tx) => crosswalks.find(tx, created.id))).toMatchObject({ externalCode: 'KB-TRIM', sourceSystem: 'TREASURY' });
      expect(await refusal(create(input(record, '   ')))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'external_code' });
      expect(await refusal(create(input(record, 'x'.repeat(101))))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'external_code' });
      expect(await refusal(create(input(record, 'A\u0000B')))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'external_code' });
      expect(await refusal(create(input(record, 'KB-9', { sourceSystem: 'y'.repeat(51) })))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'source_system' });
      expect(await refusal(create(input(record, 'KB-9', { externalType: '' })))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'external_type' });
      expect(await refusal(create(input(record, 'KB-9', { confidence: 1.5 })))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'confidence' });
      expect(await refusal(create(input(record, 'KB-9', { confidence: Number.NaN })))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'confidence' });
    });

    it('refuses an entry that does not exist, one of another tenant, and one that was merged away', async () => {
      expect(await refusal(create(input(randomUUID(), 'KB-404')))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      const other = await as((tx) => masters.propose(tx, { masterType: 'FUND_SOURCE', businessKey: `OTH-${randomUUID().slice(0, 6)}`, content: { label: 'Other', attributes: { category: 'NSTW', relation: 'ADDITIVE' }, parentRecordId: null, validFrom: '2024-01-01', validUntil: null, legalBasis: null }, reason: 'Initial entry' }, memberId(ACTOR)), TENANT_B);
      expect(await refusal(create(input(other.recordId, 'KB-OTHER')))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      const survivor = await entry();
      const merged = await entry();
      await owner("update machvon.master_record set status = 'MERGED', merged_into_id = $2::uuid where id = $1::uuid", [merged, survivor]);
      expect(await refusal(create(input(merged, 'KB-MERGED')))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'master_record_id' });
    });
  });

  describe('retiring a mapping', () => {
    it('ends the mapping and keeps its row, and frees the code for a new mapping', async () => {
      const record = await entry();
      const created = await create(input(record, 'KB-RET'));
      const retired = await as((tx) => crosswalks.retire(tx, created.id, 1, memberId(ACTOR)));
      expect(retired.version).toBe(2);
      const row = await as((tx) => crosswalks.find(tx, created.id));
      expect(row).toMatchObject({ status: 'RETIRED', version: 2 });
      expect(row?.validUntil).not.toBeNull();
      const again = await create(input(await entry(), 'KB-RET'));
      expect(again.id).not.toBe(created.id);
      expect((await as((tx) => crosswalks.list(tx, { externalCode: 'KB-RET' }, { limit: 10, after: undefined }))).map((item) => item.status).sort()).toEqual(['ACTIVE', 'RETIRED']);
    });

    it('does not end a mapping before it began, and refuses a stale version, a second retirement and an unknown or foreign mapping', async () => {
      const record = await entry();
      const future = await create(input(record, 'KB-FUTURE', { validFrom: '2999-01-01' }));
      await as((tx) => crosswalks.retire(tx, future.id, 1, memberId(ACTOR)));
      expect((await as((tx) => crosswalks.find(tx, future.id)))?.validUntil).toBe('2999-01-01');
      const created = await create(input(record, 'KB-STALE'));
      await expect(as((tx) => crosswalks.retire(tx, created.id, 7, memberId(ACTOR)))).rejects.toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
      await as((tx) => crosswalks.retire(tx, created.id, 1, memberId(ACTOR)));
      expect(await refusal(as((tx) => crosswalks.retire(tx, created.id, 2, memberId(ACTOR))))).toEqual({ code: 'STAGE_TRANSITION_DENIED', status: 409, detail: 'status' });
      expect(await refusal(as((tx) => crosswalks.retire(tx, randomUUID(), 1, memberId(ACTOR))))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      const foreign = await create(input(record, 'KB-FOREIGN'));
      expect(await refusal(as((tx) => crosswalks.retire(tx, foreign.id, 1, memberId(ACTOR)), TENANT_B))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    });
  });

  describe('listing', () => {
    it('filters by system, code type, code, entry and status, newest first, in pages, inside the tenant', async () => {
      const record = await entry();
      const other = await entry();
      const system = `LIST${randomUUID().slice(0, 6)}`;
      const ids: string[] = [];
      for (const code of ['A', 'B', 'C']) ids.push((await create(input(record, code, { sourceSystem: system }))).id);
      const odd = await create(input(other, 'A', { sourceSystem: system, externalType: 'OTHER_TYPE' }));
      await as((tx) => crosswalks.retire(tx, ids[0] as string, 1, memberId(ACTOR)));

      const all = await as((tx) => crosswalks.list(tx, { sourceSystem: system }, { limit: 50, after: undefined }));
      expect(all.map((row) => row.id)).toEqual([odd.id, ...[...ids].reverse()]);
      expect(all[0]).toMatchObject({ masterType: 'FUND_SOURCE', externalType: 'OTHER_TYPE' });
      expect((await as((tx) => crosswalks.list(tx, { sourceSystem: system, status: 'ACTIVE', externalType: TYPE }, { limit: 50, after: undefined }))).map((row) => row.externalCode)).toEqual(['C', 'B']);
      expect((await as((tx) => crosswalks.list(tx, { sourceSystem: system, masterRecordId: other }, { limit: 50, after: undefined }))).map((row) => row.id)).toEqual([odd.id]);
      expect((await as((tx) => crosswalks.list(tx, { sourceSystem: system, externalCode: 'B' }, { limit: 50, after: undefined }))).map((row) => row.id)).toEqual([ids[1]]);

      const first = await as((tx) => crosswalks.list(tx, { sourceSystem: system }, { limit: 2, after: undefined }));
      const last = first[first.length - 1];
      const next = await as((tx) => crosswalks.list(tx, { sourceSystem: system }, { limit: 2, after: { code: last?.createdAtKey as string, id: last?.id as string } }));
      expect([...first, ...next].map((row) => row.id)).toEqual(all.map((row) => row.id).slice(0, 4));
      expect(await as((tx) => crosswalks.list(tx, { sourceSystem: system }, { limit: 50, after: undefined }), TENANT_B)).toEqual([]);
    });
  });

  describe('translating codes', () => {
    it('answers the codes that have an ACTIVE mapping in force on the date and no others', async () => {
      const system = `RES${randomUUID().slice(0, 6)}`;
      const a = await entry();
      const b = await entry();
      const retired = await entry();
      const gone = await entry();
      const mapped = await create(input(a, 'ONE', { sourceSystem: system }));
      await create(input(b, 'TWO', { sourceSystem: system, validFrom: '2999-01-01' }));
      const ended = await create(input(retired, 'THREE', { sourceSystem: system }));
      await as((tx) => crosswalks.retire(tx, ended.id, 1, memberId(ACTOR)));
      await create(input(gone, 'FOUR', { sourceSystem: system }));
      await owner("update machvon.master_record set status = 'RETIRED' where id = $1::uuid", [gone]);
      expect(mapped.version).toBe(1);
      const found = await as((tx) => crosswalks.resolve(tx, system, TYPE, ['ONE', 'TWO', 'THREE', 'FOUR', 'FIVE']));
      expect([...found.keys()]).toEqual(['ONE']);
      expect(found.get('ONE')).toMatchObject({ recordId: a, masterType: 'FUND_SOURCE' });
      expect([...(await as((tx) => crosswalks.resolve(tx, system, TYPE, ['TWO'], '2999-06-01'))).keys()]).toEqual(['TWO']);
      expect((await as((tx) => crosswalks.resolve(tx, system, TYPE, []))).size).toBe(0);
      expect((await as((tx) => crosswalks.resolve(tx, system, TYPE, ['ONE']), TENANT_B)).size).toBe(0);
    });
  });

  describe('the alias of a tenant on an entry of the platform (AC-ST-MDM-002-2)', () => {
    const ALIAS = 'TENANT_ALIAS';
    const TODAY = vietnamDateOf(new Date());
    const alias = (masterRecordId: string, kind: string, code: string, extra: Partial<CrosswalkInput> = {}): CrosswalkInput => ({ masterRecordId, sourceSystem: ALIAS, externalType: kind, externalCode: code, validFrom: '2024-01-01', matchMethod: 'MANUAL', ...extra });

    /** An entry of the platform namespace with a version in force, as the baseline leaves the national catalogues. */
    async function platformEntry(masterType = 'FUND_SOURCE'): Promise<{ id: string; label: string }> {
      counter += 1;
      const recordId = randomUUID();
      const label = `Platform entry ${counter}`;
      await harness.owner(TENANT_A, [
        [`insert into machvon.master_record (tenant_id, id, namespace, master_type, business_key, status, created_by, updated_by) values ($1, $2, 'PLATFORM', $3, $4, 'EFFECTIVE', $5, $5)`, [TENANT_A, recordId, masterType, `PLAT-${counter}`, memberId(ACTOR)]],
        [
          `insert into machvon.master_record_version (tenant_id, id, master_record_id, master_type, code, revision, label, attributes, valid_from, status, namespace, published_at, created_by, updated_by)
           values ($1, $2, $3, $4, $5, 1, $6, '{}'::jsonb, '2020-01-01', 'EFFECTIVE', 'PLATFORM', now(), $7, $7)`,
          [TENANT_A, randomUUID(), recordId, masterType, `PLAT-${counter}`, label, memberId(ACTOR)],
        ],
      ]);
      return { id: recordId, label };
    }
    const found = async (recordId: string) => (await as((tx) => masters.search(tx, { masterType: 'FUND_SOURCE', asOf: TODAY, limit: 500, after: undefined }))).find((row) => row.id === recordId);
    const stored = (recordId: string) =>
      owner('select r.version::text as version, r.business_key, v.label, v.code, v.revision from machvon.master_record r join machvon.master_record_version v on v.master_record_id = r.id where r.id = $1::uuid', [recordId]);

    it('AC-ST-MDM-002-2: overrides the label and the order of a platform entry through the alias, and leaves the entry, its code and its name as the platform made them', async () => {
      const record = await platformEntry();
      const before = await stored(record.id);
      expect(await found(record.id)).toMatchObject({ aliasLabel: null, aliasOrder: null, displayLabel: record.label, displayOrder: null });
      const label = await create(alias(record.id, 'LABEL', '  Nguồn vốn trung ương  '));
      const order = await create(alias(record.id, 'ORDER', '007'));
      expect(await as((tx) => crosswalks.find(tx, label.id))).toMatchObject({ sourceSystem: ALIAS, externalType: 'LABEL', externalCode: 'Nguồn vốn trung ương', status: 'ACTIVE', matchMethod: 'MANUAL' });
      expect(await as((tx) => crosswalks.find(tx, order.id))).toMatchObject({ externalType: 'ORDER', externalCode: '7' });
      expect(await found(record.id)).toMatchObject({ aliasLabel: 'Nguồn vốn trung ương', aliasOrder: 7, displayLabel: 'Nguồn vốn trung ương', displayOrder: 7, label: record.label });
      expect(await stored(record.id)).toEqual(before);
    });

    it('AC-ST-MDM-002-2: one ACTIVE alias of each kind for an entry (409 CROSSWALK_DUPLICATE), changed by retiring it and making another; other entries may use the same label and the same order', async () => {
      const record = await platformEntry();
      const other = await platformEntry();
      const first = await create(alias(record.id, 'LABEL', 'Tên một'));
      expect(await refusal(create(alias(record.id, 'LABEL', 'Tên hai')))).toEqual({ code: 'CROSSWALK_DUPLICATE', status: 409 });
      expect((await create(alias(other.id, 'LABEL', 'Tên một'))).version).toBe(1);
      await create(alias(record.id, 'ORDER', '10'));
      await create(alias(other.id, 'ORDER', '10'));
      await as((tx) => crosswalks.retire(tx, first.id, 1, memberId(ACTOR)));
      await create(alias(record.id, 'LABEL', 'Tên hai'));
      expect(await found(record.id)).toMatchObject({ aliasLabel: 'Tên hai', displayOrder: 10 });
    });

    it('AC-ST-MDM-002-2: an alias is not in force before its day and not after it is retired', async () => {
      const record = await platformEntry();
      const later = await create(alias(record.id, 'LABEL', 'Tên sau này', { validFrom: '2999-01-01' }));
      expect(await found(record.id)).toMatchObject({ aliasLabel: null, displayLabel: record.label });
      await as((tx) => crosswalks.retire(tx, later.id, 1, memberId(ACTOR)));
      const now = await create(alias(record.id, 'ORDER', '3'));
      expect(await found(record.id)).toMatchObject({ aliasOrder: 3 });
      await as((tx) => crosswalks.retire(tx, now.id, 1, memberId(ACTOR)));
      expect(await found(record.id)).toMatchObject({ aliasOrder: null });
    });

    it('AC-ST-MDM-002-2: only a label or an order, made by hand, on an entry of the platform; the code is never an alias', async () => {
      const record = await platformEntry();
      expect(await refusal(create(alias(record.id, 'CODE', 'NEW-CODE')))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'external_type' });
      expect(await refusal(create(alias(record.id, 'NAME', 'Tên')))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'external_type' });
      for (const bad of ['-1', '1.5', 'abc', '1234567', '١٢']) expect(await refusal(create(alias(record.id, 'ORDER', bad)))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'external_code' });
      expect(await refusal(create(alias(record.id, 'LABEL', 'Tên', { matchMethod: 'IMPORT' })))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'match_method' });
      expect(await refusal(create(alias(record.id, 'LABEL', 'Tên', { confidence: 0.5 })))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'confidence' });
      // An entry the tenant owns is edited through its own change requests: an alias on it would only be a second name.
      const own = await entry('FUND_SOURCE');
      expect(await refusal(create(alias(own, 'LABEL', 'Tên riêng')))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'master_record_id' });
      expect(await owner("select id from machvon.master_crosswalk where master_record_id in ($1::uuid, $2::uuid) and source_system = 'TENANT_ALIAS'", [record.id, own])).toEqual([]);
    });

    it('is kept by the database too: the kind, the order, the method and the platform namespace are checked around the commands, and one ACTIVE alias of a kind per entry', async () => {
      const record = await platformEntry();
      const own = await entry('FUND_SOURCE');
      const raw = async (target: string, kind: string, code: string, method = 'MANUAL'): Promise<{ code?: string; constraint?: string }> => {
        try {
          await owner(
            `insert into machvon.master_crosswalk (tenant_id, id, master_record_id, source_system, external_type, external_code, valid_from, match_method, status, created_by, updated_by)
             values ($1, $2, $3, 'TENANT_ALIAS', $4, $5, '2024-01-01', $6, 'ACTIVE', $7, $7)`,
            [TENANT_A, randomUUID(), target, kind, code, method, memberId(ACTOR)],
          );
        } catch (error) {
          return error as { code?: string; constraint?: string };
        }
        return {};
      };
      expect((await raw(record.id, 'CODE', 'X')).constraint).toBe('master_crosswalk_alias_chk');
      expect((await raw(record.id, 'ORDER', 'ten')).constraint).toBe('master_crosswalk_alias_chk');
      expect((await raw(record.id, 'LABEL', 'Tên', 'RULE')).constraint).toBe('master_crosswalk_alias_chk');
      expect((await raw(own, 'LABEL', 'Tên')).code).toBe('23514');
      expect(await raw(record.id, 'LABEL', 'Tên một')).toEqual({});
      expect((await raw(record.id, 'LABEL', 'Tên hai')).constraint).toBe('master_crosswalk_alias_uq');
    });

    it('keeps the code space of the other systems as it was: one ACTIVE mapping of a code, whatever an alias says', async () => {
      const record = await platformEntry();
      await create(alias(record.id, 'LABEL', 'KB-ALIAS'));
      await create(input(record.id, 'KB-ALIAS'));
      expect(await refusal(create(input(await entry(), 'KB-ALIAS')))).toEqual({ code: 'CROSSWALK_DUPLICATE', status: 409 });
    });
  });

  describe('importing codes of another system (AC-ST-MDM-007-3)', () => {
    const HEADER = 'Mã,Tên,Từ ngày,Mã cha KB,Nguồn KB,Loại,Quan hệ';
    const MAPPING: ImportMapping = {
      key: 'Mã',
      label: 'Tên',
      valid_from: 'Từ ngày',
      parent_key: 'Mã cha KB',
      attributes: { category: 'Loại', relation: 'Quan hệ' },
      crosswalk: { source_system: SYSTEM, external_type: TYPE, fields: ['parent_key'] },
    };
    const shaOf = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
    const stage = (lines: readonly string[], mapping: unknown = MAPPING, mode: 'ATOMIC' | 'PARTIAL' = 'PARTIAL') => {
      const bytes = new TextEncoder().encode(`${HEADER}\n${lines.join('\n')}\n`);
      return as((tx) => imports.stage(tx, { masterType: 'FUND_SOURCE', fileObjectKey: `tenants/${TENANT_A}/import/${randomUUID()}`, fileSha256: shaOf(bytes), mapping, mode, bytes }, memberId(ACTOR)));
    };

    it('translates the parent from its external code, and says CROSSWALK_MISSING for a code without a mapping', async () => {
      const parent = await entry();
      const parentKey = (await owner<{ business_key: string }>('select business_key from machvon.master_record where id = $1::uuid', [parent]))[0]?.business_key as string;
      await create(input(parent, 'KB-PARENT-1'));
      const retired = await entry();
      const gone = await create(input(retired, 'KB-PARENT-GONE'));
      await as((tx) => crosswalks.retire(tx, gone.id, 1, memberId(ACTOR)));
      const wrongType = await entry('TREASURY_OFFICE');
      await create(input(wrongType, 'KB-OFFICE'));
      const batch = await stage([
        'IMP-A,Có ánh xạ,2024-01-01,KB-PARENT-1,,NSTW,ADDITIVE',
        'IMP-B,Chưa ánh xạ,2024-01-01,KB-NOPE,,NSTW,ADDITIVE',
        'IMP-C,Ánh xạ đã kết thúc,2024-01-01,KB-PARENT-GONE,,NSTW,ADDITIVE',
        'IMP-D,Khác loại,2024-01-01,KB-OFFICE,,NSTW,ADDITIVE',
        'IMP-E,Không có cha,2024-01-01,,,NSTW,ADDITIVE',
      ]);
      expect(batch.errors).toEqual([
        { row: 3, field: 'parent_key', code: 'CROSSWALK_MISSING' },
        { row: 4, field: 'parent_key', code: 'CROSSWALK_MISSING' },
        { row: 5, field: 'parent_key', code: 'PARENT_NOT_FOUND' },
      ]);
      expect(batch).toMatchObject({ totalRows: 5, errorRows: 3 });
      expect(parentKey).toMatch(/^XW-/);
      // The row with a mapping is the one that would be created; nothing is created by staging.
      expect(await owner("select 1 from machvon.master_record where business_key like 'IMP-%'")).toEqual([]);
      const strict = await stage(['IMP-F,Chưa ánh xạ,2024-01-01,KB-NOPE,,NSTW,ADDITIVE'], MAPPING, 'ATOMIC');
      const bytes = new TextEncoder().encode(`${HEADER}\nIMP-F,Chưa ánh xạ,2024-01-01,KB-NOPE,,NSTW,ADDITIVE\n`);
      await expect(as((tx) => imports.apply(tx, strict.id, strict.version, bytes, memberId(ACTOR)))).rejects.toMatchObject({ code: 'IMPORT_HAS_ERRORS' });
      expect(await owner("select 1 from machvon.master_record where business_key = 'IMP-F'")).toEqual([]);
    });

    it('attaches the child to the very record that the code is mapped to, not to a row of the file that shares its key', async () => {
      const parent = await entry();
      const parentKey = (await owner<{ business_key: string }>('select business_key from machvon.master_record where id = $1::uuid', [parent]))[0]?.business_key as string;
      await create(input(parent, 'KB-PINNED'));
      const lines = [`${parentKey},Trùng khóa với cha,2024-01-01,,,NSTW,ADDITIVE`, 'PIN-B,Con,2024-01-01,KB-PINNED,,NSTW,ADDITIVE'];
      const batch = await stage(lines);
      // The first row is the fault (the key is held); the second has its parent and is not skipped because of it.
      expect(batch.errors).toEqual([{ row: 2, field: 'business_key', code: 'DUPLICATE_KEY' }]);
      const bytes = new TextEncoder().encode([HEADER, ...lines, ''].join('\n'));
      const applied = await as((tx) => imports.apply(tx, batch.id, batch.version, bytes, memberId(ACTOR)));
      expect(applied).toMatchObject({ created: 1, skipped: 1 });
      const child = await owner<{ parent_id: string | null }>("select v.parent_id from machvon.master_record_version v join machvon.master_record r on r.id = v.master_record_id where r.business_key = 'PIN-B'");
      expect(child).toEqual([{ parent_id: parent }]);
    });

    it('translates an attribute that refers to an entry, and refuses a mapping of the translation that is not well formed', async () => {
      const priority = await as((tx) =>
        masters.propose(tx, { masterType: 'PRIORITY', businessKey: 'URGENT-KB', content: { label: 'Urgent', attributes: { rank: 1, response_hours: 1, resolution_hours: 4, working_calendar: 'ALL_DAYS' }, parentRecordId: null, validFrom: '2024-01-01', validUntil: null, legalBasis: null }, reason: 'Initial entry' }, memberId(ACTOR)),
      );
      await create(input(priority.recordId, 'KB-PRIORITY-1'));
      const mapped: ImportMapping = {
        key: 'Mã',
        label: 'Tên',
        valid_from: 'Từ ngày',
        attributes: { sla_priority_key: 'Nguồn KB' },
        crosswalk: { source_system: SYSTEM, external_type: TYPE, fields: ['attributes.sla_priority_key'] },
      };
      const bytes = new TextEncoder().encode(`${HEADER}
CAT-A,Thiếu,2024-01-01,,KB-NOPE,,
CAT-B,Có,2024-01-01,,KB-PRIORITY-1,,
`);
      const batch = await as((tx) => imports.stage(tx, { masterType: 'ISSUE_CATEGORY', fileObjectKey: `tenants/${TENANT_A}/import/${randomUUID()}`, fileSha256: shaOf(bytes), mapping: mapped, mode: 'PARTIAL', bytes }, memberId(ACTOR)));
      expect(batch.errors).toEqual([{ row: 2, field: 'attributes.sla_priority_key', code: 'CROSSWALK_MISSING' }]);
      expect(batch.errorRows).toBe(1);
      // A code that stands for an entry of another type is not the priority that happens to share its key.
      const office = await entry('TREASURY_OFFICE');
      await create(input(office, 'KB-OFFICE-AS-PRIORITY'));
      const officeKey = (await owner<{ business_key: string }>('select business_key from machvon.master_record where id = $1::uuid', [office]))[0]?.business_key as string;
      await as((tx) =>
        masters.propose(tx, { masterType: 'PRIORITY', businessKey: officeKey, content: { label: 'Same key', attributes: { rank: 2, response_hours: 1, resolution_hours: 4, working_calendar: 'ALL_DAYS' }, parentRecordId: null, validFrom: '2024-01-01', validUntil: null, legalBasis: null }, reason: 'Initial entry' }, memberId(ACTOR)),
      );
      const wrong = new TextEncoder().encode(`${HEADER}
CAT-C,Sai loại,2024-01-01,,KB-OFFICE-AS-PRIORITY,,
`);
      const refused = await as((tx) => imports.stage(tx, { masterType: 'ISSUE_CATEGORY', fileObjectKey: `tenants/${TENANT_A}/import/${randomUUID()}`, fileSha256: shaOf(wrong), mapping: mapped, mode: 'PARTIAL', bytes: wrong }, memberId(ACTOR)));
      expect(refused.errors).toEqual([{ row: 2, field: 'attributes.sla_priority_key', code: 'INVALID_VALUE' }]);

      const bad = (crosswalk: unknown) => refusal(stage(['IMP-X,X,2024-01-01,,,NSTW,ADDITIVE'], { ...MAPPING, crosswalk }));
      expect(await bad('x')).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'mapping.crosswalk' });
      expect(await bad({ source_system: SYSTEM, external_type: TYPE, fields: [] })).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'mapping.crosswalk' });
      expect(await bad({ source_system: SYSTEM, external_type: TYPE, fields: ['label'] })).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'mapping.crosswalk' });
      expect(await bad({ source_system: SYSTEM, external_type: TYPE, fields: ['parent_key', 'parent_key'] })).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'mapping.crosswalk' });
      expect(await bad({ source_system: '', external_type: TYPE, fields: ['parent_key'] })).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'mapping.crosswalk' });
      // An alias is a label of the tenant, not the code of another system: it never translates the codes of a file.
      expect(await bad({ source_system: 'TENANT_ALIAS', external_type: 'LABEL', fields: ['parent_key'] })).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'mapping.crosswalk' });
      expect(await bad({ source_system: SYSTEM, external_type: 7, fields: ['parent_key'] })).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'mapping.crosswalk' });
      expect(await bad({ source_system: SYSTEM, external_type: TYPE, fields: ['parent_key'], surprise: 1 })).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'mapping.crosswalk' });
    });
  });
});
