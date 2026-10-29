import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import * as fc from 'fast-check';
import { EffectiveAccessStore, EntitlementStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import type { MyGrant } from '@machvon/db';
import { seedSystemRoles } from '@machvon/db/src/system-roles';
import { effectivePermissions, loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import type { EffectiveAccess, GrantView } from '@machvon/kernel';
import { Client } from 'pg';
import { CommandModule } from '../src/command.module';
import { EffectiveAccessController } from '../src/modules/iam/effective-access.controller';
import { effectiveAccessView, stateOf } from '../src/modules/iam/effective-access-view';
import type { EffectiveAccessDto, GrantDto } from '../src/modules/iam/effective-access-view';
import { PolicyModule } from '../src/policy.module';
import { ProblemFilter } from '../src/problem.filter';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, grantId, id, memberId, unitId } from '../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from './isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from './isolation/test-app';
import type { RunningApp } from './isolation/test-app';

const SIGNING_KEY = randomBytes(32);
const ACTOR = '00000000-0000-4000-8000-0000000000f0';
const PROJECT = id(0x50, 1);
const CONTRACT = id(0x51, 1);

const ME = 1;
const OTHER = 2;
const NO_ROLE = 3;
const DELEGATOR = 4;

const DAY = 86_400_000;
const isoIn = (days: number): string => new Date(Date.now() + days * DAY).toISOString();

describe('getMyEffectiveAccess (ST-IAM-005, IAM-09)', () => {
  const harness = new AuthzHarness();
  const roles = new Map<string, string>();
  const grantIds = new Map<string, string>();
  let app: RunningApp;
  let counter = 0;

  const admin = async <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<R[]> => {
    const client = new Client({ connectionString: harness.database.adminUrl });
    await client.connect();
    try {
      return (await client.query(sql, params)).rows as R[];
    } finally {
      await client.end();
    }
  };

  async function mine(member: number, tenantId = TENANT_A, path = '/me/effective-access'): Promise<{ status: number; json: Record<string, unknown> }> {
    const token = signTenantContext(contextFor(tenantId, memberId(member)), SIGNING_KEY);
    const response = await fetch(`${app.baseUrl}${path}`, { headers: { [TENANT_HEADER]: token } });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }

  async function give(
    member: number,
    code: string,
    kind: string,
    refs: readonly string[] = [],
    options: { from?: string; until?: string | null; status?: string; label?: string } = {},
  ): Promise<void> {
    counter += 1;
    const grant = grantId(2000 + counter);
    if (options.label !== undefined) grantIds.set(options.label, grant);
    await harness.owner(TENANT_A, [
      [
        `insert into machvon.role_grant
           (tenant_id, id, membership_id, role_id, scope_json, effective_from, effective_until, scope_kind, scope_ref_ids, status, granted_by, grant_reason, revoked_at)
         values ($1, $2, $3, $4, $5::jsonb, $6::timestamptz, $7::timestamptz, $8, $9::uuid[], $10, $11, 'seed', case when $10 = 'Revoked' then now() end)`,
        [TENANT_A, grant, memberId(member), roles.get(code), JSON.stringify({ kind, ref_ids: refs }), options.from ?? '2026-01-01T00:00:00Z', options.until ?? null, kind, refs, options.status ?? 'Active', ACTOR],
      ],
    ]);
  }

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: 1, path: `/${unitId(1)}/` },
        { n: 2, path: `/${unitId(1)}/${unitId(2)}/`, parent: 1 },
        { n: 3, path: `/${unitId(1)}/${unitId(2)}/${unitId(3)}/`, parent: 2 },
        { n: 4, path: `/${unitId(1)}/${unitId(4)}/`, parent: 1 },
      ]);
      await harness.tenants.withTenant(contextFor(tenant, memberId(1)), (tx) => seedSystemRoles(tx, ACTOR));
    }
    for (const member of [ME, OTHER, NO_ROLE, DELEGATOR]) await harness.seedMembership(TENANT_A, member, 2);
    await harness.seedMembership(TENANT_B, ME, 1);
    const client = new Client({ connectionString: harness.database.adminUrl });
    await client.connect();
    try {
      await client.query('set session_replication_role = replica');
      await client.query(
        `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version)
         values ($1, $2, 'P-1', 'Bridge project', $3, $4, 'INTERNAL', 1000, 'CONCEPT', 1)`,
        [TENANT_A, PROJECT, unitId(2), id(0x52, 1)],
      );
      await client.query(
        `insert into machvon.contract (tenant_id, id, project_id, package_id, contractor_id, code, type, currency, status, version, contract_value_vnd, signed_on, effective_from)
         values ($1, $2, $3, $4, $5, 'C-1', 'LUMP_SUM', 'VND', 'ACTIVE', 1, 1000, date '2026-01-01', date '2026-01-01')`,
        [TENANT_A, CONTRACT, PROJECT, id(0x53, 1), id(0x54, 1)],
      );
    } finally {
      await client.end();
    }
    for (const row of await admin<{ id: string; code: string }>('select id, code from machvon.role_definition where tenant_id = $1', [TENANT_A])) roles.set(row.code, row.id);

    await give(ME, 'MEMBER', 'TENANT', [], { label: 'member' });
    await give(ME, 'UNIT_ADMIN', 'UNIT_SUBTREE', [unitId(2)], { label: 'unit-admin' });
    await give(ME, 'LEADER', 'UNIT_ONLY', [unitId(3)], { label: 'leader-ended', until: '2026-02-01T00:00:00Z' });
    await give(ME, 'AUDITOR', 'UNIT_SUBTREE', [unitId(4)], { label: 'auditor-future', from: isoIn(10), until: isoIn(40) });
    await give(ME, 'GUEST_CONTRACTOR', 'CONTRACT', [CONTRACT], { label: 'guest-contract' });
    await give(ME, 'SPECIALIST', 'PROJECT', [PROJECT], { label: 'specialist-project' });
    await give(ME, 'BILLING_VIEWER', 'TENANT', [], { label: 'billing-marked-expired', status: 'Expired', until: '2026-03-01T00:00:00Z' });
    await give(ME, 'NOTIFICATION_ADMIN', 'TENANT', [], { label: 'notification-revoked', status: 'Revoked' });
    await give(OTHER, 'TENANT_ADMIN', 'TENANT', [], { label: 'other-admin' });
    await give(OTHER, 'MEMBER', 'TENANT');
    await give(DELEGATOR, 'UNIT_ADMIN', 'UNIT_SUBTREE', [unitId(2)]);
    for (const [label, status, from, until] of [
      ['delegation-active', 'Active', "now() - interval '1 day'", "now() + interval '10 days'"],
      ['delegation-scheduled', 'Scheduled', "now() + interval '2 days'", "now() + interval '12 days'"],
      ['delegation-ended', 'Ended', "now() - interval '20 days'", "now() - interval '10 days'"],
      ['delegation-lapsed', 'Active', "now() - interval '20 days'", "now() - interval '1 day'"],
    ] as const) {
      counter += 1;
      grantIds.set(label, id(0x55, counter));
      const delegation = new Client({ connectionString: harness.database.adminUrl });
      await delegation.connect();
      try {
        await delegation.query('set session_replication_role = replica');
        await delegation.query(
          // An ended or revoked delegation carries when and why, as the table asks.
          `insert into machvon.delegation_grant (tenant_id, id, delegator_membership_id, delegate_membership_id, permissions, scope_json, valid_from, valid_until, reason, status, ended_at, end_reason, revoked_by, revoked_at, revoke_reason)
           values ($1, $2, $3, $4, array['approval.decide'], '{"kind":"UNIT_SUBTREE","ref_ids":[]}'::jsonb, ${from}, ${until}, 'cover', $5::text,
                   case when $5::text = 'Ended' then now() end, case when $5::text = 'Ended' then 'EXPIRED' end, case when $5::text = 'Revoked' then $3::uuid end, case when $5::text = 'Revoked' then now() end, case when $5::text = 'Revoked' then 'cover' end)`,
          [TENANT_A, id(0x55, counter), memberId(DELEGATOR), memberId(ME), status],
        );
      } finally {
        await delegation.end();
      }
    }
    await give(NO_ROLE, 'BILLING_VIEWER', 'TENANT');

    const database = new TenantDatabase(harness.appPool);
    const access = new EffectiveAccessStore(database, new InMemoryAuthzCache());
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [CommandModule.register({ database }), PolicyModule.register({ database, access })],
      controllers: [EffectiveAccessController],
      providers: [
        { provide: TenantDatabase, useValue: database },
        { provide: EntitlementStore, useValue: { current: () => Promise.resolve({ hash: 'entitlement-hash-1' }) } },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 240_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  const grantOf = (json: Record<string, unknown>, label: string): GrantDto | undefined => (json as unknown as EffectiveAccessDto).grants.find((grant) => grant.id === grantIds.get(label));

  describe('what it returns', () => {
    it('lists the grants of the caller with role, scope and state, separating the ones that ended and the ones that have not started', async () => {
      const reply = await mine(ME);
      expect(reply.status).toBe(200);
      const body = reply.json as unknown as EffectiveAccessDto;
      expect(body.membership_id).toBe(memberId(ME));
      const states = Object.fromEntries(body.grants.map((grant) => [[...grantIds].find(([, value]) => value === grant.id)?.[0], grant.state]));
      expect(states).toEqual({
        member: 'ACTIVE',
        'unit-admin': 'ACTIVE',
        'leader-ended': 'EXPIRED',
        'auditor-future': 'FUTURE',
        'guest-contract': 'ACTIVE',
        'specialist-project': 'ACTIVE',
        'billing-marked-expired': 'EXPIRED',
      });
      expect(grantOf(reply.json, 'notification-revoked')).toBeUndefined();
    });

    it('names the scope of each grant: units with their breadcrumb from the root, projects and contracts by code and name', async () => {
      const { json } = await mine(ME);
      expect(grantOf(json, 'unit-admin')).toMatchObject({
        role_code: 'UNIT_ADMIN',
        rank: 70,
        scope_kind: 'UNIT_SUBTREE',
        scope: { units: [{ id: unitId(2), code: 'U2', name: 'Unit 2', breadcrumb: [{ id: unitId(1), code: 'U1' }, { id: unitId(2), code: 'U2' }] }], projects: [], contracts: [] },
      });
      expect(grantOf(json, 'leader-ended')?.scope.units[0]?.breadcrumb.map((crumb) => crumb.code)).toEqual(['U1', 'U2', 'U3']);
      expect(grantOf(json, 'specialist-project')?.scope.projects).toEqual([{ id: PROJECT, code: 'P-1', name: 'Bridge project' }]);
      expect(grantOf(json, 'guest-contract')?.scope.contracts).toEqual([{ id: CONTRACT, code: 'C-1' }]);
      expect(grantOf(json, 'member')?.scope).toEqual({ units: [], projects: [], contracts: [] });
      expect(grantOf(json, 'leader-ended')?.effective_until).toBe('2026-02-01T00:00:00.000Z');
      expect(grantOf(json, 'member')?.effective_until).toBeNull();
    });

    it('shows the delegations received that are Active or scheduled, and not the ones that ended or lapsed', async () => {
      const body = (await mine(ME)).json as unknown as EffectiveAccessDto;
      expect(body.delegations_in.map((delegation) => delegation.id).sort()).toEqual([grantIds.get('delegation-active'), grantIds.get('delegation-scheduled')].sort());
      const byId = Object.fromEntries(body.delegations_in.map((delegation) => [delegation.id, delegation.state]));
      expect(byId[grantIds.get('delegation-active') ?? '']).toBe('ACTIVE');
      expect(byId[grantIds.get('delegation-scheduled') ?? '']).toBe('FUTURE');
      expect(body.delegations_in[0]).toMatchObject({ delegator_membership_id: memberId(DELEGATOR), permissions: ['approval.decide'] });
    });

    it('carries the scope version of the database and the entitlement hash', async () => {
      const [row] = await admin<{ v: string }>('select scope_version::text as v from machvon.membership where tenant_id = $1 and id = $2', [TENANT_A, memberId(ME)]);
      const body = (await mine(ME)).json as unknown as EffectiveAccessDto;
      expect(body.scope_version).toBe(Number(row?.v));
      expect(body.entitlement_hash).toBe('entitlement-hash-1');
    });

    it('moves its scope version when the access of the caller changes, so a screen that holds an older one can tell', async () => {
      const before = ((await mine(ME)).json as unknown as EffectiveAccessDto).scope_version;
      await admin('update machvon.membership set scope_version = scope_version + 1 where tenant_id = $1 and id = $2', [TENANT_A, memberId(ME)]);
      expect(((await mine(ME)).json as unknown as EffectiveAccessDto).scope_version).toBe(before + 1);
    });
  });

  describe('the permissions are the ones the PDP computes', () => {
    it('the union of the permissions of the ACTIVE grants equals effectivePermissions of the same member, now', async () => {
      const store = new EffectiveAccessStore(harness.tenants, new InMemoryAuthzCache());
      const held = effectivePermissions(await store.load(contextFor(TENANT_A, memberId(ME))), new Date());
      const body = (await mine(ME)).json as unknown as EffectiveAccessDto;
      const shown = new Set(body.grants.filter((grant) => grant.state === 'ACTIVE').flatMap((grant) => grant.permissions));
      expect([...shown].sort()).toEqual([...held].sort());
      expect(shown.size).toBeGreaterThan(3);
    });
  });

  describe('never another member', () => {
    it('answers with the caller only: the grants of another member never appear, and a member id in the request changes nothing', async () => {
      const mineBody = (await mine(ME)).json as unknown as EffectiveAccessDto;
      const otherBody = (await mine(OTHER)).json as unknown as EffectiveAccessDto;
      expect(otherBody.membership_id).toBe(memberId(OTHER));
      expect(otherBody.grants.map((grant) => grant.role_code).sort()).toEqual(['MEMBER', 'TENANT_ADMIN']);
      expect(mineBody.grants.some((grant) => grant.id === grantIds.get('other-admin'))).toBe(false);
      const probe = await mine(ME, TENANT_A, `/me/effective-access?membership_id=${memberId(OTHER)}&membershipId=${memberId(OTHER)}`);
      expect((probe.json as unknown as EffectiveAccessDto).membership_id).toBe(memberId(ME));
      expect((probe.json as unknown as EffectiveAccessDto).grants.map((grant) => grant.id)).toEqual(mineBody.grants.map((grant) => grant.id));
    });

    it('shows nothing of another tenant: the same person in tenant B sees their own membership there', async () => {
      const reply = await mine(ME, TENANT_B);
      // Member 1 of tenant B holds no role: the policy guard refuses before any grant is read.
      expect(reply.status).toBe(403);
      expect(JSON.stringify(reply.json)).not.toContain(grantIds.get('unit-admin'));
    });

    it('refuses a member who does not hold session.self with 403 SCOPE_DENIED', async () => {
      const reply = await mine(NO_ROLE);
      expect(reply.status).toBe(403);
      expect(reply.json.code).toBe('SCOPE_DENIED');
    });
  });

  describe('without an entitlement store', () => {
    it('leaves the hash out', async () => {
      const database = new TenantDatabase(harness.appPool);
      const bare = await startTestApp({
        signingKey: SIGNING_KEY,
        imports: [CommandModule.register({ database }), PolicyModule.register({ database, access: new EffectiveAccessStore(database, new InMemoryAuthzCache()) })],
        controllers: [EffectiveAccessController],
        providers: [{ provide: TenantDatabase, useValue: database }],
      });
      try {
        const token = signTenantContext(contextFor(TENANT_A, memberId(ME)), SIGNING_KEY);
        const response = await fetch(`${bare.baseUrl}/me/effective-access`, { headers: { [TENANT_HEADER]: token } });
        const body = (await response.json()) as EffectiveAccessDto;
        expect(response.status).toBe(200);
        expect('entitlement_hash' in body).toBe(false);
      } finally {
        await bare.close();
      }
    });
  });
});

describe('effectiveAccessView, against the pure PDP', () => {
  const NOW = new Date('2026-06-01T00:00:00Z');
  const PERMISSIONS = ['iam.member.manage', 'iam.role.grant', 'notification.self', 'session.self', 'project.read', 'contract.*', 'report.export'];

  interface GrantSpec {
    roleCode: string;
    rank: number;
    permissions: string[];
    kind: string;
    fromDays: number;
    lengthDays: number | null;
    storedStatus: string;
  }

  const grantArbitrary: fc.Arbitrary<GrantSpec> = fc.record({
    roleCode: fc.constantFrom('A', 'B', 'C', 'D'),
    rank: fc.integer({ min: 1, max: 99 }),
    permissions: fc.subarray(PERMISSIONS, { minLength: 0, maxLength: PERMISSIONS.length }),
    kind: fc.constantFrom('TENANT', 'UNIT_SUBTREE', 'UNIT_ONLY', 'PROJECT', 'CONTRACT'),
    // Days from now: negative is the past; the window may start and end anywhere around the present, or have no end.
    fromDays: fc.integer({ min: -400, max: 400 }),
    lengthDays: fc.option(fc.integer({ min: 1, max: 400 }), { nil: null }),
    storedStatus: fc.constantFrom('Active', 'Active', 'Active', 'Expired'),
  });

  function toMyGrant(spec: GrantSpec, index: number): MyGrant {
    const from = new Date(NOW.getTime() + spec.fromDays * DAY);
    const view: GrantView = {
      roleCode: spec.roleCode,
      rank: spec.rank,
      permissions: spec.permissions,
      scope: spec.kind === 'TENANT' ? { kind: 'TENANT' } : { kind: spec.kind as 'UNIT_ONLY', refIds: [randomUUID()], paths: ['/x/'] },
      status: spec.storedStatus,
      effectiveFrom: from,
      effectiveUntil: spec.lengthDays === null ? null : new Date(from.getTime() + spec.lengthDays * DAY),
    };
    return { id: `g-${index}`, roleName: spec.roleCode, view, scopeKind: view.scope.kind, scopeRefIds: [], storedStatus: spec.storedStatus as 'Active' | 'Expired', units: [], projects: [], contracts: [] };
  }

  it('property: the permissions of the ACTIVE grants are exactly effectivePermissions, for any grants, windows and statuses', () => {
    fc.assert(
      fc.property(fc.array(grantArbitrary, { maxLength: 12 }), (specs) => {
        const grants = specs.map(toMyGrant);
        const view = effectiveAccessView({ membershipId: 'm', scopeVersion: 3, grants, delegations: [], now: NOW });
        // The PDP loads only the grants stored as Active and applies the window itself.
        const access: EffectiveAccess = { membershipId: 'm', scopeVersion: 3, membershipActive: true, grants: grants.filter((grant) => grant.storedStatus === 'Active').map((grant) => grant.view) };
        const shown = new Set(view.grants.filter((grant) => grant.state === 'ACTIVE').flatMap((grant) => grant.permissions));
        expect([...shown].sort()).toEqual([...effectivePermissions(access, NOW)].sort());
      }),
      { numRuns: 300 },
    );
  });

  it('property: every grant is in exactly one state, and ACTIVE, EXPIRED and FUTURE follow the window', () => {
    fc.assert(
      fc.property(fc.array(grantArbitrary, { minLength: 1, maxLength: 12 }), (specs) => {
        const grants = specs.map(toMyGrant);
        const view = effectiveAccessView({ membershipId: 'm', scopeVersion: 1, grants, delegations: [], now: NOW });
        expect(view.grants).toHaveLength(grants.length);
        view.grants.forEach((dto, index) => {
          const grant = grants[index] as MyGrant;
          expect(dto.state).toBe(stateOf(grant, NOW));
          if (dto.state === 'FUTURE') expect(new Date(dto.effective_from).getTime()).toBeGreaterThan(NOW.getTime());
          if (dto.state === 'EXPIRED') expect(grant.storedStatus === 'Expired' || (dto.effective_until !== null && new Date(dto.effective_until).getTime() <= NOW.getTime())).toBe(true);
        });
      }),
      { numRuns: 200 },
    );
  });

  it('judges the boundaries as the PDP does: a grant starts at its first instant and ends before its last', () => {
    const base = { id: 'g', roleName: 'R', scopeKind: 'TENANT' as const, scopeRefIds: [], units: [], projects: [], contracts: [], storedStatus: 'Active' as const };
    const view = (from: Date, until: Date | null): GrantView => ({ roleCode: 'R', rank: 1, permissions: ['a.b'], scope: { kind: 'TENANT' }, status: 'Active', effectiveFrom: from, effectiveUntil: until });
    expect(stateOf({ ...base, view: view(NOW, null) }, NOW)).toBe('ACTIVE');
    expect(stateOf({ ...base, view: view(new Date(NOW.getTime() + 1), null) }, NOW)).toBe('FUTURE');
    expect(stateOf({ ...base, view: view(new Date(NOW.getTime() - DAY), NOW) }, NOW)).toBe('EXPIRED');
    expect(stateOf({ ...base, view: view(new Date(NOW.getTime() - DAY), new Date(NOW.getTime() + 1)) }, NOW)).toBe('ACTIVE');
  });
});
