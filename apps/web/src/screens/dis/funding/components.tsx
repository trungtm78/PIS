import type { ReactNode } from 'react';
import { useTranslation } from '../../../i18n';
import { InfoFormula, KpiTile } from '../../../ui';
import type { InfoFormulaLabels } from '../../../ui';
import { money, percent, camel } from './model';
import type { Rate } from './model';

/** The words of the "i" on every number of the funding screens: formula, source and the day the number is as of (FND-1 I8). */
export function useInfoLabels(): (name: string) => InfoFormulaLabels {
  const { t } = useTranslation();
  return (name) => ({
    open: t('dis.funding.info.open', { name }),
    close: t('dis.funding.info.close'),
    formula: t('dis.funding.info.formula'),
    numerator: t('dis.funding.info.numerator'),
    denominator: t('dis.funding.info.denominator'),
    exclusions: t('dis.funding.info.exclusions'),
    source: t('dis.funding.info.source'),
    asOf: t('dis.funding.info.asOf'),
    owner: t('dis.funding.info.owner'),
    version: t('dis.funding.info.version'),
    unverified: t('dis.funding.info.unverified'),
  });
}

export interface FigureInfoProps {
  /** The code of the figure or of the indicator: the formula sentence and the name are under it. */
  code: string;
  asOf: string;
  packCode: string;
  version: number;
  unverified: boolean;
  /** The terms of a ratio, when it is one. */
  numeratorTerm?: string | undefined;
  denominatorTerm?: string | undefined;
  /** Where the number is read from: the basis of a ratio or a kind of figure. */
  source: string;
}

/** The "i" of a figure: the sentence of its formula by code, the terms above and below the line, its source, the day and the version of the pack (the formula is the kernel's sentence, never typed on a screen). */
export function FigureInfo(props: FigureInfoProps) {
  const { t } = useTranslation();
  const labels = useInfoLabels();
  const name = t(`dis.funding.figure.${camel(props.code)}`);
  return (
    <InfoFormula
      name={name}
      formula={t(`dis.funding.formula.${camel(props.code)}`)}
      numerator={props.numeratorTerm === undefined ? null : t(`dis.funding.term.${camel(props.numeratorTerm)}`)}
      denominator={props.denominatorTerm === undefined ? null : t(`dis.funding.term.${camel(props.denominatorTerm)}`)}
      source={props.source}
      asOf={props.asOf}
      owner={t('dis.funding.info.owner.value')}
      version={t('dis.funding.info.version.value', { pack: props.packCode, version: props.version })}
      unverified={props.unverified}
      labels={labels(name)}
    />
  );
}

export function RateTile({ rate, version, unverified }: { rate: Rate; version: number; unverified: boolean }) {
  const { t } = useTranslation();
  const label = rate.class_code === null ? t(`dis.funding.figure.${camel(rate.code)}`) : t('dis.funding.share.label', { name: t(`dis.funding.figure.${camel(rate.code)}`), class: rate.class_code });
  const value = percent(rate.rate_pct);
  return (
    <KpiTile
      label={label}
      value={value}
      sub={
        <>
          {rate.null_reason === null ? <span>{t('dis.funding.rate.sub', { numerator: money(rate.numerator_vnd), denominator: money(rate.denominator_vnd) })}</span> : <span data-testid={`reason-${rate.code}`}>{t(`dis.funding.reason.${camel(rate.null_reason)}`)}</span>}{' '}
          <FigureInfo code={rate.code} asOf={rate.as_of} packCode={rate.pack_code} version={version} unverified={unverified} numeratorTerm={rate.numerator_term} denominatorTerm={rate.denominator_term} source={t(`dis.funding.basis.${camel(rate.basis)}`)} />
        </>
      }
    />
  );
}

export function Banner({ tone, children, testId }: { tone: 'info' | 'warning'; children: ReactNode; testId?: string }) {
  return (
    <p className={`dis-funding-banner dis-funding-banner--${tone}`} role="status" data-testid={testId}>
      {children}
    </p>
  );
}
