import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { AddressInfo } from 'node:net';
import { ControlDatabase, EffectiveAccessStore, InMemoryAuthzCache, UserSessionStore } from '@machvon/db';
import { seedSystemRoles } from '@machvon/db/src/system-roles';
import { loadErrorRegistry } from '@machvon/kernel';
import { Client, Pool } from 'pg';
import { AppModule } from '../src/app.module';
import { HttpJwksSource, discoverJwksUri } from '../src/auth/jwks-source';
import { JwksTokenVerifier } from '../src/auth/jwks-token-verifier';
import { INVITATION_MAILER } from '../src/modules/adm/invitation-mailer';
import type { MockInvitationMailer } from '../src/modules/adm/invitation-mailer';
import { createInvitationToken } from '../src/modules/adm/invitation-token';
import { UserSessionDenyList } from '../src/session/user-session-deny-list';
import { AuthzHarness, grantId, id, memberId, unitId } from '../../../packages/db/test/support/authz-fixtures';
import { CONTROL_AUDIENCE, IDENTITY_AUDIENCE, TENANT_ISSUER, controlClaims, identityClaims, issuerKey, newIssuer } from './auth/auth-fixtures';
import { OidcTestProvider, signJwt } from './auth/oidc-test-provider';
import type { ProviderKey } from './auth/oidc-test-provider';
import { ERROR_CODES_PATH } from './isolation/test-app';

// Several embedded databases, RSA keys and a full application: slow on a loaded machine.
jest.setTimeout(120_000);

const PLACEMENT = id(0x70, 1);
const T = id(0x71, 1);
const T_OTHER = id(0x71, 2);
const ACTOR = id(0x60, 99);

// People of tenant T: member n is user n, in the unit given.
const ADMIN = 1; // TENANT_ADMIN (rank 90) on the whole tenant
const UNIT_ADMIN = 2; // UNIT_ADMIN (rank 70) on the subtree of unit 2
const OWNER = 3; // the only TENANT_OWNER
const TARGET_A = 4; // Active, unit 2
const TARGET_B = 5; // Active, unit 3 (out of reach of UNIT_ADMIN)
const TARGET_C = 6; // Suspended, unit 2
const PEER = 7; // UNIT_ADMIN of unit 2, the same rank as UNIT_ADMIN
const TARGET_D = 8; // Active, unit 2
const LOCKED_USER = 9; // Active membership, account Locked
const OTHER_TENANT_MEMBER = 50; // a member of T_OTHER that tenant T does not have

const U1 = 1;
const U2 = 2;
const U3 = 3;

interface Reply {
  status: number;
  headers: Headers;
  json: Record<string, unknown>;
}

interface CallOptions {
  key?: string;
  ifMatch?: string;
}

describe('members and invitations (ST-ADM-006 backend)', () => {
  const harness = new AuthzHarness();
  let provider: OidcTestProvider;
  let key: ProviderKey;
  let controlPool: Pool;
  let app: INestApplication;
  let baseUrl: string;
  let mailer: MockInvitationMailer;
  let counter = 0;
  const roles = new Map<string, string>();
  const tokens = new Map<number, string>();
  const nowSeconds = (): number => Math.floor(Date.now() / 1000);
  const emailOf = (label: string): string => `${label}-${(counter += 1)}@invited.test`;

  const admin = async <R extends object = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<R[]> => {
    const client = new Client({ connectionString: harness.database.adminUrl });
    await client.connect();
    try {
      return (await client.query(text, params)).rows as R[];
    } finally {
      await client.end();
    }
  };

  function identityToken(options: { sub: string; email?: string; verified?: boolean; audience?: 'tenant' | 'control' }): string {
    const overrides = {
      sub: options.sub,
      sid: `idp-${(counter += 1)}-${randomUUID()}`,
      exp: nowSeconds() + 300,
      iat: nowSeconds() - 10,
      auth_time: nowSeconds() - 60,
      email: options.email,
      email_verified: options.verified ?? true,
    };
    return signJwt(key, options.audience === 'control' ? controlClaims(provider.issuer, overrides) : identityClaims(provider.issuer, overrides));
  }

  async function send(method: string, path: string, token: string | undefined, body: unknown, options: CallOptions = {}): Promise<Reply> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (token !== undefined) headers.authorization = `Bearer ${token}`;
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, headers: response.headers, json: (await response.json()) as Record<string, unknown> };
  }

  /** A tenant token of member n, made through the tenant selection like a real session. */
  async function login(n: number): Promise<string> {
    const cached = tokens.get(n);
    if (cached !== undefined) return cached;
    const reply = await send('POST', '/me/session/tenant-selection', identityToken({ sub: `sub-${n}` }), { tenant_id: T, membership_id: memberId(n) });
    expect(reply.status).toBe(200);
    const token = reply.json.access_token as string;
    tokens.set(n, token);
    return token;
  }

  async function as(n: number, method: string, path: string, body: unknown, options: CallOptions = {}): Promise<Reply> {
    return send(method, path, await login(n), body, options);
  }

  const invite = (n: number, body: Record<string, unknown>, options: CallOptions = {}): Promise<Reply> => as(n, 'POST', '/memberships/invitations', body, options);

  /** Invites a new person into unit 2 and returns what the invited person received. */
  async function invited(n = ADMIN, unit = U2): Promise<{ email: string; token: string; invitationId: string; membershipId: string }> {
    const email = emailOf('person');
    const reply = await invite(n, { email, organization_unit_id: unitId(unit) });
    expect(reply.status).toBe(201);
    const message = mailer.lastTo(email);
    if (message === undefined) throw new Error('no invitation was sent');
    return { email, token: message.token, invitationId: message.invitationId, membershipId: reply.json.resource_id as string };
  }

  const accept = (identity: string | undefined, invitationId: string, token: string, options: CallOptions = {}): Promise<Reply> =>
    send('POST', `/memberships/invitations/${invitationId}/accept`, identity, { token }, options);

  const membershipRow = async (membershipId: string): Promise<{ status: string; version: string; scope_version: string; ended_reason: string | null }> =>
    (await admin<{ status: string; version: string; scope_version: string; ended_reason: string | null }>(
      'select status, version::text as version, scope_version::text as scope_version, ended_reason from machvon.membership where id = $1',
      [membershipId],
    ))[0] as { status: string; version: string; scope_version: string; ended_reason: string | null };
  const versionOf = async (n: number): Promise<string> => `"${(await membershipRow(memberId(n))).version}"`;
  const countOf = async (text: string, params: unknown[] = []): Promise<number> => Number((await admin<{ n: string }>(text, params))[0]?.n);
  const audits = (action: string, outcome = 'SUCCESS'): Promise<number> =>
    countOf('select count(*) as n from machvon.audit_event where action = $1 and outcome = $2', [action, outcome]);
  const events = (type: string, aggregate?: string): Promise<number> =>
    countOf('select count(*) as n from machvon.outbox_event where type = $1 and ($2::text is null or aggregate_id = $2::uuid)', [type, aggregate ?? null]);

  async function giveRole(member: number, code: string, kind: string, refs: readonly string[] = []): Promise<void> {
    await harness.owner(T, [
      [
        `insert into machvon.role_grant (tenant_id, id, membership_id, role_id, scope_json, effective_from, scope_kind, scope_ref_ids, status, granted_by, grant_reason)
         values ($1, $2, $3, $4, $5::jsonb, '2026-01-01T00:00:00Z', $6, $7::uuid[], 'Active', $8, 'seed')`,
        [T, grantId(1000 + (counter += 1)), memberId(member), roles.get(code), JSON.stringify({ kind, ref_ids: refs }), kind, refs, ACTOR],
      ],
    ]);
  }

  /** Limits the licence to `seats` seats of staff by a new revision that is the latest. */
  async function limitSeats(seats: number | null, quota: Record<string, unknown> = {}): Promise<void> {
    await admin('delete from machvon.license_revision where tenant_id = $1', [T]);
    if (seats === null) return;
    const client = new Client({ connectionString: harness.database.adminUrl });
    await client.connect();
    try {
      await client.query('set session_replication_role = replica');
      await client.query(
        `insert into machvon.license_revision (tenant_id, id, serial, revision, entitlement_version_id, valid_from, valid_until, grace_until, status, signed_claims, key_id, seats, quota_json)
         values ($1, $2, $3, 1, $4, now() - interval '1 day', now() + interval '1 year', now() + interval '1 year 30 days', 'Active', 'claims', 'key-1', $5, $6::jsonb)`,
        [T, randomUUID(), `serial-${(counter += 1)}`, randomUUID(), seats, JSON.stringify(quota)],
      );
    } finally {
      await client.end();
    }
  }

  /** Puts the tenant on a plan with `quota` seats of staff (the quota of a downgrade), by a new entitlement version that is the latest. */
  async function limitPlanSeats(quota: number): Promise<void> {
    const [{ next } = { next: '1' }] = await admin<{ next: string }>('select (coalesce(max(version_no), 0) + 1)::text as next from machvon.entitlement_version where tenant_id = $1', [T]);
    const features = [{ featureCode: 'member.seats', limitKind: 'QUOTA', limitValue: quota, graceBehavior: 'READ_ONLY', expiredBehavior: 'DENY' }];
    await admin(
      `insert into machvon.entitlement_version (tenant_id, id, version_no, plan_version_id, features_json, entitlements_hash, cause, effective_from)
       values ($1, $2, $3, '00000000-0000-4000-9000-000000000001', $4::jsonb, $5, 'SUBSCRIPTION_CHANGE', now())`,
      [T, randomUUID(), Number(next), JSON.stringify(features), next.padStart(64, '0')],
    );
  }

  const clearPlan = (): Promise<unknown[]> => admin('delete from machvon.entitlement_version where tenant_id = $1', [T]);

  const activeStaff = (): Promise<number> => countOf("select count(*) as n from machvon.membership where tenant_id = $1 and status = 'Active' and membership_type = 'STAFF'", [T]);

  beforeAll(async () => {
    await harness.start();
    await admin("insert into machvon.placement (id, kind, region, db_cluster_ref, kms_key_ref, status) values ($1, 'POOL', 'vn-north', 'cluster-1', 'kms-1', 'Active')", [PLACEMENT]);
    const tenants: Array<[string, string]> = [
      [T, 'tenant-main'],
      [T_OTHER, 'tenant-other'],
    ];
    for (const [tenantId, code] of tenants) {
      await admin("insert into machvon.tenant (id, code, name, status, placement_id, region) values ($1, $2, $2, 'Active', $3, 'vn-north')", [tenantId, code, PLACEMENT]);
      await harness.seedUnits(tenantId, [
        { n: U1, path: `/${unitId(U1)}/` },
        { n: U2, path: `/${unitId(U1)}/${unitId(U2)}/`, parent: U1 },
        { n: U3, path: `/${unitId(U1)}/${unitId(U3)}/`, parent: U1 },
      ]);
      await harness.tenants.withTenant({ tenantId, membershipId: ACTOR, scopeVersion: 0 }, (tx) => seedSystemRoles(tx, ACTOR));
    }
    const members: Array<[number, number]> = [
      [ADMIN, U1],
      [UNIT_ADMIN, U2],
      [OWNER, U1],
      [TARGET_A, U2],
      [TARGET_B, U3],
      [PEER, U2],
      [TARGET_D, U2],
      [LOCKED_USER, U2],
    ];
    for (const [member, unit] of members) await harness.seedMembership(T, member, unit);
    await harness.seedMembership(T, TARGET_C, U2, { status: 'Suspended' });
    await harness.seedMembership(T_OTHER, OTHER_TENANT_MEMBER, U1);
    await admin("update machvon.user_account set status = 'Locked' where id = $1", [id(0x60, LOCKED_USER)]);
    for (const row of await admin<{ id: string; code: string }>('select id, code from machvon.role_definition where tenant_id = $1', [T])) roles.set(row.code, row.id);
    await giveRole(ADMIN, 'TENANT_ADMIN', 'TENANT');
    await giveRole(ADMIN, 'MEMBER', 'TENANT');
    await giveRole(UNIT_ADMIN, 'UNIT_ADMIN', 'UNIT_SUBTREE', [unitId(U2)]);
    await giveRole(UNIT_ADMIN, 'MEMBER', 'TENANT');
    await giveRole(OWNER, 'TENANT_OWNER', 'TENANT');
    await giveRole(OWNER, 'MEMBER', 'TENANT');
    await giveRole(PEER, 'UNIT_ADMIN', 'UNIT_SUBTREE', [unitId(U2)]);
    for (const member of [TARGET_A, TARGET_B, TARGET_C, TARGET_D]) await giveRole(member, 'MEMBER', 'TENANT');

    provider = await OidcTestProvider.start();
    key = provider.addKey('RS256');
    const signing = issuerKey();
    const issuer = newIssuer(signing);
    const jwks = new HttpJwksSource({ jwksUri: await discoverJwksUri(provider.issuer) });
    const verifier = new JwksTokenVerifier({
      issuer: provider.issuer,
      identityAudience: IDENTITY_AUDIENCE,
      controlAudience: CONTROL_AUDIENCE,
      jwks,
      tenantTokenKeys: async () => (await issuer.publicKeys()).keys,
      tenantIssuer: TENANT_ISSUER,
    });
    controlPool = new Pool({ connectionString: harness.database.urlFor('machvon_control'), max: 4 });
    controlPool.on('error', () => undefined);
    const sessions = new UserSessionStore(harness.tenants);
    const denyList = new UserSessionDenyList(sessions);
    const moduleRef = await Test.createTestingModule({
      imports: [
        AppModule.register({
          database: harness.tenants,
          registry: loadErrorRegistry(ERROR_CODES_PATH),
          auth: { verifier, denyList, controlAudience: CONTROL_AUDIENCE },
          policy: { database: harness.tenants, access: new EffectiveAccessStore(harness.tenants, new InMemoryAuthzCache()), denyList },
          session: { verifier, control: new ControlDatabase(controlPool), tenants: harness.tenants, sessions, issuer, denyList },
        }),
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.listen(0, '127.0.0.1');
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    mailer = app.get<MockInvitationMailer>(INVITATION_MAILER, { strict: false });
  });

  afterAll(async () => {
    await app?.close();
    await provider?.stop();
    await controlPool?.end();
    await harness.stop();
  });

  describe('inviteMember', () => {
    it('refuses an invitation when no seat is free (403 QUOTA_EXCEEDED), writes nothing, and invites once a seat is free (UAT-AC156)', async () => {
      const [staff, invitations, members] = [await activeStaff(), await countOf('select count(*) as n from machvon.membership_invitation where tenant_id = $1', [T]), await countOf('select count(*) as n from machvon.membership where tenant_id = $1', [T])];
      await limitSeats(staff);
      try {
        const refused = await invite(ADMIN, { email: emailOf('no-seat'), organization_unit_id: unitId(U2) });
        expect([refused.status, refused.json.code]).toEqual([403, 'QUOTA_EXCEEDED']);
        expect(await countOf('select count(*) as n from machvon.membership_invitation where tenant_id = $1', [T])).toBe(invitations);
        expect(await countOf('select count(*) as n from machvon.membership where tenant_id = $1', [T])).toBe(members);
        expect(await activeStaff()).toBe(staff);
        await limitSeats(staff + 1);
        expect((await invite(ADMIN, { email: emailOf('seat-free'), organization_unit_id: unitId(U2) })).status).toBe(201);
      } finally {
        await limitSeats(null);
      }
    });

    it('refuses an invitation after a plan downgrade below the seats in use, and leaves every member as they were (AC-ST-SAS-010-2)', async () => {
      const staff = await activeStaff();
      await limitPlanSeats(staff - 1);
      try {
        const refused = await invite(ADMIN, { email: emailOf('downgraded'), organization_unit_id: unitId(U2) });
        expect([refused.status, refused.json.code]).toEqual([403, 'QUOTA_EXCEEDED']);
        expect(await activeStaff()).toBe(staff);
        // The members the plan no longer covers keep working: nobody is taken away and no data is touched.
        const session = await send('POST', '/me/session/tenant-selection', identityToken({ sub: `sub-${TARGET_A}` }), { tenant_id: T, membership_id: memberId(TARGET_A) });
        expect(session.status).toBe(200);
        expect((await membershipRow(memberId(TARGET_A))).status).toBe('Active');
        await limitPlanSeats(staff + 1);
        expect((await invite(ADMIN, { email: emailOf('upgraded'), organization_unit_id: unitId(U2) })).status).toBe(201);
      } finally {
        await clearPlan();
      }
    });

    it('creates an Invited membership with the default role and sends the token only to the person', async () => {
      const email = emailOf('first');
      const before = await events('iam.membership.invited.v1');
      const reply = await invite(ADMIN, { email, display_name: 'First Person', organization_unit_id: unitId(U2) });
      expect(reply.status).toBe(201);
      expect(reply.json).toMatchObject({ status: 'INVITED', resource_version: 1 });
      const membershipId = reply.json.resource_id as string;

      expect((await membershipRow(membershipId)).status).toBe('Invited');
      const account = await admin<{ idp_subject: string; display_name: string; email_normalized: string }>(
        'select idp_subject, display_name, email_normalized from machvon.user_account where email_normalized = $1',
        [email],
      );
      expect(account).toHaveLength(1);
      expect(account[0]?.idp_subject).toMatch(/^invitation:/);
      expect(account[0]?.display_name).toBe('First Person');

      const message = mailer.lastTo(email);
      expect(message?.tenantId).toBe(T);
      const invitation = await admin<{ token_hash: string; email_hash: string; status: string; expires_at: Date }>(
        'select token_hash, email_hash, status, expires_at from machvon.membership_invitation where id = $1',
        [message?.invitationId],
      );
      expect(invitation[0]?.status).toBe('Pending');
      expect(invitation[0]?.token_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(invitation[0]?.token_hash).not.toBe(message?.token);
      const days = ((invitation[0]?.expires_at.getTime() ?? 0) - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(6.9);
      expect(days).toBeLessThan(7.1);

      const grants = await admin<{ code: string; scope_kind: string }>(
        'select r.code, g.scope_kind from machvon.role_grant g join machvon.role_definition r on r.id = g.role_id where g.membership_id = $1',
        [membershipId],
      );
      expect(grants).toEqual([{ code: 'MEMBER', scope_kind: 'UNIT_ONLY' }]);
      expect(await events('iam.membership.invited.v1')).toBe(before + 1);
      expect(await audits('membership.invite')).toBeGreaterThanOrEqual(1);
    });

    it('keeps the email and the token out of the audit trail and the outbox', async () => {
      const { email, token, invitationId } = await invited();
      const audit = await admin<{ text: string }>("select row_to_json(a)::text as text from machvon.audit_event a where action = 'membership.invite' order by seq desc limit 1");
      const outbox = await admin<{ text: string }>("select row_to_json(o)::text as text from machvon.outbox_event o where type = 'iam.membership.invited.v1' order by created_at desc limit 1");
      for (const row of [audit[0]?.text ?? '', outbox[0]?.text ?? '']) {
        expect(row).not.toContain(email);
        expect(row).not.toContain(token);
        expect(row).not.toContain(token.split('.')[1] ?? 'x');
      }
      expect(invitationId).toBeDefined();
    });

    it('replays the stored answer for the same key and body, without a second invitation or message', async () => {
      const email = emailOf('replay');
      const body = { email, organization_unit_id: unitId(U2) };
      const first = await invite(ADMIN, body, { key: 'replay-key-0123456789' });
      const sent = mailer.sent.length;
      const second = await invite(ADMIN, body, { key: 'replay-key-0123456789' });
      expect(second.status).toBe(201);
      expect(second.headers.get('idempotency-replayed')).toBe('true');
      expect(second.json.resource_id).toBe(first.json.resource_id);
      expect(mailer.sent).toHaveLength(sent);
      const conflict = await invite(ADMIN, { ...body, display_name: 'Someone Else' }, { key: 'replay-key-0123456789' });
      expect(conflict.status).toBe(409);
      expect(conflict.json.code).toBe('IDEMPOTENCY_CONFLICT');
    });

    it('is bound by the scope of the inviter: a unit admin invites inside their subtree only, with a DENIED audit row', async () => {
      const before = await audits('command.denied:inviteMember', 'DENIED');
      const outside = await invite(UNIT_ADMIN, { email: emailOf('outside'), organization_unit_id: unitId(U3) });
      expect(outside.status).toBe(403);
      expect(outside.json.code).toBe('SCOPE_DENIED');
      expect(await audits('command.denied:inviteMember', 'DENIED')).toBe(before + 1);
      const inside = await invite(UNIT_ADMIN, { email: emailOf('inside'), organization_unit_id: unitId(U2) });
      expect(inside.status).toBe(201);
    });

    it('refuses a member without the permission with 403 SCOPE_DENIED', async () => {
      const reply = await invite(TARGET_A, { email: emailOf('nobody'), organization_unit_id: unitId(U2) });
      expect(reply.status).toBe(403);
      expect(reply.json.code).toBe('SCOPE_DENIED');
    });

    it('applies the anti-escalation rules to the initial grants and leaves nothing behind when one is refused', async () => {
      const email = emailOf('escalation');
      const accounts = await countOf('select count(*) as n from machvon.user_account');
      const members = await countOf('select count(*) as n from machvon.membership where tenant_id = $1', [T]);
      const refused = await invite(ADMIN, {
        email,
        organization_unit_id: unitId(U2),
        initial_grants: [{ role_id: roles.get('TENANT_ADMIN'), scope_kind: 'TENANT' }],
      });
      expect(refused.status).toBe(403);
      expect(refused.json.code).toBe('ROLE_ESCALATION_DENIED');
      expect(await countOf('select count(*) as n from machvon.user_account')).toBe(accounts);
      expect(await countOf('select count(*) as n from machvon.membership where tenant_id = $1', [T])).toBe(members);
      expect(mailer.lastTo(email)).toBeUndefined();

      const allowed = await invite(ADMIN, {
        email,
        organization_unit_id: unitId(U2),
        initial_grants: [{ role_id: roles.get('UNIT_ADMIN'), scope_kind: 'UNIT_SUBTREE', scope_ref_ids: [unitId(U2)] }],
      });
      expect(allowed.status).toBe(201);
      const granted = await admin<{ code: string }>(
        'select r.code from machvon.role_grant g join machvon.role_definition r on r.id = g.role_id where g.membership_id = $1',
        [allowed.json.resource_id],
      );
      expect(granted).toEqual([{ code: 'UNIT_ADMIN' }]);
    });

    it.each([
      ['an unknown role', (): Record<string, unknown> => ({ role_id: randomUUID(), scope_kind: 'TENANT' }), 404, 'RESOURCE_NOT_FOUND'],
      ['a scope that names no unit', (): Record<string, unknown> => ({ role_id: roles.get('MEMBER'), scope_kind: 'UNIT_ONLY', scope_ref_ids: [randomUUID()] }), 422, 'VALIDATION_FAILED'],
    ])('refuses an initial grant with %s', async (_label, grant, status, code) => {
      const reply = await invite(ADMIN, { email: emailOf('bad-grant'), organization_unit_id: unitId(U2), initial_grants: [grant()] });
      expect(reply.status).toBe(status);
      expect(reply.json.code).toBe(code);
    });

    it('refuses a retired role', async () => {
      await admin("update machvon.role_definition set status = 'Retired' where tenant_id = $1 and code = 'SPECIALIST'", [T]);
      try {
        const reply = await invite(ADMIN, { email: emailOf('retired'), organization_unit_id: unitId(U2), initial_grants: [{ role_id: roles.get('SPECIALIST'), scope_kind: 'TENANT' }] });
        expect(reply.status).toBe(422);
      } finally {
        await admin("update machvon.role_definition set status = 'Active' where tenant_id = $1 and code = 'SPECIALIST'", [T]);
      }
    });

    it('refuses an unknown unit with 404, an unusable unit and a validity in the past with 422', async () => {
      const unknown = await invite(ADMIN, { email: emailOf('unit'), organization_unit_id: randomUUID() });
      expect(unknown.status).toBe(404);
      await admin("update machvon.organization_unit set status = 'Dissolved' where tenant_id = $1 and id = $2", [T, unitId(U3)]);
      try {
        const inactive = await invite(ADMIN, { email: emailOf('unit'), organization_unit_id: unitId(U3) });
        expect(inactive.status).toBe(422);
        expect(inactive.json.detail).toBe('organization_unit_id');
      } finally {
        await admin("update machvon.organization_unit set status = 'Active' where tenant_id = $1 and id = $2", [T, unitId(U3)]);
      }
      const past = await invite(ADMIN, { email: emailOf('past'), organization_unit_id: unitId(U2), valid_until: '2020-01-01T00:00:00Z' });
      expect(past.status).toBe(422);
      expect(past.json.detail).toBe('valid_until');
    });

    it('validates the body: a missing email is 400, an unknown field is 400 FIELD_NOT_ALLOWED', async () => {
      expect((await invite(ADMIN, { organization_unit_id: unitId(U2) })).status).toBe(400);
      const extra = await invite(ADMIN, { email: emailOf('extra'), organization_unit_id: unitId(U2), role: 'x' });
      expect(extra.status).toBe(400);
      expect(extra.json.code).toBe('FIELD_NOT_ALLOWED');
    });

    it('invites a person again once the earlier invitation ran out unopened, and not while it is open', async () => {
      const { email, invitationId, membershipId } = await invited();
      expect((await invite(ADMIN, { email, organization_unit_id: unitId(U2) })).status).toBe(409);
      await admin("update machvon.membership_invitation set expires_at = now() - interval '1 minute' where id = $1", [invitationId]);
      const again = await invite(ADMIN, { email, organization_unit_id: unitId(U2) });
      expect(again.status).toBe(201);
      expect(again.json.resource_id).not.toBe(membershipId);
      expect((await membershipRow(membershipId)).status).toBe('Expired');
    });

    it('refuses a second live membership of the same person in the unit with 409 MEMBERSHIP_EXISTS, and reuses an existing account', async () => {
      const { email } = await invited();
      const again = await invite(ADMIN, { email: ` ${email.toUpperCase()} `, organization_unit_id: unitId(U2) });
      expect(again.status).toBe(409);
      expect(again.json.code).toBe('MEMBERSHIP_EXISTS');
      expect(await countOf('select count(*) as n from machvon.user_account where email_normalized = $1', [email])).toBe(1);

      const known = await invite(ADMIN, { email: 'USER4@example.test', organization_unit_id: unitId(U3) });
      expect(known.status).toBe(201);
      const row = await admin<{ user_id: string }>('select user_id from machvon.membership where id = $1', [known.json.resource_id]);
      expect(row[0]?.user_id).toBe(id(0x60, TARGET_A));
    });

    it('stores the validity of the membership when one is asked for', async () => {
      const validUntil = new Date(Date.now() + 30 * 86_400_000).toISOString();
      const reply = await invite(ADMIN, { email: emailOf('valid'), organization_unit_id: unitId(U2), valid_until: validUntil });
      expect(reply.status).toBe(201);
      const row = await admin<{ valid_until: Date }>('select valid_until from machvon.membership where id = $1', [reply.json.resource_id]);
      expect(row[0]?.valid_until.toISOString()).toBe(validUntil);
    });
  });

  describe('acceptInvitation', () => {
    it('activates the membership, binds the identity and answers with the session of the new member', async () => {
      const { email, token, invitationId, membershipId } = await invited();
      const before = await events('iam.membership.activated.v1');
      const sv = Number((await membershipRow(membershipId)).scope_version);
      const reply = await accept(identityToken({ sub: `sub-new-${email}`, email }), invitationId, token);
      expect(reply.status).toBe(200);
      expect(reply.json).toMatchObject({ tenant_id: T, membership_id: membershipId, mode: 'FULL', token_type: 'Bearer' });
      const claims = JSON.parse(Buffer.from((reply.json.access_token as string).split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;
      expect(claims).toMatchObject({ tid: T, mid: membershipId });

      const row = await membershipRow(membershipId);
      expect(row.status).toBe('Active');
      expect(Number(row.scope_version)).toBe(sv + 1);
      expect((await admin<{ status: string }>('select status from machvon.membership_invitation where id = $1', [invitationId]))[0]?.status).toBe('Accepted');
      expect((await admin<{ idp_subject: string }>('select idp_subject from machvon.user_account where email_normalized = $1', [email]))[0]?.idp_subject).toBe(`sub-new-${email}`);
      expect(await events('iam.membership.activated.v1', membershipId)).toBe(1);
      expect(await events('iam.membership.activated.v1')).toBe(before + 1);
      expect(await countOf("select count(*) as n from machvon.audit_event where action = 'membership.invitation_accepted' and resource_id = $1", [membershipId])).toBe(1);
      expect(await countOf('select count(*) as n from machvon.user_session where membership_id = $1 and revoked_at is null', [membershipId])).toBe(1);
    });

    it('replays the same session answer for the same key, with one activation', async () => {
      const { email, token, invitationId, membershipId } = await invited();
      const identity = identityToken({ sub: `sub-new-${email}`, email });
      const first = await accept(identity, invitationId, token, { key: 'accept-key-0123456789' });
      const second = await accept(identity, invitationId, token, { key: 'accept-key-0123456789' });
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(second.headers.get('idempotency-replayed')).toBe('true');
      expect(second.json.membership_id).toBe(first.json.membership_id);
      expect(await events('iam.membership.activated.v1', membershipId)).toBe(1);
    });

    it('is single use: a second acceptance with another key is 409 INVITATION_EXPIRED', async () => {
      const { email, token, invitationId } = await invited();
      const identity = identityToken({ sub: `sub-new-${email}`, email });
      expect((await accept(identity, invitationId, token)).status).toBe(200);
      const again = await accept(identity, invitationId, token);
      expect(again.status).toBe(409);
      expect(again.json.code).toBe('INVITATION_EXPIRED');
    });

    it('lets exactly one of two concurrent acceptances through', async () => {
      const { email, token, invitationId, membershipId } = await invited();
      const identity = identityToken({ sub: `sub-new-${email}`, email });
      const replies = await Promise.all([accept(identity, invitationId, token), accept(identity, invitationId, token)]);
      expect(replies.map((reply) => reply.status).sort()).toEqual([200, 409]);
      expect(await events('iam.membership.activated.v1', membershipId)).toBe(1);
    });

    it('answers the same 404 for an unknown invitation, a wrong secret, a token of another shape and a token of another tenant', async () => {
      const { email, token, invitationId } = await invited();
      const identity = identityToken({ sub: `sub-new-${email}`, email });
      const wrongSecret = createInvitationToken(T).token;
      const otherTenant = createInvitationToken(T_OTHER).token;
      const replies = [
        await accept(identity, invitationId, wrongSecret),
        await accept(identity, randomUUID(), token),
        await accept(identity, invitationId, 'x'.repeat(40)),
        await accept(identity, invitationId, otherTenant),
        await accept(identity, invitationId, token.replace('.', '-')),
      ];
      const strip = (json: Record<string, unknown>): Record<string, unknown> => ({ ...json, correlationId: 'x', correlation_id: 'x', instance: 'x' });
      for (const reply of replies) {
        expect(reply.status).toBe(404);
        expect(reply.json.code).toBe('RESOURCE_NOT_FOUND');
        expect(strip(reply.json)).toEqual(strip(replies[0]?.json ?? {}));
      }
      // The invitation is still usable afterwards: nothing above spent it.
      expect((await accept(identity, invitationId, token)).status).toBe(200);
    });

    it('refuses a token shorter than the contract allows as a validation error', async () => {
      const { email, invitationId } = await invited();
      const reply = await accept(identityToken({ sub: 'sub-short', email }), invitationId, 'short');
      expect(reply.status).toBe(422);
    });

    it('refuses an email that is not the invited one, or not verified, and leaves the invitation open (AC-ST-ADM-006-2)', async () => {
      const { email, token, invitationId, membershipId } = await invited();
      const stranger = await accept(identityToken({ sub: 'sub-stranger', email: 'stranger@example.test' }), invitationId, token);
      expect(stranger.status).toBe(403);
      expect(stranger.json.code).toBe('INVITATION_EMAIL_MISMATCH');
      const unverified = await accept(identityToken({ sub: `sub-unverified-${email}`, email, verified: false }), invitationId, token);
      expect(unverified.status).toBe(403);
      expect(unverified.json.code).toBe('INVITATION_EMAIL_MISMATCH');
      const withoutEmail = await accept(identityToken({ sub: 'sub-no-email' }), invitationId, token);
      expect(withoutEmail.json.code).toBe('INVITATION_EMAIL_MISMATCH');
      expect((await membershipRow(membershipId)).status).toBe('Invited');
      expect((await admin<{ idp_subject: string }>('select idp_subject from machvon.user_account where email_normalized = $1', [email]))[0]?.idp_subject).toMatch(/^invitation:/);
      expect((await accept(identityToken({ sub: `sub-ok-${email}`, email: email.toUpperCase() }), invitationId, token)).status).toBe(200);
    });

    it('refuses an identity that already belongs to another account, or an account that belongs to another identity', async () => {
      const first = await invited();
      const taken = await accept(identityToken({ sub: 'sub-1', email: first.email }), first.invitationId, first.token);
      expect(taken.status).toBe(403);
      expect(taken.json.code).toBe('INVITATION_EMAIL_MISMATCH');

      const known = await invite(ADMIN, { email: 'user5@example.test', organization_unit_id: unitId(U2) });
      expect(known.status).toBe(201);
      const message = mailer.lastTo('user5@example.test');
      const hijack = await accept(identityToken({ sub: 'sub-hijack', email: 'user5@example.test' }), message?.invitationId ?? '', message?.token ?? '');
      expect(hijack.status).toBe(403);
      expect(hijack.json.code).toBe('INVITATION_EMAIL_MISMATCH');
      const own = await accept(identityToken({ sub: 'sub-5', email: 'user5@example.test' }), message?.invitationId ?? '', message?.token ?? '');
      expect(own.status).toBe(200);
    });

    it('refuses a locked account', async () => {
      const reply = await invite(ADMIN, { email: `user${LOCKED_USER}@example.test`, organization_unit_id: unitId(U3) });
      expect(reply.status).toBe(201);
      const message = mailer.lastTo(`user${LOCKED_USER}@example.test`);
      const refused = await accept(identityToken({ sub: `sub-${LOCKED_USER}`, email: message?.toEmail }), message?.invitationId ?? '', message?.token ?? '');
      expect(refused.status).toBe(403);
      expect(refused.json.code).toBe('MEMBERSHIP_INACTIVE');
    });

    it('expires an invitation that ran out: 409 INVITATION_EXPIRED, invitation and membership Expired, and the person can be invited again (AC-ST-ADM-006-2)', async () => {
      const { email, token, invitationId, membershipId } = await invited();
      await admin("update machvon.membership_invitation set expires_at = now() - interval '1 second' where id = $1", [invitationId]);
      const identity = identityToken({ sub: `sub-new-${email}`, email });
      const reply = await accept(identity, invitationId, token, { key: 'expired-key-0123456789' });
      expect(reply.status).toBe(409);
      expect(reply.json.code).toBe('INVITATION_EXPIRED');
      expect((await admin<{ status: string }>('select status from machvon.membership_invitation where id = $1', [invitationId]))[0]?.status).toBe('Expired');
      expect((await membershipRow(membershipId)).status).toBe('Expired');
      const replay = await accept(identity, invitationId, token, { key: 'expired-key-0123456789' });
      expect(replay.status).toBe(409);
      expect(replay.headers.get('idempotency-replayed')).toBe('true');
      expect((await invite(ADMIN, { email, organization_unit_id: unitId(U2) })).status).toBe(201);
    });

    it('judges the account again on a replay: an account locked after the acceptance gets no session from the stored answer', async () => {
      const { email, token, invitationId, membershipId } = await invited();
      const identity = identityToken({ sub: `sub-new-${email}`, email });
      expect((await accept(identity, invitationId, token, { key: 'accept-locked-0123456789' })).status).toBe(200);
      const account = (await admin<{ user_id: string }>('select user_id from machvon.membership where id = $1', [membershipId]))[0]?.user_id;
      await admin("update machvon.user_account set status = 'Locked' where id = $1", [account]);
      const replay = await accept(identity, invitationId, token, { key: 'accept-locked-0123456789' });
      expect([replay.status, replay.json.code]).toEqual([403, 'MEMBERSHIP_INACTIVE']);
      expect(replay.json.access_token).toBeUndefined();
    });

    describe('in a tenant that is suspended', () => {
      const suspend = (reason: string | null): Promise<unknown> => admin("update machvon.tenant set status = 'Suspended', lifecycle_reason = $2 where id = $1", [T, reason]);
      const reinstate = (): Promise<unknown> => admin("update machvon.tenant set status = 'Active', lifecycle_reason = null where id = $1", [T]);

      it.each([
        ['read-only', null],
        ['security incident', 'SECURITY_INCIDENT'],
      ])('refuses the acceptance (%s), keeps the invitation open, and accepts with the same key once the tenant is reinstated', async (_name, reason) => {
        const { email, token, invitationId, membershipId } = await invited();
        const identity = identityToken({ sub: `sub-new-${email}`, email });
        await suspend(reason);
        try {
          const refused = await accept(identity, invitationId, token, { key: `accept-suspended-${reason ?? 'ro'}-0123456789` });
          expect([refused.status, refused.json.code]).toEqual([403, 'TENANT_SUSPENDED']);
          expect((await membershipRow(membershipId)).status).toBe('Invited');
          expect((await admin<{ status: string }>('select status from machvon.membership_invitation where id = $1', [invitationId]))[0]?.status).toBe('Pending');
        } finally {
          await reinstate();
        }
        const accepted = await accept(identity, invitationId, token, { key: `accept-suspended-${reason ?? 'ro'}-0123456789` });
        expect(accepted.status).toBe(200);
        expect((await membershipRow(membershipId)).status).toBe('Active');
      });
    });

    it('ends a membership whose own validity ran out before it was accepted, without taking a seat, and the person can be invited again', async () => {
      const { email, token, invitationId, membershipId } = await invited();
      await admin("update machvon.membership set valid_from = now() - interval '2 days', valid_until = now() - interval '1 second' where id = $1", [membershipId]);
      const seats = await countOf("select count(*) as n from machvon.membership where tenant_id = $1 and status = 'Active'", [T]);
      const refused = await accept(identityToken({ sub: `sub-new-${email}`, email }), invitationId, token);
      expect([refused.status, refused.json.code]).toEqual([409, 'INVITATION_EXPIRED']);
      expect((await membershipRow(membershipId)).status).toBe('Expired');
      expect((await admin<{ status: string }>('select status from machvon.membership_invitation where id = $1', [invitationId]))[0]?.status).toBe('Expired');
      expect(await countOf("select count(*) as n from machvon.membership where tenant_id = $1 and status = 'Active'", [T])).toBe(seats);
      expect((await invite(ADMIN, { email, organization_unit_id: unitId(U2) })).status).toBe(201);
    });

    it('waits for the membership before it locks the invitation, the order in which the lifecycle commands lock them', async () => {
      const { email, token, invitationId, membershipId } = await invited();
      const holder = new Client({ connectionString: harness.database.adminUrl });
      const probe = new Client({ connectionString: harness.database.adminUrl });
      await holder.connect();
      await probe.connect();
      let pending: Promise<Reply> | undefined;
      try {
        // Another command holds the membership, as endMembership does before it revokes the invitations.
        await holder.query('begin');
        await holder.query('select id from machvon.membership where id = $1 for update', [membershipId]);
        pending = accept(identityToken({ sub: `sub-new-${email}`, email }), invitationId, token);
        // Wait until the acceptance is blocked on a lock; it must not hold the invitation meanwhile.
        for (let waited = 0; waited < 100; waited += 1) {
          const blocked = await probe.query("select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()");
          if (Number((blocked.rows[0] as { n: number }).n) > 0) break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        await probe.query('begin');
        await expect(probe.query('select id from machvon.membership_invitation where id = $1 for update nowait', [invitationId])).resolves.toMatchObject({ rowCount: 1 });
        await probe.query('rollback');
      } finally {
        await holder.query('rollback');
        await holder.end();
        await probe.end();
      }
      expect((await pending)?.status).toBe(200);
    });

    it('stays accepted just before the expiry', async () => {
      const { email, token, invitationId } = await invited();
      await admin("update machvon.membership_invitation set expires_at = now() + interval '1 minute' where id = $1", [invitationId]);
      expect((await accept(identityToken({ sub: `sub-new-${email}`, email }), invitationId, token)).status).toBe(200);
    });

    it('refuses when no seat is left (403 QUOTA_EXCEEDED), keeps the invitation open, and accepts once a seat is free (AC-ST-ADM-006-4)', async () => {
      const { email, token, invitationId, membershipId } = await invited();
      await limitSeats(await activeStaff());
      try {
        const identity = identityToken({ sub: `sub-new-${email}`, email });
        const refused = await accept(identity, invitationId, token);
        expect(refused.status).toBe(403);
        expect(refused.json.code).toBe('QUOTA_EXCEEDED');
        expect((await membershipRow(membershipId)).status).toBe('Invited');
        expect((await admin<{ status: string }>('select status from machvon.membership_invitation where id = $1', [invitationId]))[0]?.status).toBe('Pending');
        await limitSeats((await activeStaff()) + 1);
        expect((await accept(identity, invitationId, token)).status).toBe(200);
      } finally {
        await limitSeats(null);
      }
    });

    it('counts guest seats apart: a licence with no guest seats left does not hold back staff (AC-ST-ADM-006-4)', async () => {
      const { email, token, invitationId } = await invited();
      await limitSeats(1000, { guest_seats: 0 });
      try {
        expect((await accept(identityToken({ sub: `sub-new-${email}`, email }), invitationId, token)).status).toBe(200);
      } finally {
        await limitSeats(null);
      }
    });

    it('needs an identity token of the tenant client', async () => {
      const { email, token, invitationId } = await invited();
      expect((await accept(undefined, invitationId, token)).status).toBe(401);
      expect((await accept('not-a-token', invitationId, token)).status).toBe(401);
      expect((await accept(identityToken({ sub: 'sub-control', email, audience: 'control' }), invitationId, token)).status).toBe(401);
    });
  });

  describe('suspendMembership, reactivateMembership and endMembership', () => {
    const lifecycle = (n: number, action: string, target: number, ifMatch?: string, reason = 'a reason that is long enough'): Promise<Reply> =>
      as(n, 'POST', `/memberships/${memberId(target)}/${action}`, { reason }, { ifMatch });

    it('suspends an Active member: scope_version up, sessions revoked, events and audit written (AC-ST-ADM-006-1)', async () => {
      await admin(
        `insert into machvon.user_session (tenant_id, id, user_account_id, membership_id, idp_session_id, assurance_level, ip_hash, user_agent_summary)
         values ($1, $2, $3, $4, 'idp-target-a', 'aal1', $5, 'test')`,
        [T, randomUUID(), id(0x60, TARGET_A), memberId(TARGET_A), '0'.repeat(64)],
      );
      const sv = Number((await membershipRow(memberId(TARGET_A))).scope_version);
      const accessEvents = await events('iam.access.changed.v1', memberId(TARGET_A));
      const reply = await lifecycle(ADMIN, 'suspend', TARGET_A, await versionOf(TARGET_A));
      expect(reply.status).toBe(200);
      expect(reply.json).toMatchObject({ status: 'SUSPENDED', resource_id: memberId(TARGET_A) });
      const row = await membershipRow(memberId(TARGET_A));
      expect(row.status).toBe('Suspended');
      expect(Number(row.scope_version)).toBe(sv + 1);
      expect(Number(row.version)).toBe(reply.json.resource_version);
      expect(await countOf('select count(*) as n from machvon.user_session where membership_id = $1 and revoked_at is null', [memberId(TARGET_A)])).toBe(0);
      expect(await events('iam.membership.suspended.v1', memberId(TARGET_A))).toBe(1);
      expect(await events('iam.access.changed.v1', memberId(TARGET_A))).toBe(accessEvents + 1);
      expect(await audits('membership.suspend')).toBeGreaterThanOrEqual(1);
    });

    it('refuses to suspend twice (409 MEMBERSHIP_STATE_INVALID) and needs the current version', async () => {
      expect((await lifecycle(ADMIN, 'suspend', TARGET_A, await versionOf(TARGET_A))).json.code).toBe('MEMBERSHIP_STATE_INVALID');
      expect((await lifecycle(ADMIN, 'reactivate', TARGET_A)).status).toBe(428);
      const stale = await lifecycle(ADMIN, 'reactivate', TARGET_A, '"1"');
      expect(stale.status).toBe(409);
      expect(stale.json.code).toBe('VERSION_CONFLICT');
    });

    it('reactivates a Suspended member, but only while a seat is free', async () => {
      await limitSeats(await activeStaff());
      try {
        const refused = await lifecycle(ADMIN, 'reactivate', TARGET_C, await versionOf(TARGET_C));
        expect(refused.status).toBe(403);
        expect(refused.json.code).toBe('QUOTA_EXCEEDED');
        expect((await membershipRow(memberId(TARGET_C))).status).toBe('Suspended');
      } finally {
        await limitSeats(null);
      }
      const reply = await lifecycle(ADMIN, 'reactivate', TARGET_C, await versionOf(TARGET_C));
      expect(reply.status).toBe(200);
      expect(reply.json.status).toBe('ACTIVE');
      expect((await membershipRow(memberId(TARGET_C))).status).toBe('Active');
      expect(await events('iam.membership.activated.v1', memberId(TARGET_C))).toBe(1);
      expect((await lifecycle(ADMIN, 'reactivate', TARGET_C, await versionOf(TARGET_C))).json.code).toBe('MEMBERSHIP_STATE_INVALID');
    });

    it('ends a member for good: reason kept, pending invitations revoked, no way back', async () => {
      const pending = await invited(ADMIN, U2);
      const ended = await as(ADMIN, 'POST', `/memberships/${pending.membershipId}/end`, { reason: 'the invitation was a mistake' }, { ifMatch: '"1"' });
      expect(ended.status).toBe(200);
      expect(ended.json.status).toBe('ENDED');
      const row = await membershipRow(pending.membershipId);
      expect(row).toMatchObject({ status: 'Ended', ended_reason: 'the invitation was a mistake' });
      expect((await admin<{ status: string }>('select status from machvon.membership_invitation where id = $1', [pending.invitationId]))[0]?.status).toBe('Revoked');
      const accepted = await accept(identityToken({ sub: `sub-new-${pending.email}`, email: pending.email }), pending.invitationId, pending.token);
      expect(accepted.status).toBe(409);
      expect(accepted.json.code).toBe('INVITATION_EXPIRED');

      const again = await as(ADMIN, 'POST', `/memberships/${pending.membershipId}/end`, { reason: 'the invitation was a mistake' }, { ifMatch: `"${row.version}"` });
      expect(again.json.code).toBe('MEMBERSHIP_STATE_INVALID');
      const back = await as(ADMIN, 'POST', `/memberships/${pending.membershipId}/reactivate`, { reason: 'the invitation was a mistake' }, { ifMatch: `"${row.version}"` });
      expect(back.json.code).toBe('MEMBERSHIP_STATE_INVALID');
      expect(await events('iam.membership.ended.v1', pending.membershipId)).toBe(1);
    });

    it('ends an Active member and revokes their sessions', async () => {
      const reply = await lifecycle(UNIT_ADMIN, 'end', TARGET_D, await versionOf(TARGET_D));
      expect(reply.status).toBe(200);
      expect((await membershipRow(memberId(TARGET_D))).status).toBe('Ended');
    });

    it('refuses to act on oneself (AC-ST-ADM-006-1)', async () => {
      const reply = await lifecycle(ADMIN, 'suspend', ADMIN, await versionOf(ADMIN));
      expect(reply.status).toBe(403);
      expect(reply.json.code).toBe('SELF_ACTION_DENIED');
    });

    it('is bound by the scope of the actor: a unit admin cannot reach another unit', async () => {
      const before = await audits('command.denied:suspendMembership', 'DENIED');
      const reply = await lifecycle(UNIT_ADMIN, 'suspend', TARGET_B, await versionOf(TARGET_B));
      expect(reply.status).toBe(403);
      expect(reply.json.code).toBe('SCOPE_DENIED');
      expect(await audits('command.denied:suspendMembership', 'DENIED')).toBe(before + 1);
      expect((await membershipRow(memberId(TARGET_B))).status).toBe('Active');
    });

    it('refuses to act on a member of the same rank or higher (BR-IAM-05) (AC-ST-ADM-006-1)', async () => {
      const peer = await lifecycle(UNIT_ADMIN, 'suspend', PEER, await versionOf(PEER));
      expect(peer.status).toBe(403);
      expect(peer.json.code).toBe('ROLE_ESCALATION_DENIED');
      const above = await lifecycle(UNIT_ADMIN, 'suspend', ADMIN, await versionOf(ADMIN));
      expect(above.json.code).toBe('SCOPE_DENIED');
    });

    it('never suspends or ends the last tenant owner, and ranks protect owners when there are two (AC-ST-ADM-006-3)', async () => {
      const last = await lifecycle(ADMIN, 'suspend', OWNER, await versionOf(OWNER));
      expect(last.status).toBe(409);
      expect(last.json.code).toBe('LAST_TENANT_OWNER');
      expect((await lifecycle(ADMIN, 'end', OWNER, await versionOf(OWNER))).json.code).toBe('LAST_TENANT_OWNER');

      const second = 10;
      await harness.seedMembership(T, second, U1);
      await giveRole(second, 'TENANT_OWNER', 'TENANT');
      const ranked = await lifecycle(ADMIN, 'suspend', second, await versionOf(second));
      expect(ranked.status).toBe(403);
      expect(ranked.json.code).toBe('ROLE_ESCALATION_DENIED');
    });

    it('answers 404 for an unknown membership and for a membership of another tenant', async () => {
      const unknown = await as(ADMIN, 'POST', `/memberships/${randomUUID()}/suspend`, { reason: 'a reason that is long enough' }, { ifMatch: '"1"' });
      expect(unknown.status).toBe(404);
      const foreign = await as(ADMIN, 'POST', `/memberships/${memberId(OTHER_TENANT_MEMBER)}/suspend`, { reason: 'a reason that is long enough' }, { ifMatch: '"1"' });
      expect(foreign.status).toBe(404);
      expect((await admin<{ status: string }>('select status from machvon.membership where tenant_id = $1 and id = $2', [T_OTHER, memberId(OTHER_TENANT_MEMBER)]))[0]?.status).toBe('Active');
    });

    it('validates the reason: at least ten characters', async () => {
      const reply = await lifecycle(ADMIN, 'suspend', TARGET_B, await versionOf(TARGET_B), 'short');
      expect(reply.status).toBe(422);
    });
  });
});
