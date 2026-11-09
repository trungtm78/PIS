import { createHash } from 'node:crypto';
import type { ChannelSendResult, EffectiveAccess, TenantContext } from '@machvon/kernel';
import { ReportMailRunner } from './delivery-runner.ts';
import type { MailRunnerDeps } from './delivery-runner.ts';
import type { MailScheduleRow, MailingRow } from './delivery-store.ts';

const TENANT = { tenantId: '00000000-0000-4000-8000-00000000000a', membershipId: '00000000-0000-4000-8000-0000000000ff', scopeVersion: 0 } as unknown as TenantContext;
const R1 = '11111111-1111-4111-8111-111111111111';
const R2 = '22222222-2222-4222-8222-222222222222';
const BYTES = new Uint8Array([1, 2, 3, 4]);
const SHA = createHash('sha256').update(BYTES).digest('hex');
const NOW = new Date('2026-11-06T01:00:30Z');

const schedule = (over: Partial<MailScheduleRow> = {}): MailScheduleRow => ({
  id: 'sch-1',
  layoutCode: 'PVN-MONTHLY',
  cron: '0 8 6 * *',
  timezone: 'Asia/Ho_Chi_Minh',
  format: 'XLSX',
  recipients: [R1],
  note: null,
  status: 'ACTIVE',
  lastRunAt: null,
  retiredAt: null,
  retiredBy: null,
  retireReason: null,
  createdBy: 'maker',
  createdAt: '2026-11-01T00:00:00.000Z',
  version: 1,
  ...over,
});
const copy = (over: Record<string, unknown> = {}) => ({
  id: 'issue-1',
  layoutCode: 'PVN-MONTHLY',
  layoutVersion: '1',
  periodCode: '2026-10',
  revision: 1,
  countsAsAccepted: true,
  issuedAt: '2026-11-03T03:00:00.000Z',
  xlsxSha256: SHA,
  xlsxName: 'PVN-MONTHLY_2026-10_v1.xlsx',
  docxSha256: null,
  docxName: null,
  ...over,
});

/** An in-memory log with the rules of the table: a unique key, SENDING moved to its settled state. */
function fakes(options: { schedules?: MailScheduleRow[]; copies?: Array<ReturnType<typeof copy>>; address?: string | undefined; active?: boolean; bytes?: Uint8Array | undefined; send?: (n: number) => ChannelSendResult } = {}) {
  const log = new Map<string, MailingRow>();
  const marked: string[] = [];
  const calls: Array<{ to: string; subject: string; text: string; sha: string; key: string; name: string }> = [];
  let sequence = 0;
  const schedules = options.schedules ?? [schedule()];
  const copies = options.copies ?? [copy()];
  const store: NonNullable<MailRunnerDeps['store']> = {
    settleLost: async () => 0,
    activeForRun: async () => schedules,
    markRun: async (_tx, id) => void marked.push(id),
    held: async (_tx, scheduleId, ids) => new Map([...log.values()].filter((row) => row.scheduleId === scheduleId && ids.includes(row.issueId)).map((row) => [`${row.issueId}|${row.recipientId}`, row])),
    begin: async (_tx, input) => {
      const key = `${input.scheduleId}|${input.issueId}|${input.recipientId}`;
      const held = log.get(key);
      if (held !== undefined && held.status !== 'FAILED') return undefined;
      const row: MailingRow = { id: held?.id ?? `m-${(sequence += 1)}`, scheduleId: input.scheduleId, issueId: input.issueId, recipientId: input.recipientId, fileFormat: input.format, fileName: null, fileSha256: null, status: 'SENDING', attempts: (held?.attempts ?? 0) + 1, errorCode: null, providerMessageId: null, firstAttemptAt: null, lastAttemptAt: null, sentAt: null, createdAt: '' };
      log.set(key, row);
      return row;
    },
    skip: async (_tx, input) => {
      const key = `${input.scheduleId}|${input.issueId}|${input.recipientId}`;
      if (!log.has(key)) log.set(key, { id: `m-${(sequence += 1)}`, scheduleId: input.scheduleId, issueId: input.issueId, recipientId: input.recipientId, fileFormat: input.format, fileName: null, fileSha256: null, status: 'SKIPPED', attempts: 0, errorCode: input.reason, providerMessageId: null, firstAttemptAt: null, lastAttemptAt: null, sentAt: null, createdAt: '' });
    },
    settle: async (_tx, id, outcome, file) => {
      const entry = [...log.entries()].find(([, row]) => row.id === id) as [string, MailingRow];
      const row = { ...entry[1], status: outcome.status, errorCode: outcome.errorCode, providerMessageId: outcome.providerMessageId, fileName: file?.name ?? null, fileSha256: file?.sha256 ?? null };
      log.set(entry[0], row);
      return row;
    },
    addressOf: async () => ('address' in options ? options.address : 'leader@example.test'),
  };
  const reports: NonNullable<MailRunnerDeps['reports']> = {
    listIssues: async () => copies as never,
    outputBytes: async () => ('bytes' in options ? (options.bytes === undefined ? undefined : { bytes: options.bytes, format: 'XLSX' }) : { bytes: BYTES, format: 'XLSX' }),
    findLayout: async () => ({ name: 'Báo cáo tháng gửi PVN' }) as never,
  };
  const mailer = {
    ready: async () => ({ ok: true as const }),
    send: async (_ctx: TenantContext, request: { to: string; subject: string; text: string; idempotencyKey: string; attachments: Array<{ sha256: string; fileName: string }> }) => {
      calls.push({ to: request.to, subject: request.subject, text: request.text, sha: request.attachments[0]?.sha256 ?? '', key: request.idempotencyKey, name: request.attachments[0]?.fileName ?? '' });
      return options.send?.(calls.length) ?? ({ kind: 'ACCEPTED', providerMessageId: `p-${calls.length}` } as ChannelSendResult);
    },
  };
  const database = { withTenant: async <T>(_ctx: TenantContext, work: (tx: never) => Promise<T>): Promise<T> => work(undefined as never) };
  const access = { membershipActive: options.active ?? true } as EffectiveAccess;
  const runner = new ReportMailRunner({ database: database as never, mailer, mayRead: () => true, store, reports, accessOf: async () => access, clock: () => NOW });
  return { runner, log, marked, calls, mailer, database };
}

describe('ReportMailRunner', () => {
  it('mails the issued copy to the recipient with the file attached, its SHA-256 in the message, and logs it as SENT', async () => {
    const world = fakes();
    const runs = await world.runner.run(TENANT, NOW);
    expect(runs).toEqual([{ scheduleId: 'sch-1', sent: 1, failed: 0, skipped: 0 }]);
    expect(world.calls).toHaveLength(1);
    expect(world.calls[0]).toMatchObject({ to: 'leader@example.test', sha: SHA, name: 'PVN-MONTHLY_2026-10_v1.xlsx' });
    expect(world.calls[0]?.text).toContain(SHA);
    expect(world.calls[0]?.subject).toContain('Báo cáo tháng gửi PVN');
    const row = [...world.log.values()][0] as MailingRow;
    expect(row).toMatchObject({ status: 'SENT', fileSha256: SHA, providerMessageId: 'p-1', attempts: 1 });
    expect(world.marked).toEqual(['sch-1']);
  });

  it('sends nothing twice: a run again over the same copy sends no second message', async () => {
    const world = fakes();
    await world.runner.run(TENANT, NOW);
    await world.runner.run(TENANT, NOW);
    expect(world.calls).toHaveLength(1);
  });

  it('does nothing before the schedule is due', async () => {
    const world = fakes();
    expect(await world.runner.run(TENANT, new Date('2026-11-05T10:00:00Z'))).toEqual([]);
    expect(world.calls).toHaveLength(0);
    expect(world.marked).toEqual([]);
  });

  it('writes nothing and marks nothing when there is no channel to send on, so the copies wait for it', async () => {
    const world = fakes();
    world.mailer.ready = async () => ({ ok: false as never, reason: 'NO_ACCOUNT' }) as never;
    expect(await world.runner.run(TENANT, NOW)).toEqual([]);
    expect(world.log.size).toBe(0);
    expect(world.marked).toEqual([]);
  });

  it('logs a copy of a DEMO form as skipped with its reason and sends nothing (R18)', async () => {
    const world = fakes({ copies: [copy({ countsAsAccepted: false })] });
    const runs = await world.runner.run(TENANT, NOW);
    expect(runs[0]).toMatchObject({ sent: 0, skipped: 1 });
    expect(world.calls).toHaveLength(0);
    expect([...world.log.values()][0]).toMatchObject({ status: 'SKIPPED', errorCode: 'DEMO_FORM' });
  });

  it('does not mail the history: a copy issued before the schedule was made is left alone', async () => {
    const world = fakes({ copies: [copy({ issuedAt: '2026-10-20T03:00:00.000Z' })] });
    await world.runner.run(TENANT, NOW);
    expect(world.calls).toHaveLength(0);
    expect(world.log.size).toBe(0);
  });

  it('refuses a recipient who is no longer allowed, who has no address, or whose file is missing, each with its own code and without a call', async () => {
    const inactive = fakes({ active: false });
    await inactive.runner.run(TENANT, NOW);
    expect([...inactive.log.values()][0]).toMatchObject({ status: 'REFUSED', errorCode: 'RECIPIENT_NOT_ALLOWED' });
    const nobody = fakes({ address: undefined });
    await nobody.runner.run(TENANT, NOW);
    expect([...nobody.log.values()][0]).toMatchObject({ status: 'REFUSED', errorCode: 'NO_ADDRESS' });
    const gone = fakes({ bytes: undefined });
    await gone.runner.run(TENANT, NOW);
    expect([...gone.log.values()][0]).toMatchObject({ status: 'REFUSED', errorCode: 'FILE_MISSING' });
    const altered = fakes({ bytes: new Uint8Array([9, 9]) });
    await altered.runner.run(TENANT, NOW);
    expect([...altered.log.values()][0]).toMatchObject({ status: 'REFUSED', errorCode: 'FILE_INTEGRITY' });
    for (const world of [inactive, nobody, gone, altered]) expect(world.calls).toHaveLength(0);
  });

  it('a failure that may pass is tried again at the next run, up to the attempts, with the same row', async () => {
    const world = fakes({ send: (n) => (n < 3 ? { kind: 'FAILED', failureClass: 'RETRYABLE', errorCode: 'SMTP_4XX' } : { kind: 'ACCEPTED', providerMessageId: 'ok' }) });
    await world.runner.run(TENANT, NOW);
    expect([...world.log.values()][0]).toMatchObject({ status: 'FAILED', attempts: 1 });
    await world.runner.run(TENANT, NOW);
    expect([...world.log.values()][0]).toMatchObject({ status: 'FAILED', attempts: 2 });
    await world.runner.run(TENANT, NOW);
    expect([...world.log.values()][0]).toMatchObject({ status: 'SENT', attempts: 3 });
    expect(world.log.size).toBe(1);
  });

  it('a failure for good is refused and not tried again; a lost answer is unknown and never sent again on its own', async () => {
    const refused = fakes({ send: () => ({ kind: 'FAILED', failureClass: 'PERMANENT', errorCode: 'SMTP_5XX' }) });
    await refused.runner.run(TENANT, NOW);
    await refused.runner.run(TENANT, NOW);
    expect(refused.calls).toHaveLength(1);
    expect([...refused.log.values()][0]).toMatchObject({ status: 'REFUSED', errorCode: 'SMTP_5XX' });
    const unknown = fakes({ send: () => ({ kind: 'UNKNOWN', errorCode: 'ADAPTER_TIMEOUT' }) });
    await unknown.runner.run(TENANT, NOW);
    await unknown.runner.run(TENANT, NOW);
    expect(unknown.calls).toHaveLength(1);
    expect([...unknown.log.values()][0]).toMatchObject({ status: 'UNKNOWN' });
  });

  it('an adapter that throws is an unknown result, and the others of the run are still sent', async () => {
    let n = 0;
    const world = fakes({ schedules: [schedule({ recipients: [R1, R2] })] });
    world.mailer.send = async (_ctx, request) => {
      n += 1;
      world.calls.push({ to: request.to, subject: '', text: '', sha: '', key: request.idempotencyKey, name: '' });
      if (n === 1) throw new Error('boom');
      return { kind: 'ACCEPTED', providerMessageId: 'ok' };
    };
    await world.runner.run(TENANT, NOW);
    const statuses = [...world.log.values()].map((row) => row.status).sort();
    expect(statuses).toEqual(['SENT', 'UNKNOWN']);
  });

  it('takes a batch of copies and leaves the schedule unmarked while some are left over', async () => {
    const many = Array.from({ length: 7 }, (_, index) => copy({ id: `issue-${index}`, issuedAt: `2026-11-0${index + 1}T03:00:00.000Z` }));
    const world = fakes({ copies: many });
    await world.runner.run(TENANT, NOW);
    expect(world.calls).toHaveLength(5);
    expect(world.marked).toEqual([]);
    await world.runner.run(TENANT, NOW);
    expect(world.calls).toHaveLength(7);
    expect(world.marked).toEqual(['sch-1']);
  });

  it('gives the channel a key that names the mailing and its attempt', async () => {
    const world = fakes({ send: (n) => (n === 1 ? { kind: 'FAILED', failureClass: 'RETRYABLE', errorCode: 'X' } : { kind: 'ACCEPTED', providerMessageId: 'ok' }) });
    await world.runner.run(TENANT, NOW);
    await world.runner.run(TENANT, NOW);
    expect(world.calls.map((call) => call.key)).toEqual(['m-1:EMAIL:1', 'm-1:EMAIL:2']);
  });
});
