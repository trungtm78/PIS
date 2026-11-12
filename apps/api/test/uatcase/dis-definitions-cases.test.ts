import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { BASELINE_PACK, DISBURSEMENT_TERMS, DisPeriodStore, EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase, applyBaseline } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { DIS_GLOSSARY_DOMAIN } from '@machvon/contracts';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { GlossaryController, GlossaryReadsController } from '../../src/modules/mdm/glossary.controller';
import { PeriodSnapshotController } from '../../src/modules/dis/period-snapshot.controller';
import { DIS_CLOCK } from '../../src/modules/dis/tokens';
import { AuthzHarness, TENANT_A, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';
import { assertStatus, expectCheckFails } from '../uat/uat-kit';
import type { Reply } from '../uat/uat-kit';

jest.setTimeout(300_000);

const SIGNING_KEY = randomBytes(32);
const WORKER = '00000000-0000-4000-8000-000000000000';
const OWNER = 1; // the capital business owner: owns the domain DISBURSEMENT, approves and publishes, and builds the figures
const READER = 2; // reads the definitions

/** FR-DIS-25: the definitions of the disbursement metrics are signed when the business owner has published every required term, and the screen DIS-25 shows each term with its signer and date. */
describe('the sign-off of the definitions of the disbursement metrics (UAT cases of DIS)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  let periodId = '';
  let periodEnd = '';
  const clockNow = new Date('2027-12-15T03:00:00Z');

  const tokenOf = (member: number): string => signTenantContext({ tenantId: TENANT_A, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);
  async function call(method: 'GET' | 'POST', url: string, options: { member: number; body?: unknown; ifMatch?: string }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }
  const rows = async <R extends object>(sql: string, params: unknown[] = []): Promise<R[]> => harness.owner<R>(TENANT_A, [[sql, params]]);

  /** A new snapshot of the period (what carries the state of the definitions it was made with), and the state it says. */
  async function snapshotDefinition(): Promise<unknown> {
    const built = await call('POST', '/period-snapshots', { member: OWNER, body: { period_id: periodId, snapshot_kind: 'ADHOC', treasury_cutoff_date: periodEnd } });
    assertStatus(built, 200);
    const read = await call('GET', `/period-snapshots/${built.json.resource_id as string}/lines`, { member: OWNER });
    return (read.json.snapshot as Record<string, unknown>).definition_status;
  }

  beforeAll(async () => {
    await harness.start();
    await harness.seedUnits(TENANT_A, [{ n: 1, path: `/${unitId(1)}/` }]);
    for (const n of [OWNER, READER]) await harness.seedMembership(TENANT_A, n, 1);
    await harness.seedRole(TENANT_A, 1, 'TENANT_OWNER', ['glossary.propose', 'glossary.approve', 'glossary.read', 'snapshot.build', 'snapshot.freeze', 'disbursement.read'], 80);
    await harness.seedRole(TENANT_A, 2, 'DEFINITION_READER', ['glossary.read'], 20);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: OWNER, role: 1, kind: 'TENANT' },
      { n: 2, member: READER, role: 2, kind: 'TENANT' },
    ]);
    const tenants = harness.tenants as TenantDatabase;
    await tenants.withTenant({ tenantId: TENANT_A, membershipId: WORKER, scopeVersion: 0 }, async (tx) => {
      await applyBaseline(tx, BASELINE_PACK, WORKER);
      await new DisPeriodStore().generate(tx, { calendarCode: 'DEFAULT', fiscalYear: 2027, periodType: 'WEEK' }, WORKER, new Date('2026-12-15T00:00:00Z'));
    });
    const [week] = await rows<{ id: string; end: string }>("select id, end_date::text as end from machvon.reporting_period where fiscal_year = 2027 and period_type = 'WEEK' and start_date >= date '2027-01-04' order by start_date limit 1");
    periodId = (week as { id: string }).id;
    periodEnd = (week as { end: string }).end;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [CommandModule.register({ database: tenants }), PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) })],
      controllers: [GlossaryController, GlossaryReadsController, PeriodSnapshotController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: DIS_CLOCK, useValue: () => clockNow },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 300_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  it('UAT-PLAN-04: the snapshot says SIGNED once the owner has published every required term, stays PROPOSED_PENDING_SIGNOFF with one term unpublished, and DIS-25 shows each term with signer and date', async () => {
    const codes = DISBURSEMENT_TERMS.map((item) => item.termCode);
    expect(DIS_GLOSSARY_DOMAIN).toBe('DISBURSEMENT');
    const terms = await rows<{ id: string; version: string }>("select id, version::text as version from machvon.glossary_term where domain = 'DISBURSEMENT' and status = 'IN_REVIEW' order by term_code");
    expect(terms).toHaveLength(codes.length);
    expect(await snapshotDefinition()).toBe('PROPOSED_PENDING_SIGNOFF');

    const finish = async (term: { id: string; version: string }): Promise<void> => {
      const approved = await call('POST', `/glossary-terms/${term.id}/decision`, { member: OWNER, ifMatch: `"${term.version}"`, body: { decision: 'approve', reason: 'Signed by the capital business owner' } });
      expect(approved.json).toMatchObject({ status: 'APPROVED' });
      const published = await call('POST', `/glossary-terms/${term.id}/publish`, { member: OWNER, ifMatch: `"${approved.json.resource_version as number}"` });
      expect(published.json).toMatchObject({ status: 'PUBLISHED' });
    };
    const last = terms[terms.length - 1] as { id: string; version: string };
    for (const term of terms.slice(0, -1)) await finish(term);
    // One term short of the whole set: the snapshot still says the definitions are proposals.
    expect(await snapshotDefinition()).toBe('PROPOSED_PENDING_SIGNOFF');
    await finish(last);
    expect(await snapshotDefinition()).toBe('SIGNED');

    // DIS-25 reads the glossary of the domain: every required term is PUBLISHED, with the person who signed it and the day.
    const listed = await call('GET', `/glossary-terms?domain=${DIS_GLOSSARY_DOMAIN}`, { member: READER });
    assertStatus(listed, 200);
    const items = listed.json.items as Array<{ term_code: string; status: string; approved_by: string | null; published_by: string | null; published_at: string | null }>;
    expect(items.map((item) => item.term_code).sort()).toEqual([...codes].sort());
    for (const item of items) {
      expect([item.term_code, item.status, item.approved_by, item.published_by]).toEqual([item.term_code, 'PUBLISHED', memberId(OWNER), memberId(OWNER)]);
      expect(Number.isNaN(Date.parse(item.published_at as string))).toBe(false);
    }
  });

  it('negative control of the definition cases: a status other than the expected one makes the check throw', () => {
    expectCheckFails(() => assertStatus({ status: 200, json: {} }, 409, 'GLOSSARY_TERM_NOT_PUBLISHED'));
    expectCheckFails(() => expect(['PROPOSED_PENDING_SIGNOFF']).toEqual(['SIGNED']));
  });
});
