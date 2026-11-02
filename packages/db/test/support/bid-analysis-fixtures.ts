import { randomUUID } from 'node:crypto';
import { TENANT_A, id, memberId } from './authz-fixtures';
import type { AuthzHarness } from './authz-fixtures';
import { seedAs } from './bid-proposal-fixtures';

const FAMILY = 0x9a;

export interface SeededCriteria {
  id: string;
}

/** A version of criteria of a package, as the planner and the approver would have left it (the statements are written past the triggers so a test starts from any status). */
export async function seedCriteria(harness: AuthzHarness, packageId: string, options: { status?: string; codes?: string[]; revision?: number } = {}): Promise<SeededCriteria> {
  const criteriaId = randomUUID();
  const codes = options.codes ?? ['C1', 'C2'];
  // As the planner stores them: the first is pass or fail, the others are scored with a weight, a scale and a threshold.
  const criteria = codes.map((code, position) => ({
    code,
    name: `Criterion ${code}`,
    kind: position === 0 ? 'PASS_FAIL' : 'SCORED',
    weight: position === 0 ? null : 40,
    max_score: position === 0 ? null : 10,
    threshold: position === 0 ? null : 6,
    mandatory: code === codes[0],
    required_evidence: ['A contract list'],
  }));
  const status = options.status ?? 'APPROVED';
  await seedAs(harness, [
    // One version of a package is in force at a time: the one that was approved is superseded.
    ["update machvon.criteria_version set status = 'SUPERSEDED' where package_id = $1 and status = 'APPROVED' and $2::text = 'APPROVED'", [packageId, status]],
    [
      `insert into machvon.criteria_version (tenant_id, id, package_id, revision, criteria_json, legal_basis, weights_sum, status, approved_by, effective_at, created_by, version)
       values ($1, $2, $3, $4, $5::jsonb, 'Test legal basis', null, $6, $7, $8::timestamptz, $9, 1)`,
      [TENANT_A, criteriaId, packageId, options.revision ?? 1, JSON.stringify({ criteria }), status, status === 'APPROVED' ? memberId(2) : null, status === 'APPROVED' ? new Date().toISOString() : null, memberId(1)],
    ],
  ]);
  return { id: criteriaId };
}

export interface SeededProfile {
  id: string;
  promptVersionId: string;
}

/** A profile of the task of the analysis (the task type the module names) with its prompt, PUBLISHED unless the options say otherwise. */
export async function seedAnalysisProfile(
  harness: AuthzHarness,
  options: { status?: string; taskType?: string; tools?: string[]; maxInputTokens?: number | null; withPrompt?: boolean } = {},
): Promise<SeededProfile> {
  const profileId = randomUUID();
  const promptId = randomUUID();
  const status = options.status ?? 'PUBLISHED';
  const taskType = options.taskType ?? 'BID_ANALYSIS';
  await seedAs(harness, [
    // Only one profile of a task is published at a time: the one that was in force is retired.
    ["update machvon.model_profile_version set status = 'RETIRED' where task_type = $1 and status = 'PUBLISHED' and $2::text = 'PUBLISHED'", [taskType, status]],
    [
      `insert into machvon.ai_prompt_version (tenant_id, id, task_type, name, revision, template_object_key, template_sha256, input_schema, output_schema, status, approved_by, created_by, updated_by)
       values ($1, $2, $3, 'analysis', $4, 'tenants/t/prompts/analysis.txt', repeat('c', 64), '{}'::jsonb, '{}'::jsonb, 'APPROVED', $5, $6, $6)`,
      [TENANT_A, promptId, taskType, Math.floor(Math.random() * 1_000_000) + 1, memberId(2), memberId(1)],
    ],
    [
      `insert into machvon.model_profile_version (tenant_id, id, task_type, revision, model_id, output_cap, routing_policy, status, allowed_model_ids, max_input_tokens, timeout_ms, concurrency_limit, output_schema, tool_allowlist,
         max_classification, prompt_version_id, retention_days, created_by)
       values ($1, $2, $3, $4, 'dom-model', 1000, '{"routes":["DOMESTIC_HOSTED","SELF_HOSTED"],"thresholds":{}}'::jsonb, $5, '[]'::jsonb, $6, 30000, 4, $7::jsonb, $8::jsonb, 'IMPORTANT_CORE', $9, 90, $10)`,
      [
        TENANT_A,
        profileId,
        taskType,
        Math.floor(Math.random() * 1_000_000) + 1,
        status,
        options.maxInputTokens === undefined ? 8000 : options.maxInputTokens,
        JSON.stringify({ type: 'object', properties: { findings: { type: 'array' }, citations: { type: 'array' } }, required: ['findings', 'citations'] }),
        JSON.stringify(options.tools ?? ['search_documents', 'read_document']),
        options.withPrompt === false ? null : promptId,
        memberId(1),
      ],
    ],
  ]);
  return { id: profileId, promptVersionId: promptId };
}

/** A request at the gateway as it stands when a run has been answered (written past the triggers): the run points at it. */
export async function seedAiRequest(harness: AuthzHarness, options: { status?: string; route?: string | null; rejectCode?: string | null; cost?: string; classification?: string } = {}): Promise<string> {
  const requestId = randomUUID();
  await seedAs(harness, [
    [
      `insert into machvon.ai_request (tenant_id, id, task_type, subject_module, requested_by, profile_version_id, data_classification, classification_basis, policy_version_id, route_class, status, reject_code, input_sha256, cost_vnd, created_by, updated_by)
       values ($1, $2, 'BID_ANALYSIS', 'BID', $3, $4, $5, '[]'::jsonb, $6, $7, $8, $9, repeat('d', 64), $10::numeric, $3, $3)`,
      [
        TENANT_A,
        requestId,
        memberId(1),
        randomUUID(),
        options.classification ?? 'CONFIDENTIAL',
        id(FAMILY, 1),
        options.route === undefined ? 'DOMESTIC_HOSTED' : options.route,
        options.status ?? 'COMPLETED',
        options.rejectCode ?? null,
        options.cost ?? '1500',
      ],
    ],
  ]);
  return requestId;
}
