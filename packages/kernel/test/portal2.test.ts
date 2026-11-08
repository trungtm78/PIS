import { assertChecker, assertDecisionAllowed, nextOutcomeStatus } from '../src/bid-petition-outcome';
import { DomainError } from '../src/errors';
import { builtInDefault, registerAllGovernanceRules } from '../src/governance-rules';
import { disputeStats } from '../src/vnd-portal';
import {
  PORTAL_ACCESS_DEFAULTS,
  assertContactProof,
  assertInvitable,
  assertPortalUpload,
  assertScanClean,
  assertSecondPerson,
  effectiveInvitationStatus,
  nextInvitationStatus,
  normaliseContactEmail,
  portalAccessPolicyOf,
} from '../src/vnd-portal-access';

const code = (run: () => unknown): string | undefined => {
  try {
    run();
    return undefined;
  } catch (error) {
    return error instanceof DomainError ? `${error.code}:${error.status}` : String(error);
  }
};

describe('invitation of a contractor to the portal (PORTAL-2)', () => {
  it('moves only along the edges and asks a reason for a rejection or a revocation', () => {
    expect(nextInvitationStatus('PROPOSED', 'APPROVE')).toBe('APPROVED');
    expect(nextInvitationStatus('APPROVED', 'REVOKE', 'the contact left the company')).toBe('REVOKED');
    expect(nextInvitationStatus('PROPOSED', 'REVOKE', 'proposed by mistake')).toBe('REVOKED');
    expect(code(() => nextInvitationStatus('APPROVED', 'APPROVE'))).toBe('PORTAL_INVITATION_STATE_INVALID:409');
    expect(code(() => nextInvitationStatus('REVOKED', 'REVOKE', 'again and again'))).toBe('PORTAL_INVITATION_STATE_INVALID:409');
    expect(code(() => nextInvitationStatus('PROPOSED', 'REJECT', 'no'))).toBe('VALIDATION_FAILED:422');
  });

  it('applies the two-person rule', () => {
    const a = '11111111-1111-4111-8111-111111111111';
    expect(code(() => assertSecondPerson(a, a.toUpperCase()))).toBe('SCOPE_DENIED:403');
    expect(code(() => assertSecondPerson(a, '22222222-2222-4222-8222-222222222222'))).toBeUndefined();
  });

  it('reads an expired proposal or access as EXPIRED before the job writes it', () => {
    const now = new Date('2026-11-08T00:00:00Z');
    expect(effectiveInvitationStatus({ status: 'PROPOSED', proposalExpiresAt: '2026-11-07T00:00:00Z', accessValidUntil: null, now })).toBe('EXPIRED');
    expect(effectiveInvitationStatus({ status: 'PROPOSED', proposalExpiresAt: '2026-11-09T00:00:00Z', accessValidUntil: null, now })).toBe('PROPOSED');
    expect(effectiveInvitationStatus({ status: 'APPROVED', proposalExpiresAt: '2026-11-01T00:00:00Z', accessValidUntil: '2026-11-08T00:00:00Z', now })).toBe('EXPIRED');
    expect(effectiveInvitationStatus({ status: 'APPROVED', proposalExpiresAt: '2026-11-01T00:00:00Z', accessValidUntil: '2027-01-01T00:00:00Z', now })).toBe('APPROVED');
    expect(effectiveInvitationStatus({ status: 'REVOKED', proposalExpiresAt: '2026-11-01T00:00:00Z', accessValidUntil: '2020-01-01T00:00:00Z', now })).toBe('REVOKED');
  });

  it('proves the contact by the registry e-mail or by a named paper', () => {
    const email = normaliseContactEmail('  Contact@Acme.VN ');
    expect(email).toBe('contact@acme.vn');
    expect(assertContactProof({ basis: 'REGISTRY_EMAIL', reference: null, email, registryEmail: 'CONTACT@acme.vn' })).toEqual({ basis: 'REGISTRY_EMAIL', reference: null });
    expect(code(() => assertContactProof({ basis: 'REGISTRY_EMAIL', reference: null, email, registryEmail: 'other@acme.vn' }))).toBe('PORTAL_CONTACT_UNPROVEN:422');
    expect(code(() => assertContactProof({ basis: 'REGISTRY_EMAIL', reference: null, email, registryEmail: null }))).toBe('PORTAL_CONTACT_UNPROVEN:422');
    expect(code(() => assertContactProof({ basis: 'REGISTRY_EMAIL', reference: 'letter 12', email, registryEmail: email }))).toBe('VALIDATION_FAILED:422');
    expect(assertContactProof({ basis: 'REPRESENTATIVE_LETTER', reference: ' CV-2026/118 ', email, registryEmail: null })).toEqual({ basis: 'REPRESENTATIVE_LETTER', reference: 'CV-2026/118' });
    expect(code(() => assertContactProof({ basis: 'OTHER_EVIDENCE', reference: 'abc', email, registryEmail: null }))).toBe('VALIDATION_FAILED:422');
    expect(code(() => assertContactProof({ basis: 'GUESS', reference: 'abcdefgh', email, registryEmail: null }))).toBe('VALIDATION_FAILED:422');
    expect(code(() => normaliseContactEmail('not an address'))).toBe('VALIDATION_FAILED:422');
  });

  it('invites only a verified contractor that is not restricted', () => {
    expect(code(() => assertInvitable({ verificationStatus: 'VERIFIED', restricted: false }))).toBeUndefined();
    expect(code(() => assertInvitable({ verificationStatus: 'PENDING', restricted: false }))).toBe('CONTRACTOR_NOT_INVITABLE:422');
    expect(code(() => assertInvitable({ verificationStatus: 'VERIFIED', restricted: true }))).toBe('CONTRACTOR_NOT_INVITABLE:422');
  });

  it('keeps the numbers of the rule inside their bounds', () => {
    expect(portalAccessPolicyOf({ ...PORTAL_ACCESS_DEFAULTS })).toEqual(PORTAL_ACCESS_DEFAULTS);
    expect(code(() => portalAccessPolicyOf({ ...PORTAL_ACCESS_DEFAULTS, access_days: 3650 }))).toBe('GOVERNANCE_RULE_PARAMS_INVALID:422');
    expect(code(() => portalAccessPolicyOf({ ...PORTAL_ACCESS_DEFAULTS, proposal_days: 0 }))).toBe('GOVERNANCE_RULE_PARAMS_INVALID:422');
    expect(code(() => portalAccessPolicyOf(null))).toBe('GOVERNANCE_RULE_PARAMS_INVALID:422');
  });
});

describe('the rule of the portal access (PORTAL-2)', () => {
  it('is registered with an unverified starting value that passes its own parser', () => {
    registerAllGovernanceRules();
    const found = builtInDefault('VENDOR_PORTAL_ACCESS', 'DEFAULT');
    expect(found?.params).toEqual(PORTAL_ACCESS_DEFAULTS);
    expect(found?.legalStatus).toBe('UNVERIFIED');
  });
});

describe('upload limits of the portal (PORTAL-2)', () => {
  it('refuses what is not a clean scan, an unknown purpose, an empty or an oversize file', () => {
    expect(code(() => assertScanClean('CLEAN'))).toBeUndefined();
    expect(code(() => assertScanClean('INFECTED'))).toBe('FILE_NOT_CLEAN:422');
    expect(code(() => assertScanClean('UNAVAILABLE'))).toBe('SCAN_PENDING:409');
    expect(assertPortalUpload({ purpose: 'CERTIFICATE', sizeBytes: 10, maxBytes: 100 })).toBe('CERTIFICATE');
    expect(code(() => assertPortalUpload({ purpose: 'CERTIFICATE', sizeBytes: 101, maxBytes: 100 }))).toBe('PAYLOAD_TOO_LARGE:413');
    expect(code(() => assertPortalUpload({ purpose: 'CERTIFICATE', sizeBytes: 0, maxBytes: 100 }))).toBe('VALIDATION_FAILED:422');
    expect(code(() => assertPortalUpload({ purpose: 'PHOTO', sizeBytes: 10, maxBytes: 100 }))).toBe('VALIDATION_FAILED:422');
  });
});

describe('outcome of a petition (PORTAL-2)', () => {
  it('allows a decision only from the statuses that make sense', () => {
    expect(assertDecisionAllowed('UPHELD', 'RESOLVED')).toBe('UPHELD');
    expect(assertDecisionAllowed('REJECTED', 'ESCALATED')).toBe('REJECTED');
    expect(assertDecisionAllowed('WITHDRAWN', 'PROCESSING')).toBe('WITHDRAWN');
    expect(code(() => assertDecisionAllowed('UPHELD', 'RECEIVED'))).toBe('PETITION_OUTCOME_NOT_ALLOWED:422');
    expect(code(() => assertDecisionAllowed('WITHDRAWN', 'RESOLVED'))).toBe('PETITION_OUTCOME_NOT_ALLOWED:422');
    expect(code(() => assertDecisionAllowed('MAYBE', 'RESOLVED'))).toBe('VALIDATION_FAILED:422');
  });

  it('is confirmed or returned from PROPOSED only, by another person', () => {
    expect(nextOutcomeStatus('PROPOSED', 'CONFIRM')).toBe('CONFIRMED');
    expect(nextOutcomeStatus('PROPOSED', 'RETURN', 'the decision number is wrong')).toBe('RETURNED');
    expect(code(() => nextOutcomeStatus('PROPOSED', 'RETURN', 'no'))).toBe('VALIDATION_FAILED:422');
    expect(code(() => nextOutcomeStatus('CONFIRMED', 'CONFIRM'))).toBe('PETITION_OUTCOME_STATE_INVALID:409');
    expect(code(() => assertChecker('a', 'A'))).toBe('SCOPE_DENIED:403');
  });

  it('keeps the upheld share over decisions only and counts the answered petitions apart', () => {
    const day = '2026-01-01';
    const stats = disputeStats([
      { kind: 'PETITION', outcome: 'UPHELD', openedOn: day, closedOn: '2026-01-11' },
      { kind: 'PETITION', outcome: 'REJECTED', openedOn: day, closedOn: '2026-01-21' },
      { kind: 'PETITION', outcome: 'REJECTED', openedOn: day, closedOn: '2026-01-21' },
      { kind: 'PETITION', outcome: 'OPEN', openedOn: day, closedOn: null, awaitingOutcome: true },
      { kind: 'PETITION', outcome: 'OPEN', openedOn: day, closedOn: null },
    ]);
    expect(stats).toMatchObject({ total: 5, open: 2, upheld: 1, rejected: 2, withdrawn: 0, awaitingOutcome: 1, upheldPct: 33 });
  });
});
