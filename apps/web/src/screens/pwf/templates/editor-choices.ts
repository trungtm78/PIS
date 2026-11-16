import type { Translator } from '../../../i18n';
import { codeKey, roleName } from '../codes';
import { BUILT_IN_PARTIES } from './template-model';
import type { Template } from './template-model';
import { PROJECT_OWNER, partyRef, unitRef } from './table-model';
import type { TemplateProblem } from './template-model';

type T = Translator['t'];

/** The roles the platform ships with a Vietnamese name (`pwf6.role.<code>.word`): the choices of the role of a step before the template names a role of its own. */
export const KNOWN_ROLES: readonly string[] = [
  'INVESTOR_REP',
  'DECISION_AUTHORITY',
  'PMB_MANAGER',
  'PMB_PLANNER',
  'PMB_ACCOUNTANT',
  'PROCUREMENT_OFFICER',
  'SITE_ENGINEER',
  'SUPERVISOR',
  'DPI_APPRAISER',
  'FINANCE_APPRAISER',
  'LEGAL_OFFICER',
  'AUDITOR',
];

export interface Choice {
  value: string;
  label: string;
}

/** What a role is called: the name this template gives it, else the name of the catalogue, else its code. */
export function roleLabel(t: T, template: Pick<Template, 'roles'>, code: string): string {
  const own = (template.roles ?? []).find((role) => role.code === code)?.name.trim() ?? '';
  return own === '' ? roleName(t, code) : own;
}

/** The roles a step can be given: those the template names, those it already uses, then the catalogue; a code a row holds that is in none of them is kept so that the select shows what is stored. */
export function roleChoices(t: T, template: Template, used: readonly string[], current: string): Choice[] {
  const codes = [...new Set([...(template.roles ?? []).map((role) => role.code), ...used, ...KNOWN_ROLES, ...(current === '' ? [] : [current])])];
  return codes.map((code) => ({ value: code, label: roleLabel(t, template, code) }));
}

/** The unit a step is received by (R61): the owner of the project, the two parties every project has, the parties the template names, and the units of the tenant. */
export function unitChoices(t: T, template: Template, tenantUnits: readonly { id: string; name: string }[], current: readonly string[]): Choice[] {
  const choices: Choice[] = [
    { value: PROJECT_OWNER, label: t('pwfx.unit.owner') },
    ...BUILT_IN_PARTIES.map((code) => ({ value: partyRef(code), label: t(`pwfx.unit.party.${codeKey(code)}`) })),
    ...(template.parties ?? []).map((party) => ({ value: partyRef(party.code), label: party.name })),
    ...tenantUnits.map((unit) => ({ value: unitRef(unit.id), label: unit.name })),
  ];
  const known = new Set(choices.map((choice) => choice.value));
  return [...choices, ...current.filter((ref) => ref !== '' && !known.has(ref)).map((ref) => ({ value: ref, label: ref }))];
}

/** The problems whose path is one of the fields of a part of the template (`tasks[3]` and `duration`, `bands`): the cell of that field says them. */
export function problemsOf(problems: readonly TemplateProblem[], at: string, fields: readonly string[]): TemplateProblem[] {
  return problems.filter((problem) => fields.some((field) => problem.path === `${at}.${field}` || problem.path.startsWith(`${at}.${field}.`) || problem.path.startsWith(`${at}.${field}[`)));
}

/** The cell of the table (or the part of the details) a problem of a task belongs to. */
export type CellName = 'name' | 'unit' | 'anchor' | 'limit' | 'bands' | 'basis' | 'details';

const CELL_FIELDS: readonly (readonly [CellName, readonly string[]])[] = [
  ['name', ['name', 'code', 'phase', 'step']],
  ['unit', ['responsible_role', 'responsible_units']],
  ['anchor', ['predecessors']],
  ['limit', ['duration', 'duration_working_days', 'extension', 'kind']],
  ['bands', ['bands']],
  ['basis', ['legal_basis']],
];

export function cellOfProblem(path: string): CellName {
  const field = /^(?:tasks|steps)\[\d+\]\.([a-z_]+)/.exec(path)?.[1];
  if (field === undefined) return 'name';
  return CELL_FIELDS.find(([, fields]) => fields.includes(field))?.[0] ?? 'details';
}
