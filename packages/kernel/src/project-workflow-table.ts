import { activeTasks, BUILT_IN_PARTIES } from './project-workflow.ts';
import type { DurationUnit, ProjectFacts, ProjectWorkflowTemplate, TemplateExtension, UnitPart } from './project-workflow.ts';

/**
 * The rules behind the table of steps of a workflow template (PWF section 22, R61, R63, R71, R72, R75), all pure: the code a new row gets from its name, the stamp of a verified legal ground, the units of a project that the
 * references of a template stand for, and whether an extension of a time limit fits the caps of its task. The data side (the fields of the template, their checks, the hash) is project-workflow.ts; the dates are project-schedule.ts.
 */

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Codes made once from a name (R63).
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

const CODE_MAX = 40;

/**
 * The code of a new phase, step, task, role or party, made from its name: the marks of the letters are dropped (`đ` is `d`), the letters are capitals, everything else is one underscore, at most 40 characters; a name that gives no
 * letter first gets the prefix `C_`. A code that is taken gets `_2`, `_3`, ... (the stem is cut so that the whole still fits). The code of a row is made ONCE: renaming the row never calls this again, because the code is the
 * identity of the row in every project that froze the template.
 */
export function workflowCodeFrom(name: string, taken: Iterable<string> = []): string {
  const plain = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  let stem = /^[A-Z]/.test(plain) ? plain : `C_${plain}`;
  stem = stem.slice(0, CODE_MAX).replace(/_+$/g, '');
  if (stem.length < 2) stem = 'CODE';
  const used = new Set(taken);
  if (!used.has(stem)) return stem;
  for (let index = 2; ; index += 1) {
    const suffix = `_${index}`;
    const candidate = `${stem.slice(0, CODE_MAX - suffix.length).replace(/_+$/g, '')}${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The stamp of a verified legal ground (R75).
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

type Params = Record<string, unknown>;
const isRecord = (value: unknown): value is Params => typeof value === 'object' && value !== null && !Array.isArray(value);
const listOf = (value: unknown): Params[] => (Array.isArray(value) ? value.filter(isRecord) : []);
const groundKey = (one: Params): string => JSON.stringify([one.document ?? null, typeof one.article === 'string' ? one.article : null, typeof one.note === 'string' ? one.note : null]);

export interface LegalStampResult {
  params: Params;
  /** The citations the server stamped with this save. */
  stamped: number;
  /** The citations that came in as verified and were put back to unverified (a copied or edited line that carried a stamp of somewhere else). */
  reset: number;
}

/**
 * The params of a template draft with the verification of its legal grounds as the SERVER says it (R75). The stamp (`verified_by`, `verified_at`) is never taken from the client; what the client sends only says what the person did:
 *
 *  - a citation marked VERIFIED without a stamp is the person saying "I checked it": when the version before has the same citation (same step or task by code, same document, article and note) already verified it keeps exactly what
 *    that version says (its stamp, or none for a citation verified before stamps existed, so an untouched template keeps its hash); otherwise it is stamped with the person and the time of the save;
 *  - a citation marked VERIFIED that carries a stamp keeps it only when the version before has that very citation with that very stamp; anywhere else (a row copied to another step, a text that was edited, a template cloned under
 *    another code) the stamp belongs to something else, and the citation goes back to UNVERIFIED;
 *  - a citation that is UNVERIFIED carries no stamp.
 *
 * `previous` is the params of the version before of the SAME rule code, or null when there is none.
 */
export function stampLegalVerification(params: Params, previous: Params | null, actor: string, at: string): LegalStampResult {
  let stamped = 0;
  let reset = 0;
  const earlier = (place: 'steps' | 'tasks', code: unknown): Map<string, Params> => {
    const owner = listOf(previous?.[place]).find((one) => one.code === code);
    return new Map(listOf(owner?.legal_basis).map((one) => [groundKey(one), one] as const));
  };
  const judge = (place: 'steps' | 'tasks', owner: Params): Params => {
    if (!Array.isArray(owner.legal_basis)) return owner;
    const before = earlier(place, owner.code);
    const grounds = listOf(owner.legal_basis).map((one): Params => {
      const { verified_by: by, verified_at: when, ...rest } = one;
      if (one.verification !== 'VERIFIED') return rest;
      const was = before.get(groundKey(one));
      const wasVerified = was !== undefined && was.verification === 'VERIFIED';
      const carried = wasVerified && typeof was.verified_by === 'string' && typeof was.verified_at === 'string' ? { verified_by: was.verified_by, verified_at: was.verified_at } : {};
      if (by === undefined && when === undefined) {
        if (wasVerified) return { ...rest, ...carried };
        stamped += 1;
        return { ...rest, verified_by: actor, verified_at: at };
      }
      if (wasVerified && was.verified_by === by && was.verified_at === when) return { ...rest, ...carried };
      reset += 1;
      return { ...rest, verification: 'UNVERIFIED' };
    });
    return { ...owner, legal_basis: grounds };
  };
  const out: Params = { ...params };
  if (Array.isArray(params.steps)) out.steps = listOf(params.steps).map((step) => judge('steps', step));
  if (Array.isArray(params.tasks)) out.tasks = listOf(params.tasks).map((task) => judge('tasks', task));
  return { params: out, stamped, reset };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The units that receive the tasks of a project (R61, R71).
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** The units the project itself names. */
export interface ProjectUnits {
  ownerUnitId: string | null;
  investorUnitId: string | null;
  decisionAuthorityUnitId: string | null;
}

export interface ReceivingUnit {
  unit_ref: string;
  unit_id: string;
  role: string;
  part: UnitPart;
}

export interface UnitResolution {
  /** Every reference the tasks of this project use, in the order met, with the unit it stands for (null: nobody can say yet) and where the answer came from. */
  refs: Array<{ unit_ref: string; unit_id: string | null; source: 'PROJECT' | 'TEMPLATE' | 'CHOSEN' | 'NONE' }>;
  /** The references still without a unit: the workflow cannot start until the person who starts it names them. */
  unresolved: string[];
  /** The references the caller named a unit for although the project (or the template) already answers them: refused, the project is corrected, not the workflow. */
  overridden: string[];
  /** The references the caller named that no task of this project uses. */
  unknown: string[];
  /** The units of each task that has some, the leading one first. */
  byTask: Record<string, ReceivingUnit[]>;
}

const UNIT_PREFIX = 'UNIT:';
const PARTY_PREFIX = 'PROJECT_PARTY:';

/** The unit a reference stands for by the project alone: its owning unit, the two parties the project names, or the very unit the reference carries; undefined for a slot only a person can fill. */
function fixedUnit(ref: string, project: ProjectUnits): { unitId: string | null; source: 'PROJECT' | 'TEMPLATE' } | undefined {
  if (ref === 'PROJECT_OWNER') return { unitId: project.ownerUnitId, source: 'PROJECT' };
  if (ref.startsWith(UNIT_PREFIX)) return { unitId: ref.slice(UNIT_PREFIX.length), source: 'TEMPLATE' };
  if (ref === `${PARTY_PREFIX}${BUILT_IN_PARTIES[0]}`) return { unitId: project.investorUnitId, source: 'PROJECT' };
  if (ref === `${PARTY_PREFIX}${BUILT_IN_PARTIES[1]}`) return { unitId: project.decisionAuthorityUnitId, source: 'PROJECT' };
  return undefined;
}

/**
 * The units of the tasks of one project (the branches it does not have are left out): the project answers for its owner and its named parties, a `UNIT:` reference for itself, and the person who starts the workflow for every other
 * party (`chosen`: reference to unit id). A party of the project that the project has not named yet (no investor recorded) may be chosen too, since nothing is overridden. Nothing is ever guessed.
 */
export function resolveResponsibleUnits(template: ProjectWorkflowTemplate, facts: ProjectFacts, project: ProjectUnits, chosen: Readonly<Record<string, string>> = {}): UnitResolution {
  const refs: UnitResolution['refs'] = [];
  const answer = new Map<string, string | null>();
  const overridden: string[] = [];
  for (const task of activeTasks(template, facts).active) {
    for (const unit of task.responsibleUnits ?? []) {
      if (answer.has(unit.unitRef)) continue;
      const fixed = fixedUnit(unit.unitRef, project);
      const picked = chosen[unit.unitRef];
      if (fixed !== undefined && fixed.unitId !== null) {
        if (picked !== undefined && picked !== fixed.unitId) overridden.push(unit.unitRef);
        answer.set(unit.unitRef, fixed.unitId);
        refs.push({ unit_ref: unit.unitRef, unit_id: fixed.unitId, source: fixed.source });
      } else {
        answer.set(unit.unitRef, picked ?? null);
        refs.push({ unit_ref: unit.unitRef, unit_id: picked ?? null, source: picked === undefined ? 'NONE' : 'CHOSEN' });
      }
    }
  }
  const byTask: Record<string, ReceivingUnit[]> = {};
  for (const task of activeTasks(template, facts).active) {
    const units = (task.responsibleUnits ?? []).flatMap((unit): ReceivingUnit[] => {
      const unitId = answer.get(unit.unitRef);
      return unitId === null || unitId === undefined ? [] : [{ unit_ref: unit.unitRef, unit_id: unitId, role: unit.role, part: unit.part }];
    });
    if (units.length > 0) byTask[task.code] = [...units].sort((left, right) => Number(right.part === 'LEAD') - Number(left.part === 'LEAD'));
  }
  return { refs, unresolved: refs.filter((one) => one.unit_id === null).map((one) => one.unit_ref), overridden, unknown: Object.keys(chosen).filter((ref) => !answer.has(ref)), byTask };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Extending the time limit of a task (R72).
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** What an extension is judged against: the rule of the task in the frozen template (null: the template says nothing of extensions), what its approved extensions have used so far, and whether the task is still open. */
export interface ExtensionSubject {
  code: string;
  extension: TemplateExtension | null;
  timesUsed: number;
  valueUsed: number;
  closed: boolean;
}

export interface ExtensionAsk {
  taskCode: string;
  addValue: number;
}

export type ExtensionRefusalCode = 'PWF_EXTENSION_TASK_UNKNOWN' | 'PWF_EXTENSION_NOT_ALLOWED' | 'PWF_EXTENSION_TASK_CLOSED' | 'PWF_EXTENSION_LIMIT_EXCEEDED';

export interface ExtensionRefusal {
  code: ExtensionRefusalCode;
  task: string;
  limit?: 'TIMES' | 'VALUE';
  used?: number;
  asked?: number;
  max?: number;
}

export interface ExtensionVerdict {
  ok: boolean;
  refusals: ExtensionRefusal[];
  /** What each task would have used once the whole proposal is applied: one time per line, the values added up. */
  totals: Array<{ task: string; times: number; value: number; unit: DurationUnit }>;
}

/**
 * Whether the extensions of ONE proposal fit the caps of their tasks, judged on the whole proposal (several lines for one task count as that many times and their values add up) on top of what approved extensions used before.
 * Only an extension spends a cap: a task that moves because another one did is not listed here at all. The same judgement runs when the proposal is made and again when it is approved.
 */
export function assessExtensions(subjects: readonly ExtensionSubject[], asks: readonly ExtensionAsk[]): ExtensionVerdict {
  const byCode = new Map(subjects.map((one) => [one.code, one] as const));
  const refusals: ExtensionRefusal[] = [];
  const sums = new Map<string, { times: number; value: number }>();
  for (const ask of asks) {
    const sum = sums.get(ask.taskCode) ?? { times: 0, value: 0 };
    sums.set(ask.taskCode, { times: sum.times + 1, value: sum.value + ask.addValue });
  }
  const totals: ExtensionVerdict['totals'] = [];
  for (const [code, sum] of sums) {
    const subject = byCode.get(code);
    if (subject === undefined) {
      refusals.push({ code: 'PWF_EXTENSION_TASK_UNKNOWN', task: code });
      continue;
    }
    if (subject.extension === null || !subject.extension.allowed) {
      refusals.push({ code: 'PWF_EXTENSION_NOT_ALLOWED', task: code });
      continue;
    }
    if (subject.closed) {
      refusals.push({ code: 'PWF_EXTENSION_TASK_CLOSED', task: code });
      continue;
    }
    const times = subject.timesUsed + sum.times;
    const value = subject.valueUsed + sum.value;
    const { maxTimes, maxValue } = subject.extension;
    if (maxTimes !== null && times > maxTimes) refusals.push({ code: 'PWF_EXTENSION_LIMIT_EXCEEDED', task: code, limit: 'TIMES', used: subject.timesUsed, asked: sum.times, max: maxTimes });
    if (maxValue !== null && value > maxValue) refusals.push({ code: 'PWF_EXTENSION_LIMIT_EXCEEDED', task: code, limit: 'VALUE', used: subject.valueUsed, asked: sum.value, max: maxValue });
    totals.push({ task: code, times, value, unit: subject.extension.unit });
  }
  return { ok: refusals.length === 0, refusals, totals };
}
