import { randomUUID } from 'node:crypto';
import { DomainError, asUuid } from '@machvon/kernel';
import { SCOPE_FROM } from './prj-project-store.ts';
import type { ProjectClassification, ProjectStatus } from './prj-project-store.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

/**
 * What the commands that move a project along its life cycle have in common (ST-PRJ-002 and ST-PRJ-003): the lock on the project inside the
 * scope of the command, the check of a document that grounds a decision, the reason and the date as they are stored, and the row of the history of
 * the stage. The transition table itself is `prj-stage-machine`.
 */

const MIN_REASON = 5;
const MAX_REASON = 2000;
/** A document that has been recalled, replaced or has expired is no ground for a decision; one still waiting to take effect or corrected is. */
const USABLE_DOCUMENT_STATUSES: readonly string[] = ['PENDING', 'EFFECTIVE', 'CORRECTED'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

/** The scopes a stage command is judged by: the one of its own permission decides, the one of `project.read` tells a refusal from a miss. */
export interface StageScopes {
  act: ScopeBuilder;
  read: ScopeBuilder;
}

/** The project as a command that moves it sees it, locked for update. */
export interface LockedProject {
  id: string;
  code: string;
  version: number;
  status: ProjectStatus;
  classification: ProjectClassification;
  projectGroup: string | null;
  nationalProjectCode: string | null;
  /** The member who created the project: with whoever sent it to appraisal, the proposer who neither scores nor decides on it. */
  createdBy: string | null;
  /** An exact decimal string in VND. */
  totalInvestmentVnd: string;
  /** The unit whose level decides on the project (PRJ 3.1 section 2); a decision on the project is the business of whoever holds the right on it. */
  decisionAuthorityUnitId: string | null;
}

export interface LockSql {
  id: string;
  code: string;
  version: string;
  status: ProjectStatus;
  classification: ProjectClassification;
  project_group: string | null;
  national_project_code: string | null;
  created_by: string | null;
  total_investment_vnd: string;
  decision_authority_unit_id: string | null;
}

/** The columns a command that locks a project reads. */
export const LOCK_COLUMNS = 'p.id, p.code, p.version::text as version, p.status, p.classification, p.project_group, p.national_project_code, p.created_by, p.total_investment_vnd::text as total_investment_vnd, p.decision_authority_unit_id';

export const lockedProjectOf = (row: LockSql): LockedProject => ({
  id: row.id,
  code: row.code,
  version: Number(row.version),
  status: row.status,
  classification: row.classification,
  projectGroup: row.project_group,
  nationalProjectCode: row.national_project_code,
  createdBy: row.created_by,
  totalInvestmentVnd: row.total_investment_vnd,
  decisionAuthorityUnitId: row.decision_authority_unit_id,
});

/** The reason as it is stored: trimmed, within its length, with line breaks but no other control character. */
export function reasonOf(value: string, field = 'reason'): string {
  const text = value.trim();
  // eslint-disable-next-line no-control-regex
  if (text.length < MIN_REASON || text.length > MAX_REASON || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) throw invalid(field);
  return text;
}

/** A calendar date as typed (`YYYY-MM-DD`); a value that is not a date is a fault of the request named by `field`. */
export function dateOf(value: string, field: string): string {
  const parsed = new Date(`${value}T00:00:00Z`);
  // A date that does not exist (the 30th of February) is read by the engine as a later one: only a date that reads back as typed is a date.
  if (!DATE.test(value) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw invalid(field);
  return value;
}

export function effectiveDateOf(value: string | undefined): string | null {
  return value === undefined ? null : dateOf(value, 'effective_date');
}

/**
 * Locks the project for update inside the scope of the command; a project the caller can read but not act on is a refusal (403 SCOPE_DENIED),
 * one that is out of sight does not exist (404).
 */
export async function lockProject(tx: TenantTx, id: string, scopes: StageScopes): Promise<LockedProject> {
  const predicate = scopes.act(2);
  const rows = await tx.query<LockSql>(`select ${LOCK_COLUMNS} from ${SCOPE_FROM} where p.id = $1::uuid and ${predicate.sql} for update of p`, [id, ...predicate.params]);
  const row = rows[0];
  if (row === undefined) {
    const readable = scopes.read(2);
    const seen = await tx.query<{ id: string }>(`select p.id from ${SCOPE_FROM} where p.id = $1::uuid and ${readable.sql}`, [id, ...readable.params]);
    throw seen[0] === undefined ? new DomainError('RESOURCE_NOT_FOUND', 404) : new DomainError('SCOPE_DENIED', 403);
  }
  return lockedProjectOf(row);
}

/** Whether the project lies in a scope: what tells a caller whether a move is theirs to make. */
export async function projectInScope(tx: TenantTx, projectId: string, scope: ScopeBuilder): Promise<boolean> {
  const predicate = scope(2);
  const rows = await tx.query<{ id: string }>(`select p.id from ${SCOPE_FROM} where p.id = $1::uuid and ${predicate.sql}`, [projectId, ...predicate.params]);
  return rows[0] !== undefined;
}

/**
 * A document of the tenant that can still ground a decision, as the lower-case id the database writes. A value that is not an id is a fault
 * of the request (422 VALIDATION_FAILED); a document of another tenant, one that does not exist and one that no longer stands are alike
 * DECISION_REQUIRED, so the answer does not tell which of them it is.
 */
export async function usableDocumentId(tx: TenantTx, given: string, apiField: string): Promise<string> {
  const id = asUuid(given);
  if (id === undefined) throw invalid(apiField);
  const rows = await tx.query<{ effect_status: string }>('select effect_status from machvon.document where id = $1::uuid', [id]);
  if (rows[0] === undefined || !USABLE_DOCUMENT_STATUSES.includes(rows[0].effect_status)) throw new DomainError('DECISION_REQUIRED', 422, apiField);
  return id;
}

export interface StageChangeRow {
  projectId: string;
  version: number;
  from: ProjectStatus;
  to: ProjectStatus;
  operation: string;
  actorKind: string;
  actorId: string;
  decisionDocumentId: string | null;
  reason: string | null;
  effectiveDate: string | null;
  sourceEventId: string | null;
}

/** Appends one move to the history of the stage of a project; the row is never changed or deleted. */
export async function recordStageChange(tx: TenantTx, row: StageChangeRow): Promise<void> {
  await tx.query(
    `insert into machvon.project_stage_change
       (tenant_id, id, project_id, project_version, from_stage, to_stage, operation, actor_kind, actor_id, decision_document_id, reason, effective_date, source_event_id)
     values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::bigint, $4, $5, $6, $7, $8::uuid, $9::uuid, $10, $11::date, $12::uuid)`,
    [randomUUID(), row.projectId, row.version, row.from, row.to, row.operation, row.actorKind, row.actorId, row.decisionDocumentId, row.reason, row.effectiveDate, row.sourceEventId],
  );
}
