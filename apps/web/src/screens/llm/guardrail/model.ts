import { CLASSIFICATIONS, ROUTES } from '../llm-model';
import type { Classification, Route } from '../llm-model';
import type { RequestEntry } from '../gateway-model';
import { isGuardrail, matches } from '../trace/model';

/** LLM-15: the guardrails of the AI gateway and the data they hold to (ST-LLM-009, LLM F1, BR-LLM-11, UAT-AC466): what every request is held to, what each published profile may use and keep, the routes each class of data may take, and the requests a guardrail refused with the rule that did. */
export const PROFILE_READ_PERMISSION = 'model_profile_version.read';
export const POLICY_READ_PERMISSION = 'llm.policy.read';

export interface GuardProfile {
  id: string;
  taskType: string;
  revision: number;
  modelId: string;
  tools: string[];
  routes: Route[];
  maxClassification: Classification | null;
  retentionDays: number | null;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []);

/** A profile that is in force, as far as the guardrails are concerned; a profile that is not published, or that cannot be read, is left out. */
export function toGuardProfile(raw: unknown): GuardProfile | undefined {
  const row = asRecord(raw);
  const id = text(row?.id);
  const taskType = text(row?.task_type);
  if (row === undefined || id === undefined || taskType === undefined || row.status !== 'PUBLISHED' || typeof row.revision !== 'number') return undefined;
  const policy = asRecord(row.routing_policy);
  const days = row.retention_days;
  return {
    id,
    taskType,
    revision: row.revision,
    modelId: text(row.model_id) ?? '',
    tools: strings(row.tool_allowlist),
    routes: ROUTES.filter((route) => strings(policy?.routes).includes(route)),
    maxClassification: CLASSIFICATIONS.find((level) => level === row.max_classification) ?? null,
    retentionDays: typeof days === 'number' && Number.isInteger(days) ? days : null,
  };
}

/** The requests that a guardrail refused, the latest first, narrowed to the ones that match the words typed. */
export function refusals(entries: readonly RequestEntry[], words: string): RequestEntry[] {
  return entries.filter((entry) => isGuardrail(entry) && matches(entry, words)).sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id));
}
