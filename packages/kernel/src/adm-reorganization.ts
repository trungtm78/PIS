import { DomainError } from './errors.ts';

/**
 * The reorganisation of organisation units (ST-ADM-015, ADM 3.2): what makes a proposal well formed, and where each member and project of the old units goes. Which members and projects the old units hold, whether the
 * units exist and who may propose are judged on the data by the command; this is the part that needs none.
 */

/** What the saga does: merge units into one, split one into several, dissolve units into one that takes over, rename one into another. A transfer is the move of a unit under another parent (`moveOrganizationUnit`). */
export const REORGANIZATION_KINDS = ['MERGE', 'SPLIT', 'DISSOLVE', 'RENAME'] as const;
export type ReorganizationKind = (typeof REORGANIZATION_KINDS)[number];
/** A date this far after today is a slip of the pen. */
const MAX_DAYS_AHEAD = 366;
const DAY_MS = 86_400_000;

export interface SuccessorInput {
  existingUnitId?: string | undefined;
  newUnit?: unknown;
}

export interface ReorganizationMapping {
  memberships: ReadonlyArray<{ membershipId: string; successorUnitId: string }>;
  projects: ReadonlyArray<{ projectId: string; successorUnitId: string }>;
  defaultSuccessorUnitId?: string | undefined;
}

export interface ReorganizationInput {
  kind: ReorganizationKind;
  /** The Vietnam date from which the new units stand, `YYYY-MM-DD`. */
  effectiveFrom: string;
  predecessorIds: readonly string[];
  successors: readonly SuccessorInput[];
  mapping: ReorganizationMapping;
}

export interface ReorganizationDefect {
  field: string;
  code:
    | 'KIND_UNSUPPORTED'
    | 'PREDECESSORS_REQUIRED'
    | 'SUCCESSORS_REQUIRED'
    | 'DUPLICATE'
    | 'MERGE_NEEDS_TWO'
    | 'ONE_PREDECESSOR_ONLY'
    | 'ONE_SUCCESSOR_ONLY'
    | 'SPLIT_NEEDS_TWO'
    | 'SUCCESSOR_UNNAMED'
    | 'SUCCESSOR_AMBIGUOUS'
    | 'SUCCESSOR_IS_PREDECESSOR'
    | 'NEW_UNIT_NEEDS_SOLE_SUCCESSOR'
    | 'DATE_INVALID'
    | 'DATE_TOO_FAR'
    | 'TARGET_NOT_A_SUCCESSOR';
}

function validDate(text: string): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (match === null) return undefined;
  const at = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const back = new Date(at);
  return back.getUTCFullYear() === Number(match[1]) && back.getUTCMonth() === Number(match[2]) - 1 && back.getUTCDate() === Number(match[3]) ? at : undefined;
}

/** Every defect of a proposal, in the order of the fields; none when it is well formed. `today` is the Vietnam date. */
export function validateReorganization(input: ReorganizationInput, today: string): ReorganizationDefect[] {
  const defects: ReorganizationDefect[] = [];
  const add = (field: string, code: ReorganizationDefect['code']): void => void defects.push({ field, code });
  if (!(REORGANIZATION_KINDS as readonly string[]).includes(input.kind)) {
    add('kind', 'KIND_UNSUPPORTED');
    return defects;
  }
  const predecessors = new Set(input.predecessorIds);
  if (input.predecessorIds.length === 0) add('predecessor_unit_ids', 'PREDECESSORS_REQUIRED');
  else if (predecessors.size !== input.predecessorIds.length) add('predecessor_unit_ids', 'DUPLICATE');
  else if (input.kind === 'MERGE' && predecessors.size < 2) add('predecessor_unit_ids', 'MERGE_NEEDS_TWO');
  else if ((input.kind === 'SPLIT' || input.kind === 'RENAME') && predecessors.size !== 1) add('predecessor_unit_ids', 'ONE_PREDECESSOR_ONLY');
  const count = input.successors.length;
  if (count === 0) add('successors', 'SUCCESSORS_REQUIRED');
  else if (input.kind === 'SPLIT' ? count < 2 : count > 1) add('successors', input.kind === 'SPLIT' ? 'SPLIT_NEEDS_TWO' : 'ONE_SUCCESSOR_ONLY');
  const existing: string[] = [];
  input.successors.forEach((successor, index) => {
    const field = `successors[${index}]`;
    const named = successor.existingUnitId !== undefined;
    const created = successor.newUnit !== undefined;
    if (named && created) add(field, 'SUCCESSOR_AMBIGUOUS');
    else if (!named && !created) add(field, 'SUCCESSOR_UNNAMED');
    else if (created && count > 1) add(field, 'NEW_UNIT_NEEDS_SOLE_SUCCESSOR');
    else if (named && predecessors.has(successor.existingUnitId as string)) add(field, 'SUCCESSOR_IS_PREDECESSOR');
    if (named) existing.push(successor.existingUnitId as string);
  });
  if (new Set(existing).size !== existing.length) add('successors', 'DUPLICATE');
  const effective = validDate(input.effectiveFrom);
  const now = validDate(today);
  if (effective === undefined) add('effective_from', 'DATE_INVALID');
  else if (now !== undefined && effective - now > MAX_DAYS_AHEAD * DAY_MS) add('effective_from', 'DATE_TOO_FAR');
  const targets = new Set(existing);
  const seenMembers = new Set<string>();
  input.mapping.memberships.forEach((entry, index) => {
    if (seenMembers.has(entry.membershipId)) add(`mapping.memberships[${index}]`, 'DUPLICATE');
    else if (!targets.has(entry.successorUnitId)) add(`mapping.memberships[${index}]`, 'TARGET_NOT_A_SUCCESSOR');
    seenMembers.add(entry.membershipId);
  });
  const seenProjects = new Set<string>();
  input.mapping.projects.forEach((entry, index) => {
    if (seenProjects.has(entry.projectId)) add(`mapping.projects[${index}]`, 'DUPLICATE');
    else if (!targets.has(entry.successorUnitId)) add(`mapping.projects[${index}]`, 'TARGET_NOT_A_SUCCESSOR');
    seenProjects.add(entry.projectId);
  });
  if (input.mapping.defaultSuccessorUnitId !== undefined && !targets.has(input.mapping.defaultSuccessorUnitId)) add('mapping.default_successor_unit_id', 'TARGET_NOT_A_SUCCESSOR');
  return defects;
}

/** 422 naming the first field, with every defect as a member of the problem. */
export function assertValidReorganization(input: ReorganizationInput, today: string): void {
  const defects = validateReorganization(input, today);
  if (defects.length > 0) throw new DomainError('VALIDATION_FAILED', 422, defects[0]?.field, { extensions: { defects } });
}

/**
 * The unit that takes a member or a project of an old unit: the only successor when there is one; otherwise the one named for it, or the default successor. `successorIds` are the successors once they exist (the id of a
 * new unit is known only when it is created, so a mapping never names one: a new unit is always the only successor).
 */
export function successorOf(input: ReorganizationInput, what: 'membership' | 'project', id: string, successorIds: readonly string[]): string | undefined {
  if (successorIds.length === 1) return successorIds[0];
  const named = what === 'membership' ? input.mapping.memberships.find((entry) => entry.membershipId === id)?.successorUnitId : input.mapping.projects.find((entry) => entry.projectId === id)?.successorUnitId;
  return named ?? input.mapping.defaultSuccessorUnitId;
}

/** The members and the projects of the old units that have no place to go, in the order they were given (BR-ADM: nothing is left behind, `REORG_MAPPING_INCOMPLETE`). */
export function unmapped(input: ReorganizationInput, membershipIds: readonly string[], projectIds: readonly string[], successorIds: readonly string[]): { memberships: string[]; projects: string[] } {
  return {
    memberships: membershipIds.filter((id) => successorOf(input, 'membership', id, successorIds) === undefined),
    projects: projectIds.filter((id) => successorOf(input, 'project', id, successorIds) === undefined),
  };
}
