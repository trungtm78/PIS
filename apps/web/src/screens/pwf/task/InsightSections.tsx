import { useTranslation } from '../../../i18n';
import { DataTable, SectionCard, StatusPill } from '../../../ui';
import type { DataTableColumn } from '../../../ui';
import { FigureInfo } from '../components';
import { Named, kpiName } from '../codes';
import { dayText, stampText } from '../model';
import type { TaskDetail } from '../model';
import { historyWord, kpiFormula, kpiStateWord } from './labels';
import { historyGroups, kpiInputs } from './model';
import type { KpiResult } from './model';

/** The log of the task, newest first: when, what happened in words, and the reason given with it. Closed until asked for. */
export function HistorySection({ task, open = false }: { task: TaskDetail; open?: boolean }) {
  const { t } = useTranslation();
  const groups = historyGroups(task.history);
  const count = task.history.length;
  return (
    <details className="pwf-fold" data-testid="history" open={open}>
      <summary>
        {t('pwf.task.history.title')}
        <span className="pwf-fold__note pwf-hint">{t('pwf6.task.history.count', { count })}</span>
      </summary>
      <div className="pwf-fold__body">
        {count === 0 ? (
          <p className="pwf-hint">{t('pwf6.task.history.empty')}</p>
        ) : (
          <ol className="pwf-history" aria-label={t('pwf.task.history.caption')}>
            {groups.map((group) => (
              <li key={group.date} className="pwf-history__day">
                <h3 className="pwf-history__date">{dayText(group.date)}</h3>
                <ul>
                  {group.entries.map((entry) => (
                    <li key={entry.id} className="pwf-history__entry" data-kind={entry.kind}>
                      <span className="pwf-history__time">{stampText(entry.at).slice(11)}</span>
                      <span className="pwf-history__what">
                        <span className="pwf-history__line">
                          <strong>{historyWord(t, entry.kind)}</strong>
                          {typeof entry.actor_name === 'string' && entry.actor_name !== '' ? (
                            <span className="pwf-history__who" data-testid="history-actor">
                              {entry.actor_name}
                            </span>
                          ) : null}
                        </span>
                        {entry.reason === null ? null : <span className="pwf-history__reason">{entry.reason}</span>}
                      </span>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ol>
        )}
      </div>
    </details>
  );
}

/** The KPI results of the task, each with the "i" that says the formula, the source and the facts it was computed from; absent when the caller may not see them. */
export function KpiSection({ task }: { task: TaskDetail }) {
  const { t } = useTranslation();
  const results = task.kpi_results;
  const columns: DataTableColumn<KpiResult>[] = [
    { key: 'kpi', header: t('pwf.task.kpi.col.kpi'), render: (item) => <Named name={kpiName(t, item.kpi_code)} code={item.kpi_code} /> },
    {
      key: 'value',
      header: t('pwf.task.kpi.col.value'),
      align: 'right',
      render: (item) => (
        <span className="pwf-figure">
          {item.value === null ? '–' : item.value}
          <FigureInfo name={kpiName(t, item.kpi_code)} formula={kpiFormula(t, item.operation)} source={t('pwf.task.kpi.source.text', { hash: item.inputs_hash.slice(0, 12) })} asOf={item.computed_at} version={t('pwf.task.kpi.version.text', { version: item.kpi_set_version })} />
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
  // A person who may not see the KPI of the task is shown no empty card about it: the block is simply not there.
  if (results === undefined) return null;
  return (
    <SectionCard title={t('pwf.task.kpi.title')}>
      <div data-testid="kpi">
        {results.length === 0 ? (
          <p className="callout" role="status" data-testid="kpi-empty">
            {t('pwf.task.kpi.empty')}
          </p>
        ) : (
          <div className="pwf-free">
            <DataTable columns={columns} rows={[...results]} rowKey={(item) => item.id} caption={t('pwf.task.kpi.caption')} />
          </div>
        )}
      </div>
    </SectionCard>
  );
}
