import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { AddressInfo } from 'node:net';
import { ControlDatabase, EffectiveAccessStore, InMemoryAuthzCache, UserSessionStore } from '@machvon/db';
import { loadErrorRegistry } from '@machvon/kernel';
import type { MetricsSink } from '@machvon/kernel';
import { Client, Pool } from 'pg';
import { AppModule } from '../../src/app.module';
import { HttpJwksSource, discoverJwksUri } from '../../src/auth/jwks-source';
import { JwksTokenVerifier } from '../../src/auth/jwks-token-verifier';
import { UserSessionDenyList } from '../../src/session/user-session-deny-list';
import { AuthzHarness, id } from '../../../../packages/db/test/support/authz-fixtures';
import { CONTROL_AUDIENCE, IDENTITY_AUDIENCE, TENANT_ISSUER, identityClaims, issuerKey, newIssuer } from '../auth/auth-fixtures';
import { OidcTestProvider, signJwt } from '../auth/oidc-test-provider';
import type { ProviderKey } from '../auth/oidc-test-provider';
import { ERROR_CODES_PATH } from '../isolation/test-app';

// RSA key generation and several embedded databases are slow on a loaded machine.
jest.setTimeout(60_000);

const PLACEMENT = id(0x70, 1);
const T_ACTIVE = id(0x71, 1);
const T_OTHER = id(0x71, 2);
const T_SUSPENDED = id(0x71, 3);
const T_PROVISIONING = id(0x71, 4);
const T_INCIDENT = id(0x71, 5);

const unit = (n: number): string => id(0x72, n);
const user = (n: number): string => id(0x73, n);
const member = (n: number): string => id(0x74, n);
const role = (n: number): string => id(0x75, n);

const MAIN = 1; // an ordinary person with memberships in four tenants
const OUTSIDER = 2; // a person with a membership in T_ACTIVE only
const LOCKED = 3;
const LEADER_USER = 4; // holds LEADER in T_ACTIVE
const READER = 5; // holds organization_unit.read on the whole of T_ACTIVE
const MANAGER = 6; // holds iam.member.manage and membership.read on the whole of T_ACTIVE

// Memberships: member(n) belongs to user(MAIN) unless stated below.
const M_ACTIVE = 1;
const M_OTHER_TENANT = 2;
const M_SUSPENDED_TENANT = 3;
const M_PROVISIONING_TENANT = 4;
const M_ENDED = 5; // status Ended in T_ACTIVE (a second unit)
const M_EXPIRED = 6;
const M_NOT_STARTED = 7;
const M_OUTSIDER = 8;
const M_LEADER = 9;
const M_READER = 10;
const M_MANAGER = 11;
const M_INCIDENT = 12;
const M_ACTIVE_BIS = 13; // a second membership of MAIN in T_ACTIVE, on its own unit
const M_LOCKED = 14;

const READ_ROLE = 1;
const LEADER_ROLE = 2;
const MANAGER_ROLE = 3;

function decode(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;
}

describe('selectTenantContext, session binding and revocation (ST-IAM-003)', () => {
  const harness = new AuthzHarness();
  const counters = new Map<string, number>();
  const metrics: MetricsSink = {
    increment: (name, labels) => counters.set(`${name}${labels === undefined ? '' : JSON.stringify(labels)}`, (counters.get(`${name}${labels === undefined ? '' : JSON.stringify(labels)}`) ?? 0) + 1),
    gauge: () => undefined,
  };
  let provider: OidcTestProvider;
  let key: ProviderKey;
  let controlPool: Pool;
  let control: ControlDatabase;
  let controlCalls = 0;
  let sessions: UserSessionStore;
  let app: INestApplication;
  let baseUrl: string;
  let sessionCounter = 0;

  const nowSeconds = (): number => Math.floor(Date.now() / 1000);
  const idpSession = (): string => `idp-${(sessionCounter += 1)}-${randomUUID()}`;

  function identityToken(n: number, options: { sid?: string; assurance?: 'aal1' | 'aal2'; overrides?: Record<string, unknown> } = {}): string {
    const aal2 = (options.assurance ?? 'aal2') === 'aal2';
    const claims = identityClaims(provider.issuer, {
      sub: `sub-${n}`,
      sid: options.sid ?? idpSession(),
      exp: nowSeconds() + 300,
      iat: nowSeconds() - 10,
      auth_time: nowSeconds() - 60,
      acr: aal2 ? 'aal2' : 'aal1',
      amr: aal2 ? ['pwd', 'otp'] : ['pwd'],
      ...options.overrides,
    });
    return signJwt(key, claims);
  }

  async function select(token: string | undefined, body: unknown, idempotencyKey: string | null = `key-${randomUUID()}`): Promise<{ status: number; headers: Headers; json: Record<string, unknown> }> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (token !== undefined) headers.authorization = `Bearer ${token}`;
    if (idempotencyKey !== null) headers['idempotency-key'] = idempotencyKey;
    const response = await fetch(`${baseUrl}/me/session/tenant-selection`, { method: 'POST', headers, body: JSON.stringify(body) });
    return { status: response.status, headers: response.headers, json: (await response.json()) as Record<string, unknown> };
  }

  async function api(method: string, path: string, token: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': `key-${randomUUID()}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }

  const pick = (tenantId: string, membership: number) => ({ tenant_id: tenantId, membership_id: member(membership) });

  async function admin<T extends object = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
    const client = new Client({ connectionString: harness.database.adminUrl });
    await client.connect();
    try {
      return (await client.query(text, params)).rows as T[];
    } finally {
      await client.end();
    }
  }

  beforeAll(async () => {
    await harness.start();
    controlPool = new Pool({ connectionString: harness.database.urlFor('machvon_control'), max: 4 });
    controlPool.on('error', () => undefined);
    const realControl = new ControlDatabase(controlPool);
    control = new Proxy(realControl, {
      get(target, property, receiver) {
        if (property === 'withControl') {
          return (...args: Parameters<ControlDatabase['withControl']>) => {
            controlCalls += 1;
            return target.withControl(...args);
          };
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });

    await admin("insert into machvon.placement (id, kind, region, db_cluster_ref, kms_key_ref, status) values ($1, 'POOL', 'vn-north', 'cluster-1', 'kms-1', 'Active')", [PLACEMENT]);
    const tenants: Array<[string, string, string, string | null]> = [
      [T_ACTIVE, 'tenant-active', 'Active', null],
      [T_OTHER, 'tenant-other', 'Active', null],
      [T_SUSPENDED, 'tenant-suspended', 'Suspended', 'NON_PAYMENT'],
      [T_PROVISIONING, 'tenant-provisioning', 'Provisioning', null],
      [T_INCIDENT, 'tenant-incident', 'Suspended', 'SECURITY_INCIDENT'],
    ];
    for (const [tenantId, code, status, reason] of tenants) {
      await admin("insert into machvon.tenant (id, code, name, status, placement_id, region, lifecycle_reason) values ($1, $2, $2, $3, $4, 'vn-north', $5)", [tenantId, code, status, PLACEMENT, reason]);
    }
    const users: Array<[number, string]> = [
      [MAIN, 'Active'],
      [OUTSIDER, 'Active'],
      [LOCKED, 'Locked'],
      [LEADER_USER, 'Active'],
      [READER, 'Active'],
      [MANAGER, 'Active'],
    ];
    for (const [n, status] of users) {
      await admin("insert into machvon.user_account (id, idp_subject, email_normalized, display_name, phone_e164, status) values ($1, $2, $3, $4, $5, $6)", [
        user(n),
        `sub-${n}`,
        `person${n}@example.test`,
        `Person ${n}`,
        `+8490000000${n}`,
        status,
      ]);
    }
    const memberships: Array<[string, number, number, string, string | null, string | null]> = [
      [T_ACTIVE, M_ACTIVE, MAIN, 'Active', null, null],
      [T_OTHER, M_OTHER_TENANT, MAIN, 'Active', null, null],
      [T_SUSPENDED, M_SUSPENDED_TENANT, MAIN, 'Active', null, null],
      [T_PROVISIONING, M_PROVISIONING_TENANT, MAIN, 'Active', null, null],
      [T_ACTIVE, M_ENDED, MAIN, 'Ended', null, null],
      [T_ACTIVE, M_EXPIRED, MAIN, 'Active', null, '2020-01-01T00:00:00Z'],
      [T_ACTIVE, M_NOT_STARTED, MAIN, 'Active', '2999-01-01T00:00:00Z', null],
      [T_ACTIVE, M_OUTSIDER, OUTSIDER, 'Active', null, null],
      [T_ACTIVE, M_LEADER, LEADER_USER, 'Active', null, null],
      [T_ACTIVE, M_READER, READER, 'Active', null, null],
      [T_ACTIVE, M_MANAGER, MANAGER, 'Active', null, null],
      [T_INCIDENT, M_INCIDENT, MAIN, 'Active', null, null],
      [T_ACTIVE, M_ACTIVE_BIS, MAIN, 'Active', null, null],
      [T_ACTIVE, M_LOCKED, LOCKED, 'Active', null, null],
    ];
    for (const [tenantId, n, owner, status, from, until] of memberships) {
      await harness.owner(tenantId, [
        ["insert into machvon.organization_unit (tenant_id, id, code, name, valid_from, path, depth) values ($1, $2, $3, $3, date '2026-01-01', $4, 0)", [tenantId, unit(n), `U${n}`, `/${unit(n)}/`]],
        [
          'insert into machvon.membership (tenant_id, id, user_id, organization_id, status, valid_from, valid_until, scope_version) values ($1, $2, $3, $4, $5, coalesce($6::timestamptz, $7::timestamptz - make_interval(days => 365), now() - make_interval(days => 1)), $7, 7)',
          [tenantId, member(n), user(owner), unit(n), status, from, until],
        ],
      ]);
    }
    const addRole = (n: number, code: string, permissions: string[], rank: number): [string, unknown[]] => [
      "insert into machvon.role_definition (tenant_id, id, code, name, permissions, rank, status, created_by) values ($1, $2, $3, $3, $4, $5, 'Active', $6)",
      [T_ACTIVE, role(n), code, permissions, rank, id(0x60, 99)],
    ];
    const addGrant = (n: number, membership: number, roleNumber: number): [string, unknown[]] => [
      `insert into machvon.role_grant (tenant_id, id, membership_id, role_id, scope_json, effective_from, scope_kind, scope_ref_ids, status, granted_by, grant_reason)
       values ($1, $2, $3, $4, '{"kind":"TENANT","ref_ids":[]}'::jsonb, '2026-01-01T00:00:00Z', 'TENANT', '{}', 'Active', $5, 'test')`,
      [T_ACTIVE, id(0x76, n), member(membership), role(roleNumber), id(0x60, 99)],
    ];
    await harness.owner(T_ACTIVE, [
      addRole(READ_ROLE, 'READER', ['organization_unit.read'], 20),
      addRole(LEADER_ROLE, 'LEADER', ['approval.decide'], 60),
      addRole(MANAGER_ROLE, 'MANAGER', ['membership.read', 'iam.member.manage'], 50),
      addGrant(1, M_READER, READ_ROLE),
      addGrant(2, M_LEADER, LEADER_ROLE),
      addGrant(3, M_MANAGER, MANAGER_ROLE),
    ]);
    // The reader of memberships also needs membership.read to call the membership list: the manager holds both.
    await admin("update machvon.membership set scope_version = 7");

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
    sessions = new UserSessionStore(harness.tenants);
    const denyList = new UserSessionDenyList(sessions);
    const moduleRef = await Test.createTestingModule({
      imports: [
        AppModule.register({
          database: harness.tenants,
          registry: loadErrorRegistry(ERROR_CODES_PATH),
          auth: { verifier, denyList, controlAudience: CONTROL_AUDIENCE },
          policy: { database: harness.tenants, access: new EffectiveAccessStore(harness.tenants, new InMemoryAuthzCache()), denyList },
          session: { verifier, control, tenants: harness.tenants, sessions, issuer, denyList, metrics },
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

  describe('which memberships may be selected (AC-ST-IAM-003-1)', () => {
    it('gives the same 403 TENANT_SELECTION_INVALID for the membership of another person and for one that does not exist, naming no tenant', async () => {
      const token = identityToken(MAIN);
      const foreign = await select(token, pick(T_ACTIVE, M_OUTSIDER));
      const missing = await select(token, { tenant_id: T_ACTIVE, membership_id: member(99) });
      const wrongTenant = await select(token, { tenant_id: T_OTHER, membership_id: member(M_ACTIVE) });
      for (const reply of [foreign, missing, wrongTenant]) {
        expect(reply.status).toBe(403);
        expect(reply.json.code).toBe('TENANT_SELECTION_INVALID');
      }
      const strip = (json: Record<string, unknown>) => ({ ...json, correlation_id: 'x' });
      expect(strip(foreign.json)).toEqual(strip(missing.json));
      expect(strip(foreign.json)).toEqual(strip(wrongTenant.json));
      expect(JSON.stringify(foreign.json)).not.toContain('tenant-active');
    });

    it.each([
      ['an Ended membership', M_ENDED],
      ['a membership whose validity has ended', M_EXPIRED],
      ['a membership that has not started yet', M_NOT_STARTED],
    ])('refuses %s with 403 MEMBERSHIP_INACTIVE and audits the denial in the tenant', async (_label, membership) => {
      const reply = await select(identityToken(MAIN), pick(T_ACTIVE, membership));
      expect(reply.status).toBe(403);
      expect(reply.json.code).toBe('MEMBERSHIP_INACTIVE');
      const rows = await admin<{ n: string }>("select count(*) as n from machvon.audit_event where action = 'session.tenant_selection_denied' and outcome = 'DENIED' and resource_id = $1", [member(membership)]);
      expect(Number(rows[0]?.n)).toBeGreaterThanOrEqual(1);
    });

    it('selects an own Active membership: the token carries tid, mid, the database scope version and mode FULL', async () => {
      const sid = idpSession();
      const reply = await select(identityToken(MAIN, { sid }), pick(T_ACTIVE, M_ACTIVE));
      expect(reply.status).toBe(200);
      expect(reply.json).toMatchObject({ tenant_id: T_ACTIVE, membership_id: member(M_ACTIVE), scope_version: 7, mode: 'FULL', token_type: 'Bearer', expires_in: 300, assurance_level: 'aal2' });
      const claims = decode(reply.json.access_token as string);
      expect(claims).toMatchObject({ tid: T_ACTIVE, mid: member(M_ACTIVE), sv: 7, mode: 'FULL', aud: 'machvon-api' });
      const rows = await admin<{ id: string; membership_id: string; idp_session_id: string; revoked_at: string | null }>(
        'select id, membership_id, idp_session_id, revoked_at from machvon.user_session where idp_session_id = $1',
        [sid],
      );
      expect(rows).toEqual([{ id: claims.sid, membership_id: member(M_ACTIVE), idp_session_id: sid, revoked_at: null }]);
    });

    it('audits a successful selection as SUCCESS in the transaction that binds the session', async () => {
      const sid = idpSession();
      const reply = await select(identityToken(MAIN, { sid }), pick(T_ACTIVE, M_ACTIVE));
      const claims = decode(reply.json.access_token as string);
      const rows = await admin<{ outcome: string; action: string }>('select outcome, action from machvon.audit_event where resource_id = $1', [claims.sid]);
      expect(rows).toEqual([{ outcome: 'SUCCESS', action: 'session.tenant_selected' }]);
    });
  });

  describe('the state of the tenant', () => {
    it('gives a READ_ONLY session for a suspended tenant: reads pass and commands are 403 TENANT_SUSPENDED', async () => {
      const reply = await select(identityToken(MAIN), pick(T_SUSPENDED, M_SUSPENDED_TENANT));
      expect(reply.status).toBe(200);
      expect(reply.json.mode).toBe('READ_ONLY');
      const token = reply.json.access_token as string;
      const command = await api('POST', '/org-units', token, { code: 'NEWUNIT', name: 'New unit', parent_id: unit(M_SUSPENDED_TENANT), unit_type: 'DEPARTMENT', valid_from: '2026-01-01' });
      expect(command.status).toBe(403);
      expect(command.json.code).toBe('TENANT_SUSPENDED');
    });

    it('refuses a tenant that is still provisioning and one suspended for a security incident with 403 TENANT_SUSPENDED', async () => {
      const provisioning = await select(identityToken(MAIN), pick(T_PROVISIONING, M_PROVISIONING_TENANT));
      const incident = await select(identityToken(MAIN), pick(T_INCIDENT, M_INCIDENT));
      for (const reply of [provisioning, incident]) {
        expect(reply.status).toBe(403);
        expect(reply.json.code).toBe('TENANT_SUSPENDED');
      }
    });
  });

  describe('a second factor where the roles require one', () => {
    it('refuses an aal1 identity for a LEADER with 403 MFA_REQUIRED and accepts the same person at aal2', async () => {
      const weak = await select(identityToken(LEADER_USER, { assurance: 'aal1' }), pick(T_ACTIVE, M_LEADER));
      expect(weak.status).toBe(403);
      expect(weak.json.code).toBe('MFA_REQUIRED');
      const strong = await select(identityToken(LEADER_USER, { assurance: 'aal2' }), pick(T_ACTIVE, M_LEADER));
      expect(strong.status).toBe(200);
      expect(strong.json.assurance_level).toBe('aal2');
    });

    it('lets a person without a role of the policy select at aal1', async () => {
      const reply = await select(identityToken(READER, { assurance: 'aal1' }), pick(T_ACTIVE, M_READER));
      expect(reply.status).toBe(200);
      expect(reply.json.assurance_level).toBe('aal1');
    });
  });

  describe('binding and revocation (AC-ST-IAM-003-2)', () => {
    it('revokes the token of the previous tenant at once when the same identity-provider session selects another tenant', async () => {
      const sid = idpSession();
      const first = await select(identityToken(MAIN, { sid }), pick(T_ACTIVE, M_ACTIVE));
      const firstToken = first.json.access_token as string;
      // The token works before the switch (an unknown route of the API answers 404 once authenticated, never 401).
      expect((await api('GET', '/resources/organization_unit', firstToken)).status).not.toBe(401);
      const second = await select(identityToken(MAIN, { sid }), pick(T_OTHER, M_OTHER_TENANT));
      expect(second.status).toBe(200);
      expect(second.json.tenant_id).toBe(T_OTHER);
      const after = await api('GET', '/resources/organization_unit', firstToken);
      expect(after.status).toBe(401);
      expect(after.json.code).toBe('SESSION_EXPIRED');
      const rows = await admin<{ tenant_id: string; revoked: boolean }>('select tenant_id, revoked_at is not null as revoked from machvon.user_session where idp_session_id = $1 order by tenant_id', [sid]);
      expect(rows).toEqual([
        { tenant_id: T_ACTIVE, revoked: true },
        { tenant_id: T_OTHER, revoked: false },
      ]);
    });

    it('keeps one live session for a second selection of the same tenant (two tabs): both tokens work', async () => {
      const sid = idpSession();
      const first = await select(identityToken(MAIN, { sid }), pick(T_ACTIVE, M_ACTIVE));
      const second = await select(identityToken(MAIN, { sid }), pick(T_ACTIVE, M_ACTIVE));
      expect(second.status).toBe(200);
      expect(decode(second.json.access_token as string).sid).toBe(decode(first.json.access_token as string).sid);
      expect(first.json.access_token).not.toBe(second.json.access_token);
      expect((await api('GET', '/resources/organization_unit', first.json.access_token as string)).status).not.toBe(401);
      expect((await api('GET', '/resources/organization_unit', second.json.access_token as string)).status).not.toBe(401);
    });

    it('revokes the old session when the same identity-provider session picks another membership of the same tenant', async () => {
      const sid = idpSession();
      const first = await select(identityToken(MAIN, { sid }), pick(T_ACTIVE, M_ACTIVE));
      const second = await select(identityToken(MAIN, { sid }), pick(T_ACTIVE, M_ACTIVE_BIS));
      expect(second.status).toBe(200);
      expect(decode(second.json.access_token as string).sid).not.toBe(decode(first.json.access_token as string).sid);
      expect((await api('GET', '/resources/organization_unit', first.json.access_token as string)).status).toBe(401);
    });

    it('replays the first result for the same key and body: same session, no second row, and a header says so', async () => {
      const sid = idpSession();
      const token = identityToken(MAIN, { sid });
      const key = `key-${randomUUID()}`;
      const first = await select(token, pick(T_ACTIVE, M_ACTIVE), key);
      const again = await select(token, pick(T_ACTIVE, M_ACTIVE), key);
      expect(again.status).toBe(200);
      expect(again.headers.get('idempotency-replayed')).toBe('true');
      expect(first.headers.get('idempotency-replayed')).toBeNull();
      expect(decode(again.json.access_token as string).sid).toBe(decode(first.json.access_token as string).sid);
      const rows = await admin<{ n: string }>('select count(*) as n from machvon.user_session where idp_session_id = $1', [sid]);
      expect(Number(rows[0]?.n)).toBe(1);
    });

    it('stores no bearer token in the idempotency record', async () => {
      const token = identityToken(MAIN);
      const key = `key-${randomUUID()}`;
      const reply = await select(token, pick(T_ACTIVE, M_ACTIVE), key);
      const rows = await admin<{ response_ref: unknown }>("select response_ref from machvon.idempotency_record where operation = 'selectTenantContext' order by created_at desc limit 1");
      expect(JSON.stringify(rows[0]?.response_ref)).not.toContain(reply.json.access_token as string);
      expect(JSON.stringify(rows[0]?.response_ref)).not.toContain('access_token');
    });

    it('answers a refusal for the same key again as the stored refusal, not as a new attempt', async () => {
      const token = identityToken(LEADER_USER, { assurance: 'aal1' });
      const key = `key-${randomUUID()}`;
      const first = await select(token, pick(T_ACTIVE, M_LEADER), key);
      const second = await select(token, pick(T_ACTIVE, M_LEADER), key);
      expect(first.json.code).toBe('MFA_REQUIRED');
      expect(second.status).toBe(403);
      expect(second.json.code).toBe('MFA_REQUIRED');
      expect(second.headers.get('idempotency-replayed')).toBe('true');
    });

    it('requires an Idempotency-Key and refuses unknown fields', async () => {
      const token = identityToken(MAIN);
      const noKey = await select(token, pick(T_ACTIVE, M_ACTIVE), null);
      expect(noKey.status).toBe(400);
      expect(noKey.json.code).toBe('INVALID_REQUEST');
      const extra = await select(token, { ...pick(T_ACTIVE, M_ACTIVE), role: 'TENANT_OWNER' });
      expect(extra.status).toBe(400);
      expect(extra.json.code).toBe('FIELD_NOT_ALLOWED');
    });

    it('counts failures by code', async () => {
      await select(identityToken(MAIN), pick(T_ACTIVE, M_OUTSIDER));
      expect(counters.get('tenant_selection_failures_total{"code":"TENANT_SELECTION_INVALID"}')).toBeGreaterThanOrEqual(1);
      expect(counters.get('tenant_selection_total{"mode":"FULL"}')).toBeGreaterThanOrEqual(1);
    });
  });

  describe('who may ask', () => {
    it('answers a Locked account and an unknown subject exactly like a bad token', async () => {
      const locked = await select(identityToken(LOCKED), pick(T_ACTIVE, M_LOCKED));
      const unknown = await select(identityToken(77), pick(T_ACTIVE, M_ACTIVE));
      const forged = await select('not-a-token', pick(T_ACTIVE, M_ACTIVE));
      for (const reply of [locked, unknown, forged]) {
        expect(reply.status).toBe(401);
        expect(reply.json.code).toBe('SESSION_EXPIRED');
      }
      const strip = (json: Record<string, unknown>) => ({ ...json, correlation_id: 'x' });
      expect(strip(locked.json)).toEqual(strip(unknown.json));
      expect(strip(locked.json)).toEqual(strip(forged.json));
    });

    it('never reaches the account lookup for a forged, expired or foreign-audience token', async () => {
      const before = controlCalls;
      const expired = identityToken(MAIN, { overrides: { exp: nowSeconds() - 3600, iat: nowSeconds() - 4000 } });
      const wrongAudience = identityToken(MAIN, { overrides: { aud: 'someone-else' } });
      const wrongKey = signJwt(provider.addKey('RS256'), identityClaims(provider.issuer, { exp: nowSeconds() + 300 }));
      provider.removeKey(JSON.parse(Buffer.from(wrongKey.split('.')[0] ?? '', 'base64url').toString('utf8')).kid as string);
      for (const token of [expired, wrongAudience, wrongKey, undefined]) {
        const reply = await select(token, pick(T_ACTIVE, M_ACTIVE));
        expect(reply.status).toBe(401);
      }
      expect(controlCalls).toBe(before);
    });

    it('does not accept a tenant token where an identity token is required', async () => {
      const issued = await select(identityToken(MAIN), pick(T_ACTIVE, M_ACTIVE));
      const reply = await select(issued.json.access_token as string, pick(T_ACTIVE, M_ACTIVE));
      expect(reply.status).toBe(401);
    });
  });

  describe('a token issued here still obeys the database (M2c)', () => {
    it('is denied after its grant is revoked and the scope version raised, although the token is still valid', async () => {
      const sid = idpSession();
      const reply = await select(identityToken(READER, { sid, assurance: 'aal1' }), pick(T_ACTIVE, M_READER));
      const token = reply.json.access_token as string;
      expect((await api('GET', '/resources/organization_unit', token)).status).toBe(200);
      await harness.owner(T_ACTIVE, [
        ["update machvon.role_grant set status = 'Revoked', revoked_at = now(), revoked_by = $2, revoke_reason = 'test revocation' where id = $1", [id(0x76, 1), id(0x60, 99)]],
        ['update machvon.membership set scope_version = scope_version + 1 where id = $1', [member(M_READER)]],
      ]);
      const denied = await api('GET', '/resources/organization_unit', token);
      expect(denied.status).toBe(403);
      expect(denied.json.code).toBe('SCOPE_DENIED');
    });
  });

  describe('membership reads', () => {
    async function tokenFor(n: number, membership: number): Promise<string> {
      const reply = await select(identityToken(n, { assurance: 'aal2' }), pick(T_ACTIVE, membership));
      expect(reply.status).toBe(200);
      return reply.json.access_token as string;
    }

    it('masks email and phone for a caller who does not manage members, and shows them to one who does', async () => {
      const manager = await api('GET', `/resources/membership/${member(M_LEADER)}`, await tokenFor(MANAGER, M_MANAGER));
      expect(manager.status).toBe(200);
      expect(manager.json).toMatchObject({ id: member(M_LEADER), email: `person${LEADER_USER}@example.test`, phone: `+8490000000${LEADER_USER}`, display_name: `Person ${LEADER_USER}` });
    });

    it('lists only the members of the caller tenant, in pages, and never those of another tenant', async () => {
      const token = await tokenFor(MANAGER, M_MANAGER);
      const first = await api('GET', '/resources/membership?limit=3', token);
      expect(first.status).toBe(200);
      const items = first.json.items as Array<{ id: string }>;
      expect(items).toHaveLength(3);
      expect(first.json.next_cursor).not.toBeNull();
      const rest = await api('GET', `/resources/membership?limit=200&cursor=${first.json.next_cursor as string}`, token);
      const all = [...items, ...(rest.json.items as Array<{ id: string }>)].map((item) => item.id);
      expect(new Set(all).size).toBe(all.length);
      expect(all).toContain(member(M_ACTIVE));
      expect(all).not.toContain(member(M_OTHER_TENANT));
      expect(all).not.toContain(member(M_SUSPENDED_TENANT));
    });

    it('answers 404 for a member of another tenant and for one that does not exist, alike', async () => {
      const token = await tokenFor(MANAGER, M_MANAGER);
      const other = await api('GET', `/resources/membership/${member(M_OTHER_TENANT)}`, token);
      const missing = await api('GET', `/resources/membership/${member(99)}`, token);
      expect(other.status).toBe(404);
      expect(missing.status).toBe(404);
      expect({ ...other.json, correlation_id: 'x' }).toEqual({ ...missing.json, correlation_id: 'x' });
    });

    it('masks personal data for a caller who may read memberships but does not manage them', async () => {
      await harness.owner(T_ACTIVE, [
        [
          "insert into machvon.role_definition (tenant_id, id, code, name, permissions, rank, status, created_by) values ($1, $2, 'DIRECTORY', 'DIRECTORY', '{membership.read}', 15, 'Active', $3)",
          [T_ACTIVE, role(9), id(0x60, 99)],
        ],
        [
          `insert into machvon.role_grant (tenant_id, id, membership_id, role_id, scope_json, effective_from, scope_kind, scope_ref_ids, status, granted_by, grant_reason)
           values ($1, $2, $3, $4, '{"kind":"TENANT","ref_ids":[]}'::jsonb, '2026-01-01T00:00:00Z', 'TENANT', '{}', 'Active', $5, 'test')`,
          [T_ACTIVE, id(0x76, 9), member(M_ACTIVE), role(9), id(0x60, 99)],
        ],
        ['update machvon.membership set scope_version = scope_version + 1 where id = $1', [member(M_ACTIVE)]],
      ]);
      const reply = await select(identityToken(MAIN, { assurance: 'aal1' }), pick(T_ACTIVE, M_ACTIVE));
      const masked = await api('GET', `/resources/membership/${member(M_LEADER)}`, reply.json.access_token as string);
      expect(masked.status).toBe(200);
      expect(masked.json.email).toBe(`p***@example.test`);
      expect(String(masked.json.phone)).toMatch(/^\*+\d{3}$/);
      expect(JSON.stringify(masked.json)).not.toContain(`person${LEADER_USER}@`);
    });
  });

  describe('the memberships a person may choose from (IAM-04)', () => {
    async function candidates(token: string | undefined): Promise<{ status: number; json: Record<string, unknown> }> {
      const headers: Record<string, string> = {};
      if (token !== undefined) headers.authorization = `Bearer ${token}`;
      const response = await fetch(`${baseUrl}/me/session/tenant-selection/candidates`, { headers });
      return { status: response.status, json: (await response.json()) as Record<string, unknown> };
    }

    it('lists every membership of the person with the tenant name and state, and nobody of other people', async () => {
      const reply = await candidates(identityToken(MAIN));
      expect(reply.status).toBe(200);
      const items = reply.json.items as Array<Record<string, unknown>>;
      const byMembership = new Map(items.map((item) => [item.membership_id as string, item]));
      expect(items).toHaveLength(9);
      expect(byMembership.get(member(M_ACTIVE))).toMatchObject({ tenant_id: T_ACTIVE, tenant_name: 'tenant-active', tenant_status: 'Active', status: 'Active' });
      expect(byMembership.get(member(M_SUSPENDED_TENANT))).toMatchObject({ tenant_id: T_SUSPENDED, tenant_status: 'Suspended' });
      expect(byMembership.get(member(M_ENDED))).toMatchObject({ status: 'Ended' });
      expect(byMembership.has(member(M_OUTSIDER))).toBe(false);
      for (const item of items) {
        expect(Object.keys(item).sort()).toEqual(['membership_id', 'membership_type', 'status', 'tenant_id', 'tenant_name', 'tenant_status', 'valid_from', 'valid_until']);
      }
      expect(JSON.stringify(reply.json)).not.toContain('example.test');
    });

    it('orders the list by tenant name and then membership id, so the chooser is stable', async () => {
      const reply = await candidates(identityToken(MAIN));
      const items = reply.json.items as Array<{ tenant_name: string; membership_id: string }>;
      const keys = items.map((item) => `${item.tenant_name}|${item.membership_id}`);
      expect(keys).toEqual([...keys].sort());
    });

    it('answers a person with one membership with exactly that one', async () => {
      const reply = await candidates(identityToken(OUTSIDER));
      expect((reply.json.items as unknown[]).length).toBe(1);
      expect((reply.json.items as Array<{ membership_id: string }>)[0]?.membership_id).toBe(member(M_OUTSIDER));
    });

    it('is 401 SESSION_EXPIRED without a token, with a forged token and with a tenant token', async () => {
      expect((await candidates(undefined)).status).toBe(401);
      expect((await candidates('not-a-token')).status).toBe(401);
      const tenantToken = (await select(identityToken(MANAGER, { assurance: 'aal2' }), pick(T_ACTIVE, M_MANAGER))).json.access_token as string;
      expect((await candidates(tenantToken)).status).toBe(401);
    });
  });

  describe('replay, key binding and concurrency (Codex review of M2e)', () => {
    async function setTenantStatus(tenantId: string, status: string, reason: string | null): Promise<void> {
      await admin('update machvon.tenant set status = $2, lifecycle_reason = $3 where id = $1', [tenantId, status, reason]);
    }

    it('replays with the CURRENT mode: a tenant suspended after the first selection gives READ_ONLY, not the stored FULL', async () => {
      const sid = idpSession();
      const token = identityToken(MAIN, { sid });
      const key = `key-${randomUUID()}`;
      const first = await select(token, pick(T_OTHER, M_OTHER_TENANT), key);
      expect(first.json.mode).toBe('FULL');
      await setTenantStatus(T_OTHER, 'Suspended', 'NON_PAYMENT');
      try {
        const again = await select(token, pick(T_OTHER, M_OTHER_TENANT), key);
        expect(again.status).toBe(200);
        expect(again.headers.get('idempotency-replayed')).toBe('true');
        expect(again.json.mode).toBe('READ_ONLY');
        expect(decode(again.json.access_token as string).mode).toBe('READ_ONLY');
      } finally {
        await setTenantStatus(T_OTHER, 'Active', null);
      }
    });

    it('replays only for an identity that still has the assurance the membership needs: aal1 gets MFA_REQUIRED, not a token', async () => {
      const sid = idpSession();
      const key = `key-${randomUUID()}`;
      const first = await select(identityToken(LEADER_USER, { sid, assurance: 'aal2' }), pick(T_ACTIVE, M_LEADER), key);
      expect(first.status).toBe(200);
      const again = await select(identityToken(LEADER_USER, { sid, assurance: 'aal1' }), pick(T_ACTIVE, M_LEADER), key);
      expect(again.status).toBe(403);
      expect(again.json.code).toBe('MFA_REQUIRED');
      expect(again.json.access_token).toBeUndefined();
    });

    it('does not hand the token of one login to another login that reuses the same key and body', async () => {
      const key = `key-${randomUUID()}`;
      const sidA = idpSession();
      const sidB = idpSession();
      const first = await select(identityToken(MAIN, { sid: sidA }), pick(T_ACTIVE, M_ACTIVE), key);
      const second = await select(identityToken(MAIN, { sid: sidB }), pick(T_ACTIVE, M_ACTIVE), key);
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(second.headers.get('idempotency-replayed')).toBeNull();
      expect(decode(second.json.access_token as string).sid).not.toBe(decode(first.json.access_token as string).sid);
      const rows = await admin<{ idp_session_id: string }>('select idp_session_id from machvon.user_session where id = $1', [decode(second.json.access_token as string).sid as string]);
      expect(rows).toEqual([{ idp_session_id: sidB }]);
    });

    it('refuses to replay a selection that another selection has superseded, and revokes nothing', async () => {
      const sid = idpSession();
      const keyA = `key-${randomUUID()}`;
      await select(identityToken(MAIN, { sid }), pick(T_ACTIVE, M_ACTIVE), keyA);
      const second = await select(identityToken(MAIN, { sid }), pick(T_OTHER, M_OTHER_TENANT));
      expect(second.status).toBe(200);
      const replay = await select(identityToken(MAIN, { sid }), pick(T_ACTIVE, M_ACTIVE), keyA);
      expect(replay.status).toBe(401);
      expect(replay.json.code).toBe('SESSION_EXPIRED');
      // The session of the newer selection is untouched.
      expect((await api('GET', '/resources/organization_unit', second.json.access_token as string)).status).not.toBe(401);
      const live = await admin<{ n: string }>('select count(*) as n from machvon.user_session where idp_session_id = $1 and revoked_at is null', [sid]);
      expect(Number(live[0]?.n)).toBe(1);
    });

    it('serialises two selections of different tenants by one identity-provider session: exactly one session stays live', async () => {
      for (let round = 0; round < 4; round += 1) {
        const sid = idpSession();
        const [a, b] = await Promise.all([
          select(identityToken(MAIN, { sid }), pick(T_ACTIVE, M_ACTIVE)),
          select(identityToken(MAIN, { sid }), pick(T_OTHER, M_OTHER_TENANT)),
        ]);
        expect(a.status).toBe(200);
        expect(b.status).toBe(200);
        const live = await admin<{ n: string }>('select count(*) as n from machvon.user_session where idp_session_id = $1 and revoked_at is null', [sid]);
        expect(Number(live[0]?.n)).toBe(1);
      }
    });
  });

  describe('personal data follows the scope of the permission, row by row', () => {
    it('shows email and phone only for members inside the unit where the caller manages members', async () => {
      await harness.owner(T_ACTIVE, [
        ["insert into machvon.organization_unit (tenant_id, id, code, name, valid_from, path, depth) values ($1, $2, 'U15', 'U15', date '2026-01-01', $3, 0)", [T_ACTIVE, unit(15), `/${unit(15)}/`]],
        [
          "insert into machvon.membership (tenant_id, id, user_id, organization_id, status, valid_from, valid_until, scope_version) values ($1, $2, $3, $4, 'Active', now() - interval '1 day', null, 7)",
          [T_ACTIVE, member(15), user(READER), unit(15)],
        ],
        [
          "insert into machvon.role_definition (tenant_id, id, code, name, permissions, rank, status, created_by) values ($1, $2, 'PIIDIR', 'PIIDIR', '{membership.read}', 15, 'Active', $3)",
          [T_ACTIVE, role(10), id(0x60, 99)],
        ],
        [
          "insert into machvon.role_definition (tenant_id, id, code, name, permissions, rank, status, created_by) values ($1, $2, 'PIIUNIT', 'PIIUNIT', '{iam.member.manage}', 15, 'Active', $3)",
          [T_ACTIVE, role(11), id(0x60, 99)],
        ],
        [
          `insert into machvon.role_grant (tenant_id, id, membership_id, role_id, scope_json, effective_from, scope_kind, scope_ref_ids, status, granted_by, grant_reason)
           values ($1, $2, $3, $4, '{"kind":"TENANT","ref_ids":[]}'::jsonb, '2026-01-01T00:00:00Z', 'TENANT', '{}', 'Active', $5, 'test')`,
          [T_ACTIVE, id(0x76, 20), member(15), role(10), id(0x60, 99)],
        ],
        [
          `insert into machvon.role_grant (tenant_id, id, membership_id, role_id, scope_json, effective_from, scope_kind, scope_ref_ids, status, granted_by, grant_reason)
           values ($1, $2, $3, $4, jsonb_build_object('kind', 'UNIT_ONLY', 'ref_ids', jsonb_build_array($6::text)), '2026-01-01T00:00:00Z', 'UNIT_ONLY', array[$6::uuid], 'Active', $5, 'test')`,
          [T_ACTIVE, id(0x76, 21), member(15), role(11), id(0x60, 99), unit(M_LEADER)],
        ],
      ]);
      const reply = await select(identityToken(READER, { assurance: 'aal1' }), pick(T_ACTIVE, 15));
      expect(reply.status).toBe(200);
      const token = reply.json.access_token as string;
      const inside = await api('GET', `/resources/membership/${member(M_LEADER)}`, token);
      const outside = await api('GET', `/resources/membership/${member(M_OUTSIDER)}`, token);
      expect(inside.json.email).toBe(`person${LEADER_USER}@example.test`);
      expect(outside.json.email).toBe('p***@example.test');
      expect(String(outside.json.phone)).toMatch(/^\*+\d{3}$/);
      const list = await api('GET', '/resources/membership?limit=200', token);
      const byId = new Map((list.json.items as Array<{ id: string; email: string }>).map((item) => [item.id, item.email]));
      expect(byId.get(member(M_LEADER))).toBe(`person${LEADER_USER}@example.test`);
      expect(byId.get(member(M_OUTSIDER))).toBe('p***@example.test');
      expect(byId.get(member(M_MANAGER))).toBe('p***@example.test');
      expect(JSON.stringify(outside.json)).not.toContain(`person${OUTSIDER}@`);
    });
  });

  describe('the domain the sign-in is opened on chooses the tenant (ST-SAS-017)', () => {
    const HOST_OTHER = 'portal.tinh-khac.example.vn';
    const HOST_PENDING = 'cho.tinh-active.example.vn';
    const HOST_PLATFORM = 'b.machvon.vn';

    async function domain(tenantId: string, n: number, hostname: string, status: string, kind: 'CUSTOM' | 'PLATFORM_SUBDOMAIN' = 'CUSTOM'): Promise<void> {
      await admin(
        `insert into machvon.tenant_domain (tenant_id, id, hostname, kind, txt_token_hash, status, verified_at, tls_status)
         values ($1, $2, $3, $5, case when $5 = 'CUSTOM' then repeat('a', 64) end, $4, case when $4 = 'PendingVerification' then null else now() end, 'Pending')`,
        [tenantId, id(0x77, n), hostname, status, kind],
      );
    }

    async function selectOn(token: string, host: string | undefined, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
      const headers: Record<string, string> = { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': `key-${randomUUID()}` };
      if (host !== undefined) headers['x-tenant-host'] = host;
      const response = await fetch(`${baseUrl}/me/session/tenant-selection`, { method: 'POST', headers, body: JSON.stringify(body) });
      return { status: response.status, json: (await response.json()) as Record<string, unknown> };
    }

    async function candidatesOn(token: string, host: string): Promise<Array<Record<string, unknown>>> {
      const response = await fetch(`${baseUrl}/me/session/tenant-selection/candidates?host=${encodeURIComponent(host)}`, { headers: { authorization: `Bearer ${token}` } });
      expect(response.status).toBe(200);
      return ((await response.json()) as { items: Array<Record<string, unknown>> }).items;
    }

    beforeAll(async () => {
      await domain(T_OTHER, 1, HOST_OTHER, 'Active');
      await domain(T_ACTIVE, 2, HOST_PENDING, 'PendingVerification');
      await domain(T_OTHER, 3, HOST_PLATFORM, 'Active', 'PLATFORM_SUBDOMAIN');
    });

    it('AC-ST-SAS-017-2 UAT-AC153: a person of tenant A who signs in on the verified domain of tenant B is refused tenant A with 403 TENANT_SELECTION_INVALID, and only tenant B can be chosen there', async () => {
      const refused = await selectOn(identityToken(OUTSIDER), HOST_OTHER, pick(T_ACTIVE, M_OUTSIDER));
      expect(refused.status).toBe(403);
      expect(refused.json.code).toBe('TENANT_SELECTION_INVALID');
      expect(JSON.stringify(refused.json)).not.toContain(T_OTHER);
      // A person of both tenants: the domain decides which one the sign-in may start from.
      const wrong = await selectOn(identityToken(MAIN), HOST_OTHER, pick(T_ACTIVE, M_ACTIVE));
      expect(wrong.status).toBe(403);
      expect(wrong.json.code).toBe('TENANT_SELECTION_INVALID');
      const right = await selectOn(identityToken(MAIN), HOST_OTHER, pick(T_OTHER, M_OTHER_TENANT));
      expect(right.status).toBe(200);
      expect(decode(right.json.access_token as string).tid).toBe(T_OTHER);
      // The subdomain of the platform chooses its tenant in the same way, and the chooser names no unit of the other tenant.
      const onPlatform = await selectOn(identityToken(OUTSIDER), HOST_PLATFORM, pick(T_ACTIVE, M_OUTSIDER));
      expect(onPlatform.status).toBe(403);
      expect(onPlatform.json.code).toBe('TENANT_SELECTION_INVALID');
      const listed = await candidatesOn(identityToken(OUTSIDER), HOST_PLATFORM);
      expect(listed.map((item) => item.tenant_id)).toEqual([T_ACTIVE]);
      expect(JSON.stringify(listed)).not.toContain('tenant-other');
    });

    it('marks the membership of the tenant of the domain as preselected, and the domain gives no membership to anybody', async () => {
      const items = await candidatesOn(identityToken(MAIN), HOST_OTHER);
      const byTenant = new Map(items.map((item) => [`${item.tenant_id as string}|${item.membership_id as string}`, item.preselected]));
      expect(byTenant.get(`${T_OTHER}|${member(M_OTHER_TENANT)}`)).toBe(true);
      expect(byTenant.get(`${T_ACTIVE}|${member(M_ACTIVE)}`)).toBe(false);
      // A person with no membership in the tenant of the domain gets no entry for it.
      const outsider = await candidatesOn(identityToken(OUTSIDER), HOST_OTHER);
      expect(outsider.map((item) => item.tenant_id)).toEqual([T_ACTIVE]);
      expect(outsider[0]?.preselected).toBe(false);
    });

    it('takes the host of the candidates from the header the page sends with every request, as it does from the query', async () => {
      const response = await fetch(`${baseUrl}/me/session/tenant-selection/candidates`, { headers: { authorization: `Bearer ${identityToken(MAIN)}`, 'x-tenant-host': HOST_OTHER } });
      const items = ((await response.json()) as { items: Array<Record<string, unknown>> }).items;
      expect(items.find((item) => item.tenant_id === T_OTHER)?.preselected).toBe(true);
      expect(items.find((item) => item.tenant_id === T_ACTIVE)?.preselected).toBe(false);
    });

    it('does not let a domain that is not verified, one nobody holds, or a platform host choose anything', async () => {
      for (const host of [HOST_PENDING, 'nobody.example.vn', 'tinh-active.machvon.vn', 'not a host', '']) {
        const reply = await selectOn(identityToken(OUTSIDER), host === '' ? undefined : host, pick(T_ACTIVE, M_OUTSIDER));
        expect(reply.status).toBe(200);
      }
      const items = await candidatesOn(identityToken(OUTSIDER), HOST_PENDING);
      expect(items.every((item) => item.preselected === undefined || item.preselected === false)).toBe(true);
    });
  });

});
