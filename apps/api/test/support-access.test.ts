import { randomBytes, randomUUID } from 'node:crypto';
import { AuditWriter, EffectiveAccessStore, InMemoryAuthzCache, PLATFORM_TENANT_ID, seedSystemRoles } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { Client } from 'pg';
import { AppModule } from '../src/app.module';
import { JwksTokenVerifier } from '../src/auth/jwks-token-verifier';
import { SupportAccessJob } from '../src/modules/sas/support-access.job';
import { CLAIMS_HEADER, TENANT_HEADER } from './isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from './isolation/test-app';
import type { RunningApp } from './isolation/test-app';
import { CONTROL_AUDIENCE, IDENTITY_AUDIENCE, issuerKey, newIssuer } from './auth/auth-fixtures';
import { ProvisioningHarness } from './provisioning/provisioning-fixtures';

const SIGNING_KEY = randomBytes(32);
/** The Support Operator: a control principal, with no membership of any tenant. */
const OPERATOR = '00000000-0000-4000-8000-0000000000d1';
const REASON = 'The customer asked for it in the ticket.';

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

describe('controlled support access over HTTP (ST-SAS-015)', () => {
  const harness = new ProvisioningHarness();
  let app: RunningApp;
  let counter = 0;
  const issuer = newIssuer(issuerKey());
  const verifier = new JwksTokenVerifier({ issuer: 'https://idp.example', identityAudience: IDENTITY_AUDIENCE, controlAudience: CONTROL_AUDIENCE, jwks: { keyFor: () => Promise.resolve(undefined) }, tenantTokenKeys: async () => (await issuer.publicKeys()).keys, tenantIssuer: 'https://api.machvon.test' });

  const admin = async <T extends object = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> => harness.admin(async (client) => (await client.query(text, params)).rows as T[]);

  async function send(context: { tenantId: string; membershipId: string }, claims: Record<string, unknown>, method: string, path: string, options: { payload?: unknown; ifMatch?: number; key?: string } = {}): Promise<Reply> {
    const headers: Record<string, string> = {
      [TENANT_HEADER]: signTenantContext({ ...context, scopeVersion: 1 }, SIGNING_KEY),
      [CLAIMS_HEADER]: JSON.stringify(claims),
      'content-type': 'application/json',
    };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = `"${options.ifMatch}"`;
    const response = await fetch(`${app.baseUrl}${path}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.payload ?? {}) });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }

  /** The operator at the control plane. */
  const asOperator = (method: string, path: string, payload?: unknown) => send({ tenantId: PLATFORM_TENANT_ID, membershipId: OPERATOR }, { aud: 'control', roles: ['SupportOperator'] }, method, path, { payload });
  /** A member of a tenant. */
  const asMember = (tenantId: string, membershipId: string, method: string, path: string, options: { payload?: unknown; ifMatch?: number } = {}) => send({ tenantId, membershipId }, { aud: 'tenant' }, method, path, options);
  /** The operator with a support token: it names the grant, and the operator is the membership of the context. */
  const withGrant = (tenantId: string, grantId: string, method: string, path: string, payload?: unknown) => send({ tenantId, membershipId: OPERATOR }, { aud: 'tenant', support: { grantId } }, method, path, { payload });

  async function seedMember(owner: Client, tenantId: string, unitId: string, roleCode: string): Promise<string> {
    counter += 1;
    const membershipId = `00000000-0000-4000-8000-${(0xd000 + counter).toString(16).padStart(12, '0')}`;
    const userId = randomUUID();
    await owner.query("insert into machvon.user_account (id, idp_subject, email_normalized, display_name, status) values ($1, $2, $3, 'Member', 'Active')", [userId, `sub-${userId}`, `${userId}@example.test`]);
    await owner.query("insert into machvon.membership (tenant_id, id, user_id, organization_id, status, valid_from) values ($1, $2, $3, $4, 'Active', now())", [tenantId, membershipId, userId, unitId]);
    const role = await owner.query<{ id: string }>('select id from machvon.role_definition where code = $1', [roleCode]);
    await owner.query(
      `insert into machvon.role_grant (tenant_id, id, membership_id, role_id, scope_json, effective_from, scope_kind, scope_ref_ids, status, granted_by, grant_reason)
       values ($1, $2, $3, $4, '{"kind":"TENANT","ref_ids":[]}'::jsonb, '2026-01-01T00:00:00Z', 'TENANT', '{}', 'Active', $5, 'test')`,
      [tenantId, randomUUID(), membershipId, role.rows[0]?.id, OPERATOR],
    );
    return membershipId;
  }

  /** An Active tenant with its owner and one administrator, and a ticket the owner opened. */
  async function tenant(): Promise<{ tenantId: string; owner: string; adminMember: string; ticket: string }> {
    const created = await harness.request();
    const tenantId = created.tenantId;
    await harness.registry.transition(tenantId, 'Requested', 'Provisioning');
    await harness.registry.transition(tenantId, 'Provisioning', 'Active');
    await harness.tenants.withTenant({ tenantId, membershipId: OPERATOR, scopeVersion: 1 }, (tx) => seedSystemRoles(tx, OPERATOR));
    const client = new Client({ connectionString: harness.database.urlFor('machvon_owner') });
    await client.connect();
    try {
      await client.query("select set_config('app.tenant_id', $1, false)", [tenantId]);
      const unitId = randomUUID();
      await client.query("insert into machvon.organization_unit (tenant_id, id, code, name, valid_from, path, depth) values ($1, $2, 'U1', 'Unit 1', date '2026-01-01', '/u1/', 0)", [tenantId, unitId]);
      const owner = await seedMember(client, tenantId, unitId, 'TENANT_OWNER');
      const adminMember = await seedMember(client, tenantId, unitId, 'TENANT_ADMIN');
      const ticket = `SUP-2026-${String(800000 + counter)}`;
      await client.query(
        `insert into machvon.support_ticket (tenant_id, id, ticket_code, requester_membership_id, category, subject, description_ref, priority, status, sla_due_at)
         values ($1, gen_random_uuid(), $2, $3, 'DATA', 'Cannot open the list', 'ref', 'P3', 'Open', now() + interval '3 days')`,
        [tenantId, ticket, owner],
      );
      return { tenantId, owner, adminMember, ticket };
    } finally {
      await client.end();
    }
  }

  const ask = (tenantId: string, ticket: string, overrides: Record<string, unknown> = {}): Promise<Reply> =>
    asOperator('POST', '/support-access', { tenant_id: tenantId, ticket_reference: ticket, scope: { modules: ['PRJ'] }, access_mode: 'READ_ONLY', duration_minutes: 60, reason: REASON, ...overrides });
  const approve = (tenantId: string, member: string, grantId: string, ifMatch: number, decision = 'approve'): Promise<Reply> =>
    asMember(tenantId, member, 'POST', `/support-access/${grantId}/approve`, { payload: { decision, reason: REASON }, ifMatch });
  const auditOf = (tenantId: string, action: string): Promise<Array<{ outcome: string; impersonator_id: string | null; actor_id: string; resource_id: string }>> =>
    admin("select outcome, impersonator_id, actor_id, resource_id from machvon.audit_event where tenant_id = $1 and action = $2 order by occurred_at", [tenantId, action]);

  beforeAll(async () => {
    await harness.start();
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        AppModule.register({
          database: harness.tenants,
          registry: loadErrorRegistry(ERROR_CODES_PATH),
          policy: { database: harness.tenants, access: new EffectiveAccessStore(harness.tenants, new InMemoryAuthzCache()) },
          control: { database: harness.control, registry: harness.registry },
          supportIssuer: issuer,
        }),
      ],
    });
  }, 180_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  it('AC-ST-SAS-015-1 UAT-AC38: an operator without a grant is refused 403 SCOPE_DENIED with an audit row; once a grant is approved and used the read is 200 and audited with the impersonator', async () => {
    const t = await tenant();
    const refused = await asOperator('GET', '/project-pipeline');
    expect(refused.status).toBe(403);
    expect(refused.json).toMatchObject({ code: 'SCOPE_DENIED' });

    const requested = await ask(t.tenantId, t.ticket);
    expect(requested.status).toBe(201);
    expect(requested.json).toMatchObject({ status: 'REQUESTED', resource_version: 1 });
    const grantId = requested.json.resource_id as string;
    // Asked for, not given: the operator is still out.
    expect((await withGrant(t.tenantId, grantId, 'GET', '/project-pipeline')).status).toBe(403);

    const approved = await approve(t.tenantId, t.owner, grantId, 1);
    expect(approved.status).toBe(200);
    expect(approved.json).toMatchObject({ status: 'ACTIVE', resource_version: 2 });

    const used = await withGrant(t.tenantId, grantId, 'GET', '/project-pipeline');
    expect(used.status).toBe(200);
    const audits = await auditOf(t.tenantId, 'support_access.used');
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ outcome: 'SUCCESS', impersonator_id: OPERATOR, resource_id: grantId });
    expect((await auditOf(t.tenantId, 'authz.denied:listProjectPipeline')).some((row) => row.impersonator_id === OPERATOR && row.outcome === 'DENIED')).toBe(true);
  });

  it('AC-ST-SAS-015-2 UAT-AC169: a request for 600 minutes is 400, a write with one approver is refused 403, and the grant is Active once the second approver acts', async () => {
    const t = await tenant();
    const long = await ask(t.tenantId, t.ticket, { duration_minutes: 600 });
    expect(long.status).toBe(400);

    const requested = await ask(t.tenantId, t.ticket, { access_mode: 'READ_WRITE' });
    expect(requested.status).toBe(201);
    const grantId = requested.json.resource_id as string;
    const first = await approve(t.tenantId, t.owner, grantId, 1);
    expect(first.status).toBe(200);
    expect(first.json).toMatchObject({ status: 'REQUESTED', resource_version: 2 });
    // One approver: the write, and even the read, is refused.
    expect((await withGrant(t.tenantId, grantId, 'POST', `/explanation-requests/${randomUUID()}/response`, {})).status).toBe(403);
    expect((await withGrant(t.tenantId, grantId, 'GET', '/project-pipeline')).status).toBe(403);
    // The same person cannot be the second.
    const again = await approve(t.tenantId, t.owner, grantId, 2);
    expect(again.status).toBe(403);
    expect(again.json).toMatchObject({ code: 'SELF_APPROVAL_DENIED' });
    const second = await approve(t.tenantId, t.adminMember, grantId, 2);
    expect(second.status).toBe(200);
    expect(second.json).toMatchObject({ status: 'ACTIVE', resource_version: 3 });
    expect((await withGrant(t.tenantId, grantId, 'GET', '/project-pipeline')).status).toBe(200);
    // A write now reaches its handler (it is not refused at the door): the explanation request does not exist.
    const write = await withGrant(t.tenantId, grantId, 'POST', `/explanation-requests/${randomUUID()}/response`, {});
    expect(write.status).not.toBe(403);
  });

  it('AC-ST-SAS-015-3 UAT-AC125: an operator who holds only a ticket reads no tenant data: 403 SCOPE_DENIED', async () => {
    const t = await tenant();
    // The ticket is the condition, not the permission: the control token, a grant that was never asked for and a grant of another tenant all end at the same door.
    expect((await asOperator('GET', '/project-pipeline')).json).toMatchObject({ code: 'SCOPE_DENIED' });
    expect((await withGrant(t.tenantId, randomUUID(), 'GET', '/project-pipeline')).status).toBe(403);
    const other = await tenant();
    const grantOfOther = (await ask(other.tenantId, other.ticket)).json.resource_id as string;
    await approve(other.tenantId, other.owner, grantOfOther, 1);
    expect((await withGrant(t.tenantId, grantOfOther, 'GET', '/project-pipeline')).status).toBe(403);
    expect((await withGrant(other.tenantId, grantOfOther, 'GET', '/project-pipeline')).status).toBe(200);
  });

  it('keeps an operator inside the modules, the mode and the resources of the grant', async () => {
    const t = await tenant();
    const grantId = (await ask(t.tenantId, t.ticket, { scope: { modules: ['PRJ'] } })).json.resource_id as string;
    await approve(t.tenantId, t.owner, grantId, 1);
    expect((await withGrant(t.tenantId, grantId, 'GET', '/project-pipeline')).status).toBe(200);
    // Another module is out of reach, a write under a read-only grant is out of reach.
    expect((await withGrant(t.tenantId, grantId, 'GET', '/appropriations')).status).toBe(403);
    expect((await withGrant(t.tenantId, grantId, 'POST', `/explanation-requests/${randomUUID()}/response`, {})).status).toBe(403);
  });

  it('reaches the resources a grant names and no others, and not the lists that name none', async () => {
    const t = await tenant();
    const projectId = randomUUID();
    const grantId = (await ask(t.tenantId, t.ticket, { scope: { modules: ['PRJ'], resource_ids: [projectId] } })).json.resource_id as string;
    await approve(t.tenantId, t.owner, grantId, 1);
    // The project it names is reached (the handler answers; the door does not refuse), another project and the list are not.
    expect((await withGrant(t.tenantId, grantId, 'GET', `/projects/${projectId}/lifecycle`)).status).not.toBe(403);
    expect((await withGrant(t.tenantId, grantId, 'GET', `/projects/${randomUUID()}/lifecycle`)).status).toBe(403);
    expect((await withGrant(t.tenantId, grantId, 'GET', '/project-pipeline')).status).toBe(403);
  });

  it('is revoked by the tenant at once, once, and the operator is out on the next request', async () => {
    const t = await tenant();
    const grantId = (await ask(t.tenantId, t.ticket)).json.resource_id as string;
    await approve(t.tenantId, t.owner, grantId, 1);
    expect((await withGrant(t.tenantId, grantId, 'GET', '/project-pipeline')).status).toBe(200);
    const revoked = await asMember(t.tenantId, t.adminMember, 'POST', `/support-access/${grantId}/revoke`, { payload: { reason: 'The work is done.' }, ifMatch: 2 });
    expect(revoked.status).toBe(200);
    expect(revoked.json).toMatchObject({ status: 'REVOKED' });
    expect((await withGrant(t.tenantId, grantId, 'GET', '/project-pipeline')).status).toBe(403);
    const again = await asMember(t.tenantId, t.adminMember, 'POST', `/support-access/${grantId}/revoke`, { payload: { reason: 'Revoked a second time.' }, ifMatch: 3 });
    expect(again.status).toBe(409);
    expect(again.json).toMatchObject({ code: 'SUPPORT_GRANT_INVALID' });
  });

  it('ends a grant when its window ends: the lifecycle pass says Expired and the operator is out', async () => {
    const t = await tenant();
    const grantId = (await ask(t.tenantId, t.ticket)).json.resource_id as string;
    await approve(t.tenantId, t.owner, grantId, 1);
    await admin("alter table machvon.support_access_grant disable trigger support_access_grant_guard");
    await admin("update machvon.support_access_grant set starts_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' where id = $1", [grantId]);
    await admin("alter table machvon.support_access_grant enable trigger support_access_grant_guard");
    // The guard judges the window itself; the pass only makes the record say it.
    expect((await withGrant(t.tenantId, grantId, 'GET', '/project-pipeline')).status).toBe(403);
    const pass = await harness.tenants.withTenant({ tenantId: t.tenantId, membershipId: OPERATOR, scopeVersion: 1 }, (tx) => new SupportAccessJob(new AuditWriter(harness.tenants)).run(tx, OPERATOR, new Date()));
    expect(pass.expired).toEqual([grantId]);
    expect((await asMember(t.tenantId, t.owner, 'GET', `/resources/support_access_grant/${grantId}`)).json).toMatchObject({ status: 'Expired', in_force: false });
  });

  describe('the exchange of a grant for a support token', () => {
    const exchange = (tenantId: string, grantId: string, membershipId = OPERATOR, claims: Record<string, unknown> = { aud: 'control', roles: ['SupportOperator'] }) =>
      send({ tenantId: PLATFORM_TENANT_ID, membershipId }, claims, 'POST', `/support-access/${grantId}/token`, { payload: { tenant_id: tenantId } });

    it('gives the operator a token that ends with the grant and carries act=support, only once the grant is in force, and audits both the refusal and the issue', async () => {
      const t = await tenant();
      const grantId = (await ask(t.tenantId, t.ticket)).json.resource_id as string;
      const early = await exchange(t.tenantId, grantId);
      expect(early.status).toBe(403);
      expect(early.json).toMatchObject({ code: 'SCOPE_DENIED' });
      expect((await auditOf(t.tenantId, 'support_access.token_denied'))[0]).toMatchObject({ outcome: 'DENIED', impersonator_id: OPERATOR });
      await approve(t.tenantId, t.owner, grantId, 1);
      const issued = await exchange(t.tenantId, grantId);
      expect(issued.status).toBe(200);
      expect(issued.json).toMatchObject({ token_type: 'Bearer', grant_id: grantId });
      expect(issued.json.expires_in as number).toBeGreaterThan(0);
      expect(issued.json.expires_in as number).toBeLessThanOrEqual(300);
      const verified = await verifier.verifyTenantToken(issued.json.access_token as string);
      expect(verified).toMatchObject({ tenant: { tenantId: t.tenantId, membershipId: OPERATOR }, audience: 'tenant', mode: 'FULL', support: { grantId, operatorId: OPERATOR } });
      expect((await auditOf(t.tenantId, 'support_access.token_issued'))[0]).toMatchObject({ outcome: 'SUCCESS', impersonator_id: OPERATOR, resource_id: grantId });
    });

    it('is refused to another operator, for a grant of another tenant, after a revocation, and to anybody who is not on the control plane', async () => {
      const t = await tenant();
      const other = await tenant();
      const grantId = (await ask(t.tenantId, t.ticket)).json.resource_id as string;
      await approve(t.tenantId, t.owner, grantId, 1);
      expect((await exchange(t.tenantId, grantId, '00000000-0000-4000-8000-0000000000d2')).status).toBe(403);
      expect((await exchange(other.tenantId, grantId)).status).toBe(403);
      // A member of the tenant, and a control principal without the role of the operator, never reach the exchange.
      expect((await send({ tenantId: t.tenantId, membershipId: t.owner }, { aud: 'tenant' }, 'POST', `/support-access/${grantId}/token`, { payload: { tenant_id: t.tenantId } })).status).toBe(403);
      expect((await exchange(t.tenantId, grantId, OPERATOR, { aud: 'control', roles: ['BillingOperator'] })).status).toBe(403);
      expect((await exchange(t.tenantId, grantId)).status).toBe(200);
      await asMember(t.tenantId, t.owner, 'POST', `/support-access/${grantId}/revoke`, { payload: { reason: 'The work is done.' }, ifMatch: 2 });
      expect((await exchange(t.tenantId, grantId)).status).toBe(403);
      expect((await send({ tenantId: PLATFORM_TENANT_ID, membershipId: OPERATOR }, { aud: 'control', roles: ['SupportOperator'] }, 'POST', `/support-access/${grantId}/token`, { payload: { tenant_id: 'not-a-tenant' } })).status).toBeGreaterThanOrEqual(400);
    });

    it('does not keep the token anywhere a second call could replay it: the exchange has no idempotency record', async () => {
      const t = await tenant();
      const grantId = (await ask(t.tenantId, t.ticket)).json.resource_id as string;
      await approve(t.tenantId, t.owner, grantId, 1);
      const first = await exchange(t.tenantId, grantId);
      const second = await exchange(t.tenantId, grantId);
      expect(first.json.access_token).not.toBe(second.json.access_token);
      const stored = await admin<{ n: string }>("select count(*)::text as n from machvon.idempotency_record where operation = 'issueSupportAccessToken'");
      expect(stored[0]?.n).toBe('0');
    });
  });

  it('reaches the resource reads of the modules a grant names, and never the audit trail of the tenant', async () => {
    const t = await tenant();
    const grantId = (await ask(t.tenantId, t.ticket, { scope: { modules: ['PRJ', 'ADM'] } })).json.resource_id as string;
    await approve(t.tenantId, t.owner, grantId, 1);
    expect((await withGrant(t.tenantId, grantId, 'GET', '/resources/project')).status).toBe(200);
    expect((await withGrant(t.tenantId, grantId, 'GET', '/resources/organization_unit')).status).toBe(200);
    // The audit trail of the tenant is kept from every grant (no module owns it), and so is a module the grant does not name.
    expect((await withGrant(t.tenantId, grantId, 'GET', '/resources/audit_event')).status).toBe(403);
    expect((await withGrant(t.tenantId, grantId, 'GET', '/appropriations')).status).toBe(403);
  });

  it('never gives the audit trail of the tenant, to read or to export, even to a read-write grant of its module', async () => {
    const t = await tenant();
    const grantId = (await ask(t.tenantId, t.ticket, { access_mode: 'READ_WRITE', scope: { modules: ['ADM'] } })).json.resource_id as string;
    await approve(t.tenantId, t.owner, grantId, 1);
    await approve(t.tenantId, t.adminMember, grantId, 2);
    expect((await withGrant(t.tenantId, grantId, 'GET', '/resources/organization_unit')).status).toBe(200);
    expect((await withGrant(t.tenantId, grantId, 'POST', '/audit-exports', { from: '2026-01-01T00:00:00Z', to: '2026-02-01T00:00:00Z', format: 'JSONL' })).status).toBe(403);
    expect((await withGrant(t.tenantId, grantId, 'GET', '/resources/audit_event')).status).toBe(403);
    // Nor what reads across modules without asking each: the global search is not narrowed by the modules of a grant.
    expect((await withGrant(t.tenantId, grantId, 'GET', '/search?q=contract')).status).toBe(403);
    expect((await auditOf(t.tenantId, 'authz.denied:exportAuditLog'))[0]).toMatchObject({ outcome: 'DENIED', impersonator_id: OPERATOR });
  });

  describe('escalation probes (the operator cannot approve, extend or revoke their own access)', () => {
    it('refuses the control token and the support token at the doors of the tenant', async () => {
      const t = await tenant();
      const grantId = (await ask(t.tenantId, t.ticket)).json.resource_id as string;
      const asControl = await send({ tenantId: PLATFORM_TENANT_ID, membershipId: OPERATOR }, { aud: 'control', roles: ['SupportOperator', 'SystemAdmin'] }, 'POST', `/support-access/${grantId}/approve`, { payload: { decision: 'approve', reason: REASON }, ifMatch: 1 });
      expect(asControl.status).toBe(403);
      const asSupport = await withGrant(t.tenantId, grantId, 'POST', `/support-access/${grantId}/approve`, { decision: 'approve', reason: REASON });
      expect(asSupport.status).toBe(403);
      // Nor can the holder of a support token ask again for more.
      const extend = await send({ tenantId: t.tenantId, membershipId: OPERATOR }, { aud: 'tenant', support: { grantId } }, 'POST', '/support-access', { payload: { tenant_id: t.tenantId, ticket_reference: t.ticket, scope: { modules: ['PRJ'] }, access_mode: 'READ_ONLY', duration_minutes: 480, reason: REASON } });
      expect(extend.status).toBe(403);
      expect((await auditOf(t.tenantId, 'support_access.approved')).length).toBe(0);
    });

    it('refuses the request to every role of the platform but the Support Operator and the System Admin, and writes nothing', async () => {
      const t = await tenant();
      for (const roles of [['BillingOperator'], ['PlatformOperator']]) {
        const reply = await send({ tenantId: PLATFORM_TENANT_ID, membershipId: OPERATOR }, { aud: 'control', roles }, 'POST', '/support-access', { payload: { tenant_id: t.tenantId, ticket_reference: t.ticket, scope: { modules: ['PRJ'] }, access_mode: 'READ_ONLY', duration_minutes: 60, reason: REASON } });
        expect([reply.status, reply.json.code]).toEqual([403, 'SCOPE_DENIED']);
      }
      expect((await asMember(t.tenantId, t.owner, 'GET', '/resources/support_access_grant')).json.items).toEqual([]);
    });

    it('refuses a member of another tenant: the grant is not found', async () => {
      const t = await tenant();
      const other = await tenant();
      const grantId = (await ask(t.tenantId, t.ticket)).json.resource_id as string;
      expect((await approve(other.tenantId, other.owner, grantId, 1)).status).toBe(404);
      expect((await asMember(other.tenantId, other.owner, 'GET', `/resources/support_access_grant/${grantId}`)).status).toBe(404);
    });

    it('refuses an ordinary member, who does not hold the right to approve', async () => {
      const t = await tenant();
      const grantId = (await ask(t.tenantId, t.ticket)).json.resource_id as string;
      expect((await approve(t.tenantId, randomUUID(), grantId, 1)).status).toBe(403);
    });
  });

  it('needs a ticket of the tenant, and shows the tenant who asked, for what and until when', async () => {
    const t = await tenant();
    const missing = await ask(t.tenantId, 'SUP-2026-000000');
    expect(missing.status).toBe(404);
    expect(missing.json).toMatchObject({ code: 'TICKET_NOT_FOUND' });
    const grantId = (await ask(t.tenantId, t.ticket, { scope: { modules: ['PRJ', 'DOC'] } })).json.resource_id as string;
    const list = await asMember(t.tenantId, t.adminMember, 'GET', '/resources/support_access_grant');
    expect(list.status).toBe(200);
    expect((list.json.items as Array<Record<string, unknown>>)[0]).toMatchObject({ id: grantId, ticket_reference: t.ticket, operator_id: OPERATOR, status: 'Requested', access_mode: 'READ_ONLY', in_force: false, scope: { modules: ['PRJ', 'DOC'], resource_ids: [] }, version: 1 });
    const requested = await auditOf(t.tenantId, 'support_access.requested');
    expect(requested).toHaveLength(1);
    expect(requested[0]).toMatchObject({ actor_id: OPERATOR });
  });
});
