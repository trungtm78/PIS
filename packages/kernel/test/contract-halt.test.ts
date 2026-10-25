import { DomainError, GUARANTEE_ACTIONS, MAX_EXTENSION_DAYS, NEW_WORK_STATUSES, acceptsNewWork, assertDayBetween, assertNotProposer, guaranteeActionOf, terminationSuggestion, CONTRACT_STATUSES } from '../src/index.ts';

const refusal = (work: () => void): DomainError | undefined => {
  try {
    work();
  } catch (error) {
    return error instanceof DomainError ? error : undefined;
  }
  return undefined;
};

describe('the statuses that take new work (BR-PAY-09, CTR 3.2)', () => {
  it('AC-ST-CTR-005-1, UAT-AC303: takes new quantities and advances only while the contract is active', () => {
    expect(NEW_WORK_STATUSES).toEqual(['ACTIVE']);
    expect(CONTRACT_STATUSES.filter(acceptsNewWork)).toEqual(['ACTIVE']);
    expect(acceptsNewWork('SUSPENDED')).toBe(false);
    expect(acceptsNewWork('TERMINATED')).toBe(false);
  });
});

describe('the guarantee action of a termination', () => {
  it('knows call, release and hold, and nothing else', () => {
    expect(GUARANTEE_ACTIONS).toEqual(['CALL', 'RELEASE', 'HOLD']);
    expect(guaranteeActionOf('CALL')).toBe('CALL');
    expect(guaranteeActionOf('RELEASE')).toBe('RELEASE');
    expect(guaranteeActionOf('HOLD')).toBe('HOLD');
    expect(guaranteeActionOf('call')).toBeUndefined();
    expect(guaranteeActionOf(undefined)).toBeUndefined();
    expect(guaranteeActionOf(3)).toBeUndefined();
  });

  it('bounds the extension a resumption asks for at ten years', () => {
    expect(MAX_EXTENSION_DAYS).toBe(3650);
  });
});

describe('assertNotProposer', () => {
  const A = '00000000-0000-4000-8000-0000000000aa';
  const B = '00000000-0000-4000-8000-0000000000bb';

  it('AC-ST-CTR-005-2, UAT-AC304: refuses someone who proposed the end, whatever the case of the identifier', () => {
    expect(refusal(() => assertNotProposer(A, [B, A]))).toMatchObject({ code: 'SELF_APPROVAL_DENIED', status: 403 });
    expect(refusal(() => assertNotProposer(A.toUpperCase(), [A]))?.code).toBe('SELF_APPROVAL_DENIED');
    expect(refusal(() => assertNotProposer(A, [B.toUpperCase()]))).toBeUndefined();
  });

  it('lets anyone through when nobody is known to have proposed it', () => {
    expect(refusal(() => assertNotProposer(A, [null, undefined]))).toBeUndefined();
    expect(refusal(() => assertNotProposer(A, []))).toBeUndefined();
  });
});

describe('assertDayBetween', () => {
  it('accepts the bounds themselves and the days between, with or without an earliest day', () => {
    expect(refusal(() => assertDayBetween('terminated_on', '2026-10-01', '2026-10-01', '2026-10-25'))).toBeUndefined();
    expect(refusal(() => assertDayBetween('terminated_on', '2026-10-25', '2026-10-01', '2026-10-25'))).toBeUndefined();
    expect(refusal(() => assertDayBetween('terminated_on', '2000-01-01', null, '2026-10-25'))).toBeUndefined();
  });

  it('names the field and the bounds when the day is before the earliest or after the latest', () => {
    expect(refusal(() => assertDayBetween('suspended_from', '2026-09-30', '2026-10-01', '2026-10-25'))).toMatchObject({
      code: 'VALIDATION_FAILED',
      status: 422,
      detail: 'suspended_from',
      extensions: { earliest: '2026-10-01', latest: '2026-10-25' },
    });
    expect(refusal(() => assertDayBetween('resumed_on', '2026-10-26', null, '2026-10-25'))).toMatchObject({ detail: 'resumed_on', extensions: { earliest: null, latest: '2026-10-25' } });
  });
});

describe('terminationSuggestion', () => {
  it('suggests a recorded termination for the contractor, resting on the decision, with no penalty amount', () => {
    expect(terminationSuggestion({ contractId: 'c1', terminatedOn: '2026-10-20', reason: 'Abandoned the site', decisionDocumentVersionId: 'v1' })).toEqual({
      violationKind: 'OTHER',
      severity: 'MAJOR',
      penaltyKind: 'TERMINATION',
      penaltyAmountVnd: '0',
      occurredOn: '2026-10-20',
      description: 'Abandoned the site',
      decisionDocumentVersionId: 'v1',
      sourceModule: 'CTR',
      sourceRefId: 'c1',
    });
  });
});
