import type { ReactNode } from 'react';
import { translator, useTranslation } from '../../i18n';
import { systemRoleLabel } from '../../shell/account-role';
import type { Translator } from '../../i18n';
import './pwf.css';
import './pwf6.css';

type T = Translator['t'];

/**
 * The names people read for the codes the workflow carries (roles, phases, kinds of evidence, document types, events of the log, grades, templates, KPI). A template of a province may use a code this catalogue has
 * no name for: the code itself is then shown, never a guessed name. A code is a small secondary note next to its name, never the name.
 */
export const codeKey = (code: string): string =>
  code
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+([a-z0-9])/g, (_match, next: string) => next.toUpperCase())
    .replace(/[^a-zA-Z0-9]/g, '');


/** Whether the catalogue has a name for the role (a role of a province's own template may have none). */
export const roleKnown = (code: string): boolean => translator.has(`pwf6.role.${codeKey(code)}.word`) || systemRoleLabel(translator.t, code) !== undefined;
/** The name of a role of a workflow: the name of the workflow's own catalogue, else the name of the role of the product (STAFF_MEMBER), else the code. */
export const roleName = (t: T, code: string): string => (translator.has(`pwf6.role.${codeKey(code)}.word`) ? t(`pwf6.role.${codeKey(code)}.word`) : (systemRoleLabel(t, code) ?? code));
/** The name of a phase: what the workflow or the template says first, else the name of the shipped phases, else the code. */
export const phaseName = (t: T, code: string, phases?: readonly { code: string; name: string }[]): string => phases?.find((phase) => phase.code === code)?.name ?? (translator.has(`pwf6.phase.${codeKey(code)}.word`) ? t(`pwf6.phase.${codeKey(code)}.word`) : code);
export const evidenceKindName = (t: T, code: string): string => (translator.has(`pwf6.evidence.${codeKey(code)}.word`) ? t(`pwf6.evidence.${codeKey(code)}.word`) : code);
export const docTypeName = (t: T, code: string): string => (translator.has(`pwf6.doc.${codeKey(code)}.word`) ? t(`pwf6.doc.${codeKey(code)}.word`) : code);
export const docTypeKnown = (code: string): boolean => translator.has(`pwf6.doc.${codeKey(code)}.word`);
export const historyName = (t: T, kind: string): string => (translator.has(`pwf6.history.${codeKey(kind)}.word`) ? t(`pwf6.history.${codeKey(kind)}.word`) : kind);
export const gradeName = (t: T, code: string): string => (translator.has(`pwf6.grade.${codeKey(code)}.word`) ? t(`pwf6.grade.${codeKey(code)}.word`) : code);
export const templateName = (t: T, code: string): string => (translator.has(`pwf6.template.${codeKey(code)}.word`) ? t(`pwf6.template.${codeKey(code)}.word`) : code);
export const templateKnown = (code: string): boolean => translator.has(`pwf6.template.${codeKey(code)}.word`);
export const kpiName = (t: T, code: string): string => (translator.has(`pwf6.kpi.${codeKey(code)}.word`) ? t(`pwf6.kpi.${codeKey(code)}.word`) : code);
export const factName = (t: T, code: string): string => (translator.has(`pwf6.fact.${codeKey(code)}.word`) ? t(`pwf6.fact.${codeKey(code)}.word`) : code);

/** "System default" for version 0 of a rule (the shipped default has no version of the tenant), else "version N". */
export const versionText = (t: T, version: number | null | undefined): string => (version === null || version === undefined || version === 0 ? t('pwf6.version.default.text') : t('pwf6.version.numbered.text', { version }));

export type GradeTone = 'success' | 'info' | 'warning' | 'danger' | 'neutral';
/** The tone and glyph of a grade: the weakest grade is never green and never ticked. */
export function gradeLook(code: string): { tone: GradeTone; icon: string } {
  switch (code) {
    case 'EXCELLENT':
      return { tone: 'success', icon: '★' };
    case 'GOOD':
      return { tone: 'success', icon: '✓' };
    case 'FAIR':
      return { tone: 'warning', icon: '◐' };
    case 'WEAK':
    case 'POOR':
      return { tone: 'danger', icon: '▼' };
    default:
      return { tone: 'neutral', icon: '○' };
  }
}

/** A name with its code as a small note after it (the code is left out when it is the name, or when `code` is not given). */
export function Named({ name, code }: { name: string; code?: string | null | undefined }) {
  return (
    <span className="pwf-named">
      <span className="pwf-named__name">{name}</span>
      {code === undefined || code === null || code === '' || code === name ? null : <span className="pwf-code">{code}</span>}
    </span>
  );
}

/**
 * The name of a task. Its code (`PREP_DONE`) is not read on the screen (owner review of 17/11/2026): it stays on the element as the tooltip and as `data-task-code`, for whoever has to match it against a template or a report.
 * `children` is the name as the place shows it (a link); `note` is what the critical mark adds, shown as a small note under the name.
 */
export function TaskName({ name, code, note, children }: { name: string; code: string; note?: ReactNode; children?: ReactNode }) {
  const shown = typeof note === 'string' ? note.replace(/^[\s·]+/u, '') : note;
  const hasNote = shown !== undefined && shown !== null && shown !== false && shown !== '';
  return (
    <span className="pwf-taskname" title={code === '' || code === name ? undefined : code} data-task-code={code === '' ? undefined : code}>
      <span className="pwf-taskname__name">{children ?? name}</span>
      {hasNote ? <span className="pwf-hint pwf-taskname__code">{shown}</span> : null}
    </span>
  );
}

/** A name that carries its code as the tooltip only: a form, a document type, a figure. The code is the name only where no name is known. */
export function NamedTip({ name, code }: { name: string; code?: string | null | undefined }) {
  return (
    <span className="pwf-named" title={code === undefined || code === null || code === '' || code === name ? undefined : code}>
      <span className="pwf-named__name">{name}</span>
    </span>
  );
}

/** The name of a kind of project (or of the template of that kind) for a sentence: the name the shared catalogue gives the code, else the name the screens know for it, else the code. */
export function projectKindLabel(t: T, code: string, names?: ReadonlyMap<string, string>): string {
  return names?.get(code) ?? (templateKnown(code) ? templateName(t, code) : translator.has(`pwf6.fact.${codeKey(code)}.word`) ? factName(t, code) : code);
}

/**
 * The kind of project a template is for, by its name: the name the shared catalogue gives the code, else the name the screens know for it, and only then the code, marked as a code. Where a name is shown the code is a
 * small note under it, for whoever has to match it against the mapping rule.
 */
export function ProjectTypeName({ code, names }: { code: string; names: ReadonlyMap<string, string> }) {
  const { t } = useTranslation();
  const label = projectKindLabel(t, code, names);
  const name = label === code ? undefined : label;
  if (name === undefined) {
    return (
      <span className="pwf-code" data-project-type={code}>
        {code}
      </span>
    );
  }
  return (
    <span className="pwf-taskname" data-project-type={code} title={code}>
      <span className="pwf-taskname__name">{name}</span>
      {name === code ? null : <span className="pwf-code pwf-taskname__code">{code}</span>}
    </span>
  );
}

/**
 * A role by its name: the name the template gives it (`name`, a role a tenant made up itself), else the name of the shipped catalogue. Only a role neither of them names is shown as its code, marked as a code. The code stays on the
 * element (`data-role`, and the tooltip) for whoever needs it.
 */
export function RoleName({ code, name }: { code: string; name?: string | null | undefined }) {
  const { t } = useTranslation();
  const own = name?.trim() ?? '';
  if (own !== '') {
    return (
      <span data-role={code} title={code}>
        {own}
      </span>
    );
  }
  return roleKnown(code) ? <span data-role={code}>{roleName(t, code)}</span> : <span className="pwf-code" data-role={code}>{code}</span>;
}
