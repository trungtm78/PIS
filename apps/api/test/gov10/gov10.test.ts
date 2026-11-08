import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { Client } from 'pg';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { audModule } from '../../src/modules/aud';
import { RedFlagController, RedFlagReadsController } from '../../src/modules/aud/red-flag.controller';
import { homeModule } from '../../src/modules/home';
import { AlertLadderReadsController } from '../../src/modules/home/alert-ladder.controller';
import { AlertClosureReadsController, AlertFeedbackController, AlertFeedbackReadsController, AlertFloodController } from '../../src/modules/home/alert-ops.controller';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { AuthzHarness, TENANT_A, TENANT_B, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(240_000);

const SIGNING_KEY = randomBytes(32);
const AUDITOR = 1; // reads, scans, reviews, reports and reviews feedback
const SECOND = 2; // reads and clears
const DRAFTER = 3; // may read red flags, but drafted the package
const NOBODY = 4; // home.read only
const B_AUDITOR = 1; // of tenant B
const ROOT = 1;
const PROJECT = randomUUID();
const PACKAGE = randomUUID();

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

/** Red flags of procurement, the report that an alert is wrong, the closing and the storms of alerts, and the ladder, over HTTP (lane GOV-10). */
describe('GOV-10 over HTTP', () => {
  let findingId = '';
  const harness = new AuthzHarness();
  let app: RunningApp;
  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);

  async function call(method: string, url: string, options: { member: number; tenantId?: string; body?: unknown; ifMatch?: string; key?: string }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member, options.tenantId), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    const text = await response.text();
    return { status: response.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
  }
  const items = (reply: Reply): Array<Record<string, unknown>> => reply.json.items as Array<Record<string, unknown>>;

  async function seed(statements: Array<[string, unknown[]]>): Promise<void> {
    const client = new Client({ connectionString: harness.database.adminUrl });
    await client.connect();
    try {
      await client.query('set session_replication_role = replica');
      for (const [sql, params] of statements) await client.query(sql, params);
    } finally {
      await client.end();
    }
  }

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) await harness.seedUnits(tenant, [{ n: ROOT, path: `/${unitId(ROOT)}/` }]);
    for (const member of [AUDITOR, SECOND, DRAFTER, NOBODY]) await harness.seedMembership(TENANT_A, member, ROOT);
    await harness.seedMembership(TENANT_B, B_AUDITOR, ROOT);
    const everything = ['home.read', 'aud.redflag.read', 'aud.redflag.scan', 'aud.redflag.review', 'alert.feedback.review', 'alert.closure.read', 'alert.ladder.read'];
    await harness.seedRole(TENANT_A, 1, 'GOV10_AUDITOR', everything, 20);
    await harness.seedRole(TENANT_A, 2, 'GOV10_CHECKER', ['home.read', 'aud.redflag.read', 'aud.redflag.clear'], 20);
    await harness.seedRole(TENANT_A, 3, 'GOV10_DRAFTER', ['home.read', 'aud.redflag.read', 'aud.redflag.review'], 20);
    await harness.seedRole(TENANT_A, 4, 'GOV10_NOBODY', ['home.read'], 20);
    await harness.seedRole(TENANT_B, 1, 'GOV10_AUDITOR', everything, 20);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: AUDITOR, role: 1, kind: 'TENANT' },
      { n: 2, member: SECOND, role: 2, kind: 'TENANT' },
      { n: 3, member: DRAFTER, role: 3, kind: 'TENANT' },
      { n: 4, member: NOBODY, role: 4, kind: 'TENANT' },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: B_AUDITOR, role: 1, kind: 'TENANT' }]);
    // A package that was bid by one bidder in five days, drafted by DRAFTER.
    await seed([
      [`insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group) values ($1, $2, 'PRJ-G10', 'Bridge', $3, $4, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`, [TENANT_A, PROJECT, unitId(ROOT), randomUUID()]],
      [`insert into machvon.procurement_package (tenant_id, id, project_id, code, budget_vnd, method, revision, status, title, created_by) values ($1, $2, $3, 'GT-G10', 900000000, 'OPEN_BIDDING', 1, 'APPROVED', 'Package', $4)`, [TENANT_A, PACKAGE, PROJECT, memberId(DRAFTER)]],
      [`insert into machvon.procurement_milestone (tenant_id, id, package_id, milestone_kind, actual_at, source, created_by, updated_by, version) values ($1, $2, $3, 'INVITATION_PUBLISHED', '2020-09-01T01:00:00Z', 'MANUAL', $4, $4, 1), ($1, $5, $3, 'BID_CLOSING', '2020-09-06T01:00:00Z', 'MANUAL', $4, $4, 1)`, [TENANT_A, randomUUID(), PACKAGE, memberId(AUDITOR), randomUUID()]],
      [`insert into machvon.proposal (tenant_id, id, project_id, package_id, contractor_id, document_version_ids, revision, status, submitted_at, access_released_at, bid_price_vnd, created_by) values ($1, $2, $3, $4, $5, '[]'::jsonb, 1, 'RECEIVED', '2020-09-05T01:00:00Z', '2020-09-07T01:00:00Z', 800000000, $6)`, [TENANT_A, randomUUID(), PROJECT, PACKAGE, randomUUID(), memberId(AUDITOR)]],
    ]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [RedFlagController, RedFlagReadsController, AlertFeedbackController, AlertFeedbackReadsController, AlertClosureReadsController, AlertFloodController, AlertLadderReadsController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 300_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  it('is registered in the modules of HOME and AUD', () => {
    for (const controller of [RedFlagController, RedFlagReadsController]) expect(audModule.controllers).toContain(controller);
    for (const controller of [AlertFeedbackController, AlertFeedbackReadsController, AlertClosureReadsController, AlertFloodController, AlertLadderReadsController]) expect(homeModule.controllers).toContain(controller);
  });

  describe('red flags (G4-3)', () => {

    it('refuses a scan to a caller without the right, scans once for a key, and flags the package for the auditor as a signal and never a conclusion', async () => {
      expect((await call('POST', '/red-flags/scan', { member: NOBODY })).status).toBe(403);
      const key = `key-${randomUUID()}`;
      const first = await call('POST', '/red-flags/scan', { member: AUDITOR, key });
      expect(first.status).toBe(200);
      expect(first.json.status).toBe('FINISHED');
      const replay = await call('POST', '/red-flags/scan', { member: AUDITOR, key });
      expect(replay.json.resource_id).toBe(first.json.resource_id);
      const list = await call('GET', '/red-flags', { member: AUDITOR });
      expect(list.status).toBe(200);
      expect(items(list)).toHaveLength(1);
      const found = items(list)[0] as Record<string, unknown>;
      expect(found).toMatchObject({ subject_code: 'GT-G10', score: 5, band: 'MEDIUM', status: 'NEW', is_conclusion: false });
      findingId = found.id as string;
      const detail = await call('GET', `/red-flags/${findingId}`, { member: AUDITOR });
      expect((detail.json.readings as Array<Record<string, unknown>>).find((reading) => reading.code === 'AWARD_VS_FINAL_PRICE_GAP')).toMatchObject({ status: 'NOT_COMPUTABLE' });
      const summary = await call('GET', '/red-flags/summary', { member: AUDITOR });
      expect(summary.json.total).toBe(1);
      const registry = await call('GET', '/red-flags/indicators', { member: AUDITOR });
      expect(items(registry).length).toBeGreaterThanOrEqual(12);
    });

    it('hides the finding from the person who drafted the package, whatever they hold, and from another tenant', async () => {
      const list = await call('GET', '/red-flags', { member: DRAFTER });
      expect(items(list)).toEqual([]);
      expect((await call('GET', '/red-flags/summary', { member: DRAFTER })).json.total).toBe(0);
      expect((await call('GET', `/red-flags/${findingId}`, { member: DRAFTER })).status).toBe(404);
      expect((await call('POST', `/red-flags/${findingId}/take`, { member: DRAFTER, ifMatch: '"1"' })).status).toBe(404);
      expect((await call('GET', `/red-flags/${findingId}`, { member: B_AUDITOR, tenantId: TENANT_B })).status).toBe(404);
      expect((await call('GET', '/red-flags', { member: NOBODY })).status).toBe(403);
    });

  });

  describe('the report that an alert is wrong, the closing and the storms (G2-8, G2-9, G2-11)', () => {
    let reportId = '';

    it('reports an item the person may see, once, and keeps the item in the list', async () => {
      const finding = (items(await call('GET', '/red-flags', { member: AUDITOR }))[0] as Record<string, unknown>).id as string;
      const body = { source: 'RED_FLAG', source_id: finding, reason: 'WRONG_DATA', note: 'Single bid is normal here' };
      const made = await call('POST', '/home/alert-feedback', { member: AUDITOR, body });
      expect(made.status).toBe(200);
      reportId = made.json.resource_id as string;
      expect((await call('POST', '/home/alert-feedback', { member: AUDITOR, body })).json.code).toBe('ALERT_FEEDBACK_ALREADY_REPORTED');
      expect((await call('POST', '/home/alert-feedback', { member: AUDITOR, body: { ...body, source_id: 'does-not-exist' } })).status).toBe(404);
      expect((await call('POST', '/home/alert-feedback', { member: AUDITOR, body: { ...body, source_id: finding, reason: 'MADE_UP' } })).status).toBeGreaterThanOrEqual(400);
      const mine = await call('GET', '/home/alert-feedback/mine', { member: AUDITOR });
      expect(items(mine).map((entry) => entry.id)).toEqual([reportId]);
      // The audit row and the event name the report and the reason, never the words.
      const audit = await harness.owner<{ safe_diff: Record<string, unknown> }>(TENANT_A, [["select safe_diff from machvon.audit_event where action = 'home.alert_feedback_reported'", []]]);
      expect(JSON.stringify(audit)).not.toContain('Single bid is normal here');
      const events = await harness.owner<{ payload: Record<string, unknown> }>(TENANT_A, [["select payload from machvon.outbox_event where type = 'home.alert_feedback.reported.v1'", []]]);
      expect(JSON.stringify(events)).not.toContain('Single bid is normal here');
    });

    it('is reviewed by somebody else, with the version and a reason for a rejection, and by nobody without the right', async () => {
      const queue = await call('GET', '/home/alert-feedback?status=PENDING', { member: AUDITOR });
      expect(items(queue)).toHaveLength(1);
      expect((await call('GET', '/home/alert-feedback', { member: NOBODY })).status).toBe(403);
      expect((await call('POST', `/home/alert-feedback/${reportId}/review`, { member: AUDITOR, ifMatch: '"1"', body: { move: 'ACCEPT_FOR_TUNING', proposal_note: 'raise the line' } })).status).toBe(403);
      expect((await call('POST', `/home/alert-feedback/${reportId}/review`, { member: NOBODY, ifMatch: '"1"', body: { move: 'REJECT', review_note: 'no' } })).status).toBe(403);
    });

    it('lets the reporter withdraw only their own report', async () => {
      expect((await call('POST', `/home/alert-feedback/${reportId}/withdraw`, { member: SECOND, ifMatch: '"1"' })).status).toBe(404);
      const withdrawn = await call('POST', `/home/alert-feedback/${reportId}/withdraw`, { member: AUDITOR, ifMatch: '"1"' });
      expect(withdrawn.json.status).toBe('WITHDRAWN');
    });

    it('reads the closing report and the storms for the right holder, and the flood state of one own list', async () => {
      expect((await call('GET', '/home/alert-closures', { member: AUDITOR })).status).toBe(200);
      expect((await call('GET', '/home/alert-closures', { member: NOBODY })).status).toBe(403);
      expect((await call('GET', '/home/alert-closures/summary', { member: NOBODY })).status).toBe(403);
      expect((await call('GET', '/home/alert-closures/summary', { member: AUDITOR })).json).toMatchObject({ closed_by_system: 0, open_now: 0 });
      expect((await call('GET', '/home/alert-storms', { member: AUDITOR })).json.items).toEqual([]);
      const flood = await call('GET', '/home/work/flood', { member: AUDITOR });
      expect(flood.status).toBe(200);
      expect(flood.json).toMatchObject({ storm: { active: false }, protecting: false });
      expect((flood.json.policy as Record<string, unknown>).unverified).toBe(true);
      expect((await call('GET', '/home/work/flood?view=weird', { member: AUDITOR })).status).toBe(422);
      expect((await call('GET', '/home/alert-feedback/stats', { member: AUDITOR })).status).toBe(200);
    });
  });

  describe('the channel ladder (G2-6)', () => {
    it('shows the three ladders with the rule that decided and the label of an unconfirmed default, to the right holder only', async () => {
      const policy = await call('GET', '/home/alert-ladder/policy', { member: AUDITOR });
      const ladders = policy.json.ladders as Array<Record<string, unknown>>;
      expect(ladders.map((ladder) => ladder.severity)).toEqual(['URGENT', 'ACTION', 'WATCH']);
      expect(ladders[0]).toMatchObject({ version: 'builtin', unverified: true, hand_off: 'ESCALATE' });
      expect((await call('GET', '/home/alert-ladder/policy', { member: NOBODY })).status).toBe(403);
      expect((await call('GET', '/home/alert-ladder/runs', { member: NOBODY })).status).toBe(403);
      expect((await call('GET', '/home/alert-ladder/runs?state=NOPE', { member: AUDITOR })).status).toBe(422);
      expect((await call('GET', '/home/alert-ladder/item?source=RED_FLAG&source_id=x', { member: AUDITOR })).json.items).toEqual([]);
      const kpi = await call('GET', '/home/alert-ladder/kpi', { member: AUDITOR });
      expect(kpi.json).toMatchObject({ runs: 0, unverified: true });
    });
  });

  describe('the review of a red flag after the alerts', () => {
    it('clears only in two steps: a proposal with a reason, then a different auditor', async () => {
      expect((await call('POST', `/red-flags/${findingId}/take`, { member: AUDITOR, ifMatch: '"1"' })).json.status).toBe('IN_REVIEW');
      expect((await call('POST', `/red-flags/${findingId}/propose-clear`, { member: AUDITOR, ifMatch: '"2"', body: { reason: 'ok' } })).status).toBe(422);
      expect((await call('POST', `/red-flags/${findingId}/propose-clear`, { member: AUDITOR, ifMatch: '"1"', body: { reason: 'The single bid is justified' } })).status).toBe(409);
      expect((await call('POST', `/red-flags/${findingId}/propose-clear`, { member: AUDITOR, ifMatch: '"2"', body: { reason: 'The single bid is justified' } })).json.status).toBe('CLEAR_PROPOSED');
      // The proposer holds no right to clear; the checker is a different person.
      expect((await call('POST', `/red-flags/${findingId}/confirm-clear`, { member: AUDITOR, ifMatch: '"3"' })).status).toBe(403);
      const cleared = await call('POST', `/red-flags/${findingId}/confirm-clear`, { member: SECOND, ifMatch: '"3"' });
      expect(cleared.json.status).toBe('CLEARED');
      const events = await harness.owner<{ type: string }>(TENANT_A, [["select type from machvon.outbox_event where type like 'aud.red_flag.%' order by created_at", []]]);
      expect(events.map((event) => event.type)).toEqual(expect.arrayContaining(['aud.red_flag.taken.v1', 'aud.red_flag.clear_proposed.v1', 'aud.red_flag.cleared.v1']));
    });
  });
});
