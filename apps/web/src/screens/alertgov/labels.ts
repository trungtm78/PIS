import { hasMessage } from '../../i18n';
import type { Translator } from '../../i18n';
import { camel } from './model';

type T = Translator['t'];

/**
 * The words of the codes the screens show. Each family is one function with its own head, so that the i18n check sees the whole family in use; a code this build does not know is shown as it came
 * (a new status of the server never makes a blank cell).
 */
export const kindText = (t: T, code: string): string => (hasMessage(`alertgov.kind.${camel(code)}`) ? t(`alertgov.kind.${camel(code)}`) : code);
export const triggerText = (t: T, code: string): string => (hasMessage(`alertgov.trigger.${camel(code)}`) ? t(`alertgov.trigger.${camel(code)}`) : code);
export const viaText = (t: T, code: string): string => (hasMessage(`alertgov.via.${camel(code)}`) ? t(`alertgov.via.${camel(code)}`) : code);
export const escalationStatusText = (t: T, code: string): string => (hasMessage(`alertgov.status.${camel(code)}`) ? t(`alertgov.status.${camel(code)}`) : code);
export const coverStatusText = (t: T, code: string): string => (hasMessage(`alertgov.cover.status.${camel(code)}`) ? t(`alertgov.cover.status.${camel(code)}`) : code);
export const coverageText = (t: T, code: string): string => (hasMessage(`alertgov.coverage.state.${camel(code)}`) ? t(`alertgov.coverage.state.${camel(code)}`) : code);
export const positionText = (t: T, code: string): string => (hasMessage(`alertgov.position.state.${camel(code)}`) ? t(`alertgov.position.state.${camel(code)}`) : code);
export const kpiStatusText = (t: T, code: string): string => (hasMessage(`alertgov.kpi.status.${camel(code)}`) ? t(`alertgov.kpi.status.${camel(code)}`) : code);
export const kpiName = (t: T, code: string): string => (hasMessage(`alertgov.kpi.name.${camel(code)}`) ? t(`alertgov.kpi.name.${camel(code)}`) : code);
export const kpiNote = (t: T, code: string): string => (hasMessage(`alertgov.kpi.note.${camel(code)}`) ? t(`alertgov.kpi.note.${camel(code)}`) : code);
export const partText = (t: T, code: string): string => {
  const suffix = camel(code.replace(/\d+/g, 'n'));
  return hasMessage(`alertgov.kpi.part.${suffix}`) ? t(`alertgov.kpi.part.${suffix}`, { days: code.match(/\d+/)?.[0] ?? '' }) : code;
};
export const absenceKindText = (t: T, code: string): string => (hasMessage(`alertgov.absence.kind.${camel(code)}`) ? t(`alertgov.absence.kind.${camel(code)}`) : code);
export const phaseText = (t: T, code: string): string => (hasMessage(`alertgov.absence.phase.${camel(code)}`) ? t(`alertgov.absence.phase.${camel(code)}`) : code);
export const severityText = (t: T, code: string): string => (hasMessage(`alertgov.severity.${camel(code)}`) ? t(`alertgov.severity.${camel(code)}`) : code);
export const channelText = (t: T, code: string): string => (hasMessage(`alertgov.channel.${camel(code)}`) ? t(`alertgov.channel.${camel(code)}`) : code);
export const sectionText = (t: T, code: string): string => (hasMessage(`alertgov.digest.section.${camel(code)}`) ? t(`alertgov.digest.section.${camel(code)}`) : code);
export const defectText = (t: T, code: string): string => (hasMessage(`alertgov.defect.${camel(code)}`) ? t(`alertgov.defect.${camel(code)}`) : code);
export const gapText = (t: T, code: string): string => (hasMessage(`alertgov.gap.kind.${camel(code)}`) ? t(`alertgov.gap.kind.${camel(code)}`) : code);
export const sourceText = (t: T, code: string): string => (hasMessage(`alerts.source.${camel(code)}`) ? t(`alerts.source.${camel(code)}`) : code);
