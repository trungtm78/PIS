import { useTranslation } from '../../../i18n';
import { DataTable, SectionCard } from '../../../ui';
import type { DataTableColumn } from '../../../ui';
import { lineStateWord } from './labels';
import { LineStatePill, PeriodStatusPill } from './components';
import { useComparison } from './hooks';
import { changeBetween, effectiveScore, rangeText, scoreText } from './model';
import type { ComparisonPoint } from './model';

/** The periods of one person side by side. Periods whose samples differ are shown but not ranked against each other, and the change between two periods is said only when both were rated (BR-PWF-36). */
export function Comparison({ membershipId, enabled }: { membershipId: string | undefined; enabled: boolean }) {
  const { t } = useTranslation();
  const compare = useComparison(membershipId, enabled);
  const data = compare.data;
  if (data === undefined) return null;
  const points = [...data.points].sort((a, b) => a.period_from.localeCompare(b.period_from));
  const columns: DataTableColumn<ComparisonPoint>[] = [
    { key: 'period', header: t('pwfs.compare.col.period'), render: (row) => rangeText(row.period_from, row.period_to) },
    { key: 'status', header: t('pwfs.compare.col.status'), render: (row) => <PeriodStatusPill status={row.period_status} /> },
    { key: 'score', header: t('pwfs.compare.col.score'), align: 'right', render: (row) => scoreText(effectiveScore(row)) },
    {
      key: 'rating',
      header: t('pwfs.compare.col.rating'),
      render: (row) => (row.state === 'RATED' && row.rating !== null ? row.rating : <LineStatePill state={row.state} />),
    },
    { key: 'sample', header: t('pwfs.compare.col.sample'), align: 'right', render: (row) => t('pwfs.compare.sample.text', { count: row.rated_task_count, weight: row.effective_weight }) },
    {
      key: 'change',
      header: t('pwfs.compare.col.change'),
      align: 'right',
      render: (row) => {
        const change = changeBetween(points[points.indexOf(row) - 1], row);
        return change === null ? <span title={lineStateWord(t, row.state)}>–</span> : change > 0 ? `+${change}` : String(change);
      },
    },
  ];
  return (
    <SectionCard title={t('pwfs.compare.title')}>
      <div data-testid="comparison">
        {data.sample_sizes_differ ? (
          <p className="callout warning" role="status" data-testid="no-ranking">
            {t('pwfs.compare.noRanking.note')}
          </p>
        ) : null}
        <div className="pwf-free">
          <DataTable columns={columns} rows={points} rowKey={(row) => row.period_id} caption={t('pwfs.compare.caption.text')} state={points.length === 0 ? 'empty' : 'ready'} />
        </div>
      </div>
    </SectionCard>
  );
}
