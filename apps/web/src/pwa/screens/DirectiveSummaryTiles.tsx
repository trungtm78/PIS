import { useTranslation } from '../../i18n';
import type { Summary } from '../../screens/dir/model';
import './pwa.css';

/** The counts of the scope with how each is made: a missing reading says so and shows no number. */
export function SummaryTiles({ summary, failed, retry }: { summary: Summary | null; failed: boolean; retry: () => void }) {
  const { t } = useTranslation();
  if (summary === null) {
    return failed ? (
      <p className="callout warning" role="alert" data-testid="summary-failed">
        {t('pwa2.directives.summary.failed')}{' '}
        <button type="button" className="ui-button ui-button--outline ui-button--small pwa-touch" onClick={retry}>
          {t('states.retry.action')}
        </button>
      </p>
    ) : (
      <div role="status" aria-busy="true" aria-label={t('states.loading.label')}>
        <span className="ui-skeleton ui-skeleton--line" />
      </div>
    );
  }
  const tiles: Array<{ key: string; label: string; value: number; tone?: 'danger' }> = [
    { key: 'overdue', label: t('pwa2.directives.summary.overdue'), value: summary.byStatus.OVERDUE, tone: 'danger' },
    { key: 'dueSoon', label: t('pwa2.directives.summary.dueSoon'), value: summary.dueSoon },
    { key: 'escalated', label: t('pwa2.directives.summary.escalated'), value: summary.escalated },
    { key: 'open', label: t('pwa2.directives.summary.open'), value: summary.byStatus.OPEN + summary.byStatus.IN_PROGRESS },
  ];
  const definitions = Object.entries(summary.definitions);
  return (
    <section aria-label={t('pwa2.directives.summary.aria')} data-testid="summary">
      <ul className="pwa-tiles">
        {tiles.map((tile) => (
          <li key={tile.key} className="pwa-tile" data-tile={tile.key} {...(tile.tone === undefined || tile.value === 0 ? {} : { 'data-tone': tile.tone })}>
            <span>{tile.label}</span>
            <strong>{tile.value}</strong>
          </li>
        ))}
      </ul>
      <p className="sub">
        {t('pwa2.directives.summary.total', { total: summary.total })}
        {summary.truncated ? ` ${t('pwa2.directives.summary.truncated')}` : ''}
      </p>
      {summary.policy.unverified ? (
        <p className="callout" role="status" data-testid="policy-unverified">
          {t('pwa2.directives.summary.unverified')}
        </p>
      ) : null}
      {definitions.length === 0 ? null : (
        <details className="pwa-details">
          <summary className="pwa-touch">{t('pwa2.directives.summary.how')}</summary>
          <ul className="pwa-lines">
            {definitions.map(([name, text]) => (
              <li key={name}>{text}</li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

