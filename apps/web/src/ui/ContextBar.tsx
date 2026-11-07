import { useTranslation } from '../i18n';
import { UnitChip } from './FilterPanel';
import { StatusPill } from './StatusPill';

export interface ContextBarProps {
  items: { label: string; value: string }[];
  asOf?: string;
  stale?: boolean;
  unit?: string;
}

/** The scope line under the page title: scope, period, closing date, unit and how fresh the numbers are. */
export function ContextBar({ items, asOf, stale = false, unit }: ContextBarProps) {
  const { t } = useTranslation();
  return (
    <div className="ui-context" role="group" aria-label={t('ui.contextBar.label')}>
      {items.map((item) => (
        <span className="ui-context__item" key={item.label}>
          <span className="ui-context__label">{item.label}</span>
          <strong className="ui-context__value">{item.value}</strong>
        </span>
      ))}
      {unit !== undefined && <UnitChip unit={unit} />}
      {stale ? (
        <StatusPill tone="warning">{asOf === undefined ? t('ui.contextBar.stale') : t('ui.contextBar.staleAsOf', { time: asOf })}</StatusPill>
      ) : (
        asOf !== undefined && <span className="ui-context__asof">{t('ui.contextBar.asOf', { time: asOf })}</span>
      )}
    </div>
  );
}
