import type { ReactNode } from 'react';
import { useTranslation } from '../i18n';
import type { UiState } from './types';

export interface CommandHeroProps {
  label: string;
  value: string;
  unit: string;
  caption?: ReactNode;
  ratio?: { percent: number | null; label: string };
  chips?: { label: string; value: string }[];
  actions?: ReactNode;
  state?: UiState;
  onRetry?: () => void;
}

const RADIUS = 38;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

function Ring({ percent, label }: { percent: number | null; label: string }) {
  const { t } = useTranslation();
  const known = percent !== null;
  const shown = known ? Math.min(100, Math.max(0, percent)) : 0;
  const text = known ? t('ui.commandHero.ratioAria', { label, percent: Math.round(shown) }) : t('ui.commandHero.noRatio', { label });
  return (
    <div className="ui-hero__ratio">
      <svg className="ui-hero__ring" viewBox="0 0 100 100" role="img" aria-label={text}>
        <circle className="ui-hero__ring-track" cx="50" cy="50" r={RADIUS} fill="none" strokeWidth="10" />
        {known && (
          <circle
            className="ui-hero__ring-fill"
            cx="50"
            cy="50"
            r={RADIUS}
            fill="none"
            strokeWidth="10"
            strokeLinecap="round"
            strokeDasharray={`${(CIRCUMFERENCE * shown) / 100} ${CIRCUMFERENCE}`}
            transform="rotate(-90 50 50)"
          />
        )}
        <text className="ui-hero__ring-text" x="50" y="56" textAnchor="middle">
          {known ? `${Math.round(shown)}%` : '—'}
        </text>
      </svg>
      <span className="ui-hero__ratio-label">{label}</span>
    </div>
  );
}

/** The dark command block of the leader home: one big number with its unit, an optional ring, chips and actions. */
export function CommandHero({ label, value, unit, caption, ratio, chips, actions, state = 'ready', onRetry }: CommandHeroProps) {
  const { t } = useTranslation();
  if (state === 'loading') {
    return (
      <section className="ui-hero ui-hero--loading" role="status" aria-busy="true" aria-label={t('ui.commandHero.loading', { label })}>
        <div className="ui-hero__main">
          <span className="ui-skeleton ui-skeleton--line ui-skeleton--short ui-skeleton--dark" />
          <span className="ui-skeleton ui-skeleton--hero ui-skeleton--dark" />
          <span className="ui-skeleton ui-skeleton--line ui-skeleton--dark" />
        </div>
      </section>
    );
  }
  if (state === 'error') {
    return (
      <section className="ui-hero ui-hero--error" role="alert">
        <div className="ui-hero__main">
          <p className="ui-hero__label">{label}</p>
          <p className="ui-hero__message">{t('ui.commandHero.error', { label })}</p>
          {onRetry !== undefined && (
            <button type="button" className="ui-button ui-button--onDark" onClick={onRetry}>
              {t('ui.common.retry')}
            </button>
          )}
        </div>
      </section>
    );
  }
  return (
    <section className="ui-hero" aria-label={label}>
      <div className="ui-hero__main">
        <p className="ui-hero__label">{label}</p>
        <p className="ui-hero__figure">
          <span className="ui-hero__value">{value}</span>
          <span className="ui-hero__unit">{unit}</span>
        </p>
        {caption !== undefined && <div className="ui-hero__caption">{caption}</div>}
        {chips !== undefined && chips.length > 0 && (
          <ul className="ui-hero__chips">
            {chips.map((chip) => (
              <li className="ui-hero__chip" key={chip.label}>
                <span className="ui-hero__chip-label">{chip.label}</span>
                <strong className="ui-hero__chip-value">{chip.value}</strong>
              </li>
            ))}
          </ul>
        )}
      </div>
      {ratio !== undefined && <Ring percent={ratio.percent} label={ratio.label} />}
      {actions !== undefined && <div className="ui-hero__actions">{actions}</div>}
    </section>
  );
}
