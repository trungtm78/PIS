import { randomUUID } from 'node:crypto';
import { AuditWriter, enqueueOutbox } from '@machvon/db';
import type { TenantDatabase } from '@machvon/db';
import { DomainError, NOOP_METRICS, asUuid } from '@machvon/kernel';
import type { EffectiveAccess, MetricsSink, SignalRequest, TenantContext, Transition, WorkflowDefinition } from '@machvon/kernel';
import { CapitalPlanApprovalService } from './plan-approval.service';
import type { StepResult, StepScope } from './plan-approval.service';

export const CAPITAL_PLAN_APPROVAL_WORKFLOW = 'capital-plan-approval';

/** The states of the approval of one plan revision; `published` and `rejected` end the instance. */
export const APPROVAL_STATES = { drafting: 'drafting', inReview: 'in-review', approved: 'approved', published: 'published', rejected: 'rejected' } as const;

export interface ApprovalWorkflowDeps {
  database: TenantDatabase;
  /** The grants of the person the signed context names: the activities judge the unit of the plan against them exactly as the commands do. */
  access: (context: TenantContext) => Promise<EffectiveAccess>;
  metrics?: MetricsSink;
}

/** What a signal of the workflow carries. The plan is the one the instance was started for; the tenant and the person come from the signed context only. */
interface SignalCall {
  planId: string;
  expectedVersion: number;
  reason: string;
  decisionDocumentId: string;
  effectiveAt: string | undefined;
}

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

function callOf(request: SignalRequest): SignalCall {
  const input = request.input as { plan_id?: unknown } | null;
  const payload = (request.payload ?? {}) as Record<string, unknown>;
  const planId = asUuid(input?.plan_id);
  if (planId === undefined || asUuid(payload.plan_id) !== planId) throw invalid('plan_id');
  const expectedVersion = payload.expected_version;
  if (typeof expectedVersion !== 'number' || !Number.isInteger(expectedVersion) || expectedVersion < 1) throw invalid('expected_version');
  return {
    planId,
    expectedVersion,
    reason: typeof payload.reason === 'string' ? payload.reason : '',
    decisionDocumentId: typeof payload.decision_document_id === 'string' ? payload.decision_document_id : '',
    effectiveAt: typeof payload.effective_at === 'string' ? payload.effective_at : undefined,
  };
}

/**
 * The approval of a capital plan revision as a workflow (ST-CAP-003, NFR-TENANCY-08): drafting, in review, approved, published or rejected. Every
 * activity runs in the tenant of the signed context the signal carried: the instance of another tenant is not found, a context that does not verify
 * is refused before anything is read, and the person is the one the context names. The activities are the steps of the commands
 * (`CapitalPlanApprovalService`), so a plan moved by the workflow leaves the same audit rows, events, ledger entries and balances as one moved by
 * the API. The database stays the authority of the state: the workflow engine only orders the signals.
 */
export function capitalPlanApprovalWorkflow(deps: ApprovalWorkflowDeps): WorkflowDefinition {
  const service = new CapitalPlanApprovalService(deps.metrics ?? NOOP_METRICS);
  const audit = new AuditWriter(deps.database);

  const activity =
    (work: (step: StepScope, access: EffectiveAccess, call: SignalCall) => Promise<StepResult>) =>
    async (request: SignalRequest): Promise<void> => {
      const call = callOf(request);
      const access = await deps.access(request.context);
      await deps.database.withTenant(request.context, (tx) => {
        const correlationId = randomUUID();
        const step: StepScope = {
          tx,
          tenantId: request.context.tenantId,
          actorId: request.context.membershipId,
          audit: (entry) => audit.recordInTx(tx, request.context.membershipId, { ...entry, correlationId, requestId: randomUUID() }),
          emit: (event) => enqueueOutbox(tx, { ...event, correlationId }),
        };
        return work(step, access, call);
      });
    };

  const decision =
    (name: string): Transition['activity'] =>
    activity((step, access, call) => service.decide(step, access, call.planId, call.expectedVersion, { decision: name, reason: call.reason }));

  return {
    name: CAPITAL_PLAN_APPROVAL_WORKFLOW,
    version: 1,
    initialState: APPROVAL_STATES.drafting,
    terminalStates: [APPROVAL_STATES.published, APPROVAL_STATES.rejected],
    transitions: [
      { from: APPROVAL_STATES.drafting, signal: 'submit', to: APPROVAL_STATES.inReview, activity: activity((step, access, call) => service.submit(step, access, call.planId, call.expectedVersion)) },
      { from: APPROVAL_STATES.inReview, signal: 'approve', to: APPROVAL_STATES.approved, activity: decision('approve') },
      { from: APPROVAL_STATES.inReview, signal: 'return', to: APPROVAL_STATES.drafting, activity: decision('return') },
      { from: APPROVAL_STATES.inReview, signal: 'reject', to: APPROVAL_STATES.rejected, activity: decision('reject') },
      {
        from: APPROVAL_STATES.approved,
        signal: 'publish',
        to: APPROVAL_STATES.published,
        activity: activity((step, access, call) => service.publish(step, access, call.planId, call.expectedVersion, { decisionDocumentId: call.decisionDocumentId, effectiveAt: call.effectiveAt })),
      },
    ],
  };
}
