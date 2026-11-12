import { useTranslation } from '../../../i18n';
import { DataTable } from '../../../ui';
import type { DataTableColumn } from '../../../ui';
import { FigureInfo } from '../components';
import { dayText } from '../model';
import type { Workload } from '../model';
import { workloadRows } from './model';
import type { WorkloadRow } from './model';

/** The workload of each person by week, for looking at only: there is no control here that moves work from one person to another. */
export function WorkloadView({ workload }: { workload: Workload }) {
  const { t } = useTranslation();
  const rows = workloadRows(workload);
  const info = (name: string) => <FigureInfo name={name} formula={t('pwf.board.workload.formula')} source={t('pwf.board.workload.source')} asOf={workload.as_of} version={t('pwf.board.count.version')} />;
  const columns: DataTableColumn<WorkloadRow>[] = [
    { key: 'person', header: t('pwf.board.workload.person.header'), pinned: true, render: (row) => row.name },
    { key: 'open', header: t('pwf.board.workload.open.header'), align: 'right', render: (row) => row.open },
    ...workload.weeks.map(
      (week, index): DataTableColumn<WorkloadRow> => ({ key: `week-${week}`, header: t('pwf.board.workload.week.header', { date: dayText(week) }), align: 'right', render: (row) => row.weekly[index] ?? 0 }),
    ),
    {
      key: 'total',
      header: t('pwf.board.workload.total.header'),
      align: 'right',
      render: (row) => (
        <span className="pwf-figure">
          {row.total}
          {info(t('pwf.board.workload.total.header'))}
        </span>
      ),
    },
  ];
  return (
    <div>
      <h2>{t('pwf.board.workload.title')}</h2>
      <p className="callout" role="note" data-testid="display-only">
        {t('pwf.board.workload.display.notice')}
      </p>
      {rows.length === 0 ? (
        <p className="callout" role="status">
          {t('pwf.board.workload.empty.text')}
        </p>
      ) : (
        <div data-testid="workload-table">
          <DataTable columns={columns} rows={rows} rowKey={(row) => row.id} caption={t('pwf.board.workload.caption')} state="ready" />
        </div>
      )}
    </div>
  );
}
