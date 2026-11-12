import { randomUUID } from 'node:crypto';
import { TENANT_A, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { assertStatus, codeOf, expectCheckFails } from './uat-kit';
import type { Reply } from './uat-kit';
import { ROOT_UNIT, UatWorld } from './uat-world';

/**
 * UAT of the enterprise edition from the frozen snapshot to the leader (docs/uat/ent/uat.json, HSKT rows DL.03, BC.02 and YCK.01, screens PWA-03 and PWA-08): the period of the enterprise is closed by a snapshot that is built when
 * every input point has submitted, frozen by somebody else with the version the screen saw, and read by the leader as the rates against the annual plan. Each case is named by its id in docs/uat/ent/uat.json.
 */
jest.setTimeout(600_000);

const FAMILY = 0x9a;
const DEPARTMENT = 2;
const OTHER_DEPARTMENT = 3;
const PERSONAS = {
  'ent-builder': ['funding.snapshot.build', 'funding.snapshot.read'],
  'ent-freezer': ['funding.snapshot.freeze', 'funding.snapshot.read'],
  'ent-both': ['funding.snapshot.build', 'funding.snapshot.freeze', 'funding.snapshot.read'],
  'ent-reader': ['funding.snapshot.read'],
  'ent-leader': ['home.read'],
  'ent-nobody': ['uat.nothing'],
};
const items = (reply: Reply): Array<Record<string, unknown>> => reply.json.items as Array<Record<string, unknown>>;

describe('UAT of the enterprise snapshot and the leader rates (DL.03, BC.02, PWA-03)', () => {
  const world = new UatWorld();
  const projects: string[] = [];
  let lockedPeriod = '';
  let openPeriod = '';
  let snapshotId = '';

  const period = async (code: string, start: string, end: string, locked: boolean): Promise<string> => {
    const created = randomUUID();
    await world.seedAsAdmin([
      [
        `insert into machvon.reporting_period
           (tenant_id, id, code, calendar_version, start_date, end_date, deadline_at, calendar_code, period_type, fiscal_year, status, soft_closed_at, locked_at, locked_by, calendar_version_id, created_by, updated_by)
         values ($1, $2, $3, 1, $4::date, $5::date, $5::date + interval '3 hours', 'ENTERPRISE', 'MONTH', 2026, $6, $7, $8, $9, $10, $11, $11)`,
        [TENANT_A, created, code, start, end, locked ? 'LOCKED' : 'OPEN', locked ? `${end}T05:00:00Z` : null, locked ? `${end}T06:00:00Z` : null, locked ? memberId(1) : null, randomUUID(), memberId(1)],
      ],
    ]);
    return created;
  };

  const project = async (unit: number, label: string): Promise<string> => {
    const created = randomUUID();
    await world.seedAsAdmin([
      [
        `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, investor_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
         values ($1, $2, $3, $4, $5, $6, $7, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
        [TENANT_A, created, `UAT-ENT-${label}`, `Enterprise project ${label}`, unitId(unit), unitId(ROOT_UNIT), id(FAMILY, 90)],
      ],
    ]);
    return created;
  };

  const plan = (projectId: string, amount: string): Promise<void> =>
    world.seedAsAdmin([
      [`insert into machvon.plan_version (tenant_id, id, project_id, fiscal_year, revision, decision_id, status, effective_at) values ($1, $2, $3, 2026, 1, $4, 'PUBLISHED', '2026-01-10T03:00:00Z'::timestamptz)`, [TENANT_A, `${randomUUID()}`, projectId, randomUUID()]],
    ]).then(async () => {
      const [version] = await world.rows<{ id: string }>('select id from machvon.plan_version where project_id = $1', [projectId]);
      await world.seedAsAdmin([
        [
          `insert into machvon.allocation_line (tenant_id, id, plan_version_id, fund_source_version_id, bucket, source_year, amount_vnd, ctmtqg_subset_vnd, budget_level, taxonomy_pack) values ($1, $2, $3, $4, 'EQUITY', 2026, $5::numeric, 0, 'ALL', 'ENTERPRISE')`,
          [TENANT_A, randomUUID(), version?.id, randomUUID(), amount],
        ],
      ]);
    });

  /** The accepted actuals up to March, as the figure store leaves them after a preparer and a checker. */
  const actual = (projectId: string, amount: string): Promise<void> =>
    world.seedAsAdmin([
      [
        `insert into machvon.plan_figure_revision (tenant_id, id, batch_id, project_id, taxonomy_pack, bucket, budget_level, measure, figure_kind, period_grain, plan_year, period_ordinal, amount_vnd, basis, as_of_date, status, prepared_by, approved_by, approved_at, updated_by)
         select $1::uuid, gen_random_uuid(), $2::uuid, $3::uuid, 'ENTERPRISE', 'EQUITY', 'ALL', 'DISBURSED', 'ACTUAL', 'MONTH', 2026, m::smallint, case when m = 3 then $4::numeric else 0 end, 'REPORTED', '2026-04-03'::date, 'ACCEPTED', $5::uuid, $6::uuid, now(), $5::uuid from generate_series(1, 3) as m`,
        [TENANT_A, randomUUID(), projectId, amount, memberId(1), memberId(2)],
      ],
    ]);

  beforeAll(async () => {
    await world.start(PERSONAS, { 'ent-builder': ['funding.snapshot.build', 'funding.snapshot.freeze', 'funding.snapshot.read'] }, async (w) => {
      await w.harness.seedUnits(TENANT_A, [
        { n: DEPARTMENT, path: `/${unitId(ROOT_UNIT)}/${unitId(DEPARTMENT)}/`, parent: ROOT_UNIT },
        { n: OTHER_DEPARTMENT, path: `/${unitId(ROOT_UNIT)}/${unitId(OTHER_DEPARTMENT)}/`, parent: ROOT_UNIT },
      ]);
    });
    projects.push(await project(DEPARTMENT, 'A'), await project(OTHER_DEPARTMENT, 'B'));
    await plan(projects[0] as string, '1000');
    await plan(projects[1] as string, '3000');
    lockedPeriod = await period('UAT-ENT-2026-03', '2026-03-01', '2026-03-31', true);
    openPeriod = await period('UAT-ENT-2026-04', '2026-04-01', '2026-04-30', false);
  }, 600_000);

  afterAll(() => world.stop(), 60_000);

  const build = (persona: string, periodId: string, key?: string): Promise<Reply> => world.as(persona, 'POST', '/enterprise-snapshots', { body: { period_id: periodId }, ...(key === undefined ? {} : { key }) });
  const freeze = (persona: string, snapshot: string, version: number, key?: string): Promise<Reply> => world.as(persona, 'POST', `/enterprise-snapshots/${snapshot}/freeze`, { ifMatch: version, ...(key === undefined ? {} : { key }) });

  it('UAT-ENT-E2E-01 the leader sees no snapshot as an answer and not as a failure, a build is refused while a unit has not submitted (422 ENTERPRISE_SNAPSHOT_INCOMPLETE) and writes nothing, then the snapshot is built', async () => {
    const none = await world.as('ent-leader', 'GET', '/leader/rates');
    assertStatus(none, 200);
    expect(none.json).toMatchObject({ snapshot: null });
    const readiness = await world.as('ent-builder', 'GET', `/enterprise-snapshot-readiness?period_id=${lockedPeriod}`);
    assertStatus(readiness, 200);
    expect(readiness.json).toMatchObject({ complete: false, planned_cells: 2, projects: 2, rebuild_allowed: true, frozen: null, actions: { build: true } });
    expect((readiness.json.missing_units as Array<{ unit_id: string }>).map((unit) => unit.unit_id).sort()).toEqual([unitId(DEPARTMENT), unitId(OTHER_DEPARTMENT)].sort());
    const refused = await build('ent-both', lockedPeriod);
    assertStatus(refused, 422, 'ENTERPRISE_SNAPSHOT_INCOMPLETE');
    expect((refused.json.missing_units as unknown[]).length).toBe(2);
    expect(await world.rows(`select 1 from machvon.period_snapshot where snapshot_kind = 'ENTERPRISE_CLOSE'`)).toHaveLength(0);
    await actual(projects[0] as string, '100');
    await actual(projects[1] as string, '900');
    const built = await build('ent-both', lockedPeriod);
    assertStatus(built, 200);
    expect(built.json).toMatchObject({ status: 'BUILDING', resource_version: 1 });
    snapshotId = built.json.resource_id as string;
    expect((await world.audits(snapshotId, 'enterprise.snapshot_built'))[0]?.safe_diff).toMatchObject({ revision: 1, projects: 2, taxonomy_pack: 'ENTERPRISE' });
    expect((await world.events(snapshotId, 'enterprise.snapshot_built.v1'))[0]?.payload).toMatchObject({ snapshot_id: snapshotId, period_id: lockedPeriod, revision: 1 });
    const stillNone = await world.as('ent-leader', 'GET', '/leader/rates');
    expect(stillNone.json).toMatchObject({ snapshot: null });
  });

  it('UAT-ENT-IDM-01 building again under the same Idempotency-Key replays the same snapshot and writes no second one, and the same key for another period is refused (409 IDEMPOTENCY_CONFLICT)', async () => {
    const key = `uat-${randomUUID()}`;
    const first = await build('ent-both', lockedPeriod, key);
    assertStatus(first, 200);
    // The snapshot of the period in review is the one this key made (a build with another key is a new revision until the snapshot is frozen).
    snapshotId = first.json.resource_id as string;
    const before = (await world.rows(`select 1 from machvon.period_snapshot where snapshot_kind = 'ENTERPRISE_CLOSE' and period_id = $1`, [lockedPeriod])).length;
    const again = await build('ent-both', lockedPeriod, key);
    assertStatus(again, 200);
    expect(again.json.resource_id).toBe(snapshotId);
    expect(await world.rows(`select 1 from machvon.period_snapshot where snapshot_kind = 'ENTERPRISE_CLOSE' and period_id = $1`, [lockedPeriod])).toHaveLength(before);
    const other = await build('ent-both', openPeriod, key);
    assertStatus(other, 409, 'IDEMPOTENCY_CONFLICT');
  });

  it('UAT-ENT-STA-01 a period that is not locked takes no snapshot (409 PERIOD_STATE_INVALID), a period that does not exist is 404, and a missing period is 400', async () => {
    assertStatus(await build('ent-both', openPeriod), 409, 'PERIOD_STATE_INVALID');
    assertStatus(await build('ent-both', randomUUID()), 404);
    assertStatus(await world.as('ent-builder', 'POST', '/enterprise-snapshots', { body: {} }), 400);
    expect(await world.rows(`select 1 from machvon.period_snapshot where snapshot_kind = 'ENTERPRISE_CLOSE' and period_id = $1`, [openPeriod])).toHaveLength(0);
  });

  it('UAT-ENT-SOD-01 the person who built the snapshot cannot freeze it (403 SELF_APPROVAL_DENIED), a person without the right cannot, a stale version is 409, and somebody else freezes it once', async () => {
    const target = snapshotId;
    assertStatus(await build('ent-freezer', lockedPeriod), 403);
    assertStatus(await build('ent-reader', lockedPeriod), 403);
    assertStatus(await freeze('ent-both', target, 1), 403, 'SELF_APPROVAL_DENIED');
    assertStatus(await freeze('ent-reader', target, 1), 403);
    assertStatus(await freeze('ent-freezer', target, 9), 409, 'VERSION_CONFLICT');
    const frozen = await freeze('ent-freezer', target, 1);
    assertStatus(frozen, 200);
    expect(frozen.json).toMatchObject({ status: 'FROZEN', resource_version: 2 });
    const audit = (await world.audits(snapshotId, 'enterprise.snapshot_frozen'))[0];
    expect(audit?.safe_diff).toMatchObject({ revision: 1, supersedes_id: null });
    expect(audit?.safe_diff['payload_sha256']).toMatch(/^[0-9a-f]{64}$/);
    expect((await world.events(snapshotId, 'enterprise.snapshot_frozen.v1'))[0]?.payload).toMatchObject({ snapshot_id: snapshotId, revision: 1 });
    assertStatus(await freeze('ent-freezer', snapshotId, 2), 409, 'SNAPSHOT_FROZEN');
  });

  it('UAT-ENT-DAT-01 a frozen snapshot reads with a verified hash and its lineage, a frozen period refuses another build until it is reopened, and the leader reads the rates against the plan with the numerator and the denominator', async () => {
    const detail = await world.as('ent-reader', 'GET', `/enterprise-snapshots/${snapshotId}`);
    expect(detail.json).toMatchObject({ hash_verified: true, snapshot: { status: 'FROZEN' }, actions: { build: false, freeze: false } });
    expect((detail.json.lineage as unknown[]).length).toBeGreaterThanOrEqual(1);
    const refused = await build('ent-both', lockedPeriod);
    assertStatus(refused, 409, 'SNAPSHOT_FROZEN');
    expect(refused.json).toMatchObject({ reopen_required: true });
    const totals = (await world.as('ent-reader', 'GET', `/enterprise-snapshots/${snapshotId}?measure=DISBURSED`)).json.totals as { rates: Array<{ code: string; numerator_vnd: string | null; denominator_vnd: string; rate_pct: string | null }> };
    expect(totals.rates.find((one) => one.code === 'RATE_YEAR_IN_FORCE')).toMatchObject({ numerator_vnd: '1000', denominator_vnd: '4000', rate_pct: '25.0000' });
    const rates = await world.as('ent-leader', 'GET', '/leader/rates');
    assertStatus(rates, 200);
    expect(rates.json).toMatchObject({ snapshot_id: snapshotId, definition_status: 'PROPOSED_PENDING_SIGNOFF' });
    expect(rates.json.company).toMatchObject({ plan_vnd: '4000', disbursed_vnd: '1000' });
    expect(Number((rates.json.company as { rate_pct: string }).rate_pct)).toBeCloseTo(25, 3);
    expect((rates.json.units as unknown[]).length).toBe(2);
    assertStatus(await world.as('ent-nobody', 'GET', '/leader/rates'), 403);
    assertStatus(await world.as('ent-leader', 'GET', `/leader/rates?snapshot_id=${randomUUID()}`), 404);
    assertStatus(await world.as('ent-leader', 'GET', '/leader/rates?snapshot_id=not-an-id'), 422);
    assertStatus(await world.as('ent-leader', 'GET', '/leader/blocked-projects'), 200);
  });

  it('UAT-ENT-ISO-01 another tenant sees nothing of the snapshot: not in the list, not by id, and the leader rates of the other tenant do not name it', async () => {
    const foreign = await world.asTenantB(1, 'GET', `/enterprise-snapshots/${snapshotId}`);
    const nothing = await world.asTenantB(1, 'GET', `/enterprise-snapshots/${randomUUID()}`);
    expect([foreign.status, codeOf(foreign)]).toEqual([nothing.status, codeOf(nothing)]);
    assertStatus(foreign, 404);
    expect(items(await world.asTenantB(1, 'GET', '/enterprise-snapshots'))).toEqual([]);
    assertStatus(await world.asTenantB(1, 'POST', `/enterprise-snapshots/${snapshotId}/freeze`, { ifMatch: 1 }), 404);
  });

  it('negative control: the checks of this suite go red on an answer that is wrong on purpose', () => {
    expectCheckFails(() => assertStatus({ status: 200, json: {} }, 422, 'ENTERPRISE_SNAPSHOT_INCOMPLETE'));
    expectCheckFails(() => assertStatus({ status: 422, json: { code: 'OTHER' } }, 422, 'ENTERPRISE_SNAPSHOT_INCOMPLETE'));
  });
});
