import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { formatVnd } from '../dis/report/money';
import { ConfirmationLabel, Field } from './components';
import { useObligations, useReport } from './hooks';
import { reportStatusLabel } from './labels';
import { vietnamToday, yearsAround } from './model';
import { currentRevisionId, defaultWeek, pairedRates, proposalsOf, slowLines, weeksOf } from './weekly-model';
import type { ReportView } from './types';
import '../dis/dis.css';
import './mne.css';

/**
 * MNE-07: the weekly quick report (CV 3665/BTC-PTHT [CXN-11]) of a week: the two disbursement rates, the same numbers as DIS-19 because the report is filled from the same frozen snapshot, the sums they are made of, and
 * the slowest projects with their leaders from the open early warnings. Read-only: the report is written and handed in through MNE-03, and goes through review and issue like any other.
 */
export default function WeeklyQuickScreen({ route }: ScreenProps) {
  const tenant = useSession().tenant;
  // What is open belongs to one member of one tenant: a switch starts the screen over.
  return <WeeklyContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function WeeklyContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const today = vietnamToday();
  const [year, setYear] = useState(Number(today.slice(0, 4)));
  const [chosen, setChosen] = useState('');
  const list = useObligations({ year, status: '' });
  // A page is not the whole of the year: the rest is read, so that every week can be picked.
  useEffect(() => {
    if (list.hasNextPage === true && !list.isFetchingNextPage && list.error === null) void list.fetchNextPage();
  }, [list.hasNextPage, list.isFetchingNextPage, list.error, list]);
  const weeks = useMemo(() => weeksOf(list.data?.pages.flatMap((page) => page.items) ?? []), [list.data]);
  const selected = weeks.find((week) => week.reportId === chosen) ?? defaultWeek(weeks, today);
  const state = useScreenState({ isLoading: list.isLoading || list.hasNextPage === true, error: list.error, data: list.data === undefined ? undefined : weeks });

  return (
    <section className="mne" data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('mne.weekly.page.title')}</h1>
          <p>{t('mne.weekly.page.subtitle')}</p>
        </div>
      </div>
      <div className="card">
        <div className="mne-filters">
          <Field id="weekly-year" label={t('mne.calendar.filter.year.label')} error={undefined}>
            <select
              id="weekly-year"
              value={year}
              onChange={(event) => {
                setYear(Number(event.target.value));
                setChosen('');
              }}
            >
              {yearsAround(today, [year]).map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </Field>
          {selected === undefined ? null : (
            <Field id="weekly-week" label={t('mne.weekly.week.label')} error={undefined}>
              <select id="weekly-week" value={selected.reportId} onChange={(event) => setChosen(event.target.value)}>
                {weeks.map((week) => (
                  <option key={week.reportId} value={week.reportId}>
                    {t('mne.weekly.week.option', { period: week.periodLabel, unit: week.unitCode, due: week.dueDate })}
                  </option>
                ))}
              </select>
            </Field>
          )}
        </div>
        <StateBoundary state={state} onRetry={() => void list.refetch()}>
          {selected === undefined ? null : <WeeklyReport key={selected.reportId} id={selected.reportId} />}
        </StateBoundary>
      </div>
    </section>
  );
}

/** The report of one week, with the states of its own: the week that was picked can be denied or fail while the weeks stay. */
function WeeklyReport({ id }: { id: string }) {
  const query = useReport(id);
  const state = useScreenState({ isLoading: query.isLoading, error: query.error, data: query.data });
  // The calendar lists the first revision; when it was corrected, the week reports the latest one.
  const latest = query.data === undefined ? id : currentRevisionId(query.data);
  if (latest !== id) return <WeeklyReport key={latest} id={latest} />;
  return <StateBoundary state={state} onRetry={() => void query.refetch()}>{query.data === undefined ? null : <WeeklyBody report={query.data} />}</StateBoundary>;
}

function WeeklyBody({ report }: { report: ReportView }) {
  const { t } = useTranslation();
  const rates = pairedRates(report);
  const slow = slowLines(report);
  const proposals = proposalsOf(report);
  const value = (rate: string | null): string => (rate === null ? t('mne.weekly.rate.missing') : t('dis.rates.value.text', { value: rate }));
  return (
    <div data-testid="weekly-report" data-report-status={report.status}>
      <div data-testid="weekly-header">
        <div className="mne-badges">
          <strong>{report.formTitle}</strong>
          <span className="pill">{reportStatusLabel(t, report.status)}</span>
          <ConfirmationLabel awaiting={report.awaitingConfirmation} cxnRefs={report.cxnRefs} />
          {report.revision > 1 ? <span className="pill warn" data-testid="weekly-revision">{t('mne.weekly.header.revision', { revision: report.revision })}</span> : null}
        </div>
        <p className="sub">{t('mne.weekly.header.unit', { unit: `${report.unitCode} ${report.unitName}` })}</p>
        <p className="sub">{t('mne.weekly.header.period', { period: report.periodLabel, due: report.dueDate })}</p>
        <p className="sub">{report.asOfDate === null ? t('mne.weekly.header.noSnapshot') : t('mne.weekly.header.asOf', { date: report.asOfDate })}</p>
      </div>
      <section aria-labelledby="weekly-rates-title" data-testid="weekly-rates">
        <h2 id="weekly-rates-title">{t('mne.weekly.rates.title')}</h2>
        <div className="dis-rate-pair" role="group" aria-label={t('mne.weekly.rates.aria')}>
          <div className="dis-rate-tile" data-rate="pm">
            <span className="sub">{t('dis.rates.col.ratePm')}</span>
            <strong>{value(rates.pm)}</strong>
          </div>
          <div className="dis-rate-tile" data-rate="total">
            <span className="sub">{t('dis.rates.col.rateTotal')}</span>
            <strong>{value(rates.total)}</strong>
          </div>
        </div>
        {rates.plan === null ? null : <p className="sub">{t('mne.weekly.figures.plan', { value: formatVnd(rates.plan) })}</p>}
        {rates.disbursed === null ? null : <p className="sub">{t('mne.weekly.figures.disbursed', { value: formatVnd(rates.disbursed) })}</p>}
      </section>
      <section aria-labelledby="weekly-slow-title" data-testid="weekly-slow">
        <h2 id="weekly-slow-title">{t('mne.weekly.slow.title')}</h2>
        <p className="sub">{t('mne.weekly.slow.help')}</p>
        {slow === null ? (
          <p>{t('mne.weekly.slow.missing')}</p>
        ) : (
          <ul className="mne-lines">
            {slow.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="weekly-proposals-title" data-testid="weekly-proposals">
        <h2 id="weekly-proposals-title">{t('mne.weekly.proposals.title')}</h2>
        {proposals.length === 0 ? (
          <p>{t('mne.weekly.proposals.none')}</p>
        ) : (
          proposals.map((proposal) => (
            <p key={proposal.key} className="mne-text">
              {proposal.text}
            </p>
          ))
        )}
      </section>
      <div className="mne-actions">
        <Link className="btn" to={`/mne/mne-03?report=${report.id}`}>
          {t('mne.weekly.open')}
        </Link>
      </div>
    </div>
  );
}
