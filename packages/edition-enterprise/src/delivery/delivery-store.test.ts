import type { TenantTx } from '@machvon/db';
import { DomainError } from '@machvon/kernel';
import { ReportMailStore } from './delivery-store.ts';
import { DELIVERY_LOST_AFTER_MINUTES } from './delivery-rules.ts';
import type { DeliveryScheduleRequest } from './delivery-rules.ts';

interface Call {
  sql: string;
  params: unknown[];
}

function fakeTx(answer: (sql: string, params: unknown[]) => unknown[] | Error): { tx: TenantTx; calls: Call[] } {
  const calls: Call[] = [];
  const tx: TenantTx = {
    query: async <R>(sql: string, params: unknown[] = []): Promise<R[]> => {
      calls.push({ sql, params });
      const result = answer(sql, params);
      if (result instanceof Error) throw result;
      return result as R[];
    },
  };
  return { tx, calls };
}

const SCHEDULE_ID = '11111111-1111-4111-8111-111111111111';
const ISSUE_ID = '22222222-2222-4222-8222-222222222222';
const MEMBER_A = '33333333-3333-4333-8333-333333333333';
const MEMBER_B = '44444444-4444-4444-8444-444444444444';
const AT = new Date('2026-11-09T03:00:00.000Z');

const scheduleSql = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: SCHEDULE_ID,
  layout_code: 'HPM-MONTHLY',
  cron: '0 8 5 * *',
  timezone: 'Asia/Ho_Chi_Minh',
  format: 'XLSX',
  recipients: [MEMBER_A],
  note: null,
  status: 'ACTIVE',
  last_run_at: null,
  retired_at: null,
  retired_by: null,
  retire_reason: null,
  created_by: 'maker',
  created_at: '2026-11-01T00:00:00.000000Z',
  version: '3',
  ...patch,
});

const mailingSql = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'mail-1',
  schedule_id: SCHEDULE_ID,
  issue_id: ISSUE_ID,
  recipient_id: MEMBER_A,
  file_format: 'XLSX',
  file_name: null,
  file_sha256: null,
  status: 'SENDING',
  attempts: 1,
  error_code: null,
  provider_message_id: null,
  first_attempt_at: null,
  last_attempt_at: null,
  sent_at: null,
  created_at: '2026-11-09T03:00:00.000000Z',
  ...patch,
});

const request = (patch: Partial<DeliveryScheduleRequest> = {}): DeliveryScheduleRequest => ({ layoutCode: 'HPM-MONTHLY', cron: '0 8 5 * *', format: 'XLSX', recipients: [MEMBER_A], note: null, ...patch }) as DeliveryScheduleRequest;

describe('ReportMailStore.createSchedule', () => {
  it('refuses a recipient who is not an active member of the tenant, and writes nothing', async () => {
    const { tx, calls } = fakeTx(() => [{ membership_id: MEMBER_A }]);
    await expect(new ReportMailStore().createSchedule(tx, request({ recipients: [MEMBER_A, MEMBER_B] }), 'maker')).rejects.toMatchObject({ code: 'RECIPIENT_OUT_OF_TENANT', status: 422, detail: 'recipients' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toContain("status = 'ACTIVE'");
    expect(calls[0]?.params).toEqual([[MEMBER_A, MEMBER_B]]);
  });

  it('writes the schedule under the tenant of the transaction and maps the row, version as a number', async () => {
    const { tx, calls } = fakeTx((sql) => (sql.startsWith('insert') ? [scheduleSql({ note: 'monthly' })] : [{ membership_id: MEMBER_A }]));
    const row = await new ReportMailStore().createSchedule(tx, request({ note: 'monthly' }), 'maker');
    expect(row).toMatchObject({ id: SCHEDULE_ID, layoutCode: 'HPM-MONTHLY', cron: '0 8 5 * *', timezone: 'Asia/Ho_Chi_Minh', format: 'XLSX', recipients: [MEMBER_A], note: 'monthly', status: 'ACTIVE', createdBy: 'maker', version: 3 });
    expect(calls[1]?.sql).toContain("current_setting('app.tenant_id', true)");
    expect(calls[1]?.params).toEqual(['HPM-MONTHLY', '0 8 5 * *', 'XLSX', [MEMBER_A], 'monthly', 'maker']);
  });
});

describe('ReportMailStore reads of schedules', () => {
  it('finds one schedule, locking the row only when asked, and is undefined for an id that is not there', async () => {
    const { tx, calls } = fakeTx(() => [scheduleSql()]);
    const store = new ReportMailStore();
    expect((await store.findSchedule(tx, SCHEDULE_ID))?.id).toBe(SCHEDULE_ID);
    await store.findSchedule(tx, SCHEDULE_ID, true);
    expect(calls[0]?.sql).not.toContain('for update');
    expect(calls[1]?.sql).toContain('for update');
    expect(await store.findSchedule(fakeTx(() => []).tx, SCHEDULE_ID)).toBeUndefined();
  });

  it('lists with nulls for the filters not given, and with the filters given', async () => {
    const { tx, calls } = fakeTx(() => [scheduleSql(), scheduleSql({ id: 'other' })]);
    const store = new ReportMailStore();
    expect((await store.listSchedules(tx, {}, 50)).map((row) => row.id)).toEqual([SCHEDULE_ID, 'other']);
    await store.listSchedules(tx, { status: 'RETIRED', layoutCode: 'PVN-MONTHLY' }, 10);
    expect(calls[0]?.params).toEqual([null, null, 50]);
    expect(calls[1]?.params).toEqual(['RETIRED', 'PVN-MONTHLY', 10]);
  });

  it('reads the active schedules locked with skip locked, so that two processes do not run one', async () => {
    const { tx, calls } = fakeTx(() => [scheduleSql()]);
    expect(await new ReportMailStore().activeForRun(tx)).toHaveLength(1);
    expect(calls[0]?.sql).toContain('for update skip locked');
    expect(calls[0]?.sql).toContain("status = 'ACTIVE'");
  });

  it('marks the run with the instant as ISO text', async () => {
    const { tx, calls } = fakeTx(() => []);
    await new ReportMailStore().markRun(tx, SCHEDULE_ID, AT);
    expect(calls[0]?.params).toEqual([SCHEDULE_ID, '2026-11-09T03:00:00.000Z']);
  });
});

describe('ReportMailStore.retire', () => {
  it('is not found for an unknown schedule', async () => {
    await expect(new ReportMailStore().retire(fakeTx(() => []).tx, SCHEDULE_ID, 3, 'why', 'checker', AT)).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
  });

  it('refuses a version other than the one the caller read, and updates nothing', async () => {
    const { tx, calls } = fakeTx(() => [scheduleSql({ version: '4' })]);
    await expect(new ReportMailStore().retire(tx, SCHEDULE_ID, 3, 'why', 'checker', AT)).rejects.toBeInstanceOf(DomainError);
    expect(calls.some((call) => call.sql.startsWith('update'))).toBe(false);
  });

  it('refuses to retire a schedule that is retired already', async () => {
    const { tx, calls } = fakeTx(() => [scheduleSql({ status: 'RETIRED' })]);
    await expect(new ReportMailStore().retire(tx, SCHEDULE_ID, 3, 'why', 'checker', AT)).rejects.toMatchObject({ code: 'STAGE_TRANSITION_DENIED', status: 409, detail: 'status' });
    expect(calls.some((call) => call.sql.startsWith('update'))).toBe(false);
  });

  it('reads the row locked, then retires it with the reason, the person and the instant', async () => {
    const { tx, calls } = fakeTx((sql) => [sql.startsWith('update') ? scheduleSql({ status: 'RETIRED', version: '4', retired_by: 'checker', retire_reason: 'why' }) : scheduleSql()]);
    const row = await new ReportMailStore().retire(tx, SCHEDULE_ID, 3, 'why', 'checker', AT);
    expect(calls[0]?.sql).toContain('for update');
    expect(calls[1]?.params).toEqual([SCHEDULE_ID, '2026-11-09T03:00:00.000Z', 'checker', 'why']);
    expect(row).toMatchObject({ status: 'RETIRED', version: 4, retiredBy: 'checker', retireReason: 'why' });
  });
});

describe('ReportMailStore.held', () => {
  it('reads nothing for no copy', async () => {
    const { tx, calls } = fakeTx(() => []);
    expect((await new ReportMailStore().held(tx, SCHEDULE_ID, [])).size).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('keys the rows by copy and recipient', async () => {
    const { tx } = fakeTx(() => [mailingSql(), mailingSql({ id: 'mail-2', recipient_id: MEMBER_B, status: 'SENT' })]);
    const held = await new ReportMailStore().held(tx, SCHEDULE_ID, [ISSUE_ID]);
    expect([...held.keys()]).toEqual([`${ISSUE_ID}|${MEMBER_A}`, `${ISSUE_ID}|${MEMBER_B}`]);
    expect(held.get(`${ISSUE_ID}|${MEMBER_B}`)).toMatchObject({ id: 'mail-2', scheduleId: SCHEDULE_ID, issueId: ISSUE_ID, status: 'SENT' });
  });
});

describe('ReportMailStore.begin', () => {
  const input = { scheduleId: SCHEDULE_ID, issueId: ISSUE_ID, recipientId: MEMBER_A, format: 'XLSX' as const, at: AT };

  it('writes the row inside a savepoint and releases it', async () => {
    const { tx, calls } = fakeTx((sql) => (sql.startsWith('insert') ? [mailingSql()] : []));
    const row = await new ReportMailStore().begin(tx, input);
    expect(row).toMatchObject({ id: 'mail-1', status: 'SENDING', attempts: 1 });
    expect(calls.map((call) => call.sql.split(/\s/).slice(0, 2).join(' '))).toEqual(['savepoint mailing_begin', 'insert into', 'release savepoint']);
  });

  it('is undefined, with nothing sent, when the row is held by someone and is not FAILED (the conflict returns no row)', async () => {
    const { tx } = fakeTx(() => []);
    expect(await new ReportMailStore().begin(tx, input)).toBeUndefined();
  });

  it('is undefined and rolls back to the savepoint on a unique violation, so the transaction stays usable', async () => {
    const { tx, calls } = fakeTx((sql) => (sql.startsWith('insert') ? Object.assign(new Error('duplicate'), { code: '23505' }) : []));
    expect(await new ReportMailStore().begin(tx, input)).toBeUndefined();
    expect(calls[calls.length - 1]?.sql).toBe('rollback to savepoint mailing_begin');
  });

  it('lets any other database failure through and does not call it a taken row', async () => {
    const { tx, calls } = fakeTx((sql) => (sql.startsWith('insert') ? Object.assign(new Error('deadlock'), { code: '40P01' }) : []));
    await expect(new ReportMailStore().begin(tx, input)).rejects.toThrow('deadlock');
    expect(calls.some((call) => call.sql.startsWith('rollback'))).toBe(false);
  });
});

describe('ReportMailStore.skip and settle', () => {
  it('writes a skipped copy once, with the reason and no attempt', async () => {
    const { tx, calls } = fakeTx(() => []);
    await new ReportMailStore().skip(tx, { scheduleId: SCHEDULE_ID, issueId: ISSUE_ID, recipientId: MEMBER_A, format: 'DOCX', reason: 'NO_DOCX', at: AT });
    expect(calls[0]?.sql).toContain("'SKIPPED', 0");
    expect(calls[0]?.sql).toContain('on conflict');
    expect(calls[0]?.params).toEqual([SCHEDULE_ID, ISSUE_ID, MEMBER_A, 'DOCX', 'NO_DOCX', '2026-11-09T03:00:00.000Z']);
  });

  it('settles a send with what the channel said and the file that went out', async () => {
    const { tx, calls } = fakeTx(() => [mailingSql({ status: 'SENT', provider_message_id: 'msg-1', sent_at: '2026-11-09T03:00:01.000000Z', file_name: 'a.xlsx', file_sha256: 'f'.repeat(64) })]);
    const row = await new ReportMailStore().settle(tx, 'mail-1', { status: 'SENT', errorCode: null, providerMessageId: 'msg-1' } as never, { name: 'a.xlsx', sha256: 'f'.repeat(64) }, AT);
    expect(calls[0]?.params).toEqual(['mail-1', 'SENT', null, 'msg-1', 'a.xlsx', 'f'.repeat(64), '2026-11-09T03:00:00.000Z']);
    expect(calls[0]?.sql).toContain("status = 'SENDING'");
    expect(row).toMatchObject({ status: 'SENT', providerMessageId: 'msg-1', sentAt: '2026-11-09T03:00:01.000000Z', fileName: 'a.xlsx' });
  });

  it('keeps the file columns when the send never produced a file', async () => {
    const { tx, calls } = fakeTx(() => [mailingSql({ status: 'FAILED', error_code: 'SMTP_DOWN' })]);
    await new ReportMailStore().settle(tx, 'mail-1', { status: 'FAILED', errorCode: 'SMTP_DOWN', providerMessageId: null } as never, undefined, AT);
    expect(calls[0]?.params.slice(4, 6)).toEqual([null, null]);
  });

  it('is not found when the row is no longer SENDING (settled by someone else): a settled send is not settled twice', async () => {
    await expect(new ReportMailStore().settle(fakeTx(() => []).tx, 'mail-1', { status: 'SENT', errorCode: null, providerMessageId: 'x' } as never, undefined, AT)).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404, detail: 'mailing' });
  });
});

describe('ReportMailStore.settleLost, list and addressOf', () => {
  it('counts the lost sends and uses the limit of the rule', async () => {
    const { tx, calls } = fakeTx(() => [{ id: 'a' }, { id: 'b' }]);
    expect(await new ReportMailStore().settleLost(tx, AT)).toBe(2);
    expect(calls[0]?.params).toEqual(['2026-11-09T03:00:00.000Z', DELIVERY_LOST_AFTER_MINUTES]);
    expect(calls[0]?.sql).toContain("status = 'UNKNOWN'");
    expect(await new ReportMailStore().settleLost(fakeTx(() => []).tx, AT)).toBe(0);
  });

  it('lists the log with nulls for the filters not given', async () => {
    const { tx, calls } = fakeTx(() => [mailingSql()]);
    const store = new ReportMailStore();
    expect(await store.list(tx, {}, 20)).toHaveLength(1);
    await store.list(tx, { scheduleId: SCHEDULE_ID, issueId: ISSUE_ID, recipientId: MEMBER_A, status: 'FAILED' }, 5);
    expect(calls[0]?.params).toEqual([null, null, null, null, 20]);
    expect(calls[1]?.params).toEqual([SCHEDULE_ID, ISSUE_ID, MEMBER_A, 'FAILED', 5]);
  });

  it('allows the read of the address for this transaction only, and answers undefined for a member who is not active or has no address', async () => {
    const { tx, calls } = fakeTx((sql) => (sql.startsWith('select email') ? [{ value: 'a@example.test' }] : []));
    expect(await new ReportMailStore().addressOf(tx, MEMBER_A)).toBe('a@example.test');
    expect(calls[0]?.sql).toContain("set_config('app.can_read_pii', 'true', true)");
    expect(calls[1]?.sql).toContain("status = 'ACTIVE'");
    expect(await new ReportMailStore().addressOf(fakeTx(() => []).tx, MEMBER_A)).toBeUndefined();
    expect(await new ReportMailStore().addressOf(fakeTx((sql) => (sql.startsWith('select email') ? [{ value: null }] : [])).tx, MEMBER_A)).toBeUndefined();
  });
});
