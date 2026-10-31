import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { Client } from 'pg';
import { AuditWriter, CapBalanceReconcileJob, CapReservationExpiryJob, EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase, WORKER_MEMBERSHIP_ID } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import type { MetricsSink } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { capModule } from '../../src/modules/cap';
import { FundReservationController } from '../../src/modules/cap/reservation.controller';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { CapWorld } from '../../../../packages/db/test/support/cap-fixtures';
import type { PublishedLine } from '../../../../packages/db/test/support/cap-fixtures';
import { TENANT_A, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(480_000);

const SIGNING_KEY = randomBytes(32);
const ROOT = 1;
const INVESTOR = 31; // capital.reservation.manage and capital.read over the whole tenant
const READER = 32; // capital.read only
const NOBODY = 33;
const ELSEWHERE = 34; // the same rights as the investor, over another branch only
const OTHER_BRANCH = 5;
const MILLION = 1_000_000;
const millions = (n: number): string => String(n * MILLION);
const SOON = (days: number): string => new Date(Date.now() + days * 86_400_000).toISOString();

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

class Counters implements MetricsSink {
  readonly counts = new Map<string, number>();
  increment(name: string): void {
    this.counts.set(name, (this.counts.get(name) ?? 0) + 1);
  }
  gauge(): void {
    return undefined;
  }
}

describe('the earmark of capital over HTTP (ST-CAP-011, UAT-PLAN-10, UAT-AC227)', () => {
  const world = new CapWorld();
  const harness = world.harness;
  let app: RunningApp;

  const tokenOf = (member: number): string => signTenantContext({ tenantId: TENANT_A, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);

  async function call(method: 'GET' | 'POST', url: string, options: { member: number; body?: unknown; ifMatch?: string }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }

  const rows = <R extends object>(sql: string, params: unknown[] = []): Promise<R[]> => world.owner<R>(sql, params);
  const reserve = (member: number, line: PublishedLine, amount: string, extra: Record<string, unknown> = {}): Promise<Reply> =>
    call('POST', '/fund-reservations', { member, body: { allocation_line_id: line.lineId, amount_vnd: amount, purpose: 'CONTRACT_PENDING', expires_at: SOON(30), ...extra } });
  const release = (member: number, id: string, version: number | string, reason = 'The contract was dropped.'): Promise<Reply> => call('POST', `/fund-reservations/${id}/release`, { member, ifMatch: `"${version}"`, body: { reason } });
  const entries = (lineId: string, type: string) =>
    rows<{ amount: string; source_ref_kind: string; source_ref_id: string; reason: string | null }>(
      'select amount_vnd::text as amount, source_ref_kind, source_ref_id, reason from machvon.capital_ledger_entry where allocation_line_id = $1::uuid and entry_type = $2 order by posted_at',
      [lineId, type],
    );
  const stored = async (id: string) =>
    (await rows<{ status: string; release_reason: string | null; closed_by: string | null; version: string; avc_warning_acknowledged: boolean }>('select status, release_reason, closed_by, version::text, avc_warning_acknowledged from machvon.fund_reservation where id = $1', [id]))[0];
  const expiry = (at: Date, metrics: MetricsSink = new Counters()) =>
    (harness.tenants as TenantDatabase).withTenant({ tenantId: TENANT_A, membershipId: WORKER_MEMBERSHIP_ID, scopeVersion: 0 }, (tx) =>
      new CapReservationExpiryJob(new AuditWriter(harness.tenants as TenantDatabase), metrics).run(tx, WORKER_MEMBERSHIP_ID, at),
    );

  beforeAll(async () => {
    await world.start();
    await harness.seedUnits(TENANT_A, [{ n: OTHER_BRANCH, path: `/${unitId(OTHER_BRANCH)}/` }]);
    for (const n of [INVESTOR, READER, NOBODY, ELSEWHERE]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedRole(TENANT_A, 201, 'CAP_INVESTOR', ['capital.reservation.manage', 'capital.read'], 40);
    await harness.seedRole(TENANT_A, 202, 'CAP_READER', ['capital.read'], 20);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: INVESTOR, role: 201, kind: 'TENANT' },
      { n: 2, member: READER, role: 202, kind: 'TENANT' },
      { n: 3, member: ELSEWHERE, role: 201, kind: 'UNIT_SUBTREE', refs: [unitId(OTHER_BRANCH)] },
    ]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [CommandModule.register({ database: tenants }), PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) })],
      controllers: [FundReservationController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 480_000);

  afterAll(async () => {
    if (app) await app.close();
    await world.stop();
  }, 60_000);

  it('is registered in the module of CAP', () => {
    expect(capModule.controllers).toContain(FundReservationController);
  });

  it('AC-ST-CAP-011-1, UAT-PLAN-10: with 450 of 600 million used, 150 million asks for the acknowledgement of the warning, and then 60 million more is blocked above 100 percent', async () => {
    const line = await world.publishedLine({ allocated: millions(600) });
    await world.setFigures(line.balanceId, { committed: millions(450) });
    const warned = await reserve(INVESTOR, line, millions(150));
    expect(warned).toMatchObject({ status: 422, json: { code: 'AVC_WARNING_ACK_REQUIRED', consumption_pct: '100.00', warn_pct: '90.00', block_pct: '100.00' } });
    expect((await world.balanceOf(line.balanceId)).reserved).toBe('0');
    expect(await entries(line.lineId, 'RESERVE')).toEqual([]);
    const made = await reserve(INVESTOR, line, millions(150), { avc_acknowledged: true });
    expect(made.status).toBe(200);
    expect(made.json).toMatchObject({ status: 'ACTIVE', resource_version: 1, avc_state: 'WARN', consumption_pct: '100.00' });
    const id = made.json.resource_id as string;
    expect(await stored(id)).toMatchObject({ status: 'ACTIVE', avc_warning_acknowledged: true, version: '1' });
    expect((await world.balanceOf(line.balanceId)).reserved).toBe(millions(150));
    expect(await entries(line.lineId, 'RESERVE')).toEqual([{ amount: millions(150), source_ref_kind: 'RESERVATION', source_ref_id: id, reason: 'AVC warning acknowledged at 100.00%' }]);
    // 660 of 600 is above the block threshold, whatever the acknowledgement.
    const over = await reserve(INVESTOR, line, millions(60), { avc_acknowledged: true });
    expect(over).toMatchObject({ status: 422, json: { code: 'AVC_BLOCKED', reason: 'ABOVE_BLOCK', consumption_pct: '110.00' } });
    expect((await world.balanceOf(line.balanceId)).reserved).toBe(millions(150));
    expect(await rows('select 1 from machvon.fund_reservation where allocation_line_id = $1::uuid', [line.lineId])).toHaveLength(1);
  });

  it('writes one audit row and one event for a reservation, with the share, and none for a refusal', async () => {
    const line = await world.publishedLine({ allocated: millions(100) });
    expect((await reserve(INVESTOR, line, millions(200))).status).toBe(422);
    const made = await reserve(INVESTOR, line, millions(40), { purpose: 'LAND_CLEARANCE', reference_kind: 'LAND_PLOT', reference_id: randomUUID() });
    const id = made.json.resource_id as string;
    const audit = await rows<{ safe_diff: Record<string, unknown>; actor_id: string }>(`select safe_diff, actor_id from machvon.audit_event where action = 'capital.reservation_created' and resource_id = $1`, [id]);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actor_id).toBe(memberId(INVESTOR));
    expect(audit[0]?.safe_diff).toMatchObject({ allocation_line_id: line.lineId, amount_vnd: millions(40), purpose: 'LAND_CLEARANCE', avc_state: 'OK', consumption_pct: '40.00', warning_acknowledged: false });
    const events = await rows<{ payload: Record<string, unknown> }>(`select payload from machvon.outbox_event where type = 'capital.reservation_created.v1' and aggregate_id = $1`, [id]);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({ reservation_id: id, allocation_line_id: line.lineId, appropriation_id: line.appropriationId, project_id: line.projectId, amount_vnd: millions(40), purpose: 'LAND_CLEARANCE' });
    expect(await rows(`select 1 from machvon.audit_event where action = 'capital.reservation_created' and safe_diff ->> 'allocation_line_id' = $1`, [line.lineId])).toHaveLength(1);
  });

  it('serialises two reservations made at once that together would overspend the line: one is made, the other is blocked', async () => {
    const line = await world.publishedLine({ allocated: millions(1000) });
    const [one, two] = await Promise.all([reserve(INVESTOR, line, millions(600), { avc_acknowledged: true }), reserve(INVESTOR, line, millions(600), { avc_acknowledged: true })]);
    expect([one.status, two.status].sort()).toEqual([200, 422]);
    expect([one, two].find((reply) => reply.status === 422)?.json.code).toBe('AVC_BLOCKED');
    expect((await world.balanceOf(line.balanceId)).reserved).toBe(millions(600));
  });

  it('AC-ST-CAP-011-2, UAT-AC227: a reservation that runs out is expired once, however often the job runs: one RELEASE entry, the capital back, one event', async () => {
    const line = await world.publishedLine({ allocated: millions(100) });
    const made = await reserve(INVESTOR, line, millions(30), { expires_at: SOON(2) });
    const id = made.json.resource_id as string;
    const early = new Counters();
    expect((await expiry(new Date(Date.now() + 86_400_000), early)).expired).toBe(0);
    expect((await stored(id))?.status).toBe('ACTIVE');
    const later = new Date(Date.now() + 3 * 86_400_000);
    const metrics = new Counters();
    const first = await expiry(later, metrics);
    expect(first.expired).toBe(1);
    const second = await expiry(later, metrics);
    expect(second.expired).toBe(0);
    expect(await stored(id)).toMatchObject({ status: 'EXPIRED', release_reason: 'EXPIRED', closed_by: WORKER_MEMBERSHIP_ID, version: '2' });
    expect(await entries(line.lineId, 'RELEASE')).toEqual([{ amount: millions(30), source_ref_kind: 'RESERVATION', source_ref_id: id, reason: 'EXPIRED' }]);
    expect((await world.balanceOf(line.balanceId)).reserved).toBe('0');
    expect(await rows(`select 1 from machvon.outbox_event where type = 'capital.reservation_released.v1' and aggregate_id = $1`, [id])).toHaveLength(1);
    expect(await rows(`select 1 from machvon.audit_event where action = 'capital.reservation_expired' and resource_id = $1`, [id])).toHaveLength(1);
    expect(metrics.counts.get('cap_reservation_expired_total')).toBe(first.expired);
    // Released afterwards: it is no longer active.
    expect(await release(INVESTOR, id, 2)).toMatchObject({ status: 409, json: { code: 'RESERVATION_NOT_ACTIVE' } });
  });

  it('drains a backlog of more than one batch of due reservations in the one pass', async () => {
    const line = await world.publishedLine({ allocated: millions(1000) });
    await world.setFigures(line.balanceId, { reserved: '205000' });
    await rows(
      `insert into machvon.fund_reservation (tenant_id, id, allocation_line_id, project_id, plan_year, purpose, amount_vnd, expires_at, status, created_at, created_by, updated_by)
       select $1, gen_random_uuid(), $2, $3, $4, 'OTHER', 1000, now() - interval '1 day' + make_interval(secs => n), 'ACTIVE', now() - interval '2 days', $5, $5 from generate_series(1, 205) as n`,
      [TENANT_A, line.lineId, line.projectId, line.year, memberId(INVESTOR)],
    );
    const summary = await expiry(new Date());
    expect(summary.expired).toBe(205);
    expect(await rows("select 1 from machvon.fund_reservation where allocation_line_id = $1::uuid and status = 'ACTIVE'", [line.lineId])).toHaveLength(0);
    expect(await entries(line.lineId, 'RELEASE')).toHaveLength(205);
    expect((await world.balanceOf(line.balanceId)).reserved).toBe('0');
  });

  it('locks the balances of a whole batch of expiries together in the one lock order, so it holds none of them while it waits for another', async () => {
    const one = await world.publishedLine({ allocated: millions(100) });
    const two = await world.publishedLine({ allocated: millions(100) });
    const [lower, higher] = one.balanceId < two.balanceId ? [one, two] : [two, one];
    // The reservation on the balance that is locked last expires first: made in the order of the time, a batch would take it before the other.
    await reserve(INVESTOR, higher, millions(10), { expires_at: SOON(2) });
    await reserve(INVESTOR, lower, millions(10), { expires_at: SOON(3) });
    const holder = new Client({ connectionString: harness.database.adminUrl });
    const prober = new Client({ connectionString: harness.database.adminUrl });
    await holder.connect();
    await prober.connect();
    try {
      await holder.query('begin');
      await holder.query('select 1 from machvon.allocation_balance where id = $1::uuid for update', [lower.balanceId]);
      const batch = expiry(new Date(Date.now() + 5 * 86_400_000));
      await new Promise((resolve) => setTimeout(resolve, 1500));
      // The batch waits for the lower balance and holds the higher one only if it took it first: it must not.
      await prober.query('begin');
      const free = await prober.query('select 1 from machvon.allocation_balance where id = $1::uuid for update nowait', [higher.balanceId]);
      expect(free.rowCount).toBe(1);
      await prober.query('rollback');
      await holder.query('commit');
      expect((await batch).expired).toBe(2);
    } finally {
      await holder.end();
      await prober.end();
    }
    expect((await world.balanceOf(lower.balanceId)).reserved).toBe('0');
    expect((await world.balanceOf(higher.balanceId)).reserved).toBe('0');
  });

  it('releases a reservation with a reason against the version read: the capital returns with one RELEASE entry, a second release is refused', async () => {
    const line = await world.publishedLine({ allocated: millions(100) });
    const id = (await reserve(INVESTOR, line, millions(30))).json.resource_id as string;
    expect(await release(INVESTOR, id, 7)).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT' } });
    expect(await release(INVESTOR, id, 1, 'no')).toMatchObject({ status: 422 });
    const done = await release(INVESTOR, id, 1, 'The contract was dropped.');
    expect(done).toMatchObject({ status: 200, json: { status: 'RELEASED', resource_version: 2 } });
    expect(await stored(id)).toMatchObject({ status: 'RELEASED', release_reason: 'The contract was dropped.', closed_by: memberId(INVESTOR) });
    expect(await entries(line.lineId, 'RELEASE')).toHaveLength(1);
    expect((await world.balanceOf(line.balanceId)).reserved).toBe('0');
    expect(await release(INVESTOR, id, 2)).toMatchObject({ status: 409, json: { code: 'RESERVATION_NOT_ACTIVE' } });
    expect(await entries(line.lineId, 'RELEASE')).toHaveLength(1);
    const events = await rows<{ payload: Record<string, unknown> }>(`select payload from machvon.outbox_event where type = 'capital.reservation_released.v1' and aggregate_id = $1`, [id]);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({ status: 'RELEASED', reason: 'The contract was dropped.', amount_vnd: millions(30) });
    // The capital that came back can be reserved again.
    expect((await reserve(INVESTOR, line, millions(100), { avc_acknowledged: true })).status).toBe(200);
    // Once closed it is final whatever happens to the line: a plan revision that moves the balance does not make it disappear (409, not 404), and the stale version is told first.
    const moved = await world.publishedLine({ allocated: millions(1) });
    await rows('delete from machvon.allocation_balance where id = $1::uuid', [moved.balanceId]);
    await rows('update machvon.allocation_balance set allocation_line_id = $2::uuid where id = $1::uuid', [line.balanceId, moved.lineId]);
    expect(await release(INVESTOR, id, 9)).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT' } });
    expect(await release(INVESTOR, id, 2)).toMatchObject({ status: 409, json: { code: 'RESERVATION_NOT_ACTIVE' } });
  });

  it('wants what a reservation names: whole VND above zero, a purpose of the list, a reference that is a kind with an id, a last instant ahead and within a year (422 naming the field)', async () => {
    const line = await world.publishedLine({ allocated: millions(100) });
    const cases: Array<[string, Record<string, unknown>]> = [
      ['amount_vnd', { amount_vnd: '0' }],
      ['amount_vnd', { amount_vnd: '-5' }],
      ['amount_vnd', { amount_vnd: '10.5' }],
      ['purpose', { purpose: 'HOLIDAY' }],
      ['reference_id', { reference_kind: 'LAND_PLOT' }],
      ['reference_kind', { reference_id: randomUUID() }],
      ['expires_at', { expires_at: SOON(-1) }],
      ['expires_at', { expires_at: SOON(400) }],
      ['expires_at', { expires_at: 'tomorrow' }],
    ];
    for (const [field, extra] of cases) {
      const reply = await reserve(INVESTOR, line, millions(1), extra);
      expect([reply.status, reply.json.code, reply.json.detail ?? reply.json.field]).toEqual([422, 'VALIDATION_FAILED', field]);
    }
    expect((await world.balanceOf(line.balanceId)).reserved).toBe('0');
  });

  it('refuses a line that does not exist (404), a project out of the scope of the caller (404), and one the caller may see and not reserve for (403)', async () => {
    const line = await world.publishedLine({ allocated: millions(100) });
    expect((await reserve(INVESTOR, { ...line, lineId: randomUUID() }, millions(1))).status).toBe(404);
    expect((await reserve(ELSEWHERE, line, millions(1))).status).toBe(404);
    expect((await reserve(READER, line, millions(1))).status).toBe(403);
    expect((await reserve(NOBODY, line, millions(1))).status).toBe(403);
    const id = (await reserve(INVESTOR, line, millions(1))).json.resource_id as string;
    expect((await release(ELSEWHERE, id, 1)).status).toBe(404);
    expect((await release(READER, id, 1)).status).toBe(403);
    expect((await release(INVESTOR, randomUUID(), 1)).status).toBe(404);
    expect((await stored(id))?.status).toBe('ACTIVE');
  });

  it('lists the reservations the caller sees newest first, by status, line and project, a page at a time', async () => {
    const line = await world.publishedLine({ allocated: millions(100) });
    const ids: string[] = [];
    for (const amount of [1, 2, 3]) ids.push((await reserve(INVESTOR, line, millions(amount))).json.resource_id as string);
    await release(INVESTOR, ids[0] as string, 1);
    const all = await call('GET', `/fund-reservations?allocation_line_id=${line.lineId}`, { member: READER });
    expect((all.json.items as Array<{ id: string }>).map((item) => item.id)).toEqual([...ids].reverse());
    expect((all.json.items as Array<Record<string, unknown>>)[0]).toMatchObject({ allocation_line_id: line.lineId, project: { id: line.projectId }, purpose: 'CONTRACT_PENDING', amount_vnd: millions(3), status: 'ACTIVE', plan_year: line.year, version: 1 });
    const active = await call('GET', `/fund-reservations?allocation_line_id=${line.lineId}&status=ACTIVE`, { member: READER });
    expect((active.json.items as unknown[]).length).toBe(2);
    expect(((await call('GET', `/fund-reservations?project_id=${line.projectId}&status=RELEASED`, { member: READER })).json.items as Array<{ id: string }>).map((item) => item.id)).toEqual([ids[0]]);
    const first = await call('GET', `/fund-reservations?allocation_line_id=${line.lineId}&limit=2`, { member: READER });
    expect((first.json.items as unknown[]).length).toBe(2);
    expect(typeof first.json.next_cursor).toBe('string');
    const second = await call('GET', `/fund-reservations?allocation_line_id=${line.lineId}&limit=2&cursor=${encodeURIComponent(first.json.next_cursor as string)}`, { member: READER });
    expect((second.json.items as Array<{ id: string }>).map((item) => item.id)).toEqual([ids[0]]);
    expect(second.json.next_cursor).toBeNull();
    expect((await call('GET', `/fund-reservations?allocation_line_id=${line.lineId}`, { member: ELSEWHERE })).json.items).toEqual([]);
    expect((await call('GET', '/fund-reservations', { member: NOBODY })).status).toBe(403);
    for (const bad of ['status=MAYBE', 'allocation_line_id=x', 'project_id=y', 'cursor=z']) expect((await call('GET', `/fund-reservations?${bad}`, { member: READER })).status).toBe(422);
  });

  it('keeps the balances equal to the ledger: the nightly check finds no drift after a reservation and a release, and finds the reserved column when it is tampered with', async () => {
    const line = await world.publishedLine({ allocated: millions(100) });
    const kept = (await reserve(INVESTOR, line, millions(20))).json.resource_id as string;
    const gone = (await reserve(INVESTOR, line, millions(10))).json.resource_id as string;
    await release(INVESTOR, gone, 1);
    const check = () => (harness.tenants as TenantDatabase).withTenant({ tenantId: TENANT_A, membershipId: WORKER_MEMBERSHIP_ID, scopeVersion: 0 }, (tx) => new CapBalanceReconcileJob(new AuditWriter(harness.tenants as TenantDatabase)).drift(tx));
    const mine = async () => (await check()).filter((row) => row.appropriationId === line.appropriationId);
    expect(await mine()).toEqual([]);
    expect((await world.balanceOf(line.balanceId)).reserved).toBe(millions(20));
    await world.owner('update machvon.allocation_balance set reserved_vnd = reserved_vnd + 7 where id = $1::uuid', [line.balanceId]);
    expect(await mine()).toEqual([expect.objectContaining({ column: 'reserved_vnd', differenceVnd: '7', ledgerVnd: millions(20), balanceVnd: String(20 * MILLION + 7) })]);
    expect(kept).toBeDefined();
  });

  it('is kept by the database as well: what was reserved never changes, a closed reservation is final, and nothing is deleted', async () => {
    const line = await world.publishedLine({ allocated: millions(100) });
    const id = (await reserve(INVESTOR, line, millions(10))).json.resource_id as string;
    await expect(rows('update machvon.fund_reservation set amount_vnd = amount_vnd + 1 where id = $1', [id])).rejects.toThrow(/does not change/);
    await expect(rows("update machvon.fund_reservation set purpose = 'OTHER', expires_at = expires_at + interval '1 day' where id = $1", [id])).rejects.toThrow();
    await expect(rows("update machvon.fund_reservation set status = 'RELEASED' where id = $1", [id])).rejects.toThrow();
    await expect(rows("update machvon.fund_reservation set status = 'ACTIVE', closed_at = now(), closed_by = created_by where id = $1", [id])).rejects.toThrow();
    await release(INVESTOR, id, 1);
    await expect(rows("update machvon.fund_reservation set status = 'ACTIVE', closed_at = null, closed_by = null, release_reason = null where id = $1", [id])).rejects.toThrow(/RESERVATION_NOT_ACTIVE/);
    const asApplication = (sql: string): Promise<string> =>
      harness.tenants.withTenant({ tenantId: TENANT_A, membershipId: memberId(INVESTOR), scopeVersion: 0 }, (tx) => tx.query(sql)).then(
        () => 'written',
        (error: { message: string }) => error.message,
      );
    expect(await asApplication('delete from machvon.fund_reservation')).toContain('permission denied');
    // A reference is a kind with an id, or neither.
    await expect(
      rows("insert into machvon.fund_reservation (tenant_id, id, allocation_line_id, project_id, plan_year, purpose, reference_kind, amount_vnd, expires_at, status, created_by, updated_by) values ($1, $2, $3, $4, 2026, 'OTHER', 'ONLY_A_KIND', 5, now() + interval '1 day', 'ACTIVE', $5, $5)", [TENANT_A, randomUUID(), line.lineId, line.projectId, memberId(INVESTOR)]),
    ).rejects.toThrow(/fund_reservation_reference_chk/);
  });
});
