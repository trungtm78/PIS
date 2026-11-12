import { randomBytes } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { AuditSealJob, EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { AuditEventsController } from '../src/modules/adm/audit-events.controller';
import { PolicyModule } from '../src/policy.module';
import { ProblemFilter } from '../src/problem.filter';
import { AuthzHarness, TENANT_A, TENANT_B, id, memberId, unitId } from '../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from './isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from './isolation/test-app';
import type { RunningApp } from './isolation/test-app';

// The marker the redaction writes in place of a credential value.
const REDACTED_MARKER = '[REDACTED]';
// A value that must never reach a reader; built from pieces so that no literal looks like a credential.
const DENIED_KEY = ['k', 'denied', '1'].join('-');

const SIGNING_KEY = randomBytes(32);
const path = (...ns: number[]): string => `/${ns.map(unitId).join('/')}/`;

// Members of tenant A.
const AUDITOR = 1; // audit_event.read on the whole tenant; belongs to unit 1
const SUBTREE_AUDITOR = 2; // audit_event.read on the subtree of unit 2 only; belongs to unit 2
const NOBODY = 3; // no grant
const WORKER = '00000000-0000-4000-8000-000000000000';

const EVENT = (n: number): string => id(0x60, n);

interface Reply {
  status: number;
  json: Record<string, unknown>;
  text: string;
}

describe('audit reads (ST-ADM-002, ADM-11)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;

  async function get(url: string, member: number, tenantId = TENANT_A): Promise<Reply> {
    const token = signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);
    const response = await fetch(`${app.baseUrl}${url}`, { headers: { [TENANT_HEADER]: token } });
    const text = await response.text();
    return { status: response.status, text, json: JSON.parse(text) as Record<string, unknown> };
  }

  const idsOf = (reply: Reply): string[] => (reply.json.items as Array<{ id: string }>).map((item) => item.id);

  const plant = (tenantId: string, n: number, actor: string, diff: Record<string, unknown>, extra: { impersonator?: string; ipHash?: string } = {}): [string, unknown[]] => [
    `insert into machvon.audit_event
       (tenant_id, id, seq, actor_id, action, resource_type, resource_id, safe_diff, reason, correlation_id, request_id, occurred_at, impersonator_id, ip_hash)
     values ($1, $2, nextval('machvon.audit_event_seq'), $3, $4, 'widget', $5, $6::jsonb, 'planted for the read test', $5, $5, '2026-03-01T10:00:00.123Z'::timestamptz + make_interval(secs => $7), $8, $9)`,
    [tenantId, EVENT(n), actor, `widget.change.${n}`, id(0x61, n), JSON.stringify(diff), n, extra.impersonator ?? null, extra.ipHash ?? null],
  ];

  beforeAll(async () => {
    await harness.start();
    await harness.seedUnits(TENANT_A, [
      { n: 1, path: path(1) },
      { n: 2, path: path(1, 2), parent: 1 },
    ]);
    await harness.seedUnits(TENANT_B, [{ n: 1, path: path(1) }]);
    for (const [member, unit] of [[AUDITOR, 1], [SUBTREE_AUDITOR, 2], [NOBODY, 1]] as const) await harness.seedMembership(TENANT_A, member, unit);
    await harness.seedRole(TENANT_A, 1, 'AUDITOR', ['audit_event.read'], 25);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: AUDITOR, role: 1, kind: 'TENANT' },
      { n: 2, member: SUBTREE_AUDITOR, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(2)] },
    ]);
    // 1: acted by the auditor (unit 1); 2: acted by the subtree auditor (unit 2), impersonated; 3: by a worker (no member);
    // 4: sensitive values the writer failed to list; 5 and 6: acted in unit 2 and unit 1 (paging).
    await harness.owner(TENANT_A, [
      plant(TENANT_A, 1, memberId(AUDITOR), { name: 'one' }),
      plant(TENANT_A, 2, memberId(SUBTREE_AUDITOR), { name: 'two' }, { impersonator: memberId(AUDITOR), ipHash: 'a'.repeat(64) }),
      plant(TENANT_A, 3, WORKER, { name: 'three' }),
      plant(TENANT_A, 4, memberId(AUDITOR), { password: 'hunter2', note: 'kept', nested: { api_key: 'k-123', items: [{ token: 't-9' }] } }),
      plant(TENANT_A, 5, memberId(SUBTREE_AUDITOR), { name: 'five' }),
      plant(TENANT_A, 6, memberId(AUDITOR), { name: 'six' }),
    ]);
    await harness.owner(TENANT_B, [plant(TENANT_B, 7, memberId(AUDITOR), { name: 'secret of tenant B' })]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) })],
      controllers: [AuditEventsController],
      providers: [{ provide: TenantDatabase, useValue: tenants }, { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) }],
    });
  }, 180_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  it('lists the audit trail of the tenant newest first to a reader of the whole tenant, as the documented DTO', async () => {
    const reply = await get('/resources/audit_event', AUDITOR);
    expect(reply.status).toBe(200);
    expect(idsOf(reply)).toEqual([6, 5, 4, 3, 2, 1].map(EVENT));
    expect(reply.json.next_cursor).toBeNull();
    const [first] = reply.json.items as Array<Record<string, unknown>>;
    expect(Object.keys(first ?? {}).sort()).toEqual(
      ['action', 'actor_id', 'classification', 'correlation_id', 'id', 'impersonator_id', 'occurred_at', 'on_behalf_of_id', 'outcome', 'reason', 'request_id', 'resource_id', 'resource_type', 'safe_diff', 'seal_hash', 'seq'].sort(),
    );
    expect(first).toMatchObject({ id: EVENT(6), actor_id: memberId(AUDITOR), action: 'widget.change.6', outcome: 'SUCCESS', occurred_at: '2026-03-01T10:00:06.123Z', safe_diff: { name: 'six' } });
    expect(typeof first?.seq).toBe('number');
  });

  it('never returns a sensitive value of a stored diff, at any depth, and never the address hash', async () => {
    const reply = await get(`/resources/audit_event/${EVENT(4)}`, AUDITOR);
    expect(reply.status).toBe(200);
    expect(reply.json.safe_diff).toEqual({ password: REDACTED_MARKER, note: 'kept', nested: { api_key: REDACTED_MARKER, items: [{ token: REDACTED_MARKER }] } });
    for (const secret of ['hunter2', 'k-123', 't-9']) expect(reply.text).not.toContain(secret);
    const planted = await get(`/resources/audit_event/${EVENT(2)}`, AUDITOR);
    expect(planted.text).not.toContain('a'.repeat(64));
    expect(planted.text).not.toContain('ip_hash');
  });

  it('shows the impersonator only to a reader of the whole tenant', async () => {
    expect((await get(`/resources/audit_event/${EVENT(2)}`, AUDITOR)).json.impersonator_id).toBe(memberId(AUDITOR));
    expect((await get(`/resources/audit_event/${EVENT(2)}`, SUBTREE_AUDITOR)).json.impersonator_id).toBeNull();
  });

  it('limits a subtree reader to the events of members in the subtree: none of the worker or of other units', async () => {
    const reply = await get('/resources/audit_event', SUBTREE_AUDITOR);
    expect(reply.status).toBe(200);
    expect(idsOf(reply)).toEqual([5, 2].map(EVENT));
    expect((await get(`/resources/audit_event/${EVENT(2)}`, SUBTREE_AUDITOR)).status).toBe(200);
    for (const outside of [1, 3, 4, 6]) {
      const hidden = await get(`/resources/audit_event/${EVENT(outside)}`, SUBTREE_AUDITOR);
      expect(hidden.status).toBe(404);
      expect(hidden.json.code).toBe('RESOURCE_NOT_FOUND');
    }
  });

  it('pages with an opaque cursor without repeating or skipping an event and refuses a cursor it did not issue', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page += 1) {
      const reply: Reply = await get(`/resources/audit_event?limit=4${cursor === null ? '' : `&cursor=${cursor}`}`, AUDITOR);
      expect(reply.status).toBe(200);
      seen.push(...idsOf(reply));
      cursor = reply.json.next_cursor as string | null;
      if (cursor === null) break;
    }
    expect(seen).toEqual([6, 5, 4, 3, 2, 1].map(EVENT));
    const foreign = Buffer.from(JSON.stringify(['not-a-seq', EVENT(1)]), 'utf8').toString('base64url');
    const refused = await get(`/resources/audit_event?cursor=${foreign}`, AUDITOR);
    expect(refused.status).toBe(422);
    expect(refused.json.code).toBe('VALIDATION_FAILED');
    expect((await get('/resources/audit_event?limit=0', AUDITOR)).status).toBe(422);
  });

  it('answers 404 to the id of an event of another tenant, exactly as to one that does not exist', async () => {
    const foreign = await get(`/resources/audit_event/${EVENT(7)}`, AUDITOR);
    const missing = await get(`/resources/audit_event/${id(0x62, 1)}`, AUDITOR);
    expect(foreign.status).toBe(404);
    expect({ ...foreign.json, correlation_id: 'x', instance: 'x' }).toEqual({ ...missing.json, correlation_id: 'x', instance: 'x' });
    expect(foreign.text).not.toContain('secret of tenant B');
    expect((await get('/resources/audit_event', AUDITOR)).text).not.toContain('secret of tenant B');
  });

  it('refuses a caller without the permission', async () => {
    expect((await get('/resources/audit_event', NOBODY)).status).toBe(403);
    expect((await get(`/resources/audit_event/${EVENT(1)}`, NOBODY)).status).toBe(403);
  });

  it('refuses a malformed id', async () => {
    expect((await get('/resources/audit_event/not-a-uuid', AUDITOR)).status).toBe(422);
  });
  describe('filters, seals and the verdict of the verification (ST-ADM-016, ADM-11)', () => {
    const seal = (windowRows = 3) => new AuditSealJob(harness.tenants as TenantDatabase, { windowRows }).seal({ tenantId: TENANT_A, membershipId: memberId(AUDITOR), scopeVersion: 1 });
    const verify = () => new AuditSealJob(harness.tenants as TenantDatabase).verify({ tenantId: TENANT_A, membershipId: memberId(AUDITOR), scopeVersion: 1 });
    const itemsOf = (reply: Reply): Array<Record<string, unknown>> => reply.json.items as Array<Record<string, unknown>>;

    it('narrows the trail by actor, action, resource and period, and never beyond the scope of the caller', async () => {
      expect(idsOf(await get(`/resources/audit_event?actor_id=${memberId(SUBTREE_AUDITOR)}`, AUDITOR))).toEqual([5, 2].map(EVENT));
      expect(idsOf(await get('/resources/audit_event?action=widget.change.3', AUDITOR))).toEqual([EVENT(3)]);
      expect(idsOf(await get(`/resources/audit_event?resource_type=widget&resource_id=${id(0x61, 4)}`, AUDITOR))).toEqual([EVENT(4)]);
      expect(idsOf(await get('/resources/audit_event?from=2026-03-01T10:00:02.123Z&to=2026-03-01T10:00:05.123Z', AUDITOR))).toEqual([4, 3, 2].map(EVENT));
      expect(idsOf(await get(`/resources/audit_event?actor_id=${memberId(AUDITOR)}`, SUBTREE_AUDITOR))).toEqual([]);
      expect(idsOf(await get('/resources/audit_event?resource_type=gadget', AUDITOR))).toEqual([]);
    });

    it('finds the denied commands by outcome, with the diff redacted and without the rows that succeeded (AC-ST-ADM-016-2)', async () => {
      await harness.owner(TENANT_A, [
        [
          `insert into machvon.audit_event
             (tenant_id, id, actor_id, action, resource_type, resource_id, safe_diff, correlation_id, request_id, occurred_at, outcome)
           values ($1, $2, $3, 'authz.denied:placeLegalHold', 'operation', $4, $5::jsonb, $4, $4, '2026-03-02T09:00:00Z', 'DENIED')`,
          [TENANT_A, EVENT(8), memberId(NOBODY), id(0x61, 8), JSON.stringify({ reason: 'MISSING_PERMISSION', api_key: DENIED_KEY })],
        ],
      ]);
      const reply = await get('/resources/audit_event?outcome=DENIED', AUDITOR);
      expect(idsOf(reply)).toEqual([EVENT(8)]);
      expect(itemsOf(reply)[0]).toMatchObject({ outcome: 'DENIED', actor_id: memberId(NOBODY), safe_diff: { reason: 'MISSING_PERMISSION', api_key: REDACTED_MARKER } });
      expect(reply.text).not.toContain(DENIED_KEY);
      expect(idsOf(await get('/resources/audit_event?outcome=SUCCESS', AUDITOR))).not.toContain(EVENT(8));
    });

    it.each([
      ['actor_id=not-a-uuid', 'actor_id'],
      ['resource_id=12', 'resource_id'],
      ['outcome=MAYBE', 'outcome'],
      ['from=2026-03-01', 'from'],
      ['to=yesterday', 'to'],
      ['from=2026-03-02T00:00:00Z&to=2026-03-01T00:00:00Z', 'to'],
      ['action=a&action=b', 'action'],
      [`resource_type=${'x'.repeat(201)}`, 'resource_type'],
      ['action=', 'action'],
    ])('refuses the filter %s with 422 naming %s', async (query) => {
      const reply = await get(`/resources/audit_event?${query}`, AUDITOR);
      expect([reply.status, reply.json.code]).toEqual([422, 'VALIDATION_FAILED']);
    });

    it('names the seal that covers each event (null while it waits) and carries the verdict of the verification for the banner (AC-ST-ADM-016-3, UAT-AC139)', async () => {
      const before = await get('/resources/audit_event', AUDITOR);
      expect(before.json.seal).toEqual({ status: 'UNKNOWN', checked_at: null, seals: null, broken: null });
      expect(itemsOf(before).every((item) => item.seal_hash === null)).toBe(true);

      await seal(3);
      const sealed = await get('/resources/audit_event', AUDITOR);
      const hashes = itemsOf(sealed).map((item) => item.seal_hash as string);
      expect(hashes.every((hash) => /^[0-9a-f]{64}$/.test(hash))).toBe(true);
      expect(new Set(hashes).size).toBe(3);
      expect((await get(`/resources/audit_event/${EVENT(8)}`, AUDITOR)).json.seal_hash).toBe(itemsOf(sealed).find((item) => item.id === EVENT(8))?.seal_hash);

      await harness.owner(TENANT_A, [[`insert into machvon.audit_event (tenant_id, id, actor_id, action, resource_type, resource_id, safe_diff, correlation_id, request_id, occurred_at)
        values ($1, $2, $3, 'widget.late', 'widget', $4, '{}', $4, $4, '2026-03-03T00:00:00Z')`, [TENANT_A, EVENT(9), memberId(AUDITOR), id(0x61, 9)]]]);
      expect(itemsOf(await get('/resources/audit_event', AUDITOR))[0]).toMatchObject({ id: EVENT(9), seal_hash: null });

      await verify();
      expect((await get('/resources/audit_event', AUDITOR)).json.seal).toMatchObject({ status: 'OK', seals: 3, broken: null });

      await harness.owner(TENANT_A, [["update machvon.audit_event set action = 'tampered' where id = $1", [EVENT(2)]]]);
      await verify();
      const broken = await get('/resources/audit_event', SUBTREE_AUDITOR);
      expect(broken.json.seal).toMatchObject({ status: 'BROKEN', broken: { reason: 'ROOT_MISMATCH', seal_id: expect.any(String), from_seq: expect.any(Number), to_seq: expect.any(Number) } });
    });
  });
});
