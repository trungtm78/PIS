import { randomUUID } from 'node:crypto';
import { GovernancePolicyPort } from '../src/governance-policy-port';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, memberId, unitId } from './support/authz-fixtures';

const harness = new AuthzHarness();
const port = new GovernancePolicyPort();

const ROOT = 1;
const PROVINCE = 2;
const DEPARTMENT = 3;
const MAKER = 1;
const SUBMITTER = 2;
const CHECKER = 3;

const REMINDER_A = { every_working_hours: { URGENT: 2, ACTION: 6, WATCH: 30 }, max_per_item: { URGENT: 10, ACTION: 5, WATCH: 3 } };
const REMINDER_B = { every_working_hours: { URGENT: 1, ACTION: 4, WATCH: 20 }, max_per_item: { URGENT: 20, ACTION: 10, WATCH: 6 } };
const REMINDER_PROVINCE = { every_working_hours: { URGENT: 3, ACTION: 8, WATCH: 40 }, max_per_item: { URGENT: 8, ACTION: 4, WATCH: 2 } };
const REMINDER_DEPARTMENT = { every_working_hours: { URGENT: 4, ACTION: 12, WATCH: 60 }, max_per_item: { URGENT: 6, ACTION: 3, WATCH: 1 } };

const as = <T>(work: (tx: TenantTx) => Promise<T>, tenant = TENANT_A, member = MAKER): Promise<T> => harness.tenants.withTenant(contextFor(tenant, memberId(member)), work);

interface Row {
  tenant?: string;
  type?: string;
  code?: string;
  version?: number;
  unit?: number | null;
  status?: 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'RETIRED';
  params?: Record<string, unknown>;
  from?: string;
  to?: string | null;
  createdBy?: number;
  submittedBy?: number | null;
  approvedBy?: number | null;
}

/** Writes a version as the owner of the schema (the guard of the table lets the owner write any state, the CHECKs and the exclusion constraint still apply). */
async function put(row: Row): Promise<string> {
  const id = randomUUID();
  const status = row.status ?? 'APPROVED';
  const approved = status === 'APPROVED' || status === 'RETIRED';
  const submittedBy = row.submittedBy === undefined ? (status === 'DRAFT' ? null : SUBMITTER) : row.submittedBy;
  const approvedBy = row.approvedBy === undefined ? (approved ? CHECKER : null) : row.approvedBy;
  const tenant = row.tenant ?? TENANT_A;
  await harness.owner(tenant, [
    [
      `insert into machvon.governance_rule
         (tenant_id, id, rule_type, code, version, unit_id, status, params, effective_from, effective_to, reason, created_by, submitted_by, submitted_at, approved_by, approved_at,
          retired_by, retired_at, retire_reason)
       values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::date, $10::date, 'Lý do của phiên bản', $11, $12, case when $12::uuid is null then null else now() end,
          $13, case when $13::uuid is null then null else now() end,
          case when $7 = 'RETIRED' then $14::uuid end, case when $7 = 'RETIRED' then now() end, case when $7 = 'RETIRED' then 'Thay bằng phiên bản mới' end)`,
      [
        tenant,
        id,
        row.type ?? 'REMINDER_POLICY',
        row.code ?? 'DEFAULT',
        row.version ?? 1,
        row.unit === undefined || row.unit === null ? null : unitId(row.unit),
        status,
        JSON.stringify(row.params ?? REMINDER_A),
        row.from ?? '2026-01-01',
        row.to ?? null,
        memberId(row.createdBy ?? MAKER),
        submittedBy === null ? null : memberId(submittedBy),
        approvedBy === null ? null : memberId(approvedBy),
        memberId(CHECKER),
      ],
    ],
  ]);
  return id;
}

async function failure(work: Promise<unknown>): Promise<{ code: string; constraint: string; message: string }> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; constraint?: string; message?: string };
    return { code: e.code ?? '', constraint: e.constraint ?? '', message: e.message ?? '' };
  }
  throw new Error('expected the database to refuse');
}

/** The table `governance_rule` (V1850) and the reader of every module (`GovernancePolicyPort`), G0-1. */
describe('GovernancePolicyPort and governance_rule', () => {
  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: ROOT, path: `/${unitId(ROOT)}/` },
        { n: PROVINCE, path: `/${unitId(ROOT)}/${unitId(PROVINCE)}/`, parent: ROOT },
        { n: DEPARTMENT, path: `/${unitId(ROOT)}/${unitId(PROVINCE)}/${unitId(DEPARTMENT)}/`, parent: PROVINCE },
      ]);
      for (const member of [MAKER, SUBMITTER, CHECKER]) await harness.seedMembership(tenant, member, ROOT);
    }
  }, 300_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  it('answers with the built-in default, version 0 and its provenance, when the tenant approved nothing', async () => {
    const found = await as((tx) => port.get(tx, 'REMINDER_POLICY', 'DEFAULT', '2026-11-08'));
    expect(found).toMatchObject({ source: 'DEFAULT', version: 0, ruleId: null, unitId: null, unverified: true, provenance: { legalStatus: 'UNVERIFIED' } });
    expect(await as((tx) => port.get(tx, 'REMINDER_POLICY', 'NO_SUCH_CODE', '2026-11-08'))).toBeUndefined();
    expect(await as((tx) => port.get(tx, 'NOT_A_REGISTERED_TYPE', 'DEFAULT', '2026-11-08'))).toBeUndefined();
  });

  it('answers with the approved rule in force, with its version, and an instant is read as its Vietnam day', async () => {
    const code = 'IN_FORCE';
    await put({ code, params: REMINDER_A, from: '2026-03-01' });
    const found = await as((tx) => port.get(tx, 'REMINDER_POLICY', code, '2026-11-08'));
    expect(found).toMatchObject({ source: 'RULE', version: 1, params: REMINDER_A, unverified: false });
    // 2026-03-01 00:30 in Vietnam is still 2026-02-28 in UTC: the business day is the Vietnam day, so the rule is in force.
    expect((await as((tx) => port.get(tx, 'REMINDER_POLICY', code, new Date('2026-02-28T17:30:00Z'))))?.source).toBe('RULE');
    expect(await as((tx) => port.get(tx, 'REMINDER_POLICY', code, '2026-02-28'))).toBeUndefined();
  });

  it('never lets a draft or a submitted version govern anything', async () => {
    const code = 'NOT_APPROVED';
    await put({ code, version: 1, status: 'DRAFT', params: REMINDER_B });
    await put({ code, version: 2, status: 'SUBMITTED', params: REMINDER_B });
    expect(await as((tx) => port.get(tx, 'REMINDER_POLICY', code, '2026-11-08'))).toBeUndefined();
  });

  it('reads the version that governed a past day and the successor from the day it takes over (half open periods)', async () => {
    const code = 'VERSIONED';
    await put({ code, version: 1, status: 'RETIRED', params: REMINDER_A, from: '2026-01-01', to: '2026-06-01' });
    await put({ code, version: 2, params: REMINDER_B, from: '2026-06-01' });
    const on = (day: string): Promise<number | undefined> => as((tx) => port.get(tx, 'REMINDER_POLICY', code, day)).then((one) => one?.version);
    expect(await on('2025-12-31')).toBeUndefined();
    expect(await on('2026-01-01')).toBe(1);
    expect(await on('2026-05-31')).toBe(1);
    expect(await on('2026-06-01')).toBe(2);
    expect(await on('2027-01-01')).toBe(2);
    const old = await as((tx) => port.get(tx, 'REMINDER_POLICY', code, '2026-05-31'));
    expect(old?.params).toEqual(REMINDER_A);
  });

  it('refuses at the database an approval by the maker or by the submitter (maker is not checker)', async () => {
    const byMaker = await failure(put({ code: 'SOD_MAKER', approvedBy: MAKER, createdBy: MAKER }));
    expect(byMaker).toMatchObject({ code: '23514', constraint: 'governance_rule_sod_chk' });
    const bySubmitter = await failure(put({ code: 'SOD_SUBMITTER', approvedBy: SUBMITTER, submittedBy: SUBMITTER }));
    expect(bySubmitter).toMatchObject({ code: '23514', constraint: 'governance_rule_sod_chk' });
    expect(await as((tx) => port.get(tx, 'REMINDER_POLICY', 'SOD_MAKER', '2026-11-08'))).toBeUndefined();
  });

  it('refuses two approved versions of one code and one unit whose periods overlap, and allows the successor on the day the first ends', async () => {
    const code = 'OVERLAP';
    await put({ code, version: 1, params: REMINDER_A, from: '2026-01-01', to: '2026-07-01' });
    const clash = await failure(put({ code, version: 2, params: REMINDER_B, from: '2026-06-30' }));
    expect(clash).toMatchObject({ code: '23P01', constraint: 'governance_rule_no_overlap' });
    await put({ code, version: 2, params: REMINDER_B, from: '2026-07-01' });
    const sameNumber = await failure(put({ code, version: 2, params: REMINDER_B, from: '2027-01-01', to: '2027-02-01' }));
    expect(sameNumber.constraint).toBe('governance_rule_version_uq');
    // A different unit, a different code or a different tenant may have its own period at the same time.
    await put({ code, version: 1, unit: PROVINCE, params: REMINDER_PROVINCE, from: '2026-01-01' });
    await put({ code: 'OVERLAP_OTHER', version: 1, params: REMINDER_A, from: '2026-01-01' });
    await put({ tenant: TENANT_B, code, version: 1, params: REMINDER_A, from: '2026-01-01' });
  });

  it('lets an unapproved version that was retired have an empty period and overlap nothing', async () => {
    const code = 'EMPTY_PERIOD';
    await put({ code, version: 1, params: REMINDER_A, from: '2026-01-01' });
    await put({ code, version: 2, status: 'RETIRED', submittedBy: SUBMITTER, approvedBy: null, from: '2026-05-01', to: '2026-05-01' });
    expect((await as((tx) => port.get(tx, 'REMINDER_POLICY', code, '2026-05-01')))?.version).toBe(1);
    const retiredAfterTheFact = await failure(put({ code: 'EMPTY_PERIOD_2', version: 1, status: 'RETIRED', submittedBy: SUBMITTER, approvedBy: null, from: '2026-05-01', to: '2026-06-01' }));
    expect(retiredAfterTheFact.constraint).toBe('governance_rule_unapproved_retire_chk');
  });

  it('prefers the override of the nearest unit, then the rule of the whole tenant, then the default', async () => {
    const code = 'UNIT_OVERRIDE';
    await put({ code, version: 1, params: REMINDER_A });
    await put({ code, version: 1, unit: PROVINCE, params: REMINDER_PROVINCE });
    await put({ code, version: 1, unit: DEPARTMENT, params: REMINDER_DEPARTMENT });
    const read = (chain: number[]): Promise<{ params: unknown; unitId: string | null } | undefined> => as((tx) => port.get(tx, 'REMINDER_POLICY', code, '2026-11-08', { unitChain: chain.map(unitId) }));
    expect((await read([DEPARTMENT, PROVINCE, ROOT]))?.params).toEqual(REMINDER_DEPARTMENT);
    expect((await read([PROVINCE, ROOT]))?.params).toEqual(REMINDER_PROVINCE);
    expect((await read([ROOT]))?.params).toEqual(REMINDER_A);
    expect((await read([]))?.unitId).toBeNull();
    // An override of a unit that is not above the thing decided is ignored.
    expect((await read([ROOT, 9]))?.params).toEqual(REMINDER_A);
  });

  it('keeps tenants apart: the rule of another tenant is never read, not even with its unit', async () => {
    const code = 'ISOLATED';
    await put({ tenant: TENANT_B, code, version: 1, params: REMINDER_B });
    expect(await as((tx) => port.get(tx, 'REMINDER_POLICY', code, '2026-11-08'), TENANT_A)).toBeUndefined();
    expect((await as((tx) => port.get(tx, 'REMINDER_POLICY', code, '2026-11-08'), TENANT_B))?.params).toEqual(REMINDER_B);
    const visible = await as((tx) => tx.query<{ n: string }>('select count(*)::text as n from machvon.governance_rule where code = $1', [code]), TENANT_A);
    expect(visible[0]?.n).toBe('0');
    // Row-level security hides the row from a write as well: nothing is updated, nothing is refused.
    const touched = await as((tx) => tx.query<{ id: string }>(`update machvon.governance_rule set row_version = row_version + 1 where code = $1 returning id`, [code]), TENANT_A);
    expect(touched).toEqual([]);
    const planted = await failure(
      as((tx) =>
        tx.query(
          `insert into machvon.governance_rule (tenant_id, rule_type, code, version, params, effective_from, reason, created_by) values ($1, 'REMINDER_POLICY', 'PLANTED', 1, '{}'::jsonb, date '2026-01-01', 'Lý do của phiên bản', $2)`,
          [TENANT_B, memberId(MAKER)],
        ),
      ),
    );
    expect(planted.message).toMatch(/row-level security/);
  });

  it('lists every code that has a default or a rule in force for a type, each resolved, and require() refuses a code that has neither', async () => {
    await put({ code: 'EXTRA_CODE', params: REMINDER_B });
    const all = await as((tx) => port.getAll(tx, 'REMINDER_POLICY', '2026-11-08'));
    const codes = all.map((one) => one.code);
    expect(codes).toEqual(expect.arrayContaining(['DEFAULT', 'EXTRA_CODE']));
    expect(all.find((one) => one.code === 'DEFAULT')?.source).toBe('DEFAULT');
    expect(all.find((one) => one.code === 'EXTRA_CODE')?.source).toBe('RULE');
    const missing = await as((tx) => port.require(tx, 'REMINDER_POLICY', 'NOBODY_HOME', '2026-11-08')).catch((error: { code?: string; status?: number }) => error);
    expect(missing).toMatchObject({ code: 'GOVERNANCE_RULE_NOT_FOUND', status: 404 });
    expect((await as((tx) => port.require(tx, 'REMINDER_POLICY', 'DEFAULT', '2026-11-08'))).code).toBe('DEFAULT');
  });

  it('accepts any well-formed rule type name and refuses a malformed one (the registry is open)', async () => {
    await put({ type: 'TYPE_FROM_ANOTHER_LANE', code: 'DEFAULT', params: { anything: true } });
    expect((await as((tx) => port.get(tx, 'TYPE_FROM_ANOTHER_LANE', 'DEFAULT', '2026-11-08')))?.params).toEqual({ anything: true });
    for (const bad of ['lower_case', 'AB', '1ABC', 'HAS-DASH', `A${'B'.repeat(64)}`]) {
      const refused = await failure(put({ type: bad, code: 'DEFAULT' }));
      expect(refused.code).toBe('23514');
    }
    const code = await failure(put({ code: 'lower' }));
    expect(code.code).toBe('23514');
  });

  it('guards the table: the content of a version never changes, nothing is deleted, the moves are those of the life of a version', async () => {
    const id = await put({ code: 'GUARDED', status: 'DRAFT', params: REMINDER_A, createdBy: MAKER });
    const content = await failure(as((tx) => tx.query(`update machvon.governance_rule set params = '{}'::jsonb where id = $1`, [id])));
    expect(content).toMatchObject({ code: '42501' });
    expect(content.message).toMatch(/never changes/);
    const removal = await failure(as((tx) => tx.query('delete from machvon.governance_rule where id = $1', [id])));
    expect(removal.code).toBe('42501');
    const jump = await failure(as((tx) => tx.query(`update machvon.governance_rule set status = 'APPROVED', approved_by = $2, approved_at = now() where id = $1`, [id, memberId(CHECKER)])));
    expect(jump.code).toBe('42501');
    // The legal path: submit, then a third person approves.
    await as((tx) => tx.query(`update machvon.governance_rule set status = 'SUBMITTED', submitted_by = $2, submitted_at = now(), row_version = row_version + 1 where id = $1`, [id, memberId(SUBMITTER)]));
    const selfApproval = await failure(as((tx) => tx.query(`update machvon.governance_rule set status = 'APPROVED', approved_by = $2, approved_at = now() where id = $1`, [id, memberId(MAKER)])));
    expect(selfApproval).toMatchObject({ code: '23514', constraint: 'governance_rule_sod_chk' });
    await as((tx) => tx.query(`update machvon.governance_rule set status = 'APPROVED', approved_by = $2, approved_at = now(), row_version = row_version + 1 where id = $1`, [id, memberId(CHECKER)]), TENANT_A, CHECKER);
    const rewrite = await failure(as((tx) => tx.query(`update machvon.governance_rule set approved_by = $2 where id = $1`, [id, memberId(SUBMITTER)])));
    expect(rewrite.code).toBe('42501');
    const widen = await failure(as((tx) => tx.query(`update machvon.governance_rule set effective_from = date '2020-01-01' where id = $1`, [id])));
    expect(widen.code).toBe('42501');
    await as((tx) =>
      tx.query(`update machvon.governance_rule set status = 'RETIRED', effective_to = date '2026-12-31', retired_by = $2, retired_at = now(), retire_reason = 'Không còn áp dụng', row_version = row_version + 1 where id = $1`, [id, memberId(CHECKER)]),
    );
    const back = await failure(as((tx) => tx.query(`update machvon.governance_rule set status = 'APPROVED' where id = $1`, [id])));
    expect(back.code).toBe('42501');
    const later = await failure(as((tx) => tx.query(`update machvon.governance_rule set effective_to = date '2027-12-31' where id = $1`, [id])));
    expect(later.code).toBe('42501');
  });
});
