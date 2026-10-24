import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import vi from '../../../i18n/vi.json';
import { channelName, problemMessage, purposeName, statusName, statusPill } from './labels';
import { problemReasonOf } from './model';
import type { ProblemReason } from './model';

// A translator that returns the key, so the test sees which key each case uses.
const t = ((key: string) => key) as Parameters<typeof channelName>[0];

describe('the words of the consent screen', () => {
  it('names every channel, purpose and status with a key of the catalogue, and a code it does not know by itself', () => {
    const keys = [
      ...['EMAIL', 'SMS', 'ZALO', 'WHATSAPP', 'PUSH'].map((channel) => channelName(t, channel)),
      ...['OPERATIONAL', 'REMINDER', 'ANNOUNCEMENT', 'SUPPORT_CONVERSATION'].map((purpose) => purposeName(t, purpose)),
      ...(['Granted', 'Withdrawn', 'Expired'] as const).map((status) => statusName(t, status)),
    ];
    for (const key of keys) expect(Object.keys(vi)).toContain(key);
    expect(channelName(t, 'FAX')).toBe('FAX');
    expect(purposeName(t, 'MARKETING')).toBe('MARKETING');
    expect(statusPill('Granted')).toBe('pill');
    expect(statusPill('Withdrawn')).toBe('pill gray');
  });

  it('reads the code of the server into a reason, and every reason has its own message', () => {
    const code = (value: string): ApiError => new ApiError({ status: 400, code: value, correlationId: 'c' });
    const reasons = ['CONSENT_ALREADY_GRANTED', 'CHANNEL_IDENTITY_UNVERIFIED', 'VERSION_CONFLICT', 'CONSENT_STATE_INVALID', 'RESOURCE_NOT_FOUND', 'SCOPE_DENIED', 'VALIDATION_FAILED', 'SESSION_EXPIRED', 'SOMETHING_NEW'].map((value) =>
      problemReasonOf(code(value)),
    );
    expect(reasons).toEqual(['alreadyGranted', 'identity', 'stale', 'ended', 'notFound', 'denied', 'invalid', 'session', 'general']);
    expect(problemReasonOf(new Error('network'))).toBe('general');
    const messages = new Set((reasons as ProblemReason[]).map((reason) => problemMessage(t, reason)));
    expect(messages.size).toBe(9);
    for (const key of messages) expect(Object.keys(vi)).toContain(key);
  });
});
