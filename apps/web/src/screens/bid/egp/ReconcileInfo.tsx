import { useTranslation } from '../../../i18n';
import { InfoFormula } from '../../../ui';
import type { InfoFormulaLabels } from '../../../ui';
import { instantDay, instantTime } from './mapping-model';
import type { ReconcilePage } from './reconcile-model';

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
    version: t('egp.reconcile.info.version.label'),
    unverified: t('egp.reconcile.info.unverified.text'),
  };
}

const stamp = (instant: string, none: string): string => (instant === '' ? none : `${instantDay(instant)} ${instantTime(instant)}`.trim());

/** The version line of the rule that decides the due time: where its numbers come from and whether anybody confirmed them. */
function useVersion(page: ReconcilePage): string {
  const { t } = useTranslation();
  const legal = page.dueRule.legalStatus === '' ? t('egp.reconcile.cell.none') : page.dueRule.legalStatus;
  return page.dueRule.source === 'RULE' ? t('egp.reconcile.info.version.rule', { version: page.dueRule.version, legal }) : t('egp.reconcile.info.version.default', { version: page.dueRule.version, legal });
}

/** The "i" of the count of open and overdue items: the formula, the source, the day it is as of, who answers for it and the rule behind the due time. */
export function CountInfo({ page }: { page: ReconcilePage }) {
  const { t } = useTranslation();
  const labels = useLabels();
  const name = t('egp.reconcile.info.count.name');
  const version = useVersion(page);
  return (
    <InfoFormula
      name={name}
      formula={t('egp.reconcile.info.count.formula')}
      source={page.source === '' ? t('egp.reconcile.cell.none') : page.source}
      asOf={stamp(page.asOf, t('egp.reconcile.cell.none'))}
      owner={t('egp.reconcile.info.owner.text')}
      version={version}
      unverified={page.dueRule.unverified}
      labels={{ ...labels, open: t('egp.mapping.info.open.label', { name }) }}
    />
  );
}

/** The "i" of a difference of an amount: theirs minus ours, exact to the dong, from the records the files said. */
export function DeltaInfo({ page }: { page: ReconcilePage }) {
  const { t } = useTranslation();
  const labels = useLabels();
  const name = t('egp.reconcile.info.delta.name');
  const version = useVersion(page);
  return (
    <InfoFormula
      name={name}
      formula={page.formula === '' ? t('egp.reconcile.info.delta.formula') : page.formula}
      source={page.source === '' ? t('egp.reconcile.cell.none') : page.source}
      asOf={stamp(page.asOf, t('egp.reconcile.cell.none'))}
      owner={t('egp.reconcile.info.owner.text')}
      version={version}
      unverified
      labels={{ ...labels, open: t('egp.mapping.info.open.label', { name }) }}
    />
  );
}

/** The "i" of the due time: the rule that gives the working days, its source and the flag that its numbers are ours and unconfirmed. */
export function DueInfo({ page }: { page: ReconcilePage }) {
  const { t } = useTranslation();
  const labels = useLabels();
  const name = t('egp.reconcile.info.due.name');
  const version = useVersion(page);
  return (
    <InfoFormula
      name={name}
      formula={page.dueRule.formula === '' ? t('egp.reconcile.info.due.formula') : page.dueRule.formula}
      source={page.dueRule.sourceText === '' ? t('egp.reconcile.cell.none') : page.dueRule.sourceText}
      asOf={page.dueRule.asOf === '' ? stamp(page.asOf, t('egp.reconcile.cell.none')) : page.dueRule.asOf.length > 10 ? stamp(page.dueRule.asOf, t('egp.reconcile.cell.none')) : instantDay(page.dueRule.asOf)}
      owner={t('egp.reconcile.info.owner.text')}
      version={version}
      unverified={page.dueRule.unverified}
      labels={{ ...labels, open: t('egp.mapping.info.open.label', { name }) }}
    />
  );
}
