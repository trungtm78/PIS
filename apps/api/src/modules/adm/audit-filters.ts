import { DomainError, asUuid } from '@machvon/kernel';

const OUTCOMES: ReadonlySet<string> = new Set(['SUCCESS', 'DENIED', 'FAILED']);
const MAX_TEXT = 200;
// A full ISO 8601 instant with a zone: a bare date or a local time would silently depend on the server's clock zone.
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/;

/** What the audit viewer narrows the trail by (ADM-11): every member is optional and all given are combined with AND. */
export interface AuditFilter {
  actorId?: string;
  action?: string;
  resourceType?: string;
  resourceId?: string;
  outcome?: string;
  /** Inclusive. */
  from?: string;
  /** Exclusive. */
  to?: string;
}

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

function textOf(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '' || value.length > MAX_TEXT || value.includes('\0')) throw invalid(field);
  return value;
}

function uuidOf(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  const uuid = asUuid(value);
  if (uuid === undefined) throw invalid(field);
  return uuid;
}

export function instantOf(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !INSTANT.test(value) || Number.isNaN(Date.parse(value))) throw invalid(field);
  return new Date(value).toISOString();
}

/** Validates the filter parameters of the audit read; anything malformed or repeated is a 422 naming the parameter. */
export function parseAuditFilter(query: Record<string, unknown>): AuditFilter {
  const filter: AuditFilter = {};
  const actorId = uuidOf(query.actor_id, 'actor_id');
  const resourceId = uuidOf(query.resource_id, 'resource_id');
  const action = textOf(query.action, 'action');
  const resourceType = textOf(query.resource_type, 'resource_type');
  const outcome = textOf(query.outcome, 'outcome');
  if (outcome !== undefined && !OUTCOMES.has(outcome)) throw invalid('outcome');
  const from = instantOf(query.from, 'from');
  const to = instantOf(query.to, 'to');
  if (from !== undefined && to !== undefined && Date.parse(to) <= Date.parse(from)) throw invalid('to');
  if (actorId !== undefined) filter.actorId = actorId;
  if (action !== undefined) filter.action = action;
  if (resourceType !== undefined) filter.resourceType = resourceType;
  if (resourceId !== undefined) filter.resourceId = resourceId;
  if (outcome !== undefined) filter.outcome = outcome;
  if (from !== undefined) filter.from = from;
  if (to !== undefined) filter.to = to;
  return filter;
}

/** The SQL conditions of a filter on table alias `e`, numbering its parameters from `firstIndex`; the parameters are returned in order. */
export function auditFilterSql(filter: AuditFilter, firstIndex: number): { sql: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  const add = (clause: (index: number) => string, value: unknown): void => {
    params.push(value);
    clauses.push(clause(firstIndex + params.length - 1));
  };
  if (filter.actorId !== undefined) add((i) => `e.actor_id = $${i}::uuid`, filter.actorId);
  if (filter.action !== undefined) add((i) => `e.action = $${i}::text`, filter.action);
  if (filter.resourceType !== undefined) add((i) => `e.resource_type = $${i}::text`, filter.resourceType);
  if (filter.resourceId !== undefined) add((i) => `e.resource_id = $${i}::uuid`, filter.resourceId);
  if (filter.outcome !== undefined) add((i) => `e.outcome = $${i}::text`, filter.outcome);
  if (filter.from !== undefined) add((i) => `e.occurred_at >= $${i}::timestamptz`, filter.from);
  if (filter.to !== undefined) add((i) => `e.occurred_at < $${i}::timestamptz`, filter.to);
  return { sql: clauses.length === 0 ? 'true' : clauses.join(' and '), params };
}
