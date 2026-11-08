import { useTranslation } from '../../../i18n';
import { InfoFormula } from '../../../ui';
import type { InfoFormulaLabels } from '../../../ui';
import { instantDay, instantTime, likenessText } from './mapping-model';
import type { SuggestionList } from './mapping-model';

/**
 * The "i" of a likeness (the confidence of a suggestion): the formula, the source, the threshold and the legal status. The numbers are our own and nobody has verified them, so the
 * panel says it is a hint that a person confirms. With the suggestion list at hand its words are the server's; without it the screen's own words stand.
 */
export function Likeness({ asOf, list }: { asOf: string; list?: SuggestionList | undefined }) {
  const { t, locale } = useTranslation();
  const name = t('egp.mapping.info.name.text');
  const labels: InfoFormulaLabels = {
    open: t('egp.mapping.info.open.label', { name }),
    close: t('egp.mapping.info.close.label'),
    formula: t('egp.mapping.info.formula.label'),
    numerator: t('egp.mapping.info.numerator.label'),
    denominator: t('egp.mapping.info.denominator.label'),
    exclusions: t('egp.mapping.info.exclusions.label'),
    source: t('egp.mapping.info.source.label'),
    asOf: t('egp.mapping.info.asOf.label'),
    owner: t('egp.mapping.info.owner.label'),
    version: t('egp.mapping.info.threshold.label'),
    unverified: t('egp.mapping.info.unverified.text'),
  };
  const day = asOf === '' ? t('egp.mapping.cell.none') : `${instantDay(asOf)} ${instantTime(asOf)}`.trim();
  return (
    <InfoFormula
      name={name}
      formula={list === undefined || list.formula === '' ? t('egp.mapping.info.formula.text') : list.formula}
      source={list === undefined || list.source === '' ? t('egp.mapping.info.source.text') : list.source}
      asOf={day}
      owner={t('egp.mapping.info.owner.text')}
      version={list === undefined ? t('egp.mapping.info.legal.text') : t('egp.mapping.info.threshold.text', { threshold: likenessText(list.threshold, locale), legal: list.legalStatus === '' ? t('egp.mapping.cell.none') : list.legalStatus })}
      unverified
      labels={labels}
    />
  );
}
