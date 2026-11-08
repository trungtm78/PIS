import { randomUUID } from 'node:crypto';
import { AnaBottleneckController } from '../../src/modules/home/ana-bottleneck.controller';
import { MEMBERS, TENANT_A, TENANT_B, UNITS, createAnaFixture, memberId, unitId } from './ana-support';

jest.setTimeout(240_000);

const FAMILY = 0xb9;
const fx = createAnaFixture(FAMILY, new Date('2027-10-20T03:00:00Z'));
const M = 1_000_000;
const HALT = ['home.read', 'home.halt.record', 'home.halt.plan', 'home.halt.approve', 'home.halt.close'];

type Item = { key: string; source: string; cause_code: string; amount_vnd: string | null; amount_null_reason: string | null; age_days: number; bucket: string; holder: { kind: string; code: string | null }; merged_keys: string[]; project: { code: string } };
type Total = { key: string; count: number; amount_vnd: string; no_amount: number };
type Analysis = { held_vnd: string; no_amount: number; merged: number; items_total: number; items: Item[]; by_cause: Total[]; by_bucket: Total[]; sources: Array<{ source: string; items: number; skipped: number }>; model: { unverified: boolean; rule_version: string } };
type Dossier = { id: string; status: string; reason_code: string; plan: { version: number; state: string; steps_total: number; steps_open: number }; steps: Array<{ id: string; status: string; ordinal: number }> };
const resourceId = (reply: { json: Record<string, unknown> }): string => reply.json.resource_id as string;

let projectCount = 0;
async function project(unit: number, status = 'IMPLEMENTATION'): Promise<string> {
  projectCount += 1;
  const snapshot = await fx.snapshot({ asOf: `2027-0${1 + (projectCount % 8)}-01` });
  const pid = await fx.project(snapshot, unit, '100000000');
  await fx.admin(async (client) => {
    await client.query('set session_replication_role = replica');
    await client.query('update machvon.project set status = $2 where id = $1::uuid', [pid, status]);
  });
  return pid;
}
const payment = (pid: string, status: string, net: number, when: Record<string, unknown>): Promise<string> =>
  fx.insert('payment_request', { project_id: pid, contract_id: randomUUID(), acceptance_id: randomUUID(), gross_vnd: net, advance_recovery_vnd: 0, retention_vnd: 0, tax_adjustment_vnd: 0, net_vnd: net, status, request_kind: 'INTERIM', ...(when.treasury_sent_at === undefined ? {} : { treasury_sent_by: memberId(MEMBERS.LEADER), treasury_submitted_on: String(when.treasury_sent_at).slice(0, 10) }), ...(status === 'SETTLED' ? { settled_transaction_id: randomUUID(), treasury_paid_on: '2027-01-05', settled_by: memberId(MEMBERS.LEADER), settled_at: '2027-01-05T03:00:00Z' } : {}), claims_acceptance: ['SUBMITTED', 'VERIFIED', 'SENT_TREASURY', 'SETTLED'].includes(status), version: 1, currency: 'VND', ...when }, TENANT_A, { replica: true });
async function compensation(pid: string, unit: number, amounts: number[], due: string): Promise<string> {
  const planId = await fx.insert('compensation_plan', { project_id: pid, status: 'PAYING', executor_kind: 'PROJECT_OWNER', approved_by: memberId(MEMBERS.LEADER), created_by: memberId(MEMBERS.BRANCH), approved_on: '2027-01-01', posting_place_text: 'Commune office', timer_rule_version_id: randomUUID(), posting_started_on: '2026-11-01', posting_ends_on: '2026-12-01', decision_document_version_id: randomUUID(), payment_due_on: '2027-12-31', total_compensation_vnd: amounts.reduce((sum, one) => sum + one, 0), total_support_vnd: 0, total_resettlement_vnd: 0 }, TENANT_A, { replica: true });
  for (const amount of amounts) await fx.insert('compensation_payment', { plan_id: planId, household_id: randomUUID(), owner_unit_id: unitId(unit), amount_vnd: amount, due_on: due, status: 'PENDING', payment_no: 1 }, TENANT_A, { replica: true });
  return planId;
}
const issue = (pid: string, unit: number, severity: string, opened: string, extra: Record<string, unknown> = {}): Promise<string> =>
  fx.insert('issue', { project_id: pid, category_version_id: randomUUID(), severity, assignee_id: memberId(MEMBERS.LEADER), due_at: '2027-12-01T00:00:00Z', status: 'OPEN', version: 1, code: `VM-2027-${String(Math.floor(Math.random() * 900_000) + 100_000)}`, title: 'Culvert blocked', description: 'The culvert under the access road is blocked.', sla_policy_id: randomUUID(), response_due_at: opened, reported_by: memberId(MEMBERS.LEADER), owner_unit_id: unitId(unit), opened_at: opened, ...extra }, TENANT_A, { replica: true });

describe('the bottlenecks and the halted projects over HTTP (G3-9)', () => {
  beforeAll(async () => {
    await fx.start({
      controllers: [AnaBottleneckController],
      roles: [
        { n: 1, name: 'HALT_ALL', permissions: HALT },
        { n: 2, name: 'HALT_BRANCH', permissions: ['home.read', 'home.halt.record', 'home.halt.plan'] },
        { n: 3, name: 'HALT_READ', permissions: ['home.read'] },
      ],
      grants: [
        { n: 1, member: MEMBERS.LEADER, role: 1, kind: 'TENANT' },
        { n: 2, member: MEMBERS.SECOND, role: 1, kind: 'TENANT' },
        { n: 3, member: MEMBERS.BRANCH, role: 2, kind: 'UNIT_SUBTREE', unit: UNITS.NORTH },
        { n: 4, member: MEMBERS.NOBODY, role: 3, kind: 'TENANT' },
      ],
    });
  }, 300_000);
  afterAll(() => fx.stop(), 60_000);
  beforeEach(async () => {
    fx.clock.now = new Date('2027-10-20T03:00:00Z');
    await fx.wipe(['project_restart_step', 'project_halt_dossier', 'compensation_payment', 'compensation_plan', 'payment_request', 'issue']);
  });

  it('adds up what is held: payments waiting to be checked and paid by the Treasury, compensation due and unpaid, and says how many items have no amount', async () => {
    const north = await project(UNITS.NORTH);
    await payment(north, 'SUBMITTED', 500 * M, { submitted_at: '2027-10-10T03:00:00Z' });
    await payment(north, 'SENT_TREASURY', 300 * M, { treasury_sent_at: '2027-07-20T03:00:00Z' });
    await payment(north, 'SETTLED', 900 * M, { submitted_at: '2027-01-01T03:00:00Z' });
    await compensation(north, UNITS.NORTH, [600 * M, 400 * M], '2027-10-18');
    await issue(north, UNITS.NORTH, 'HIGH', '2027-09-01T03:00:00Z');
    await issue(north, UNITS.NORTH, 'LOW', '2027-09-01T03:00:00Z');
    const reply = await fx.get('/home/bottlenecks');
    expect(reply.status).toBe(200);
    const analysis = reply.json as unknown as Analysis;
    expect(analysis.model).toMatchObject({ unverified: true, rule_version: 'builtin' });
    // Held: 500M + 300M of the two requests and 1,000M of the plan; the issue of high severity has no amount; the settled request and the issue of low severity are not bottlenecks.
    expect(analysis).toMatchObject({ held_vnd: String(1800 * M), no_amount: 1, items_total: 4, merged: 0 });
    expect(analysis.items.map((item) => [item.source, item.cause_code, item.amount_vnd, item.age_days, item.bucket])).toEqual([
      ['PAYMENT', 'PAYMENT_PENDING_TREASURY', String(300 * M), 92, 'GT_90'],
      ['PAYMENT', 'PAYMENT_PENDING_DOSSIER', String(500 * M), 10, 'LE_30'],
      ['LAND', 'LAND_CLEARANCE', String(1000 * M), 2, 'LE_7'],
      ['ISSUE', 'ISSUE_UNRESOLVED', null, 49, 'LE_90'],
    ]);
    expect(analysis.items[0]?.holder).toMatchObject({ kind: 'EXTERNAL', code: 'TREASURY' });
    expect(analysis.items[3]).toMatchObject({ amount_null_reason: 'NO_AMOUNT', holder: { kind: 'PERSON' } });
    expect(analysis.by_cause.find((total) => total.key === 'ISSUE_UNRESOLVED')).toMatchObject({ count: 1, amount_vnd: '0', no_amount: 1 });
    expect(analysis.by_bucket.map((total) => total.key)).toEqual(['LE_7', 'LE_30', 'LE_90', 'GT_90']);
  });

  it('counts one amount once when an issue was opened for the payment request', async () => {
    const north = await project(UNITS.NORTH);
    const request = await payment(north, 'SUBMITTED', 500 * M, { submitted_at: '2027-10-10T03:00:00Z' });
    await issue(north, UNITS.NORTH, 'CRITICAL', '2027-10-05T03:00:00Z', { source_module: 'PAY', source_ref_id: request });
    const analysis = (await fx.get('/home/bottlenecks')).json as unknown as Analysis;
    expect(analysis).toMatchObject({ held_vnd: String(500 * M), items_total: 1, merged: 1, no_amount: 0 });
    expect(analysis.items[0]?.merged_keys).toHaveLength(1);
  });

  it('filters the list by cause and by bucket, keeps the totals whole, and refuses a malformed filter', async () => {
    const north = await project(UNITS.NORTH);
    await payment(north, 'SUBMITTED', 500 * M, { submitted_at: '2027-10-10T03:00:00Z' });
    await issue(north, UNITS.NORTH, 'HIGH', '2027-09-01T03:00:00Z');
    const byCause = (await fx.get('/home/bottlenecks?cause=ISSUE_UNRESOLVED')).json as unknown as Analysis;
    expect(byCause.items.map((item) => item.source)).toEqual(['ISSUE']);
    expect(byCause.items_total).toBe(2);
    const byBucket = (await fx.get('/home/bottlenecks?bucket=LE_30')).json as unknown as Analysis;
    expect(byBucket.items.map((item) => item.source)).toEqual(['PAYMENT']);
    expect((await fx.get('/home/bottlenecks?cause=lower')).status).toBe(422);
    expect((await fx.get('/home/bottlenecks?bucket=SOON')).status).toBe(422);
    expect((await fx.get('/home/bottlenecks?unit_id=nope')).status).toBe(422);
  });

  it('shows a reader only the projects of their scope and none of another tenant', async () => {
    const north = await project(UNITS.NORTH);
    const south = await project(UNITS.SOUTH);
    await payment(north, 'SUBMITTED', 500 * M, { submitted_at: '2027-10-10T03:00:00Z' });
    await payment(south, 'SUBMITTED', 700 * M, { submitted_at: '2027-10-10T03:00:00Z' });
    expect(((await fx.get('/home/bottlenecks')).json as unknown as Analysis).held_vnd).toBe(String(1200 * M));
    expect(((await fx.get('/home/bottlenecks', MEMBERS.BRANCH)).json as unknown as Analysis).held_vnd).toBe(String(500 * M));
    expect(((await fx.get('/home/bottlenecks', 1, TENANT_B)).json as unknown as Analysis).items_total).toBe(0);
  });

  it('runs the halt of a project: dossier, plan by one person, approval by another, steps, restart', async () => {
    const north = await project(UNITS.NORTH, 'SUSPENDED');
    const listed = (await fx.get('/home/halted-projects')).json as { undocumented: Array<{ project: { id: string } }> };
    expect(listed.undocumented.map((one) => one.project.id)).toEqual([north]);
    const recorded = await fx.post('/home/halted-projects', { project_id: north, reason_code: 'LAND_CLEARANCE', reason_text: 'Twelve households have not accepted the compensation.', halted_on: '2027-09-01', order_ref: 'Decision 15/QD' }, MEMBERS.LEADER);
    expect(recorded.status).toBe(200);
    const dossier = resourceId(recorded);
    expect(((await fx.get('/home/halted-projects')).json as { undocumented: unknown[] }).undocumented).toEqual([]);
    expect((await fx.post('/home/halted-projects', { project_id: north, reason_code: 'OTHER', reason_text: 'A second dossier for the same project.', halted_on: '2027-09-02' })).json.code).toBe('PROJECT_HALT_OPEN_EXISTS');
    // A restart needs a plan the second person approved.
    const noPlan = await fx.post(`/home/halted-projects/${dossier}/closure`, { outcome: 'RESTARTED', note: 'Work is back on site.', restarted_on: '2027-10-18' });
    expect(noPlan.status).toBe(409);
    const saved = await fx.post(`/home/halted-projects/${dossier}/plan`, { steps: [{ title: 'Pay the twelve households', owner_unit_id: unitId(UNITS.NORTH), due_on: '2027-11-15' }, { title: 'Hand over the site', owner_unit_id: unitId(UNITS.NORTH), due_on: '2027-11-30' }], expected_restart_on: '2027-12-01' }, MEMBERS.LEADER);
    expect(saved.json).toMatchObject({ status: 'PLAN_SAVED' });
    let detail = (await fx.get(`/home/halted-projects/${dossier}`)).json as unknown as Dossier;
    expect(detail).toMatchObject({ status: 'HALTED', plan: { version: 1, state: 'AWAITING_APPROVAL', steps_total: 2 } });
    const own = await fx.post(`/home/halted-projects/${dossier}/plan-decision`, { decision: 'APPROVE', note: 'The plan is realistic.' }, MEMBERS.LEADER);
    expect(own.status).toBe(403);
    expect(own.json.code).toBe('SELF_APPROVAL_DENIED');
    expect((await fx.post(`/home/halted-projects/${dossier}/plan-decision`, { decision: 'APPROVE', note: 'The plan is realistic.' }, MEMBERS.SECOND)).json).toMatchObject({ status: 'RESTART_PLANNED' });
    detail = (await fx.get(`/home/halted-projects/${dossier}`)).json as unknown as Dossier;
    expect(detail).toMatchObject({ status: 'RESTART_PLANNED', plan: { state: 'ON_TRACK', steps_open: 2 } });
    const early = await fx.post(`/home/halted-projects/${dossier}/closure`, { outcome: 'RESTARTED', note: 'Work is back on site.', restarted_on: '2027-10-18' });
    expect(early.status).toBe(409);
    expect(early.json.code).toBe('PROJECT_HALT_STEPS_OPEN');
    for (const step of detail.steps) expect((await fx.post(`/home/halted-projects/${dossier}/steps/${step.id}/closure`, { status: 'DONE', note: 'Done and checked on site.' })).status).toBe(200);
    expect((await fx.post(`/home/halted-projects/${dossier}/steps/${detail.steps[0]?.id}/closure`, { status: 'DROPPED', note: 'Trying to close it again.' })).status).toBe(409);
    expect((await fx.post(`/home/halted-projects/${dossier}/closure`, { outcome: 'RESTARTED', note: 'Work is back on site.', restarted_on: '2027-10-18' })).json).toMatchObject({ status: 'RESTARTED' });
    expect((await fx.post(`/home/halted-projects/${dossier}/closure`, { outcome: 'CANCELLED', note: 'Cancelling a restarted dossier.' })).status).toBe(409);
    for (const action of ['home.project_halted', 'home.restart_plan_saved', 'home.restart_plan_decided', 'home.restart_step_closed', 'home.project_restarted']) {
      expect(Number((await fx.rows<{ n: string }>(`select count(*)::text as n from machvon.audit_event where action = $1`, [action]))[0]?.n)).toBeGreaterThanOrEqual(1);
    }
    // A closed dossier lets the project have a new one.
    expect((await fx.post('/home/halted-projects', { project_id: north, reason_code: 'OTHER', reason_text: 'A new halt of the same project.', halted_on: '2027-10-19' })).status).toBe(200);
  });

  it('returns a plan for rework, and saves the next version over it', async () => {
    const north = await project(UNITS.NORTH, 'SUSPENDED');
    const dossier = resourceId(await fx.post('/home/halted-projects', { project_id: north, reason_code: 'OTHER', reason_text: 'The designer lost the files of the bridge.', halted_on: '2027-09-01' }));
    const step = { title: 'Rebuild the files of the bridge', owner_unit_id: unitId(UNITS.NORTH), due_on: '2027-11-15' };
    await fx.post(`/home/halted-projects/${dossier}/plan`, { steps: [step] }, MEMBERS.LEADER);
    expect((await fx.post(`/home/halted-projects/${dossier}/plan-decision`, { decision: 'RETURN', note: 'The plan needs a day for the survey.' }, MEMBERS.SECOND)).json).toMatchObject({ status: 'RETURNED' });
    const again = await fx.post(`/home/halted-projects/${dossier}/plan-decision`, { decision: 'APPROVE', note: 'Approving the returned plan.' }, MEMBERS.SECOND);
    expect(again.status).toBe(409);
    expect((await fx.post(`/home/halted-projects/${dossier}/plan`, { steps: [step, { ...step, title: 'Survey of the bridge site' }] }, MEMBERS.SECOND)).json).toMatchObject({ status: 'PLAN_SAVED' });
    const detail = (await fx.get(`/home/halted-projects/${dossier}`)).json as unknown as Dossier;
    expect(detail.plan).toMatchObject({ version: 2, steps_total: 2, state: 'AWAITING_APPROVAL' });
    expect(detail.steps).toHaveLength(3);
  });

  it('refuses a halt for a project that is not suspended or not in scope, a plan that is not whole, and a reader without the right', async () => {
    const running = await project(UNITS.NORTH);
    const south = await project(UNITS.SOUTH, 'SUSPENDED');
    const base = { reason_code: 'OTHER', reason_text: 'The works stopped for the season.', halted_on: '2027-09-01' };
    const stage = await fx.post('/home/halted-projects', { ...base, project_id: running });
    expect(stage.status).toBe(422);
    expect(stage.json.code).toBe('PROJECT_STAGE_INVALID');
    expect((await fx.post('/home/halted-projects', { ...base, project_id: south }, MEMBERS.BRANCH)).status).toBe(404);
    expect((await fx.post('/home/halted-projects', { ...base, project_id: south, reason_code: 'WHATEVER' })).status).toBe(422);
    expect((await fx.post('/home/halted-projects', { ...base, project_id: south, halted_on: '2027-12-01' })).status).toBe(422);
    expect((await fx.post('/home/halted-projects', { ...base, project_id: south }, MEMBERS.NOBODY)).status).toBe(403);
    const dossier = resourceId(await fx.post('/home/halted-projects', { ...base, project_id: south }));
    for (const bad of [{ steps: [] }, { steps: [{ title: 'No owner at all', due_on: '2027-11-15' }] }, { steps: [{ title: 'A day in the past', owner_unit_id: unitId(UNITS.SOUTH), due_on: '2027-10-01' }] }]) {
      expect((await fx.post(`/home/halted-projects/${dossier}/plan`, bad)).status).toBe(422);
    }
    expect((await fx.get(`/home/halted-projects/${dossier}`, MEMBERS.BRANCH)).status).toBe(404);
    expect((await fx.get(`/home/halted-projects/${dossier}`, 1, TENANT_B)).status).toBe(404);
  });

  it('cannot edit or remove a dossier or a step, and cannot move a dossier to a state the guard does not allow', async () => {
    const north = await project(UNITS.NORTH, 'SUSPENDED');
    const dossier = resourceId(await fx.post('/home/halted-projects', { project_id: north, reason_code: 'OTHER', reason_text: 'The works stopped for the season.', halted_on: '2027-09-01' }));
    await fx.post(`/home/halted-projects/${dossier}/plan`, { steps: [{ title: 'Restart the works', owner_unit_id: unitId(UNITS.NORTH), due_on: '2027-11-15' }] }, MEMBERS.LEADER);
    const asApp = (sql: string): Promise<unknown> => fx.harness.tenants.withTenant({ tenantId: TENANT_A, membershipId: memberId(MEMBERS.LEADER), scopeVersion: 1 }, (tx) => tx.query(sql, [dossier]));
    await expect(asApp('delete from machvon.project_halt_dossier where id = $1::uuid')).rejects.toBeDefined();
    await expect(asApp('delete from machvon.project_restart_step where dossier_id = $1::uuid')).rejects.toBeDefined();
    await expect(asApp("update machvon.project_halt_dossier set reason_text = 'A different reason for the halt' where id = $1::uuid")).rejects.toBeDefined();
    await expect(asApp("update machvon.project_restart_step set title = 'A different step title' where dossier_id = $1::uuid")).rejects.toBeDefined();
    await expect(asApp("update machvon.project_halt_dossier set status = 'RESTARTED', closed_by = created_by, closed_at = now(), close_note = 'Forced restart', restarted_on = current_date where id = $1::uuid")).rejects.toBeDefined();
  });
});
