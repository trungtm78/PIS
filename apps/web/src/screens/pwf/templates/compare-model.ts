import { stepsOf } from './template-model';
import type { EditorStep, EditorTask, Template } from './template-model';
import type { TemplatePhase } from '../model';

/**
 * Two versions of a workflow template side by side as people read a procedure: phase, step, task. For each one that was added, removed or changed, what changed is said field by field with the value before and after
 * (a duration in working days, a role, the tasks it waits for, its legal grounds, its forms, its checklist), never as the raw parameters.
 */

export type ChangeKind = 'added' | 'removed' | 'changed';
export type Tier = 'template' | 'phase' | 'step' | 'task';

/** The fields a comparison names; each has its word in the catalogue (`pwf6.cmp.field.<field>`). */
export type DiffField =
  | 'name'
  | 'projectType'
  | 'gates'
  | 'phase'
  | 'step'
  | 'duration'
  | 'kind'
  | 'required'
  | 'priority'
  | 'responsibleRole'
  | 'approverRole'
  | 'predecessors'
  | 'constraint'
  | 'legalDocs'
  | 'forms'
  | 'formPolicies'
  | 'checklist'
  | 'kpi'
  | 'conditions'
  | 'legalBasis';

/** How a value is said: as text, as a number of working days, as a role, a phase, a list of codes of a kind. The view turns it into words. */
export type DiffValue =
  | { type: 'text'; text: string }
  | { type: 'days'; days: number }
  | { type: 'role'; code: string | null }
  | { type: 'phase'; code: string }
  | { type: 'step'; code: string | null }
  | { type: 'flag'; on: boolean }
  | { type: 'enum'; group: 'kind' | 'priority'; code: string }
  | { type: 'none' };

export interface FieldDiff {
  field: DiffField;
  /** For a single value: before and after. */
  before?: DiffValue;
  after?: DiffValue;
  /** For a list: what was added and what was removed (already as readable items). */
  added?: string[];
  removed?: string[];
  /** For a list whose items changed in place (a checklist item renamed, a ground whose article changed). */
  changed?: string[];
}

export interface ItemDiff {
  tier: Tier;
  kind: ChangeKind;
  code: string;
  name: string;
  /** The phase the item belongs to (itself, for a phase); empty for the template. */
  phase: string;
  fields: FieldDiff[];
}

export interface CompareTotals {
  phases: number;
  steps: number;
  tasks: number;
  /** The sum of the durations of the tasks, in working days (not the length of the schedule: tasks run in parallel). */
  days: number;
  checklist: number;
  legalBasis: number;
  forms: number;
}

export interface TemplateComparison {
  before: CompareTotals;
  after: CompareTotals;
  items: ItemDiff[];
  counts: Record<ChangeKind, number>;
}

export function totalsOf(template: Template): CompareTotals {
  return {
    phases: template.phases.length,
    steps: stepsOf(template).length,
    tasks: template.tasks.length,
    days: template.tasks.reduce((sum, task) => sum + task.duration_working_days, 0),
    checklist: template.tasks.reduce((sum, task) => sum + task.checklist.length, 0),
    legalBasis: template.tasks.reduce((sum, task) => sum + (task.legal_basis ?? []).length, 0) + stepsOf(template).reduce((sum, step) => sum + (step.legal_basis ?? []).length, 0),
    forms: new Set(template.tasks.flatMap((task) => task.form_templates)).size,
  };
}

const text = (value: string): DiffValue => ({ type: 'text', text: value });
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** What two lists of codes differ by. */
function listDiff(field: DiffField, before: readonly string[], after: readonly string[]): FieldDiff[] {
  const added = after.filter((item) => !before.includes(item));
  const removed = before.filter((item) => !after.includes(item));
  return added.length === 0 && removed.length === 0 ? [] : [{ field, added, removed }];
}

/** What two keyed lists differ by: items added and removed by key, and items whose text changed under the same key. */
function keyedDiff<T>(field: DiffField, before: readonly T[], after: readonly T[], key: (item: T) => string, say: (item: T) => string): FieldDiff[] {
  const was = new Map(before.map((item) => [key(item), item]));
  const now = new Map(after.map((item) => [key(item), item]));
  const added = after.filter((item) => !was.has(key(item))).map(say);
  const removed = before.filter((item) => !now.has(key(item))).map(say);
  const changed = after.filter((item) => was.has(key(item)) && !same(was.get(key(item)), item)).map(say);
  return added.length === 0 && removed.length === 0 && changed.length === 0 ? [] : [{ field, added, removed, changed }];
}

const single = (field: DiffField, before: DiffValue, after: DiffValue): FieldDiff[] => (same(before, after) ? [] : [{ field, before, after }]);

type Basis = NonNullable<EditorTask['legal_basis']>[number];
const basisKey = (basis: Basis): string => basis.document;
const basisText = (basis: Basis): string => (basis.article === undefined || basis.article === '' ? basis.document : `${basis.document} · ${basis.article}`);

function taskFields(before: EditorTask, after: EditorTask, nameOf: (code: string) => string): FieldDiff[] {
  const predecessor = (item: EditorTask['predecessors'][number]): string => `${nameOf(item.task)} (${item.kind}${item.lag_working_days === 0 ? '' : `, ${item.lag_working_days > 0 ? '+' : ''}${item.lag_working_days}`})`;
  const constraint = (task: EditorTask): DiffValue => (task.constraint === null ? { type: 'none' } : text(`${task.constraint.kind} ${task.constraint.offset_working_days}`));
  const condition = (item: EditorTask['when'][number]): string => `${item.field}: ${item.in.join(', ')}`;
  const policy = (item: NonNullable<EditorTask['form_policies']>[number]): string => (item.policy === 'PINNED' ? `${item.form} · ${item.revision ?? ''}` : item.form);
  return [
    ...single('name', text(before.name), text(after.name)),
    ...single('phase', { type: 'phase', code: before.phase }, { type: 'phase', code: after.phase }),
    ...single('step', { type: 'step', code: before.step ?? null }, { type: 'step', code: after.step ?? null }),
    ...single('duration', { type: 'days', days: before.duration_working_days }, { type: 'days', days: after.duration_working_days }),
    ...single('kind', { type: 'enum', group: 'kind', code: before.kind }, { type: 'enum', group: 'kind', code: after.kind }),
    ...single('required', { type: 'flag', on: before.required }, { type: 'flag', on: after.required }),
    ...single('priority', { type: 'enum', group: 'priority', code: before.priority }, { type: 'enum', group: 'priority', code: after.priority }),
    ...single('responsibleRole', { type: 'role', code: before.responsible_role }, { type: 'role', code: after.responsible_role }),
    ...single('approverRole', { type: 'role', code: before.approver_role }, { type: 'role', code: after.approver_role }),
    ...keyedDiff('predecessors', before.predecessors, after.predecessors, (item) => item.task, predecessor),
    ...single('constraint', constraint(before), constraint(after)),
    ...listDiff('legalDocs', before.legal_doc_types, after.legal_doc_types),
    ...listDiff('forms', before.form_templates, after.form_templates),
    ...keyedDiff('formPolicies', before.form_policies ?? [], after.form_policies ?? [], (item) => item.form, policy),
    ...keyedDiff('checklist', before.checklist, after.checklist, (item) => item.code, (item) => item.name),
    ...listDiff('kpi', before.kpi_codes, after.kpi_codes),
    ...keyedDiff('conditions', before.when, after.when, (item) => item.field, condition),
    ...keyedDiff('legalBasis', before.legal_basis ?? [], after.legal_basis ?? [], basisKey, basisText),
  ];
}

function stepFields(before: EditorStep, after: EditorStep): FieldDiff[] {
  return [
    ...single('name', text(before.name), text(after.name)),
    ...single('phase', { type: 'phase', code: before.phase }, { type: 'phase', code: after.phase }),
    ...single('responsibleRole', { type: 'role', code: before.responsible_role ?? null }, { type: 'role', code: after.responsible_role ?? null }),
    ...keyedDiff('legalBasis', before.legal_basis ?? [], after.legal_basis ?? [], basisKey, basisText),
  ];
}

function phaseFields(before: TemplatePhase, after: TemplatePhase): FieldDiff[] {
  return [...single('name', text(before.name), text(after.name)), ...listDiff('gates', before.gates, after.gates)];
}

function parts<T extends { code: string; name: string }>(tier: Tier, before: readonly T[], after: readonly T[], phaseOf: (item: T) => string, fields: (was: T, now: T) => FieldDiff[]): ItemDiff[] {
  const was = new Map(before.map((item) => [item.code, item]));
  const now = new Map(after.map((item) => [item.code, item]));
  const found: ItemDiff[] = [];
  for (const item of after) {
    const old = was.get(item.code);
    if (old === undefined) found.push({ tier, kind: 'added', code: item.code, name: item.name, phase: phaseOf(item), fields: [] });
    else {
      const changed = fields(old, item);
      if (changed.length > 0) found.push({ tier, kind: 'changed', code: item.code, name: item.name, phase: phaseOf(item), fields: changed });
    }
  }
  for (const item of before) if (!now.has(item.code)) found.push({ tier, kind: 'removed', code: item.code, name: item.name, phase: phaseOf(item), fields: [] });
  return found;
}

/** Everything that differs between two versions, in the order of the procedure of the newer one: the template itself, then phase by phase its own change, its steps and its tasks. */
export function compareStructured(before: Template, after: Template): TemplateComparison {
  const names = new Map([...before.tasks, ...after.tasks].map((task) => [task.code, task.name]));
  const nameOf = (code: string): string => names.get(code) ?? code;
  const own: FieldDiff[] = [...single('name', text(before.name), text(after.name)), ...single('projectType', before.project_type === null ? { type: 'none' } : text(before.project_type), after.project_type === null ? { type: 'none' } : text(after.project_type))];
  const loose: ItemDiff[] = [
    ...parts('phase', before.phases, after.phases, (phase) => phase.code, phaseFields),
    ...parts('step', stepsOf(before), stepsOf(after), (step) => step.phase, stepFields),
    ...parts('task', before.tasks, after.tasks, (task) => task.phase, (was, now) => taskFields(was, now, nameOf)),
  ];
  const order = [...after.phases.map((phase) => phase.code), ...before.phases.map((phase) => phase.code).filter((code) => !after.phases.some((phase) => phase.code === code))];
  const tierOrder: Record<Tier, number> = { template: 0, phase: 1, step: 2, task: 3 };
  const rank = (item: ItemDiff): number => {
    const at = order.indexOf(item.phase);
    return (at === -1 ? order.length : at) * 10 + tierOrder[item.tier];
  };
  const items = [...(own.length === 0 ? [] : [{ tier: 'template' as const, kind: 'changed' as const, code: '', name: after.name, phase: '', fields: own }]), ...loose.map((item, index) => ({ item, index })).sort((a, b) => rank(a.item) - rank(b.item) || a.index - b.index).map(({ item }) => item)];
  const counts: Record<ChangeKind, number> = { added: 0, removed: 0, changed: 0 };
  for (const item of items) counts[item.kind] += 1;
  return { before: totalsOf(before), after: totalsOf(after), items, counts };
}
