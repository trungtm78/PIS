import { DomainError } from '../src/errors';
import {
  PUBLIC_AI_POLICY,
  aiEditionPolicy,
  assertAttestedForActivation,
  assertExceptionRevocable,
  decideException,
  exceptionCovers,
  externalVerdict,
  isExternalRoute,
  parseAttestation,
  parseExceptionRequest,
  resetAiEditionPolicy,
  setAiEditionPolicy,
} from '../src/index';
import type { AiEditionPolicy, ExceptionRecord } from '../src/index';

const refusal = (run: () => unknown): DomainError => {
  try {
    run();
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error('expected a DomainError');
};

const PROVIDER = '55555555-5555-4555-8555-555555555555';
const OTHER = '66666666-6666-4666-8666-666666666666';
const NOW = new Date('2026-11-10T03:00:00Z');
const STRICT: AiEditionPolicy = { name: 'test-strict', externalRouting: 'EXCEPTION_REQUIRED', attestationRequired: true };
const exception = (patch: Partial<ExceptionRecord> = {}): ExceptionRecord => ({
  id: '77777777-7777-4777-8777-777777777777',
  providerId: PROVIDER,
  taskType: null,
  maxClassification: 'CONFIDENTIAL',
  status: 'APPROVED',
  validFrom: new Date('2026-11-01T00:00:00Z'),
  validUntil: new Date('2026-12-01T00:00:00Z'),
  ...patch,
});
const probe = (patch: Record<string, unknown> = {}) => ({ providerId: PROVIDER, route: 'DOMESTIC_HOSTED' as const, taskType: 'AI_ASSIST_QA', classification: 'INTERNAL' as const, now: NOW, ...patch });

afterEach(() => resetAiEditionPolicy());

describe('the policy of the edition', () => {
  it('is the public policy until an edition sets its own, and goes back to it', () => {
    expect(aiEditionPolicy()).toBe(PUBLIC_AI_POLICY);
    setAiEditionPolicy(STRICT);
    expect(aiEditionPolicy()).toMatchObject({ externalRouting: 'EXCEPTION_REQUIRED' });
    resetAiEditionPolicy();
    expect(aiEditionPolicy()).toBe(PUBLIC_AI_POLICY);
  });

  it('calls external every route but the one the customer hosts', () => {
    expect(isExternalRoute('SELF_HOSTED')).toBe(false);
    expect(isExternalRoute('DOMESTIC_HOSTED')).toBe(true);
    expect(isExternalRoute('INTERNATIONAL')).toBe(true);
  });
});

describe('KT.02: a request routed to an external provider is refused unless an exception exists', () => {
  it('leaves the public edition as it is: every route the routing policy allows', () => {
    expect(externalVerdict(PUBLIC_AI_POLICY, probe(), [])).toEqual({ allowed: true, exceptionId: null });
    expect(externalVerdict(PUBLIC_AI_POLICY, probe({ route: 'INTERNATIONAL', classification: 'PUBLIC' }), [])).toEqual({ allowed: true, exceptionId: null });
  });

  it('lets the self-hosted route through without an exception and refuses the others without one', () => {
    expect(externalVerdict(STRICT, probe({ route: 'SELF_HOSTED' }), [])).toEqual({ allowed: true, exceptionId: null });
    expect(externalVerdict(STRICT, probe(), [])).toEqual({ allowed: false, code: 'AI_EXTERNAL_EXCEPTION_REQUIRED' });
    expect(externalVerdict(STRICT, probe({ route: 'INTERNATIONAL', classification: 'PUBLIC' }), [])).toEqual({ allowed: false, code: 'AI_EXTERNAL_EXCEPTION_REQUIRED' });
  });

  it('allows the request that an approved exception covers and names the exception, so that its use is logged', () => {
    expect(externalVerdict(STRICT, probe(), [exception()])).toEqual({ allowed: true, exceptionId: '77777777-7777-4777-8777-777777777777' });
  });

  it.each([
    ['requested, not approved', exception({ status: 'REQUESTED', validFrom: null, validUntil: null })],
    ['rejected', exception({ status: 'REJECTED', validFrom: null, validUntil: null })],
    ['revoked', exception({ status: 'REVOKED' })],
    ['expired', exception({ validUntil: new Date('2026-11-10T03:00:00Z') })],
    ['not yet valid', exception({ validFrom: new Date('2026-11-11T00:00:00Z') })],
    ['of another provider', exception({ providerId: OTHER })],
    ['for another task', exception({ taskType: 'AI_ASSIST_DOC_REVIEW' })],
    ['for a lower class than the data', exception({ maxClassification: 'PUBLIC' })],
  ])('does not take an exception that is %s', (_name, candidate) => {
    expect(exceptionCovers(candidate, probe())).toBe(false);
    expect(externalVerdict(STRICT, probe(), [candidate])).toEqual({ allowed: false, code: 'AI_EXTERNAL_EXCEPTION_REQUIRED' });
  });

  it('takes an exception for the task asked and finds the one that covers among several', () => {
    const wrong = exception({ id: '88888888-8888-4888-8888-888888888888', taskType: 'AI_ASSIST_DOC_REVIEW' });
    const right = exception({ taskType: 'AI_ASSIST_QA' });
    expect(externalVerdict(STRICT, probe(), [wrong, right])).toMatchObject({ allowed: true, exceptionId: right.id });
  });
});

describe('asking for, deciding and revoking an exception', () => {
  const asked = { providerId: PROVIDER.toUpperCase(), taskType: 'AI_ASSIST_QA', maxClassification: 'INTERNAL', reason: 'The self-hosted model is down for a week and the report is due.', validDays: 7 };

  it('takes a request with a reason that says why and at most 90 days', () => {
    expect(parseExceptionRequest(asked)).toEqual({ providerId: PROVIDER, taskType: 'AI_ASSIST_QA', maxClassification: 'INTERNAL', reason: asked.reason, validDays: 7 });
    expect(parseExceptionRequest({ ...asked, taskType: undefined }).taskType).toBeNull();
    expect(refusal(() => parseExceptionRequest({ ...asked, reason: 'too short' })).detail).toBe('reason');
    expect(refusal(() => parseExceptionRequest({ ...asked, validDays: 91 })).detail).toBe('valid_days');
    expect(refusal(() => parseExceptionRequest({ ...asked, validDays: 0 })).detail).toBe('valid_days');
    expect(refusal(() => parseExceptionRequest({ ...asked, maxClassification: 'SECRET' })).detail).toBe('max_classification');
    expect(refusal(() => parseExceptionRequest({ ...asked, providerId: 'x' })).detail).toBe('provider_id');
  });

  const decide = (patch: Record<string, unknown> = {}) =>
    decideException({ decision: 'APPROVE', note: undefined, approvalRef: 'DEC-2026-114', requestedBy: 'maker', actor: 'checker', requestedValidDays: 7, providerMaxClassification: 'CONFIDENTIAL', maxClassification: 'INTERNAL', status: 'REQUESTED', now: NOW, ...patch });

  it('approves for the days asked, from now, with the reference of the paper; the person who asked does not decide', () => {
    expect(decide()).toEqual({ status: 'APPROVED', validFrom: NOW, validUntil: new Date('2026-11-17T03:00:00Z'), note: null, approvalRef: 'DEC-2026-114' });
    expect(refusal(() => decide({ actor: 'maker' })).code).toBe('SELF_APPROVAL_DENIED');
    expect(refusal(() => decide({ approvalRef: ' ' })).detail).toBe('approval_ref');
    expect(refusal(() => decide({ status: 'APPROVED' })).code).toBe('STAGE_TRANSITION_DENIED');
    expect(refusal(() => decide({ maxClassification: 'PERSONAL' })).code).toBe('CLASSIFICATION_ABOVE_PROVIDER');
    expect(refusal(() => decide({ decision: 'MAYBE' })).detail).toBe('decision');
  });

  it('rejects with a note that says why', () => {
    expect(decide({ decision: 'REJECT', note: 'Use the self-hosted model.' })).toEqual({ status: 'REJECTED', validFrom: null, validUntil: null, note: 'Use the self-hosted model.', approvalRef: null });
    expect(refusal(() => decide({ decision: 'REJECT', note: 'no' })).detail).toBe('note');
  });

  it('revokes only an approved exception, with a reason', () => {
    expect(assertExceptionRevocable('APPROVED', 'The provider changed its terms.')).toBe('The provider changed its terms.');
    expect(refusal(() => assertExceptionRevocable('REQUESTED', 'The provider changed its terms.')).code).toBe('STAGE_TRANSITION_DENIED');
    expect(refusal(() => assertExceptionRevocable('APPROVED', 'short')).detail).toBe('reason');
  });
});

describe('the attestation of a provider (data location and no training)', () => {
  const given = { dataLocationCountry: 'VN', dataLocationDetail: 'Data hall 2, Ho Chi Minh City', noTrainingAttested: true, attestationRef: 'DPA-2026-07 clause 9', attestationDocumentId: undefined };

  it('takes a country, a site, the flag and the paper that says so', () => {
    expect(parseAttestation(given)).toEqual({ dataLocationCountry: 'VN', dataLocationDetail: 'Data hall 2, Ho Chi Minh City', noTrainingAttested: true, attestationRef: 'DPA-2026-07 clause 9', attestationDocumentId: null });
    expect(refusal(() => parseAttestation({ ...given, dataLocationCountry: 'vn' })).detail).toBe('data_location_country');
    expect(refusal(() => parseAttestation({ ...given, noTrainingAttested: 'yes' })).detail).toBe('no_training_attested');
    expect(refusal(() => parseAttestation({ ...given, attestationRef: '' })).detail).toBe('attestation_ref');
  });

  it('is required before an external provider is activated under a policy that asks for it, and never for the self-hosted one', () => {
    expect(() => assertAttestedForActivation(PUBLIC_AI_POLICY, { routeClass: 'DOMESTIC_HOSTED', dataLocationCountry: null, noTrainingAttested: false })).not.toThrow();
    expect(() => assertAttestedForActivation(STRICT, { routeClass: 'SELF_HOSTED', dataLocationCountry: null, noTrainingAttested: false })).not.toThrow();
    expect(refusal(() => assertAttestedForActivation(STRICT, { routeClass: 'DOMESTIC_HOSTED', dataLocationCountry: null, noTrainingAttested: false })).code).toBe('PROVIDER_ATTESTATION_REQUIRED');
    expect(refusal(() => assertAttestedForActivation(STRICT, { routeClass: 'INTERNATIONAL', dataLocationCountry: 'US', noTrainingAttested: false })).code).toBe('PROVIDER_ATTESTATION_REQUIRED');
    expect(() => assertAttestedForActivation(STRICT, { routeClass: 'DOMESTIC_HOSTED', dataLocationCountry: 'VN', noTrainingAttested: true })).not.toThrow();
  });
});
