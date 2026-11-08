import type { ReactNode } from 'react';
import { useTranslation } from '../../../i18n';
import { InfoFormula, StatusPill } from '../../../ui';
import type { InfoFormulaLabels } from '../../../ui';
import { noticeTone, responseTone, word } from './prjModel';
import type { NoticeView, ResponseView } from './prjModel';
import './prj.css';

export interface ProvenanceProps {
  name: string;
  formula: string;
  source: string;
  asOf: string;
  /** The version of the rule that fixed the number; 0 is the built-in default. */
  version: number;
  unverified: boolean;
  owner: string;
}

/** The "i" of a figure: the formula in words, the source, the day, the owner and the version of the rule, and "default, not confirmed" while nobody confirmed the numbers. */
export function Provenance({ name, formula, source, asOf, version, unverified, owner }: ProvenanceProps) {
  const { t } = useTranslation();
  const labels: InfoFormulaLabels = {
    open: t('prj.info.panel.open', { name }),
    close: t('prj.info.panel.close'),
    formula: t('prj.info.panel.formula'),
    numerator: t('prj.info.panel.numerator'),
    denominator: t('prj.info.panel.denominator'),
    exclusions: t('prj.info.panel.exclusions'),
    source: t('prj.info.panel.source'),
    asOf: t('prj.info.panel.asOf'),
    owner: t('prj.info.panel.owner'),
    version: t('prj.info.panel.version'),
    unverified: t('prj.info.panel.unverified'),
  };
  return <InfoFormula name={name} formula={formula} source={source} asOf={asOf} owner={owner} version={version === 0 ? t('prj.info.version.default') : t('prj.info.version.rule', { version })} unverified={unverified} labels={labels} />;
}

/** A figure with its "i" next to it. */
export function Figure({ label, children, info, testId }: { label: string; children: ReactNode; info?: ReactNode; testId?: string }) {
  return (
    <div className="prj-figure">
      <span className="prj-figure__label">{label}</span>
      <span className="prj-figure__value" data-testid={testId}>
        {children}
      </span>
      {info}
    </div>
  );
}

export function Facts({ items }: { items: ReadonlyArray<{ label: string; value: ReactNode; testId?: string }> }) {
  return (
    <dl className="prj-facts">
      {items.map((item) => (
        <div key={item.label} className="prj-facts__item">
          <dt>{item.label}</dt>
          <dd data-testid={item.testId}>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function NoticePill({ notice }: { notice: NoticeView }) {
  const { t } = useTranslation();
  return <StatusPill tone={noticeTone(notice.state)}>{t(`prj.common.notice.${word(notice.state)}`)}</StatusPill>;
}

export function ResponsePill({ response }: { response: ResponseView }) {
  const { t } = useTranslation();
  return <StatusPill tone={responseTone(response.state)}>{t(`prj.common.response.${word(response.state)}`)}</StatusPill>;
}

/** Previous and next page of a list read by offset. */
export function Pager({ offset, size, hasMore, onOffset }: { offset: number; size: number; hasMore: boolean; onOffset: (offset: number) => void }) {
  const { t } = useTranslation();
  if (offset === 0 && !hasMore) return null;
  return (
    <nav className="prj-pager" aria-label={t('prj.common.pager.label')}>
      <button type="button" className="ui-button ui-button--outline ui-button--small" disabled={offset === 0} onClick={() => onOffset(Math.max(0, offset - size))}>
        {t('prj.common.pager.previous')}
      </button>
      <span>{t('prj.common.pager.page', { page: Math.floor(offset / size) + 1 })}</span>
      <button type="button" className="ui-button ui-button--outline ui-button--small" disabled={!hasMore} onClick={() => onOffset(offset + size)}>
        {t('prj.common.pager.next')}
      </button>
    </nav>
  );
}

/** The days left or late, in words. */
export function DaysText({ left, late }: { left: number | null; late: number | null }) {
  const { t } = useTranslation();
  if (late !== null && late > 0) return <>{t('prj.common.days.late', { days: late })}</>;
  if (left === null) return <>–</>;
  if (left < 0) return <>{t('prj.common.days.late', { days: -left })}</>;
  return <>{t('prj.common.days.left', { days: left })}</>;
}
