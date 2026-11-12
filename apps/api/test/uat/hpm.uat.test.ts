import { createHash, randomUUID } from 'node:crypto';
import { FileService } from '../../src/modules/files';
import { TENANT_A } from '../../../../packages/db/test/support/authz-fixtures';
import { assertStatus, codeOf, expectCheckFails } from './uat-kit';
import type { Reply } from './uat-kit';
import { UatWorld } from './uat-world';

/**
 * UAT of the push of the issued reports to HPM (docs/uat/hpm/uat.json, HSKT row TH.01, screens HPM-01 and HPM-02): the journey of the pusher and the receiver, the idempotency of a push, the order of the
 * revisions, the separation of the two hands, the switch of the connection, and the rows of the audit trail and the outbox that every command must leave. The adapter is the file writer of the edition
 * (no call leaves the process), so what HPM answers is PENDING-EXTERNAL and the receipts here are recorded by hand, as the design says (R18). Each case is named by its id in docs/uat/hpm/uat.json.
 */
jest.setTimeout(600_000);

const LAYOUT = 'HPM-MONTHLY';
const REASON = 'HPM is being migrated by the customer';
const PERSONAS = {
  'hpm-admin': ['hpm.read', 'hpm.admin', 'hpm.push', 'hpm.receipt', 'hpm.correction.propose', 'hpm.correction.decide'],
  'hpm-pusher': ['hpm.read', 'hpm.push'],
  'hpm-receiver': ['hpm.read', 'hpm.receipt'],
  'hpm-reader': ['hpm.read'],
};

describe('UAT of the push to HPM (TH.01, HPM-01, HPM-02)', () => {
  const world = new UatWorld();
  let counter = 0;

  beforeAll(async () => {
    await world.start(PERSONAS, { 'hpm-admin': PERSONAS['hpm-admin'] });
  }, 600_000);

  afterAll(() => world.stop(), 60_000);

  /** A report file in the store of the tenant, as an issued copy leaves it: the key to name and the hash to state. */
  async function report(content = `row-${(counter += 1)}`): Promise<{ key: string; sha: string }> {
    const bytes = new TextEncoder().encode(`code,value\n${content}\n`);
    const stored = await world.get<FileService>(FileService).upload({ tenantId: TENANT_A, membershipId: world.idOf('hpm-admin'), scopeVersion: 1 }, { purpose: 'report_export', declaredType: 'text/csv', bytes });
    return { key: stored.key, sha: createHash('sha256').update(bytes).digest('hex') };
  }

  const push = (persona: string, file: { key: string; sha: string }, period: string, revision: number, key?: string): Promise<Reply> =>
    world.as(persona, 'POST', '/hpm/pushes', { ...(key === undefined ? {} : { key }), body: { layout_code: LAYOUT, period, revision, sha256: file.sha, file_object_key: file.key } });
  const pushOf = (reply: Reply): Record<string, unknown> => reply.json.push as Record<string, unknown>;
  const receipt = (persona: string, row: Record<string, unknown>, body: Record<string, unknown>): Promise<Reply> => world.as(persona, 'POST', `/hpm/pushes/${String(row.id)}/receipt`, { ifMatch: row.version as number, body });
  const countPushes = async (period: string): Promise<number> => (await world.rows('select 1 from machvon.hpm_push where period = $1', [period])).length;

  it('UAT-HPM-E2E-01 a pusher sends an issued report, another person records the receipt, and the log, the audit trail and the outbox all say so', async () => {
    const file = await report('executed,100');
    const sent = await push('hpm-pusher', file, '2026-M10', 1);
    assertStatus(sent, 200);
    expect(sent.json).toMatchObject({ status: 'SENT' });
    const row = pushOf(sent);
    expect(row).toMatchObject({ layout_code: LAYOUT, period: '2026-M10', revision: 1, sha256: file.sha, status: 'WRITTEN', attempts: 1, acceptance: 'PENDING_EXTERNAL', pushed_by: world.idOf('hpm-pusher') });
    const [submitted] = await world.audits(row.id as string, 'hpm.push_submitted');
    expect(submitted).toMatchObject({ actor_id: world.idOf('hpm-pusher'), safe_diff: { outcome: 'SENT', status: 'WRITTEN', sha256: file.sha } });
    const [announced] = await world.events(row.id as string, 'hpm.push.sent.v1');
    expect(announced?.payload).toMatchObject({ tenant_id: TENANT_A, push_id: row.id, sha256: file.sha });
    // The report itself never travels in the event.
    expect(JSON.stringify(announced?.payload)).not.toContain('executed,100');

    const done = await receipt('hpm-receiver', row, { outcome: 'ACCEPTED', reference: 'HPM-2026-10-0001' });
    assertStatus(done, 200);
    expect(done.json).toMatchObject({ status: 'ACCEPTED', resource_id: row.id });
    expect((await world.audits(row.id as string, 'hpm.receipt_accepted'))[0]).toMatchObject({ actor_id: world.idOf('hpm-receiver') });
    expect(await world.events(row.id as string, 'hpm.push.receipt.recorded.v1')).toHaveLength(1);
    const listed = await world.as('hpm-reader', 'GET', '/hpm/pushes?period=2026-M10');
    expect((listed.json.items as Array<Record<string, unknown>>)[0]).toMatchObject({ status: 'ACCEPTED', receipt: { reference: 'HPM-2026-10-0001', by: world.idOf('hpm-receiver') } });
  });

  it('UAT-HPM-IDM-01 the same Idempotency-Key sent twice answers the first answer: one row, one attempt', async () => {
    const file = await report();
    const key = `uat-${randomUUID()}`;
    const first = await push('hpm-pusher', file, '2026-M09', 1, key);
    const second = await push('hpm-pusher', file, '2026-M09', 1, key);
    assertStatus(second, 200);
    expect(second.json.resource_id).toBe(first.json.resource_id);
    expect(await countPushes('2026-M09')).toBe(1);
    expect(await world.rows('select 1 from machvon.hpm_push_attempt a join machvon.hpm_push p on p.id = a.push_id where p.period = $1', ['2026-M09'])).toHaveLength(1);
  });

  it('UAT-HPM-IDM-02 the same report pushed again under a new key is ALREADY_DELIVERED and makes no new attempt', async () => {
    const file = await report();
    const first = await push('hpm-pusher', file, '2026-M08', 1);
    const again = await push('hpm-pusher', file, '2026-M08', 1);
    assertStatus(again, 200);
    expect(again.json).toMatchObject({ status: 'ALREADY_DELIVERED', resource_id: pushOf(first).id });
    expect(pushOf(again)).toMatchObject({ attempts: 1 });
    expect(await countPushes('2026-M08')).toBe(1);
  });

  it('UAT-HPM-IDM-03 the same period and revision with other content is refused (409 HPM_KEY_REUSED) and nothing is written', async () => {
    const first = await push('hpm-pusher', await report('one,1'), '2026-M07', 1);
    assertStatus(first, 200);
    const other = await push('hpm-pusher', await report('other,2'), '2026-M07', 1);
    assertStatus(other, 409, 'HPM_KEY_REUSED');
    expect(await countPushes('2026-M07')).toBe(1);
  });

  it('UAT-HPM-IDM-04 five identical pushes at the same moment under one key make one row and one package: the callers that lose the race get the answer of the winner', async () => {
    const file = await report('race,bytes');
    const key = `uat-${randomUUID()}`;
    const replies = await Promise.all(Array.from({ length: 5 }, () => push('hpm-pusher', file, '2026-M11', 1, key)));
    for (const reply of replies) expect([200, 409]).toContain(reply.status);
    expect(replies.filter((reply) => reply.status === 200).length).toBeGreaterThanOrEqual(1);
    expect(await countPushes('2026-M11')).toBe(1);
    expect(await world.rows('select 1 from machvon.hpm_push_attempt a join machvon.hpm_push p on p.id = a.push_id where p.period = $1', ['2026-M11'])).toHaveLength(1);
  });

  it('UAT-HPM-STA-01 a push that was accepted or rejected cannot be retried and a decided push takes no second receipt (409)', async () => {
    const accepted = pushOf(await push('hpm-pusher', await report(), '2026-M06', 1));
    assertStatus(await receipt('hpm-receiver', accepted, { outcome: 'ACCEPTED', reference: 'HPM-6' }), 200);
    const current = ((await world.as('hpm-reader', 'GET', '/hpm/pushes?period=2026-M06')).json.items as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
    assertStatus(await world.as('hpm-pusher', 'POST', `/hpm/pushes/${String(accepted.id)}/retry`, { ifMatch: current.version as number, body: {} }), 409, 'HPM_PUSH_STATE_INVALID');
    assertStatus(await receipt('hpm-receiver', current, { outcome: 'ACCEPTED', reference: 'HPM-6-again' }), 409);
    const rejected = pushOf(await push('hpm-pusher', await report(), '2026-M05', 1));
    assertStatus(await receipt('hpm-receiver', rejected, { outcome: 'REJECTED', reference: 'HPM-5', note: 'The totals of the capital sources do not add up' }), 200);
    const afterwards = ((await world.as('hpm-reader', 'GET', '/hpm/pushes?period=2026-M05')).json.items as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
    assertStatus(await world.as('hpm-pusher', 'POST', `/hpm/pushes/${String(rejected.id)}/retry`, { ifMatch: afterwards.version as number, body: {} }), 409, 'HPM_PUSH_STATE_INVALID');
  });

  it('UAT-HPM-STA-02 an older revision is refused after a newer one (409 REPORT_OUT_OF_DATE) and a newer revision cannot replace an accepted period without a reopening and an approved correction', async () => {
    assertStatus(await push('hpm-pusher', await report('rev,two'), '2026-M04', 2), 200);
    const older = await push('hpm-pusher', await report('rev,one'), '2026-M04', 1);
    assertStatus(older, 409, 'REPORT_OUT_OF_DATE');
    expect(older.json).toMatchObject({ current_revision: 2 });
    expect(await countPushes('2026-M04')).toBe(1);
    const accepted = pushOf(await push('hpm-pusher', await report('acc,one'), '2026-M03', 1));
    assertStatus(await receipt('hpm-receiver', accepted, { outcome: 'ACCEPTED', reference: 'HPM-3' }), 200);
    const replace = await push('hpm-pusher', await report('acc,two'), '2026-M03', 2);
    assertStatus(replace, 409, 'HPM_OVERWRITE_NOT_AUTHORISED');
    expect(replace.json).toMatchObject({ missing: ['PERIOD_REOPENED', 'APPROVED_CORRECTION'], accepted_revision: 1 });
    expect(await world.rows('select 1 from machvon.hpm_push where period = $1 and revision = 2', ['2026-M03'])).toHaveLength(0);
  });

  it('UAT-HPM-SOD-01 the person who pushed cannot record the receipt of that push, even holding both rights (403 SELF_APPROVAL_DENIED), and a rejection needs a note of ten characters (422)', async () => {
    const mine = pushOf(await push('hpm-admin', await report(), '2026-M02', 1));
    const own = await receipt('hpm-admin', mine, { outcome: 'ACCEPTED', reference: 'HPM-2' });
    assertStatus(own, 403, 'SELF_APPROVAL_DENIED');
    assertStatus(await receipt('hpm-receiver', mine, { outcome: 'REJECTED', reference: 'HPM-2', note: 'short' }), 422);
    expect((await world.audits(mine.id as string, 'hpm.receipt_accepted')).length).toBe(0);
  });

  it('UAT-HPM-DAT-01 switching the connection off needs a reason and the current version, is audited with its reason, and while it is off a push is refused (409 HPM_CONNECTION_DISABLED)', async () => {
    const connection = await world.as('hpm-reader', 'GET', '/hpm/connection');
    const version = connection.json.version as number;
    assertStatus(await world.as('hpm-admin', 'POST', '/hpm/connection/state', { ifMatch: version + 5, body: { enabled: false, reason: REASON } }), 409, 'VERSION_CONFLICT');
    assertStatus(await world.as('hpm-admin', 'POST', '/hpm/connection/state', { ifMatch: version, body: { enabled: false, reason: 'no' } }), 422);
    const off = await world.as('hpm-admin', 'POST', '/hpm/connection/state', { ifMatch: version, body: { enabled: false, reason: REASON } });
    assertStatus(off, 200);
    expect((await world.audits(off.json.resource_id as string, 'hpm.connection_switched'))[0]).toMatchObject({ reason: REASON, safe_diff: { to_enabled: false } });
    assertStatus(await push('hpm-pusher', await report(), '2026-M01', 1), 409, 'HPM_CONNECTION_DISABLED');
    expect(await countPushes('2026-M01')).toBe(0);
    const on = await world.as('hpm-admin', 'POST', '/hpm/connection/state', { ifMatch: off.json.resource_version as number, body: { enabled: true, reason: 'HPM has been migrated and is back' } });
    assertStatus(on, 200);
    assertStatus(await push('hpm-pusher', await report(), '2026-M01', 1), 200);
  });

  it('UAT-HPM-ISO-01 a member of another tenant is answered 404 for a push of this tenant, as for an id that does not exist, and the log of the other tenant is empty', async () => {
    const mine = pushOf(await push('hpm-pusher', await report(), '2025-M12', 1));
    const foreign = await world.asTenantB(1, 'POST', `/hpm/pushes/${String(mine.id)}/receipt`, { ifMatch: mine.version as number, body: { outcome: 'ACCEPTED', reference: 'X' } });
    const nothing = await world.asTenantB(1, 'POST', `/hpm/pushes/${randomUUID()}/receipt`, { ifMatch: 1, body: { outcome: 'ACCEPTED', reference: 'X' } });
    expect([foreign.status, codeOf(foreign)]).toEqual([nothing.status, codeOf(nothing)]);
    assertStatus(foreign, 404);
    const log = await world.asTenantB(1, 'GET', '/hpm/pushes');
    assertStatus(log, 200);
    expect(log.json.items).toEqual([]);
  });

  it('negative control: the checks of this suite go red on an answer that is wrong on purpose', () => {
    expectCheckFails(() => assertStatus({ status: 200, json: {} }, 409, 'HPM_KEY_REUSED'));
    expectCheckFails(() => assertStatus({ status: 409, json: { code: 'OTHER' } }, 409, 'HPM_KEY_REUSED'));
  });
});
