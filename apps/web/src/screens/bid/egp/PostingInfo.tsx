import { useTranslation } from '../../../i18n';
import { InfoFormula } from '../../../ui';
import type { InfoFormulaLabels } from '../../../ui';
import { rateText, stamp } from './posting-model';
import type { PostingDetail, PostingPage, Provenance } from './posting-model';

function useLabels(): InfoFormulaLabels {
  const { t } = useTranslation();
  return {
    open: '',
    close: t('egp.mapping.info.close.label'),
    formula: t('egp.mapping.info.formula.label'),
    numerator: t('egp.mapping.info.numerator.label'),
    denominator: t('egp.mapping.info.denominator.label'),
    exclusions: t('egp.mapping.info.exclusions.label'),
    source: t('egp.mapping.info.source.label'),
    asOf: t('egp.mapping.info.asOf.label'),
    owner: t('egp.mapping.info.owner.label'),
    version: t('egp.posting.info.version.label'),
    unverified: t('egp.posting.info.unverified.text'),
  };
}

/** The version line of a rule: which version decided, whether it is the built-in default or a rule of the agency, and its legal status. */
function useVersion(rule: Provenance): string {
  const { t } = useTranslation();
  const legal = rule.legalStatus === '' ? t('egp.posting.cell.none') : rule.legalStatus;
  return rule.source === 'RULE' ? t('egp.posting.info.version.rule', { version: rule.version, legal }) : t('egp.posting.info.version.default', { version: rule.version, legal });
}

/** The "i" of the rate "posted on time": the formula, what is above and below the line, the source, the day it is as of, who answers for it and the rule behind the deadlines. */
export function RateInfo({ page }: { page: PostingPage }) {
  const { t } = useTranslation();
  const labels = useLabels();
  const name = t('egp.posting.info.rate.name');
  const version = useVersion(page.severityRule);
  return (
    <InfoFormula
      name={name}
      formula={page.onTime.formula === '' ? t('egp.posting.info.rate.formula') : page.onTime.formula}
      numerator={t('egp.posting.info.rate.numerator', { value: page.onTime.met })}
      denominator={t('egp.posting.info.rate.denominator', { value: page.onTime.met + page.onTime.metLate + page.onTime.overdue })}
      exclusions={[t('egp.posting.info.rate.exclusionOpen'), t('egp.posting.info.rate.exclusionCancelled')]}
      source={page.onTime.source === '' ? t('egp.posting.cell.none') : page.onTime.source}
      asOf={stamp(page.asOf)}
      owner={t('egp.posting.info.owner.text')}
      version={version}
      unverified
      labels={{ ...labels, open: t('egp.mapping.info.open.label', { name }) }}
    />
  );
}

/** The "i" of the urgency: how close to the deadline a duty turns urgent, by the rule `EGP_POSTING_SEVERITY` (our own number, unverified). */
export function UrgencyInfo({ page }: { page: PostingPage }) {
  const { t } = useTranslation();
  const labels = useLabels();
  const name = t('egp.posting.info.urgency.name');
  const rule = page.severityRule;
  return (
    <InfoFormula
      name={name}
      formula={rule.formula === '' ? t('egp.posting.info.urgency.formula', { hours: rule.urgentWithinHours }) : rule.formula}
      source={rule.sourceText === '' ? t('egp.posting.cell.none') : rule.sourceText}
      asOf={rule.asOf === '' ? stamp(page.asOf) : rule.asOf}
      owner={t('egp.posting.info.owner.text')}
      version={useVersion(rule)}
      unverified={rule.unverified}
      labels={{ ...labels, open: t('egp.mapping.info.open.label', { name }) }}
    />
  );
}

/** The "i" of a deadline: the rule that gives it (how many days of which kind from which fact), its version and the flag that its numbers are a default nobody confirmed against the legal text. */
export function DeadlineInfo({ detail }: { detail: PostingDetail }) {
  const { t } = useTranslation();
  const labels = useLabels();
  const name = t('egp.posting.info.deadline.name');
  const rule = detail.deadlineRule;
  return (
    <InfoFormula
      name={name}
      formula={rule.formula === '' ? t('egp.posting.info.deadline.formula') : rule.formula}
      source={rule.sourceText === '' ? t('egp.posting.cell.none') : rule.sourceText}
      asOf={rule.asOf === '' ? stamp(detail.asOf) : rule.asOf}
      owner={t('egp.posting.info.owner.text')}
      version={useVersion(rule)}
      unverified={rule.unverified}
      labels={{ ...labels, open: t('egp.mapping.info.open.label', { name }) }}
    />
  );
}

/** The rate as it is written on the card. */
export function RateValue({ page }: { page: PostingPage }) {
  const { t, locale } = useTranslation();
  const text = rateText(page.onTime.rateBp, locale);
  return <span data-testid="rate-value">{text === null ? t('egp.posting.figure.rate.none') : text}</span>;
}
