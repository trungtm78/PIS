import { translator, useTranslation } from '../../i18n';
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

const named = (t: T, key: string, fallback: string): string => (translator.has(key) ? t(key) : fallback);

/** Whether the catalogue has a name for the role (a role of a province's own template may have none). */
export const roleKnown = (code: string): boolean => translator.has(`pwf6.role.${codeKey(code)}.word`);
export const roleName = (t: T, code: string): string => named(t, `pwf6.role.${codeKey(code)}.word`, code);
/** The name of a phase: what the workflow or the template says first, else the name of the shipped phases, else the code. */
export const phaseName = (t: T, code: string, phases?: readonly { code: string; name: string }[]): string => phases?.find((phase) => phase.code === code)?.name ?? named(t, `pwf6.phase.${codeKey(code)}.word`, code);
export const evidenceKindName = (t: T, code: string): string => named(t, `pwf6.evidence.${codeKey(code)}.word`, code);
export const docTypeName = (t: T, code: string): string => named(t, `pwf6.doc.${codeKey(code)}.word`, code);
export const docTypeKnown = (code: string): boolean => translator.has(`pwf6.doc.${codeKey(code)}.word`);
export const historyName = (t: T, kind: string): string => named(t, `pwf6.history.${codeKey(kind)}.word`, kind);
export const gradeName = (t: T, code: string): string => named(t, `pwf6.grade.${codeKey(code)}.word`, code);
export const templateName = (t: T, code: string): string => named(t, `pwf6.template.${codeKey(code)}.word`, code);
export const templateKnown = (code: string): boolean => translator.has(`pwf6.template.${codeKey(code)}.word`);
export const kpiName = (t: T, code: string): string => named(t, `pwf6.kpi.${codeKey(code)}.word`, code);
export const factName = (t: T, code: string): string => named(t, `pwf6.fact.${codeKey(code)}.word`, code);
export const fieldName = (t: T, field: string): string => named(t, `pwf6.field.${codeKey(field)}.word`, field);

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

/** A role by its name; a role the catalogue has no name for is shown as its code, marked as a code. */
export function RoleName({ code }: { code: string }) {
  const { t } = useTranslation();
  return roleKnown(code) ? <span data-role={code}>{roleName(t, code)}</span> : <span className="pwf-code" data-role={code}>{code}</span>;
}
