import type { CodeEntry, Resolved, RuleStatus, RuleVersion } from '../../adm/governance/model';
import { rowCount, totalNominalDays, unverifiedRows } from './table-model';
import { readTemplate, summaryOf } from './template-model';
import type { Template, TemplateSummary } from './template-model';

/** The library of workflow templates: one row for each code of the rule type, read from the rule store. */

export type ForceKind = 'RULE' | 'DEFAULT' | 'NONE';

export interface LibraryRow {
  code: string;
  /** What the rule in force says of itself (or, when nothing is in force, the newest version). */
  summary: TemplateSummary | null;
  versions: RuleVersion[];
  statusCounts: Readonly<Record<RuleStatus, number>>;
  force: ForceKind;
  forceVersion: number;
  /** The day the rule in force begins; null for the template that ships with the platform. */
  effectiveFrom: string | null;
  /** Shipped as a starting point and not confirmed with the owner of the process. */
  unverified: boolean;
  /** The version in force, when a rule of the tenant governs the code (the one that can be retired). */
  inForce: RuleVersion | undefined;
  /** Rows of the table (steps; the tasks of a procedure written without steps). */
  steps: number;
  /** The nominal working days of every row added up (the dates of a project are the server's). */
  totalDays: number;
  /** Rows whose legal grounds nobody checked against the source text. */
  unverifiedSteps: number;
  /** The day of the last change of any version (written, submitted or approved), ISO. */
  lastChange: string | null;
  /** The kinds of project that take this procedure: the one the template names and those the mapping rule sends to it. */
  types: string[];
}

const STATUSES: readonly RuleStatus[] = ['DRAFT', 'SUBMITTED', 'APPROVED', 'RETIRED'];

export function statusCountsOf(versions: readonly RuleVersion[]): Record<RuleStatus, number> {
  return Object.fromEntries(STATUSES.map((status) => [status, versions.filter((version) => version.status === status).length])) as Record<RuleStatus, number>;
}

/** One row of the library from the code of the catalogue and what was read for it (the versions and the rule in force). */
export function libraryRow(entry: CodeEntry, versions: readonly RuleVersion[], effective: Resolved | null, mappedTypes: readonly string[] = []): LibraryRow {
  const force: ForceKind = effective === null ? 'NONE' : effective.source;
  const inForceVersion = force === 'RULE' ? versions.find((version) => version.version === effective?.version) : undefined;
  const newest = versions[0];
  const params = effective?.params ?? newest?.params;
  const template = params === undefined ? undefined : readTemplate(params);
  const stamps = versions.flatMap((version) => [version.createdAt, version.submittedAt, version.approvedAt, version.retiredAt].filter((stamp): stamp is string => typeof stamp === 'string'));
  const named = template?.project_type ?? null;
  return {
    inForce: inForceVersion,
    steps: template === undefined ? 0 : rowCount(template),
    totalDays: template === undefined ? 0 : totalNominalDays(template),
    unverifiedSteps: template === undefined ? 0 : unverifiedRows(template),
    lastChange: stamps.length === 0 ? null : [...stamps].sort()[stamps.length - 1] ?? null,
    types: [...new Set([...(named === null ? [] : [named]), ...mappedTypes])],
    code: entry.code,
    summary: params === undefined ? null : summaryOf(params),
    versions: [...versions],
    statusCounts: statusCountsOf(versions),
    force,
    forceVersion: effective?.version ?? 0,
    effectiveFrom: inForceVersion?.effectiveFrom ?? null,
    unverified: entry.unverified || effective?.unverified === true,
  };
}

/** What the library counts at the top: the templates, those a rule of the tenant governs and those still shipped unconfirmed. */
export function libraryTotals(rows: readonly LibraryRow[]): { templates: number; governed: number; unverified: number } {
  return { templates: rows.length, governed: rows.filter((row) => row.force === 'RULE').length, unverified: rows.filter((row) => row.unverified).length };
}

// ---- the two sides of a comparison -------------------------------------------------------------------------------------------------------------------------------

export const DEFAULT_SIDE = 'default';

export interface CompareSide {
  /** The id of the stored version, or `DEFAULT_SIDE` for the template that ships with the platform. */
  id: string;
  version: number;
  status: RuleStatus | 'DEFAULT';
  template: Template;
}

/** Every version of a code that can be compared, the newest first, and the shipped template when it is what governs the code. */
export function compareSides(versions: readonly RuleVersion[], effective: Resolved | null): CompareSide[] {
  const stored = versions.map((version): CompareSide => ({ id: version.id, version: version.version, status: version.status, template: readTemplate(version.params) }));
  return effective !== null && effective.source === 'DEFAULT' ? [...stored, { id: DEFAULT_SIDE, version: 0, status: 'DEFAULT', template: readTemplate(effective.params) }] : stored;
}
