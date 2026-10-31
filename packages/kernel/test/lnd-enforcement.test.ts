import type { DomainError } from '../src/errors';
import { ENFORCEMENT_STEPS, assertAdvancerIsNotDrafter, assertEnforcementMove, assertStepFacts, stepAfter } from '../src/lnd-enforcement';
import type { EnforcementStep } from '../src/lnd-enforcement';

const failure = (work: () => unknown): DomainError => {
  try {
    work();
  } catch (error) {
    return error as DomainError;
  }
  throw new Error('expected a refusal');
};

const FLOW: EnforcementStep[] = ['PERSUASION', 'NOTICE', 'ORGANIZATION_DECISION', 'ENFORCEMENT_DECISION', 'EXECUTING', 'COMPLETED'];

describe('the enforcement of a land recovery (ST-LND-011, UAT-AC385)', () => {
  it('goes through the steps in order and has no step after the last or after a suspension', () => {
    expect(FLOW.map(stepAfter)).toEqual(['NOTICE', 'ORGANIZATION_DECISION', 'ENFORCEMENT_DECISION', 'EXECUTING', 'COMPLETED', undefined]);
    expect(stepAfter('SUSPENDED')).toBeUndefined();
    expect([...ENFORCEMENT_STEPS]).toEqual([...FLOW, 'SUSPENDED']);
  });

  it('moves forward by one step and by no other way', () => {
    for (let at = 0; at < FLOW.length - 1; at += 1) expect(() => assertEnforcementMove(FLOW[at] as EnforcementStep, FLOW[at + 1] as EnforcementStep, null)).not.toThrow();
    // Skipping a step, going back and staying are refused, with the steps said.
    expect(failure(() => assertEnforcementMove('PERSUASION', 'ORGANIZATION_DECISION', null))).toMatchObject({ code: 'ENFORCEMENT_STEP_INVALID', status: 422, extensions: { from_step: 'PERSUASION', to_step: 'ORGANIZATION_DECISION' } });
    expect(failure(() => assertEnforcementMove('NOTICE', 'PERSUASION', null))).toMatchObject({ code: 'ENFORCEMENT_STEP_INVALID' });
    expect(failure(() => assertEnforcementMove('NOTICE', 'NOTICE', null))).toMatchObject({ code: 'ENFORCEMENT_STEP_INVALID' });
    expect(failure(() => assertEnforcementMove('ENFORCEMENT_DECISION', 'COMPLETED', null))).toMatchObject({ code: 'ENFORCEMENT_STEP_INVALID' });
  });

  it('is suspended from any step but the last and from a suspension', () => {
    for (const step of FLOW.slice(0, -1)) expect(() => assertEnforcementMove(step, 'SUSPENDED', null)).not.toThrow();
    expect(failure(() => assertEnforcementMove('COMPLETED', 'SUSPENDED', null))).toMatchObject({ code: 'ENFORCEMENT_STEP_INVALID' });
    expect(failure(() => assertEnforcementMove('SUSPENDED', 'SUSPENDED', 'NOTICE'))).toMatchObject({ code: 'ENFORCEMENT_STEP_INVALID' });
  });

  it('is taken up again at the step it was suspended from or at the one after it, and not elsewhere', () => {
    expect(() => assertEnforcementMove('SUSPENDED', 'NOTICE', 'NOTICE')).not.toThrow();
    expect(() => assertEnforcementMove('SUSPENDED', 'ORGANIZATION_DECISION', 'NOTICE')).not.toThrow();
    // A case suspended in persuasion goes on to the notice: persuasion is not a step to be entered again.
    expect(() => assertEnforcementMove('SUSPENDED', 'NOTICE', 'PERSUASION')).not.toThrow();
    expect(failure(() => assertEnforcementMove('SUSPENDED', 'PERSUASION', 'PERSUASION'))).toMatchObject({ code: 'ENFORCEMENT_STEP_INVALID' });
    expect(failure(() => assertEnforcementMove('SUSPENDED', 'EXECUTING', 'NOTICE'))).toMatchObject({ code: 'ENFORCEMENT_STEP_INVALID' });
    expect(failure(() => assertEnforcementMove('SUSPENDED', 'NOTICE', 'ENFORCEMENT_DECISION'))).toMatchObject({ code: 'ENFORCEMENT_STEP_INVALID' });
    expect(failure(() => assertEnforcementMove('SUSPENDED', 'NOTICE', null))).toMatchObject({ code: 'ENFORCEMENT_STEP_INVALID' });
    expect(failure(() => assertEnforcementMove('COMPLETED', 'NOTICE', null))).toMatchObject({ code: 'ENFORCEMENT_STEP_INVALID' });
  });

  it('UAT-AC385: a decision step needs the document of the decision, the step of execution also its day, the completion the day it was carried out and a suspension its reason', () => {
    const none = { decisionDocumentVersionId: undefined, plannedOn: undefined, executedOn: undefined, suspendReason: undefined };
    expect(() => assertStepFacts('NOTICE', none)).not.toThrow();
    for (const step of ['ORGANIZATION_DECISION', 'ENFORCEMENT_DECISION', 'EXECUTING'] as const) {
      expect(failure(() => assertStepFacts(step, none))).toMatchObject({ code: 'DECISION_DOCUMENT_REQUIRED', status: 422 });
    }
    expect(() => assertStepFacts('ORGANIZATION_DECISION', { ...none, decisionDocumentVersionId: 'd' })).not.toThrow();
    expect(failure(() => assertStepFacts('EXECUTING', { ...none, decisionDocumentVersionId: 'd' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'planned_on' });
    expect(() => assertStepFacts('EXECUTING', { ...none, decisionDocumentVersionId: 'd', plannedOn: '2026-12-01' })).not.toThrow();
    expect(failure(() => assertStepFacts('COMPLETED', none))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'executed_on' });
    expect(() => assertStepFacts('COMPLETED', { ...none, executedOn: '2026-12-02' })).not.toThrow();
    expect(failure(() => assertStepFacts('SUSPENDED', none))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'suspend_reason' });
    expect(() => assertStepFacts('SUSPENDED', { ...none, suspendReason: 'An appeal was filed' })).not.toThrow();
  });

  it('UAT-AC385: the person who drew the case up does not advance it', () => {
    expect(() => assertAdvancerIsNotDrafter('b', 'a')).not.toThrow();
    expect(failure(() => assertAdvancerIsNotDrafter('a', 'a'))).toMatchObject({ code: 'SELF_APPROVAL_DENIED', status: 403 });
    expect(failure(() => assertAdvancerIsNotDrafter('A', 'a'))).toMatchObject({ code: 'SELF_APPROVAL_DENIED' });
  });
});
