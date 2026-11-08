import { useTranslation } from '../../../i18n';
import { InfoFormula, StatusPill } from '../../../ui';
import type { InfoFormulaLabels } from '../../../ui';
import { signatureState } from './rptGov12Model';
import type { LockRule, SignatureFacts } from './rptGov12Model';
import './rptGov12.css';

/** The "i" of a figure of the period lock rule: formula, source, day, owner, version and the sentence that says the numbers are a default nobody confirmed. */
export function RuleInfo({ name, formula, asOf, rule }: { name: string; formula: string; asOf: string; rule: LockRule }) {
  const { t } = useTranslation();
  const labels: InfoFormulaLabels = {
    open: t('rpt.lock.info.open', { name }),
    close: t('rpt.lock.info.close'),
    formula: t('rpt.lock.info.formula'),
    numerator: t('rpt.lock.info.numerator'),
    denominator: t('rpt.lock.info.denominator'),
    exclusions: t('rpt.lock.info.exclusions'),
    source: t('rpt.lock.info.source'),
    asOf: t('rpt.lock.info.asOf'),
    owner: t('rpt.lock.info.owner'),
    version: t('rpt.lock.info.version'),
    unverified: t('rpt.lock.info.unverified'),
  };
  return (
    <InfoFormula
      name={name}
      formula={formula}
      source={t('rpt.lock.info.source.text')}
      asOf={asOf}
      owner={t('rpt.lock.info.owner.text')}
      version={rule.version === 0 ? t('rpt.lock.info.version.default') : t('rpt.lock.info.version.rule', { version: rule.version })}
      unverified={rule.unverified}
      labels={labels}
    />
  );
}

/** The signature of a copy as a word and a pill: a test signature says in words that it does not count for the Ministry. */
export function SignaturePill({ facts }: { facts: Pick<SignatureFacts, 'signed' | 'signature' | 'open_session_id'> | undefined }) {
  const { t } = useTranslation();
  const state = signatureState(facts);
  switch (state) {
    case 'signed':
      return <StatusPill tone="success">{t('rpt.lock.signature.signed')}</StatusPill>;
    case 'test':
      return <StatusPill tone="warning">{t('rpt.lock.signature.test')}</StatusPill>;
    case 'inProgress':
      return <StatusPill tone="info">{t('rpt.lock.signature.inProgress')}</StatusPill>;
    default:
      return <StatusPill tone="neutral">{t('rpt.lock.signature.unsigned')}</StatusPill>;
  }
}

export function LockPill({ open }: { open: boolean | undefined }) {
  const { t } = useTranslation();
  if (open === undefined) return <StatusPill tone="neutral">{t('rpt.lock.state.none')}</StatusPill>;
  return open ? <StatusPill tone="danger">{t('rpt.lock.state.locked')}</StatusPill> : <StatusPill tone="neutral">{t('rpt.lock.state.released')}</StatusPill>;
}
