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

const SIGNING_KEY = randomBytes(32);
const WORKER = '00000000-0000-4000-8000-000000000000';
const STEWARD = 1; // proposes the definitions
const OWNER = 2; // the capital business owner: owns the domain DISBURSEMENT, approves and publishes, and builds the figures
const OUTSIDER = 3; // holds glossary.approve and is the owner of nothing (the terms are owned by the tenant owner)
const READER = 4; // reads the definitions
const FIGURES_ONLY = 5; // reads the disbursement figures and nothing of the glossary

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

/** The definitions of the disbursement metrics and what depends on their sign-off (ST-DIS-011, DIS-25, D03). */
describe('the definitions of the disbursement metrics over HTTP (ST-DIS-011)', () => {
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
  const idOf = (reply: Reply): string => reply.json.resource_id as string;

  const definitions = (member = READER): Promise<Reply> => call('GET', `/glossary-terms?domain=${DIS_GLOSSARY_DOMAIN}`, { member });
  const statusOf = (reply: Reply, code: string): unknown => (reply.json.items as Array<Record<string, unknown>>).find((item) => item.term_code === code)?.status;
  /** An ad hoc snapshot of the tenant: what carries the state of the definitions it was made with. */
  async function snapshotDefinition(): Promise<unknown> {
    const built = await call('POST', '/period-snapshots', { member: OWNER, body: { period_id: periodId, snapshot_kind: 'ADHOC', treasury_cutoff_date: periodEnd } });
    expect(built.status).toBe(200);
    const read = await call('GET', `/period-snapshots/${idOf(built)}/lines`, { member: OWNER });
    return (read.json.snapshot as Record<string, unknown>).definition_status;
  }

  beforeAll(async () => {
    await harness.start();
    await harness.seedUnits(TENANT_A, [{ n: 1, path: `/${unitId(1)}/` }]);
    for (const n of [STEWARD, OWNER, OUTSIDER, READER, FIGURES_ONLY]) await harness.seedMembership(TENANT_A, n, 1);
    await harness.seedRole(TENANT_A, 1, 'DEFINITION_STEWARD', ['glossary.propose', 'glossary.read'], 40);
    await harness.seedRole(TENANT_A, 2, 'TENANT_OWNER', ['glossary.propose', 'glossary.approve', 'glossary.read', 'snapshot.build', 'snapshot.freeze', 'disbursement.read'], 80);
    await harness.seedRole(TENANT_A, 3, 'GLOSSARY_APPROVER', ['glossary.approve', 'glossary.read'], 40);
    await harness.seedRole(TENANT_A, 4, 'DEFINITION_READER', ['glossary.read'], 20);
    await harness.seedRole(TENANT_A, 5, 'FIGURES_ONLY', ['disbursement.read'], 20);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: STEWARD, role: 1, kind: 'TENANT' },
      { n: 2, member: OWNER, role: 2, kind: 'TENANT' },
      { n: 3, member: OUTSIDER, role: 3, kind: 'TENANT' },
      { n: 4, member: READER, role: 4, kind: 'TENANT' },
      { n: 5, member: FIGURES_ONLY, role: 5, kind: 'TENANT' },
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
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
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

  const codes = DISBURSEMENT_TERMS.map((item) => item.termCode);

  it('AC-ST-DIS-011-1 / UAT-AC257: the definitions of the metrics (the period change, the year and project cumulatives, the two denominators) are in the glossary of the tenant awaiting the owner, and a snapshot says so', async () => {
    expect(DIS_GLOSSARY_DOMAIN).toBe('DISBURSEMENT');
    expect(codes).toEqual(['GIAI_NGAN_PERIOD', 'GIAI_NGAN_YTD', 'GIAI_NGAN_PTD', 'MAU_SO_KH_TTG_GIAO', 'MAU_SO_KH_TONG']);
    const listed = await definitions();
    expect(listed.status).toBe(200);
    for (const code of codes) expect(statusOf(listed, code)).toBe('IN_REVIEW');
    expect(await snapshotDefinition()).toBe('PROPOSED_PENDING_SIGNOFF');
  });

  it('DIS-25 reads the definitions with glossary.read: a person who only holds disbursement.read is refused by the glossary (403), so the screen shows the refusal and not the definitions', async () => {
    expect((await definitions(READER)).status).toBe(200);
    expect((await definitions(FIGURES_ONLY)).status).toBe(403);
  });

  it('AC-ST-DIS-011-1 / UAT-AC257: a person who does not own the domain cannot approve a term (403 SCOPE_DENIED) and the term stays in review; a reader cannot approve either', async () => {
    const [ytd] = await rows<{ id: string; version: string }>("select id, version::text as version from machvon.glossary_term where term_code = 'GIAI_NGAN_YTD'");
    const outside = await call('POST', `/glossary-terms/${ytd?.id}/decision`, { member: OUTSIDER, ifMatch: `"${ytd?.version}"`, body: { decision: 'approve', reason: 'Reviewed by someone who does not own the domain' } });
    expect([outside.status, outside.json.code]).toEqual([403, 'SCOPE_DENIED']);
    expect(await rows<{ status: string }>('select status from machvon.glossary_term where id = $1', [ytd?.id])).toEqual([{ status: 'IN_REVIEW' }]);
    const reader = await call('POST', `/glossary-terms/${ytd?.id}/decision`, { member: READER, ifMatch: `"${ytd?.version}"`, body: { decision: 'approve', reason: 'A reader' } });
    expect(reader.status).toBe(403);
    expect(await snapshotDefinition()).toBe('PROPOSED_PENDING_SIGNOFF');
  });

  it('UAT-PLAN-69: a snapshot says the definitions are signed only once the owner has published every one of them: one term short of that it still says they are proposals, and it follows the glossary with no setting of its own', async () => {
    const terms = await rows<{ id: string; version: string }>("select id, version::text as version from machvon.glossary_term where domain = 'DISBURSEMENT' and status = 'IN_REVIEW' order by term_code");
    expect(terms).toHaveLength(codes.length);
    const finish = async (term: { id: string; version: string }): Promise<void> => {
      const approved = await call('POST', `/glossary-terms/${term.id}/decision`, { member: OWNER, ifMatch: `"${term.version}"`, body: { decision: 'approve', reason: 'Signed by the capital business owner' } });
      expect(approved.json).toMatchObject({ status: 'APPROVED' });
      const published = await call('POST', `/glossary-terms/${term.id}/publish`, { member: OWNER, ifMatch: `"${approved.json.resource_version}"` });
      expect(published.json).toMatchObject({ status: 'PUBLISHED' });
    };
    const last = terms[terms.length - 1] as { id: string; version: string };
    for (const term of terms.slice(0, -1)) await finish(term);
    expect(await snapshotDefinition()).toBe('PROPOSED_PENDING_SIGNOFF');
    await finish(last);
    for (const code of codes) expect(statusOf(await definitions(), code)).toBe('PUBLISHED');
    expect(await snapshotDefinition()).toBe('SIGNED');
  });
});
