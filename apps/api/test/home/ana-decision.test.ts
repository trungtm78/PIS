import { AnaDecisionController } from '../../src/modules/home/ana-decision.controller';
import { MEMBERS, TENANT_A, TENANT_B, UNITS, createAnaFixture, memberId, unitId } from './ana-support';

jest.setTimeout(240_000);

const FAMILY = 0xb6;
const fx = createAnaFixture(FAMILY, new Date('2027-10-20T03:00:00Z'));
const TILE = 'DISBURSEMENT_RATE_PM';
const WRITE = ['home.read', 'home.decision.record'];

type Item = { id: string; subject: { kind: string; unit_id: string | null }; kind: string; headline: { display_value: string | null } | null; follow_up: { state: string; due_on: string | null }; latest_outcome: string | null; decided_by: { id: string } };
type Detail = Item & {
  figures: { figure: { value: string }; tiles: unknown[]; snapshot: { id: string } | null };
  figures_sha256: string;
  digest_ok: boolean;
  current: { value: string | null; as_of_date: string } | null;
  comparison: { then: string; now: string; delta: string; direction: string; null_reason: string | null } | null;
  outcomes: Array<{ outcome: string; note: string }>;
  unverified: boolean;
};

/** A frozen snapshot with two projects (one in each unit) each paying `paid` of 1000 plan (billions). */
async function week(asOf: string, paid: string): Promise<void> {
  const snapshot = await fx.snapshot({ asOf });
  await fx.project(snapshot, UNITS.NORTH, paid);
  await fx.project(snapshot, UNITS.SOUTH, paid);
}
const body = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ subject: { kind: 'KPI_TILE', metric_code: TILE }, kind: 'DIRECT_ACTION', reason: 'Ask the units that lag to catch up this month.', follow_up: { due_on: '2027-10-30' }, ...over });
const id = (reply: { json: Record<string, unknown> }): string => reply.json.resource_id as string;

describe('the decision log over HTTP (G3-6)', () => {
  beforeAll(async () => {
    await fx.start({
      controllers: [AnaDecisionController],
      roles: [
        { n: 1, name: 'DECISION_ALL', permissions: WRITE },
        { n: 2, name: 'DECISION_BRANCH', permissions: WRITE },
        { n: 3, name: 'DECISION_READ', permissions: ['home.read'] },
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
    await fx.wipe(['analytics_decision_outcome', 'analytics_decision']);
  });

  it('freezes the figure the leader sees, keeps it with its digest and reads it back beside today with the difference', async () => {
    await week('2027-10-12', '600000000000');
    const recorded = await fx.post('/home/decisions', body());
    expect(recorded.status).toBe(200);
    expect(recorded.json).toMatchObject({ status: 'RECORDED' });
    // A newer week moves the figure; the record still says what was true when it was decided.
    fx.clock.now = new Date('2027-10-27T03:00:00Z');
    await week('2027-10-19', '700000000000');
    const detail = (await fx.get(`/home/decisions/${id(recorded)}`)).json as unknown as Detail;
    expect(detail.figures.figure.value).toBe('60.0000');
    expect(detail.digest_ok).toBe(true);
    expect(detail.figures_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(detail.figures.tiles.length).toBeGreaterThanOrEqual(5);
    expect(detail.current).toMatchObject({ value: '70.0000', as_of_date: '2027-10-19' });
    expect(detail.comparison).toEqual({ metric_code: TILE, then: '60.0000', now: '70.0000', delta: '10.0000', direction: 'UP', null_reason: null });
    expect(detail.unverified).toBe(true);
    expect(detail.follow_up).toMatchObject({ state: 'DUE_SOON', due_on: '2027-10-30' });
    const row = (await fx.rows<{ n: string }>(`select count(*)::text as n from machvon.audit_event where action = 'home.decision_recorded'`))[0];
    expect(Number(row?.n)).toBe(1);
    const outbox = (await fx.rows<{ n: string }>(`select count(*)::text as n from machvon.outbox_event where type = 'home.decision_recorded.v1'`))[0];
    expect(Number(outbox?.n)).toBe(1);
  });

  it('is idempotent: the same key records one decision', async () => {
    await week('2027-10-12', '600000000000');
    const first = await fx.post('/home/decisions', body(), MEMBERS.LEADER, 'decision-key-0000000001');
    const second = await fx.post('/home/decisions', body(), MEMBERS.LEADER, 'decision-key-0000000001');
    expect(second.status).toBe(200);
    expect(id(second)).toBe(id(first));
    expect(Number((await fx.rows<{ n: string }>('select count(*)::text as n from machvon.analytics_decision'))[0]?.n)).toBe(1);
  });

  it('refuses a figure that cannot be frozen and the words that the policy does not allow', async () => {
    const noSnapshot = await fx.post('/home/decisions', body());
    expect(noSnapshot.status).toBe(422);
    expect(noSnapshot.json.code).toBe('METRIC_UNAVAILABLE');
    await week('2027-10-12', '600000000000');
    expect((await fx.post('/home/decisions', body({ subject: { kind: 'KPI_TILE', metric_code: 'NOT_A_TILE' } }))).json.code).toBe('METRIC_UNAVAILABLE');
    expect((await fx.post('/home/decisions', body({ kind: 'WHATEVER' }))).status).toBe(422);
    expect((await fx.post('/home/decisions', body({ reason: 'short' }))).status).toBe(422);
    expect((await fx.post('/home/decisions', body({ follow_up: { due_on: '2027-10-20' } }))).status).toBe(422);
    expect((await fx.post('/home/decisions', body({ follow_up: { due_on: '2027-10-30', owner_id: '00000000-0000-4000-8000-0000000000e7' } }))).status).toBe(422);
    expect(Number((await fx.rows<{ n: string }>('select count(*)::text as n from machvon.analytics_decision'))[0]?.n)).toBe(0);
  });

  it('records a free subject, with a unit, without needing a figure', async () => {
    const free = await fx.post('/home/decisions', { subject: { kind: 'FREE', title: 'Weekly meeting 42', unit_id: unitId(UNITS.NORTH) }, kind: 'DEFER', reason: 'Wait for the Treasury figures of next week.' });
    expect(free.status).toBe(200);
    const detail = (await fx.get(`/home/decisions/${id(free)}`)).json as unknown as Detail;
    expect(detail.figures.snapshot).toBeNull();
    expect(detail.comparison).toBeNull();
    expect(detail.digest_ok).toBe(true);
  });

  it('refuses an urgent alert that is not in the work of the reader, naming nothing', async () => {
    const gone = await fx.post('/home/decisions', { subject: { kind: 'URGENT_ALERT', source: 'EARLY_WARNING', source_id: '00000000-0000-4000-8000-0000000000e8' }, kind: 'ESCALATE', reason: 'Raise it with the chair of the board.' });
    expect(gone.status).toBe(404);
    expect(gone.json.code).toBe('WORK_ITEM_GONE');
  });

  it('adds outcomes, closes the follow-up and stops after the decision is superseded', async () => {
    await week('2027-10-12', '600000000000');
    const first = id(await fx.post('/home/decisions', body()));
    const second = id(await fx.post('/home/decisions', body({ kind: 'ESCALATE' })));
    expect((await fx.post(`/home/decisions/${first}/outcomes`, { outcome: 'STILL_OPEN', note: 'The north unit asked for time.' })).status).toBe(200);
    let detail = (await fx.get(`/home/decisions/${first}`)).json as unknown as Detail;
    expect(detail.latest_outcome).toBe('STILL_OPEN');
    expect((await fx.post(`/home/decisions/${first}/outcomes`, { outcome: 'RESOLVED', note: 'Caught up as asked.' })).status).toBe(200);
    detail = (await fx.get(`/home/decisions/${first}`)).json as unknown as Detail;
    expect(detail.follow_up.state).toBe('RESOLVED');
    expect(detail.outcomes.map((one) => one.outcome)).toEqual(['STILL_OPEN', 'RESOLVED']);
    expect((await fx.post(`/home/decisions/${first}/outcomes`, { outcome: 'SUPERSEDED', note: 'Replaced by the escalation.', superseded_by: second })).status).toBe(200);
    const closed = await fx.post(`/home/decisions/${first}/outcomes`, { outcome: 'RESOLVED', note: 'Trying to add after.' });
    expect(closed.status).toBe(409);
    expect(closed.json.code).toBe('ANALYTICS_DECISION_SUPERSEDED');
    expect((await fx.post(`/home/decisions/${second}/outcomes`, { outcome: 'SUPERSEDED', note: 'Replaced by itself.', superseded_by: second })).status).toBe(422);
    expect((await fx.post(`/home/decisions/${second}/outcomes`, { outcome: 'RESOLVED', note: 'x' })).status).toBe(422);
  });

  it('can neither edit nor remove a decision or an outcome, whatever the application tries', async () => {
    await week('2027-10-12', '600000000000');
    const decision = id(await fx.post('/home/decisions', body()));
    await fx.post(`/home/decisions/${decision}/outcomes`, { outcome: 'STILL_OPEN', note: 'Still open for now.' });
    const asApp = (sql: string): Promise<unknown> => fx.harness.tenants.withTenant({ tenantId: TENANT_A, membershipId: memberId(MEMBERS.LEADER), scopeVersion: 1 }, (tx) => tx.query(sql, [decision]));
    await expect(asApp("update machvon.analytics_decision set reason = 'changed reason text' where id = $1::uuid")).rejects.toBeDefined();
    await expect(asApp('delete from machvon.analytics_decision_outcome where decision_id = $1::uuid')).rejects.toBeDefined();
  });

  it('shows a reader only what is theirs: their own decisions, those of their units, and none of another tenant', async () => {
    await week('2027-10-12', '600000000000');
    const south = await fx.post('/home/decisions', body({ subject: { kind: 'KPI_TILE', metric_code: TILE, unit_id: unitId(UNITS.SOUTH) } }));
    const north = await fx.post('/home/decisions', body({ subject: { kind: 'KPI_TILE', metric_code: TILE, unit_id: unitId(UNITS.NORTH) } }));
    const whole = await fx.post('/home/decisions', body({ kind: 'DEFER' }));
    const leader = (await fx.get('/home/decisions')).json as { items: Item[] };
    expect(leader.items).toHaveLength(3);
    const branch = (await fx.get('/home/decisions', MEMBERS.BRANCH)).json as { items: Item[] };
    expect(branch.items.map((item) => item.id)).toEqual([id(north)]);
    expect((await fx.get(`/home/decisions/${id(south)}`, MEMBERS.BRANCH)).status).toBe(404);
    expect((await fx.get(`/home/decisions/${id(whole)}`, MEMBERS.BRANCH)).status).toBe(404);
    expect((await fx.get(`/home/decisions/${id(north)}`, MEMBERS.BRANCH)).status).toBe(200);
    const other = (await fx.get('/home/decisions', 1, TENANT_B)).json as { items: Item[] };
    expect(other.items).toEqual([]);
    expect((await fx.get(`/home/decisions/${id(north)}`, 1, TENANT_B)).status).toBe(404);
    // The branch may not record a decision about a unit outside its scope.
    expect((await fx.post('/home/decisions', body({ subject: { kind: 'KPI_TILE', metric_code: TILE, unit_id: unitId(UNITS.SOUTH) } }), MEMBERS.BRANCH)).status).toBe(403);
    expect((await fx.post('/home/decisions', body(), MEMBERS.NOBODY)).status).toBe(403);
  });

  it('filters and pages the log, newest first', async () => {
    await week('2027-10-12', '600000000000');
    const ids: string[] = [];
    for (const kind of ['DEFER', 'ESCALATE', 'NO_ACTION']) ids.push(id(await fx.post('/home/decisions', body({ kind, follow_up: undefined }))));
    const page = (await fx.get('/home/decisions?limit=2')).json as { items: Item[]; next_cursor: string | null };
    expect(page.items.map((item) => item.id)).toEqual([ids[2], ids[1]]);
    expect(page.next_cursor).not.toBeNull();
    const next = (await fx.get(`/home/decisions?limit=2&cursor=${encodeURIComponent(page.next_cursor as string)}`)).json as { items: Item[]; next_cursor: string | null };
    expect(next.items.map((item) => item.id)).toEqual([ids[0]]);
    expect(next.next_cursor).toBeNull();
    const only = (await fx.get('/home/decisions?kind=ESCALATE')).json as { items: Item[] };
    expect(only.items.map((item) => item.id)).toEqual([ids[1]]);
    const open = (await fx.get('/home/decisions?open_follow_up=true')).json as { items: Item[] };
    expect(open.items).toEqual([]);
    expect((await fx.get('/home/decisions?limit=0')).status).toBe(422);
    expect((await fx.get('/home/decisions?cursor=x')).status).toBe(422);
    expect((await fx.get(`/home/decisions?decided_by=${memberId(MEMBERS.LEADER)}`)).status).toBe(200);
  });
});

