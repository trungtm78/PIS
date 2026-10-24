import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { PmtPermitTypeStore } from '../src/pmt-permit-type-store';
import type { PermitTypeInput, PermitTypeRow } from '../src/pmt-permit-type-store';
import { PERMIT_TYPE_WORKING_ASSUMPTIONS } from '../src/pmt-permit-type-seed';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, id, memberId, unitId } from './support/authz-fixtures';

const harness = new AuthzHarness();
/** The day the tests stand on: a successor revision may begin on it or later, never before. */
const TODAY = '2026-08-01';
const types = new PmtPermitTypeStore({ today: () => TODAY });
const LEGAL_MANAGER = 1;
const ACTOR = memberId(LEGAL_MANAGER);
const PROJECT = id(0x91, 1);
const DOSSIER = id(0x92, 1);

const as = <T>(work: (tx: TenantTx) => Promise<T>, tenant = TENANT_A): Promise<T> => harness.tenants.withTenant(contextFor(tenant, ACTOR), work);
const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);

interface Refusal {
  code: string;
  status: number;
  detail?: string;
}

async function refusal(work: Promise<unknown>): Promise<Refusal> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; status?: number; detail?: string };
    return { code: e.code ?? '', status: e.status ?? 0, ...(e.detail === undefined ? {} : { detail: e.detail }) };
  }
  throw new Error('expected a refusal');
}

let counter = 0;
/** A code that no other test uses, so each test owns its versions. */
const freshCode = (): string => {
  counter += 1;
  return `TYPE_${counter}`;
};

const input = (code: string, overrides: Partial<PermitTypeInput> = {}): PermitTypeInput => ({
  code,
  name: 'Construction permit',
  category: 'CONSTRUCTION_PERMIT',
  authorityText: 'The authority the regulation names',
  legalBasis: 'Fixture decree, article 1',
  effectiveFrom: '2026-01-01',
  appliesToRule: {},
  ...overrides,
});
const publish = (value: PermitTypeInput, tenant = TENANT_A) => as((tx) => types.publish(tx, value, ACTOR), tenant);
const retire = (typeId: string, until: string, tenant = TENANT_A) => as((tx) => types.retire(tx, typeId, until, ACTOR), tenant);
const byId = (typeId: string, tenant = TENANT_A): Promise<PermitTypeRow | undefined> => as((tx) => types.find(tx, typeId), tenant);
const row = async (typeId: string): Promise<PermitTypeRow> => {
  const found = await byId(typeId);
  if (found === undefined) throw new Error(`no permit type ${typeId}`);
  return found;
};

/** A permit written under a version, in the status given (the rows around it are not what is under test). */
async function seedPermit(typeId: string, status: string, expectedDecisionOn: string | null): Promise<string> {
  const permitId = randomUUID();
  const issued = status === 'ISSUED';
  const admin = new Client({ connectionString: harness.database.adminUrl });
  await admin.connect();
  try {
    await admin.query('set session_replication_role = replica');
    await admin.query(
      `insert into machvon.permit (tenant_id, id, dossier_id, permit_type_id, status, expected_decision_on, permit_no, issued_on, valid_from, no_expiry, document_version_id, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $6::date, $8, $9::date, $9::date, $10, $11, $7, $7)`,
      // An issued permit carries its number, its day and its scan (permit_issued_chk).
      [TENANT_A, permitId, DOSSIER, typeId, status, expectedDecisionOn, ACTOR, issued ? permitId.slice(0, 8) : null, issued ? '2026-02-01' : null, issued, issued ? randomUUID() : null],
    );
  } finally {
    await admin.end();
  }
  return permitId;
}

describe('PmtPermitTypeStore (the permit type catalogue as dated legal data, ST-PMT-001)', () => {
  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [{ n: 1, path: '/u1/' }]);
      await harness.seedMembership(tenant, LEGAL_MANAGER, 1);
    }
    const admin = new Client({ connectionString: harness.database.adminUrl });
    await admin.connect();
    try {
      await admin.query('set session_replication_role = replica');
      await admin.query(
        `insert into machvon.permit_dossier (tenant_id, id, project_id, owner_unit_id, created_by, updated_by) values ($1, $2, $3, $4, $5, $5)`,
        [TENANT_A, DOSSIER, PROJECT, unitId(1), ACTOR],
      );
    } finally {
      await admin.end();
    }
  }, 240_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  describe('publishing a version', () => {
    it('stores the legal data of a first revision, published, with the working-assumption flag when it carries a confirmation id (AC-ST-PMT-001-1)', async () => {
      const code = freshCode();
      const published = await publish(
        input(code, {
          legalBasis: '  Construction Law 135/2025, article 43  ',
          cxnRef: 'CXN-EXE-02',
          effectiveUntil: '2031-12-31',
          appliesToRule: { work_types: ['ROAD'], max_total_investment_vnd: '2300000000000' },
          defaultValidityMonths: 24,
          defaultProcessingDays: 30,
          exemptionAllowed: true,
        }),
      );
      expect(published).toMatchObject({ revision: 1, version: 1, supersededId: null });
      expect(await row(published.id)).toMatchObject({
        code,
        revision: 1,
        status: 'PUBLISHED',
        legalBasis: 'Construction Law 135/2025, article 43',
        cxnRef: 'CXN-EXE-02',
        effectiveFrom: '2026-01-01',
        effectiveUntil: '2031-12-31',
        appliesToRule: { work_types: ['ROAD'], max_total_investment_vnd: '2300000000000' },
        defaultValidityMonths: 24,
        defaultProcessingDays: 30,
        exemptionAllowed: true,
        supersedesId: null,
        version: 1,
      });
    });

    it('lets the first revision of a code begin on a day that is gone, because the regulation may be in force already', async () => {
      const published = await publish(input(freshCode(), { effectiveFrom: '2024-05-01' }));
      expect((await row(published.id)).effectiveFrom).toBe('2024-05-01');
    });

    it('stores a version without a confirmation id as confirmed, with no default periods when none is given', async () => {
      const stored = await row((await publish(input(freshCode()))).id);
      expect(stored).toMatchObject({ cxnRef: null, defaultValidityMonths: null, defaultProcessingDays: null, exemptionAllowed: false });
    });

    it.each([
      ['no legal basis', ''],
      ['a blank legal basis', '   \t '],
    ])('refuses %s with LEGAL_BASIS_REQUIRED and stores nothing (AC-ST-PMT-001-1)', async (_name, legalBasis) => {
      const code = freshCode();
      expect(await refusal(publish(input(code, { legalBasis })))).toEqual({ code: 'LEGAL_BASIS_REQUIRED', status: 422, detail: 'legal_basis' });
      expect(await owner('select id from machvon.permit_type where code = $1', [code])).toHaveLength(0);
    });

    it('ends the open-ended revision the day before the next one begins, and each applies on its own days (AC-ST-PMT-001-1)', async () => {
      const code = freshCode();
      const first = await publish(input(code));
      const second = await publish(input(code, { effectiveFrom: '2027-01-01', legalBasis: 'Fixture decree, article 2' }));
      expect(second).toMatchObject({ revision: 2, version: 1, supersededId: first.id });
      expect(await row(first.id)).toMatchObject({ status: 'RETIRED', effectiveUntil: '2026-12-31', version: 2 });
      expect(await row(second.id)).toMatchObject({ status: 'PUBLISHED', effectiveFrom: '2027-01-01', effectiveUntil: null, supersedesId: first.id });
      const on = (day: string) => as((tx) => types.inForce(tx, code, day));
      expect([(await on('2025-12-31'))?.id, (await on('2026-12-31'))?.id, (await on('2027-01-01'))?.id, (await on('2040-01-01'))?.id]).toEqual([undefined, first.id, second.id, second.id]);
    });

    it('refuses a revision whose days overlap the one before, whether that one is open-ended or closed (AC-ST-PMT-001-1)', async () => {
      const closed = freshCode();
      await publish(input(closed, { effectiveFrom: '2026-01-01', effectiveUntil: '2026-12-31' }));
      expect(await refusal(publish(input(closed, { effectiveFrom: '2026-12-31' })))).toEqual({ code: 'PERMIT_TYPE_OVERLAP', status: 409 });
      expect(await refusal(publish(input(closed, { effectiveFrom: '2026-06-01', effectiveUntil: '2027-06-30' })))).toEqual({ code: 'PERMIT_TYPE_OVERLAP', status: 409 });
      // A day before the first one began, or the same day: a revision does not go back in time.
      expect(await refusal(publish(input(closed, { effectiveFrom: '2025-01-01', effectiveUntil: '2025-12-31' })))).toEqual({ code: 'PERMIT_TYPE_OVERLAP', status: 409 });
      const open = freshCode();
      await publish(input(open, { effectiveFrom: '2026-03-01' }));
      expect(await refusal(publish(input(open, { effectiveFrom: '2026-03-01' })))).toEqual({ code: 'PERMIT_TYPE_OVERLAP', status: 409 });
      expect(await refusal(publish(input(open, { effectiveFrom: '2026-03-02' })))).toEqual({ code: 'PERMIT_TYPE_OVERLAP', status: 409 });
      expect(await owner('select revision from machvon.permit_type where code = $1', [open])).toHaveLength(1);
    });

    it('leaves a gap when the next revision begins after the last day of a closed one, and retires the one before', async () => {
      const code = freshCode();
      const first = await publish(input(code, { effectiveFrom: '2026-01-01', effectiveUntil: '2026-12-31' }));
      const second = await publish(input(code, { effectiveFrom: '2027-03-01' }));
      expect(await row(first.id)).toMatchObject({ status: 'RETIRED', effectiveUntil: '2026-12-31' });
      expect(second.supersededId).toBe(first.id);
      expect(await as((tx) => types.inForce(tx, code, '2027-02-15'))).toBeUndefined();
    });

    it('refuses a revision after the first that would begin on a day that is gone', async () => {
      const code = freshCode();
      await publish(input(code, { effectiveFrom: '2026-01-01', effectiveUntil: '2026-03-31' }));
      expect(await refusal(publish(input(code, { effectiveFrom: '2026-05-01' })))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'effective_from' });
      const second = await publish(input(code, { effectiveFrom: TODAY }));
      expect(second.revision).toBe(2);
    });

    it('runs the whole scenario of UAT-AC371 in order (AC-ST-PMT-001-1)', async () => {
      const code = freshCode();
      const first = await publish(input(code, { effectiveFrom: '2026-01-01', legalBasis: 'Fixture decree, article 1' }));
      const used = await seedPermit(first.id, 'IN_APPRAISAL', '2027-03-01');
      expect(await refusal(publish(input(code, { effectiveFrom: '2027-01-01', legalBasis: '' })))).toMatchObject({ code: 'LEGAL_BASIS_REQUIRED' });
      const second = await publish(input(code, { effectiveFrom: '2027-01-01', legalBasis: 'Fixture decree, article 2' }));
      expect(second.revision).toBe(2);
      expect((await owner<{ permit_type_id: string }>('select permit_type_id from machvon.permit where id = $1::uuid', [used]))[0]?.permit_type_id).toBe(first.id);
      expect(await refusal(publish(input(code, { effectiveFrom: '2026-06-01' })))).toEqual({ code: 'PERMIT_TYPE_OVERLAP', status: 409 });
      // The permit in appraisal is expected to be decided after 31 December 2026, so ending the first revision there strands it.
      expect(await refusal(retire(first.id, '2026-12-31'))).toEqual({ code: 'PERMIT_TYPE_IN_USE', status: 422 });
    });

    it('lets only one of two publications of the same revision win, whichever way they race', async () => {
      const code = freshCode();
      await publish(input(code));
      const attempts = await Promise.allSettled([publish(input(code, { effectiveFrom: '2027-01-01', name: 'First racer' })), publish(input(code, { effectiveFrom: '2027-01-01', name: 'Second racer' }))]);
      expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
      const lost = attempts.find((attempt) => attempt.status === 'rejected') as PromiseRejectedResult;
      expect(lost.reason).toMatchObject({ code: 'PERMIT_TYPE_OVERLAP', status: 409 });
      const revisions = await owner<{ revision: number; status: string }>('select revision, status from machvon.permit_type where code = $1 order by revision', [code]);
      expect(revisions.map((r) => r.revision)).toEqual([1, 2]);
      expect(revisions.filter((r) => r.status === 'PUBLISHED')).toHaveLength(1);
    });

    it('keeps the catalogue of each tenant apart: the same code is a different type in another tenant', async () => {
      const code = freshCode();
      const mine = await publish(input(code));
      const theirs = await publish(input(code, { legalBasis: 'Another tenant basis' }), TENANT_B);
      expect(theirs.revision).toBe(1);
      expect(await byId(theirs.id)).toBeUndefined();
      expect(await byId(mine.id, TENANT_B)).toBeUndefined();
      expect(await refusal(retire(theirs.id, '2030-01-01'))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    });

    it.each([
      ['a lower-case code', { code: 'building_permit' }, 'code'],
      ['a code that starts with a digit', { code: '1_PERMIT' }, 'code'],
      ['an unknown category', { category: 'MISC' }, 'category'],
      ['a blank name', { name: ' ' }, 'name'],
      ['a name with a control character', { name: 'Permit\u0007' }, 'name'],
      ['a blank authority', { authorityText: '' }, 'authority_text'],
      ['a legal basis longer than the column', { legalBasis: 'x'.repeat(2001) }, 'legal_basis'],
      ['a confirmation id that is not one', { cxnRef: 'EXE-03' }, 'cxn_ref'],
      ['a date that does not exist', { effectiveFrom: '2026-02-30' }, 'effective_from'],
      ['an end that does not exist', { effectiveUntil: '2026-13-01' }, 'effective_until'],
      ['an end on the first day', { effectiveFrom: '2026-05-01', effectiveUntil: '2026-05-01' }, 'effective_until'],
      ['an end before the start', { effectiveFrom: '2026-05-01', effectiveUntil: '2026-04-01' }, 'effective_until'],
      ['a validity of zero months', { defaultValidityMonths: 0 }, 'default_validity_months'],
      ['a validity that is not whole', { defaultValidityMonths: 1.5 }, 'default_validity_months'],
      ['a processing time over ten years', { defaultProcessingDays: 3651 }, 'default_processing_days'],
      ['a condition with an unknown key', { appliesToRule: { colour: 'red' } }, 'applies_to_rule'],
    ] as Array<[string, Partial<PermitTypeInput>, string]>)('refuses %s as a 422 naming the field', async (_name, overrides, field) => {
      expect(await refusal(publish(input(freshCode(), overrides)))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: field });
    });
  });

  describe('retiring a version', () => {
    it('ends a version on its last day, keeps the row and leaves what was written under it alone (AC-ST-PMT-001-1)', async () => {
      const published = await publish(input(freshCode()));
      const issued = await seedPermit(published.id, 'ISSUED', '2026-02-01');
      const retired = await retire(published.id, '2026-12-31');
      expect(retired).toMatchObject({ version: 2, changed: true });
      expect(await row(published.id)).toMatchObject({ status: 'RETIRED', effectiveUntil: '2026-12-31', version: 2 });
      expect((await owner<{ permit_type_id: string; status: string }>('select permit_type_id, status from machvon.permit where id = $1::uuid', [issued]))[0]).toEqual({
        permit_type_id: published.id,
        status: 'ISSUED',
      });
    });

    it('lets a permit that will be decided by the last day, or is decided already, stay', async () => {
      const published = await publish(input(freshCode()));
      await seedPermit(published.id, 'IN_APPRAISAL', '2026-12-31');
      await seedPermit(published.id, 'REJECTED', null);
      await seedPermit(published.id, 'EXPIRED', null);
      expect((await retire(published.id, '2026-12-31')).changed).toBe(true);
    });

    it.each([
      ['planned and undated', 'PLANNED', null],
      ['submitted', 'SUBMITTED', '2027-01-01'],
      ['in appraisal', 'IN_APPRAISAL', '2027-06-30'],
      ['waiting for a supplement', 'SUPPLEMENT_REQUESTED', '2027-02-01'],
    ])('refuses to end a version while a permit that is %s is expected after the last day', async (_name, status, expected) => {
      const published = await publish(input(freshCode()));
      await seedPermit(published.id, status, expected);
      expect(await refusal(retire(published.id, '2026-12-31'))).toEqual({ code: 'PERMIT_TYPE_IN_USE', status: 422 });
      expect(await row(published.id)).toMatchObject({ status: 'PUBLISHED', effectiveUntil: null, version: 1 });
    });

    it('moves the end only earlier, and asking for the end it already has changes nothing', async () => {
      const code = freshCode();
      const first = await publish(input(code));
      await publish(input(code, { effectiveFrom: '2027-01-01' }));
      // The first revision ended on 31 December when the second took over.
      expect(await refusal(retire(first.id, '2027-06-30'))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'effective_until' });
      expect(await retire(first.id, '2026-12-31')).toMatchObject({ version: 2, changed: false });
      expect(await retire(first.id, '2026-11-30')).toMatchObject({ version: 3, changed: true });
      expect(await row(first.id)).toMatchObject({ effectiveUntil: '2026-11-30', version: 3 });
    });

    it('refuses to end a draft, which is not a published version', async () => {
      const draftId = randomUUID();
      await owner(
        `insert into machvon.permit_type (tenant_id, id, code, name, category, authority_text, legal_basis, effective_from, applies_to_rule, status, created_by, updated_by)
         values ($1, $2, $3, 'Draft', 'OTHER', 'Authority', 'Basis', date '2026-01-01', '{}'::jsonb, 'DRAFT', $4, $4)`,
        [TENANT_A, draftId, freshCode(), ACTOR],
      );
      expect(await refusal(retire(draftId, '2027-01-01'))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'status' });
    });

    it('refuses an end on or before the first day, an end in days that are gone, a bad date and a version that does not exist', async () => {
      const published = await publish(input(freshCode(), { effectiveFrom: '2026-01-01' }));
      expect(await refusal(retire(published.id, '2026-01-01'))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'effective_until' });
      expect(await refusal(retire(published.id, '2026-07-31'))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'effective_until' });
      expect(await refusal(retire(published.id, '2026-02-30'))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'effective_until' });
      expect(await refusal(retire(randomUUID(), '2030-01-01'))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    });
  });

  describe('the database has the last word', () => {
    const published = async (overrides: Partial<PermitTypeInput> = {}): Promise<string> => (await publish(input(freshCode(), overrides))).id;
    const sqlRefusal = async (sql: string, params: unknown[]): Promise<string> => {
      try {
        await owner(sql, params);
      } catch (error) {
        return (error as { code?: string }).code ?? '';
      }
      throw new Error('expected the database to refuse');
    };

    it.each([
      ['the legal basis', 'legal_basis', "'Rewritten'"],
      ['the name', 'name', "'Renamed'"],
      ['the first day', 'effective_from', "date '2025-06-01'"],
      ['the condition', 'applies_to_rule', "'{\"work_types\":[\"ROAD\"]}'::jsonb"],
      ['the confirmation id', 'cxn_ref', 'null'],
      ['the right to be exempt', 'exemption_allowed', 'true'],
      ['the revision', 'revision', '9'],
    ])('does not let anyone edit %s of a published version (AC-ST-PMT-001-1)', async (_name, column, value) => {
      const typeId = await published({ cxnRef: 'CXN-EXE-03' });
      expect(await sqlRefusal(`update machvon.permit_type set ${column} = ${value} where id = $1::uuid`, [typeId])).toBe('23514');
    });

    it('does not let a version move its end later, come back from retired, or lose its end once retired', async () => {
      const typeId = await published({ effectiveUntil: '2030-12-31' });
      expect(await sqlRefusal("update machvon.permit_type set effective_until = date '2031-12-31' where id = $1::uuid", [typeId])).toBe('23514');
      await retire(typeId, '2029-12-31');
      expect(await sqlRefusal("update machvon.permit_type set status = 'PUBLISHED' where id = $1::uuid", [typeId])).toBe('23514');
      expect(await sqlRefusal('update machvon.permit_type set effective_until = null where id = $1::uuid', [typeId])).toBe('23514');
      expect(await sqlRefusal("update machvon.permit_type set effective_until = date '2030-06-30' where id = $1::uuid", [typeId])).toBe('23514');
    });

    it('does not let the runtime role delete a version, nor a version be written without a legal basis or over another one', async () => {
      const typeId = await published();
      await expect(as((tx) => tx.query('delete from machvon.permit_type where id = $1::uuid', [typeId]))).rejects.toMatchObject({ code: '42501' });
      expect(await owner('select id from machvon.permit_type where id = $1::uuid', [typeId])).toHaveLength(1);
      const insert = (code: string, revision: number, legalBasis: string, from: string) =>
        sqlRefusal(
          `insert into machvon.permit_type (tenant_id, id, code, revision, name, category, authority_text, legal_basis, effective_from, effective_until, applies_to_rule, status, created_by, updated_by)
           values ($1, gen_random_uuid(), $2, $3, 'Direct', 'OTHER', 'Authority', $4, $5::date, date '2027-12-31', '{}'::jsonb, 'RETIRED', $6, $6)`,
          [TENANT_A, code, revision, legalBasis, from, ACTOR],
        );
      expect(await insert(freshCode(), 1, '   ', '2026-01-01')).toBe('23514');
      const code = freshCode();
      await publish(input(code, { effectiveFrom: '2026-01-01', effectiveUntil: '2026-12-31' }));
      expect(await insert(code, 2, 'Direct basis', '2026-06-01')).toBe('23P01');
    });

    it('does not let a retired version be written without the day it ended, nor a code or reference of the wrong shape', async () => {
      const typeId = await published();
      expect(await sqlRefusal("update machvon.permit_type set status = 'RETIRED' where id = $1::uuid", [typeId])).toBe('23514');
      const insertRaw = (code: string, cxn: string | null) =>
        sqlRefusal(
          `insert into machvon.permit_type (tenant_id, id, code, name, category, authority_text, legal_basis, cxn_ref, effective_from, applies_to_rule, created_by, updated_by)
           values ($1, gen_random_uuid(), $2, 'Direct', 'OTHER', 'Authority', 'Basis', $3, date '2026-01-01', '{}'::jsonb, $4, $4)`,
          [TENANT_A, code, cxn, ACTOR],
        );
      expect(await insertRaw('lower_case', null)).toBe('23514');
      expect(await insertRaw(freshCode(), 'EXE-03')).toBe('23514');
    });
  });

  describe('reading the catalogue', () => {
    it('lists the versions of the tenant newest first, filtered by code, category and status, and pages them by keyset', async () => {
      const code = freshCode();
      const first = await publish(input(code, { category: 'LAND' }));
      const second = await publish(input(code, { category: 'LAND', effectiveFrom: '2027-01-01' }));
      const other = await publish(input(freshCode(), { category: 'TRAFFIC' }));
      const page = (filter: Parameters<PmtPermitTypeStore['list']>[1], limit = 50, after?: { code: string; id: string }) => as((tx) => types.list(tx, filter, { limit, after }));
      expect((await page({ code })).map((r) => r.id)).toEqual([second.id, first.id]);
      expect((await page({ code, status: 'RETIRED' })).map((r) => r.id)).toEqual([first.id]);
      expect((await page({ category: 'TRAFFIC' })).map((r) => r.id)).toContain(other.id);
      expect((await page({ code, category: 'TRAFFIC' }))).toHaveLength(0);
      const head = await page({ code }, 1);
      expect(head.map((r) => r.id)).toEqual([second.id]);
      const next = await page({ code }, 1, { code: head[0]?.createdAtKey ?? '', id: head[0]?.id ?? '' });
      expect(next.map((r) => r.id)).toEqual([first.id]);
      expect(await page({ code }, 1, { code: next[0]?.createdAtKey ?? '', id: next[0]?.id ?? '' })).toEqual([]);
    });

    it('finds nothing in force for a code that does not exist', async () => {
      expect(await as((tx) => types.inForce(tx, 'NO_SUCH_TYPE', '2026-08-01'))).toBeUndefined();
      expect(await byId(randomUUID())).toBeUndefined();
    });
  });

  describe('the starting catalogue of working assumptions', () => {
    it('gives a tenant the eight types of the design, each waiting for its confirmation, and gives them once', async () => {
      const added = await as((tx) => types.seedWorkingAssumptions(tx, ACTOR), TENANT_B);
      expect(added).toEqual(PERMIT_TYPE_WORKING_ASSUMPTIONS.map((type) => type.code));
      expect(added).toHaveLength(8);
      const seeded = await owner<{ code: string; cxn_ref: string; status: string; legal_basis: string; default_validity_months: number | null }>(
        'select code, cxn_ref, status, legal_basis, default_validity_months from machvon.permit_type where code = any($1::text[])',
        [added],
        TENANT_B,
      );
      expect(seeded).toHaveLength(8);
      expect(seeded.every((type) => type.status === 'PUBLISHED' && /^CXN-EXE-0[23]$/.test(type.cxn_ref) && type.legal_basis.includes(type.cxn_ref) && type.default_validity_months === null)).toBe(true);
      expect(seeded.find((type) => type.code === 'BUILDING_PERMIT')?.cxn_ref).toBe('CXN-EXE-02');
      expect(await as((tx) => types.seedWorkingAssumptions(tx, ACTOR), TENANT_B)).toEqual([]);
    });

    it('leaves alone a code the tenant already confirmed with a revision of its own', async () => {
      await as((tx) => types.seedWorkingAssumptions(tx, ACTOR), TENANT_A);
      const confirmed = await publish(input('ENV_EIA', { effectiveFrom: '2026-09-01', legalBasis: 'Environmental Protection Law 2020, read from the original text' }));
      expect(confirmed.revision).toBe(2);
      expect((await row(confirmed.id)).cxnRef).toBeNull();
      expect(await as((tx) => types.seedWorkingAssumptions(tx, ACTOR), TENANT_A)).toEqual([]);
    });
  });
});
