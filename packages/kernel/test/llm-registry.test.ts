import { DomainError } from '../src/errors.ts';
import { BASELINE_MATRIX, assertActivation, assertModelRegistration, assertPolicyDraft, assertProviderRegistration, assertPublishable, baselineViolations, routesFor } from '../src/llm-registry.ts';

const thrown = (action: () => unknown): DomainError => {
  try {
    action();
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error('expected a DomainError');
};
const shape = (error: DomainError) => [error.status, error.code];

const WITH_INTERNATIONAL = { ...BASELINE_MATRIX, PUBLIC: ['DOMESTIC_HOSTED', 'SELF_HOSTED', 'INTERNATIONAL'] };
const WITHOUT_INTERNATIONAL = { ...BASELINE_MATRIX, PUBLIC: ['DOMESTIC_HOSTED', 'SELF_HOSTED'] };

describe('the registry of providers and models (ST-LLM-001, LLM F2)', () => {
  it('AC-ST-LLM-001-1: UAT-AC457 refuses an international provider that takes anything above public data, and a domestic one outside Viet Nam', () => {
    const intl = { providerCode: 'INTL-1', regionCountry: 'US', routeClass: 'INTERNATIONAL' as const, maxClassification: 'INTERNAL' as const };
    expect(shape(thrown(() => assertProviderRegistration(intl)))).toEqual([422, 'INTERNATIONAL_CLASSIFICATION_NOT_ALLOWED']);
    expect(() => assertProviderRegistration({ ...intl, maxClassification: 'PUBLIC' })).not.toThrow();
    expect(shape(thrown(() => assertProviderRegistration({ ...intl, routeClass: 'DOMESTIC_HOSTED', maxClassification: 'INTERNAL' })))).toEqual([422, 'VALIDATION_FAILED']);
    expect(() => assertProviderRegistration({ ...intl, regionCountry: 'VN', routeClass: 'SELF_HOSTED', maxClassification: 'IMPORTANT_CORE' })).not.toThrow();
  });

  it('AC-ST-LLM-001-1: UAT-AC457 activates an international provider only with the approval of D07, and a provider that takes more than public data only with its data agreement', () => {
    const base = { routeClass: 'INTERNATIONAL' as const, maxClassification: 'PUBLIC' as const, d07ApprovalRef: undefined, dataAgreementDocumentId: null, registeredBy: 'a', actor: 'b' };
    expect(shape(thrown(() => assertActivation(base)))).toEqual([422, 'D07_APPROVAL_REQUIRED']);
    expect(shape(thrown(() => assertActivation({ ...base, d07ApprovalRef: '  ' })))).toEqual([422, 'D07_APPROVAL_REQUIRED']);
    expect(() => assertActivation({ ...base, d07ApprovalRef: 'D07-2026-01' })).not.toThrow();
    const domestic = { ...base, routeClass: 'DOMESTIC_HOSTED' as const, maxClassification: 'CONFIDENTIAL' as const };
    expect(shape(thrown(() => assertActivation(domestic)))).toEqual([422, 'DATA_AGREEMENT_REQUIRED']);
    expect(() => assertActivation({ ...domestic, dataAgreementDocumentId: 'doc-1' })).not.toThrow();
    expect(() => assertActivation({ ...domestic, maxClassification: 'PUBLIC' })).not.toThrow();
  });

  it('refuses the person who registered a provider as its approver, after the conditions on the request', () => {
    const own = { routeClass: 'DOMESTIC_HOSTED' as const, maxClassification: 'PUBLIC' as const, d07ApprovalRef: undefined, dataAgreementDocumentId: null, registeredBy: 'a', actor: 'a' };
    expect(shape(thrown(() => assertActivation(own)))).toEqual([403, 'SELF_APPROVAL_DENIED']);
    expect(shape(thrown(() => assertActivation({ ...own, routeClass: 'INTERNATIONAL' })))).toEqual([422, 'D07_APPROVAL_REQUIRED']);
  });

  it('refuses a model above the classification its provider takes, and a window it cannot fill', () => {
    const ok = { providerMax: 'CONFIDENTIAL' as const, maxClassification: 'INTERNAL' as const, contextWindow: 8000, maxOutput: 1000, capabilities: { json_schema: true } };
    expect(() => assertModelRegistration(ok)).not.toThrow();
    expect(shape(thrown(() => assertModelRegistration({ ...ok, maxClassification: 'PERSONAL' })))).toEqual([422, 'CLASSIFICATION_ABOVE_PROVIDER']);
    expect(shape(thrown(() => assertModelRegistration({ ...ok, maxOutput: 9000 })))).toEqual([422, 'VALIDATION_FAILED']);
    expect(shape(thrown(() => assertModelRegistration({ ...ok, contextWindow: 0 })))).toEqual([422, 'VALIDATION_FAILED']);
    expect(shape(thrown(() => assertModelRegistration({ ...ok, capabilities: [] as never })))).toEqual([422, 'VALIDATION_FAILED']);
  });
});

describe('the classification matrix and its baseline (ST-LLM-001, LLM BR-LLM-01)', () => {
  it('has no route to an international model for anything above public data, and important data only on a self-hosted one', () => {
    expect(BASELINE_MATRIX.INTERNAL).toEqual(['DOMESTIC_HOSTED', 'SELF_HOSTED']);
    expect(BASELINE_MATRIX.IMPORTANT_CORE).toEqual(['SELF_HOSTED']);
    for (const level of ['INTERNAL', 'CONFIDENTIAL', 'PERSONAL', 'IMPORTANT_CORE'] as const) expect(BASELINE_MATRIX[level]).not.toContain('INTERNATIONAL');
    // International is off until a published policy turns it on.
    expect(routesFor('PUBLIC', undefined)).toEqual(['DOMESTIC_HOSTED', 'SELF_HOSTED']);
    expect(routesFor('PUBLIC', { matrix: WITH_INTERNATIONAL as never, internationalEnabled: true })).toContain('INTERNATIONAL');
    expect(routesFor('PUBLIC', { matrix: WITH_INTERNATIONAL as never, internationalEnabled: false })).not.toContain('INTERNATIONAL');
    expect(routesFor('IMPORTANT_CORE', { matrix: BASELINE_MATRIX as never, internationalEnabled: true })).toEqual(['SELF_HOSTED']);
  });

  it('AC-ST-LLM-001-1: UAT-AC457 takes a draft that turns international on only with the approval of D07, and a matrix that agrees with it', () => {
    expect(shape(thrown(() => assertPolicyDraft({ matrix: WITH_INTERNATIONAL, internationalEnabled: true, d07ApprovalRef: undefined })))).toEqual([422, 'D07_APPROVAL_REQUIRED']);
    expect(() => assertPolicyDraft({ matrix: WITH_INTERNATIONAL, internationalEnabled: true, d07ApprovalRef: 'D07-1' })).not.toThrow();
    expect(() => assertPolicyDraft({ matrix: WITHOUT_INTERNATIONAL, internationalEnabled: false, d07ApprovalRef: undefined })).not.toThrow();
    // A matrix that names the international route while the tenant has it off says two things.
    expect(shape(thrown(() => assertPolicyDraft({ matrix: WITH_INTERNATIONAL, internationalEnabled: false, d07ApprovalRef: undefined })))).toEqual([422, 'POLICY_MATRIX_INVALID']);
  });

  it('refuses a matrix that is not one: an unknown level or route, a row that is not a list, a repeated route', () => {
    for (const matrix of [
      null,
      [],
      'x',
      { ...BASELINE_MATRIX, SECRET: ['SELF_HOSTED'] },
      { ...BASELINE_MATRIX, INTERNAL: 'SELF_HOSTED' },
      { ...BASELINE_MATRIX, INTERNAL: ['MOON'] },
      { ...BASELINE_MATRIX, INTERNAL: ['SELF_HOSTED', 'SELF_HOSTED'] },
      { ...BASELINE_MATRIX, INTERNAL: [3] },
    ]) {
      expect(shape(thrown(() => assertPolicyDraft({ matrix, internationalEnabled: false, d07ApprovalRef: undefined })))).toEqual([422, 'POLICY_MATRIX_INVALID']);
    }
  });

  it('AC-ST-LLM-001-2: UAT-AC458 finds what a policy takes from the baseline: a dropped line of important data, a wider route, a missing level', () => {
    const matrixOf = (value: unknown) => value as never;
    expect(baselineViolations({ matrix: matrixOf(WITHOUT_INTERNATIONAL), internationalEnabled: false })).toEqual([]);
    expect(baselineViolations({ matrix: matrixOf(WITH_INTERNATIONAL), internationalEnabled: true })).toEqual([]);
    // Stricter than the baseline is fine: a tenant may close a route.
    expect(baselineViolations({ matrix: matrixOf({ ...WITHOUT_INTERNATIONAL, PERSONAL: ['SELF_HOSTED'] }), internationalEnabled: false })).toEqual([]);
    const { IMPORTANT_CORE: dropped, ...rest } = WITHOUT_INTERNATIONAL;
    void dropped;
    expect(baselineViolations({ matrix: matrixOf(rest), internationalEnabled: false })).toEqual(['IMPORTANT_CORE']);
    expect(baselineViolations({ matrix: matrixOf({ ...WITHOUT_INTERNATIONAL, IMPORTANT_CORE: ['DOMESTIC_HOSTED', 'SELF_HOSTED'] }), internationalEnabled: false })).toEqual(['IMPORTANT_CORE']);
    // Important data has a line that cannot be emptied either: it is only for a self-hosted model.
    expect(baselineViolations({ matrix: matrixOf({ ...WITHOUT_INTERNATIONAL, IMPORTANT_CORE: [] }), internationalEnabled: false })).toEqual(['IMPORTANT_CORE']);
    expect(baselineViolations({ matrix: matrixOf({ ...WITH_INTERNATIONAL, INTERNAL: ['DOMESTIC_HOSTED', 'INTERNATIONAL'] }), internationalEnabled: true })).toEqual(['INTERNAL']);
    expect(baselineViolations({ matrix: matrixOf({ ...WITH_INTERNATIONAL, PERSONAL: ['INTERNATIONAL'], CONFIDENTIAL: ['SELF_HOSTED', 'INTERNATIONAL'] }), internationalEnabled: true })).toEqual(['CONFIDENTIAL', 'PERSONAL']);
  });

  it('AC-ST-LLM-001-2: UAT-AC458 refuses to publish what weakens the baseline, with POLICY_WEAKENS_BASELINE naming the levels, and to publish one that is not in force yet or by its author', () => {
    const now = new Date('2026-10-01T00:00:00Z');
    const draft = { matrix: WITHOUT_INTERNATIONAL as never, internationalEnabled: false, createdBy: 'a', effectiveFrom: new Date('2026-09-01T00:00:00Z'), actor: 'b', now };
    expect(() => assertPublishable(draft)).not.toThrow();
    const weak = thrown(() => assertPublishable({ ...draft, matrix: { ...WITHOUT_INTERNATIONAL, IMPORTANT_CORE: ['DOMESTIC_HOSTED', 'SELF_HOSTED'] } as never }));
    expect([weak.status, weak.code, weak.detail]).toEqual([422, 'POLICY_WEAKENS_BASELINE', 'IMPORTANT_CORE']);
    expect(shape(thrown(() => assertPublishable({ ...draft, actor: 'a' })))).toEqual([403, 'SELF_APPROVAL_DENIED']);
    expect(shape(thrown(() => assertPublishable({ ...draft, effectiveFrom: new Date('2026-10-02T00:00:00Z') })))).toEqual([422, 'VALIDATION_FAILED']);
    // The baseline is judged before the person: a weakening is told to the author who tries to approve it too.
    expect(shape(thrown(() => assertPublishable({ ...draft, actor: 'a', matrix: { ...WITHOUT_INTERNATIONAL, INTERNAL: ['INTERNATIONAL'] } as never })))).toEqual([422, 'POLICY_WEAKENS_BASELINE']);
  });
});
