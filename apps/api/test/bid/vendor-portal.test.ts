import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { bidModule } from '../../src/modules/bid';
import { PortalController } from '../../src/modules/bid/portal.controller';
import { PortalReadsController } from '../../src/modules/bid/portal-reads.controller';
import { VendorPortalStaffController } from '../../src/modules/bid/vendor-portal-staff.controller';
import { VendorPortalStaffReadsController } from '../../src/modules/bid/vendor-portal-staff-reads.controller';
import { RedFlagReadsController } from '../../src/modules/aud/red-flag.controller';
import { AuthzHarness, TENANT_A, TENANT_B, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(240_000);

const SIGNING_KEY = randomBytes(32);
const ADMIN = 1;
const CHECKER = 2;
const GUEST_A = 3;
const GUEST_B = 4;
const NOBODY = 5;
const B_ADMIN = 1;
const ROOT = 1;
const STAFF_RIGHTS = ['vnd.read', 'vnd.portal.manage', 'vnd.remediation.manage', 'vnd.ocds.export'];
const GUEST_RIGHTS = ['vnd.portal.read', 'vnd.portal.respond', 'vnd.portal.certificate', 'vnd.portal.reconfirm', 'vnd.portal.remediation'];
const ANSWER = 'The private words of the answer of the contractor';

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

describe('the contractor portal and the plans of remediation (VND-3: VND-16 to VND-22)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  let a = '';
  let b = '';
  let counter = 0;

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);

  async function call(method: string, url: string, options: { member: number; tenantId?: string; body?: unknown; ifMatch?: string | number; key?: string }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member, options.tenantId), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = `"${options.ifMatch}"`;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    const text = await response.text();
    return { status: response.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
  }

  const rows = async <R extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);
  const audits = (resourceId: string, action: string) => rows<{ safe_diff: Record<string, unknown>; reason: string | null; actor_id: string; classification: string }>('select safe_diff, reason, actor_id, classification from machvon.audit_event where resource_id = $1 and action = $2 order by occurred_at', [resourceId, action]);
  const events = (aggregateId: string, type: string) => rows<{ payload: Record<string, unknown> }>('select payload from machvon.outbox_event where aggregate_id = $1 and type = $2 order by created_at', [aggregateId, type]);

  async function document(): Promise<string> {
    const documentId = randomUUID();
    await rows(
      `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, symbol, issued_on, effect_status, created_by, updated_by) values ($1, $2, 'REFERENCE', 'QD', 'Decision', 'INTERNAL', '12/QD', date '2026-01-01', 'EFFECTIVE', $3, $3)`,
      [TENANT_A, documentId, memberId(ADMIN)],
    );
    return documentId;
  }

  async function contractor(name: string): Promise<string> {
    counter += 1;
    const contractorId = randomUUID();
    await rows(
      `insert into machvon.contractor (tenant_id, id, tax_identifier, legal_name, verification_status, profile_document_id, created_by, updated_by, verified_by, verified_at, verification_evidence_document_id, verification_basis)
       values ($1, $2, $3, $4, 'VERIFIED', $5, $6, $6, $7, now(), $8, 'EVIDENCE_DOCUMENT')`,
      [TENANT_A, contractorId, `07${String(counter).padStart(8, '0')}`, name, await document(), memberId(ADMIN), memberId(CHECKER), await document()],
    );
    return contractorId;
  }

  const bind = (member: number, contractorId: string) =>
    rows("update machvon.membership set membership_type = 'GUEST_CONTRACTOR', contractor_id = $2::uuid, valid_until = now() + interval '1 year' where id = $1::uuid", [memberId(member), contractorId]);

  const dayFromNow = (days: number): string => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) await harness.seedUnits(tenant, [{ n: ROOT, path: `/${unitId(ROOT)}/` }]);
    for (const n of [ADMIN, CHECKER, GUEST_A, GUEST_B, NOBODY]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedMembership(TENANT_B, B_ADMIN, ROOT);
    await harness.seedRole(TENANT_A, 1, 'VND_STAFF', STAFF_RIGHTS, 50);
    await harness.seedRole(TENANT_A, 2, 'GUEST_CONTRACTOR', GUEST_RIGHTS, 10);
    await harness.seedRole(TENANT_B, 1, 'VND_STAFF', STAFF_RIGHTS, 50);
    const contract = randomUUID();
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: ADMIN, role: 1, kind: 'TENANT' },
      { n: 2, member: CHECKER, role: 1, kind: 'TENANT' },
      { n: 3, member: GUEST_A, role: 2, kind: 'CONTRACT', refs: [contract] },
      { n: 4, member: GUEST_B, role: 2, kind: 'CONTRACT', refs: [contract] },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: B_ADMIN, role: 1, kind: 'TENANT' }]);
    for (const year of [2026, 2027, 2028]) {
      await rows(
        `insert into machvon.work_calendar_version (tenant_id, id, calendar_code, year, revision, working_days, holidays, compensated_workdays, legal_basis_ref, status, created_by, published_by, published_at)
         values ($1, gen_random_uuid(), 'WORKDAY_VN', $2, 1, '[1,2,3,4,5]'::jsonb, '[]'::jsonb, '[]'::jsonb, 'Labour Code 2019', 'Published', $3, $3, now())`,
        [TENANT_A, year, memberId(ADMIN)],
      );
    }
    a = await contractor('Cty Portal A');
    b = await contractor('Cty Portal B');
    await bind(GUEST_A, a);
    await bind(GUEST_B, b);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [VendorPortalStaffController, VendorPortalStaffReadsController, PortalController, PortalReadsController, RedFlagReadsController],
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

  it('is registered in the module of BID', () => {
    for (const controller of [VendorPortalStaffController, VendorPortalStaffReadsController, PortalController, PortalReadsController]) expect(bidModule.controllers).toContain(controller);
  });

  describe('the requests', () => {
    it('lets staff ask, the contractor answer once, and staff accept; audits the answer as confidential and puts no words in the events', async () => {
      const created = await call('POST', `/vendor/contractors/${a}/portal-requests`, { member: ADMIN, body: { kind: 'INFORMATION', title: 'Send the list of the key staff', body: 'As of today', due_on: dayFromNow(10) } });
      expect(created).toMatchObject({ status: 200, json: { status: 'CREATED', resource_version: 1 } });
      const requestId = created.json.resource_id as string;
      const [audit] = await audits(requestId, 'vnd.portal_request_created');
      expect(audit).toMatchObject({ classification: 'INTERNAL', actor_id: memberId(ADMIN), safe_diff: { contractor_id: a, kind: 'INFORMATION' } });

      const listed = await call('GET', '/vendor/portal/requests', { member: CHECKER });
      expect(listed.status).toBe(200);
      expect((listed.json.items as Array<{ id: string }>).some((item) => item.id === requestId)).toBe(true);
      expect(listed.json).toMatchObject({ counts: { open: expect.any(Number) }, policies: { INFORMATION: { code: 'VENDOR_PORTAL:INFORMATION', version: 'builtin', unverified: true } } });

      // The contractor sees it; another contractor does not.
      const own = await call('GET', '/portal/requests', { member: GUEST_A });
      expect((own.json.items as Array<{ id: string; clock: string }>).find((item) => item.id === requestId)).toMatchObject({ clock: 'ON_TIME' });
      const others = await call('GET', '/portal/requests', { member: GUEST_B });
      expect((others.json.items as Array<{ id: string }>).some((item) => item.id === requestId)).toBe(false);

      // Another contractor cannot answer it: it is not there.
      expect(await call('POST', `/portal/requests/${requestId}/response`, { member: GUEST_B, ifMatch: 1, body: { text: ANSWER } })).toMatchObject({ status: 404, json: { code: 'RESOURCE_NOT_FOUND' } });
      expect((await call('POST', `/portal/requests/${requestId}/response`, { member: GUEST_A, ifMatch: 1, body: {} })).json).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'text' });
      expect((await call('POST', `/portal/requests/${requestId}/response`, { member: GUEST_A, ifMatch: 9, body: { text: ANSWER } })).json).toMatchObject({ code: 'VERSION_CONFLICT' });

      // The same key gives the same answer and writes once.
      const key = `answer-${randomUUID()}`;
      const first = await call('POST', `/portal/requests/${requestId}/response`, { member: GUEST_A, ifMatch: 1, body: { text: ANSWER }, key });
      const replay = await call('POST', `/portal/requests/${requestId}/response`, { member: GUEST_A, ifMatch: 1, body: { text: ANSWER }, key });
      expect(first).toMatchObject({ status: 200, json: { status: 'RESPONDED', resource_version: 2, resource_id: requestId } });
      expect(replay.json).toEqual(first.json);
      const [answered] = await audits(requestId, 'vnd.portal_request_answered');
      expect(answered).toMatchObject({ classification: 'CONFIDENTIAL', actor_id: memberId(GUEST_A), safe_diff: { contractor_id: a, response_late: false } });
      expect(await audits(requestId, 'vnd.portal_request_answered')).toHaveLength(1);
      const sent = await events(requestId, 'vnd.portal.request.changed.v1');
      expect(sent).toHaveLength(2);
      expect(JSON.stringify(sent.map((entry) => entry.payload))).not.toContain(ANSWER);

      expect((await call('POST', `/portal/requests/${requestId}/response`, { member: GUEST_A, ifMatch: 2, body: { text: 'Again' } })).json).toMatchObject({ code: 'PORTAL_REQUEST_STATE_INVALID' });
      const accepted = await call('POST', `/vendor/portal-requests/${requestId}/accept`, { member: CHECKER, ifMatch: 2 });
      expect(accepted).toMatchObject({ status: 200, json: { status: 'ACCEPTED', resource_version: 3 } });
      expect(await call('POST', `/vendor/portal-requests/${requestId}/cancel`, { member: ADMIN, ifMatch: 3, body: { reason: 'Too late to cancel' } })).toMatchObject({ status: 409, json: { code: 'PORTAL_REQUEST_STATE_INVALID' } });
    });

    it('returns an answer for another round and cancels with a reason', async () => {
      const made = await call('POST', `/vendor/contractors/${a}/portal-requests`, { member: ADMIN, body: { kind: 'OTHER', title: 'A request to return', due_on: dayFromNow(10) } });
      const id = made.json.resource_id as string;
      await call('POST', `/portal/requests/${id}/response`, { member: GUEST_A, ifMatch: 1, body: { text: 'First' } });
      expect((await call('POST', `/vendor/portal-requests/${id}/return`, { member: CHECKER, ifMatch: 2, body: { reason: 'no' } })).json).toMatchObject({ code: 'VALIDATION_FAILED' });
      expect(await call('POST', `/vendor/portal-requests/${id}/return`, { member: CHECKER, ifMatch: 2, body: { reason: 'Please add the signed page' } })).toMatchObject({ status: 200, json: { status: 'RETURNED', resource_version: 3 } });
      const mine = await call('GET', '/portal/requests?status=OPEN', { member: GUEST_A });
      expect((mine.json.items as Array<{ id: string; round: number; review_note: string }>).find((item) => item.id === id)).toMatchObject({ round: 2, review_note: 'Please add the signed page' });
      expect(await call('POST', `/vendor/portal-requests/${id}/cancel`, { member: ADMIN, ifMatch: 3, body: { reason: 'Asked by mistake' } })).toMatchObject({ status: 200, json: { status: 'CANCELLED' } });
      expect((await call('GET', '/portal/requests?status=BAD', { member: GUEST_A })).json).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'status' });
    });

    it('refuses a contractor with no account on the portal', async () => {
      const lonely = await contractor('Cty Without An Account');
      expect((await call('POST', `/vendor/contractors/${lonely}/portal-requests`, { member: ADMIN, body: { kind: 'OTHER', title: 'Nobody can answer' } })).json).toMatchObject({ code: 'CONTRACTOR_PORTAL_NOT_BOUND' });
      expect((await call('POST', `/vendor/contractors/${randomUUID()}/portal-requests`, { member: ADMIN, body: { kind: 'OTHER', title: 'Nobody there' } })).status).toBe(404);
    });
  });

  describe('what a contractor sees and what it never sees', () => {
    it('shows the home of the portal with the whitelisted profile and nothing of the investigation', async () => {
      const home = await call('GET', '/portal/me', { member: GUEST_A });
      expect(home.status).toBe(200);
      const profile = home.json.profile as Record<string, unknown>;
      expect(profile).toMatchObject({ id: a, legal_name: 'Cty Portal A' });
      expect(Object.keys(profile).sort()).toEqual(['business_registration_no', 'email', 'id', 'legal_name', 'legal_rep_name', 'legal_rep_position', 'next_review_due', 'ownership_declaration', 'phone', 'profile_reviewed_at', 'registered_address', 'tax_identifier', 'verification_status', 'version']);
      const text = JSON.stringify(home.json);
      for (const word of ['red_flag', 'lead', 'screening', 'risk', 'party_link', 'Cty Portal B']) expect(text).not.toContain(word);
      expect(home.json).toMatchObject({ reconfirmation: { state: expect.any(String), declaration_version: 'V1' }, actions: { respond: true, certificate: true, reconfirm: true, remediation: true } });
    });

    it('refuses staff on the portal, a guest on the staff side and a guest on the red flags', async () => {
      expect(await call('GET', '/portal/me', { member: ADMIN })).toMatchObject({ status: 403, json: { code: 'SCOPE_DENIED' } });
      const guestNoPermission = await call('GET', '/portal/me', { member: NOBODY });
      expect(guestNoPermission.status).toBe(403);
      for (const path of ['/vendor/portal/requests', '/vendor/reconfirmations', '/vendor/remediation-plans', '/vendor/disputes', '/vendor/ocds/parties']) expect([path, (await call('GET', path, { member: GUEST_A })).status]).toEqual([path, 403]);
      expect((await call('GET', '/red-flags', { member: GUEST_A })).status).toBe(403);
      expect((await call('GET', '/vendor/portal/requests', { member: NOBODY })).status).toBe(403);
    });

    it('does not show the requests of one tenant to another', async () => {
      const list = await call('GET', '/vendor/portal/requests', { member: B_ADMIN, tenantId: TENANT_B });
      expect(list.status).toBe(200);
      expect(list.json.items).toEqual([]);
    });

    it('takes a certificate from the contractor, shows it as not verified, and shows the evaluations list of its own', async () => {
      const put = await call('POST', '/portal/qualifications', { member: GUEST_A, body: { kind: 'TAX_CLEARANCE', certificate_no: 'TAX-PORTAL-1', issuer: 'Tax department', issued_on: '2026-10-01', expires_on: dayFromNow(200) } });
      expect(put).toMatchObject({ status: 200, json: { status: 'CREATED' } });
      const [audit] = await audits(put.json.resource_id as string, 'vnd.portal_qualification_submitted');
      expect(audit).toMatchObject({ actor_id: memberId(GUEST_A), safe_diff: { contractor_id: a, via: 'PORTAL' } });
      const list = await call('GET', '/portal/qualifications', { member: GUEST_A });
      expect((list.json.qualifications as Array<{ certificate_no: string; verified: boolean; state: string }>).find((item) => item.certificate_no === 'TAX-PORTAL-1')).toMatchObject({ verified: false, state: 'VALID' });
      const theirs = await call('GET', '/portal/qualifications', { member: GUEST_B });
      expect((theirs.json.qualifications as unknown[]).length).toBe(0);
      expect((await call('GET', '/portal/evaluations', { member: GUEST_A })).json).toMatchObject({ items: [] });
      expect((await call('POST', '/portal/qualifications', { member: GUEST_A, body: { kind: 'TAX_CLEARANCE', certificate_no: 'X', issuer: 'Tax department', issued_on: '2026-10-01', request_id: randomUUID() } })).status).toBe(404);
    });
  });

  describe('the re-confirmation', () => {
    it('refuses a declaration that is not in force, records the confirmation and moves the day', async () => {
      expect((await call('POST', '/portal/reconfirmation', { member: GUEST_A, body: { declaration_version: 'V0', accepted: true } })).json).toMatchObject({ code: 'RECONFIRMATION_DECLARATION_STALE' });
      expect((await call('POST', '/portal/reconfirmation', { member: GUEST_A, body: { declaration_version: 'V1', accepted: false } })).json).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'accepted' });
      const done = await call('POST', '/portal/reconfirmation', { member: GUEST_A, body: { declaration_version: 'V1', accepted: true, changes_note: 'The address did not change' } });
      expect(done).toMatchObject({ status: 200, json: { status: 'CONFIRMED' } });
      const [audit] = await audits(done.json.resource_id as string, 'vnd.reconfirmation_recorded');
      expect(audit).toMatchObject({ classification: 'CONFIDENTIAL', actor_id: memberId(GUEST_A), safe_diff: { contractor_id: a, declaration_version: 'V1' } });
      const home = await call('GET', '/portal/me', { member: GUEST_A });
      expect(home.json).toMatchObject({ reconfirmation: { state: 'CURRENT' } });
      const staff = await call('GET', '/vendor/reconfirmations', { member: ADMIN });
      expect(staff.status).toBe(200);
      expect((staff.json.items as Array<{ contractor_id: string; state: string }>).find((item) => item.contractor_id === a)?.state).toBe('CURRENT');
      expect((staff.json.items as Array<{ contractor_id: string; state: string }>).find((item) => item.contractor_id === b)?.state).toBe('NEVER');
      expect((await call('GET', '/vendor/reconfirmations?state=BAD', { member: ADMIN })).json).toMatchObject({ code: 'VALIDATION_FAILED' });
    });
  });

  describe('the plans of remediation', () => {
    it('runs from the proposal to the completion; another contractor finds nothing; a contractor cannot verify its own work', async () => {
      const proposed = await call('POST', `/vendor/contractors/${a}/remediation-plans`, {
        member: ADMIN,
        body: { title: 'Quality of the works', objective: 'Bring the defects down to zero', trigger_kind: 'POOR_EVALUATION', actions: [{ description: 'Repair the cracks', due_on: dayFromNow(20) }] },
      });
      expect(proposed).toMatchObject({ status: 200, json: { status: 'CREATED' } });
      const planId = proposed.json.resource_id as string;
      const detail = await call('GET', `/vendor/remediation-plans/${planId}`, { member: CHECKER });
      expect(detail.json).toMatchObject({ plan: { status: 'PROPOSED', action_count: 1 }, may_start: false, may_complete: false, may_close: true });
      const actionId = (detail.json.actions as Array<{ id: string }>)[0]?.id as string;

      expect((await call('POST', `/portal/remediation-plans/${planId}/agreement`, { member: GUEST_B, ifMatch: 1 })).status).toBe(404);
      expect(await call('POST', `/portal/remediation-plans/${planId}/agreement`, { member: GUEST_A, ifMatch: 1 })).toMatchObject({ status: 200, json: { status: 'AGREED', resource_version: 2 } });
      expect((await call('POST', `/portal/remediation-actions/${actionId}/done`, { member: GUEST_A, ifMatch: 1, body: { note: 'Done too early' } })).json).toMatchObject({ code: 'REMEDIATION_STATE_INVALID' });
      expect(await call('POST', `/vendor/remediation-plans/${planId}/start`, { member: CHECKER, ifMatch: 2 })).toMatchObject({ status: 200, json: { status: 'STARTED' } });
      expect((await call('POST', `/portal/remediation-actions/${actionId}/done`, { member: GUEST_B, ifMatch: 1, body: { note: 'Not mine' } })).status).toBe(404);
      expect(await call('POST', `/portal/remediation-actions/${actionId}/done`, { member: GUEST_A, ifMatch: 1, body: { note: 'The cracks were repaired' } })).toMatchObject({ status: 200, json: { status: 'DONE', resource_version: 2 } });
      expect((await call('POST', `/vendor/remediation-plans/${planId}/completion`, { member: ADMIN, ifMatch: 3 })).json).toMatchObject({ code: 'REMEDIATION_STATE_INVALID' });
      expect(await call('POST', `/vendor/remediation-actions/${actionId}/verification`, { member: CHECKER, ifMatch: 2, body: { outcome: 'VERIFIED', note: 'Checked on site' } })).toMatchObject({ status: 200, json: { status: 'VERIFIED' } });
      expect(await call('POST', `/vendor/remediation-plans/${planId}/completion`, { member: ADMIN, ifMatch: 3 })).toMatchObject({ status: 200, json: { status: 'COMPLETED' } });
      const mine = await call('GET', '/portal/remediation-plans', { member: GUEST_A });
      expect((mine.json.items as Array<{ id: string; status: string; actions: Array<{ status: string }> }>).find((item) => item.id === planId)).toMatchObject({ status: 'COMPLETED', actions: [{ status: 'VERIFIED' }] });
      expect(((await call('GET', '/portal/remediation-plans', { member: GUEST_B })).json.items as Array<{ id: string }>).some((item) => item.id === planId)).toBe(false);
      const [audit] = await audits(actionId, 'vnd.remediation_action_done');
      expect(audit).toMatchObject({ classification: 'CONFIDENTIAL', actor_id: memberId(GUEST_A) });
      expect(JSON.stringify((await events(actionId, 'vnd.remediation.changed.v1')).map((entry) => entry.payload))).not.toContain('cracks');
    });

    it('closes a plan with a reason and refuses the verification of an action that was not done', async () => {
      const proposed = await call('POST', `/vendor/contractors/${b}/remediation-plans`, {
        member: ADMIN,
        body: { title: 'A plan to close', objective: 'An objective of ten characters', trigger_kind: 'MANUAL', actions: [{ description: 'An action to drop', due_on: dayFromNow(20) }] },
      });
      const planId = proposed.json.resource_id as string;
      const actionId = ((await call('GET', `/vendor/remediation-plans/${planId}`, { member: ADMIN })).json.actions as Array<{ id: string }>)[0]?.id as string;
      expect((await call('POST', `/vendor/remediation-actions/${actionId}/verification`, { member: CHECKER, ifMatch: 1, body: { outcome: 'VERIFIED' } })).json).toMatchObject({ code: 'REMEDIATION_STATE_INVALID' });
      expect((await call('POST', `/vendor/remediation-plans/${planId}/closure`, { member: ADMIN, ifMatch: 1, body: { outcome: 'CANCELLED', reason: 'no' } })).json).toMatchObject({ code: 'VALIDATION_FAILED' });
      expect(await call('POST', `/vendor/remediation-plans/${planId}/closure`, { member: ADMIN, ifMatch: 1, body: { outcome: 'CANCELLED', reason: 'The evaluation was withdrawn' } })).toMatchObject({ status: 200, json: { status: 'CANCELLED' } });
      expect((await call('GET', `/vendor/remediation-plans?status=CANCELLED&contractor_id=${b}`, { member: ADMIN })).json.items).toHaveLength(1);
      expect((await call('POST', `/vendor/contractors/${a}/remediation-plans`, { member: ADMIN, body: { title: 'Too far', objective: 'An objective of ten characters', trigger_kind: 'MANUAL', actions: [{ description: 'Far away action', due_on: '2040-01-01' }] } })).json).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'due_on' });
    });
  });

  describe('the disputes and the export of parties', () => {
    it('answers the statistics without inventing a figure, and the export without owners or contact unless the rule says so', async () => {
      const disputes = await call('GET', '/vendor/disputes', { member: CHECKER });
      expect(disputes).toMatchObject({ status: 200, json: { stats: { total: 0, upheld_pct: null, mean_days_to_close: null }, portfolio: { total: 0 }, items: [] } });
      expect((await call('GET', '/vendor/disputes?contractor_id=not-a-uuid', { member: CHECKER })).json).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'contractor_id' });
      const parties = await call('GET', '/vendor/ocds/parties', { member: CHECKER });
      expect(parties).toMatchObject({ status: 200, json: { owners_included: false, contact_included: false, policy: { code: 'VENDOR_OCDS_EXPORT', unverified: true } } });
      expect(JSON.stringify(parties.json.parties)).not.toContain('beneficialOwners');
    });
  });
});
