import { Link } from 'react-router-dom';
import { ApiError } from '@machvon/api-client';
import { useTranslation } from '../../i18n';
import { useSession } from '../../session/SessionContext';
import { SectionCard, StatusPill } from '../../ui';
import { useSummary } from '../../screens/bid/workflow/hooks';
import { READ_PERMISSION, fullDay, vietnamDay, vietnamTime } from '../../screens/bid/workflow/model';

/** The tree of the procurement progress, where the leader goes for the drill-down the phone does not repeat. */
export const PROGRESS_TREE_PATH = '/bid/bid-27';
/** The same progress as a one-column list for the phone (PWA-09). */
export const PROGRESS_PWA_PATH = '/m/progress';

/**
 * The funnel of the procurement progress on the leader dashboard (PRC-1, docs/process-tree-design.md section 8): the five steps with most packages, each with its count and, in words, whether some are late, and the link to the
 * progress tree. It reads `getPackageWorkflowSummary` on its own, so a failure of it never hides the figures of the dashboard; a leader who may not read the procurement is told the scope is hidden, and a read that failed says so.
 */
export function FunnelCard() {
  const { t } = useTranslation();
  const { permissions } = useSession();
  const allowed = permissions === undefined || permissions.includes(READ_PERMISSION);
  const summary = useSummary({}, allowed);
  const denied = !allowed || (summary.error instanceof ApiError && summary.error.status === 403);
  const data = summary.data;
  const asOf = data === undefined ? undefined : `${fullDay(vietnamDay(data.as_of))} ${vietnamTime(data.as_of)}`;
  return (
    <SectionCard title={t('prc1.funnel.title')} status={data?.truncated === true ? <StatusPill tone="warning">{t('prc1.funnel.partial.text')}</StatusPill> : undefined}>
      <div data-testid="pwa-funnel">
        {denied ? (
          <p role="status">{t('prc1.funnel.denied.text')}</p>
        ) : summary.isLoading ? (
          <div role="status" aria-busy="true" aria-label={t('prc1.funnel.loading.label')}>
            <span className="ui-skeleton ui-skeleton--line" />
            <span className="ui-skeleton ui-skeleton--line" />
            <span className="ui-skeleton ui-skeleton--line" />
          </div>
        ) : data === undefined ? (
          <p role="alert">
            {t('prc1.funnel.error.text')}{' '}
            <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => void summary.refetch()}>
              {t('ui.common.retry')}
            </button>
          </p>
        ) : data.total === 0 ? (
          <p role="status">{t('prc1.funnel.empty.text')}</p>
        ) : (
          <>
            {summary.isError && asOf !== undefined && <p role="status">{t('prc1.stale.text', { time: asOf })}</p>}
            <ol className="prc1-funnel" aria-label={t('prc1.funnel.list.label')}>
              {data.top_steps.map((step) => (
                <li key={step.node_id} className="prc1-funnel__row">
                  <span className="prc1-funnel__name">{step.name ?? step.code}</span>
                  <strong className="prc1-funnel__count">{t('ui.processTree.node.packages', { count: step.count })}</strong>
                  {step.late_count > 0 ? <StatusPill tone="danger" icon="⛔">{t('ui.processTree.node.late', { count: step.late_count })}</StatusPill> : <StatusPill tone="success" icon="✓">{t('ui.processTree.health.ok')}</StatusPill>}
                </li>
              ))}
            </ol>
            <p className="sub">{t('prc1.funnel.summary.text', { running: data.running, late: data.late, noOwner: data.no_owner })}</p>
          </>
        )}
        <p>
          <Link className="ui-button ui-button--primary pwa-touch" to={PROGRESS_PWA_PATH} data-testid="pwa-progress-link">
            {t('pwa2.progress.link')}
          </Link>{' '}
          <Link className="ui-button ui-button--outline pwa-touch" to={PROGRESS_TREE_PATH}>
            {t('prc1.funnel.link.action')}
          </Link>
        </p>
      </div>
    </SectionCard>
  );
}
