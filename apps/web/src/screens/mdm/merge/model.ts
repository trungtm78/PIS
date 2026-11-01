import { ApiError } from '@machvon/api-client';

export const MERGE_PERMISSION = 'master.merge';
export const RULE_MANAGE_PERMISSION = 'master.survivorship.manage';
export const RULE_APPROVE_PERMISSION = 'master.survivorship.approve';

export const STRATEGIES = ['SOURCE_PRIORITY', 'MOST_RECENT', 'MOST_COMPLETE', 'STEWARD_DECISION'] as const;
export type Strategy = (typeof STRATEGIES)[number];
const RULE_STATUSES = ['DRAFT', 'PUBLISHED', 'RETIRED'] as const;
export type RuleStatus = (typeof RULE_STATUSES)[number];
const MERGE_STATUSES = ['APPLIED', 'REVERTED'] as const;
export type MergeStatus = (typeof MERGE_STATUSES)[number];
export type Side = 'SURVIVOR' | 'MERGED';
const SIDES: readonly string[] = ['SURVIVOR', 'MERGED'];
export type DecisionBy = 'ONLY_ONE' | 'EQUAL' | 'RULE' | 'OVERRIDE';
const DECISION_BY: readonly string[] = ['ONLY_ONE', 'EQUAL', 'RULE', 'OVERRIDE'];

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const pick = <T extends string>(list: readonly T[], value: unknown): T | undefined => list.find((candidate) => candidate === value);

export interface Rule {
  id: string;
  masterType: string;
  attribute: string;
  strategy: Strategy;
  sources: string[];
  revision: number;
  status: RuleStatus;
  effectiveFrom: string;
  version: number;
}

export function toRule(raw: unknown): Rule | undefined {
  if (
    !isRecord(raw) ||
    typeof raw.id !== 'string' ||
    typeof raw.master_type !== 'string' ||
    typeof raw.attribute_name !== 'string' ||
    typeof raw.revision !== 'number' ||
    typeof raw.version !== 'number'
  )
    return undefined;
  const strategy = pick(STRATEGIES, raw.strategy);
  const status = pick(RULE_STATUSES, raw.status);
  if (strategy === undefined || status === undefined || typeof raw.effective_from !== 'string') return undefined;
  return {
    id: raw.id,
    masterType: raw.master_type,
    attribute: raw.attribute_name,
    strategy,
    sources: Array.isArray(raw.source_priority) ? raw.source_priority.filter((source): source is string => typeof source === 'string') : [],
    revision: raw.revision,
    status,
    effectiveFrom: raw.effective_from,
    version: raw.version,
  };
}

export interface Decision {
  attribute: string;
  chosen: Side;
  by: DecisionBy;
  strategy: Strategy | null;
  source: string | null;
}

export interface Merge {
  id: string;
  survivorId: string;
  survivorKey: string;
  mergedId: string;
  mergedKey: string;
  mergedLabel: string | null;
  masterType: string;
  decisions: Decision[];
  repointed: number;
  reason: string;
  status: MergeStatus;
  appliedAt: string;
  revertedAt: string | null;
  revertReason: string | null;
  version: number;
}

function toDecision(raw: unknown): Decision[] {
  if (!isRecord(raw) || typeof raw.attribute !== 'string' || !SIDES.includes(raw.chosen as string) || !DECISION_BY.includes(raw.by as string)) return [];
  return [{ attribute: raw.attribute, chosen: raw.chosen as Side, by: raw.by as DecisionBy, strategy: pick(STRATEGIES, raw.strategy) ?? null, source: text(raw.source) }];
}

export function toMerge(raw: unknown): Merge | undefined {
  if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.survivor_record_id !== 'string' || typeof raw.merged_record_id !== 'string' || typeof raw.version !== 'number') return undefined;
  const status = pick(MERGE_STATUSES, raw.status);
  if (
    status === undefined ||
    typeof raw.survivor_key !== 'string' ||
    typeof raw.merged_key !== 'string' ||
    typeof raw.master_type !== 'string' ||
    typeof raw.reason !== 'string' ||
    typeof raw.applied_at !== 'string'
  )
    return undefined;
  return {
    id: raw.id,
    survivorId: raw.survivor_record_id,
    survivorKey: raw.survivor_key,
    mergedId: raw.merged_record_id,
    mergedKey: raw.merged_key,
    mergedLabel: isRecord(raw.aliases) ? text(raw.aliases.merged_label) : null,
    masterType: raw.master_type,
    decisions: Array.isArray(raw.decisions) ? raw.decisions.flatMap(toDecision) : [],
    repointed: Array.isArray(raw.repointed) ? raw.repointed.length : 0,
    reason: raw.reason,
    status,
    appliedAt: raw.applied_at,
    revertedAt: text(raw.reverted_at),
    revertReason: text(raw.revert_reason),
    version: raw.version,
  };
}

// --- the rules ---------------------------------------------------------------------------------------------------------------------------------

export interface RuleForm {
  masterType: string;
  attribute: string;
  strategy: Strategy;
  sources: string[];
  effectiveFrom: string;
}

export type RuleField = keyof RuleForm;
export type FormProblem = 'required' | 'invalid';
export const EMPTY_RULE: RuleForm = { masterType: '', attribute: '', strategy: 'SOURCE_PRIORITY', sources: [], effectiveFrom: '' };

/** Whether a strategy uses an order of sources: SOURCE_PRIORITY needs one, MOST_COMPLETE may use one to break a tie, the others use none. */
export const usesSources = (strategy: Strategy): boolean => strategy === 'SOURCE_PRIORITY' || strategy === 'MOST_COMPLETE';

export const isDay = (value: string): boolean => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return false;
  const parsed = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};

export function validateRule(form: RuleForm): Partial<Record<RuleField, FormProblem>> {
  const problems: Partial<Record<RuleField, FormProblem>> = {};
  if (form.masterType.trim() === '') problems.masterType = 'required';
  else if (form.masterType.trim().length > 50) problems.masterType = 'invalid';
  if (form.attribute.trim() === '') problems.attribute = 'required';
  else if (form.attribute.trim().length > 100) problems.attribute = 'invalid';
  if (form.strategy === 'SOURCE_PRIORITY' && form.sources.length === 0) problems.sources = 'required';
  if (form.sources.length > 50) problems.sources = 'invalid';
  if (form.effectiveFrom === '') problems.effectiveFrom = 'required';
  else if (!isDay(form.effectiveFrom)) problems.effectiveFrom = 'invalid';
  return problems;
}

export function ruleBody(form: RuleForm): Record<string, unknown> {
  return {
    master_type: form.masterType.trim(),
    attribute_name: form.attribute.trim(),
    strategy: form.strategy,
    ...(usesSources(form.strategy) && form.sources.length > 0 ? { source_priority: form.sources } : {}),
    effective_from: form.effectiveFrom,
  };
}

/** The order of sources after one is moved a place up or down (a move off either end changes nothing). */
export function moveSource(sources: readonly string[], index: number, by: -1 | 1): string[] {
  const target = index + by;
  if (index < 0 || index >= sources.length || target < 0 || target >= sources.length) return [...sources];
  const next = [...sources];
  [next[index], next[target]] = [next[target] as string, next[index] as string];
  return next;
}

/** A source added to the end of the order: not empty, not twice. */
export function addSource(sources: readonly string[], name: string): string[] {
  const trimmed = name.trim();
  return trimmed === '' || sources.includes(trimmed) ? [...sources] : [...sources, trimmed];
}

// --- the merge ---------------------------------------------------------------------------------------------------------------------------------

export interface MergeForm {
  survivorId: string;
  mergedId: string;
  reason: string;
}

export type MergeField = keyof MergeForm;
export const EMPTY_MERGE: MergeForm = { survivorId: '', mergedId: '', reason: '' };

export function validateMerge(form: MergeForm): Partial<Record<MergeField, FormProblem>> {
  const problems: Partial<Record<MergeField, FormProblem>> = {};
  if (form.survivorId === '') problems.survivorId = 'required';
  if (form.mergedId === '') problems.mergedId = 'required';
  else if (form.mergedId === form.survivorId) problems.mergedId = 'invalid';
  const reason = form.reason.trim();
  if (reason === '') problems.reason = 'required';
  else if (reason.length < 10 || reason.length > 2000) problems.reason = 'invalid';
  return problems;
}

/** What the steward chose for the attributes the rules could not settle: the side to take for each. */
export type Overrides = Record<string, Side>;

export function mergeBody(form: MergeForm, overrides: Overrides): Record<string, unknown> {
  return { merged_record_id: form.mergedId, reason: form.reason.trim(), ...(Object.keys(overrides).length === 0 ? {} : { survivorship_overrides: overrides }) };
}

export type UnmergeAnswer = 'KEEP' | 'REVERT';

export function unmergeBody(reason: string, answers: Record<string, UnmergeAnswer>): Record<string, unknown> {
  return { reason: reason.trim(), ...(Object.keys(answers).length === 0 ? {} : { steward_decisions: answers }) };
}

// --- refusals ----------------------------------------------------------------------------------------------------------------------------------

export type MergeReason = 'conflict' | 'unmergeConflict' | 'alreadyReverted' | 'locked' | 'self' | 'scope' | 'stale' | 'state' | 'notFound' | 'validation' | 'general';

const REASON_BY_CODE: Readonly<Record<string, MergeReason>> = {
  MERGE_CONFLICT: 'conflict',
  UNMERGE_CONFLICT: 'unmergeConflict',
  MERGE_ALREADY_REVERTED: 'alreadyReverted',
  POLICY_LOCKED: 'locked',
  SELF_APPROVAL_DENIED: 'self',
  SCOPE_DENIED: 'scope',
  VERSION_CONFLICT: 'stale',
  STAGE_TRANSITION_DENIED: 'state',
  RESOURCE_NOT_FOUND: 'notFound',
  VALIDATION_FAILED: 'validation',
};

export interface MergeProblem {
  reason: MergeReason;
  detail: string;
  /** The attributes that a conflict names. */
  attributes: string[];
}

export function describeMergeProblem(error: unknown): MergeProblem {
  if (!(error instanceof ApiError)) return { reason: 'general', detail: '', attributes: [] };
  const named = error.extensions.attributes;
  return { reason: REASON_BY_CODE[error.code] ?? 'general', detail: error.detail ?? '', attributes: Array.isArray(named) ? named.filter((item): item is string => typeof item === 'string') : [] };
}
