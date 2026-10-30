import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import { createTranslator } from '../../../i18n';
import en from '../../../i18n/en.json';
import vi from '../../../i18n/vi.json';
import { inboxStatusLabel, inboxStatusPill, problemMessage } from './labels';
import { INBOX_STATUSES, describeProblem, mayReplay, toInboxEvent } from './model';
import type { InboxEventView } from './model';

const ROW = {
  id: 'e1',
  provider: 'TREASURY',
  event_key: 'evt-0001',
  provider_event_type: 'payment.confirmed',
  channel_account_id: 'account-1',
  status: 'FAILED',
  attempts: 3,
  next_attempt_at: '2026-10-24T10:30:00.000Z',
  error_code: 'PROVIDER_DOWN',
  received_at: '2026-10-24T09:00:00.000Z',
  processed_at: null,
  payload_kept: true,
  replay_count: 1,
  version: 5,
};

describe('toInboxEvent', () => {
  it('reads an event of the monitor', () => {
    expect(toInboxEvent(ROW)).toEqual({
      id: 'e1',
      provider: 'TREASURY',
      eventKey: 'evt-0001',
      eventType: 'payment.confirmed',
      channelAccountId: 'account-1',
      status: 'FAILED',
      attempts: 3,
      nextAttemptAt: '2026-10-24T10:30:00.000Z',
      errorCode: 'PROVIDER_DOWN',
      receivedAt: '2026-10-24T09:00:00.000Z',
      processedAt: null,
      payloadKept: true,
      replayCount: 1,
      version: 5,
    });
    expect(toInboxEvent({ ...ROW, provider_event_type: undefined, replay_count: undefined, payload_kept: false })).toMatchObject({ eventType: null, replayCount: 0, payloadKept: false });
    // An event of a provider that is not a channel names no channel account.
    expect(toInboxEvent({ ...ROW, channel_account_id: null })).toMatchObject({ channelAccountId: null });
  });

  it('never carries a payload or a reference to one, whatever the answer holds (AC-ST-ADM-018-4)', () => {
    const view = toInboxEvent({ ...ROW, payload: { iban: 'SECRET-PAYLOAD' }, payload_reference: 'tenants/x/webhook/SECRET-REFERENCE', raw_body: 'SECRET-BODY' }) as InboxEventView;
    expect(JSON.stringify(view)).not.toMatch(/SECRET/);
    expect(Object.keys(view).sort()).toEqual(['attempts', 'channelAccountId', 'errorCode', 'eventKey', 'eventType', 'id', 'nextAttemptAt', 'payloadKept', 'processedAt', 'provider', 'receivedAt', 'replayCount', 'status', 'version']);
  });

  it.each([
    ['not an object', 'x'],
    ['an array', []],
    ['no id', { ...ROW, id: undefined }],
    ['no provider', { ...ROW, provider: '' }],
    ['no key', { ...ROW, event_key: undefined }],
    ['no time of reception', { ...ROW, received_at: undefined }],
    ['an unknown status', { ...ROW, status: 'LOST' }],
    ['no status', { ...ROW, status: undefined }],
    ['attempts that are not a whole number', { ...ROW, attempts: 1.5 }],
    ['negative attempts', { ...ROW, attempts: -1 }],
    ['a version that is not a number', { ...ROW, version: '5' }],
  ])('drops an event with %s', (_name, raw) => {
    expect(toInboxEvent(raw)).toBeUndefined();
  });
});

describe('mayReplay', () => {
  const event = (status: string, payloadKept = true) => toInboxEvent({ ...ROW, status, payload_kept: payloadKept }) as InboxEventView;

  it('takes a failed or a dead event that still has its payload, and nothing else', () => {
    expect(mayReplay(event('FAILED'))).toBe(true);
    expect(mayReplay(event('DEAD'))).toBe(true);
    expect(mayReplay(event('DEAD', false))).toBe(false);
    for (const status of ['RECEIVED', 'PROCESSING', 'PROCESSED']) expect(mayReplay(event(status))).toBe(false);
  });
});

describe('describeProblem', () => {
  const failure = (code: string, status = 409) => new ApiError({ status, code, correlationId: 'c' });

  it('maps the codes of a replay to the reasons the screen words', () => {
    expect(describeProblem(failure('INBOX_STATE_INVALID')).reason).toBe('stateInvalid');
    expect(describeProblem(failure('VERSION_CONFLICT')).reason).toBe('conflict');
    expect(describeProblem(failure('RESOURCE_NOT_FOUND', 404)).reason).toBe('notFound');
    expect(describeProblem(failure('SCOPE_DENIED', 403)).reason).toBe('denied');
    expect(describeProblem(failure('ENTITLEMENT_DENIED', 403)).reason).toBe('denied');
    expect(describeProblem(failure('VALIDATION_FAILED', 422)).reason).toBe('invalid');
    expect(describeProblem(failure('INVALID_REQUEST', 400)).reason).toBe('invalid');
    expect(describeProblem(failure('SESSION_EXPIRED', 401)).reason).toBe('session');
    expect(describeProblem(failure('OTHER', 500)).reason).toBe('general');
    expect(describeProblem(new Error('x')).reason).toBe('general');
  });
});

describe.each(['vi', 'en'] as const)('the words of ADM-10 in %s', (locale) => {
  const t = createTranslator({ locale, catalogues: { vi, en }, strict: true }).t;

  it('has a sentence of its own for every status and every reason', () => {
    const all = [
      ...INBOX_STATUSES.map((status) => inboxStatusLabel(t, status)),
      ...(['stateInvalid', 'conflict', 'notFound', 'denied', 'invalid', 'session', 'general'] as const).map((reason) => problemMessage(t, { reason })),
    ];
    expect(all.every((text) => text !== '' && !text.startsWith('adm.sync.'))).toBe(true);
  });
});

describe('inboxStatusPill', () => {
  it('makes a dead event red, a failed one amber, a finished one plain and one that waits grey', () => {
    expect(INBOX_STATUSES.map(inboxStatusPill)).toEqual(['pill gray', 'pill gray', 'pill', 'pill warn', 'pill red']);
  });
});
