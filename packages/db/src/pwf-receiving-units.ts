import { DomainError, pwfTable, pwfWorkflow } from '@machvon/kernel';
import type { TenantTx } from './tenant-database.ts';

/**
 * The units that receive the tasks of a project (PWF-5, docs PWF 22.2 R61): when a workflow is made, every reference of the frozen template (`PROJECT_OWNER`, `PROJECT_PARTY:<code>`, `UNIT:<uuid>`) is turned into a unit of the
 * tenant. The project answers for its owner, its investor and its decision authority; a `UNIT:` reference answers for itself; every other party is named by the person who starts the workflow (`units`). Nothing is guessed: a
 * reference nobody can answer refuses the start (or is told by a dry run), a unit the project already names cannot be replaced here, and a unit that is named must be a unit of the tenant that is valid on the day.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNIT_REF = new RegExp(pwfWorkflow.UNIT_REF_PATTERN);
/** A template names at most 30 parties of its own, two are built in, and the owner: a request with more keys than that cannot be about a template. */
const MAX_CHOSEN = 40;
const PARTY_PREFIX = 'PROJECT_PARTY:';

export type UnitSource = 'PROJECT' | 'TEMPLATE' | 'CHOSEN' | 'NONE';

/** A reference as a screen shows it: the unit it stands for with its name (null while nobody has named it), where the answer came from, and what the template calls the party. */
export interface UnitRefView {
  unit_ref: string;
  unit_id: string | null;
  unit_name: string | null;
  source: UnitSource;
  party_name: string | null;
}

/** A reference as the row of the workflow keeps it (`project_workflow.selection.units`). */
export interface SelectedUnit {
  unit_ref: string;
  unit_id: string;
  source: Exclude<UnitSource, 'NONE'>;
}

export interface ResolvedUnits {
  refs: UnitRefView[];
  /** The references still without a unit. Empty after a resolution that did not only report. */
  unresolved: string[];
  /** The units of each task that has some, the leading one first. */
  byTask: Record<string, pwfTable.ReceivingUnit[]>;
}

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

/** The units the row of a project names; a project that is not there names none. */
export async function projectUnitsOf(tx: TenantTx, projectId: string): Promise<pwfTable.ProjectUnits> {
  const rows = await tx.query<{ owner_unit_id: string | null; investor_unit_id: string | null; decision_authority_unit_id: string | null }>(
    'select owner_unit_id, investor_unit_id, decision_authority_unit_id from machvon.project where id = $1::uuid',
    [projectId],
  );
  return { ownerUnitId: rows[0]?.owner_unit_id ?? null, investorUnitId: rows[0]?.investor_unit_id ?? null, decisionAuthorityUnitId: rows[0]?.decision_authority_unit_id ?? null };
}

/** What the person named, checked for its shape alone: a reference of the grammar of the template for each key, an id for each value. */
function chosenOf(units: Readonly<Record<string, unknown>> | undefined): Record<string, string> {
  if (units === undefined) return {};
  if (typeof units !== 'object' || units === null || Array.isArray(units)) throw invalid('units');
  const entries = Object.entries(units);
  if (entries.length > MAX_CHOSEN) throw invalid('units');
  const chosen: Record<string, string> = {};
  for (const [ref, value] of entries) {
    if (!UNIT_REF.test(ref) || typeof value !== 'string' || !UUID.test(value)) throw invalid('units');
    chosen[ref] = value.toLowerCase();
  }
  return chosen;
}

/**
 * The units of the tasks a project has under a template (the branches it does not have ask for nothing). `strict` is the start of a workflow: a reference without a unit is 422 `PWF_UNIT_UNRESOLVED` with the references. Without it
 * (a dry run, a preview) the references are told with what is still missing. Either way what the person names is judged: 422 `VALIDATION_FAILED` on `units` for a key or a value that is not one or a reference no task of this
 * project uses, 422 `PWF_UNIT_OVERRIDE_DENIED` for a reference the project or the template already answers, 422 `PWF_UNIT_UNKNOWN` for a unit (named by the person or by the template) that is not a unit of the tenant valid on
 * `day`. Returns null for a template whose tasks name no unit when the person named none either: such a workflow is made exactly as before.
 */
export async function resolveReceivingUnits(
  tx: TenantTx,
  input: { template: pwfWorkflow.ProjectWorkflowTemplate; facts: pwfWorkflow.ProjectFacts; project: pwfTable.ProjectUnits; units?: Readonly<Record<string, unknown>> | undefined; day: string; strict: boolean },
): Promise<ResolvedUnits | null> {
  const chosen = chosenOf(input.units);
  const found = pwfTable.resolveResponsibleUnits(input.template, input.facts, input.project, chosen);
  if (found.unknown.length > 0) throw new DomainError('VALIDATION_FAILED', 422, 'units', { extensions: { unit_refs: [...found.unknown].sort() } });
  if (found.refs.length === 0) return null;
  if (found.overridden.length > 0) throw new DomainError('PWF_UNIT_OVERRIDE_DENIED', 422, 'units', { extensions: { unit_refs: [...found.overridden].sort() } });
  if (input.strict && found.unresolved.length > 0) throw new DomainError('PWF_UNIT_UNRESOLVED', 422, 'units', { extensions: { unit_refs: [...found.unresolved].sort() } });
  const ids = [...new Set(found.refs.map((one) => one.unit_id).filter((id): id is string => id !== null))];
  const units = await tx.query<{ id: string; name: string; valid: boolean }>(
    `select u.id, u.name, (u.valid_from <= $2::date and (u.valid_until is null or u.valid_until >= $2::date)) as valid from machvon.organization_unit u where u.id = any($1::uuid[])`,
    [ids, input.day],
  );
  const known = new Map(units.map((unit) => [unit.id, unit] as const));
  // The units the project itself names are the project's to keep right; a unit named here (by the person, or by the template for every project) is checked on the day the workflow is made.
  const gone = found.refs.filter((one) => one.unit_id !== null && one.source !== 'PROJECT' && known.get(one.unit_id)?.valid !== true).map((one) => one.unit_ref);
  if (gone.length > 0) throw new DomainError('PWF_UNIT_UNKNOWN', 422, 'units', { extensions: { unit_refs: gone.sort() } });
  const parties = new Map<string, string>((input.template.parties ?? []).map((party) => [`${PARTY_PREFIX}${party.code}`, party.name] as const));
  return {
    refs: found.refs.map((one) => ({ unit_ref: one.unit_ref, unit_id: one.unit_id, unit_name: one.unit_id === null ? null : (known.get(one.unit_id)?.name ?? null), source: one.source, party_name: parties.get(one.unit_ref) ?? null })),
    unresolved: found.unresolved,
    byTask: found.byTask,
  };
}

/** What the row of the workflow keeps of a resolution: the reference, the unit and where it came from. */
export const selectedUnitsOf = (resolved: ResolvedUnits): SelectedUnit[] =>
  resolved.refs.flatMap((one): SelectedUnit[] => (one.unit_id === null || one.source === 'NONE' ? [] : [{ unit_ref: one.unit_ref, unit_id: one.unit_id, source: one.source }]));

/** The references of a resolution as a response tells them (a dry run, a preview): every reference and the ones that still ask for a unit. */
export const unitsViewOf = (resolved: ResolvedUnits | null): { refs: UnitRefView[]; unresolved: string[] } => ({ refs: resolved?.refs ?? [], unresolved: resolved?.unresolved ?? [] });
