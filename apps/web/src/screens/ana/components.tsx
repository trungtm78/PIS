import { useTranslation } from '../../i18n';
import { InfoFormula, StatusPill } from '../../ui';
import type { InfoFormulaLabels } from '../../ui';
import { dayText } from './common';
import type { AnaInfo } from './common';
import './ana.css';

/** The words of the "i" control: the same keys the BI figures use, so a number says its formula, source and day the same way on every screen. */
export function useInfoLabels(): (name: string) => InfoFormulaLabels {
  const { t } = useTranslation();
  return (name) => ({
    open: t('govc.bi.info.open', { name }),
    close: t('govc.bi.info.close'),
    formula: t('govc.bi.info.formula'),
    numerator: t('govc.bi.info.numerator'),
    denominator: t('govc.bi.info.denominator'),
    exclusions: t('govc.bi.info.exclusions'),
    source: t('govc.bi.info.source'),
    asOf: t('govc.bi.info.asOf'),
    owner: t('govc.bi.info.owner'),
    version: t('govc.bi.info.version'),
    unverified: t('govc.bi.register.unverified'),
  });
}

/** The "i" of a number of the executive analytics: formula, source, the day it is as of, the version of the rule (0 is the default of the platform) and the not-confirmed flag. */
export function AnaFigureInfo({ name, info, asOf }: { name: string; info: AnaInfo | undefined; asOf?: string | null | undefined }) {
  const { t } = useTranslation();
  const labels = useInfoLabels();
  if (info === undefined) return null;
  return (
    <InfoFormula
      name={name}
      formula={info.formula}
      source={info.source}
      asOf={dayText(asOf ?? info.asOf)}
      owner={t('ana.common.owner')}
      version={info.ruleVersion === 'builtin' ? t('ana.common.version.builtin') : t('ana.common.version.rule', { version: info.ruleVersion })}
      unverified={info.unverified}
      labels={labels(name)}
    />
  );
}

/** A note that says why a figure is missing (never 0 and never green): the reason code of the server becomes words through the map of the screen. */
export function NaNote({ reason, label }: { reason: string | null; label: (reason: string) => string }) {
  const { t } = useTranslation();
  if (reason === null) return null;
  return (
    <p className="ana-na" role="status" data-testid="ana-na" data-reason={reason}>
      <StatusPill tone="neutral">{t('ana.common.na')}</StatusPill> {label(reason)}
    </p>
  );
}

/** Said on every screen whose numbers come from a rule the tenant has not approved yet (a starting value of the research). */
export function UnverifiedNote({ unverified }: { unverified: boolean }) {
  const { t } = useTranslation();
  if (!unverified) return null;
  return (
    <p className="ana-unverified" role="status" data-testid="ana-unverified">
      <StatusPill tone="warning">{t('ana.common.unverified.pill')}</StatusPill> {t('ana.common.unverified.body')}
    </p>
  );
}
