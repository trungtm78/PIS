import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../src/command.module';
import { OrgUnitCommandsController } from '../src/org-units.commands.controller';
import { OrganizationUnitsController } from '../src/organization-units.controller';
import { PolicyModule } from '../src/policy.module';
import { ProblemFilter } from '../src/problem.filter';
import { TENANT_HEADER } from './isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from './isolation/test-app';
import type { RunningApp } from './isolation/test-app';
import { AuthzHarness, TENANT_A, TENANT_B, grantId, memberId, unitId } from '../../../packages/db/test/support/authz-fixtures';

const SIGNING_KEY = randomBytes(32);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const path = (...ns: number[]): string => `/${ns.map(unitId).join('/')}/`;

// Members of tenant A.
const ADMIN = 1; // iam.* and organization_unit.read on the whole tenant
const UNIT_ADMIN = 2; // iam.unit.manage and organization_unit.read on the subtree of unit 2
const READER = 3; // organization_unit.read on the subtree of unit 2 only
const NOBODY = 4; // no grant
const LEAF_ADMIN = 5; // iam.unit.manage on the single units 3 and 6 only (UNIT_ONLY), no reach over their descendants
const LEAF_ONLY_ADMIN = 6; // iam.unit.manage on the single units 4 and 6 only (UNIT_ONLY)

interface Reply {
  status: number;
  headers: Headers;
  json: Record<string, unknown>;
}

interface Call {
  member: number;
  tenantId?: string;
  key?: string;
  ifMatch?: string;
  body?: unknown;
}

describe('organisation unit commands (ST-ADM-004)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  let counter = 0;

  async function call(method: 'GET' | 'POST' | 'PUT', url: string, options: Call): Promise<Reply> {
    const token = signTenantContext({ tenantId: options.tenantId ?? TENANT_A, membershipId: memberId(options.member), scopeVersion: 1 }, SIGNING_KEY);
    const headers: Record<string, string> = { [TENANT_HEADER]: token, 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    return { status: response.status, headers: response.headers, json: (await response.json()) as Record<string, unknown> };
  }

  const create = (member: number, parent: number | string, extra: Record<string, unknown> = {}, options: Partial<Call> = {}): Promise<Reply> =>
    call('POST', '/org-units', {
      member,
      ...options,
      body: {
        code: `NEW${(counter += 1)}`,
        name: 'New unit',
        parent_id: typeof parent === 'number' ? unitId(parent) : parent,
        unit_type: 'DEPARTMENT',
        valid_from: '2026-02-01',
        ...extra,
      },
    });

  const move = (member: number, unit: number, target: number, ifMatch = '"1"'): Promise<Reply> =>
    call('POST', `/org-units/${unitId(unit)}/move`, {
      member,
      ifMatch,
      body: { new_parent_id: unitId(target), effective_from: '2026-02-01', reason: 'Reorganisation of departments' },
    });

  const count = async (sql: string, params: unknown[] = []): Promise<number> => {
    const rows = await harness.owner<{ n: string }>(TENANT_A, [[sql, params]]);
    return Number(rows[0]?.n);
  };

  const pathOfUnit = async (n: number | string): Promise<string | undefined> =>
    (await harness.owner<{ path: string }>(TENANT_A, [['select path from machvon.organization_unit where id = $1', [typeof n === 'number' ? unitId(n) : n]]]))[0]?.path;

  const scopeVersions = async (): Promise<Record<number, number>> => {
    const rows = await harness.owner<{ id: string; scope_version: string }>(TENANT_A, [['select id, scope_version::text from machvon.membership', []]]);
    return Object.fromEntries([ADMIN, UNIT_ADMIN, READER, NOBODY].map((n) => [n, Number(rows.find((row) => row.id === memberId(n))?.scope_version)]));
  };

  async function seedTree(): Promise<void> {
    await harness.owner(TENANT_A, [
      ['delete from machvon.organization_unit where id not in ($1, $2, $3, $4, $5, $6)', [1, 2, 3, 4, 5, 6].map(unitId)],
      ['delete from machvon.outbox_event', []],
      ['delete from machvon.role_grant where id = $1', [grantId(9)]],
    ]);
    await harness.owner(TENANT_A, [
      [
        'update machvon.organization_unit set parent_id = null, path = $2, depth = 0, version = 1 where id = $1',
        [unitId(1), path(1)],
      ],
      ...(
        [
          [2, 1, [1, 2]],
          [3, 2, [1, 2, 3]],
          [4, 3, [1, 2, 3, 4]],
          [5, 1, [1, 5]],
          [6, 5, [1, 5, 6]],
        ] as const
      ).map(
        ([n, parent, chain]): [string, unknown[]] => [
          'update machvon.organization_unit set parent_id = $2, path = $3, depth = $4, version = 1 where id = $1',
          [unitId(n), unitId(parent), path(...chain), chain.length - 1],
        ],
      ),
      ['update machvon.membership set scope_version = 1', []],
    ]);
  }

  beforeAll(async () => {
    await harness.start();
    await harness.seedUnits(TENANT_A, [
      { n: 1, path: path(1) },
      { n: 2, path: path(1, 2), parent: 1 },
      { n: 3, path: path(1, 2, 3), parent: 2 },
      { n: 4, path: path(1, 2, 3, 4), parent: 3 },
      { n: 5, path: path(1, 5), parent: 1 },
      { n: 6, path: path(1, 5, 6), parent: 5 },
    ]);
    await harness.seedUnits(TENANT_B, [
      { n: 1, path: path(1) },
      { n: 9, path: path(1, 9), parent: 1 },
    ]);
    for (const n of [ADMIN, UNIT_ADMIN, READER, NOBODY, LEAF_ADMIN, LEAF_ONLY_ADMIN]) await harness.seedMembership(TENANT_A, n, 1);
    await harness.seedRole(TENANT_A, 1, 'ADMIN_ROLE', ['iam.*', 'organization_unit.read'], 89);
    await harness.seedRole(TENANT_A, 2, 'UNIT_ADMIN_ROLE', ['iam.unit.manage', 'organization_unit.read'], 70);
    await harness.seedRole(TENANT_A, 3, 'READER_ROLE', ['organization_unit.read'], 20);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: ADMIN, role: 1, kind: 'TENANT' },
      { n: 2, member: UNIT_ADMIN, role: 2, kind: 'UNIT_SUBTREE', refs: [unitId(2)] },
      { n: 3, member: READER, role: 3, kind: 'UNIT_SUBTREE', refs: [unitId(2)] },
      { n: 4, member: LEAF_ADMIN, role: 2, kind: 'UNIT_ONLY', refs: [unitId(3), unitId(6)] },
      { n: 5, member: LEAF_ONLY_ADMIN, role: 2, kind: 'UNIT_ONLY', refs: [unitId(4), unitId(6)] },
    ]);
    const tenants = new TenantDatabase(harness.appPool);
    const store = new EffectiveAccessStore(tenants, new InMemoryAuthzCache());
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [CommandModule.register({ database: tenants }), PolicyModule.register({ database: tenants, access: store })],
      controllers: [OrgUnitCommandsController, OrganizationUnitsController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 240_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  beforeEach(seedTree);

  describe('createOrganizationUnit', () => {
    it('creates a unit and writes its audit row and outbox event in the same transaction', async () => {
      const reply = await create(ADMIN, 5, { code: 'FINANCE', is_investor: true });
      expect(reply.status).toBe(201);
      expect(reply.json).toEqual({ operation_id: expect.stringMatching(UUID), status: 'CREATED', resource_version: 1, resource_id: expect.stringMatching(UUID) });
      expect(reply.headers.get('etag')).toBe('"1"');
      const id = reply.json.resource_id as string;
      expect(await pathOfUnit(id)).toBe(`${path(1, 5)}${id}/`);
      expect(await count("select count(*) as n from machvon.audit_event where action = 'org_unit.create' and resource_id = $1 and outcome = 'SUCCESS'", [id])).toBe(1);
      expect(await count("select count(*) as n from machvon.outbox_event where type = 'iam.org_unit.created.v1' and aggregate_id = $1", [id])).toBe(1);
    });

    it('answers 422 UNIT_DEPTH_EXCEEDED at depth 9, 409 UNIT_CODE_TAKEN for a duplicate code and 422 UNIT_VALIDITY_INVALID (AC-ST-ADM-004-1, UAT-AC110)', async () => {
      let parent: string = unitId(4);
      for (let level = 4; level <= 8; level += 1) {
        const reply = await create(ADMIN, parent);
        expect(reply.status).toBe(201);
        parent = reply.json.resource_id as string;
      }
      const tooDeep = await create(ADMIN, parent);
      expect(tooDeep.status).toBe(422);
      expect(tooDeep.json.code).toBe('UNIT_DEPTH_EXCEEDED');

      const duplicate = await create(ADMIN, 1, { code: 'U2' });
      expect(duplicate.status).toBe(409);
      expect(duplicate.json.code).toBe('UNIT_CODE_TAKEN');

      const validity = await create(ADMIN, 1, { valid_from: '2025-01-01' });
      expect(validity.status).toBe(422);
      expect(validity.json.code).toBe('UNIT_VALIDITY_INVALID');
    });

    it('does not poison a corrected retry: the same key with the same body replays the refusal, a new key with a fixed body succeeds', async () => {
      const key = `key-${randomUUID()}`;
      const refused = await create(ADMIN, 1, { code: 'U2' }, { key });
      expect(refused.json.code).toBe('UNIT_CODE_TAKEN');
      const replay = await create(ADMIN, 1, { code: 'U2' }, { key });
      expect(replay.status).toBe(409);
      expect(replay.headers.get('idempotency-replayed')).toBe('true');
      expect((await create(ADMIN, 1, { code: 'FIXED' })).status).toBe(201);
    });

    it.each([
      ['an unknown field', { tenant_id: 'x' }, 400, 'FIELD_NOT_ALLOWED'],
      ['a lower case code', { code: 'lower' }, 422, 'VALIDATION_FAILED'],
      ['an impossible date', { valid_from: '2026-02-31' }, 422, 'VALIDATION_FAILED'],
      ['an unknown unit type', { unit_type: 'KINGDOM' }, 422, 'VALIDATION_FAILED'],
      ['a name of one character', { name: 'x' }, 422, 'VALIDATION_FAILED'],
    ])('refuses %s', async (_label, extra, status, code) => {
      const reply = await create(ADMIN, 1, extra);
      expect(reply.status).toBe(status);
      expect(reply.json.code).toBe(code);
    });

    it('refuses a body without parent_id with 400 INVALID_REQUEST', async () => {
      const reply = await call('POST', '/org-units', { member: ADMIN, body: { code: 'NOPARENT', name: 'No parent', unit_type: 'DEPARTMENT', valid_from: '2026-02-01' } });
      expect(reply.status).toBe(400);
      expect(reply.json.code).toBe('INVALID_REQUEST');
    });

    it('answers 404 for a parent of another tenant', async () => {
      const reply = await create(ADMIN, unitId(9));
      expect(reply.status).toBe(404);
      expect(reply.json.code).toBe('RESOURCE_NOT_FOUND');
    });
  });

  describe('updateOrganizationUnit', () => {
    it('changes the unit with a matching If-Match, answers the new ETag, and refuses stale and missing If-Match', async () => {
      const first = await call('PUT', `/org-units/${unitId(2)}`, { member: ADMIN, ifMatch: '"1"', body: { name: 'Renamed department' } });
      expect(first.status).toBe(200);
      expect(first.json).toEqual({ operation_id: expect.stringMatching(UUID), status: 'UPDATED', resource_version: 2, resource_id: unitId(2) });
      expect(first.headers.get('etag')).toBe('"2"');
      const stale = await call('PUT', `/org-units/${unitId(2)}`, { member: ADMIN, ifMatch: '"1"', body: { name: 'Another name' } });
      expect(stale.status).toBe(409);
      expect(stale.json).toMatchObject({ code: 'VERSION_CONFLICT', current_version: 2 });
      const missing = await call('PUT', `/org-units/${unitId(2)}`, { member: ADMIN, body: { name: 'Another name' } });
      expect(missing.status).toBe(428);
      expect(await count("select count(*) as n from machvon.outbox_event where type = 'iam.org_unit.updated.v1'")).toBe(1);
    });
  });

  describe('moveOrganizationUnit', () => {
    it('rewrites the subtree and bumps scope_version of exactly the memberships whose reach changes (AC-ST-ADM-004-2)', async () => {
      const before = await scopeVersions();
      const reply = await move(ADMIN, 3, 5);
      expect(reply.status).toBe(200);
      expect(reply.json).toEqual({ operation_id: expect.stringMatching(UUID), status: 'MOVED', resource_version: 2, resource_id: unitId(3) });
      expect(await pathOfUnit(3)).toBe(path(1, 5, 3));
      expect(await pathOfUnit(4)).toBe(path(1, 5, 3, 4));

      const after = await scopeVersions();
      // Holders of the subtree of unit 2 lose unit 3 and 4; the tenant admin and the member without a grant keep theirs.
      expect(after[UNIT_ADMIN]).toBe((before[UNIT_ADMIN] ?? 0) + 1);
      expect(after[READER]).toBe((before[READER] ?? 0) + 1);
      expect(after[ADMIN]).toBe(before[ADMIN]);
      expect(after[NOBODY]).toBe(before[NOBODY]);

      const audit = await harness.owner<{ reason: string; safe_diff: Record<string, unknown> }>(TENANT_A, [
        ["select reason, safe_diff from machvon.audit_event where action = 'org_unit.move' and resource_id = $1", [unitId(3)]],
      ]);
      expect(audit).toHaveLength(1);
      expect(audit[0]?.reason).toBe('Reorganisation of departments');
      expect(audit[0]?.safe_diff).toMatchObject({ from_path: path(1, 2, 3), to_path: path(1, 5, 3), moved_units: 2 });
      expect(await count("select count(*) as n from machvon.outbox_event where type = 'iam.org_unit.moved.v1'")).toBe(1);
      expect(await count("select count(*) as n from machvon.outbox_event where type = 'iam.access.changed.v1'")).toBe(1);
    });

    it('bumps the holders of the new place as well: a subtree grant on the target gains the moved units', async () => {
      const before = await scopeVersions();
      await harness.seedGrants(TENANT_A, [{ n: 9, member: NOBODY, role: 3, kind: 'UNIT_SUBTREE', refs: [unitId(5)] }]);
      expect((await move(ADMIN, 4, 6, '"1"')).status).toBe(200);
      const after = await scopeVersions();
      expect(after[NOBODY]).toBe((before[NOBODY] ?? 0) + 1);
      expect(after[UNIT_ADMIN]).toBe((before[UNIT_ADMIN] ?? 0) + 1);
    });

    it('UAT-AC110: refuses a cycle with 422 UNIT_CYCLE and changes nothing, no event and no scope_version bump', async () => {
      const before = await scopeVersions();
      const reply = await move(ADMIN, 2, 4);
      expect(reply.status).toBe(422);
      expect(reply.json.code).toBe('UNIT_CYCLE');
      expect(await pathOfUnit(2)).toBe(path(1, 2));
      expect(await pathOfUnit(4)).toBe(path(1, 2, 3, 4));
      expect(await scopeVersions()).toEqual(before);
      expect(await count("select count(*) as n from machvon.outbox_event where type like 'iam.org_unit.moved%'")).toBe(0);
    });

    it('commits one of two opposing concurrent moves and refuses the other with UNIT_CYCLE', async () => {
      const [a, b] = await Promise.all([move(ADMIN, 2, 5), move(ADMIN, 5, 2)]);
      expect([a.status, b.status].sort()).toEqual([200, 422]);
      expect([a, b].find((reply) => reply.status === 422)?.json.code).toBe('UNIT_CYCLE');
    });

    it('refuses to move a unit whose descendants are outside the reach of the caller, even when the unit and the target are inside it', async () => {
      const before = await scopeVersions();
      // Unit 3 has the descendant unit 4, which the UNIT_ONLY grant on units 3 and 6 does not cover.
      const reply = await move(LEAF_ADMIN, 3, 6);
      expect(reply.status).toBe(403);
      expect(reply.json.code).toBe('SCOPE_DENIED');
      expect(await pathOfUnit(3)).toBe(path(1, 2, 3));
      expect(await pathOfUnit(4)).toBe(path(1, 2, 3, 4));
      expect(await scopeVersions()).toEqual(before);
      expect(await count("select count(*) as n from machvon.audit_event where outcome = 'DENIED' and action = 'command.denied:moveOrganizationUnit'")).toBe(1);
    });

    it('lets a UNIT_ONLY caller move a leaf unit when the unit and the target are both inside its reach', async () => {
      const reply = await move(LEAF_ONLY_ADMIN, 4, 6);
      expect(reply.status).toBe(200);
      expect(await pathOfUnit(4)).toBe(path(1, 5, 6, 4));
    });

    it('refuses a future effective_from, a short reason and a stale If-Match', async () => {
      const future = await call('POST', `/org-units/${unitId(3)}/move`, { member: ADMIN, ifMatch: '"1"', body: { new_parent_id: unitId(5), effective_from: '2999-01-01', reason: 'Reorganisation of departments' } });
      expect(future.status).toBe(422);
      const shortReason = await call('POST', `/org-units/${unitId(3)}/move`, { member: ADMIN, ifMatch: '"1"', body: { new_parent_id: unitId(5), effective_from: '2026-02-01', reason: 'short' } });
      expect(shortReason.status).toBe(422);
      const stale = await move(ADMIN, 3, 5, '"7"');
      expect(stale.status).toBe(409);
      expect(stale.json).toMatchObject({ code: 'VERSION_CONFLICT', current_version: 1 });
    });
  });

  describe('organisation unit reads', () => {
    it('return the full unit view the tree screen edits: type, status, successor, version and depth', async () => {
      const created = await create(ADMIN, 1, { name: 'Full view unit', unit_type: 'COMMUNE', administrative_code: '12345', is_investor: true, legal_basis_ref: 'QD-1' });
      const id = created.json.resource_id as string;
      const detail = await call('GET', `/resources/organization_unit/${id}`, { member: ADMIN });
      expect(detail.json).toMatchObject({
        id,
        name: 'Full view unit',
        parent_id: unitId(1),
        unit_type: 'COMMUNE',
        administrative_code: '12345',
        is_investor: true,
        legal_basis_ref: 'QD-1',
        status: 'Active',
        successor_id: null,
        version: 1,
        depth: 1,
      });
      const list = await call('GET', '/resources/organization_unit?limit=100', { member: ADMIN });
      const items = list.json.items as Array<{ id: string; version: number; unit_type: string }>;
      expect(items.find((item) => item.id === id)).toMatchObject({ version: 1, unit_type: 'COMMUNE' });
    });
  });

  describe('scope and authorisation', () => {
    it('lets a UNIT_ADMIN manage units inside its subtree only; outside it the answer is 403 SCOPE_DENIED with a DENIED audit row', async () => {
      expect((await create(UNIT_ADMIN, 3)).status).toBe(201);
      const outside = await create(UNIT_ADMIN, 5);
      expect(outside.status).toBe(403);
      expect(outside.json.code).toBe('SCOPE_DENIED');
      expect(await count("select count(*) as n from machvon.audit_event where outcome = 'DENIED' and action like 'command.denied:createOrganizationUnit'")).toBe(1);

      expect((await move(UNIT_ADMIN, 4, 2)).status).toBe(200);
      expect((await move(UNIT_ADMIN, 4, 5, '"2"')).json.code).toBe('SCOPE_DENIED'); // target outside the subtree
      expect((await move(UNIT_ADMIN, 6, 2)).json.code).toBe('SCOPE_DENIED'); // unit outside the subtree
      const rename = await call('PUT', `/org-units/${unitId(5)}`, { member: UNIT_ADMIN, ifMatch: '"1"', body: { name: 'Hijacked' } });
      expect(rename.status).toBe(403);
    });

    it.each([
      ['a reader without iam.unit.manage', READER],
      ['a member without any grant', NOBODY],
    ])('denies the commands to %s at the guard with an authz DENIED audit row', async (_label, member) => {
      const before = await count("select count(*) as n from machvon.audit_event where outcome = 'DENIED' and action = 'authz.denied:createOrganizationUnit'");
      const reply = await create(member, 3);
      expect(reply.status).toBe(403);
      expect(reply.json.code).toBe('SCOPE_DENIED');
      expect(await count("select count(*) as n from machvon.audit_event where outcome = 'DENIED' and action = 'authz.denied:createOrganizationUnit'")).toBe(before + 1);
      expect((await move(member, 3, 5)).status).toBe(403);
    });

    it('never lets tenant B act on tenant A units: the unit is not found', async () => {
      await harness.seedMembership(TENANT_B, ADMIN, 1);
      await harness.seedRole(TENANT_B, 1, 'ADMIN_ROLE', ['iam.*', 'organization_unit.read'], 89);
      await harness.seedGrants(TENANT_B, [{ n: 1, member: ADMIN, role: 1, kind: 'TENANT' }]);
      const reply = await call('POST', `/org-units/${unitId(3)}/move`, {
        member: ADMIN,
        tenantId: TENANT_B,
        ifMatch: '"1"',
        body: { new_parent_id: unitId(9), effective_from: '2026-02-01', reason: 'Reorganisation of departments' },
      });
      expect(reply.status).toBe(404);
      expect(reply.json.code).toBe('RESOURCE_NOT_FOUND');
      expect(await pathOfUnit(3)).toBe(path(1, 2, 3));
    });
  });

  describe('reads limited to the reader\'s subtree', () => {
    const list = async (member: number): Promise<string[]> => {
      const reply = await call('GET', '/resources/organization_unit?limit=50', { member });
      expect(reply.status).toBe(200);
      return (reply.json.items as Array<{ id: string }>).map((item) => item.id).sort();
    };

    it('lists only the subtree for a subtree reader and everything for a tenant-wide grant', async () => {
      expect(await list(READER)).toEqual([2, 3, 4].map(unitId).sort());
      expect(await list(UNIT_ADMIN)).toEqual([2, 3, 4].map(unitId).sort());
      expect(await list(ADMIN)).toEqual([1, 2, 3, 4, 5, 6].map(unitId).sort());
    });

    it('answers 404 for a unit outside the scope and 200 inside it', async () => {
      expect((await call('GET', `/resources/organization_unit/${unitId(3)}`, { member: READER })).status).toBe(200);
      const outside = await call('GET', `/resources/organization_unit/${unitId(5)}`, { member: READER });
      expect(outside.status).toBe(404);
      expect(outside.json.code).toBe('RESOURCE_NOT_FOUND');
    });

    it('denies a member without organization_unit.read at the guard', async () => {
      expect((await call('GET', '/resources/organization_unit', { member: NOBODY })).status).toBe(403);
    });

    it('follows a move: units that leave the subtree disappear from the reader\'s list', async () => {
      expect((await move(ADMIN, 4, 5)).status).toBe(200);
      expect(await list(READER)).toEqual([2, 3].map(unitId).sort());
    });
  });
});
