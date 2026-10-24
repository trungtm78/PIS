import { randomUUID } from 'node:crypto';
import { vietnamDateOf } from '@machvon/kernel';
import type { EffectiveAccess, Scope } from '@machvon/kernel';
import { BASELINE_PACK, applyBaseline } from '../src/master-baseline';
import { MasterStore } from '../src/master-store';
import { PrjProjectStore, projectScope, wholeVnd } from '../src/prj-project-store';
import type { NewProject, ProfileChange, UpdateScopes } from '../src/prj-project-store';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, memberId, unitId } from './support/authz-fixtures';

const harness = new AuthzHarness();
const store = new PrjProjectStore();
const ACTOR = 1;
const LEADER = 2;
const WORKER = '00000000-0000-4000-8000-000000000000';
const TODAY = vietnamDateOf(new Date());
const READ = 'project.read';
const UPDATE = 'project.update';
// Units: 1 is the province (/u1/), 2 the department below it (/u1/u2/), 3 another branch (/u3/), 4 is dissolved.
const PROVINCE = 1;
const DEPARTMENT = 2;
const OTHER_BRANCH = 3;
const DISSOLVED = 4;

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

const grant = (permission: string, scope: Scope): EffectiveAccess => ({
  membershipId: memberId(ACTOR),
  scopeVersion: 1,
  membershipActive: true,
  grants: [{ roleCode: 'TEST', rank: 10, permissions: [permission], scope, status: 'Active', effectiveFrom: new Date('2026-01-01T00:00:00Z'), effectiveUntil: null }],
});
const WHOLE_TENANT = grant(READ, { kind: 'TENANT' });
const readOf = (access: EffectiveAccess) => projectScope(access, READ, new Date());
const scopesOf = (update: EffectiveAccess, read: EffectiveAccess = update): UpdateScopes => ({ update: projectScope(update, UPDATE, new Date()), read: projectScope(read, READ, new Date()) });
const EVERYWHERE: UpdateScopes = { update: projectScope(grant(UPDATE, { kind: 'TENANT' }), UPDATE, new Date()), read: readOf(WHOLE_TENANT) };

/** The master versions the tests choose from: one in force of each type, and the ones that are not. */
const versions: Record<string, string> = {};
/** The record each seeded version belongs to. */
const records: Record<string, string> = {};
let counter = 0;

async function seedVersion(name: string, masterType: string, overrides: { recordStatus?: string; versionStatus?: string; validFrom?: string; validUntil?: string | null; published?: boolean } = {}, tenant = TENANT_A): Promise<string> {
  counter += 1;
  const recordId = randomUUID();
  const versionId = randomUUID();
  const key = `${name}-${counter}`;
  await harness.owner(tenant, [
    [
      // A merged entry names the one it was merged into: the first effective entry of the type.
      `insert into machvon.master_record (tenant_id, id, namespace, master_type, business_key, status, merged_into_id, created_by, updated_by)
       values ($1, $2, 'TENANT', $3, $4, $5, case when $5 = 'MERGED' then (select id from machvon.master_record where master_type = $3 and status = 'EFFECTIVE' limit 1) end, $6, $6)`,
      [tenant, recordId, masterType, key, overrides.recordStatus ?? 'EFFECTIVE', memberId(ACTOR)],
    ],
    [
      `insert into machvon.master_record_version (tenant_id, id, master_type, code, revision, label, attributes, valid_from, valid_until, status, master_record_id, published_at, created_by, updated_by)
       values ($1, $2, $3, $4, 1, $5, '{}'::jsonb, $6::date, $7::date, $8, $9, case when $10::boolean then now() end, $11, $11)`,
      [tenant, versionId, masterType, key, `Label ${key}`, overrides.validFrom ?? '2020-01-01', overrides.validUntil ?? null, overrides.versionStatus ?? 'EFFECTIVE', recordId, overrides.published ?? true, memberId(ACTOR)],
    ],
  ]);
  records[versionId] = recordId;
  return versionId;
}

const input = (code: string, extra: Partial<NewProject> = {}): NewProject => ({
  code,
  name: `Project ${code}`,
  ownerUnitId: unitId(DEPARTMENT),
  areaMasterVersionId: versions.area as string,
  totalInvestmentVnd: '500000000000',
  ...extra,
});
const create = (data: NewProject, tenant = TENANT_A) => as((tx) => store.create(tx, data, memberId(ACTOR), TODAY), tenant);
const update = (projectId: string, version: number, change: ProfileChange, scopes: UpdateScopes = EVERYWHERE, tenant = TENANT_A) =>
  as((tx) => store.updateProfile(tx, projectId, version, change, memberId(ACTOR), scopes, TODAY), tenant);
const find = (projectId: string, access: EffectiveAccess = WHOLE_TENANT, tenant = TENANT_A) => as((tx) => store.find(tx, projectId, readOf(access)), tenant);
const row = async (projectId: string) => (await owner<Record<string, unknown>>('select * from machvon.project where id = $1::uuid', [projectId]))[0];

describe('PrjProjectStore (the project register, ST-PRJ-001)', () => {
  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: PROVINCE, path: '/u1/' },
        { n: DEPARTMENT, path: '/u1/u2/', parent: PROVINCE },
        { n: OTHER_BRANCH, path: '/u3/' },
        { n: DISSOLVED, path: '/u4/' },
      ]);
      await harness.seedMembership(tenant, ACTOR, PROVINCE);
      await harness.seedMembership(tenant, LEADER, DEPARTMENT);
      await harness.owner(tenant, [["update machvon.organization_unit set status = 'Dissolved' where id = $1", [unitId(DISSOLVED)]]]);
      await harness.tenants.withTenant({ tenantId: tenant, membershipId: WORKER, scopeVersion: 0 }, (tx) => applyBaseline(tx, BASELINE_PACK, WORKER, TODAY));
    }
    versions.area = await seedVersion('AREA', 'AREA');
    versions.area2 = await seedVersion('ADMIN', 'ADMIN_UNIT');
    versions.sector = await seedVersion('SECTOR', 'SECTOR');
    versions.sector2 = await seedVersion('SECTOR', 'SECTOR');
    versions.type = await seedVersion('TYPE', 'PROJECT_TYPE');
    versions.program = await seedVersion('PROGRAM', 'PROGRAM');
    versions.expired = await seedVersion('OLD', 'SECTOR', { versionStatus: 'RETIRED', validUntil: '2024-01-01' });
    versions.future = await seedVersion('FUTURE', 'SECTOR', { validFrom: '2999-01-01' });
    versions.unpublished = await seedVersion('DRAFT', 'SECTOR', { versionStatus: 'DRAFT', published: false });
    versions.retiredRecord = await seedVersion('RET', 'SECTOR', { recordStatus: 'RETIRED' });
    versions.mergedRecord = await seedVersion('MRG', 'SECTOR', { recordStatus: 'MERGED' });
    versions.foreign = await seedVersion('SECTOR', 'SECTOR', {}, TENANT_B);
    versions.wrongType = await seedVersion('PRIORITY', 'PRIORITY');
  }, 240_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  describe('creating a project', () => {
    it('creates a CONCEPT project at version 1 with its first revision, and refuses the same code in the tenant but not in another (AC-ST-PRJ-001-1)', async () => {
      const created = await create(input('DA-2026-001', { sectorMasterVersionId: versions.sector as string, startYear: 2026, endYear: 2028 }));
      expect(created).toMatchObject({ version: 1, status: 'CONCEPT', classification: 'INTERNAL' });
      expect(await row(created.id)).toMatchObject({ code: 'DA-2026-001', status: 'CONCEPT', version: '1', total_investment_vnd: '500000000000', start_year: 2026, end_year: 2028, created_by: memberId(ACTOR) });
      const revisions = await owner<Record<string, unknown>>('select revision, change_kind, status, before_json, after_json, total_investment_vnd from machvon.project_revision where project_id = $1::uuid', [created.id]);
      expect(revisions).toHaveLength(1);
      expect(revisions[0]).toMatchObject({ revision: 1, change_kind: 'INITIAL', status: 'DRAFT', before_json: {}, total_investment_vnd: '500000000000' });
      expect(revisions[0]?.after_json).toMatchObject({ code: 'DA-2026-001', total_investment_vnd: '500000000000', group_suggestion: { group_key: 'B' } });

      expect(await refusal(create(input('DA-2026-001')))).toEqual({ code: 'PROJECT_CODE_DUPLICATE', status: 409 });
      expect(await owner('select count(*)::int as n from machvon.project where code = $1', ['DA-2026-001'])).toEqual([{ n: 1 }]);
      // The second tenant has its own units and master data: the same code is a different project there.
      const other = await create(input('DA-2026-001', { areaMasterVersionId: await seedVersion('AREA', 'AREA', {}, TENANT_B) }), TENANT_B);
      expect(other).toMatchObject({ status: 'CONCEPT', version: 1 });
    });

    it('finds the organisation unit that a scope is judged by, and none for a unit that does not exist', async () => {
      expect(await as((tx) => store.unitRef(tx, unitId(DEPARTMENT)))).toEqual({ id: unitId(DEPARTMENT), path: '/u1/u2/' });
      expect(await as((tx) => store.unitRef(tx, randomUUID()))).toBeUndefined();
    });

    it('suggests the group by the rule in force on the proposal date and says that the rule still waits for its confirmation', async () => {
      const created = await create(input('DA-GROUP-1', { totalInvestmentVnd: '119999999999' }));
      expect(created.groupSuggestion).toMatchObject({ groupKey: 'C', asOf: TODAY, awaitingConfirmation: true, cxn: 'CXN-32' });
      expect(created.groupSuggestion?.ruleVersionId).toEqual(expect.any(String));
      const big = await create(input('DA-GROUP-2', { totalInvestmentVnd: '30000000000000' }));
      expect(big.groupSuggestion?.groupKey).toBe('QTQG');
      const detail = await find(big.id);
      expect(detail?.proposedOn).toBe(TODAY);
      expect(await as((tx) => store.suggestGroup(tx, detail?.sector ?? null, '500', '2024-12-31'))).toBeNull();
    });

    it('keeps the amount as whole dong: 1000.00 is 1000, a fraction or a negative or a too long amount is refused', async () => {
      expect(wholeVnd('1000.00')).toBe('1000');
      expect(wholeVnd('0')).toBe('0');
      for (const bad of ['1000.5', '-1', '01', '', '1e3', `1${'0'.repeat(24)}`]) expect(() => wholeVnd(bad)).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED', detail: 'total_investment_vnd' }));
      const created = await create(input('DA-MONEY-1', { totalInvestmentVnd: '2000.00' }));
      expect((await row(created.id))?.total_investment_vnd).toBe('2000');
    });

    it('refuses a name, a code, a year, a classification and a unit that are not valid, and leaves nothing behind', async () => {
      const cases: Array<[NewProject, string]> = [
        [input('X1', { name: 'ab' }), 'name'],
        [input('X1', { name: 'x'.repeat(501) }), 'name'],
        [input('   '), 'code'],
        [input('X'.repeat(51)), 'code'],
        [input('A\u0000B'), 'code'],
        [input('X2', { startYear: 2030, endYear: 2026 }), 'end_year'],
        [input('X3', { startYear: 1989 }), 'start_year'],
        [input('X4', { endYear: 2101 }), 'end_year'],
        [input('X5', { classification: 'SECRET' as never }), 'classification'],
        [input('X6', { ownerUnitId: randomUUID() }), 'owner_unit_id'],
        [input('X7', { ownerUnitId: unitId(DISSOLVED) }), 'owner_unit_id'],
        [input('X8', { investorUnitId: randomUUID() }), 'investor_unit_id'],
        [input('X9', { decisionAuthorityUnitId: unitId(DISSOLVED) }), 'decision_authority_unit_id'],
      ];
      for (const [data, field] of cases) expect(await refusal(create(data))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: field });
      expect(await owner("select count(*)::int as n from machvon.project where code like 'X%'")).toEqual([{ n: 0 }]);
    });

    it('trims the code and the name, and keeps the classification and the units it was given', async () => {
      const created = await create(input('  DA-TRIM  ', { name: '  Cầu qua sông  ', classification: 'CONFIDENTIAL', investorUnitId: unitId(PROVINCE), decisionAuthorityUnitId: unitId(PROVINCE) }));
      expect(created.classification).toBe('CONFIDENTIAL');
      expect(await row(created.id)).toMatchObject({ code: 'DA-TRIM', name: 'Cầu qua sông', classification: 'CONFIDENTIAL', investor_unit_id: unitId(PROVINCE), decision_authority_unit_id: unitId(PROVINCE) });
    });

    it('counts a project in the impact preview and the usage of every entry it names, so a change of the entry shows who is affected', async () => {
      const sectorVersion = await seedVersion('IMPACT-SECTOR', 'SECTOR');
      const areaVersion = await seedVersion('IMPACT-AREA', 'AREA');
      const created = await create(input('IMPACT-1', { areaMasterVersionId: areaVersion, sectorMasterVersionId: sectorVersion, projectTypeMasterVersionId: versions.type as string }));
      const usage = (versionId: string) => as((tx) => new MasterStore().usage(tx, records[versionId] as string));
      expect(await usage(sectorVersion)).toMatchObject({ total: 1, counts: { 'project.sector_master_version_id': 1 }, samples: [{ reference: 'project.sector_master_version_id', id: created.id }] });
      expect(await usage(areaVersion)).toMatchObject({ total: 1, counts: { 'project.area_master_version_id': 1 } });
      expect((await usage(versions.type as string)).counts['project.project_type_master_version_id']).toBeGreaterThanOrEqual(1);
      expect(await usage(versions.sector2 as string)).toMatchObject({ total: 0, counts: {} });
    });

    it('takes only master data that is in force today and of the type of the field (MASTER_NOT_EFFECTIVE)', async () => {
      const refused = async (field: keyof NewProject, version: string) => refusal(create(input(`M-${counter++}`, { [field]: version } as Partial<NewProject>)));
      for (const stale of ['expired', 'future', 'unpublished', 'retiredRecord', 'mergedRecord']) {
        expect(await refused('sectorMasterVersionId', versions[stale] as string)).toEqual({ code: 'MASTER_NOT_EFFECTIVE', status: 422, detail: 'sector_master_version_id' });
      }
      expect(await refused('areaMasterVersionId', versions.expired as string)).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'area_master_version_id' });
      // A version of another tenant, an unknown one and one of another type are indistinguishable faults of the request.
      for (const wrong of [versions.foreign as string, randomUUID(), versions.wrongType as string, versions.type as string]) {
        expect(await refused('sectorMasterVersionId', wrong)).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'sector_master_version_id' });
      }
      expect(await refused('projectTypeMasterVersionId', versions.sector as string)).toMatchObject({ detail: 'project_type_master_version_id' });
      expect(await refused('programMasterVersionId', versions.sector as string)).toMatchObject({ detail: 'program_master_version_id' });
      const fine = await create(input('M-OK', { areaMasterVersionId: versions.area2 as string, projectTypeMasterVersionId: versions.type as string, programMasterVersionId: versions.program as string }));
      expect(fine.version).toBe(1);
    });
  });

  describe('reading the register in the scope of the caller', () => {
    let inProvince: string;
    let inDepartment: string;
    let inOtherBranch: string;
    let investedByDepartment: string;

    beforeAll(async () => {
      inProvince = (await create(input('R-1', { ownerUnitId: unitId(PROVINCE) }))).id;
      inDepartment = (await create(input('R-2', { ownerUnitId: unitId(DEPARTMENT) }))).id;
      inOtherBranch = (await create(input('R-3', { ownerUnitId: unitId(OTHER_BRANCH) }))).id;
      investedByDepartment = (await create(input('R-4', { ownerUnitId: unitId(OTHER_BRANCH), investorUnitId: unitId(DEPARTMENT) }))).id;
      await owner(
        `insert into machvon.project_accountability (tenant_id, id, project_id, leader_membership_id, accountability_role, valid_from, status, created_by, updated_by)
         values ($1, $2, $3, $4, 'LEADER_IN_CHARGE', '2026-01-01', 'ACTIVE', $5, $5)`,
        [TENANT_A, randomUUID(), inDepartment, memberId(LEADER), memberId(ACTOR)],
      );
    });

    const codes = async (access: EffectiveAccess, tenant = TENANT_A): Promise<string[]> =>
      (await as((tx) => store.list(tx, readOf(access), { limit: 200, after: undefined }), tenant)).map((item) => item.code).filter((code) => code.startsWith('R-'));

    it('shows a whole-tenant reader every project and a subtree reader the projects whose owner or investor is in the subtree (AC-ST-PRJ-001-5)', async () => {
      expect(await codes(WHOLE_TENANT)).toEqual(['R-1', 'R-2', 'R-3', 'R-4']);
      expect(await codes(grant(READ, { kind: 'UNIT_SUBTREE', refIds: [unitId(PROVINCE)], paths: ['/u1/'] }))).toEqual(['R-1', 'R-2', 'R-4']);
      expect(await codes(grant(READ, { kind: 'UNIT_SUBTREE', refIds: [unitId(DEPARTMENT)], paths: ['/u1/u2/'] }))).toEqual(['R-2', 'R-4']);
      expect(await codes(grant(READ, { kind: 'UNIT_ONLY', refIds: [unitId(PROVINCE)] }))).toEqual(['R-1']);
      expect(await codes(grant(READ, { kind: 'UNIT_ONLY', refIds: [unitId(OTHER_BRANCH)] }))).toEqual(['R-3', 'R-4']);
      expect(await codes(grant(READ, { kind: 'PROJECT', refIds: [inOtherBranch] }))).toEqual(['R-3']);
      expect(await codes(grant(READ, { kind: 'CONTRACT', refIds: [randomUUID()] }))).toEqual([]);
      expect(await codes(grant('project.update', { kind: 'TENANT' }))).toEqual([]);
      expect(await codes({ ...WHOLE_TENANT, membershipActive: false })).toEqual([]);
    });

    it('lists the register of the tenant only, ordered by code, in pages that continue after the last line', async () => {
      const page1 = await as((tx) => store.list(tx, readOf(WHOLE_TENANT), { limit: 2, after: undefined }));
      expect(page1).toHaveLength(2);
      const last = page1[1];
      const page2 = await as((tx) => store.list(tx, readOf(WHOLE_TENANT), { limit: 2, after: { code: last?.codeKey ?? '', id: last?.id ?? '' } }));
      const everything = await as((tx) => store.list(tx, readOf(WHOLE_TENANT), { limit: 200, after: undefined }));
      expect(page1.map((item) => item.id)).toEqual(everything.slice(0, 2).map((item) => item.id));
      expect(page2.map((item) => item.id)).toEqual(everything.slice(2, 4).map((item) => item.id));
      expect(await codes(WHOLE_TENANT, TENANT_B)).toEqual([]);
    });

    it('carries the investor, the group, the national code and the leader in charge in each line', async () => {
      const lines = await as((tx) => store.list(tx, readOf(WHOLE_TENANT), { limit: 200, after: undefined }));
      const line = (code: string) => lines.find((item) => item.code === code);
      expect(line('R-2')).toMatchObject({ ownerUnitName: 'Unit 2', status: 'CONCEPT', projectGroup: null, nationalProjectCode: null, leader: { membershipId: memberId(LEADER), displayName: `User ${LEADER}` }, version: 1 });
      expect(line('R-4')).toMatchObject({ ownerUnitName: 'Unit 3', investorUnitName: 'Unit 2', leader: null });
      expect(line('R-1')?.investorUnitId).toBeNull();
    });

    it('opens a project with its master data and units, and keeps a project outside the scope, or in another tenant, out of sight (AC-ST-PRJ-001-3)', async () => {
      const full = await create(
        input('R-FULL', {
          sectorMasterVersionId: versions.sector as string,
          projectTypeMasterVersionId: versions.type as string,
          programMasterVersionId: versions.program as string,
          decisionAuthorityUnitId: unitId(PROVINCE),
          investorUnitId: unitId(DEPARTMENT),
        }),
      );
      const detail = await find(full.id);
      expect(detail).toMatchObject({
        code: 'R-FULL',
        status: 'CONCEPT',
        classification: 'INTERNAL',
        totalInvestmentVnd: '500000000000',
        decisionAuthorityUnitName: 'Unit 1',
        investorUnitName: 'Unit 2',
        appraisalScore: null,
        pipelinePriority: null,
        area: { versionId: versions.area, businessKey: expect.stringMatching(/^AREA-/) },
        sector: { versionId: versions.sector },
        projectType: { versionId: versions.type },
        program: { versionId: versions.program },
      });
      expect(detail?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect((await find(inProvince))?.sector).toBeNull();
      const department = grant(READ, { kind: 'UNIT_SUBTREE', refIds: [unitId(DEPARTMENT)], paths: ['/u1/u2/'] });
      expect(await find(inProvince, department)).toBeUndefined();
      expect(await find(inDepartment, department)).toBeDefined();
      expect(await find(investedByDepartment, department)).toBeDefined();
      expect(await find(inOtherBranch, department)).toBeUndefined();
      expect(await find(inDepartment, WHOLE_TENANT, TENANT_B)).toBeUndefined();
      expect(await find(randomUUID())).toBeUndefined();
    });

    it('counts the open projects that have no national code, for the telemetry gauge', async () => {
      const before = await as((tx) => store.countMissingNationalCode(tx));
      expect(before).toBeGreaterThan(0);
      await owner("update machvon.project set status = 'CANCELLED' where id = $1::uuid", [inProvince]);
      expect(await as((tx) => store.countMissingNationalCode(tx))).toBe(before - 1);
      await owner("update machvon.project set national_project_code = '7654321' where id = $1::uuid", [inDepartment]);
      expect(await as((tx) => store.countMissingNationalCode(tx))).toBe(before - 2);
      expect(await as((tx) => store.countMissingNationalCode(tx), TENANT_B)).toBeLessThan(before);
    });
  });

  describe('updating the profile', () => {
    it('changes the descriptive fields, raises the version and reports each change (AC-ST-PRJ-001-2)', async () => {
      const created = await create(input('U-1', { sectorMasterVersionId: versions.sector as string }));
      const done = await update(created.id, 1, {
        name: 'Tên mới của dự án',
        classification: 'CONFIDENTIAL',
        investorUnitId: unitId(PROVINCE),
        areaMasterVersionId: versions.area2 as string,
        sectorMasterVersionId: versions.sector2 as string,
        projectTypeMasterVersionId: versions.type as string,
        programMasterVersionId: versions.program as string,
        startYear: 2025,
        endYear: 2030,
      });
      expect(done).toMatchObject({ version: 2, status: 'CONCEPT', classification: 'CONFIDENTIAL' });
      expect(done.changes.map((change) => change.field).sort()).toEqual(['area_master_version_id', 'classification', 'end_year', 'investor_unit_id', 'name', 'program_master_version_id', 'project_type_master_version_id', 'sector_master_version_id', 'start_year']);
      expect(done.changes.find((change) => change.field === 'name')).toEqual({ field: 'name', before: 'Project U-1', after: 'Tên mới của dự án' });
      expect(await row(created.id)).toMatchObject({
        name: 'Tên mới của dự án',
        version: '2',
        sector_master_version_id: versions.sector2,
        start_year: 2025,
        end_year: 2030,
        updated_by: memberId(ACTOR),
        total_investment_vnd: '500000000000',
        status: 'CONCEPT',
        code: 'U-1',
      });
    });

    it('refuses a stale version and leaves the row as it was (AC-ST-PRJ-001-2)', async () => {
      const created = await create(input('U-2'));
      await update(created.id, 1, { name: 'Second name' });
      const before = await row(created.id);
      expect(await refusal(update(created.id, 1, { name: 'Third name' }))).toEqual({ code: 'VERSION_CONFLICT', status: 409 });
      expect(await row(created.id)).toEqual(before);
    });

    it('writes nothing when nothing changes, and refuses an empty body', async () => {
      const created = await create(input('U-3'));
      expect(await update(created.id, 1, { name: 'Project U-3', startYear: undefined })).toMatchObject({ version: 1, changes: [] });
      expect((await row(created.id))?.version).toBe('1');
      expect(await refusal(update(created.id, 1, {}))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'body' });
    });

    it('refuses values that break the rules of the field, and a year that crosses the other one', async () => {
      const created = await create(input('U-4', { startYear: 2026, endYear: 2028 }));
      const cases: Array<[ProfileChange, string]> = [
        [{ name: 'ab' }, 'name'],
        [{ classification: 'SECRET' as never }, 'classification'],
        [{ investorUnitId: unitId(DISSOLVED) }, 'investor_unit_id'],
        [{ startYear: 2029 }, 'start_year'],
        [{ endYear: 2025 }, 'end_year'],
        [{ startYear: 2031, endYear: 2030 }, 'end_year'],
        [{ startYear: 1980 }, 'start_year'],
      ];
      for (const [change, field] of cases) expect(await refusal(update(created.id, 1, change))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: field });
      expect(await refusal(update(created.id, 1, { sectorMasterVersionId: versions.expired as string }))).toEqual({ code: 'MASTER_NOT_EFFECTIVE', status: 422, detail: 'sector_master_version_id' });
      expect(await refusal(update(created.id, 1, { programMasterVersionId: versions.sector as string }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'program_master_version_id' });
      expect((await row(created.id))?.version).toBe('1');
    });

    it('locks the fields of the dossier once the project leaves the concept stage, and everything once it is closed (STAGE_LOCKED_FIELD)', async () => {
      const created = await create(input('U-5'));
      await owner("update machvon.project set status = 'APPRAISAL', project_group = null where id = $1::uuid", [created.id]);
      for (const [change, field] of [
        [{ investorUnitId: unitId(PROVINCE) }, 'investor_unit_id'],
        [{ areaMasterVersionId: versions.area2 as string }, 'area_master_version_id'],
        [{ sectorMasterVersionId: versions.sector as string }, 'sector_master_version_id'],
        [{ projectTypeMasterVersionId: versions.type as string }, 'project_type_master_version_id'],
        [{ programMasterVersionId: versions.program as string }, 'program_master_version_id'],
        [{ startYear: 2026 }, 'start_year'],
        [{ endYear: 2027 }, 'end_year'],
      ] as Array<[ProfileChange, string]>) {
        expect(await refusal(update(created.id, 1, change))).toEqual({ code: 'STAGE_LOCKED_FIELD', status: 422, detail: field });
      }
      // The name and the classification stay open while the project lives.
      expect(await update(created.id, 1, { name: 'Renamed in appraisal', classification: 'PUBLIC' })).toMatchObject({ version: 2, status: 'APPRAISAL' });
      for (const stage of ['CLOSED', 'REJECTED', 'CANCELLED']) {
        await owner("update machvon.project set status = $2, project_group = 'C' where id = $1::uuid", [created.id, stage]);
        expect(await refusal(update(created.id, 2, { name: 'Nope' }))).toEqual({ code: 'STAGE_LOCKED_FIELD', status: 422, detail: 'name' });
      }
    });

    it('judges the scope of project.update: out of sight is 404, readable but not updatable is 403, another tenant is 404', async () => {
      const created = await create(input('U-6', { ownerUnitId: unitId(DEPARTMENT) }));
      const inside = scopesOf(grant(UPDATE, { kind: 'UNIT_SUBTREE', refIds: [unitId(DEPARTMENT)], paths: ['/u1/u2/'] }), WHOLE_TENANT);
      const outside = scopesOf(grant(UPDATE, { kind: 'UNIT_SUBTREE', refIds: [unitId(OTHER_BRANCH)], paths: ['/u3/'] }), WHOLE_TENANT);
      const blind = scopesOf(grant(UPDATE, { kind: 'UNIT_ONLY', refIds: [unitId(OTHER_BRANCH)] }), grant(READ, { kind: 'UNIT_ONLY', refIds: [unitId(OTHER_BRANCH)] }));
      expect(await refusal(update(created.id, 1, { name: 'Edited outside' }, outside))).toEqual({ code: 'SCOPE_DENIED', status: 403 });
      expect(await refusal(update(created.id, 1, { name: 'Edited blind' }, blind))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(update(created.id, 1, { name: 'Edited abroad' }, EVERYWHERE, TENANT_B))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(update(randomUUID(), 1, { name: 'Edited nothing' }))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await update(created.id, 1, { name: 'Edited inside' }, inside)).toMatchObject({ version: 2 });
      const projectScoped = scopesOf(grant(UPDATE, { kind: 'PROJECT', refIds: [created.id] }), WHOLE_TENANT);
      expect(await update(created.id, 2, { name: 'Edited by project grant' }, projectScoped)).toMatchObject({ version: 3 });
    });
  });

  describe('what the database keeps', () => {
    it('keeps the internal code for good, even for the owner of the schema', async () => {
      const created = await create(input('K-1'));
      await expect(owner("update machvon.project set code = 'K-RENAMED' where id = $1::uuid", [created.id])).rejects.toMatchObject({ message: expect.stringContaining('keeps its internal code') });
      await expect(owner("update machvon.project set code = ' K-SPACE' where id = $1::uuid", [created.id])).rejects.toBeDefined();
      expect((await row(created.id))?.code).toBe('K-1');
    });

    it('refuses a code or name with edge spaces, years out of range, and a second initial revision', async () => {
      const created = await create(input('K-2'));
      await expect(owner("update machvon.project set name = ' x ' where id = $1::uuid", [created.id])).rejects.toMatchObject({ constraint: 'project_identity_text_chk' });
      await expect(owner('update machvon.project set start_year = 1800 where id = $1::uuid', [created.id])).rejects.toMatchObject({ constraint: 'project_year_range_chk' });
      await expect(
        owner(
          `insert into machvon.project_revision (tenant_id, id, project_id, revision, change_kind, before_json, after_json, reason, status, created_by, updated_by)
           values ($1, $2, $3, 1, 'INITIAL', '{}', '{}', 'again', 'DRAFT', $4, $4)`,
          [TENANT_A, randomUUID(), created.id, memberId(ACTOR)],
        ),
      ).rejects.toMatchObject({ constraint: 'project_revision_no_uq' });
      await expect(
        owner(
          `insert into machvon.project_revision (tenant_id, id, project_id, revision, change_kind, before_json, after_json, reason, status, created_by, updated_by)
           values ($1, $2, $3, 2, 'INITIAL', '{}', '{}', 'again', 'DRAFT', $4, $4)`,
          [TENANT_A, randomUUID(), created.id, memberId(ACTOR)],
        ),
      ).rejects.toMatchObject({ constraint: 'project_revision_initial_chk' });
    });

    it('converts the status of the legacy register into the stages of the PIMA life cycle (CR-PRJ-01)', async () => {
      const [converted] = await owner<{ draft: string; review: string; approved: string; planned: string; active: string; closed: string; unknown: string | null }>(
        `select machvon.prj_legacy_project_status('Draft', false, false) as draft, machvon.prj_legacy_project_status('InReview', false, false) as review,
                machvon.prj_legacy_project_status('Approved', false, false) as approved, machvon.prj_legacy_project_status('Active', true, false) as planned,
                machvon.prj_legacy_project_status('Active', true, true) as active, machvon.prj_legacy_project_status('Closed', false, false) as closed,
                machvon.prj_legacy_project_status('Other', false, false) as unknown`,
      );
      expect(converted).toEqual({ draft: 'CONCEPT', review: 'APPRAISAL', approved: 'PIPELINE', planned: 'BUDGETED', active: 'IMPLEMENTATION', closed: 'CLOSED', unknown: null });
      expect((await owner<{ status: string }>("select machvon.prj_legacy_project_status('Active', false, false) as status"))[0]?.status).toBe('IMPLEMENTATION');
    });

    it('stays inside its tenant: the same project id is invisible to the other tenant through the row level security', async () => {
      const created = await create(input('K-3'));
      expect(await owner('select count(*)::int as n from machvon.project where id = $1::uuid', [created.id], TENANT_B)).toEqual([{ n: 0 }]);
      expect(await owner('select count(*)::int as n from machvon.project_revision where project_id = $1::uuid', [created.id], TENANT_B)).toEqual([{ n: 0 }]);
    });
  });
});
