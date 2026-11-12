import { randomUUID } from 'node:crypto';
import { TENANT_A, TENANT_B, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { assertRefusedForPermission, assertStatus, codeOf, expectCheckFails } from '../uat/uat-kit';
import type { Reply } from '../uat/uat-kit';
import { ROOT_UNIT, UatWorld } from '../uat/uat-world';
import { scopedCaller, seedScopedMembers } from './support';

/**
 * Cases of docs/uat/ebs/uat.json that the suite `../uat/ebs.uat.test.ts` does not script: the two stories of the file and of the reconciliation seen as the three attackers of the design (the maker who tries the next
 * step of their own work, the member of another tenant who uses an id of this one, the reader who sends a command), and the boundaries of the amounts, the periods and the days of a file. The layout of the file is a
 * working assumption (PENDING-EXTERNAL, R18). Each case is named by its id in the title of its test.
 */
jest.setTimeout(240_000);

const HEADER = 'project_code,period,extract_date,disbursed_vnd,committed_vnd';
const DEPARTMENT = 2;
const UNIT_HOLDER = 40; // every right of the area, on the unit tree of the department only
const PERSONAS = {
  'ebs-admin': ['ebs.read', 'ebs.admin', 'ebs.import', 'ebs.import.preview', 'ebs.reconcile'],
  'ebs-previewer': ['ebs.read', 'ebs.import.preview'],
  'ebs-reconciler': ['ebs.read', 'ebs.reconcile'],
  'ebs-owner': ['ebs.read', 'ebs.reconcile'],
  'ebs-reader': ['ebs.read'],
};
const csv = (...lines: string[]): Uint8Array => new TextEncoder().encode(lines.join('\n'));

/** The refusal of a step the caller has no standing for: 403 with the code of the self-approval rule or of the scope. */
function assertRefusedAsMaker(reply: Reply): void {
  assertStatus(reply, 403);
  if (!['SELF_APPROVAL_DENIED', 'SCOPE_DENIED'].includes(codeOf(reply) ?? '')) throw new Error(`expected SELF_APPROVAL_DENIED or SCOPE_DENIED, got ${reply.status} ${codeOf(reply)}`);
}

describe('UAT cases of the reconciliation with Oracle EBS that the suite of the area does not script (EBS)', () => {
  const world = new UatWorld();
  const unitCaller = scopedCaller(world);
  let counter = 0;

  beforeAll(async () => {
    await world.start(PERSONAS, { 'ebs-admin': PERSONAS['ebs-admin'] }, async (w) => {
      await w.harness.seedUnits(TENANT_A, [{ n: DEPARTMENT, path: `/${unitId(ROOT_UNIT)}/${unitId(DEPARTMENT)}/`, parent: ROOT_UNIT }]);
      await seedScopedMembers(w, [{ n: UNIT_HOLDER, permissions: ['ebs.read', 'ebs.import', 'ebs.import.preview', 'ebs.reconcile'], kind: 'UNIT_SUBTREE', units: [DEPARTMENT] }]);
      // The published working calendar of three years: the items of a reconciliation get a due time from it.
      const year = new Date().getUTCFullYear();
      await w.seedAsAdmin(
        [year - 1, year, year + 1].map((value): [string, unknown[]] => [
          `insert into machvon.work_calendar_version (tenant_id, id, calendar_code, year, revision, working_days, holidays, compensated_workdays, legal_basis_ref, status, created_by, published_by, published_at)
           values ($1, gen_random_uuid(), 'WORKDAY_VN', $2, 1, '[1,2,3,4,5]'::jsonb, '[]'::jsonb, '[]'::jsonb, 'Labour Code 2019', 'Published', $3, $3, now())`,
          [TENANT_A, value, memberId(1)],
        ]),
      );
    });
  }, 300_000);

  afterAll(() => world.stop(), 60_000);

  /** A project of ours with the money the Treasury paid, so that a statement can differ from it. */
  async function project(paid: string): Promise<string> {
    counter += 1;
    const projectId = randomUUID();
    const code = `UAT-EBX-P${String(counter).padStart(3, '0')}`;
    await world.seedAsAdmin([
      [
        `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, investor_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
         values ($1, $2, $3, 'Plant project', $4, $4, $5, 'INTERNAL', 1000000000, 'IMPLEMENTATION', 1, 'B')`,
        [TENANT_A, projectId, code, unitId(ROOT_UNIT), id(0x97, 91)],
      ],
      [
        `insert into machvon.treasury_transaction (tenant_id, id, project_id, external_id, provider, amount_vnd, confirmed_at, source_hash, direction, reversal_of_id, import_id)
         values ($1, gen_random_uuid(), $2, $3, 'TREASURY', $4::numeric, '2026-10-01T08:00:00+07:00', $5, 'PAYMENT', null, gen_random_uuid())`,
        [TENANT_A, projectId, `EXT-${code}`, paid, 'd'.repeat(64)],
      ],
    ]);
    return code;
  }

  const door = (bytes: Uint8Array): Promise<{ key: string; sha: string }> => world.store(bytes, 'import', 'text/csv', 'ebs-admin');
  const body = (file: { key: string; sha: string }): Record<string, unknown> => ({ file_object_key: file.key, file_sha256: file.sha });
  const items = (reply: Reply): Array<Record<string, unknown>> => reply.json.items as Array<Record<string, unknown>>;
  const count = async (sql: string, params: unknown[] = []): Promise<number> => (await world.rows(sql, params)).length;

  /** A difference of a project, opened by the run of the reconciler (a maker) for the owner. */
  async function openItem(): Promise<{ id: string; version: number; code: string }> {
    const code = await project('900');
    const loaded = await world.as('ebs-admin', 'POST', '/ebs/imports', { body: body(await door(csv(HEADER, `${code},2026-10,2026-11-06,950,`))) });
    assertStatus(loaded, 200);
    const run = await world.as('ebs-reconciler', 'POST', '/ebs/reconciliations', { body: { period: '2026-10', owner_id: world.idOf('ebs-owner') } });
    assertStatus(run, 200);
    const item = items(run).find((candidate) => candidate.project_code === code) as { id: string; version: number };
    return { id: item.id, version: item.version, code };
  }

  it('UAT-PLAN-174 the dry run and the apply of a file: a holder below the whole tenant and a previewer are refused the apply (403), a member of another tenant naming a file of this one is answered as for a file that does not exist (404), a reader is refused (403), and nothing changes', async () => {
    const code = await project('50');
    const file = await door(csv(HEADER, `${code},2026-10,2026-11-02,10,20`));
    const records = (): Promise<number> => count('select 1 from machvon.ebs_record where project_code = $1', [code]);
    const imports = (): Promise<number> => count("select 1 from machvon.audit_event where action = 'ebs.import_applied'");
    const importsBefore = await imports();

    // Step 1: whoever may only try the file, or holds the right on a part of the tenant, does not apply it.
    assertRefusedForPermission(await world.as('ebs-previewer', 'POST', '/ebs/imports', { body: body(file) }));
    assertRefusedAsMaker(await unitCaller(UNIT_HOLDER, 'POST', '/ebs/imports', { body: body(file) }));
    expect((await unitCaller(UNIT_HOLDER, 'POST', '/ebs/imports', { body: body(file) })).json).toMatchObject({ code: 'SCOPE_DENIED' });
    assertStatus(await world.as('ebs-previewer', 'POST', '/ebs/imports/preview', { body: body(file) }), 200);

    // Step 2: the key of a file of tenant A, in the hands of a member of tenant B, is a key that names nothing.
    const missing = { ...body(file), file_object_key: file.key.replace(/[0-9a-f-]{36}$/, randomUUID()) };
    for (const path of ['/ebs/imports', '/ebs/imports/preview']) {
      const foreign = await world.asTenantB(1, 'POST', path, { body: body(file) });
      const nothing = await world.asTenantB(1, 'POST', path, { body: missing });
      expect([foreign.status, codeOf(foreign)]).toEqual([nothing.status, codeOf(nothing)]);
      assertStatus(foreign, 404);
    }

    // Step 3: a reader sends the commands.
    assertRefusedForPermission(await world.as('ebs-reader', 'POST', '/ebs/imports', { body: body(file) }));
    assertRefusedForPermission(await world.as('ebs-reader', 'POST', '/ebs/imports/preview', { body: body(file) }));

    expect(await records()).toBe(0);
    expect(await imports()).toBe(importsBefore);
    expect(await world.rows('select 1 from machvon.ebs_record', [], TENANT_B)).toHaveLength(0);
  });

  it('UAT-PLAN-150 the reconciliation and its differences: a maker who is not the owner and a holder below the whole tenant are refused the settling, an item is not handed to a maker (403), a member of another tenant is answered as for an id that does not exist (404), a reader is refused (403), and nothing changes', async () => {
    const item = await openItem();
    const stateOf = async (): Promise<Record<string, unknown>> =>
      (await world.rows<Record<string, unknown>>('select state, owner_id, version, resolution_kind, resolved_by from machvon.ebs_reconciliation_item where id = $1::uuid', [item.id]))[0] as Record<string, unknown>;
    const before = await stateOf();
    const tomorrow = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    const resolution = { kind: 'TIMING', reason: 'The payment will be booked next month', review_on: tomorrow };
    const resolve = (persona: string): Promise<Reply> => world.as(persona, 'POST', `/ebs/differences/${item.id}/resolution`, { ifMatch: item.version, body: resolution });

    // Step 1: the two makers of the figures (the one who loaded the file, the one who ran the comparison) do not settle it; nor is it handed to a maker.
    assertRefusedAsMaker(await resolve('ebs-admin'));
    assertRefusedAsMaker(await resolve('ebs-reconciler'));
    assertRefusedAsMaker(await world.as('ebs-reconciler', 'POST', `/ebs/differences/${item.id}/owner`, { ifMatch: item.version, body: { owner_id: world.idOf('ebs-admin') } }));
    expect((await world.as('ebs-reconciler', 'POST', `/ebs/differences/${item.id}/owner`, { ifMatch: item.version, body: { owner_id: world.idOf('ebs-admin') } })).json).toMatchObject({ code: 'SELF_APPROVAL_DENIED' });
    assertRefusedAsMaker(await unitCaller(UNIT_HOLDER, 'POST', `/ebs/differences/${item.id}/resolution`, { ifMatch: item.version, body: resolution }));
    assertRefusedAsMaker(await unitCaller(UNIT_HOLDER, 'POST', `/ebs/differences/${item.id}/owner`, { ifMatch: item.version, body: { owner_id: world.idOf('ebs-owner') } }));
    assertRefusedAsMaker(await unitCaller(UNIT_HOLDER, 'POST', '/ebs/reconciliations', { body: { period: '2026-10' } }));

    // Step 2: tenant B uses the id of the item of tenant A.
    const owner = { owner_id: memberId(1) };
    for (const [path, payload] of [[`/resolution`, resolution], [`/owner`, owner]] as const) {
      const foreign = await world.asTenantB(1, 'POST', `/ebs/differences/${item.id}${path}`, { ifMatch: 1, body: payload });
      const nothing = await world.asTenantB(1, 'POST', `/ebs/differences/${randomUUID()}${path}`, { ifMatch: 1, body: payload });
      expect([foreign.status, codeOf(foreign)]).toEqual([nothing.status, codeOf(nothing)]);
      assertStatus(foreign, 404);
    }

    // Step 3: a reader sends the three commands.
    assertRefusedForPermission(await resolve('ebs-reader'));
    assertRefusedForPermission(await world.as('ebs-reader', 'POST', `/ebs/differences/${item.id}/owner`, { ifMatch: item.version, body: { owner_id: world.idOf('ebs-owner') } }));
    assertRefusedForPermission(await world.as('ebs-reader', 'POST', '/ebs/reconciliations', { body: { period: '2026-10' } }));

    expect(await stateOf()).toEqual(before);
    expect(await world.audits(item.id, 'ebs.difference_resolved')).toHaveLength(0);
    expect(await world.audits(item.id, 'ebs.difference_reassigned')).toHaveLength(0);
    expect(await world.events(item.id, 'ebs.difference.resolved.v1')).toHaveLength(0);
  });

  it('UAT-EBS-EDG-02 the boundaries of a file: amounts of 0, a negative one, two decimals and fifteen digits are kept to the dong and the cent, a third decimal is refused, the periods 2026-12 and 2027-01 are read and 2026-13 is not, and a 29 February is read only in a leap year (DATE_INVALID otherwise)', async () => {
    const lines: Array<[string, string]> = [
      ['zero', 'UAT-EDG-ZERO,2026-12,2026-12-31,0,0'],
      ['negative', 'UAT-EDG-NEG,2026-12,2026-12-31,-1500,'],
      ['two decimals', 'UAT-EDG-DEC,2027-01,2027-01-05,1234.50,0.05'],
      ['fifteen digits', 'UAT-EDG-BIG,2026-12,2026-12-31,123456789012345,'],
      ['three decimals', 'UAT-EDG-D3,2026-12,2026-12-31,1.234,'],
      ['month thirteen', 'UAT-EDG-M13,2026-13,2026-12-31,1,'],
      ['month zero', 'UAT-EDG-M00,2026-00,2026-12-31,1,'],
      ['29 February of a common year', 'UAT-EDG-F29C,2027-02,2027-02-29,1,'],
      ['29 February of a leap year', 'UAT-EDG-F29L,2028-02,2028-02-29,1,'],
      ['month of a year of three digits', 'UAT-EDG-Y3,202-12,2026-12-31,1,'],
    ];
    const file = await door(csv(HEADER, ...lines.map(([, line]) => line)));
    const dry = await world.as('ebs-previewer', 'POST', '/ebs/imports/preview', { body: body(file) });
    assertStatus(dry, 200);
    const verdicts = new Map((dry.json.rows as Array<{ line: number; status: string; code: string | null; field: string | null }>).map((row) => [lines[row.line - 2]?.[0], [row.status, row.code, row.field]]));
    expect(Object.fromEntries(verdicts)).toEqual({
      zero: ['VALID', null, null],
      negative: ['VALID', null, null],
      'two decimals': ['VALID', null, null],
      'fifteen digits': ['VALID', null, null],
      'three decimals': ['ERROR', 'AMOUNT_INVALID', 'disbursed_vnd'],
      'month thirteen': ['ERROR', 'PERIOD_INVALID', 'period'],
      'month zero': ['ERROR', 'PERIOD_INVALID', 'period'],
      '29 February of a common year': ['ERROR', 'DATE_INVALID', 'extract_date'],
      '29 February of a leap year': ['VALID', null, null],
      'month of a year of three digits': ['ERROR', 'PERIOD_INVALID', 'period'],
    });
    expect(dry.json).toMatchObject({ counts: { total: 10, valid: 5, errors: 5 } });
    expect(await count("select 1 from machvon.ebs_record where project_code like 'UAT-EDG-%'")).toBe(0);

    // The apply keeps the valid rows as the dry run read them, and quarantines the others with the same code.
    const applied = await world.as('ebs-admin', 'POST', '/ebs/imports', { body: body(file) });
    assertStatus(applied, 200);
    expect(applied.json).toMatchObject({ counts: { total: 10, applied: 5, quarantined: 5 } });
    const kept = await world.rows<{ project_code: string; period: string; extract_date: string; disbursed_vnd: string | null; committed_vnd: string | null }>(
      "select project_code, period, extract_date::text, disbursed_vnd::text, committed_vnd::text from machvon.ebs_record where project_code like 'UAT-EDG-%' order by project_code",
    );
    expect(kept).toEqual([
      { project_code: 'UAT-EDG-BIG', period: '2026-12', extract_date: '2026-12-31', disbursed_vnd: '123456789012345.00', committed_vnd: null },
      { project_code: 'UAT-EDG-DEC', period: '2027-01', extract_date: '2027-01-05', disbursed_vnd: '1234.50', committed_vnd: '0.05' },
      { project_code: 'UAT-EDG-F29L', period: '2028-02', extract_date: '2028-02-29', disbursed_vnd: '1.00', committed_vnd: null },
      { project_code: 'UAT-EDG-NEG', period: '2026-12', extract_date: '2026-12-31', disbursed_vnd: '-1500.00', committed_vnd: null },
      { project_code: 'UAT-EDG-ZERO', period: '2026-12', extract_date: '2026-12-31', disbursed_vnd: '0.00', committed_vnd: '0.00' },
    ]);
    const quarantined = await world.rows<{ code: string }>('select error_code as code from machvon.file_import_quarantine where import_id = $1::uuid order by line', [applied.json.resource_id]);
    expect(quarantined.map((row) => row.code)).toEqual(['AMOUNT_INVALID', 'PERIOD_INVALID', 'PERIOD_INVALID', 'DATE_INVALID', 'PERIOD_INVALID']);
  });

  it('negative control: the checks of this suite go red on an answer that is wrong on purpose', () => {
    expectCheckFails(() => assertRefusedAsMaker({ status: 403, json: { code: 'PERMISSION_DENIED' } }));
    expectCheckFails(() => assertRefusedAsMaker({ status: 200, json: { code: 'SCOPE_DENIED' } }));
  });
});
