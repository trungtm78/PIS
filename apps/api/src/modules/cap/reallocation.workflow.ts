import { randomUUID } from 'node:crypto';
import { AuditWriter, enqueueOutbox } from '@machvon/db';
import type { TenantDatabase } from '@machvon/db';
import { DomainError, asUuid } from '@machvon/kernel';
import type { EffectiveAccess, SignalRequest, TenantContext, WorkflowDefinition } from '@machvon/kernel';
import type { StepScope } from './plan-approval.service';
import { ReallocationApprovalService } from './reallocation.service';
import type { ReallocationStepResult } from './reallocation.service';

export const CAPITAL_REALLOCATION_WORKFLOW = 'capital-reallocation-approval';

/** The states of the approval of one reallocation proposal; `applied` and `rejected` end the instance. */
export const REALLOCATION_STATES = { drafting: 'drafting', inReview: 'in-review', approved: 'approved', applied: 'applied', rejected: 'rejected' } as const;

export interface ReallocationWorkflowDeps {
  database: TenantDatabase;
  /** The grants of the person the signed context names: the activities judge the unit of the proposal against them exactly as the commands do. */
  access: (context: TenantContext) => Promise<EffectiveAccess>;
}

/** What a signal of the workflow carries. The proposal is the one the instance was started for; the tenant and the person come from the signed context only. */
interface SignalCall {
  proposalId: string;
  expectedVersion: number;
  reason: string;
  decisionDocumentId: string;
}

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

function callOf(request: SignalRequest): SignalCall {
  const input = request.input as { proposal_id?: unknown } | null;
  const payload = (request.payload ?? {}) as Record<string, unknown>;
  const proposalId = asUuid(input?.proposal_id);
  if (proposalId === undefined || asUuid(payload.proposal_id) !== proposalId) throw invalid('proposal_id');
  const expectedVersion = payload.expected_version;
  if (typeof expectedVersion !== 'number' || !Number.isInteger(expectedVersion) || expectedVersion < 1) throw invalid('expected_version');
  return {
    proposalId,
    expectedVersion,
    reason: typeof payload.reason === 'string' ? payload.reason : '',
    decisionDocumentId: typeof payload.decision_document_id === 'string' ? payload.decision_document_id : '',
  };
}

/**
 * The approval of a reallocation proposal as a workflow (ST-CAP-010, NFR-OPERABILITY-04): drafting, in review, approved, applied or rejected. An instance follows the version of the definition it started on, so
 * a newer version of the approval (one more level, say) changes the proposals that start after it and none that are already under way. Every activity runs in the tenant of the signed context its signal carried
 * and calls the same step as the command does, so the domain guard stays the judge of each decision: the author or the submitter who signals `approve` or `apply` is refused 403 SELF_APPROVAL_DENIED, whatever the
 * workflow allows, and the instance keeps waiting where it was. The database stays the authority of the state: the workflow engine only orders the signals.
 */
export function capitalReallocationWorkflow(deps: ReallocationWorkflowDeps): WorkflowDefinition {
  const service = new ReallocationApprovalService();
  const audit = new AuditWriter(deps.database);

  const activity =
    (work: (step: StepScope, access: EffectiveAccess, call: SignalCall) => Promise<ReallocationStepResult>) =>
    async (request: SignalRequest): Promise<void> => {
      const call = callOf(request);
      const access = await deps.access(request.context);
      await deps.database.withTenant(request.context, async (tx) => {
        const correlationId = randomUUID();
        const step: StepScope = {
          tx,
          tenantId: request.context.tenantId,
          actorId: request.context.membershipId,
          audit: (entry) => audit.recordInTx(tx, request.context.membershipId, { ...entry, correlationId, requestId: randomUUID() }),
          emit: (event) => enqueueOutbox(tx, { ...event, correlationId }),
        };
        await work(step, access, call);
      });
    };

  const decision =
    (name: string) =>
    activity((step, access, call) => service.decide(step, access, call.proposalId, call.expectedVersion, { decision: name, reason: call.reason }));

  return {
    name: CAPITAL_REALLOCATION_WORKFLOW,
    version: 1,
    initialState: REALLOCATION_STATES.drafting,
    terminalStates: [REALLOCATION_STATES.applied, REALLOCATION_STATES.rejected],
    transitions: [
      { from: REALLOCATION_STATES.drafting, signal: 'submit', to: REALLOCATION_STATES.inReview, activity: activity((step, access, call) => service.submit(step, access, call.proposalId, call.expectedVersion)) },
      { from: REALLOCATION_STATES.inReview, signal: 'approve', to: REALLOCATION_STATES.approved, activity: decision('approve') },
      { from: REALLOCATION_STATES.inReview, signal: 'return', to: REALLOCATION_STATES.drafting, activity: decision('return') },
      { from: REALLOCATION_STATES.inReview, signal: 'reject', to: REALLOCATION_STATES.rejected, activity: decision('reject') },
      {
        from: REALLOCATION_STATES.approved,
        signal: 'apply',
        to: REALLOCATION_STATES.applied,
        activity: activity((step, access, call) => service.apply(step, access, call.proposalId, call.expectedVersion, { decisionDocumentId: call.decisionDocumentId })),
      },
    ],
  };
}
