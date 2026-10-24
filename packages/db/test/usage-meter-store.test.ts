import { Client } from 'pg';
import { MAX_CLOCK_SKEW_MS, UsageMeterStore } from '../src/usage-meter-store';
import type { RecordUsageInput } from '../src/usage-meter-store';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, memberId } from './support/authz-fixtures';

const store = new UsageMeterStore();
const CTX_A = contextFor(TENANT_A, memberId(1));
const CTX_B = contextFor(TENANT_B, memberId(1));
const NOW = new Date('2026-10-25T06:00:00Z');

let counter = 0;
const event = (overrides: Partial<RecordUsageInput> = {}): RecordUsageInput => {
  counter += 1;
  return { meter: 'notification.zns', externalEventKey: `da-${counter}`, quantity: '1', occurredAt: new Date('2026-10-20T01:00:00Z'), sourceReference: 'campaign:42', now: NOW, ...overrides };
};

describe('UsageMeterStore', () => {
  const harness = new AuthzHarness();
  const inA = <T>(work: Parameters<typeof harness.tenants.withTenant<T>>[1]): Promise<T> => harness.tenants.withTenant(CTX_A, work);
  const inB = <T>(work: Parameters<typeof harness.tenants.withTenant<T>>[1]): Promise<T> => harness.tenants.withTenant(CTX_B, work);

  const admin = async <T>(work: (client: Client) => Promise<T>): Promise<T> => {
    const client = new Client({ connectionString: harness.database.adminUrl });
    await client.connect();
    try {
      return await work(client);
    } finally {
      await client.end();
    }
  };
  const eventCount = (tenant: string, meter: string, key: string): Promise<number> =>
    admin(async (client) => Number((await client.query<{ n: string }>('select count(*) as n from machvon.usage_meter_event where tenant_id = $1 and meter = $2 and external_event_key = $3', [tenant, meter, key])).rows[0]?.n));
  const sqlState = async (client: Client, text: string, params: unknown[] = []): Promise<string | undefined> => {
    try {
      await client.query(text, params);
      return undefined;
    } catch (error) {
      return (error as { code?: string }).code;
    }
  };

  beforeAll(() => harness.start(), 180_000);
  afterAll(() => harness.stop(), 60_000);

  describe('record', () => {
    it('adds the first event of a key to the counter of its month and says what the counter holds (AC-ST-SAS-010-1)', async () => {
      const recorded = await inA((tx) => store.record(tx, event({ meter: 'notification.zns', externalEventKey: 'first', quantity: '100' })));
      expect(recorded).toMatchObject({ replayed: false, counter: 'notification.messages', used: '100', windowStart: new Date('2026-10-01T00:00:00Z'), windowEnd: new Date('2026-11-01T00:00:00Z') });
      const row = await inA((tx) => store.readEvent(tx, recorded.eventId));
      expect(row).toEqual({
        id: recorded.eventId,
        meter: 'notification.zns',
        externalEventKey: 'first',
        quantity: '100',
        unit: 'message',
        occurredAt: new Date('2026-10-20T01:00:00Z'),
        sourceReference: 'campaign:42',
        recordedAt: expect.any(Date),
      });
    });

    it('answers the first event and leaves the counter alone when the same key is sent again: 101, not 102, and one row (UAT-AC168)', async () => {
      await inA((tx) => store.record(tx, event({ externalEventKey: 'seed-100', quantity: '99', occurredAt: new Date('2026-09-10T00:00:00Z') })));
      const before = await inA((tx) => store.record(tx, event({ externalEventKey: 'seed-1', quantity: '1', occurredAt: new Date('2026-09-11T00:00:00Z') })));
      expect(before.used).toBe('100');
      const first = await inA((tx) => store.record(tx, event({ externalEventKey: 'da-1001', quantity: '1', occurredAt: new Date('2026-09-12T00:00:00Z') })));
      const again = await inA((tx) => store.record(tx, event({ externalEventKey: 'da-1001', quantity: '1', occurredAt: new Date('2026-09-12T00:00:00Z') })));
      expect([first.replayed, first.used]).toEqual([false, '101']);
      expect([again.replayed, again.used, again.eventId]).toEqual([true, '101', first.eventId]);
      expect(await eventCount(TENANT_A, 'notification.zns', 'da-1001')).toBe(1);
      const [september] = await inA((tx) => store.countersAt(tx, new Date('2026-09-15T00:00:00Z')));
      expect(september).toMatchObject({ counter: 'notification.messages', used: '101' });
    });

    it('keeps one event for a key sent by many at once, and feeds the counter once', async () => {
      const at = new Date('2026-08-05T00:00:00Z');
      const recorded = await Promise.all(Array.from({ length: 8 }, () => inA((tx) => store.record(tx, event({ meter: 'ai.tokens', externalEventKey: 'racing', quantity: '250', occurredAt: at })))));
      expect(new Set(recorded.map((entry) => entry.eventId)).size).toBe(1);
      expect(recorded.filter((entry) => !entry.replayed)).toHaveLength(1);
      expect(await eventCount(TENANT_A, 'ai.tokens', 'racing')).toBe(1);
      const [august] = (await inA((tx) => store.countersAt(tx, at))).filter((row) => row.counter === 'ai.tokens');
      expect(august?.used).toBe('250');
    });

    it('adds up events of different keys that arrive at the same time without losing one', async () => {
      const at = new Date('2026-07-05T00:00:00Z');
      await Promise.all(Array.from({ length: 12 }, (_value, n) => inA((tx) => store.record(tx, event({ meter: 'bi.query', externalEventKey: `parallel-${n}`, quantity: '2.5', occurredAt: at })))));
      const [july] = (await inA((tx) => store.countersAt(tx, at))).filter((row) => row.counter === 'bi.queries');
      expect(july?.used).toBe('30');
    });

    it('treats a key as the key of its meter: the same key on another meter is another event', async () => {
      const zns = await inA((tx) => store.record(tx, event({ meter: 'notification.zns', externalEventKey: 'shared-key' })));
      const sms = await inA((tx) => store.record(tx, event({ meter: 'notification.sms', externalEventKey: 'shared-key' })));
      expect(zns.eventId).not.toBe(sms.eventId);
      expect([zns.replayed, sms.replayed]).toEqual([false, false]);
      expect(sms.counter).toBe(zns.counter);
    });

    it('keeps the events of a tenant apart from those of another, also for the same key', async () => {
      const at = new Date('2026-06-05T00:00:00Z');
      const a = await inA((tx) => store.record(tx, event({ externalEventKey: 'tenant-key', quantity: '4', occurredAt: at })));
      const b = await inB((tx) => store.record(tx, event({ externalEventKey: 'tenant-key', quantity: '7', occurredAt: at })));
      expect([a.replayed, b.replayed, a.used, b.used]).toEqual([false, false, '4', '7']);
      expect(await inB((tx) => store.readEvent(tx, a.eventId))).toBeUndefined();
      expect((await inB((tx) => store.listEvents(tx, { limit: 100 }))).every((row) => row.id !== a.eventId)).toBe(true);
    });

    it('puts an event in the month it happened in, not the month it was recorded in', async () => {
      const march = await inA((tx) => store.record(tx, event({ meter: 'storage.gb_day', externalEventKey: 'march', quantity: '3', occurredAt: new Date('2026-03-31T23:59:59Z') })));
      const april = await inA((tx) => store.record(tx, event({ meter: 'storage.gb_day', externalEventKey: 'april', quantity: '5', occurredAt: new Date('2026-04-01T00:00:00Z') })));
      expect([march.windowStart, april.windowStart]).toEqual([new Date('2026-03-01T00:00:00Z'), new Date('2026-04-01T00:00:00Z')]);
      expect([march.used, april.used]).toEqual(['3', '5']);
    });

    it('keeps six decimals and rounds nothing', async () => {
      const at = new Date('2026-05-05T00:00:00Z');
      await inA((tx) => store.record(tx, event({ meter: 'storage.gb_day', externalEventKey: 'dec-1', quantity: '0.000001', occurredAt: at })));
      const second = await inA((tx) => store.record(tx, event({ meter: 'storage.gb_day', externalEventKey: 'dec-2', quantity: '1.250000', occurredAt: at })));
      expect(second.used).toBe('1.250001');
    });

    it('accepts an event a little ahead of the clock and refuses one that has not happened', async () => {
      const edge = new Date(NOW.getTime() + MAX_CLOCK_SKEW_MS);
      await expect(inA((tx) => store.record(tx, event({ occurredAt: edge })))).resolves.toMatchObject({ replayed: false });
      await expect(inA((tx) => store.record(tx, event({ occurredAt: new Date(edge.getTime() + 1) })))).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'occurred_at' });
    });

    it('refuses a meter nobody knows with 422 METER_UNKNOWN, and writes nothing', async () => {
      await expect(inA((tx) => store.record(tx, event({ meter: 'notification.pigeon', externalEventKey: 'unknown' })))).rejects.toMatchObject({ code: 'METER_UNKNOWN', status: 422, detail: 'meter' });
      expect(await eventCount(TENANT_A, 'notification.pigeon', 'unknown')).toBe(0);
    });

    it.each([
      ['an empty key', { externalEventKey: '   ' }, 'external_event_key'],
      ['a key that is too long', { externalEventKey: 'k'.repeat(201) }, 'external_event_key'],
      ['an empty source', { sourceReference: '' }, 'source_reference'],
      ['a source that is too long', { sourceReference: 's'.repeat(501) }, 'source_reference'],
      ['a quantity of zero', { quantity: '0' }, 'quantity'],
      ['a quantity of zeros', { quantity: '0.000000' }, 'quantity'],
      ['a negative quantity', { quantity: '-1' }, 'quantity'],
      ['a quantity with seven decimals', { quantity: '1.1234567' }, 'quantity'],
      ['a quantity in an exponent', { quantity: '1e3' }, 'quantity'],
      ['a quantity of nineteen digits', { quantity: '1'.repeat(19) }, 'quantity'],
      ['a unit that is not the unit of the meter', { unit: 'token' }, 'unit'],
    ] as const)('refuses %s', async (_name, overrides, field) => {
      await expect(inA((tx) => store.record(tx, event(overrides)))).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: field });
    });

    it('takes the unit of the meter when none is given, and accepts the unit it has', async () => {
      const recorded = await inA((tx) => store.record(tx, event({ meter: 'ai.tokens', unit: 'token' })));
      expect((await inA((tx) => store.readEvent(tx, recorded.eventId)))?.unit).toBe('token');
    });

    it('rolls the event back with the transaction that wrote it, and the counter with it', async () => {
      const at = new Date('2026-02-05T00:00:00Z');
      await expect(
        inA(async (tx) => {
          await store.record(tx, event({ meter: 'bi.query', externalEventKey: 'rolled-back', quantity: '9', occurredAt: at }));
          throw new Error('abort');
        }),
      ).rejects.toThrow('abort');
      expect(await eventCount(TENANT_A, 'bi.query', 'rolled-back')).toBe(0);
      expect((await inA((tx) => store.countersAt(tx, at))).filter((row) => row.counter === 'bi.queries')).toEqual([]);
    });
  });

  describe('corrections', () => {
    const at = new Date('2026-01-10T00:00:00Z');

    it('takes away from the counter of the meter it corrects and is kept as an event of its own', async () => {
      await inA((tx) => store.record(tx, event({ meter: 'notification.sms', externalEventKey: 'sent', quantity: '10', occurredAt: at })));
      const corrected = await inA((tx) => store.record(tx, event({ meter: 'notification.sms_correction', externalEventKey: 'sent-fix', quantity: '3', occurredAt: at })));
      expect([corrected.used, corrected.counter]).toEqual(['7', 'notification.messages']);
      expect(await eventCount(TENANT_A, 'notification.sms_correction', 'sent-fix')).toBe(1);
      expect(await eventCount(TENANT_A, 'notification.sms', 'sent')).toBe(1);
    });

    it('is applied once, however often it is sent', async () => {
      const first = await inA((tx) => store.record(tx, event({ meter: 'notification.email_correction', externalEventKey: 'fix-once', quantity: '1', occurredAt: at })));
      const again = await inA((tx) => store.record(tx, event({ meter: 'notification.email_correction', externalEventKey: 'fix-once', quantity: '1', occurredAt: at })));
      expect([again.replayed, again.used]).toEqual([true, first.used]);
    });

    it('refuses to take away more than the counter holds, and keeps neither the event nor a change', async () => {
      const other = new Date('2026-01-20T00:00:00Z');
      await inA((tx) => store.record(tx, event({ meter: 'bi.query', externalEventKey: 'small', quantity: '2', occurredAt: other })));
      await expect(inA((tx) => store.record(tx, event({ meter: 'bi.query_correction', externalEventKey: 'too-much', quantity: '2.000001', occurredAt: other })))).rejects.toMatchObject({ code: 'VALIDATION_FAILED', detail: 'quantity' });
      expect(await eventCount(TENANT_A, 'bi.query_correction', 'too-much')).toBe(0);
      const [counter] = (await inA((tx) => store.countersAt(tx, other))).filter((row) => row.counter === 'bi.queries');
      expect(counter?.used).toBe('2');
    });

    it('can take the counter to exactly zero', async () => {
      const month = new Date('2025-12-10T00:00:00Z');
      await inA((tx) => store.record(tx, event({ meter: 'storage.gb_day', externalEventKey: 'zero-in', quantity: '4', occurredAt: month })));
      const out = await inA((tx) => store.record(tx, event({ meter: 'storage.gb_day_correction', externalEventKey: 'zero-out', quantity: '4', occurredAt: month })));
      expect(out.used).toBe('0');
    });

    it('refuses a correction of a month in which nothing was counted', async () => {
      await expect(inA((tx) => store.record(tx, event({ meter: 'ai.tokens_correction', externalEventKey: 'nothing', quantity: '1', occurredAt: new Date('2020-01-01T00:00:00Z') })))).rejects.toMatchObject({ code: 'VALIDATION_FAILED', detail: 'quantity' });
    });
  });

  describe('listEvents and readEvent', () => {
    const base = new Date('2025-05-01T00:00:00Z');

    beforeAll(async () => {
      for (let n = 0; n < 5; n += 1) {
        await inA((tx) => store.record(tx, event({ meter: n % 2 === 0 ? 'bi.query' : 'ai.tokens', externalEventKey: `list-${n}`, occurredAt: new Date(base.getTime() + n * 86_400_000) })));
      }
    });

    it('lists the latest event first, by meter and by period', async () => {
      const all = await inA((tx) => store.listEvents(tx, { from: base, until: new Date(base.getTime() + 5 * 86_400_000), limit: 50 }));
      expect(all.map((row) => row.externalEventKey)).toEqual(['list-4', 'list-3', 'list-2', 'list-1', 'list-0']);
      const bi = await inA((tx) => store.listEvents(tx, { meter: 'bi.query', from: base, until: new Date(base.getTime() + 5 * 86_400_000), limit: 50 }));
      expect(bi.map((row) => row.externalEventKey)).toEqual(['list-4', 'list-2', 'list-0']);
      const narrow = await inA((tx) => store.listEvents(tx, { from: new Date(base.getTime() + 2 * 86_400_000), until: new Date(base.getTime() + 4 * 86_400_000), limit: 50 }));
      expect(narrow.map((row) => row.externalEventKey)).toEqual(['list-3', 'list-2']);
    });

    it('pages with a keyset that neither repeats nor skips an event', async () => {
      const seen: string[] = [];
      let after: { occurredAt: Date; id: string } | undefined;
      for (;;) {
        const page = await inA((tx) => store.listEvents(tx, { from: base, until: new Date(base.getTime() + 5 * 86_400_000), limit: 2, after }));
        seen.push(...page.map((row) => row.externalEventKey));
        const last = page[page.length - 1];
        if (page.length < 2 || last === undefined) break;
        after = { occurredAt: last.occurredAt, id: last.id };
      }
      expect(seen).toEqual(['list-4', 'list-3', 'list-2', 'list-1', 'list-0']);
    });

    it('breaks a tie of time by id, so two events of one instant are both on some page', async () => {
      const instant = new Date('2025-04-01T00:00:00Z');
      const ids = await Promise.all(['tie-a', 'tie-b', 'tie-c'].map((key) => inA((tx) => store.record(tx, event({ externalEventKey: key, occurredAt: instant })))));
      const first = await inA((tx) => store.listEvents(tx, { from: instant, until: new Date(instant.getTime() + 1), limit: 2 }));
      const second = await inA((tx) => store.listEvents(tx, { from: instant, until: new Date(instant.getTime() + 1), limit: 2, after: { occurredAt: instant, id: first[1]?.id ?? '' } }));
      expect([...first, ...second].map((row) => row.id).sort()).toEqual(ids.map((entry) => entry.eventId).sort());
    });

    it('does not read an event of another tenant', async () => {
      const mine = await inA((tx) => store.record(tx, event()));
      expect(await inA((tx) => store.readEvent(tx, mine.eventId))).toMatchObject({ id: mine.eventId });
      expect(await inB((tx) => store.readEvent(tx, mine.eventId))).toBeUndefined();
    });
  });

  describe('countersAt', () => {
    it('returns the counters whose window holds the instant, by counter', async () => {
      const at = new Date('2024-11-15T00:00:00Z');
      await inA((tx) => store.record(tx, event({ meter: 'bi.query', externalEventKey: 'c-1', quantity: '2', occurredAt: at })));
      await inA((tx) => store.record(tx, event({ meter: 'ai.tokens', externalEventKey: 'c-2', quantity: '500', occurredAt: at })));
      expect((await inA((tx) => store.countersAt(tx, at))).map((row) => [row.counter, row.used])).toEqual([
        ['ai.tokens', '500'],
        ['bi.queries', '2'],
      ]);
      expect(await inA((tx) => store.countersAt(tx, new Date('2024-12-01T00:00:00Z')))).toEqual([]);
      expect(await inB((tx) => store.countersAt(tx, at))).toEqual([]);
    });
  });

  describe('what the database guards (V1481)', () => {
    it('refuses to change or delete an event, also for the owner, and the runtime role cannot try', async () => {
      const recorded = await inA((tx) => store.record(tx, event({ externalEventKey: 'guarded' })));
      await admin(async (client) => {
        expect(await sqlState(client, 'update machvon.usage_meter_event set quantity = 99 where id = $1', [recorded.eventId])).toBe('23514');
        expect(await sqlState(client, 'delete from machvon.usage_meter_event where id = $1', [recorded.eventId])).toBe('23514');
      });
      const app = new Client({ connectionString: harness.database.urlFor('machvon_app') });
      await app.connect();
      try {
        expect(await sqlState(app, 'update machvon.usage_meter_event set quantity = 99')).toBe('42501');
        expect(await sqlState(app, 'delete from machvon.usage_meter_event')).toBe('42501');
        expect(await sqlState(app, 'truncate machvon.usage_meter_event')).toBe('42501');
      } finally {
        await app.end();
      }
      expect((await inA((tx) => store.readEvent(tx, recorded.eventId)))?.quantity).toBe('1');
    });

    it('keeps the counter from going below zero whatever the application did', async () => {
      await admin(async (client) => {
        await client.query("select set_config('app.tenant_id', $1, false)", [TENANT_A]);
        expect(await sqlState(client, "update machvon.usage_counter set used_value = -1 where feature_code = 'notification.messages'")).toBe('23514');
      });
    });
  });
});
