import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { AddressInfo } from 'node:net';
import { ControlDatabase, EffectiveAccessStore, InMemoryAuthzCache, UserSessionStore } from '@machvon/db';
import { SYSTEM_ROLES, seedSystemRoles } from '@machvon/db/src/system-roles';
import { loadErrorRegistry } from '@machvon/kernel';
import { Client, Pool } from 'pg';
import { AppModule } from '../src/app.module';
import { HttpJwksSource, discoverJwksUri } from '../src/auth/jwks-source';
import { JwksTokenVerifier } from '../src/auth/jwks-token-verifier';
import { INVITATION_MAILER } from '../src/modules/adm/invitation-mailer';
import type { MockInvitationMailer } from '../src/modules/adm/invitation-mailer';
import { UserSessionDenyList } from '../src/session/user-session-deny-list';
import { AuthzHarness, grantId, id, memberId, unitId } from '../../../packages/db/test/support/authz-fixtures';
import { CONTROL_AUDIENCE, IDENTITY_AUDIENCE, TENANT_ISSUER, identityClaims, issuerKey, newIssuer } from './auth/auth-fixtures';
import { OidcTestProvider, signJwt } from './auth/oidc-test-provider';
import type { ProviderKey } from './auth/oidc-test-provider';
import { ERROR_CODES_PATH } from './isolation/test-app';

// Several embedded databases, RSA keys and a full application: slow on a loaded machine.
jest.setTimeout(120_000);

const PLACEMENT = id(0x70, 1);
const T = id(0x71, 1);
const T_OTHER = id(0x71, 2);
const ACTOR = id(0x60, 99);
const DAY_MS = 86_400_000;
// BR-IAM-05 (c): whoever grants a role holds every permission of it, so the custom roles that grant the guest role hold the permissions of the system role GUEST_CONTRACTOR (contract.read and the portal rights).
const GUEST_ROLE_PERMISSIONS = SYSTEM_ROLES.find((role) => role.code === 'GUEST_CONTRACTOR')?.permissions ?? [];

// People of tenant T (member n is user n).
const ADMIN = 1; // TENANT_OWNER (rank 99) on the whole tenant: TENANT_ADMIN lacks contract.read, which BR-IAM-05 (c) wants for the guest role
const UNIT_GUEST_ADMIN = 2; // custom role GUEST_ADMIN (rank 70) on the subtree of unit 2
const CONTRACT_GUEST_ADMIN = 3; // the same role on the contract CT_A1 only
const JUNIOR = 4; // custom role JUNIOR_INVITER (rank 10, the rank of the guest role) on the whole tenant
const UNIT_ADMIN = 5; // UNIT_ADMIN on unit 2 (and a reader of the member directory there): manages members but holds no permission to invite guests
const READER = 6; // AUDITOR: reads only
const GRANT_ON_CONTRACT = 7; // may grant roles on the contract CT_A1 only, and may invite guests on the subtree of unit 2
const GRANT_ON_UNIT = 8; // may grant roles on the subtree of unit 2, and may invite guests on the contract CT_A1 only
const OTHER_TENANT_MEMBER = 50;

const U1 = 1;
const U2 = 2;
const U3 = 3;

const CONTRACTOR = id(0x54, 1);
const OTHER_CONTRACTOR = id(0x54, 2);
const PROJECT_U2 = id(0x50, 1);
const PROJECT_U3 = id(0x50, 2);
const CT_A1 = id(0x51, 1); // ACTIVE, project of unit 2, completion 2027-03-31
const CT_A2 = id(0x51, 2); // SIGNED, project of unit 2, no completion date
const CT_B1 = id(0x51, 3); // ACTIVE, project of unit 3
const CT_FOREIGN = id(0x51, 4); // ACTIVE, project of unit 2, another contractor
const CT_DRAFT = id(0x51, 5); // DRAFT, project of unit 2
const CT_CLOSED = id(0x51, 6); // CLOSED, project of unit 2
const CT_DONE = id(0x51, 7); // COMPLETED, project of unit 2, completion 2026-06-30 (already past)
const CT_COMPLETION = Date.parse('2027-03-31T00:00:00Z');

interface Reply {
  status: number;
  headers: Headers;
  json: Record<string, unknown>;
}

interface CallOptions {
  key?: string;
  ifMatch?: string;
}

describe('guest contractors (ST-ADM-007, ADM-17 backend)', () => {
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
  const emailOf = (label: string): string => `${label}-${(counter += 1)}@guest.test`;
  const inDays = (days: number): string => new Date(Date.now() + days * DAY_MS).toISOString();

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

  function identityToken(options: { sub: string; email?: string }): string {
    const overrides = {
      sub: options.sub,
      sid: `idp-${(counter += 1)}-${randomUUID()}`,
      exp: nowSeconds() + 300,
      iat: nowSeconds() - 10,
      auth_time: nowSeconds() - 60,
      email: options.email,
      email_verified: true,
    };
    return signJwt(key, identityClaims(provider.issuer, overrides));
  }

  async function send(method: string, path: string, token: string | undefined, body: unknown, options: CallOptions = {}): Promise<Reply> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (token !== undefined) headers.authorization = `Bearer ${token}`;
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, headers: response.headers, json: (await response.json()) as Record<string, unknown> };
  }

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

  /** A guest invitation that would succeed for the tenant admin; `overrides` change what a case is about. */
  const guestBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    email: emailOf('guest'),
    contractor_id: CONTRACTOR,
    contract_ids: [CT_A1],
    role_id: roles.get('GUEST_CONTRACTOR'),
    valid_until: inDays(120),
    ...overrides,
  });
  const inviteGuest = (n: number, body: Record<string, unknown>, options: CallOptions = {}): Promise<Reply> => as(n, 'POST', '/guest-memberships', body, options);

  const unchanged = async (work: () => Promise<void>): Promise<void> => {
    const count = (): Promise<number> => countOf('select count(*) as n from machvon.membership where tenant_id = $1', [T]);
    const before = [await count(), await countOf('select count(*) as n from machvon.membership_invitation where tenant_id = $1', [T]), mailer.sent.length];
    await work();
    expect([await count(), await countOf('select count(*) as n from machvon.membership_invitation where tenant_id = $1', [T]), mailer.sent.length]).toEqual(before);
  };

  async function giveRole(member: number, code: string, kind: string, refs: readonly string[] = []): Promise<void> {
    await harness.owner(T, [
      [
        `insert into machvon.role_grant (tenant_id, id, membership_id, role_id, scope_json, effective_from, scope_kind, scope_ref_ids, status, granted_by, grant_reason)
         values ($1, $2, $3, $4, $5::jsonb, '2026-01-01T00:00:00Z', $6, $7::uuid[], 'Active', $8, 'seed')`,
        [T, grantId(1000 + (counter += 1)), memberId(member), roles.get(code), JSON.stringify({ kind, ref_ids: refs }), kind, refs, ACTOR],
      ],
    ]);
  }

  async function seedContracts(): Promise<void> {
    const client = new Client({ connectionString: harness.database.adminUrl });
    await client.connect();
    try {
      // Foreign keys to unrelated modules are out of scope here, so the superuser seeds with them switched off.
      await client.query('set session_replication_role = replica');
      await client.query(
        `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version)
         values ($1, $2, 'GP1', 'Project 1', $3, $4, 'INTERNAL', 1000, 'CONCEPT', 1), ($1, $5, 'GP2', 'Project 2', $6, $4, 'INTERNAL', 1000, 'CONCEPT', 1)`,
        [T, PROJECT_U2, unitId(U2), id(0x52, 1), PROJECT_U3, unitId(U3)],
      );
      await client.query(
        `insert into machvon.contractor (tenant_id, id, tax_identifier, legal_name, verification_status, profile_document_id)
         values ($1, $2, '0100000001', 'Cao Bang Builders', 'VERIFIED', $4), ($1, $3, '0100000002', 'Other Builders', 'VERIFIED', $4)`,
        [T, CONTRACTOR, OTHER_CONTRACTOR, id(0x55, 1)],
      );
      const rows: Array<[string, string, string, string, string, string | null]> = [
        [CT_A1, PROJECT_U2, CONTRACTOR, 'ACTIVE', 'GC-A1', '2027-03-31'],
        [CT_A2, PROJECT_U2, CONTRACTOR, 'SIGNED', 'GC-A2', null],
        [CT_B1, PROJECT_U3, CONTRACTOR, 'ACTIVE', 'GC-B1', '2027-03-31'],
        [CT_FOREIGN, PROJECT_U2, OTHER_CONTRACTOR, 'ACTIVE', 'GC-X', '2027-03-31'],
        [CT_DRAFT, PROJECT_U2, CONTRACTOR, 'DRAFT', 'GC-D', null],
        [CT_CLOSED, PROJECT_U2, CONTRACTOR, 'CLOSED', 'GC-C', '2026-06-30'],
        [CT_DONE, PROJECT_U2, CONTRACTOR, 'COMPLETED', 'GC-E', '2026-06-30'],
      ];
      for (const [contractId, project, contractor, status, code, completion] of rows) {
        const draft = status === 'DRAFT';
        const done = status === 'COMPLETED';
        await client.query(
          `insert into machvon.contract (tenant_id, id, project_id, package_id, contractor_id, code, type, currency, status, version, contract_value_vnd, signed_on, effective_from, completion_due,
              completed_on, completion_quality_acceptance_id, completed_by)
           values ($1, $2, $3, $4, $5, $6, 'LUMP_SUM', 'VND', $7, 1, $8, $9::date, $9::date, $10::date, $11::date, $12::uuid, $13::uuid)`,
          // A completed contract names the acceptance and the person that completed it (contract_completion_chk); the foreign keys are off for this seed.
          [T, contractId, project, id(0x53, 1), contractor, code, status, draft ? 0 : 1000, draft ? null : '2026-01-01', completion, done ? '2026-06-30' : null, done ? id(0x56, 1) : null, done ? ACTOR : null],
        );
      }
    } finally {
      await client.end();
    }
  }

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
      [UNIT_GUEST_ADMIN, U2],
      [CONTRACT_GUEST_ADMIN, U2],
      [JUNIOR, U1],
      [UNIT_ADMIN, U2],
      [READER, U1],
      [GRANT_ON_CONTRACT, U2],
      [GRANT_ON_UNIT, U2],
    ];
    for (const [member, unit] of members) await harness.seedMembership(T, member, unit);
    await harness.seedMembership(T_OTHER, OTHER_TENANT_MEMBER, U1);
    // The custom roles of the guest invitation: what a unit-level administrator of guests would hold.
    for (const [n, code, rank] of [
      [1, 'GUEST_ADMIN', 70],
      [2, 'JUNIOR_INVITER', 10],
    ] as const) await harness.seedRole(T, n, code, ['iam.guest.invite', 'iam.role.grant', ...GUEST_ROLE_PERMISSIONS], rank);
    await harness.seedRole(T, 3, 'DIRECTORY_READER', ['membership.read'], 1);
    await harness.seedRole(T, 4, 'GUEST_GRANTER', ['iam.role.grant', ...GUEST_ROLE_PERMISSIONS], 70);
    await harness.seedRole(T, 5, 'GUEST_INVITER', ['iam.guest.invite'], 10);
    for (const row of await admin<{ id: string; code: string }>('select id, code from machvon.role_definition where tenant_id = $1', [T])) roles.set(row.code, row.id);
    await seedContracts();
    await giveRole(ADMIN, 'TENANT_OWNER', 'TENANT');
    await giveRole(ADMIN, 'MEMBER', 'TENANT');
    await giveRole(UNIT_GUEST_ADMIN, 'GUEST_ADMIN', 'UNIT_SUBTREE', [unitId(U2)]);
    await giveRole(UNIT_GUEST_ADMIN, 'MEMBER', 'TENANT');
    await giveRole(CONTRACT_GUEST_ADMIN, 'GUEST_ADMIN', 'CONTRACT', [CT_A1]);
    await giveRole(CONTRACT_GUEST_ADMIN, 'MEMBER', 'TENANT');
    await giveRole(JUNIOR, 'JUNIOR_INVITER', 'TENANT');
    await giveRole(JUNIOR, 'MEMBER', 'TENANT');
    await giveRole(UNIT_ADMIN, 'UNIT_ADMIN', 'UNIT_SUBTREE', [unitId(U2)]);
    await giveRole(UNIT_ADMIN, 'DIRECTORY_READER', 'UNIT_SUBTREE', [unitId(U2)]);
    await giveRole(UNIT_ADMIN, 'MEMBER', 'TENANT');
    await giveRole(READER, 'AUDITOR', 'TENANT');
    await giveRole(READER, 'MEMBER', 'TENANT');
    await giveRole(GRANT_ON_CONTRACT, 'GUEST_GRANTER', 'CONTRACT', [CT_A1]);
    await giveRole(GRANT_ON_CONTRACT, 'GUEST_INVITER', 'UNIT_SUBTREE', [unitId(U2)]);
    await giveRole(GRANT_ON_CONTRACT, 'MEMBER', 'TENANT');
    await giveRole(GRANT_ON_UNIT, 'GUEST_GRANTER', 'UNIT_SUBTREE', [unitId(U2)]);
    await giveRole(GRANT_ON_UNIT, 'GUEST_INVITER', 'CONTRACT', [CT_A1]);
    await giveRole(GRANT_ON_UNIT, 'MEMBER', 'TENANT');

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

  describe('inviteGuestContractor', () => {
    it('creates an Invited guest membership with a contract grant that ends with the invitation window, and sends the token only to the person', async () => {
      const email = emailOf('first');
      const validUntil = inDays(200);
      const eventsBefore = await countOf("select count(*) as n from machvon.outbox_event where type = 'iam.membership.invited.v1'");
      const reply = await inviteGuest(ADMIN, guestBody({ email, contract_ids: [CT_A2, CT_A1], valid_until: validUntil }));
      expect(reply.status).toBe(201);
      expect(reply.json).toMatchObject({ status: 'INVITED', resource_version: 1 });
      const membershipId = reply.json.resource_id as string;

      const member = await admin<{ status: string; membership_type: string; contractor_id: string; organization_id: string; valid_until: Date }>(
        'select status, membership_type, contractor_id, organization_id, valid_until from machvon.membership where id = $1',
        [membershipId],
      );
      expect(member[0]).toMatchObject({ status: 'Invited', membership_type: 'GUEST_CONTRACTOR', contractor_id: CONTRACTOR, organization_id: unitId(U2) });
      expect(member[0]?.valid_until.toISOString()).toBe(validUntil);

      const grants = await admin<{ code: string; scope_kind: string; scope_ref_ids: string[]; effective_until: Date; status: string }>(
        `select r.code, g.scope_kind, g.scope_ref_ids, g.effective_until, g.status from machvon.role_grant g join machvon.role_definition r on r.id = g.role_id where g.membership_id = $1`,
        [membershipId],
      );
      // The role of the invitation and the self-service baseline (MEMBER), both on the contracts and both ending with the invitation window.
      expect(grants.map((grant) => grant.code).sort()).toEqual(['GUEST_CONTRACTOR', 'MEMBER']);
      for (const grant of grants) {
        expect(grant).toMatchObject({ scope_kind: 'CONTRACT', status: 'Active' });
        expect([...grant.scope_ref_ids].sort()).toEqual([CT_A1, CT_A2].sort());
        expect(grant.effective_until.toISOString()).toBe(validUntil);
      }

      const message = mailer.lastTo(email);
      expect(message?.tenantId).toBe(T);
      const invitation = await admin<{ status: string; token_hash: string }>('select status, token_hash from machvon.membership_invitation where id = $1', [message?.invitationId]);
      expect(invitation[0]?.status).toBe('Pending');
      expect(invitation[0]?.token_hash).not.toBe(message?.token);

      expect(await countOf("select count(*) as n from machvon.outbox_event where type = 'iam.membership.invited.v1'")).toBe(eventsBefore + 1);
      const outbox = await admin<{ payload: Record<string, unknown> }>("select payload from machvon.outbox_event where type = 'iam.membership.invited.v1' and aggregate_id = $1", [membershipId]);
      expect(outbox[0]?.payload).toMatchObject({ membership_id: membershipId, type: 'GUEST_CONTRACTOR', unit_id: unitId(U2) });
      expect(await countOf("select count(*) as n from machvon.audit_event where action = 'membership.guest_invited' and resource_id = $1", [membershipId])).toBe(1);
    });

    it('keeps the email and the token out of the audit trail and the outbox', async () => {
      const email = emailOf('private');
      expect((await inviteGuest(ADMIN, guestBody({ email }))).status).toBe(201);
      const token = mailer.lastTo(email)?.token ?? '';
      const audit = await admin<{ text: string }>("select row_to_json(a)::text as text from machvon.audit_event a where action = 'membership.guest_invited' order by seq desc limit 1");
      const outbox = await admin<{ text: string }>("select row_to_json(o)::text as text from machvon.outbox_event o where type = 'iam.membership.invited.v1' order by created_at desc limit 1");
      for (const row of [audit[0]?.text ?? '', outbox[0]?.text ?? '']) {
        expect(row).not.toContain(email);
        expect(row).not.toContain(token);
      }
    });

    it('replays the stored answer for the same key and body, and refuses the same key with another body', async () => {
      const body = guestBody();
      const first = await inviteGuest(ADMIN, body, { key: 'guest-replay-0123456789' });
      const sent = mailer.sent.length;
      const second = await inviteGuest(ADMIN, body, { key: 'guest-replay-0123456789' });
      expect(second.status).toBe(201);
      expect(second.headers.get('idempotency-replayed')).toBe('true');
      expect(second.json.resource_id).toBe(first.json.resource_id);
      expect(mailer.sent).toHaveLength(sent);
      const conflict = await inviteGuest(ADMIN, { ...body, contract_ids: [CT_A2] }, { key: 'guest-replay-0123456789' });
      expect(conflict.status).toBe(409);
      expect(conflict.json.code).toBe('IDEMPOTENCY_CONFLICT');
    });

    it('refuses a person who already holds a live membership in the unit, and leaves nothing behind', async () => {
      const body = guestBody({ email: emailOf('twice') });
      expect((await inviteGuest(ADMIN, body)).status).toBe(201);
      await unchanged(async () => {
        const again = await inviteGuest(ADMIN, body);
        expect(again.status).toBe(409);
        expect(again.json.code).toBe('MEMBERSHIP_EXISTS');
      });
    });

    it('lets the guest read their own session after accepting: the baseline self-service rights come with the invitation', async () => {
      const email = emailOf('self-service');
      const reply = await inviteGuest(ADMIN, guestBody({ email }));
      expect(reply.status).toBe(201);
      const message = mailer.lastTo(email);
      const accepted = await send('POST', `/memberships/invitations/${message?.invitationId}/accept`, identityToken({ sub: `sub-guest-${email}`, email }), { token: message?.token });
      expect(accepted.status).toBe(200);
      const token = accepted.json.access_token as string;
      expect((await send('GET', '/me/effective-access', token, undefined)).status).toBe(200);
    });

    it('puts the guest in the unit that owns the first contract by id, not in the first unit by id', async () => {
      const lowest = id(0x51, 0);
      const seeding = new Client({ connectionString: harness.database.adminUrl });
      await seeding.connect();
      try {
        // As in seedContracts: foreign keys to unrelated modules are out of scope here.
        await seeding.query('set session_replication_role = replica');
        await seeding.query(
          `insert into machvon.contract (tenant_id, id, project_id, package_id, contractor_id, code, type, currency, status, version, contract_value_vnd, signed_on, effective_from, completion_due)
           values ($1, $2, $3, $4, $5, 'GC-LOW', 'LUMP_SUM', 'VND', 'ACTIVE', 1, 1000, '2026-01-01', '2026-01-01', '2027-03-31')`,
          [T, lowest, PROJECT_U3, id(0x53, 1), CONTRACTOR],
        );
      } finally {
        await seeding.end();
      }
      try {
        // The lowest contract id belongs to unit 3, the lowest unit id to unit 2.
        const reply = await inviteGuest(ADMIN, guestBody({ contract_ids: [CT_A1, lowest] }));
        expect(reply.status).toBe(201);
        const member = await admin<{ organization_id: string }>('select organization_id from machvon.membership where id = $1', [reply.json.resource_id]);
        expect(member[0]?.organization_id).toBe(unitId(U3));
      } finally {
        await admin('delete from machvon.contract where tenant_id = $1 and id = $2', [T, lowest]);
      }
    });

    describe('the right to invite and the right to grant are judged on their own scopes', () => {
      it('accepts a caller who grants roles on the contract and invites guests on the unit subtree that owns it', async () => {
        expect((await inviteGuest(GRANT_ON_CONTRACT, guestBody({ contract_ids: [CT_A1] }))).status).toBe(201);
      });

      it('accepts a caller who grants roles on the unit subtree and invites guests on the contract', async () => {
        expect((await inviteGuest(GRANT_ON_UNIT, guestBody({ contract_ids: [CT_A1] }))).status).toBe(201);
      });

      it('still refuses the contracts that neither of the two invite grants covers', async () => {
        await unchanged(async () => {
          const reply = await inviteGuest(GRANT_ON_UNIT, guestBody({ contract_ids: [CT_A2] }));
          expect([reply.status, reply.json.code]).toEqual([403, 'SCOPE_DENIED']);
        });
      });
    });

    describe('what a guest may be given (BR-IAM-08)', () => {
      it('refuses a contract of another contractor: GUEST_SCOPE_INVALID (AC-ST-ADM-007-1)', async () => {
        await unchanged(async () => {
          const reply = await inviteGuest(ADMIN, guestBody({ contract_ids: [CT_A1, CT_FOREIGN] }));
          expect(reply.status).toBe(422);
          expect(reply.json.code).toBe('GUEST_SCOPE_INVALID');
        });
      });

      it('refuses a contract that is not in force: CONTRACT_NOT_ACTIVE for a draft and a closed one', async () => {
        for (const contract of [CT_DRAFT, CT_CLOSED]) {
          await unchanged(async () => {
            const reply = await inviteGuest(ADMIN, guestBody({ contract_ids: [CT_A1, contract] }));
            expect(reply.status).toBe(422);
            expect(reply.json.code).toBe('CONTRACT_NOT_ACTIVE');
          });
        }
      });

      it('refuses a contract that does not exist', async () => {
        for (const contract of [randomUUID(), id(0x51, 99)]) {
          await unchanged(async () => {
            const reply = await inviteGuest(ADMIN, guestBody({ contract_ids: [contract] }));
            expect(reply.status).toBe(422);
            expect(reply.json).toMatchObject({ code: 'VALIDATION_FAILED' });
          });
        }
      });

      it('refuses a role that guests may not hold: GUEST_SCOPE_INVALID (AC-ST-ADM-007-1)', async () => {
        await unchanged(async () => {
          const reply = await inviteGuest(ADMIN, guestBody({ role_id: roles.get('UNIT_ADMIN') }));
          expect(reply.status).toBe(422);
          expect(reply.json.code).toBe('GUEST_SCOPE_INVALID');
        });
      });

      it('refuses a role that does not exist with 404', async () => {
        await unchanged(async () => {
          expect((await inviteGuest(ADMIN, guestBody({ role_id: randomUUID() }))).status).toBe(404);
        });
      });

      it('refuses a retired role', async () => {
        await admin("update machvon.role_definition set status = 'Retired' where id = $1", [roles.get('MEMBER')]);
        try {
          await unchanged(async () => {
            const reply = await inviteGuest(ADMIN, guestBody({ role_id: roles.get('MEMBER') }));
            expect(reply.status).toBe(422);
            expect(reply.json).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'role_id' });
          });
        } finally {
          await admin("update machvon.role_definition set status = 'Active' where id = $1", [roles.get('MEMBER')]);
        }
      });

      it('refuses a body without the fields the design requires, and an empty contract list or an unknown field', async () => {
        for (const missing of ['email', 'contractor_id', 'contract_ids', 'role_id', 'valid_until']) {
          const body = guestBody();
          delete body[missing];
          const reply = await inviteGuest(ADMIN, body);
          expect(reply.status).toBe(400);
          expect(reply.json.code).toBe('INVALID_REQUEST');
        }
        const empty = await inviteGuest(ADMIN, guestBody({ contract_ids: [] }));
        expect([empty.status, empty.json.code]).toEqual([422, 'VALIDATION_FAILED']);
        const unknown = await inviteGuest(ADMIN, guestBody({ unexpected: true }));
        expect([unknown.status, unknown.json.code]).toEqual([400, 'FIELD_NOT_ALLOWED']);
      });
    });

    describe('valid_until is required and bounded', () => {
      const detailOf = (reply: Reply): unknown => reply.json.detail;

      it('refuses a moment in the past or now', async () => {
        for (const until of [inDays(-1), new Date().toISOString()]) {
          const reply = await inviteGuest(ADMIN, guestBody({ valid_until: until }));
          expect(reply.status).toBe(422);
          expect(reply.json.code).toBe('VALIDATION_FAILED');
          expect(detailOf(reply)).toBe('valid_until');
        }
      });

      it('allows up to 365 days after the latest end of the contracts, and refuses a day more', async () => {
        const bound = CT_COMPLETION + 365 * DAY_MS;
        expect((await inviteGuest(ADMIN, guestBody({ valid_until: new Date(bound).toISOString() }))).status).toBe(201);
        const over = await inviteGuest(ADMIN, guestBody({ valid_until: new Date(bound + DAY_MS).toISOString() }));
        expect(over.status).toBe(422);
        expect(detailOf(over)).toBe('valid_until');
      });

      it('counts from today when none of the contracts has an end date, and from the latest end otherwise', async () => {
        // CT_A1 ends 2027-03-31 so the pair is bounded by that; CT_A2 has no end date, so alone it is bounded from today.
        const bound = Date.now() + 365 * DAY_MS;
        expect((await inviteGuest(ADMIN, guestBody({ contract_ids: [CT_A1, CT_A2], valid_until: new Date(bound - DAY_MS).toISOString() }))).status).toBe(201);
        const over = await inviteGuest(ADMIN, guestBody({ contract_ids: [CT_A2], valid_until: new Date(bound + 2 * DAY_MS).toISOString() }));
        expect(over.status).toBe(422);
        expect(detailOf(over)).toBe('valid_until');
      });

      it('counts a contract that already ended from today, so a completed contract still allows a year of access', async () => {
        const bound = Date.now() + 365 * DAY_MS;
        expect((await inviteGuest(ADMIN, guestBody({ contract_ids: [CT_DONE], valid_until: new Date(bound - DAY_MS).toISOString() }))).status).toBe(201);
        const over = await inviteGuest(ADMIN, guestBody({ contract_ids: [CT_DONE], valid_until: new Date(bound + 2 * DAY_MS).toISOString() }));
        expect(over.status).toBe(422);
        expect(detailOf(over)).toBe('valid_until');
      });
    });

    describe('who may invite, and where', () => {
      it('lets a guest administrator of a unit invite for the contracts of projects of that subtree', async () => {
        const reply = await inviteGuest(UNIT_GUEST_ADMIN, guestBody({ contract_ids: [CT_A1, CT_A2] }));
        expect(reply.status).toBe(201);
        const grant = await admin<{ granted_by: string }>('select granted_by from machvon.role_grant where membership_id = $1', [reply.json.resource_id]);
        expect(grant[0]?.granted_by).toBe(memberId(UNIT_GUEST_ADMIN));
      });

      it('refuses the contracts of a project outside the subtree with 403, and a mix of inside and outside', async () => {
        for (const contracts of [[CT_B1], [CT_A1, CT_B1]]) {
          await unchanged(async () => {
            const reply = await inviteGuest(UNIT_GUEST_ADMIN, guestBody({ contract_ids: contracts }));
            expect(reply.status).toBe(403);
            expect(reply.json.code).toBe('SCOPE_OUT_OF_GRANTOR_RANGE');
          });
        }
      });

      it('lets a caller bound to one contract invite for that contract only', async () => {
        expect((await inviteGuest(CONTRACT_GUEST_ADMIN, guestBody({ contract_ids: [CT_A1] }))).status).toBe(201);
        await unchanged(async () => {
          const reply = await inviteGuest(CONTRACT_GUEST_ADMIN, guestBody({ contract_ids: [CT_A1, CT_A2] }));
          expect(reply.status).toBe(403);
          expect(reply.json.code).toBe('SCOPE_OUT_OF_GRANTOR_RANGE');
        });
      });

      it('applies the anti-escalation rule: a caller of the rank of the guest role cannot hand it out', async () => {
        await unchanged(async () => {
          const reply = await inviteGuest(JUNIOR, guestBody());
          expect(reply.status).toBe(403);
          expect(reply.json.code).toBe('ROLE_ESCALATION_DENIED');
        });
      });

      it('refuses a caller who manages members but holds no permission to invite guests, with a DENIED audit row', async () => {
        const before = await countOf("select count(*) as n from machvon.audit_event where action = 'authz.denied:inviteGuestContractor' and outcome = 'DENIED'");
        await unchanged(async () => {
          const reply = await inviteGuest(UNIT_ADMIN, guestBody());
          expect(reply.status).toBe(403);
          expect(reply.json.code).toBe('SCOPE_DENIED');
        });
        expect(await countOf("select count(*) as n from machvon.audit_event where action = 'authz.denied:inviteGuestContractor' and outcome = 'DENIED'")).toBe(before + 1);
      });

      it('refuses a read-only caller', async () => {
        const reply = await inviteGuest(READER, guestBody());
        expect(reply.status).toBe(403);
        expect(reply.json.code).toBe('SCOPE_DENIED');
      });

      it('requires a session', async () => {
        expect((await send('POST', '/guest-memberships', undefined, guestBody())).status).toBe(401);
      });
    });

    describe('the guest seats of the licence', () => {
      it('refuses to invite a guest when no guest seat is left (403 QUOTA_EXCEEDED), writes nothing, and invites once the licence allows one', async () => {
        const email = emailOf('no-guest-seat');
        const members = async (): Promise<number> => Number((await admin<{ n: string }>('select count(*) as n from machvon.membership where tenant_id = $1', [T]))[0]?.n);
        const before = await members();
        await admin('delete from machvon.license_revision where tenant_id = $1', [T]);
        const client = new Client({ connectionString: harness.database.adminUrl });
        await client.connect();
        try {
          await client.query('set session_replication_role = replica');
          await client.query(
            `insert into machvon.license_revision (tenant_id, id, serial, revision, entitlement_version_id, valid_from, valid_until, grace_until, status, signed_claims, key_id, seats, quota_json)
             values ($1, $2, 'guest-invite-serial', 1, $3, now() - interval '1 day', now() + interval '1 year', now() + interval '2 years', 'Active', 'claims', 'key-1', 100, '{"guest_seats": 0}'::jsonb)`,
            [T, randomUUID(), randomUUID()],
          );
        } finally {
          await client.end();
        }
        const refused = await inviteGuest(ADMIN, guestBody({ email }));
        expect([refused.status, refused.json.code]).toEqual([403, 'QUOTA_EXCEEDED']);
        expect(await members()).toBe(before);
        expect(mailer.lastTo(email)).toBeUndefined();

        await admin('delete from machvon.license_revision where tenant_id = $1', [T]);
        expect((await inviteGuest(ADMIN, guestBody({ email }))).status).toBe(201);
        expect(await members()).toBe(before + 1);
      });
    });

    describe('the seats of staff and of guests, one meter each (UAT-AC114)', () => {
      it('UAT-AC114 with every staff seat in use a new staff invitation is 403 QUOTA_EXCEEDED naming the meter, the seats used and the limit, a guest is still invited (the guest meter is apart), and once a membership ends the staff invitation is accepted', async () => {
        const staffInUse = (): Promise<number> => countOf("select count(*) as n from machvon.membership where tenant_id = $1 and status = 'Active' and membership_type = 'STAFF'", [T]);
        // One more Active staff member that no other case uses, so that ending it frees a seat without touching the people of the other cases.
        await harness.seedMembership(T, 90, U2);
        const seats = await staffInUse();
        await admin('delete from machvon.license_revision where tenant_id = $1', [T]);
        const client = new Client({ connectionString: harness.database.adminUrl });
        await client.connect();
        try {
          await client.query('set session_replication_role = replica');
          await client.query(
            `insert into machvon.license_revision (tenant_id, id, serial, revision, entitlement_version_id, valid_from, valid_until, grace_until, status, signed_claims, key_id, seats, quota_json)
             values ($1, $2, 'uat-ac114', 1, $3, now() - interval '1 day', now() + interval '1 year', now() + interval '2 years', 'Active', 'claims', 'key-1', $4, '{"guest_seats": 5}'::jsonb)`,
            [T, randomUUID(), randomUUID(), seats],
          );
        } finally {
          await client.end();
        }
        try {
          const invitations = (): Promise<number> => countOf('select count(*) as n from machvon.membership_invitation where tenant_id = $1', [T]);
          const before = await invitations();
          // Step 1: the fourth person of the design (here, the one after the last free seat) is refused with the facts of the meter, and nothing is written.
          const staffBody = { email: emailOf('staff-full'), organization_unit_id: unitId(U2) };
          const full = await as(ADMIN, 'POST', '/memberships/invitations', staffBody);
          expect([full.status, full.json.code, full.json.feature, full.json.used, full.json.limit]).toEqual([403, 'QUOTA_EXCEEDED', 'seats', seats, seats]);
          expect(await invitations()).toBe(before);
          // Step 2: a guest contractor is counted on the guest meter, which has room: 201.
          const guest = await inviteGuest(ADMIN, guestBody({ email: emailOf('guest-meter') }));
          expect(guest.status).toBe(201);
          expect(await invitations()).toBe(before + 1);
          // Step 3: one membership ends (the seat is free again) and the same invitation goes through.
          const row = (await admin<{ version: string }>('select version::text from machvon.membership where id = $1', [memberId(90)]))[0];
          const ended = await as(ADMIN, 'POST', `/memberships/${memberId(90)}/end`, { reason: 'the person left the unit for good' }, { ifMatch: `"${row?.version}"` });
          expect(ended.status).toBe(200);
          expect(await staffInUse()).toBe(seats - 1);
          expect((await as(ADMIN, 'POST', '/memberships/invitations', staffBody)).status).toBe(201);
          // The negative control: a check that wants the full meter to be accepted must fail on the first answer.
          expect(() => expect(full.status).toBe(201)).toThrow();
        } finally {
          await admin('delete from machvon.license_revision where tenant_id = $1', [T]);
        }
      });
    });

    describe('the invitation of a guest is accepted like any other', () => {
      it('activates the membership, and the licence limit of guest seats applies at acceptance', async () => {
        const email = emailOf('accepting');
        const reply = await inviteGuest(ADMIN, guestBody({ email }));
        const message = mailer.lastTo(email);
        const accept = (): Promise<Reply> =>
          send('POST', `/memberships/invitations/${message?.invitationId}/accept`, identityToken({ sub: `sub-guest-${email}`, email }), { token: message?.token });

        await admin('delete from machvon.license_revision where tenant_id = $1', [T]);
        const client = new Client({ connectionString: harness.database.adminUrl });
        await client.connect();
        try {
          await client.query('set session_replication_role = replica');
          await client.query(
            `insert into machvon.license_revision (tenant_id, id, serial, revision, entitlement_version_id, valid_from, valid_until, grace_until, status, signed_claims, key_id, seats, quota_json)
             values ($1, $2, 'guest-serial', 1, $3, now() - interval '1 day', now() + interval '1 year', now() + interval '2 years', 'Active', 'claims', 'key-1', 100, '{"guest_seats": 0}'::jsonb)`,
            [T, randomUUID(), randomUUID()],
          );
        } finally {
          await client.end();
        }
        const refused = await accept();
        expect(refused.status).toBe(403);
        expect(refused.json.code).toBe('QUOTA_EXCEEDED');

        await admin('delete from machvon.license_revision where tenant_id = $1', [T]);
        const accepted = await accept();
        expect(accepted.status).toBe(200);
        expect(accepted.json).toMatchObject({ tenant_id: T, membership_id: reply.json.resource_id });
        expect((await admin<{ status: string }>('select status from machvon.membership where id = $1', [reply.json.resource_id]))[0]?.status).toBe('Active');
      });
    });
  });

  describe('the contract picker (get_resources_contract)', () => {
    const contracts = async (n: number, query = ''): Promise<Reply & { items: Array<Record<string, unknown>> }> => {
      const reply = await as(n, 'GET', `/resources/contract${query}`, undefined);
      return { ...reply, items: (reply.json.items as Array<Record<string, unknown>> | undefined) ?? [] };
    };
    const codesOf = (items: Array<Record<string, unknown>>): unknown[] => items.map((item) => item.code);

    it('lists every contract of the tenant for a reader of the whole tenant, with the contractor and the owner unit', async () => {
      const { status, items } = await contracts(ADMIN, '?limit=200');
      expect(status).toBe(200);
      expect(codesOf(items)).toEqual(['GC-A1', 'GC-A2', 'GC-B1', 'GC-C', 'GC-D', 'GC-E', 'GC-X']);
      // The register of CTR (ST-CTR-001) took the read over from the picker: the fields the picker read are all still there.
      expect(items[0]).toMatchObject({
        id: CT_A1,
        code: 'GC-A1',
        status: 'ACTIVE',
        contractor_id: CONTRACTOR,
        contractor_name: 'Cao Bang Builders',
        project_id: PROJECT_U2,
        owner_unit_id: unitId(U2),
        completion_due: '2027-03-31',
      });
      expect(items.find((item) => item.code === 'GC-A2')).toMatchObject({ status: 'SIGNED', completion_due: null });
      expect(items.find((item) => item.code === 'GC-X')).toMatchObject({ contractor_id: OTHER_CONTRACTOR, contractor_name: 'Other Builders' });
    });

    it('pages with an opaque cursor', async () => {
      const first = await contracts(ADMIN, '?limit=3');
      expect(codesOf(first.items)).toEqual(['GC-A1', 'GC-A2', 'GC-B1']);
      expect(typeof first.json.next_cursor).toBe('string');
      const second = await contracts(ADMIN, `?limit=3&cursor=${first.json.next_cursor as string}`);
      expect(codesOf(second.items)).toEqual(['GC-C', 'GC-D', 'GC-E']);
      const last = await contracts(ADMIN, `?limit=3&cursor=${second.json.next_cursor as string}`);
      expect(codesOf(last.items)).toEqual(['GC-X']);
      expect(last.json.next_cursor).toBeNull();
    });

    it('limits a unit-level reader to the contracts of projects in their subtree', async () => {
      const { items } = await contracts(UNIT_GUEST_ADMIN, '?limit=200');
      expect(codesOf(items)).toEqual(['GC-A1', 'GC-A2', 'GC-C', 'GC-D', 'GC-E', 'GC-X']);
      expect(items.every((item) => item.owner_unit_id === unitId(U2))).toBe(true);
    });

    it('shows a reader whose grants are bound to a contract that contract and no other (ST-CTR-001: a contract grant reaches its contract)', async () => {
      const { status, items } = await contracts(CONTRACT_GUEST_ADMIN);
      expect(status).toBe(200);
      expect(codesOf(items)).toEqual(['GC-A1']);
    });

    it('refuses a caller without contract.read, and a malformed page request', async () => {
      const refused = await contracts(READER);
      expect(refused.status).toBe(403);
      expect(refused.json.code).toBe('SCOPE_DENIED');
      const bad = await contracts(ADMIN, '?limit=0');
      expect([bad.status, bad.json.code]).toEqual([422, 'VALIDATION_FAILED']);
    });
  });

  describe('the member directory (ADM-02 and ADM-17 reads)', () => {
    const list = async (n: number, query = ''): Promise<{ status: number; items: Array<Record<string, unknown>> }> => {
      const reply = await as(n, 'GET', `/resources/membership${query}`, undefined);
      return { status: reply.status, items: (reply.json.items as Array<Record<string, unknown>> | undefined) ?? [] };
    };

    it('lists the roles in force and the invitation of each member', async () => {
      const { items } = await list(ADMIN, '?limit=200');
      const admin1 = items.find((item) => item.id === memberId(ADMIN));
      expect(admin1).toMatchObject({ version: 1, role_codes: ['MEMBER', 'TENANT_OWNER'], invitation_status: null, contractor_id: null, contractor_name: null, contracts: [] });
    });

    it('filters by membership type and shows the contractor, the contracts and the pending invitation of a guest', async () => {
      const email = emailOf('listed');
      const reply = await inviteGuest(ADMIN, guestBody({ email, contract_ids: [CT_A1, CT_A2] }));
      const { items } = await list(ADMIN, '?membership_type=GUEST_CONTRACTOR&limit=200');
      expect(items.length).toBeGreaterThan(0);
      expect(items.every((item) => item.membership_type === 'GUEST_CONTRACTOR')).toBe(true);
      const row = items.find((item) => item.id === reply.json.resource_id);
      expect(row).toMatchObject({
        status: 'Invited',
        role_codes: ['GUEST_CONTRACTOR', 'MEMBER'],
        invitation_status: 'Pending',
        contractor_id: CONTRACTOR,
        contractor_name: 'Cao Bang Builders',
        contracts: [
          { id: CT_A1, code: 'GC-A1' },
          { id: CT_A2, code: 'GC-A2' },
        ],
      });
      const staff = await list(ADMIN, '?membership_type=STAFF&limit=200');
      expect(staff.items.every((item) => item.membership_type === 'STAFF')).toBe(true);
      expect(staff.items.some((item) => item.id === reply.json.resource_id)).toBe(false);
    });

    it('shows a unit administrator only the members of their subtree, and only the contracts they reach', async () => {
      const reply = await inviteGuest(ADMIN, guestBody({ contract_ids: [CT_A1, CT_B1] }));
      const { items } = await list(UNIT_ADMIN, '?limit=200');
      expect(items.length).toBeGreaterThan(0);
      expect(items.some((item) => item.id === memberId(ADMIN))).toBe(false);
      // The guest sits in unit 2 (the owner of the first contract) and is visible; the contract of unit 3 is not shown.
      const row = items.find((item) => item.id === reply.json.resource_id);
      expect(row?.contracts).toEqual([{ id: CT_A1, code: 'GC-A1' }]);
    });

    it('refuses an unknown membership type', async () => {
      const reply = await as(ADMIN, 'GET', '/resources/membership?membership_type=ROBOT', undefined);
      expect(reply.status).toBe(422);
      expect(reply.json).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'membership_type' });
    });

    it('does not show members of another tenant', async () => {
      const { items } = await list(ADMIN, '?limit=200');
      expect(items.some((item) => item.id === memberId(OTHER_TENANT_MEMBER))).toBe(false);
    });
  });
});
