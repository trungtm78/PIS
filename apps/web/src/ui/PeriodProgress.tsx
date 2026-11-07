import { useTranslation } from '../i18n';
import { toneClass } from './types';
import type { Tone, UiState } from './types';

export interface PeriodProgressProps {
  title: string;
  percent: number | null;
  sent: number;
  total: number;
  dueLabel?: string;
  tone?: Tone;
  state?: UiState;
  onRetry?: () => void;
}

const clamp = (value: number): number => Math.min(100, Math.max(0, value));

/** The progress of a reporting period: a bar, "đã gửi a/b" and the due date. */
export function PeriodProgress({ title, percent, sent, total, dueLabel, tone, state = 'ready', onRetry }: PeriodProgressProps) {
  const { t } = useTranslation();
  const root = `ui-kpi ui-period ${toneClass(tone)}`;
  if (state === 'loading') {
    return (
      <div className={`${root} ui-kpi--loading`} role="status" aria-busy="true" aria-label={t('ui.periodProgress.loading', { title })}>
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
          <span className="ui-kpi__label">{title}</span>
          <span className="ui-kpi__message">{t('ui.periodProgress.error', { title })}</span>
          {onRetry !== undefined && (
            <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={onRetry}>
              {t('ui.common.retry')}
            </button>
          )}
        </div>
      </div>
    );
  }
  const known = percent !== null;
  const shown = known ? clamp(percent) : 0;
  return (
    <article className={root}>
      <div className="ui-kpi__body">
        <span className="ui-kpi__label">{title}</span>
        <span className="ui-kpi__figure">
          <span className="ui-kpi__value">{known ? `${Math.round(shown)}%` : '—'}</span>
        </span>
        <div
          className="ui-bar"
          role="progressbar"
          aria-label={title}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={known ? Math.round(shown) : undefined}
          aria-valuetext={known ? `${Math.round(shown)}%` : t('ui.periodProgress.noPercent')}
        >
          <span className="ui-bar__fill" style={{ width: `${shown}%` }} />
        </div>
        <span className="ui-kpi__sub ui-period__counts">
          <span>{t('ui.periodProgress.sent', { sent, total })}</span>
          {dueLabel !== undefined && <span>{dueLabel}</span>}
        </span>
      </div>
    </article>
  );
}
