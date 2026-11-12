import { randomUUID } from 'node:crypto';
import { TENANT_A, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { assertStatus, codeOf, expectCheckFails } from './uat-kit';
import type { Reply } from './uat-kit';
import { ROOT_UNIT, UatWorld } from './uat-world';

/**
 * UAT of the reconciliation with Oracle EBS (docs/uat/ebs/uat.json, HSKT row CN.04, screens EBS-01 and EBS-02): the file the finance person hands over (dry run first, then apply once per hash), the quarantine
 * of the bad rows, the switch of the connection, the differences found by project code with an owner who made none of the figures, and the rows the audit trail and the outbox keep. The layout of the file
 * is a working assumption (PENDING-EXTERNAL, R18): the cases say so and do not claim the customer's format. Each case is named by its id in docs/uat/ebs/uat.json.
 */
jest.setTimeout(600_000);

const HEADER = 'project_code,period,extract_date,disbursed_vnd,committed_vnd';
const PERSONAS = {
  'ebs-admin': ['ebs.read', 'ebs.admin', 'ebs.import', 'ebs.import.preview', 'ebs.reconcile'],
  'ebs-reconciler': ['ebs.read', 'ebs.reconcile'],
  'ebs-previewer': ['ebs.read', 'ebs.import.preview'],
  'ebs-reader': ['ebs.read'],
  'ebs-owner': ['ebs.read', 'ebs.reconcile'],
};
const csv = (...lines: string[]): Uint8Array => new TextEncoder().encode(lines.join('\n'));

describe('UAT of the reconciliation with Oracle EBS (CN.04, EBS-01, EBS-02)', () => {
  const world = new UatWorld();
  let counter = 0;

  beforeAll(async () => {
    await world.start(PERSONAS, { 'ebs-admin': PERSONAS['ebs-admin'] }, async (w) => {
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
  }, 600_000);

  afterAll(() => world.stop(), 60_000);

  /** A project of ours with the money the Treasury paid, so that a statement can differ from it. */
  async function project(paid: string): Promise<string> {
    counter += 1;
    const projectId = randomUUID();
    const code = `UAT-EBS-P${String(counter).padStart(3, '0')}`;
    await world.seedAsAdmin([
      [
        `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, investor_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
         values ($1, $2, $3, 'Plant project', $4, $4, $5, 'INTERNAL', 1000000000, 'IMPLEMENTATION', 1, 'B')`,
        [TENANT_A, projectId, code, unitId(ROOT_UNIT), id(0x97, 90)],
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

  it('UAT-EBS-E2E-01 the finance person loads a statement as a dry run that writes nothing, applies it, and the connection shows the run; the audit trail and the outbox keep it', async () => {
    const code = await project('600');
    const file = await door(csv(HEADER, `${code},2026-09,2026-10-02,100,200`, 'UAT-EBS-UNKNOWN,2026-09,2026-10-02,5,5', `${code},2026-09,bad-day,1,1`));
    const dry = await world.as('ebs-previewer', 'POST', '/ebs/imports/preview', { body: body(file) });
    assertStatus(dry, 200);
    expect(dry.json).toMatchObject({ status: 'DRY_RUN', acceptance: 'PENDING_EXTERNAL', already_applied: false, counts: { total: 3, valid: 2, errors: 1 } });
    expect(await world.rows('select 1 from machvon.ebs_record where project_code = $1', [code])).toHaveLength(0);

    const done = await world.as('ebs-admin', 'POST', '/ebs/imports', { body: body(file) });
    assertStatus(done, 200);
    expect(done.json).toMatchObject({ status: 'APPLIED', acceptance: 'PENDING_EXTERNAL', counts: { total: 3, applied: 2, quarantined: 1 }, unknown_projects: 1 });
    const importId = done.json.resource_id as string;
    expect(await world.rows('select 1 from machvon.ebs_record where import_id = $1', [importId])).toHaveLength(2);
    expect((await world.audits(importId, 'ebs.import_applied'))[0]).toMatchObject({ actor_id: world.idOf('ebs-admin'), safe_diff: { records_written: 2, unknown_projects: 1, file_sha256: file.sha } });
    expect((await world.events(importId, 'ebs.import.applied.v1'))[0]?.payload).toMatchObject({ tenant_id: TENANT_A, import_id: importId, rows_applied: 2, rows_quarantined: 1 });
    const view = await world.as('ebs-reader', 'GET', '/ebs/connection');
    expect(view.json).toMatchObject({ registered: true, health: { status: 'FRESH' } });
  });

  it('UAT-EBS-IDM-01 the same file applied a second time is refused (409 IMPORT_FILE_ALREADY_APPLIED) and writes no second record', async () => {
    const code = await project('50');
    const file = await door(csv(HEADER, `${code},2026-08,2026-09-02,10,20`));
    const first = await world.as('ebs-admin', 'POST', '/ebs/imports', { body: body(file) });
    assertStatus(first, 200);
    const again = await world.as('ebs-admin', 'POST', '/ebs/imports', { body: body(file) });
    assertStatus(again, 409, 'IMPORT_FILE_ALREADY_APPLIED');
    expect(await world.rows('select 1 from machvon.ebs_record where project_code = $1', [code])).toHaveLength(1);
  });

  it('UAT-EBS-IDM-02 the same Idempotency-Key answers the first answer of an apply instead of a refusal', async () => {
    const code = await project('70');
    const file = await door(csv(HEADER, `${code},2026-07,2026-08-02,11,22`));
    const key = `uat-${randomUUID()}`;
    const first = await world.as('ebs-admin', 'POST', '/ebs/imports', { key, body: body(file) });
    const second = await world.as('ebs-admin', 'POST', '/ebs/imports', { key, body: body(file) });
    assertStatus(second, 200);
    expect(second.json.resource_id).toBe(first.json.resource_id);
    expect(await world.rows('select 1 from machvon.ebs_record where project_code = $1', [code])).toHaveLength(1);
  });

  it('UAT-EBS-IDM-03 five applies of the same file at the same moment write the records once: one applies, the others are refused as already applied', async () => {
    const code = await project('80');
    const file = await door(csv(HEADER, `${code},2026-06,2026-07-02,12,24`));
    const replies = await Promise.all(Array.from({ length: 5 }, () => world.as('ebs-admin', 'POST', '/ebs/imports', { body: body(file) })));
    expect(replies.filter((reply) => reply.status === 200)).toHaveLength(1);
    for (const reply of replies.filter((one) => one.status !== 200)) expect([409, codeOf(reply)]).toEqual([409, 'IMPORT_FILE_ALREADY_APPLIED']);
    expect(await world.rows('select 1 from machvon.ebs_record where project_code = $1', [code])).toHaveLength(1);
  });

  it('UAT-EBS-EDG-01 a file none of whose rows can be taken is refused as a whole with the line of each fault (422 IMPORT_HAS_ERRORS), and a file whose hash is not the one named is refused', async () => {
    const file = await door(csv(HEADER, 'P1,2026-99,2026-11-02,10,20', 'P2,2026-10,2026-11-02,abc,1'));
    const refused = await world.as('ebs-admin', 'POST', '/ebs/imports', { body: body(file) });
    assertStatus(refused, 422, 'IMPORT_HAS_ERRORS');
    expect((refused.json.errors as Array<{ line: number; code: string }>).map((error) => [error.line, error.code])).toEqual([[2, 'PERIOD_INVALID'], [3, 'AMOUNT_INVALID']]);
    const other = await door(csv(HEADER, 'P3,2026-10,2026-11-02,1,1'));
    const wrong = await world.as('ebs-admin', 'POST', '/ebs/imports', { body: { file_object_key: other.key, file_sha256: file.sha } });
    expect(wrong.status).toBeGreaterThanOrEqual(400);
    expect(wrong.status).toBeLessThan(500);
    expect(await world.rows('select 1 from machvon.ebs_record where project_code in ($1, $2, $3)', ['P1', 'P2', 'P3'])).toHaveLength(0);
  });

  it('UAT-EBS-SOD-01 a previewer may run the dry run but not apply, and the apply is for the holder of the right on the whole tenant (403)', async () => {
    const file = await door(csv(HEADER, 'UAT-EBS-SOD,2026-10,2026-11-02,1,1'));
    assertStatus(await world.as('ebs-previewer', 'POST', '/ebs/imports', { body: body(file) }), 403);
    assertStatus(await world.as('ebs-previewer', 'POST', '/ebs/imports/preview', { body: body(file) }), 200);
    assertStatus(await world.as('ebs-reader', 'POST', '/ebs/imports/preview', { body: body(file) }), 403);
    expect(await world.rows('select 1 from machvon.ebs_record where project_code = $1', ['UAT-EBS-SOD'])).toHaveLength(0);
  });

  it('UAT-EBS-DAT-01 the connection is switched off with a reason, audited, and while it is off the dry run still runs and the apply is refused', async () => {
    const view = await world.as('ebs-admin', 'GET', '/ebs/connection');
    const off = await world.as('ebs-admin', 'POST', '/ebs/connection/state', { ifMatch: view.json.version as number, body: { enabled: false, reason: 'The statement layout is being agreed with the customer' } });
    assertStatus(off, 200);
    expect((await world.audits(off.json.resource_id as string, 'ebs.connection_switched'))[0]?.reason).toBe('The statement layout is being agreed with the customer');
    const file = await door(csv(HEADER, 'UAT-EBS-OFF,2026-10,2026-11-02,1,1'));
    assertStatus(await world.as('ebs-previewer', 'POST', '/ebs/imports/preview', { body: body(file) }), 200);
    const blocked = await world.as('ebs-admin', 'POST', '/ebs/imports', { body: body(file) });
    expect(blocked.status).toBe(409);
    expect(await world.rows('select 1 from machvon.ebs_record where project_code = $1', ['UAT-EBS-OFF'])).toHaveLength(0);
    assertStatus(await world.as('ebs-admin', 'POST', '/ebs/connection/state', { ifMatch: off.json.resource_version as number, body: { enabled: true, reason: 'The layout is agreed and the connection is back' } }), 200);
  });

  it('UAT-EBS-E2E-02 a reconciliation opens one item for the difference, with an owner who made none of the figures, and says nothing of what agrees', async () => {
    const differs = await project('600');
    const agrees = await project('50');
    const file = await door(csv(HEADER, `${differs}-X,2026-10,2026-11-05,1,1`, `${differs},2026-10,2026-11-05,700,`, `${agrees},2026-10,2026-11-05,50,`));
    assertStatus(await world.as('ebs-admin', 'POST', '/ebs/imports', { body: body(file) }), 200);
    assertStatus(await world.as('ebs-reader', 'POST', '/ebs/reconciliations', { body: {} }), 403);
    const run = await world.as('ebs-reconciler', 'POST', '/ebs/reconciliations', { body: { period: '2026-10', owner_id: memberId(world.member('ebs-owner')) } });
    assertStatus(run, 200);
    expect(run.json).toMatchObject({ status: 'RECONCILED', no_owner: 0 });
    const mine = items(run).filter((item) => item.project_code === differs);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ measure: 'DISBURSED_VND', difference_kind: 'AMOUNT_MISMATCH', ours: '600', theirs: '700', delta: '100', state: 'OPEN', owner_id: world.idOf('ebs-owner') });
    expect(items(run).filter((item) => item.project_code === agrees)).toHaveLength(0);
    const stored = await world.rows<{ owner_id: string; maker_ids: string[] }>('select owner_id, maker_ids from machvon.ebs_reconciliation_item where id = $1', [mine[0]?.id]);
    expect(stored[0]?.maker_ids).not.toContain(stored[0]?.owner_id);
    expect(await world.events(mine[0]?.id as string, 'ebs.reconciliation.run.v1')).toHaveLength(1);
    expect((await world.audits(TENANT_A, 'ebs.reconciliation_run'))[0]).toMatchObject({ actor_id: world.idOf('ebs-reconciler'), safe_diff: { period: '2026-10', no_owner: 0 } });
    // The same figures again open nothing new (idempotent reconciliation).
    const again = await world.as('ebs-reconciler', 'POST', '/ebs/reconciliations', { body: { period: '2026-10', owner_id: memberId(world.member('ebs-owner')) } });
    expect(again.json).toMatchObject({ opened: 0, refreshed: 0 });
    expect(await world.rows("select 1 from machvon.ebs_reconciliation_item where project_code = $1 and state = 'OPEN'", [differs])).toHaveLength(1);
  });

  it('UAT-EBS-STA-01 only the owner explains and closes an item, a closed item is final (409 EBS_ITEM_STATE_INVALID), and a maker cannot close it (403)', async () => {
    const code = await project('900');
    const file = await door(csv(HEADER, `${code},2026-10,2026-11-06,950,`));
    assertStatus(await world.as('ebs-admin', 'POST', '/ebs/imports', { body: body(file) }), 200);
    const run = await world.as('ebs-reconciler', 'POST', '/ebs/reconciliations', { body: { period: '2026-10', owner_id: memberId(world.member('ebs-owner')) } });
    const item = items(run).find((candidate) => candidate.project_code === code) as { id: string; version: number };
    const tomorrow = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    const settle = (persona: string, version: number, extra: Record<string, unknown> = {}): Promise<Reply> =>
      world.as(persona, 'POST', `/ebs/differences/${item.id}/resolution`, { ifMatch: version, body: { kind: 'TIMING', reason: 'The payment will be booked next month', review_on: tomorrow, ...extra } });
    assertStatus(await settle('ebs-admin', item.version), 403);
    assertStatus(await settle('ebs-reconciler', item.version), 403);
    assertStatus(await settle('ebs-owner', item.version + 9), 409, 'VERSION_CONFLICT');
    assertStatus(await settle('ebs-owner', item.version, { reason: 'short' }), 422);
    const done = await settle('ebs-owner', item.version);
    assertStatus(done, 200);
    expect((await world.audits(item.id, 'ebs.difference_resolved'))[0]).toMatchObject({ actor_id: world.idOf('ebs-owner'), safe_diff: { resolution_kind: 'TIMING', state: 'RESOLVED' } });
    expect(await world.events(item.id, 'ebs.difference.resolved.v1')).toHaveLength(1);
    assertStatus(await settle('ebs-owner', done.json.resource_version as number), 409, 'EBS_ITEM_STATE_INVALID');
  });

  it('UAT-EBS-ISO-01 a member of another tenant is answered 404 for an item of this tenant, as for an id that does not exist, and sees no record of it', async () => {
    const [item] = items(await world.as('ebs-admin', 'GET', '/ebs/differences?state=RESOLVED')) as Array<{ id: string; version: number }>;
    const body_ = { kind: 'WAIVED', reason: 'Another tenant must not settle this', review_on: '2999-01-01' };
    const foreign = await world.asTenantB(1, 'POST', `/ebs/differences/${String(item?.id)}/resolution`, { ifMatch: 1, body: body_ });
    const nothing = await world.asTenantB(1, 'POST', `/ebs/differences/${randomUUID()}/resolution`, { ifMatch: 1, body: body_ });
    expect([foreign.status, codeOf(foreign)]).toEqual([nothing.status, codeOf(nothing)]);
    assertStatus(foreign, 404);
    expect(items(await world.asTenantB(1, 'GET', '/ebs/differences'))).toEqual([]);
  });

  it('negative control: the checks of this suite go red on an answer that is wrong on purpose', () => {
    expectCheckFails(() => assertStatus({ status: 200, json: {} }, 409, 'IMPORT_FILE_ALREADY_APPLIED'));
    expectCheckFails(() => assertStatus({ status: 409, json: { code: 'EBS_ITEM_STATE_INVALID' } }, 409, 'IMPORT_FILE_ALREADY_APPLIED'));
  });
});
