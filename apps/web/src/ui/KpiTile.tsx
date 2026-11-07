import type { ReactNode } from 'react';
import { useTranslation } from '../i18n';
import { toneClass } from './types';
import type { Tone, UiState } from './types';

export interface KpiTileProps {
  icon?: ReactNode;
  label: string;
  value: string;
  unit?: string;
  sub?: ReactNode;
  tone?: Tone;
  href?: string;
  state?: UiState;
  onRetry?: () => void;
}

/** A KPI card: coloured round icon tile, uppercase label, big number with its unit and a sub line. */
export function KpiTile({ icon, label, value, unit, sub, tone, href, state = 'ready', onRetry }: KpiTileProps) {
  const { t } = useTranslation();
  const root = `ui-kpi ${toneClass(tone)}`;
  if (state === 'loading') {
    return (
      <div className={`${root} ui-kpi--loading`} role="status" aria-busy="true" aria-label={t('ui.kpiTile.loading', { label })}>
        <span className="ui-kpi__icon ui-skeleton" aria-hidden="true" />
        <div className="ui-kpi__body">
          <span className="ui-skeleton ui-skeleton--line ui-skeleton--short" />
          <span className="ui-skeleton ui-skeleton--big" />
          <span className="ui-skeleton ui-skeleton--line" />
        </div>
      </div>
    );
  }
  if (state === 'error') {
    return (
      <div className={`${root} ui-kpi--error`} role="alert">
        <div className="ui-kpi__body">
          <span className="ui-kpi__label">{label}</span>
          <span className="ui-kpi__message">{t('ui.kpiTile.error', { label })}</span>
          {onRetry !== undefined && (
            <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={onRetry}>
              {t('ui.common.retry')}
            </button>
          )}
        </div>
      </div>
    );
  }
  const labelNode = href === undefined ? label : <a className="ui-kpi__link" href={href}>{label}</a>;
  return (
    <article className={`${root}${href === undefined ? '' : ' ui-kpi--link'}`}>
      {icon !== undefined && (
        <span className="ui-kpi__icon" aria-hidden="true">
          {icon}
        </span>
      )}
      <div className="ui-kpi__body">
        <span className="ui-kpi__label">{labelNode}</span>
        <span className="ui-kpi__figure">
          <span className="ui-kpi__value">{value}</span>
          {unit !== undefined && <span className="ui-kpi__unit">{unit}</span>}
        </span>
        {sub !== undefined && <span className="ui-kpi__sub">{sub}</span>}
      </div>
    </article>
  );
}
