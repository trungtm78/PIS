import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { AddressInfo } from 'node:net';
import { ControlDatabase, EffectiveAccessStore, InMemoryAuthzCache, UserSessionStore } from '@machvon/db';
import { seedSystemRoles } from '@machvon/db/src/system-roles';
import { loadErrorRegistry } from '@machvon/kernel';
import { Client, Pool } from 'pg';
import { AppModule } from '../../src/app.module';
import { HttpJwksSource, discoverJwksUri } from '../../src/auth/jwks-source';
import { JwksTokenVerifier } from '../../src/auth/jwks-token-verifier';
import { UserSessionDenyList } from '../../src/session/user-session-deny-list';
import { AuthzHarness, grantId, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { CONTROL_AUDIENCE, IDENTITY_AUDIENCE, TENANT_ISSUER, identityClaims, issuerKey, newIssuer } from '../auth/auth-fixtures';
import { OidcTestProvider, signJwt } from '../auth/oidc-test-provider';
import type { ProviderKey } from '../auth/oidc-test-provider';
import { ERROR_CODES_PATH } from '../isolation/test-app';
import { assertStatus, expectCheckFails } from '../uat/uat-kit';
import type { Reply } from '../uat/uat-kit';

jest.setTimeout(120_000);

/**
 * UAT cases of the membership and session rules of the platform fixture (IAM.md BR-IAM-07, IAM-04, IAM-02), run through the whole application with identity tokens
 * and the tenant tokens the selection hands out, as a browser would. People of tenant A "minh-ha": u.owner, u.admin, u.unitadmin (UNIT_ADMIN 70 on A-BQLGT), u.leader
 * (LEADER 60), u.spec, u.maker (INVESTOR_OFFICER 30) and one person who decides approvals; tenant B "bo-thu-nghiem" holds a suspended membership of u.spec.
 */
const PLACEMENT = id(0x70, 1);
const T_A = id(0x71, 1);
const T_B = id(0x71, 2);
const ACTOR = id(0x60, 99);

const OWNER = 1;
const ADMIN = 2;
const UNIT_ADMIN = 3;
const LEADER = 4;
const SPEC = 5;
const MAKER = 6;
const DECIDER = 7;
const SPEC_IN_B = 15;

const A_ROOT = 1;
const A_BQLGT = 2;
const A_STC = 3;

interface CallOptions {
  ifMatch?: string;
  key?: string;
}

describe('membership and session rules of the platform fixture (BR-IAM-07, IAM-02, IAM-04)', () => {
  const harness = new AuthzHarness();
  let provider: OidcTestProvider;
  let key: ProviderKey;
  let controlPool: Pool;
  let app: INestApplication;
  let baseUrl: string;
  let skewMs = 0;
  let counter = 0;
  const roles = new Map<string, string>();
  const nowSeconds = (): number => Math.floor(Date.now() / 1000);

  const admin = async <R extends object = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<R[]> => {
    const client = new Client({ connectionString: harness.database.adminUrl });
    await client.connect();
    try {
      return (await client.query(text, params)).rows as R[];
    } finally {
      await client.end();
    }
  };
  const countOf = async (text: string, params: unknown[] = []): Promise<number> => Number((await admin<{ n: string }>(text, params))[0]?.n);

  /** The identity token of person n as the identity provider issues it: a second factor when `aal2`, the password alone otherwise. Every call is a new sign-in with a session of its own. */
  function identityToken(person: number, aal2 = true): string {
    return signJwt(
      key,
      identityClaims(provider.issuer, {
        sub: `sub-${person}`,
        sid: `idp-${(counter += 1)}-${randomUUID()}`,
        exp: nowSeconds() + 300,
        iat: nowSeconds() - 10,
        auth_time: nowSeconds() - 60,
        acr: aal2 ? 'aal2' : 'aal1',
        amr: aal2 ? ['pwd', 'otp'] : ['pwd'],
      }),
    );
  }

  async function send(method: string, path: string, token: string, body: unknown, options: CallOptions = {}): Promise<Reply & { headers: Headers }> {
    const headers: Record<string, string> = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, headers: response.headers, json: (await response.json()) as Record<string, unknown> };
  }

  const select = (token: string, tenantId: string, membershipId: string): Promise<Reply> => send('POST', '/me/session/tenant-selection', token, { tenant_id: tenantId, membership_id: membershipId });

  /** A tenant token of person n in tenant A, from a sign-in of its own. */
  async function login(person: number, aal2 = true): Promise<string> {
    const reply = await select(identityToken(person, aal2), T_A, memberId(person));
    assertStatus(reply, 200);
    return reply.json.access_token as string;
  }

  const decode = (token: string): Record<string, unknown> => JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;
  const membershipRow = async (membershipId: string): Promise<{ status: string; version: string }> =>
    (await admin<{ status: string; version: string }>('select status, version::text as version from machvon.membership where id = $1', [membershipId]))[0] as { status: string; version: string };

  async function giveRole(member: number, code: string, kind: string, refs: readonly string[] = []): Promise<void> {
    counter += 1;
    await harness.owner(T_A, [
      [
        `insert into machvon.role_grant (tenant_id, id, membership_id, role_id, scope_json, effective_from, scope_kind, scope_ref_ids, status, granted_by, grant_reason)
         values ($1, $2, $3, $4, $5::jsonb, '2026-01-01T00:00:00Z', $6, $7::uuid[], 'Active', $8, 'seed')`,
        [T_A, grantId(1000 + counter), memberId(member), roles.get(code), JSON.stringify({ kind, ref_ids: refs }), kind, refs, ACTOR],
      ],
    ]);
  }

  beforeAll(async () => {
    await harness.start();
    await admin("insert into machvon.placement (id, kind, region, db_cluster_ref, kms_key_ref, status) values ($1, 'POOL', 'vn-north', 'cluster-1', 'kms-1', 'Active')", [PLACEMENT]);
    for (const [tenantId, code] of [[T_A, 'minh-ha'], [T_B, 'bo-thu-nghiem']] as const) {
      await admin("insert into machvon.tenant (id, code, name, status, placement_id, region) values ($1, $2, $2, 'Active', $3, 'vn-north')", [tenantId, code, PLACEMENT]);
      await harness.seedUnits(tenantId, [
        { n: A_ROOT, path: `/${unitId(A_ROOT)}/` },
        { n: A_BQLGT, path: `/${unitId(A_ROOT)}/${unitId(A_BQLGT)}/`, parent: A_ROOT },
        { n: A_STC, path: `/${unitId(A_ROOT)}/${unitId(A_STC)}/`, parent: A_ROOT },
      ]);
      await harness.tenants.withTenant({ tenantId, membershipId: ACTOR, scopeVersion: 0 }, (tx) => seedSystemRoles(tx, ACTOR));
    }
    const people: Array<[number, number]> = [[OWNER, A_ROOT], [ADMIN, A_ROOT], [UNIT_ADMIN, A_BQLGT], [LEADER, A_BQLGT], [SPEC, A_STC], [MAKER, A_BQLGT], [DECIDER, A_BQLGT]];
    for (const [person, unit] of people) await harness.seedMembership(T_A, person, unit);
    // u.spec holds a second membership, in tenant B, and it is suspended.
    await harness.owner(T_B, [
      [
        "insert into machvon.membership (tenant_id, id, user_id, organization_id, status, valid_from) values ($1, $2, $3, $4, 'Suspended', now() - interval '30 days')",
        [T_B, memberId(SPEC_IN_B), id(0x60, SPEC), unitId(A_ROOT)],
      ],
    ]);
    for (const row of await admin<{ id: string; code: string }>('select id, code from machvon.role_definition where tenant_id = $1', [T_A])) roles.set(row.code, row.id);
    await admin("insert into machvon.role_definition (tenant_id, id, code, name, permissions, rank, status, created_by) values ($1, $2, 'DECIDER', 'DECIDER', '{approval.decide}', 40, 'Active', $3)", [T_A, randomUUID(), ACTOR]);
    for (const row of await admin<{ id: string; code: string }>("select id, code from machvon.role_definition where tenant_id = $1 and code = 'DECIDER'", [T_A])) roles.set(row.code, row.id);
    await giveRole(OWNER, 'TENANT_OWNER', 'TENANT');
    await giveRole(ADMIN, 'TENANT_ADMIN', 'TENANT');
    await giveRole(UNIT_ADMIN, 'UNIT_ADMIN', 'UNIT_SUBTREE', [unitId(A_BQLGT)]);
    await giveRole(LEADER, 'LEADER', 'UNIT_SUBTREE', [unitId(A_BQLGT)]);
    await giveRole(SPEC, 'SPECIALIST', 'TENANT');
    await giveRole(MAKER, 'INVESTOR_OFFICER', 'TENANT');
    await giveRole(DECIDER, 'DECIDER', 'TENANT');
    for (const person of [OWNER, ADMIN, UNIT_ADMIN, LEADER, SPEC, MAKER, DECIDER]) await giveRole(person, 'MEMBER', 'TENANT');

    provider = await OidcTestProvider.start();
    key = provider.addKey('RS256');
    const issuer = newIssuer(issuerKey());
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
    // The clock of the deny list can be moved forward: "60 seconds later" is a step of this clock, not a wait.
    const denyList = new UserSessionDenyList(sessions, { now: () => Date.now() + skewMs });
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
  });

  afterAll(async () => {
    await app?.close();
    await provider?.stop();
    await controlPool?.end();
    await harness.stop();
  });

  it('UAT-AC101: a membership of somebody else is 403 TENANT_SELECTION_INVALID, a suspended one is 403 MEMBERSHIP_INACTIVE, and the own active one gives the session context of tenant A, audited', async () => {
    const foreign = await select(identityToken(SPEC), T_A, memberId(MAKER));
    assertStatus(foreign, 403, 'TENANT_SELECTION_INVALID');
    const suspended = await select(identityToken(SPEC), T_B, memberId(SPEC_IN_B));
    assertStatus(suspended, 403, 'MEMBERSHIP_INACTIVE');
    expect(await countOf('select count(*) as n from machvon.user_session where membership_id in ($1, $2)', [memberId(MAKER), memberId(SPEC_IN_B)])).toBe(0);

    const own = await select(identityToken(SPEC), T_A, memberId(SPEC));
    assertStatus(own, 200);
    expect(own.json).toMatchObject({ tenant_id: T_A, membership_id: memberId(SPEC), mode: 'FULL' });
    expect(Number(own.json.scope_version)).toBeGreaterThanOrEqual(1);
    const claims = decode(own.json.access_token as string);
    expect(claims).toMatchObject({ tid: T_A, mid: memberId(SPEC) });
    expect(await admin('select outcome, action from machvon.audit_event where resource_id = $1', [claims.sid])).toEqual([{ outcome: 'SUCCESS', action: 'session.tenant_selected' }]);
  });

  it('UAT-AC113: u.unitadmin cannot suspend themselves (403 SELF_ACTION_DENIED), u.leader without iam.member.manage cannot suspend u.maker (403 SCOPE_DENIED), u.unitadmin can, and 60 seconds later both sessions of u.maker are 401 SESSION_EXPIRED', async () => {
    const unitAdmin = await login(UNIT_ADMIN);
    const leader = await login(LEADER);
    const firstSession = await login(MAKER);
    const secondSession = await login(MAKER);
    for (const token of [firstSession, secondSession]) assertStatus(await send('GET', '/me/sessions', token, undefined), 200);
    const reason = { reason: 'Tạm dừng do điều chuyển công tác' };
    const makerVersion = `"${(await membershipRow(memberId(MAKER))).version}"`;

    const self = await send('POST', `/memberships/${memberId(UNIT_ADMIN)}/suspend`, unitAdmin, reason, { ifMatch: `"${(await membershipRow(memberId(UNIT_ADMIN))).version}"` });
    assertStatus(self, 403, 'SELF_ACTION_DENIED');
    const withoutRight = await send('POST', `/memberships/${memberId(MAKER)}/suspend`, leader, reason, { ifMatch: makerVersion });
    assertStatus(withoutRight, 403, 'SCOPE_DENIED');
    expect((await membershipRow(memberId(MAKER))).status).toBe('Active');

    const eventsBefore = await countOf("select count(*) as n from machvon.outbox_event where type = 'iam.access.changed.v1' and aggregate_id = $1", [memberId(MAKER)]);
    const done = await send('POST', `/memberships/${memberId(MAKER)}/suspend`, unitAdmin, reason, { ifMatch: makerVersion });
    assertStatus(done, 200);
    expect(done.json).toMatchObject({ status: 'SUSPENDED', resource_id: memberId(MAKER) });
    expect((await membershipRow(memberId(MAKER))).status).toBe('Suspended');
    expect(await countOf("select count(*) as n from machvon.outbox_event where type = 'iam.access.changed.v1' and aggregate_id = $1", [memberId(MAKER)])).toBe(eventsBefore + 1);

    skewMs += 60_000;
    for (const token of [firstSession, secondSession]) assertStatus(await send('GET', '/me/sessions', token, undefined), 401, 'SESSION_EXPIRED');
  });

  it('UAT-AC118: the only owner cannot end their own membership (403 SELF_ACTION_DENIED) and u.admin cannot revoke the owner grant (403 ROLE_ESCALATION_DENIED, rank 99 above 90), and both stay in force', async () => {
    const owner = await login(OWNER);
    const adminToken = await login(ADMIN);
    const ended = await send('POST', `/memberships/${memberId(OWNER)}/end`, owner, { reason: 'Rời khỏi đơn vị' }, { ifMatch: `"${(await membershipRow(memberId(OWNER))).version}"` });
    assertStatus(ended, 403, 'SELF_ACTION_DENIED');
    expect((await membershipRow(memberId(OWNER))).status).toBe('Active');

    const grant = (await admin<{ id: string; version: string }>("select id, version::text as version from machvon.role_grant where membership_id = $1 and role_id = $2 and status = 'Active'", [memberId(OWNER), roles.get('TENANT_OWNER')]))[0];
    const revoked = await send('POST', `/role-grants/${grant?.id}/revoke`, adminToken, { reason: 'Thu hồi vai trò chủ sở hữu' }, { ifMatch: `"${grant?.version}"` });
    assertStatus(revoked, 403, 'ROLE_ESCALATION_DENIED');
    expect(await countOf("select count(*) as n from machvon.role_grant where id = $1 and status = 'Active'", [grant?.id])).toBe(1);
  });

  it('UAT-PLAN-44: a password-only sign-in of u.leader gets no tenant token (403 MFA_REQUIRED), the second factor gets a token that carries acr aal2, and a password-only token carries aal1 and is refused on the approval route with 403 MFA_REQUIRED', async () => {
    const sessionsOfLeader = (): Promise<number> => countOf('select count(*) as n from machvon.user_session where membership_id = $1', [memberId(LEADER)]);
    const sessionsBefore = await sessionsOfLeader();
    const weak = await select(identityToken(LEADER, false), T_A, memberId(LEADER));
    assertStatus(weak, 403, 'MFA_REQUIRED');
    expect(weak.json.access_token).toBeUndefined();
    expect(await sessionsOfLeader()).toBe(sessionsBefore);

    const strong = await select(identityToken(LEADER, true), T_A, memberId(LEADER));
    assertStatus(strong, 200);
    expect(strong.json.assurance_level).toBe('aal2');
    expect(decode(strong.json.access_token as string)).toMatchObject({ acr: 'aal2', amr: ['pwd', 'otp'] });

    // The person who decides approvals holds no role of the policy, so the password alone opens a session: it says aal1, and the decision asks for more.
    const passwordOnly = await login(DECIDER, false);
    expect(decode(passwordOnly)).toMatchObject({ acr: 'aal1' });
    const task = randomUUID();
    assertStatus(await send('POST', `/approval-tasks/${task}/decision`, passwordOnly, { decision: 'approve' }, { ifMatch: '"1"' }), 403, 'MFA_REQUIRED');
    // With the second factor the same call is past the step-up: it reaches the task, which does not exist.
    assertStatus(await send('POST', `/approval-tasks/${task}/decision`, await login(DECIDER, true), { decision: 'approve' }, { ifMatch: '"1"' }), 404);
  });

  it('the checks of this suite can go red: a check fed the wrong answer throws', () => {
    expectCheckFails(() => assertStatus({ status: 200, json: {} }, 403, 'SELF_ACTION_DENIED'));
    expectCheckFails(() => assertStatus({ status: 401, json: { code: 'SESSION_EXPIRED' } }, 401, 'MFA_REQUIRED'));
  });
});
