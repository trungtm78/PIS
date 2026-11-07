import type { DomainError } from '../src/errors';
import { B1_DEFAULTS } from '../src/gov-b1-policy';
import { assertDisbursementAllowed, disbursementVerdict } from '../src/pay-disbursement-precondition';
import type { DisbursementFacts } from '../src/pay-disbursement-precondition';

const policy = B1_DEFAULTS.DISBURSEMENT_PRECONDITION;
const facts = (over: Partial<DisbursementFacts> = {}): DisbursementFacts => ({ projectId: 'p1', projectCode: 'DA-01', projectStatus: 'IMPLEMENTATION', allocatedVnd: '5000000000', reappraisalOpen: false, ...over });

function refusal(work: () => unknown): DomainError {
  try {
    work();
  } catch (error) {
    return error as DomainError;
  }
  throw new Error('expected a refusal');
}

describe('the precondition of a disbursement (G1-2)', () => {
  it('lets a listed project with an approved plan amount be paid', () => {
    expect(disbursementVerdict(facts(), policy)).toEqual({ allowed: true, refusal: null, cause: { projectStatus: 'IMPLEMENTATION', allocatedVnd: '5000000000' }, fix: null, warnings: [] });
    expect(assertDisbursementAllowed(facts(), policy)).toEqual([]);
  });

  it.each(['CONCEPT', 'APPRAISAL', 'REJECTED', 'CANCELLED', 'CLOSED'])('refuses a project in the stage %s as not on the list, naming the stage and the way to fix it', (status) => {
    const error = refusal(() => assertDisbursementAllowed(facts({ projectStatus: status }), policy));
    expect(error.code).toBe('DISBURSEMENT_PROJECT_NOT_LISTED');
    expect(error.status).toBe(422);
    expect(error.extensions).toMatchObject({ project_status: status, project_code: 'DA-01', fix: 'COMPLETE_STAGE_TRANSITION' });
  });

  it.each(['PIPELINE', 'BUDGETED', 'IMPLEMENTATION', 'SUSPENDED', 'COMPLETED', 'SETTLED'])('does not refuse the stage %s on the list', (status) => {
    expect(disbursementVerdict(facts({ projectStatus: status }), policy).allowed).toBe(true);
  });

  it('refuses a listed project that holds no approved amount on the system, with the amount it holds', () => {
    const error = refusal(() => assertDisbursementAllowed(facts({ allocatedVnd: '0' }), policy));
    expect(error.code).toBe('DISBURSEMENT_NO_APPROVED_PLAN');
    expect(error.extensions).toMatchObject({ allocated_vnd: '0', fix: 'ENTER_APPROVED_PLAN' });
  });

  it('names the stage first when both causes hold: the project must be listed before its plan matters', () => {
    expect(disbursementVerdict(facts({ projectStatus: 'CONCEPT', allocatedVnd: '0' }), policy).refusal).toBe('DISBURSEMENT_PROJECT_NOT_LISTED');
  });

  it('leaves the plan unchecked when the policy does not require an approved plan', () => {
    expect(disbursementVerdict(facts({ allocatedVnd: '0' }), { ...policy, requireApprovedPlan: false }).allowed).toBe(true);
  });

  it('follows the stages of the policy, not a list in the code', () => {
    expect(disbursementVerdict(facts({ projectStatus: 'SUSPENDED' }), { ...policy, unlistedStatuses: ['SUSPENDED'] }).refusal).toBe('DISBURSEMENT_PROJECT_NOT_LISTED');
  });

  it('warns about an open re-appraisal without stopping the payment', () => {
    expect(assertDisbursementAllowed(facts({ reappraisalOpen: true }), policy)).toEqual(['REAPPRAISAL_OPEN']);
  });
});
