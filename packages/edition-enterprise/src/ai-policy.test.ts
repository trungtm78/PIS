import { PUBLIC_AI_POLICY, aiEditionPolicy, externalVerdict } from '@machvon/kernel/src/ai-edition-policy.ts';
import { ENTERPRISE_AI_POLICY, clearEnterpriseAiPolicy, registerEnterpriseAiPolicy } from './ai-policy.ts';

afterEach(() => clearEnterpriseAiPolicy());

describe('the AI policy of the enterprise edition (R5)', () => {
  it('keeps processing on the customer servers: external providers need an exception and an attestation', () => {
    expect(ENTERPRISE_AI_POLICY).toMatchObject({ externalRouting: 'EXCEPTION_REQUIRED', attestationRequired: true });
    expect(Object.isFrozen(ENTERPRISE_AI_POLICY)).toBe(true);
  });

  it('is the policy of the process only after the seam registers it, and the public one before and after a reset', () => {
    expect(aiEditionPolicy()).toBe(PUBLIC_AI_POLICY);
    registerEnterpriseAiPolicy();
    expect(aiEditionPolicy()).toMatchObject({ name: ENTERPRISE_AI_POLICY.name, externalRouting: 'EXCEPTION_REQUIRED' });
    clearEnterpriseAiPolicy();
    expect(aiEditionPolicy()).toBe(PUBLIC_AI_POLICY);
  });

  it('refuses a request to a provider outside the customer servers when no exception stands, and lets the self-hosted model through', () => {
    registerEnterpriseAiPolicy();
    const probe = { providerId: '11111111-1111-4111-8111-111111111111', taskType: 'AI_ASSIST_QA', classification: 'INTERNAL' as const, now: new Date('2026-11-10T00:00:00Z') };
    expect(externalVerdict(aiEditionPolicy(), { ...probe, route: 'DOMESTIC_HOSTED' }, [])).toEqual({ allowed: false, code: 'AI_EXTERNAL_EXCEPTION_REQUIRED' });
    expect(externalVerdict(aiEditionPolicy(), { ...probe, route: 'INTERNATIONAL', classification: 'PUBLIC' }, [])).toEqual({ allowed: false, code: 'AI_EXTERNAL_EXCEPTION_REQUIRED' });
    expect(externalVerdict(aiEditionPolicy(), { ...probe, route: 'SELF_HOSTED' }, [])).toEqual({ allowed: true, exceptionId: null });
  });
});
