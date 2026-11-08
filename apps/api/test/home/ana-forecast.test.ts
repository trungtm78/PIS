import { AnaForecastController } from '../../src/modules/home/ana-forecast.controller';
import { MEMBERS, TENANT_B, UNITS, createAnaFixture, unitId } from './ana-support';

jest.setTimeout(240_000);

const FAMILY = 0xb5;
const fx = createAnaFixture(FAMILY, new Date('2027-11-02T03:00:00Z'));
const M = 1_000_000;
const WEEKS = ['2027-09-05', '2027-09-12', '2027-09-19', '2027-09-26', '2027-10-03', '2027-10-10', '2027-10-17', '2027-10-24', '2027-10-31'];

type Outlook = {
  null_reason: string | null;
  cumulative_vnd: string | null;
  plan_total_vnd: string | null;
  remaining_days: number | null;
  linear: { low_vnd: string; central_vnd: string; high_vnd: string } | null;
  seasonal: { central_vnd: string } | null;
  seasonal_null_reason: string | null;
  seasonal_ratio_pct: { central: string | null } | null;
  needed: { status: string; per_week_vnd: string | null; multiple: string | null };
};
type Reading = { null_reason: string | null; year: number | null; whole: Outlook | null; series: Array<{ as_of_date: string; cumulative_vnd: string }>; prior_series: unknown[]; funds: Array<{ code: string; outlook: Outlook }>; info: { formula: string; unverified: boolean; rule_version: string }; certification_gate: string | null };
const outlookOf = (reply: { json: Record<string, unknown> }): Reading => reply.json as unknown as Reading;

/** Nine weekly snapshots: two projects of two funds, each paying 200M at the start and 5M more every week (the whole pays 400M and then 10M a week), the plan 500M each. */
async function steadyYear(): Promise<{ fundA: string; fundB: string }> {
  const fundA = await fx.fundSource('NSTW', 'State budget');
  const fundB = await fx.fundSource('NSDP', 'Local budget');
  let northProject: string | undefined;
  let southProject: string | undefined;
  for (const [index, asOf] of WEEKS.entries()) {
    const snapshot = await fx.snapshot({ asOf });
    const paid = String(200 * M + 5 * M * index);
    northProject = await fx.project(snapshot, UNITS.NORTH, paid, { ...(northProject === undefined ? {} : { projectId: northProject }), fundSourceVersionId: fundA, planPm: String(500 * M), planLocal: '0' });
    southProject = await fx.project(snapshot, UNITS.SOUTH, paid, { ...(southProject === undefined ? {} : { projectId: southProject }), fundSourceVersionId: fundB, planPm: String(500 * M), planLocal: '0' });
  }
  return { fundA, fundB };
}

describe('the year-end outlook of the disbursement over HTTP (G3-5)', () => {
  beforeAll(async () => {
    await fx.start({
      controllers: [AnaForecastController],
      roles: [
        { n: 1, name: 'OUTLOOK_ALL', permissions: ['home.read'] },
        { n: 2, name: 'OUTLOOK_BRANCH', permissions: ['home.read'] },
      ],
      grants: [
        { n: 1, member: MEMBERS.LEADER, role: 1, kind: 'TENANT' },
        { n: 2, member: MEMBERS.BRANCH, role: 2, kind: 'UNIT_SUBTREE', unit: UNITS.NORTH },
      ],
    });
  }, 300_000);
  afterAll(() => fx.stop(), 60_000);
  beforeEach(() => fx.wipe());

  it('gives the band, the needed amount per week and the formula of the rule, with the golden numbers of the kernel', async () => {
    await steadyYear();
    const reply = await fx.get('/home/outlook');
    expect(reply.status).toBe(200);
    const reading = outlookOf(reply);
    expect(reading).toMatchObject({ year: 2027, null_reason: null, certification_gate: null });
    expect(reading.series).toHaveLength(9);
    expect(reading.whole).toMatchObject({ null_reason: null, cumulative_vnd: String(480 * M), plan_total_vnd: String(1000 * M), remaining_days: 61 });
    expect(reading.whole?.linear).toEqual({ low_vnd: '567142857', central_vnd: '567142857', high_vnd: '567142857' });
    expect(reading.whole?.needed).toMatchObject({ status: 'NEEDED', per_week_vnd: '59672131', multiple: '5.97' });
    expect(reading.whole?.seasonal_null_reason).toBe('NO_PRIOR_YEAR');
    expect(reading.info.unverified).toBe(true);
    expect(reading.info.formula).toEqual(expect.any(String));
    expect(reading.info.rule_version).toBe('builtin');
  });

  it('forecasts every fund source on its own when asked (G3-11)', async () => {
    await steadyYear();
    const reading = outlookOf(await fx.get('/home/outlook?breakdown=FUND'));
    expect(reading.funds.map((fund) => fund.code)).toEqual(['NSDP', 'NSTW']);
    // One fund: 20M in 4 weeks over 28 days, 20M * 61 / 28 = 43,571,428.57 on top of 240M.
    expect(reading.funds[0]?.outlook.linear?.central_vnd).toBe('283571429');
    expect(reading.funds[0]?.outlook.plan_total_vnd).toBe(String(500 * M));
  });

  it('reads the seasonal shape of the year before when its series is complete', async () => {
    await steadyYear();
    for (const [asOf, millions] of [['2026-09-05', 300], ['2026-10-03', 380], ['2026-10-31', 460], ['2026-12-31', 1000]] as const) {
      const snapshot = await fx.snapshot({ asOf });
      await fx.project(snapshot, UNITS.NORTH, String((millions * M) / 2), { planPm: String(500 * M), planLocal: '0' });
      await fx.project(snapshot, UNITS.SOUTH, String((millions * M) / 2), { planPm: String(500 * M), planLocal: '0' });
    }
    const reading = outlookOf(await fx.get('/home/outlook'));
    expect(reading.prior_series).toHaveLength(4);
    expect(reading.whole?.seasonal?.central_vnd).toBe(String(750 * M));
    expect(reading.whole?.seasonal_ratio_pct?.central).toBe('75.0');
  });

  it('gives no point for a week in which the Treasury booked nothing and never fills it with zero', async () => {
    await steadyYear();
    const snapshot = await fx.snapshot({ asOf: '2027-11-01' });
    await fx.project(snapshot, UNITS.NORTH, null);
    const reading = outlookOf(await fx.get('/home/outlook'));
    expect(reading.series).toHaveLength(9);
    expect(reading.whole?.cumulative_vnd).toBe(String(480 * M));
  });

  it('says there is no snapshot instead of inventing a figure, and never shows the data of another tenant', async () => {
    await steadyYear();
    const other = await fx.get('/home/outlook', 1, TENANT_B);
    expect(other.status).toBe(200);
    expect(other.json).toMatchObject({ null_reason: 'NO_SNAPSHOT', whole: null, year: null });
  });

  it('keeps a branch reader in its scope and refuses a unit outside it without naming it', async () => {
    await steadyYear();
    const own = outlookOf(await fx.get('/home/outlook', MEMBERS.BRANCH));
    expect(own.whole?.cumulative_vnd).toBe(String(240 * M));
    expect(own.whole?.plan_total_vnd).toBe(String(500 * M));
    const denied = await fx.get(`/home/outlook?unit_id=${unitId(UNITS.SOUTH)}`, MEMBERS.BRANCH);
    expect(denied.status).toBe(403);
  });

  it('refuses a reader without the right and a malformed query', async () => {
    expect((await fx.get('/home/outlook', MEMBERS.NOBODY)).status).toBe(403);
    expect((await fx.get('/home/outlook?plan_basis=ALL')).status).toBe(422);
    expect((await fx.get('/home/outlook?breakdown=X')).status).toBe(422);
    expect((await fx.get('/home/outlook?unit_id=nope')).status).toBe(422);
    expect((await fx.get('/home/outlook?year=27')).status).toBe(422);
  });
});
