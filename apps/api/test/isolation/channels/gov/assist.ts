import type { Client } from 'pg';
import type { ForeignAttemptSpec } from '../api';
import { LLM_FIXTURES } from '../../suite';
import { ASSIST_FIXTURES } from './assist.fixtures';
import type { SeedContext } from './support';

const FOREIGN = 'TNT-B';
const foreign = ASSIST_FIXTURES[FOREIGN];
const providerId = LLM_FIXTURES[FOREIGN].providerId;

/**
 * The foreign-id cases of the AI assistant (AI-2): a TNT-A user names a run, a checklist, a set of criteria, an exception or a provider of TNT-B. The bodies are valid, so that the request reaches the lookup, and
 * every command has an object of its own that the control run of the owner does not take away from another case.
 */
export const ASSIST_SPECS: readonly ForeignAttemptSpec[] = [
  { operation: 'getAiAssistRun', method: 'GET', id: foreign.runId },
  { operation: 'decideAiAssistRun', method: 'POST', id: foreign.runId, body: { decision: 'REJECTED', rationale: 'Isolation foreign decision of a run of the assistant' } },
  { operation: 'getAiReviewChecklist', method: 'GET', id: foreign.checklistId },
  { operation: 'publishAiReviewChecklist', method: 'POST', id: foreign.checklistId, versioned: true, body: {} },
  { operation: 'getAiEvalCriteriaSet', method: 'GET', id: foreign.criteriaSetId },
  { operation: 'publishAiEvalCriteriaSet', method: 'POST', id: foreign.criteriaSetId, versioned: true, body: {} },
  { operation: 'attestAiProvider', method: 'POST', id: providerId, versioned: true, body: { data_location_country: 'VN', no_training_attested: true, attestation_ref: 'DPA-ISOLATION' } },
  { operation: 'getAiExternalException', method: 'GET', id: foreign.exceptionId },
  { operation: 'decideAiExternalException', method: 'POST', id: foreign.exceptionId, versioned: true, body: { decision: 'REJECT', note: 'Isolation foreign decision of an exception' } },
  { operation: 'revokeAiExternalException', method: 'POST', id: foreign.exceptionId, versioned: true, body: { reason: 'Isolation foreign revocation of an exception' } },
];

/** Every operation of the assistant controllers: the suite principal holds the permission of each. */
export const ASSIST_OPERATIONS: readonly string[] = [
  'createAiAssistRun',
  'listAiAssistRuns',
  'getAiAssistRun',
  'decideAiAssistRun',
  'createAiReviewChecklist',
  'publishAiReviewChecklist',
  'listAiReviewChecklists',
  'getAiReviewChecklist',
  'createAiEvalCriteriaSet',
  'publishAiEvalCriteriaSet',
  'listAiEvalCriteriaSets',
  'getAiEvalCriteriaSet',
  'attestAiProvider',
  'requestAiExternalException',
  'decideAiExternalException',
  'revokeAiExternalException',
  'listAiExternalExceptions',
  'getAiExternalException',
  'getAiEditionPolicy',
];

/** The tables the seed fills that the snapshot reads. */
export const ASSIST_SNAPSHOT_TABLES: readonly string[] = ['ai_assist_run', 'ai_assist_decision', 'ai_review_checklist', 'ai_review_checklist_item', 'ai_eval_criteria_set', 'ai_eval_criterion', 'ai_external_exception', 'ai_external_exception_use'];

const INSERT_RUN = `insert into machvon.ai_assist_run (tenant_id, id, kind, request_text, source_refs, status, asked_by)
  values ($1, $2, 'QA', $3, '[{"kind":"PROJECT","id":"00000000-0000-4000-8000-000000000001"}]'::jsonb, 'COMPLETED', $4) on conflict do nothing`;
const INSERT_CHECKLIST = `insert into machvon.ai_review_checklist (tenant_id, id, code, revision, title, applies_to, status, created_by)
  values ($1, $2, 'ISO-CHECKLIST', 1, $3, 'DIS_REPORT', 'DRAFT', $4) on conflict do nothing`;
const INSERT_CRITERIA = `insert into machvon.ai_eval_criteria_set (tenant_id, id, code, revision, title, scale_max, status, created_by)
  values ($1, $2, 'ISO-CRITERIA', 1, $3, 100, 'DRAFT', $4) on conflict do nothing`;
const INSERT_EXCEPTION = `insert into machvon.ai_external_exception (tenant_id, id, provider_id, max_classification, reason, requested_by, requested_valid_days)
  values ($1, $2, $3, 'PUBLIC', $4, $5, 7) on conflict do nothing`;

/** Seeds a run, a draft checklist, a draft set of criteria and a request for an exception for the tenant of the context (the provider is the one of its AI registry). */
export async function seedAssist(client: Client, context: SeedContext): Promise<void> {
  const fixture = ASSIST_FIXTURES[context.tenant];
  await client.query(INSERT_RUN, [context.tenantId, fixture.runId, fixture.runQuestion, context.membershipId]);
  await client.query(INSERT_CHECKLIST, [context.tenantId, fixture.checklistId, fixture.checklistTitle, context.actorId]);
  await client.query(INSERT_CRITERIA, [context.tenantId, fixture.criteriaSetId, fixture.criteriaTitle, context.actorId]);
  await client.query(INSERT_EXCEPTION, [context.tenantId, fixture.exceptionId, LLM_FIXTURES[context.tenant].providerId, fixture.exceptionReason, context.actorId]);
}
