import { hasMessage } from '../../../i18n';
import type { useTranslation } from '../../../i18n';
import type { InfoFormulaLabels } from '../../../ui';
import { statusText } from '../labels';
import { camel } from './model';
import type { Definition, FigureValue } from './model';

type Translate = ReturnType<typeof useTranslation>['t'];

/** The heading of a column of a report; each family of keys is written as a template so that the i18n check sees the whole family in use. */
export const columnLabel = (t: Translate, key: string): string => t(`ca1.col.${camel(key)}`);

/** The title of a report of the catalogue. */
export const reportTitle = (t: Translate, code: string): string => t(`ca1.report.${camel(code)}.title`);

/** What a report is for, in one line (the hub shows it under the title). */
export const reportLead = (t: Translate, code: string): string => t(`ca1.report.${camel(code)}.lead`);

/** Why a figure is not there: the reason of the server in words. A reason the screen has no word for is shown as it came, never hidden. */
export function reasonText(t: Translate, reason: string): string {
  return hasMessage(`ca1.na.${camel(reason)}`) ? t(`ca1.na.${camel(reason)}`) : reason;
}

/** A group of a breakdown (a status of a contract, a band of delay, of bidders, of age, a tier). */
export function groupLabel(t: Translate, dimension: string, key: string): string {
  if (dimension === 'contract_status') return statusText(t, key);
  return hasMessage(`ca1.group.${camel(key)}`) ? t(`ca1.group.${camel(key)}`) : key;
}

export const dimensionLabel = (t: Translate, dimension: string): string => t(`ca1.dimension.${camel(dimension)}`);

/** The level of a concentration or of the health of a contract. */
export const levelLabel = (t: Translate, level: string | null): string => (level === null ? t('ca1.level.none') : t(`ca1.level.${camel(level)}`));

/** The name of an indicator: the Vietnamese key when the screen has one, the name the server sent otherwise. */
export function indicatorName(t: Translate, definition: Definition): string {
  return hasMessage(`ca1.indicator.${camel(definition.code)}.name`) ? t(`ca1.indicator.${camel(definition.code)}.name`) : definition.name;
}

/** The labels of the "i" of a figure. */
export function infoLabels(t: Translate, name: string): InfoFormulaLabels {
  return {
    open: t('ca1.info.open', { name }),
    close: t('ca1.info.close'),
    formula: t('ca1.info.formula'),
    numerator: t('ca1.info.numerator'),
    denominator: t('ca1.info.denominator'),
    exclusions: t('ca1.info.exclusions'),
    source: t('ca1.info.source'),
    asOf: t('ca1.info.asOf'),
    owner: t('ca1.info.owner'),
    version: t('ca1.info.version'),
    unverified: t('ca1.info.unverified'),
  };
}

/** The text of one part of a definition: the Vietnamese key of the indicator when it exists, else the text the server sent (kernel, English). */
export function definitionText(t: Translate, definition: Definition, part: 'formula' | 'numerator' | 'denominator' | 'nullPolicy'): string | null {
  if (hasMessage(`ca1.indicator.${camel(definition.code)}.${part}`)) return t(`ca1.indicator.${camel(definition.code)}.${part}`);
  const sent = part === 'formula' ? definition.formula : part === 'numerator' ? definition.numerator : part === 'denominator' ? definition.denominator : definition.nullPolicy;
  return sent === '' ? null : sent;
}

/** A figure of a concentration (a share, an index) as text: the value, or the reason it has none. */
export function figureText(t: Translate, figure: FigureValue, kind: 'percent' | 'index', locale: string): string {
  if (figure.value === null) return figure.reason === null ? t('ca1.na.noRows') : reasonText(t, figure.reason);
  const shown = locale === 'vi' ? figure.value.replace('.', ',') : figure.value;
  return kind === 'percent' ? `${shown}%` : shown;
}
