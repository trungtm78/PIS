import { useTranslation } from '../../../i18n';
import { DataTable, SectionCard, StatusPill, Timeline } from '../../../ui';
import type { DataTableColumn, TimelineGroup } from '../../../ui';
import { FigureInfo } from '../components';
import { dependencyWord } from '../labels';
import { todayInVietnam } from '../model';
import type { TaskDetail } from '../model';
import { historyWord, kpiFormula, kpiStateWord } from './labels';
import { historyGroups, kpiInputs } from './model';
import type { HistoryEntry, KpiResult } from './model';

type Predecessor = TaskDetail['predecessors'][number];

/** The tasks this one waits for, with the kind of link and its lag in working days. */
export function PredecessorsSection({ task }: { task: TaskDetail }) {
  const { t } = useTranslation();
  const columns: DataTableColumn<Predecessor>[] = [
    { key: 'task', header: t('pwf.task.predecessor.col.task'), render: (item) => item.task },
    { key: 'kind', header: t('pwf.task.predecessor.col.kind'), render: (item) => dependencyWord(t, item.kind) },
    { key: 'lag', header: t('pwf.task.predecessor.col.lag'), align: 'right', render: (item) => t('pwf.task.days.text', { days: item.lag_working_days }) },
  ];
  return (
    <SectionCard title={t('pwf.task.predecessor.title')}>
      <div data-testid="predecessors">
        {task.predecessors.length === 0 ? (
          <p className="callout" role="status">
            {t('pwf.task.predecessor.empty')}
          </p>
        ) : (
          <DataTable columns={columns} rows={task.predecessors} rowKey={(item) => `${item.task}:${item.kind}`} caption={t('pwf.task.predecessor.caption')} />
        )}
      </div>
    </SectionCard>
  );
}

const timelineKind = (entry: HistoryEntry): 'return' | 'hold' | 'note' => (entry.kind === 'RETURNED' ? 'return' : entry.kind === 'PAUSE_APPROVED' ? 'hold' : 'note');

/** The log of the task: who did what and when, newest first, with the reason of a return. */
export function HistorySection({ task }: { task: TaskDetail }) {
  const { t } = useTranslation();
  const groups: TimelineGroup[] = historyGroups(task.history).map((group) => ({
    date: group.date,
    entries: group.entries.map((entry) => ({ id: entry.id, at: entry.at, kind: timelineKind(entry), title: historyWord(t, entry.kind), ...(entry.reason === null ? {} : { note: entry.reason }) })),
  }));
  return (
    <SectionCard title={t('pwf.task.history.title')}>
      <div data-testid="history">
        <Timeline groups={groups} gaps={false} today={todayInVietnam()} caption={t('pwf.task.history.caption')} />
      </div>
    </SectionCard>
  );
}

/** The KPI results of the task, each with the "i" that says the formula, the source and the facts it was computed from; absent when the caller may not see them. */
export function KpiSection({ task }: { task: TaskDetail }) {
  const { t } = useTranslation();
  const results = task.kpi_results;
  const columns: DataTableColumn<KpiResult>[] = [
    { key: 'kpi', header: t('pwf.task.kpi.col.kpi'), render: (item) => item.kpi_code },
    {
      key: 'value',
      header: t('pwf.task.kpi.col.value'),
      align: 'right',
      render: (item) => (
        <span className="pwf-figure">
          {item.value === null ? '–' : item.value}
          <FigureInfo name={item.kpi_code} formula={kpiFormula(t, item.operation)} source={t('pwf.task.kpi.source.text', { hash: item.inputs_hash.slice(0, 12) })} asOf={item.computed_at} version={t('pwf.task.kpi.version.text', { version: item.kpi_set_version })} />
        </span>
      ),
    },
    { key: 'score', header: t('pwf.task.kpi.col.score'), align: 'right', render: (item) => (item.score === null ? '–' : item.score) },
    { key: 'weight', header: t('pwf.task.kpi.col.weight'), align: 'right', render: (item) => item.weight },
    {
      key: 'state',
      header: t('pwf.task.kpi.col.state'),
      render: (item) => (
        <StatusPill tone={item.state === 'OK' ? 'success' : 'neutral'} icon={item.state === 'OK' ? '✓' : '○'}>
          {kpiStateWord(t, item.state)}
        </StatusPill>
      ),
    },
    {
      key: 'inputs',
      header: t('pwf.task.kpi.col.inputs'),
      render: (item) => (
        <dl className="pwf-facts">
          {kpiInputs(item.inputs).map(([name, value]) => (
            <div key={name} className="pwf-input">
              <dt>{name}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      ),
    },
  ];
  return (
    <SectionCard title={t('pwf.task.kpi.title')}>
      <div data-testid="kpi">
        {results === undefined ? (
          <p className="callout" role="status" data-testid="kpi-hidden">
            {t('pwf.task.kpi.hidden')}
          </p>
        ) : results.length === 0 ? (
          <p className="callout" role="status" data-testid="kpi-empty">
            {t('pwf.task.kpi.empty')}
          </p>
        ) : (
          <DataTable columns={columns} rows={[...results]} rowKey={(item) => item.id} caption={t('pwf.task.kpi.caption')} />
        )}
      </div>
    </SectionCard>
  );
}
