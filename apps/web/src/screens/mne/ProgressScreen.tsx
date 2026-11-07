import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { Field } from './components';
import { useObligations } from './hooks';
import { progressLabel, roleLabel } from './labels';
import { vietnamToday, yearsAround } from './model';
import { isFiled, progressOf, summarize, worstFirst } from './progress-model';
import type { ProgressKind } from './progress-model';
import type { ObligationView } from './types';
import './mne.css';
import './mne-kit.css';
import { ContextBar, DataTable, FilterPanel, SectionCard, StatusPill } from '../../ui';
import type { DataTableColumn, Tone } from '../../ui';

/**
 * MNE-09: the filing progress of the monitoring reports of a year, in the units of the reader (BR-MNE-04): for each obligation the version of the rule it follows, its due date, the day it was filed and whether it was
 * on time, in words and with the number of days; what is not filed is counted to today. Read-only: the calendar (MNE-01) is where the obligations are generated.
 */
export default function ProgressScreen({ route }: ScreenProps) {
  const tenantId = useSession().tenant?.id;
  // The filters belong to one tenant: a switch starts the screen over.
  return <ProgressContent key={tenantId ?? 'none'} route={route} />;
}

function ProgressContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { tenant } = useSession();
  const today = vietnamToday();
  const [year, setYear] = useState(Number(today.slice(0, 4)));
  const [onlyLate, setOnlyLate] = useState(false);
  const list = useObligations({ year, status: '' });
  // A page is not the whole of the year: the rest is read, so that the summary counts every obligation.
  useEffect(() => {
    if (list.hasNextPage === true && !list.isFetchingNextPage && list.error === null) void list.fetchNextPage();
  }, [list.hasNextPage, list.isFetchingNextPage, list.error, list]);
  const all = useMemo(() => list.data?.pages.flatMap((page) => page.items) ?? [], [list.data]);
  const summary = useMemo(() => summarize(all), [all]);
  const shown = useMemo(() => worstFirst(onlyLate ? all.filter((item) => ['LATE', 'OPEN_LATE'].includes(progressOf(item).kind)) : all), [all, onlyLate]);
  const columns = useMemo(() => progressColumns(t), [t]);
  const state = useScreenState({ isLoading: list.isLoading || list.hasNextPage === true, error: list.error, data: list.data === undefined ? undefined : all });

  return (
    <section className="mne" data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('mne.progress.page.title')}</h1>
          <p>{t('mne.progress.page.subtitle')}</p>
        </div>
      </div>
      <p className="sub" data-testid="progress-today">
        {t('mne.progress.today', { today })}
      </p>
      <ContextBar
        items={[
          { label: t('mne.progress.ctx.scope'), value: tenant?.name ?? t('mne.progress.ctx.scope.all') },
          { label: t('mne.progress.ctx.year'), value: String(year) },
        ]}
        {...(list.dataUpdatedAt > 0 ? { asOf: new Date(list.dataUpdatedAt).toLocaleString('vi-VN') } : {})}
      />
      <FilterPanel applied={onlyLate ? 1 : 0}>
        <div className="mne-filters" role="group" aria-label={t('mne.calendar.filter.title')}>
          <Field id="progress-year" label={t('mne.calendar.filter.year.label')} error={undefined}>
            <select id="progress-year" value={year} onChange={(event) => setYear(Number(event.target.value))}>
              {yearsAround(today, [year]).map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </Field>
          <label className="mne-formats">
            <input type="checkbox" checked={onlyLate} onChange={(event) => setOnlyLate(event.target.checked)} /> {t('mne.progress.filter.late')}
          </label>
        </div>
      </FilterPanel>
      <StateBoundary state={state} onRetry={() => void list.refetch()}>
        <SectionCard title={t('mne.progress.summary.title')}>
          <div className="mne-badges" role="group" aria-label={t('mne.progress.summary.title')} data-testid="progress-summary">
            <strong>{t('mne.progress.summary.total', { count: summary.total })}</strong>
            <StatusPill tone="success">{t('mne.progress.summary.onTime', { count: summary.onTime })}</StatusPill>
            <StatusPill tone="danger">{t('mne.progress.summary.late', { count: summary.late })}</StatusPill>
            <StatusPill tone="warning">{t('mne.progress.summary.openLate', { count: summary.openLate })}</StatusPill>
            <StatusPill tone="info">{t('mne.progress.summary.open', { count: summary.open })}</StatusPill>
          </div>
          <DataTable
            caption={t('mne.progress.summary.title')}
            columns={columns}
            rows={shown}
            rowKey={(item) => item.reportId}
            severity={(item) => (progressOf(item).kind === 'OPEN_LATE' ? 'URGENT' : null)}
          />
        </SectionCard>
      </StateBoundary>
    </section>
  );
}

const KIND_TONE: Readonly<Record<ProgressKind, Tone>> = { ON_TIME: 'success', LATE: 'danger', OPEN_LATE: 'danger', OPEN: 'info' };

type Translate = ReturnType<typeof useTranslation>['t'];

/** The columns of the progress table: the unit stays pinned; the word of the progress is a pill and carries the kind of the row. */
function progressColumns(t: Translate): DataTableColumn<ObligationView>[] {
  return [
    {
      key: 'unit',
      header: t('mne.progress.column.unit'),
      pinned: true,
      render: (item) => (
        <>
          {item.unitCode} <span className="sub">{item.unitName}</span>
        </>
      ),
    },
    { key: 'period', header: t('mne.progress.column.period'), render: (item) => item.periodLabel },
    { key: 'form', header: t('mne.progress.column.form'), render: (item) => item.formCode },
    {
      key: 'rule',
      header: t('mne.progress.column.rule'),
      render: (item) => (
        <>
          <span data-testid={`rule-${item.reportId}`}>{t('mne.progress.rule.text', { code: item.ruleCode, revision: item.ruleRevision })}</span>
          <br />
          <span className="sub">{roleLabel(t, item.reportingRole)}</span>
        </>
      ),
    },
    { key: 'due', header: t('mne.progress.column.due'), render: (item) => item.dueDate },
    {
      key: 'filed',
      header: t('mne.progress.column.filed'),
      render: (item) => <span data-testid={`filed-${item.reportId}`}>{item.filedOn ?? (isFiled(item) ? t('mne.progress.filed.unknown') : t('mne.progress.filed.none'))}</span>,
    },
    {
      key: 'progress',
      header: t('mne.progress.column.progress'),
      render: (item) => {
        const progress = progressOf(item);
        return (
          <span data-testid={`progress-${item.reportId}`} data-progress={progress.kind}>
            <StatusPill tone={KIND_TONE[progress.kind]}>{progressLabel(t, progress)}</StatusPill>
          </span>
        );
      },
    },
  ];
}
