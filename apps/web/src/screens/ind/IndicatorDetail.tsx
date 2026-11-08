import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import { useScreenState } from '../../states/useScreenState';
import { SectionCard, StatusPill } from '../../ui';
import { GovernanceLink, OriginBadge, StateNote, VersionTable } from './ind-components';
import { useIndicatorDetail } from './ind-hooks';
import { categoryLabel, checkLabel, periodLabel, surfaceLabel, unitLabel, valueKindLabel, vatLabel } from './ind-labels';
import { DASH, PATH_MAPPINGS, PATH_RULES, vietnamDateTime } from './ind-model';
import type { Indicator } from './ind-model';
import './ind.css';

function Facts({ indicator }: { indicator: Indicator }) {
  const { t } = useTranslation();
  const rows: Array<[string, string]> = [
    [t('ind.dict.detail.code'), indicator.code],
    [t('ind.dict.detail.formula'), indicator.formula || DASH],
    [t('ind.dict.detail.numerator'), indicator.numerator ?? DASH],
    [t('ind.dict.detail.denominator'), indicator.denominator ?? DASH],
    [t('ind.dict.detail.exclusions'), indicator.exclusions.length === 0 ? DASH : indicator.exclusions.join('; ')],
    [t('ind.dict.detail.unit'), `${unitLabel(t, indicator.unit)} (${t('ind.dict.detail.decimals', { n: indicator.decimals })})`],
    [t('ind.dict.detail.period'), periodLabel(t, indicator.period)],
    [t('ind.dict.detail.owner'), indicator.owner || DASH],
    [t('ind.dict.detail.source'), indicator.source || DASH],
    [t('ind.dict.detail.kind'), valueKindLabel(t, indicator.valueKind)],
    [t('ind.dict.detail.category'), indicator.category === null ? DASH : categoryLabel(t, indicator.category)],
    [t('ind.dict.detail.entryField'), indicator.entryField ?? DASH],
    [t('ind.dict.detail.vat'), vatLabel(t, indicator.vatBasis)],
    [t('ind.dict.detail.aliases'), indicator.aliases.length === 0 ? DASH : indicator.aliases.join('; ')],
    [t('ind.dict.detail.requiredOn'), indicator.requiredOn.length === 0 ? DASH : indicator.requiredOn.map((surface) => surfaceLabel(t, surface)).join('; ')],
    [t('ind.dict.detail.version'), indicator.version === 0 ? t('ind.dict.detail.versionDefault') : t('ind.dict.detail.versionNumber', { n: indicator.version })],
    [t('ind.dict.detail.effective'), indicator.effectiveFrom === null ? DASH : `${indicator.effectiveFrom} → ${indicator.effectiveTo ?? DASH}`],
  ];
  return (
    <dl className="ind-facts" data-testid="indicator-facts">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * One indicator of the dictionary (IND-01): its definition as the KPI register holds it, how the figure is obtained and entered, whether it is the platform's starting value nobody confirmed, where it is used and
 * the history of its versions with who made and who approved each. A definition is changed through the governance rules, never here.
 */
export function IndicatorDetail({ code, onClose, onEnter }: { code: string; onClose: () => void; onEnter: (code: string) => void }) {
  const { t } = useTranslation();
  const detail = useIndicatorDetail(code);
  const heading = useRef<HTMLDivElement>(null);
  const state = useScreenState({ isLoading: detail.isLoading, error: detail.data === undefined ? detail.error : undefined, data: detail.data ?? null, isEmpty: () => false });
  const data = detail.data;
  useEffect(() => {
    heading.current?.focus();
  }, [code]);
  const title = data === undefined ? t('ind.dict.detail.titlePlain') : t('ind.dict.detail.title', { name: data.indicator.name });
  return (
    <SectionCard
      title={title}
      actions={
        <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={onClose}>
          {t('ind.dict.detail.close')}
        </button>
      }
    >
      <div data-testid="indicator-detail" role="group" aria-label={title} aria-live="polite" tabIndex={-1} ref={heading}>
        <StateNote
          state={state}
          name="detail"
          texts={{ loading: t('ind.dict.detail.loading'), denied: t('ind.dict.detail.denied'), error: t('ind.dict.detail.error') }}
          onRetry={() => void detail.refetch()}
        />
        {state === 'default' && data === undefined ? (
          <p className="callout warning" role="alert" data-testid="detail-missing">
            {t('ind.dict.detail.error')}
          </p>
        ) : null}
        {state === 'default' && data !== undefined ? (
          <>
            <p className="ind-chips">
              <OriginBadge origin={data.indicator.origin} unverified={data.indicator.unverified} />
              <StatusPill tone={data.indicator.enterable ? 'info' : 'neutral'}>{data.indicator.enterable ? t('ind.dict.detail.enterable') : t('ind.dict.detail.derived')}</StatusPill>
              {data.asOf === null ? null : <span className="sub">{t('ind.dict.detail.asOf', { time: vietnamDateTime(data.asOf) })}</span>}
            </p>
            {data.indicator.origin === 'DEFAULT' && data.indicator.unverified ? (
              <p className="callout warning" role="status" data-testid="detail-unverified">
                {t('ind.dict.detail.unverified')}
              </p>
            ) : null}
            <Facts indicator={data.indicator} />
            {data.indicator.enterable ? (
              <div className="ind-actions">
                <button type="button" className="ui-button ui-button--outline" onClick={() => onEnter(data.indicator.code)}>
                  {t('ind.dict.detail.enter')}
                </button>
              </div>
            ) : (
              <p className="sub" data-testid="detail-derived-note">
                {t('ind.dict.detail.derivedNote')}
              </p>
            )}
            <h3>{t('ind.dict.usage.title')}</h3>
            <div className="ind-usage" data-testid="indicator-usage">
              <div>
                <h4>{t('ind.dict.usage.rules')}</h4>
                {data.usage.rules.length === 0 ? (
                  <p className="sub">{t('ind.dict.usage.none')}</p>
                ) : (
                  <ul>
                    {data.usage.rules.map((rule) => (
                      <li key={rule.code} data-rule={rule.code}>
                        {rule.code} ({checkLabel(t, rule.check)}) — {rule.active ? t('ind.dict.usage.active') : t('ind.dict.usage.template')}
                      </li>
                    ))}
                  </ul>
                )}
                <Link to={PATH_RULES}>{t('ind.dict.usage.rulesLink')}</Link>
              </div>
              <div>
                <h4>{t('ind.dict.usage.mappings')}</h4>
                {data.usage.mappings.length === 0 ? (
                  <p className="sub">{t('ind.dict.usage.none')}</p>
                ) : (
                  <ul>
                    {data.usage.mappings.map((mapping) => (
                      <li key={`${mapping.code}:${mapping.source}`} data-mapping={mapping.code}>
                        {mapping.code}: {mapping.source} — {mapping.active ? t('ind.dict.usage.active') : t('ind.dict.usage.template')}
                      </li>
                    ))}
                  </ul>
                )}
                <Link to={PATH_MAPPINGS}>{t('ind.dict.usage.mappingsLink')}</Link>
              </div>
            </div>
            <h3>{t('ind.dict.versions.title')}</h3>
            <VersionTable versions={data.versions} caption={t('ind.dict.versions.caption')} />
            <GovernanceLink />
          </>
        ) : null}
      </div>
    </SectionCard>
  );
}
