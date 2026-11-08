import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { MilestoneForecastController } from '../../src/modules/dis/milestone-forecast.controller';
import { DIS_CLOCK } from '../../src/modules/dis/tokens';
import { LessonsController } from '../../src/modules/prj/lessons.controller';
import { LookAheadController } from '../../src/modules/prj/look-ahead.controller';
import { PaymentClockReadsController } from '../../src/modules/pay/payment-clock.controller';
import { SettlementClockController } from '../../src/modules/ctr/settlement-clock.controller';
import { ReallocationImpactReadsController } from '../../src/modules/cap/reallocation-impact.controller';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { AuthzHarness, TENANT_A, TENANT_B, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

const SIGNING_KEY = randomBytes(32);
const READER = 1;
const NOBODY = 2;
const ROOT = 1;
const NOW = new Date('2027-11-02T03:00:00Z');
const PERMISSIONS = ['payment.clock.read', 'disbursement.read', 'contract.read', 'capital.read', 'look_ahead.read', 'lesson.read'];

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

/** The reads of GOV-11a over HTTP: each answers its read model to a caller with the permission, refuses a caller without it, and a project or a contract that does not exist is 404. */
describe('the reads of the milestones, the clocks, the look-ahead and the lessons over HTTP (GOV-11a)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);
  async function get(path: string, member = READER, tenantId?: string): Promise<Reply> {
    const response = await fetch(`${app.baseUrl}${path}`, { headers: { [TENANT_HEADER]: tokenOf(member, tenantId) } });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [{ n: ROOT, path: `/${unitId(ROOT)}/` }]);
      await harness.seedRole(tenant, 1, 'GOV11A_READER', PERMISSIONS, 20);
    }
    for (const n of [READER, NOBODY]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedGrants(TENANT_A, [{ n: 1, member: READER, role: 1, kind: 'TENANT' }]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [MilestoneForecastController, PaymentClockReadsController, SettlementClockController, LookAheadController, LessonsController, ReallocationImpactReadsController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: DIS_CLOCK, useValue: () => NOW },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 300_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  it('serves the catalogue of the standard return reasons from the rule, flagged not confirmed', async () => {
    const reply = await get('/payment-return-reasons');
    expect(reply.status).toBe(200);
    const items = reply.json.items as Array<{ code: string; unverified: boolean; source: string }>;
    expect(items.map((item) => item.code)).toEqual(expect.arrayContaining(['MISSING_DOCUMENT', 'OTHER']));
    expect(items.every((item) => item.unverified && item.source === 'DEFAULT')).toBe(true);
    expect(reply.json.reason_code_required).toBe(true);
  });

  it('serves an empty board of the Treasury clocks with the 2 and 1 working days of the rule, and refuses a bad filter', async () => {
    const reply = await get('/payment-clocks');
    expect(reply.status).toBe(200);
    expect(reply.json.items).toEqual([]);
    const rules = reply.json.rules as Array<{ kind: string; working_days: number; unverified: boolean }>;
    expect(rules.map((rule) => [rule.kind, rule.working_days, rule.unverified])).toEqual([['PAYMENT', 2, true], ['ADVANCE', 1, true]]);
    expect(reply.json.summary).toMatchObject({ total: 0, open: 0, breached: 0 });
    expect((await get('/payment-clocks?state=NOPE')).status).toBe(422);
    expect((await get('/payment-clocks?kind=NOPE')).status).toBe(422);
    expect((await get('/payment-clocks?limit=0')).status).toBe(422);
  });

  it('serves the board of the milestones without a snapshot as an answer with no snapshot, never as an error', async () => {
    const reply = await get('/disbursement-milestones');
    expect(reply.status).toBe(200);
    expect(reply.json).toMatchObject({ snapshot: null, run: null, milestones: [] });
    expect((reply.json.rule as { unverified: boolean }).unverified).toBe(true);
    expect((await get(`/disbursement-milestones?snapshot_id=${randomUUID()}`)).status).toBe(404);
    expect((await get('/disbursement-milestones?snapshot_id=nope')).status).toBe(422);
  });

  it('serves the accuracy of the forecasts with no pairs as empty rows and the band of nobody', async () => {
    const reply = await get('/disbursement-forecast-accuracy');
    expect(reply.status).toBe(200);
    expect(reply.json.rows).toEqual([]);
    expect((await get('/disbursement-forecast-accuracy?plan_year=20x7')).status).toBe(422);
  });

  it('serves the clocks of settlement with the months of the rule and refuses a bad state', async () => {
    const reply = await get('/contract-settlement-clocks');
    expect(reply.status).toBe(200);
    expect(reply.json.items).toEqual([]);
    expect((reply.json.rule as { params: { months_by_group: Record<string, number> } }).params.months_by_group).toEqual({ QTQG: 5, A: 5, B: 5, C: 4 });
    expect((await get('/contract-settlement-clocks?state=NOPE')).status).toBe(422);
  });

  it('says 404 for a contract, a project or a proposal that does not exist, and never a 500', async () => {
    for (const path of [`/contracts/${randomUUID()}/linkage`, `/contracts/${randomUUID()}/adjustments`, `/projects/${randomUUID()}/look-ahead`, `/projects/${randomUUID()}/lessons`, `/reallocation-proposals/${randomUUID()}/impact`]) {
      const reply = await get(path);
      expect([path, reply.status]).toEqual([path, 404]);
    }
    expect([400, 422]).toContain((await get('/contracts/not-a-uuid/linkage')).status);
    expect((await get(`/projects/${randomUUID()}/look-ahead?plan_id=${randomUUID()}`)).status).toBe(404);
    expect([400, 422]).toContain((await get(`/projects/${randomUUID()}/look-ahead?plan_id=nope`)).status);
  });

  it('refuses a caller without the permission and reads nothing of another tenant', async () => {
    expect((await get('/payment-clocks', NOBODY)).status).toBe(403);
    expect((await get('/payment-return-reasons', NOBODY)).status).toBe(403);
    expect((await get('/disbursement-milestones', NOBODY)).status).toBe(403);
    expect((await get('/contract-settlement-clocks', NOBODY)).status).toBe(403);
    const foreign = (await get('/payment-clocks', READER, TENANT_B)).status;
    expect(foreign).toBeGreaterThanOrEqual(400);
    expect(foreign).toBeLessThan(500);
  });
});
