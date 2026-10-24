import { describe, expect, it } from 'vitest';
import { levelOf, shareOf, toUsage } from './model';

describe('toUsage', () => {
  const raw = {
    as_of: '2026-10-25T06:00:00Z',
    window_start: '2026-10-01T00:00:00Z',
    window_end: '2026-11-01T00:00:00Z',
    meters: [
      { counter: 'notification.messages', unit: 'message', used: '101', limit: '1000' },
      { counter: 'ai.tokens', unit: 'token', used: '0' },
      { unit: 'query', used: '5' },
    ],
    seats: { used: 3, limit: 40 },
    guest_seats: { used: 0 },
    recent_events: [{ id: 'e1', meter: 'notification.zns', external_event_key: 'da-1', quantity: '1', unit: 'message', occurred_at: '2026-10-20T01:00:00Z', source_reference: 'campaign:42' }, { meter: 'no id' }],
  };

  it('reads the counters with their limits, the seats and the events, and drops what has no name or id', () => {
    expect(toUsage(raw)).toEqual({
      asOf: '2026-10-25T06:00:00Z',
      windowStart: '2026-10-01T00:00:00Z',
      windowEnd: '2026-11-01T00:00:00Z',
      meters: [
        { counter: 'notification.messages', unit: 'message', used: '101', limit: '1000' },
        { counter: 'ai.tokens', unit: 'token', used: '0', limit: undefined },
      ],
      seats: { used: 3, limit: 40 },
      guestSeats: { used: 0, limit: undefined },
      recentEvents: [{ id: 'e1', meter: 'notification.zns', externalEventKey: 'da-1', quantity: '1', unit: 'message', occurredAt: '2026-10-20T01:00:00Z', sourceReference: 'campaign:42' }],
    });
  });

  it('has no events at all for a tenant-plane answer, and an empty list for a tenant that has none', () => {
    expect(toUsage({ ...raw, recent_events: undefined }).recentEvents).toBeUndefined();
    expect(toUsage({ ...raw, recent_events: [] }).recentEvents).toEqual([]);
  });

  it('treats a malformed answer as nothing counted', () => {
    expect(toUsage(null)).toEqual({ asOf: '', windowStart: '', windowEnd: '', meters: [], seats: { used: 0, limit: undefined }, guestSeats: { used: 0, limit: undefined }, recentEvents: undefined });
    expect(toUsage({ meters: 'x', seats: { used: -1, limit: 'many' }, guest_seats: 7 }).seats).toEqual({ used: 0, limit: undefined });
    expect(toUsage({ meters: [{ counter: 'a', used: '' }] }).meters).toEqual([{ counter: 'a', unit: '', used: '0', limit: undefined }]);
  });
});

describe('shareOf', () => {
  it('is the whole percentage of the limit that is used, rounded down', () => {
    expect(shareOf('101', '1000')).toBe(10);
    expect(shareOf('999', '1000')).toBe(99);
    expect(shareOf(3, 40)).toBe(7);
    expect(shareOf('1500', '1000')).toBe(150);
    expect(shareOf('0', '10')).toBe(0);
  });

  it('is nothing to measure without a limit or with a limit of zero or one that is not a number', () => {
    expect(shareOf('5', undefined)).toBeUndefined();
    expect(shareOf('5', '0')).toBeUndefined();
    expect(shareOf('5', 'x')).toBeUndefined();
    expect(shareOf('x', '5')).toBeUndefined();
  });
});

describe('levelOf', () => {
  it.each([
    ['0', '100', 'ok'],
    ['89', '100', 'ok'],
    ['90', '100', 'near'],
    ['99.999', '100', 'near'],
    ['100', '100', 'full'],
    ['100.5', '100', 'over'],
    ['120', '100', 'over'],
    ['0', '0', 'full'],
    ['1', '0', 'over'],
    ['5', undefined, 'none'],
    ['x', '5', 'none'],
    ['5', 'x', 'none'],
  ] as const)('puts %s of %s at %s', (used, limit, level) => {
    expect(levelOf(used, limit)).toBe(level);
  });

  it('judges seats as numbers too', () => {
    expect(levelOf(120, 100)).toBe('over');
    expect(levelOf(3, 40)).toBe('ok');
  });
});
