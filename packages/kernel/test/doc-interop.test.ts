import { createHmac } from 'node:crypto';
import type { DomainError } from '../src/errors';
import { verifyProviderCallback } from '../src/provider-signature';
import {
  INBOUND_STATUSES,
  INTEROP_ADAPTER_STATUSES,
  INTEROP_BACKOFF_CAP_SECONDS,
  INTEROP_DIRECTIONS,
  INTEROP_MAX_ATTEMPTS,
  INTEROP_SIGNATURE_SCHEME,
  OUTBOUND_STATUSES,
  assertEgressAllowed,
  assertInteropEvent,
  assertRetryable,
  egressDecision,
  interopBackoffSeconds,
  interopSignedPayload,
  isEgressEntry,
  planFailure,
  signInteropMessage,
} from '../src/doc-interop';
import type { InteropEvent, InteropSignedFields, InteropStatus } from '../src/doc-interop';

function refusal(work: () => unknown): DomainError {
  try {
    work();
  } catch (error) {
    return error as DomainError;
  }
  throw new Error('expected a refusal');
}

const NOW = new Date('2026-11-03T03:00:00.000Z');

describe('the states and the attempts of an interoperability message (ST-DOC-021)', () => {
  it('names the directions, the statuses of each and the words for the adapter', () => {
    expect(INTEROP_DIRECTIONS).toEqual(['OUTBOUND', 'INBOUND']);
    expect(OUTBOUND_STATUSES).toEqual(['QUEUED', 'SENT', 'ACKED', 'REJECTED', 'FAILED', 'DEAD']);
    expect(INBOUND_STATUSES).toEqual(['RECEIVED', 'PROCESSED']);
    expect(INTEROP_ADAPTER_STATUSES).toEqual(['VERIFIED', 'PROPOSED', 'MOCK', 'MISSING']);
    expect(INTEROP_MAX_ATTEMPTS).toBe(20);
  });

  describe('the waits between the attempts (AC-ST-DOC-021-1)', () => {
    it('doubles from a minute up to six hours', () => {
      expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 19].map(interopBackoffSeconds)).toEqual([60, 120, 240, 480, 960, 1920, 3840, 7680, 15360, 21600, 21600]);
      expect(interopBackoffSeconds(10_000)).toBe(INTEROP_BACKOFF_CAP_SECONDS);
    });

    it.each([0, -1, 1.5, Number.NaN])('has no wait for %s failed attempts', (count) => {
      expect(() => interopBackoffSeconds(count)).toThrow(RangeError);
    });
  });

  describe('what a failed attempt does (AC-ST-DOC-021-1)', () => {
    it('waits for the next attempt and counts the one that failed', () => {
      expect(planFailure(0, NOW)).toEqual({ status: 'FAILED', attempts: 1, nextAttemptAt: new Date('2026-11-03T03:01:00.000Z') });
      expect(planFailure(3, NOW)).toEqual({ status: 'FAILED', attempts: 4, nextAttemptAt: new Date('2026-11-03T03:08:00.000Z') });
      expect(planFailure(18, NOW)).toEqual({ status: 'FAILED', attempts: 19, nextAttemptAt: new Date('2026-11-03T09:00:00.000Z') });
    });

    it('ends as DEAD on the twentieth failure and has no next attempt', () => {
      expect(planFailure(19, NOW)).toEqual({ status: 'DEAD', attempts: 20, nextAttemptAt: null });
      expect(planFailure(25, NOW)).toEqual({ status: 'DEAD', attempts: 20, nextAttemptAt: null });
    });

    it('is DEAD after exactly twenty failures in a row', () => {
      let attempts = 0;
      let outcome = planFailure(attempts, NOW);
      let failures = 1;
      while (outcome.status === 'FAILED') {
        attempts = outcome.attempts;
        outcome = planFailure(attempts, NOW);
        failures += 1;
      }
      expect(failures).toBe(20);
    });
  });

  describe('the edges between the states', () => {
    const allowed: Array<[InteropEvent, 'OUTBOUND' | 'INBOUND', InteropStatus]> = [
      ['send', 'OUTBOUND', 'QUEUED'],
      ['fail', 'OUTBOUND', 'QUEUED'],
      ['requeue', 'OUTBOUND', 'FAILED'],
      ['retry', 'OUTBOUND', 'FAILED'],
      ['retry', 'OUTBOUND', 'DEAD'],
      ['cancel', 'OUTBOUND', 'QUEUED'],
      ['cancel', 'OUTBOUND', 'FAILED'],
      ['acknowledge', 'OUTBOUND', 'SENT'],
      ['reject', 'OUTBOUND', 'SENT'],
      ['process', 'INBOUND', 'RECEIVED'],
    ];

    it.each(allowed)('lets %s take a %s message that is %s', (event, direction, from) => {
      expect(() => assertInteropEvent(event, direction, from)).not.toThrow();
    });

    it('allows no other event for any direction and status', () => {
      const events: InteropEvent[] = ['send', 'fail', 'requeue', 'retry', 'cancel', 'acknowledge', 'reject', 'process'];
      const every = [...OUTBOUND_STATUSES, ...INBOUND_STATUSES];
      let taken = 0;
      for (const event of events)
        for (const direction of INTEROP_DIRECTIONS)
          for (const from of every) {
            try {
              assertInteropEvent(event, direction, from);
              taken += 1;
            } catch (error) {
              expect((error as DomainError).code).toBe('INTEROP_STATE_INVALID');
            }
          }
      expect(taken).toBe(allowed.length);
    });

    it('takes an event only for the direction it belongs to, even from a status the other direction also has', () => {
      expect(() => assertInteropEvent('retry', 'INBOUND', 'FAILED')).toThrow();
      expect(() => assertInteropEvent('process', 'OUTBOUND', 'RECEIVED')).toThrow();
      expect(() => assertInteropEvent('send', 'INBOUND', 'QUEUED')).toThrow();
      expect(() => assertInteropEvent('process', 'INBOUND', 'RECEIVED')).not.toThrow();
    });

    it('keeps a message that ended where it is', () => {
      for (const ended of ['ACKED', 'REJECTED', 'PROCESSED'] as const) {
        for (const event of ['send', 'fail', 'requeue', 'retry', 'cancel', 'acknowledge', 'reject', 'process'] as const) {
          expect(() => assertInteropEvent(event, ended === 'PROCESSED' ? 'INBOUND' : 'OUTBOUND', ended)).toThrow();
        }
      }
    });
  });

  describe('sending a message again by hand (AC-ST-DOC-021-1)', () => {
    it.each(['FAILED', 'DEAD'] as const)('takes a %s message', (status) => {
      expect(() => assertRetryable('OUTBOUND', status)).not.toThrow();
    });

    it.each(['QUEUED', 'SENT', 'ACKED', 'REJECTED'] as const)('refuses a %s message with 409 INTEROP_STATE_INVALID and says which status it has', (status) => {
      const error = refusal(() => assertRetryable('OUTBOUND', status));
      expect([error.code, error.status, error.extensions]).toEqual(['INTEROP_STATE_INVALID', 409, { status, direction: 'OUTBOUND' }]);
    });

    it('refuses a message that arrived: nothing is sent for it', () => {
      for (const status of INBOUND_STATUSES) expect(refusal(() => assertRetryable('INBOUND', status)).code).toBe('INTEROP_STATE_INVALID');
    });
  });
});

describe('the hosts the system may call (AC-ST-DOC-021-2)', () => {
  it('allows an https address whose host is listed, whatever the capitals, the port or the path', () => {
    expect(egressDecision('https://LGSP.example.gov.vn:8443/ws/send?x=1', ['lgsp.example.gov.vn'])).toEqual({ allowed: true, host: 'lgsp.example.gov.vn', endpoint: 'https://lgsp.example.gov.vn:8443/ws/send?x=1' });
    expect(egressDecision('https://lgsp.example.gov.vn', ['LGSP.Example.gov.vn'])).toEqual({ allowed: true, host: 'lgsp.example.gov.vn', endpoint: 'https://lgsp.example.gov.vn/' });
  });

  it('allows the hosts below a wildcard domain and not the domain itself', () => {
    expect(egressDecision('https://a.b.gov.vn/x', ['*.gov.vn'])).toMatchObject({ allowed: true });
    expect(egressDecision('https://gov.vn/x', ['*.gov.vn'])).toEqual({ allowed: false, reason: 'HOST_NOT_ALLOWED' });
    expect(egressDecision('https://evilgov.vn/x', ['*.gov.vn'])).toEqual({ allowed: false, reason: 'HOST_NOT_ALLOWED' });
  });

  it('refuses a host that is not listed, however much it looks like one that is', () => {
    expect(egressDecision('https://lgsp.example.gov.vn.attacker.net/x', ['lgsp.example.gov.vn'])).toEqual({ allowed: false, reason: 'HOST_NOT_ALLOWED' });
    expect(egressDecision('https://attacker.net@lgsp.example.gov.vn/x', ['attacker.net'])).toEqual({ allowed: false, reason: 'HOST_NOT_ALLOWED' });
  });

  it('allows nothing to a tenant that listed nothing', () => {
    expect(egressDecision('https://lgsp.example.gov.vn', [])).toEqual({ allowed: false, reason: 'HOST_NOT_ALLOWED' });
  });

  it('refuses an address that is not https, and one that is not an address', () => {
    expect(egressDecision('http://lgsp.example.gov.vn', ['lgsp.example.gov.vn'])).toEqual({ allowed: false, reason: 'SCHEME_NOT_HTTPS' });
    expect(egressDecision('ftp://lgsp.example.gov.vn', ['lgsp.example.gov.vn'])).toEqual({ allowed: false, reason: 'SCHEME_NOT_HTTPS' });
    expect(egressDecision('not an address', ['lgsp.example.gov.vn'])).toEqual({ allowed: false, reason: 'ENDPOINT_INVALID' });
    expect(egressDecision(undefined, ['lgsp.example.gov.vn'])).toEqual({ allowed: false, reason: 'ENDPOINT_INVALID' });
  });

  it('matches nothing with an entry that is not a host name', () => {
    for (const entry of ['https://lgsp.example.gov.vn', 'lgsp.example.gov.vn/path', 'lgsp.example.gov.vn:443', '*', '*gov.vn', '', 7, null]) {
      expect(isEgressEntry(entry)).toBe(false);
      expect(egressDecision('https://lgsp.example.gov.vn', [entry])).toEqual({ allowed: false, reason: 'HOST_NOT_ALLOWED' });
    }
    expect(isEgressEntry('lgsp.example.gov.vn')).toBe(true);
    expect(isEgressEntry('*.example.gov.vn')).toBe(true);
    expect(isEgressEntry(`${'a'.repeat(251)}.vn`)).toBe(false);
  });

  it('returns the host and the address it allowed, and refuses the rest with 422 EGRESS_NOT_ALLOWED and the reason', () => {
    expect(assertEgressAllowed('https://lgsp.example.gov.vn/x', ['lgsp.example.gov.vn'])).toEqual({ host: 'lgsp.example.gov.vn', endpoint: 'https://lgsp.example.gov.vn/x' });
    const error = refusal(() => assertEgressAllowed('https://elsewhere.example.org/x', ['lgsp.example.gov.vn']));
    expect([error.code, error.status, error.detail, error.extensions]).toEqual(['EGRESS_NOT_ALLOWED', 422, 'endpoint', { reason: 'HOST_NOT_ALLOWED' }]);
  });
});

describe('what an inbound message is signed over (AC-ST-DOC-021-2)', () => {
  const fields: InteropSignedFields = {
    externalMessageId: 'E-IN-1',
    senderCode: 'G08.SKHDT',
    envelopeSha256: 'a'.repeat(64),
    envelopeObjectKey: 'tenants/t/uploads/envelope-1',
    signatureKeyId: 'k-2026',
  };
  const secret = Buffer.from('shared-secret-of-the-agency');

  it('is the fields in a fixed order as a JSON array', () => {
    expect(interopSignedPayload(fields).toString('utf8')).toBe('["E-IN-1","G08.SKHDT","' + 'a'.repeat(64) + '","tenants/t/uploads/envelope-1","k-2026"]');
  });

  it('is an HMAC-SHA256 in hex of that payload', () => {
    expect(signInteropMessage(secret, fields)).toBe(createHmac('sha256', secret).update(interopSignedPayload(fields)).digest('hex'));
  });

  it('verifies under the scheme of the provider check, and changes with every field', () => {
    const signature = signInteropMessage(secret, fields);
    const check = (given: InteropSignedFields) => verifyProviderCallback({ provider: 'lgsp', rawBody: interopSignedPayload(given), signature, timestampSeconds: 0, keys: [{ keyId: 'k-2026', secret }], scheme: INTEROP_SIGNATURE_SCHEME, replayWindowSeconds: Number.MAX_SAFE_INTEGER });
    expect(check(fields)).toEqual({ keyId: 'k-2026' });
    for (const changed of [
      { externalMessageId: 'E-IN-2' },
      { senderCode: 'G08.SKHAC' },
      { envelopeSha256: 'b'.repeat(64) },
      { envelopeObjectKey: 'tenants/t/uploads/envelope-2' },
      { signatureKeyId: 'k-2025' },
    ]) {
      expect(refusal(() => check({ ...fields, ...changed })).code).toBe('SIGNATURE_INVALID');
    }
  });
});
