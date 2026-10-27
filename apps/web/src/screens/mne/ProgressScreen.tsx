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
import './mne.css';

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
      <div className="card">
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
        <StateBoundary state={state} onRetry={() => void list.refetch()}>
          <div className="mne-badges" role="group" aria-label={t('mne.progress.summary.title')} data-testid="progress-summary">
            <strong>{t('mne.progress.summary.total', { count: summary.total })}</strong>
            <span className="pill">{t('mne.progress.summary.onTime', { count: summary.onTime })}</span>
            <span className="pill warn">{t('mne.progress.summary.late', { count: summary.late })}</span>
            <span className="pill warn">{t('mne.progress.summary.openLate', { count: summary.openLate })}</span>
            <span className="pill">{t('mne.progress.summary.open', { count: summary.open })}</span>
          </div>
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">{t('mne.progress.column.unit')}</th>
                  <th scope="col">{t('mne.progress.column.period')}</th>
                  <th scope="col">{t('mne.progress.column.form')}</th>
                  <th scope="col">{t('mne.progress.column.rule')}</th>
                  <th scope="col">{t('mne.progress.column.due')}</th>
                  <th scope="col">{t('mne.progress.column.filed')}</th>
                  <th scope="col">{t('mne.progress.column.progress')}</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((item) => {
                  const progress = progressOf(item);
                  return (
                    <tr key={item.reportId} data-report-id={item.reportId} data-progress={progress.kind}>
                      <td>
                        {item.unitCode} <span className="sub">{item.unitName}</span>
                      </td>
                      <td>{item.periodLabel}</td>
                      <td>{item.formCode}</td>
                      <td>
                        <span data-testid={`rule-${item.reportId}`}>{t('mne.progress.rule.text', { code: item.ruleCode, revision: item.ruleRevision })}</span>
                        <br />
                        <span className="sub">{roleLabel(t, item.reportingRole)}</span>
                      </td>
                      <td>{item.dueDate}</td>
                      <td data-testid={`filed-${item.reportId}`}>{item.filedOn ?? (isFiled(item) ? t('mne.progress.filed.unknown') : t('mne.progress.filed.none'))}</td>
                      <td data-testid={`progress-${item.reportId}`}>{progressLabel(t, progress)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </StateBoundary>
      </div>
    </section>
  );
}
