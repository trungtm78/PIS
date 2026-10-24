import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import type { EffectiveAccess, Scope } from '@machvon/kernel';
import { criteriaDocument, legalBasisOf, readCriteria } from '../src/bid-criteria-input';
import { BidCriteriaReads, criteriaReadScope } from '../src/bid-criteria-reads';
import type { CriteriaReadScope } from '../src/bid-criteria-reads';
import { PROHIBITED_RULES, normalizedForMatch, prohibitedRuleOf } from '../src/bid-criteria-rules';
import { BidCriteriaStore } from '../src/bid-criteria-store';
import type { ScopeBuilder } from '../src/scope-version';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, id, memberId, unitId } from './support/authz-fixtures';

const harness = new AuthzHarness();
const criteria = new BidCriteriaStore();
const reads = new BidCriteriaReads();
const MAKER = 1;
const APPROVER = 2;
const PROVINCE = 1;
const DEPARTMENT = 2;
const OTHER_BRANCH = 3;
const FAMILY = 0x94;
const NOW = new Date();

const everything: ScopeBuilder = () => ({ sql: 'true', params: [] });
const grant = (permission: string, scope: Scope): EffectiveAccess => ({
  membershipId: memberId(MAKER),
  scopeVersion: 1,
  membershipActive: true,
  grants: [{ roleCode: 'TEST', rank: 10, permissions: [permission], scope, status: 'Active', effectiveFrom: new Date('2026-01-01T00:00:00Z'), effectiveUntil: null }],
});
const subtree = (permission: string, unit: number): EffectiveAccess => grant(permission, { kind: 'UNIT_SUBTREE', refIds: [unitId(unit)], paths: [`/${unitId(unit)}/`] });

const as = <T>(work: (tx: TenantTx) => Promise<T>, member = MAKER, tenant = TENANT_A): Promise<T> => harness.tenants.withTenant(contextFor(tenant, memberId(member)), work);
const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);

interface Refusal {
  code: string;
  status: number;
  detail?: string;
  extensions?: Record<string, unknown>;
}

async function refusal(work: Promise<unknown>): Promise<Refusal> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; status?: number; detail?: string; extensions?: Record<string, unknown> };
    return { code: e.code ?? '', status: e.status ?? 0, ...(e.detail === undefined ? {} : { detail: e.detail }), ...(e.extensions === undefined ? {} : { extensions: e.extensions }) };
  }
  throw new Error('expected a refusal');
}

async function databaseRefusal(work: Promise<unknown>): Promise<{ sqlstate: string; message: string }> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; message: string };
    return { sqlstate: e.code ?? '', message: e.message };
  }
  throw new Error('expected the database to refuse');
}

async function seedAs(statements: Array<[string, unknown[]]>): Promise<void> {
  const client = new Client({ connectionString: harness.database.adminUrl });
  await client.connect();
  try {
    // Foreign keys to the modules this story only reads are out of scope here, so the superuser seeds with them switched off.
    await client.query('set session_replication_role = replica');
    for (const [sql, params] of statements) await client.query(sql, params);
  } finally {
    await client.end();
  }
}

let counter = 0;
const nextCode = (prefix: string): string => {
  counter += 1;
  return `${prefix}-${counter}`;
};

interface Seeded {
  projectId: string;
  packageId: string;
}

/** A project with one package whose plan is approved (PLANNED), or in the given status. */
async function seedPackage(options: { status?: string; unit?: number; tenant?: string } = {}): Promise<Seeded> {
  const tenant = options.tenant ?? TENANT_A;
  const projectId = randomUUID();
  const packageId = randomUUID();
  await seedAs([
    [
      `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, investor_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
       values ($1, $2, $3, 'Criteria project', $4, $5, $6, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
      [tenant, projectId, nextCode('CP'), unitId(options.unit ?? DEPARTMENT), unitId(PROVINCE), id(FAMILY, 90)],
    ],
    [
      `insert into machvon.procurement_package (tenant_id, id, project_id, code, budget_vnd, method, revision, status, title)
       values ($1, $2, $3, $4, 1000, 'OPEN_BIDDING', 1, $5, 'Construction package')`,
      [tenant, packageId, projectId, nextCode('GT'), options.status ?? 'PLANNED'],
    ],
  ]);
  return { projectId, packageId };
}

const scored = (code: string, weight: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  code,
  name: `Criterion ${code}`,
  kind: 'SCORED',
  weight,
  max_score: 10,
  threshold: 5,
  mandatory: false,
  required_evidence: ['Audited statements'],
  ...extra,
});
const passFail = (code: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ code, name: `Requirement ${code}`, kind: 'PASS_FAIL', mandatory: true, ...extra });
const valid = (): { criteria: Array<Record<string, unknown>> } => ({ criteria: [scored('C1', 40), scored('C2', 30), scored('C3', 20), scored('C4', 10), passFail('R1')] });

const draft = (seeded: Seeded, json: unknown = valid(), member = MAKER, scope: ScopeBuilder = everything) =>
  as((tx) => criteria.create(tx, { packageId: seeded.packageId, criteriaJson: json, legalBasis: 'Luật Đấu thầu 22/2023/QH15' }, memberId(member), scope), member);
const approve = (criteriaId: string, version: number, member = APPROVER, scope: ScopeBuilder = everything) => as((tx) => criteria.approve(tx, criteriaId, version, memberId(member), scope), member);

type Row = { status: string; version: string; approved_by: string | null; effective_at: string | null; revision: number; weights_sum: number | null };
const rowOf = async (criteriaId: string): Promise<Row> =>
  (
    await owner<Row>('select status, version::text as version, approved_by, effective_at::text as effective_at, revision, weights_sum from machvon.criteria_version where id = $1::uuid', [criteriaId])
  )[0] as Row;
const countFor = async (packageId: string): Promise<number> => Number((await owner<{ n: string }>('select count(*)::text as n from machvon.criteria_version where package_id = $1::uuid', [packageId]))[0]?.n);

describe('the shape of the criteria (no database)', () => {
  it('reads a list of scored and pass/fail criteria with trimmed text and exact weights', () => {
    const read = readCriteria({ criteria: [scored('C1', 60, { name: '  Experience  ' }), scored('C2', 40, { threshold: undefined }), passFail('R1', { required_evidence: undefined })] });
    expect(read.weightsSum).toBe(100);
    expect(read.criteria.map((criterion) => [criterion.code, criterion.kind, criterion.weight, criterion.maxScore, criterion.threshold, criterion.mandatory])).toEqual([
      ['C1', 'SCORED', 60, 10, 5, false],
      ['C2', 'SCORED', 40, 10, null, false],
      ['R1', 'PASS_FAIL', null, null, null, true],
    ]);
    expect(read.criteria[0]?.name).toBe('Experience');
    expect(read.criteria[2]?.requiredEvidence).toEqual([]);
    expect(criteriaDocument(read.criteria).criteria[2]).toEqual({ code: 'R1', name: 'Requirement R1', kind: 'PASS_FAIL', weight: null, max_score: null, threshold: null, mandatory: true, required_evidence: [] });
    // What is stored reads back the same way, so the approval can judge it again.
    expect(readCriteria(criteriaDocument(read.criteria))).toEqual(read);
  });

  it('has no weights to add up when no criterion is scored', () => {
    expect(readCriteria({ criteria: [passFail('R1'), passFail('R2')] }).weightsSum).toBeNull();
  });

  it.each([
    ['not an object', 'x', 'criteria_json'],
    ['a list', [], 'criteria_json'],
    ['no list of criteria', {}, 'criteria_json.criteria'],
    ['an empty list', { criteria: [] }, 'criteria_json.criteria'],
    ['too many criteria', { criteria: Array.from({ length: 51 }, (_, index) => passFail(`R${index}`)) }, 'criteria_json.criteria'],
    ['a criterion that is not an object', { criteria: ['x'] }, 'criteria_json.criteria.0'],
    ['a code with a space', { criteria: [passFail('R 1')] }, 'criteria_json.criteria.0.code'],
    ['a code that repeats in another case', { criteria: [passFail('r1'), passFail('R1')] }, 'criteria_json.criteria.1.code'],
    ['a name that is too short', { criteria: [passFail('R1', { name: 'x' })] }, 'criteria_json.criteria.0.name'],
    ['a control character in the name', { criteria: [passFail('R1', { name: 'bell\u0007' })] }, 'criteria_json.criteria.0.name'],
    ['an unknown kind', { criteria: [passFail('R1', { kind: 'RANKED' })] }, 'criteria_json.criteria.0.kind'],
    ['a mandatory flag that is not a boolean', { criteria: [passFail('R1', { mandatory: 'yes' })] }, 'criteria_json.criteria.0.mandatory'],
    ['too much evidence', { criteria: [passFail('R1', { required_evidence: Array.from({ length: 11 }, () => 'Certificate') })] }, 'criteria_json.criteria.0.required_evidence'],
    ['evidence that is not a list', { criteria: [passFail('R1', { required_evidence: 'x' })] }, 'criteria_json.criteria.0.required_evidence'],
    ['a piece of evidence that is too short', { criteria: [passFail('R1', { required_evidence: ['x'] })] }, 'criteria_json.criteria.0.required_evidence.0'],
    ['a weight on a pass/fail criterion', { criteria: [passFail('R1', { weight: 10 })] }, 'criteria_json.criteria.0.weight'],
    ['a scale on a pass/fail criterion', { criteria: [passFail('R1', { max_score: 10 })] }, 'criteria_json.criteria.0.max_score'],
    ['a scored criterion without a weight', { criteria: [scored('C1', 100, { weight: undefined })] }, 'criteria_json.criteria.0.weight'],
    ['a weight of zero', { criteria: [scored('C1', 0)] }, 'criteria_json.criteria.0.weight'],
    ['a weight above 100', { criteria: [scored('C1', 101)] }, 'criteria_json.criteria.0.weight'],
    ['a fractional weight', { criteria: [scored('C1', 99.5)] }, 'criteria_json.criteria.0.weight'],
    ['a scored criterion without a scale', { criteria: [scored('C1', 100, { max_score: undefined })] }, 'criteria_json.criteria.0.max_score'],
    ['a scale above 100', { criteria: [scored('C1', 100, { max_score: 101 })] }, 'criteria_json.criteria.0.max_score'],
    ['a threshold above the scale', { criteria: [scored('C1', 100, { threshold: 11 })] }, 'criteria_json.criteria.0.threshold'],
    ['a negative threshold', { criteria: [scored('C1', 100, { threshold: -1 })] }, 'criteria_json.criteria.0.threshold'],
  ])('refuses %s as a fault of the request', (_name, json, field) => {
    expect(() => readCriteria(json)).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED', status: 422, detail: field }));
  });

  it('refuses a member the contract does not name, in the list and in a criterion (FIELD_NOT_ALLOWED)', () => {
    expect(() => readCriteria({ criteria: [passFail('R1')], extra: 1 })).toThrow(expect.objectContaining({ code: 'FIELD_NOT_ALLOWED', status: 400, detail: 'criteria_json.extra' }));
    expect(() => readCriteria({ criteria: [passFail('R1', { weighting: 1 })] })).toThrow(expect.objectContaining({ code: 'FIELD_NOT_ALLOWED', status: 400, detail: 'criteria_json.criteria.0.weighting' }));
  });

  it('refuses weights that do not add up to exactly 100 (AC-ST-BID-003-1: 30/30/20/10 is 90)', () => {
    const refused = (weights: number[]) => {
      try {
        readCriteria({ criteria: weights.map((weight, index) => scored(`C${index}`, weight)) });
      } catch (error) {
        return error as { code: string; status: number; extensions: Record<string, unknown> };
      }
      throw new Error('expected a refusal');
    };
    expect(refused([30, 30, 20, 10])).toMatchObject({ code: 'CRITERIA_WEIGHT_INVALID', status: 422, extensions: { weights_sum: 90, expected: 100 } });
    expect(refused([60, 41])).toMatchObject({ code: 'CRITERIA_WEIGHT_INVALID', extensions: { weights_sum: 101 } });
    expect(() => readCriteria({ criteria: [scored('C1', 50), scored('C2', 50)] })).not.toThrow();
  });

  it('keeps the legal basis trimmed and within its length', () => {
    expect(legalBasisOf('  Luật Đấu thầu  ')).toBe('Luật Đấu thầu');
    for (const bad of [undefined, 5, 'xx', 'x'.repeat(2001), 'bell\u0007 basis']) expect(() => legalBasisOf(bad)).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED', detail: 'legal_basis' }));
  });
});

describe('the criteria nobody may ask for (no database)', () => {
  it('matches whole words, without regard to case, accents or punctuation', () => {
    expect(normalizedForMatch('Giám đốc là NGƯỜI địa-phương!')).toBe('giam doc la nguoi dia phuong');
    expect(prohibitedRuleOf('Giám đốc là người địa phương')?.code).toBe('LOCAL_PRESENCE');
    expect(prohibitedRuleOf('GIOI TINH của người đại diện')?.code).toBe('GENDER');
    expect(prohibitedRuleOf('Representative gender')?.code).toBe('GENDER');
    expect(prohibitedRuleOf('Ethnic origin of the staff')?.code).toBe('ETHNICITY');
    expect(prohibitedRuleOf('Đã kết hôn')?.code).toBe('MARITAL_STATUS');
  });

  it('does not take a word for a part of another: years are not men, and an experience is no origin', () => {
    for (const text of ['Ít nhất 5 năm kinh nghiệm', 'Năng lực tài chính', 'Doanh nghiệp có trụ sở tại Việt Nam', 'Kinh nghiệm thi công cầu']) expect(prohibitedRuleOf(text)).toBeUndefined();
  });

  it('gives every rule a legal basis and terms of its own', () => {
    expect(new Set(PROHIBITED_RULES.map((rule) => rule.code)).size).toBe(PROHIBITED_RULES.length);
    for (const rule of PROHIBITED_RULES) {
      expect(rule.legalBasis.length).toBeGreaterThan(20);
      expect(rule.terms.length).toBeGreaterThan(0);
      for (const term of rule.terms) expect(prohibitedRuleOf(term)?.code).toBe(rule.code);
    }
  });

  it('refuses a criterion whose name or evidence falls under a rule, naming the criterion and the basis (AC-ST-BID-003-3)', () => {
    const refused = (json: unknown) => {
      try {
        readCriteria(json);
      } catch (error) {
        return error as { code: string; status: number; detail: string; extensions: Record<string, unknown> };
      }
      throw new Error('expected a refusal');
    };
    expect(refused({ criteria: [scored('C1', 100, { name: 'Director is a local person' })] })).toMatchObject({
      code: 'PROHIBITED_CRITERION',
      status: 422,
      detail: 'criteria_json.criteria.0.name',
      extensions: { criterion_code: 'C1', rule: 'LOCAL_PRESENCE', category: 'REGION', legal_basis: expect.stringContaining('22/2023/QH15') },
    });
    expect(refused({ criteria: [passFail('R1'), passFail('R2', { required_evidence: ['Giới tính người đại diện'] })] })).toMatchObject({
      code: 'PROHIBITED_CRITERION',
      detail: 'criteria_json.criteria.1.name',
      extensions: { criterion_code: 'R2', rule: 'GENDER', category: 'PERSONAL_ATTRIBUTE' },
    });
    // A prohibited criterion is judged before the weights: the maker hears about it even when the weights are wrong too.
    expect(refused({ criteria: [scored('C1', 10, { name: 'Dân tộc' })] }).code).toBe('PROHIBITED_CRITERION');
  });
});

describe('BidCriteriaStore (the evaluation criteria, ST-BID-003)', () => {
  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: PROVINCE, path: `/${unitId(PROVINCE)}/` },
        { n: DEPARTMENT, path: `/${unitId(PROVINCE)}/${unitId(DEPARTMENT)}/`, parent: PROVINCE },
        { n: OTHER_BRANCH, path: `/${unitId(OTHER_BRANCH)}/` },
      ]);
      for (const member of [MAKER, APPROVER]) await harness.seedMembership(tenant, member, PROVINCE);
    }
  }, 240_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  describe('create', () => {
    it('drafts the first revision of a package with its weights and its maker', async () => {
      const seeded = await seedPackage();
      const created = await draft(seeded);
      expect(created).toMatchObject({ packageId: seeded.packageId, revision: 1, version: 1, status: 'DRAFT', weightsSum: 100, criteriaCount: 5, supersedesId: null, replacedDraftId: null });
      const stored = (await owner<{ criteria_json: { criteria: Array<Record<string, unknown>> }; legal_basis: string; created_by: string; approved_by: string | null }>(
        'select criteria_json, legal_basis, created_by, approved_by from machvon.criteria_version where id = $1::uuid',
        [created.id],
      ))[0];
      expect(stored?.criteria_json.criteria.map((criterion) => criterion.code)).toEqual(['C1', 'C2', 'C3', 'C4', 'R1']);
      expect(stored).toMatchObject({ legal_basis: 'Luật Đấu thầu 22/2023/QH15', created_by: memberId(MAKER), approved_by: null });
    });

    it('takes the place of the draft in work with the next revision, which is superseded unapproved', async () => {
      const seeded = await seedPackage();
      const first = await draft(seeded);
      const second = await draft(seeded, { criteria: [scored('C1', 100)] });
      expect(second).toMatchObject({ revision: 2, replacedDraftId: first.id, supersedesId: null, weightsSum: 100, criteriaCount: 1 });
      expect(await rowOf(first.id)).toMatchObject({ status: 'SUPERSEDED', version: '2', approved_by: null });
      expect(await rowOf(second.id)).toMatchObject({ status: 'DRAFT', version: '1' });
    });

    it('names the version in force that a revision will replace, and keeps it in force until the revision is approved', async () => {
      const seeded = await seedPackage();
      const first = await draft(seeded);
      await approve(first.id, 1);
      const next = await draft(seeded, { criteria: [scored('C1', 70), scored('C2', 30)] });
      expect(next).toMatchObject({ revision: 2, supersedesId: first.id, replacedDraftId: null });
      expect((await rowOf(first.id)).status).toBe('APPROVED');
    });

    it('has no weights for a set of requirements that are only met or not', async () => {
      const seeded = await seedPackage();
      const created = await draft(seeded, { criteria: [passFail('R1'), passFail('R2')] });
      expect(created.weightsSum).toBeNull();
      expect((await rowOf(created.id)).weights_sum).toBeNull();
    });

    it('saves nothing when the weights do not add up (AC-ST-BID-003-1) or a criterion is prohibited (AC-ST-BID-003-3)', async () => {
      const seeded = await seedPackage();
      expect(await refusal(draft(seeded, { criteria: [scored('C1', 30), scored('C2', 30), scored('C3', 20), scored('C4', 10)] }))).toMatchObject({
        code: 'CRITERIA_WEIGHT_INVALID',
        status: 422,
        extensions: { weights_sum: 90 },
      });
      expect(await refusal(draft(seeded, { criteria: [scored('C1', 50, { name: 'Giám đốc là người địa phương' }), scored('C2', 50, { name: 'Giới tính người đại diện' })] }))).toMatchObject({
        code: 'PROHIBITED_CRITERION',
        status: 422,
        extensions: { criterion_code: 'C1', rule: 'LOCAL_PRESENCE' },
      });
      expect(await countFor(seeded.packageId)).toBe(0);
    });

    it('does not replace the draft in work when the new one is refused', async () => {
      const seeded = await seedPackage();
      const first = await draft(seeded);
      expect((await refusal(draft(seeded, { criteria: [scored('C1', 90)] }))).code).toBe('CRITERIA_WEIGHT_INVALID');
      expect((await rowOf(first.id)).status).toBe('DRAFT');
      expect(await countFor(seeded.packageId)).toBe(1);
    });

    it('refuses a package whose plan is still in work or was dropped (PACKAGE_STATE_INVALID), and one that does not exist or is outside the scope (404)', async () => {
      for (const status of ['DRAFT', 'IN_REVIEW', 'CANCELLED']) {
        const seeded = await seedPackage({ status });
        expect(await refusal(draft(seeded))).toEqual({ code: 'PACKAGE_STATE_INVALID', status: 409, detail: 'package_id', extensions: { package_status: status } });
        expect(await countFor(seeded.packageId)).toBe(0);
      }
      const awarded = await seedPackage({ status: 'AWARDED' });
      expect((await draft(awarded)).revision).toBe(1);
      const seeded = await seedPackage();
      const outside = projectScopeOf(OTHER_BRANCH);
      expect(await refusal(draft(seeded, valid(), MAKER, outside))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(draft({ ...seeded, packageId: randomUUID() }))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      const foreign = await seedPackage({ tenant: TENANT_B });
      expect(await refusal(draft(foreign))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    });

    it('lets exactly one of several drafts of one package take the next revision at a time, none of them losing a revision number', async () => {
      const seeded = await seedPackage();
      const made = await Promise.all(Array.from({ length: 4 }, () => draft(seeded)));
      expect(made.map((item) => item.revision).sort()).toEqual([1, 2, 3, 4]);
      const rows = await owner<{ status: string }>("select status from machvon.criteria_version where package_id = $1::uuid and status = 'DRAFT'", [seeded.packageId]);
      expect(rows).toHaveLength(1);
    });
  });

  describe('approve', () => {
    it('approves a draft by someone other than the maker and records who and when', async () => {
      const seeded = await seedPackage();
      const created = await draft(seeded);
      const approved = await approve(created.id, 1);
      expect(approved).toMatchObject({ id: created.id, packageId: seeded.packageId, revision: 1, version: 2, status: 'APPROVED', weightsSum: 100, criteriaCount: 5, supersededId: null });
      const row = await rowOf(created.id);
      expect(row).toMatchObject({ status: 'APPROVED', version: '2', approved_by: memberId(APPROVER) });
      expect(row.effective_at).not.toBeNull();
    });

    it('supersedes the version in force in the same step', async () => {
      const seeded = await seedPackage();
      const first = await draft(seeded);
      await approve(first.id, 1);
      const second = await draft(seeded, { criteria: [scored('C1', 100)] });
      const approved = await approve(second.id, 1);
      expect(approved.supersededId).toBe(first.id);
      expect(await rowOf(first.id)).toMatchObject({ status: 'SUPERSEDED', version: '3' });
      expect((await rowOf(second.id)).status).toBe('APPROVED');
    });

    it('refuses the maker (403 SELF_APPROVAL_DENIED), a stale version (409 VERSION_CONFLICT) and a version outside the scope or unknown (404)', async () => {
      const seeded = await seedPackage();
      const created = await draft(seeded);
      expect(await refusal(approve(created.id, 1, MAKER))).toEqual({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      expect((await refusal(approve(created.id, 7))).code).toBe('VERSION_CONFLICT');
      expect(await refusal(approve(created.id, 1, APPROVER, projectScopeOf(OTHER_BRANCH)))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(approve(randomUUID(), 1))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect((await rowOf(created.id)).status).toBe('DRAFT');
    });

    it('refuses to approve a version again: a version that an analysis run used is LOCKED_BY_RUN, any other is not a draft (AC-ST-BID-003-2)', async () => {
      const seeded = await seedPackage();
      const created = await draft(seeded);
      await approve(created.id, 1);
      expect(await refusal(approve(created.id, 2))).toEqual({ code: 'CRITERIA_STATE_INVALID', status: 409, detail: 'status', extensions: { criteria_status: 'APPROVED' } });
      await seedAs([
        [
          `insert into machvon.analysis_run (tenant_id, id, proposal_id, criteria_version_id, profile_version_id, input_hash, status, budget_reservation_id)
           values ($1, $2, $3, $4, $5, repeat('a', 64), 'COMPLETED', $6)`,
          [TENANT_A, randomUUID(), randomUUID(), created.id, randomUUID(), randomUUID()],
        ],
      ]);
      expect(await refusal(approve(created.id, 2))).toEqual({ code: 'CRITERIA_LOCKED_BY_RUN', status: 409, detail: 'status', extensions: { criteria_status: 'APPROVED' } });
      // The only way forward is a new revision, which an approver can approve.
      const next = await draft(seeded, { criteria: [scored('C1', 50), scored('C2', 50)] });
      expect(next.revision).toBe(2);
      expect((await approve(next.id, 1)).supersededId).toBe(created.id);
      // The superseded version stays what the run used; it is no more approvable than before.
      expect((await refusal(approve(created.id, 3))).code).toBe('CRITERIA_LOCKED_BY_RUN');
    });

    it('judges the criteria again: a rule added since the draft was made refuses its approval', async () => {
      const seeded = await seedPackage();
      const versionId = randomUUID();
      // A draft written before the rule existed, as the application of an earlier release would have left it.
      await seedAs([
        [
          `insert into machvon.criteria_version (tenant_id, id, package_id, revision, criteria_json, legal_basis, weights_sum, status, created_by, version)
           values ($1, $2, $3, 1, $4::jsonb, 'Luật Đấu thầu', 100, 'DRAFT', $5, 1)`,
          [TENANT_A, versionId, seeded.packageId, JSON.stringify({ criteria: [scored('C1', 100, { name: 'Tình trạng hôn nhân của giám đốc' })] }), memberId(MAKER)],
        ],
      ]);
      expect(await refusal(approve(versionId, 1))).toMatchObject({ code: 'PROHIBITED_CRITERION', extensions: { criterion_code: 'C1', rule: 'MARITAL_STATUS' } });
      expect((await rowOf(versionId)).status).toBe('DRAFT');
    });

    it('refuses to approve for a package whose plan is no longer approved', async () => {
      const seeded = await seedPackage();
      const created = await draft(seeded);
      await owner("update machvon.procurement_package set status = 'CANCELLED' where id = $1::uuid", [seeded.packageId]);
      expect(await refusal(approve(created.id, 1))).toEqual({ code: 'PACKAGE_STATE_INVALID', status: 409, detail: 'package_id', extensions: { package_status: 'CANCELLED' } });
    });

    it('lets one of several approvals of one draft win, the others finding it approved', async () => {
      const seeded = await seedPackage();
      const created = await draft(seeded);
      const results = await Promise.allSettled(Array.from({ length: 4 }, () => approve(created.id, 1)));
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const codes = results.flatMap((result) => (result.status === 'rejected' ? [(result.reason as { code: string }).code] : []));
      expect(codes.every((code) => code === 'VERSION_CONFLICT')).toBe(true);
    });
  });

  describe('what the database keeps', () => {
    it('keeps the criteria of a version for good, whoever writes: a change is a new revision', async () => {
      const seeded = await seedPackage();
      const created = await draft(seeded);
      for (const change of [
        "criteria_json = '{\"criteria\":[]}'::jsonb",
        'weights_sum = 90',
        "legal_basis = 'Another basis'",
        'revision = 9',
        'created_by = package_id',
        "created_at = created_at + interval '1 day'",
      ]) {
        const refused = await databaseRefusal(owner(`update machvon.criteria_version set ${change} where id = $1::uuid`, [created.id]));
        expect(refused).toMatchObject({ sqlstate: '23514', message: expect.stringContaining('new revision') });
      }
    });

    it('moves a version along DRAFT, APPROVED, SUPERSEDED only, and never rewrites an approval', async () => {
      const seeded = await seedPackage();
      const created = await draft(seeded);
      await approve(created.id, 1);
      expect(await databaseRefusal(owner("update machvon.criteria_version set status = 'DRAFT', approved_by = null, effective_at = null where id = $1::uuid", [created.id]))).toMatchObject({
        sqlstate: '23514',
        message: expect.stringContaining('state transition'),
      });
      expect(await databaseRefusal(owner('update machvon.criteria_version set approved_by = created_by where id = $1::uuid', [created.id]))).toMatchObject({ sqlstate: '23514' });
      expect(await databaseRefusal(owner("update machvon.criteria_version set effective_at = effective_at + interval '1 day' where id = $1::uuid", [created.id]))).toMatchObject({
        message: expect.stringContaining('approval'),
      });
      const next = await draft(seeded, { criteria: [scored('C1', 100)] });
      await approve(next.id, 1);
      expect(await databaseRefusal(owner("update machvon.criteria_version set status = 'APPROVED' where id = $1::uuid", [created.id]))).toMatchObject({ message: expect.stringContaining('superseded') });
    });

    it('is born a draft with a maker, a legal basis and weights that add up, and is never approved by its maker', async () => {
      const seeded = await seedPackage();
      const insert = (columns: string, values: string, params: unknown[]) =>
        owner(`insert into machvon.criteria_version (tenant_id, id, package_id, revision, ${columns}) values ($1, $2, $3, ${values})`, [TENANT_A, randomUUID(), seeded.packageId, ...params]);
      const body = (json: unknown): string => JSON.stringify(json);
      const ok = body({ criteria: [scored('C1', 100)] });
      expect(await databaseRefusal(insert('criteria_json, legal_basis, weights_sum, status, created_by, approved_by, effective_at', "1, $4::jsonb, 'Basis', 100, 'APPROVED', $5, $6, now()", [ok, memberId(MAKER), memberId(APPROVER)]))).toMatchObject({
        message: expect.stringContaining('starts as a draft'),
      });
      expect(await databaseRefusal(insert('criteria_json, weights_sum, status, created_by', "1, $4::jsonb, 100, 'DRAFT', $5", [ok, memberId(MAKER)]))).toMatchObject({ message: expect.stringContaining('legal basis') });
      expect(await databaseRefusal(insert('criteria_json, legal_basis, weights_sum, status', "1, $4::jsonb, 'Basis', 100, 'DRAFT'", [ok]))).toMatchObject({ message: expect.stringContaining('maker') });
      expect(await databaseRefusal(insert('criteria_json, legal_basis, weights_sum, status, created_by', "1, $4::jsonb, 'Basis', 100, 'DRAFT', $5", [body({ criteria: [] }), memberId(MAKER)]))).toMatchObject({
        message: expect.stringContaining('one to fifty'),
      });
      const ninety = body({ criteria: [scored('C1', 90)] });
      expect(await databaseRefusal(insert('criteria_json, legal_basis, weights_sum, status, created_by', "1, $4::jsonb, 'Basis', 100, 'DRAFT', $5", [ninety, memberId(MAKER)]))).toMatchObject({
        message: expect.stringContaining('add up to 100'),
      });
      expect(await databaseRefusal(insert('criteria_json, legal_basis, weights_sum, status, created_by', "1, $4::jsonb, 'Basis', 90, 'DRAFT', $5", [ok, memberId(MAKER)]))).toMatchObject({
        message: expect.stringContaining('sum of the weights'),
      });
      const created = await draft(seeded);
      expect(await databaseRefusal(owner('update machvon.criteria_version set status = $2, approved_by = created_by, effective_at = now() where id = $1::uuid', [created.id, 'APPROVED']))).toMatchObject({
        sqlstate: '23514',
        message: expect.stringContaining('criteria_version_sod_chk'),
      });
    });

    it('has one draft and one approved version of a package at most, and one number for a revision', async () => {
      const seeded = await seedPackage();
      const created = await draft(seeded);
      const clone = (revision: number) =>
        owner(
          `insert into machvon.criteria_version (tenant_id, id, package_id, revision, criteria_json, legal_basis, weights_sum, status, created_by)
           values ($1, $2, $3, $4, $5::jsonb, 'Basis', 100, 'DRAFT', $6)`,
          [TENANT_A, randomUUID(), seeded.packageId, revision, JSON.stringify({ criteria: [scored('C1', 100)] }), memberId(MAKER)],
        );
      expect(await databaseRefusal(clone(2))).toMatchObject({ sqlstate: '23505', message: expect.stringContaining('criteria_version_one_draft_uq') });
      expect(await databaseRefusal(clone(1))).toMatchObject({ sqlstate: '23505' });
      expect(created.revision).toBe(1);
    });

    it('is never deleted, not even by the owner of the table, and the runtime role cannot even try', async () => {
      const seeded = await seedPackage();
      const created = await draft(seeded);
      expect(await databaseRefusal(owner('delete from machvon.criteria_version where id = $1::uuid', [created.id]))).toMatchObject({ sqlstate: '23514', message: expect.stringContaining('never deleted') });
      const grants = await owner<{ can_delete: boolean; can_truncate: boolean }>("select has_table_privilege('machvon_app', 'machvon.criteria_version', 'DELETE') as can_delete, has_table_privilege('machvon_app', 'machvon.criteria_version', 'TRUNCATE') as can_truncate");
      expect(grants[0]).toEqual({ can_delete: false, can_truncate: false });
    });
  });

  describe('the reads', () => {
    const allProjects = (circle: boolean): CriteriaReadScope => ({ projects: everything, circle });
    const page = { limit: 50, after: undefined };

    it('lists the versions newest first with the package and the project; a draft belongs to the circle that drafts and approves', async () => {
      const seeded = await seedPackage();
      const first = await draft(seeded);
      await approve(first.id, 1);
      const second = await draft(seeded, { criteria: [scored('C1', 100)] });
      const circle = await as((tx) => reads.list(tx, allProjects(true), { packageId: seeded.packageId }, page));
      expect(circle.map((line) => [line.id, line.revision, line.status])).toEqual([
        [second.id, 2, 'DRAFT'],
        [first.id, 1, 'APPROVED'],
      ]);
      expect(circle[1]).toMatchObject({
        package: { id: seeded.packageId, title: 'Construction package', status: 'PLANNED', project: { id: seeded.projectId, name: 'Criteria project' } },
        weightsSum: 100,
        legalBasis: 'Luật Đấu thầu 22/2023/QH15',
        version: 2,
      });
      expect(circle[1]?.approvedAt).toMatch(/Z$/);
      expect(circle[0]?.approvedAt).toBeNull();
      expect((circle[1]?.criteria as { criteria: unknown[] }).criteria).toHaveLength(5);
      const readers = await as((tx) => reads.list(tx, allProjects(false), { packageId: seeded.packageId }, page));
      expect(readers.map((line) => line.id)).toEqual([first.id]);
      expect(await as((tx) => reads.find(tx, second.id, allProjects(false)))).toBeUndefined();
      expect((await as((tx) => reads.find(tx, second.id, allProjects(true))))?.id).toBe(second.id);
    });

    it('filters by package and status, pages by creation time and keeps to the scope and the tenant of the caller', async () => {
      const seeded = await seedPackage();
      const first = await draft(seeded);
      await approve(first.id, 1);
      const second = await draft(seeded, { criteria: [scored('C1', 100)] });
      expect((await as((tx) => reads.list(tx, allProjects(true), { packageId: seeded.packageId, status: 'DRAFT' }, page))).map((line) => line.id)).toEqual([second.id]);
      const page1 = await as((tx) => reads.list(tx, allProjects(true), { packageId: seeded.packageId }, { limit: 1, after: undefined }));
      const anchor = page1[0] as { createdAtKey: string; id: string };
      const page2 = await as((tx) => reads.list(tx, allProjects(true), { packageId: seeded.packageId }, { limit: 5, after: { code: anchor.createdAtKey, id: anchor.id } }));
      expect(page2.map((line) => line.id)).toEqual([first.id]);
      const outside = criteriaReadScope(subtree('criteria_version.read', OTHER_BRANCH), 'criteria_version.read', NOW);
      expect(await as((tx) => reads.list(tx, outside, { packageId: seeded.packageId }, page))).toEqual([]);
      expect(await as((tx) => reads.list(tx, allProjects(true), {}, page), MAKER, TENANT_B)).toEqual([]);
      expect(await as((tx) => reads.find(tx, first.id, allProjects(true)), MAKER, TENANT_B)).toBeUndefined();
    });

    it('makes the circle of whoever may draft or approve criteria anywhere, and of nobody else', () => {
      expect(criteriaReadScope(subtree('bid.criteria.manage', PROVINCE), 'criteria_version.read', NOW).circle).toBe(true);
      expect(criteriaReadScope(subtree('bid.criteria.approve', PROVINCE), 'criteria_version.read', NOW).circle).toBe(true);
      expect(criteriaReadScope(subtree('criteria_version.read', PROVINCE), 'criteria_version.read', NOW).circle).toBe(false);
    });
  });
});

/** A scope builder that lets in the projects of one branch of units only. */
function projectScopeOf(unit: number): ScopeBuilder {
  return (start) => ({ sql: `p.owner_unit_id = $${start}::uuid`, params: [unitId(unit)] });
}
