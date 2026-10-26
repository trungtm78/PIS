import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { Field } from '../components';
import { usePeriods } from '../hooks';
import { periodsOf, yearsOf } from '../model';
import '../dis.css';
import { usePlanOptions, useProjectOptions, useReportPage } from './hooks';
import { reportStatusLabel } from './labels';
import { DETAIL_PATH } from './decision-model';
import { CREATE_PATH, EDIT_PATH, NO_FILTER, canCreate, isFiltered } from './model';
import type { FilterState, Kpi, ReportLine } from './model';
import { formatVnd } from './money';

const NEVER_EMPTY = (): boolean => false;

/**
 * DIS-01: the weekly reports the caller can see, newest first, with the filters of the source (year, week, annual plan, project) and the figures above the table. A filtered table and the whole scope
 * are two totals, and each says what it is the total of, so one is never taken for the other (SRC-01/02). The cumulative of a report is a snapshot of its period: the figures of the table add up
 * the reports in it and not the periods in between (ST-DIS-003, DIS 3 F1).
 */
export default function ReportListScreen({ route }: ScreenProps) {
  const tenantId = useSession().tenant?.id;
  // The filters and the page belong to one tenant: a switch starts the screen over.
  return <ReportListContent key={tenantId ?? 'none'} route={route} />;
}

function ReportListContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const [filter, setFilter] = useState<FilterState>(NO_FILTER);
  const [cursors, setCursors] = useState<Array<string | undefined>>([undefined]);
  const cursor = cursors[cursors.length - 1];
  const page = useReportPage(filter, cursor);
  const periods = usePeriods();
  const projects = useProjectOptions();
  const plans = usePlanOptions();
  const state = useScreenState({ isLoading: page.isLoading, error: page.error, data: page.data, isEmpty: NEVER_EMPTY });
  const years = yearsOf(periods.data ?? [], new Date().getFullYear());
  const weeks = periodsOf(periods.data ?? [], filter.year === '' ? 0 : Number(filter.year), '');
  const change = (next: Partial<FilterState>): void => {
    setFilter({ ...filter, ...next });
    setCursors([undefined]);
  };
  const data = page.data;

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('dis.reports.page.title')}</h1>
          <p>{t('dis.reports.page.subtitle')}</p>
        </div>
        {canCreate(permissions, mode) ? (
          <div className="actions">
            <Link className="button primary" to={CREATE_PATH}>
              {t('dis.reports.create.action')}
            </Link>
          </div>
        ) : null}
      </div>
      <div className="card">
        <div className="dis-filters" role="group" aria-label={t('dis.reports.filter.title')}>
          <Field id="report-year" label={t('dis.reports.filter.year.label')} error={undefined}>
            <select id="report-year" value={filter.year} onChange={(event) => change({ year: event.target.value, periodId: '' })}>
              <option value="">{t('dis.reports.filter.all.option')}</option>
              {years.map((year) => (
                <option key={year} value={year}>
                  {year}
                </option>
              ))}
            </select>
          </Field>
          <Field id="report-period" label={t('dis.reports.filter.period.label')} error={undefined}>
            <select id="report-period" value={filter.periodId} disabled={filter.year === ''} onChange={(event) => change({ periodId: event.target.value })}>
              <option value="">{t('dis.reports.filter.all.option')}</option>
              {weeks.map((period) => (
                <option key={period.id} value={period.id}>
                  {period.code}
                </option>
              ))}
            </select>
          </Field>
          {(plans.data ?? []).length === 0 ? null : (
            <Field id="report-plan" label={t('dis.reports.filter.plan.label')} error={undefined}>
              <select id="report-plan" value={filter.planId} onChange={(event) => change({ planId: event.target.value })}>
                <option value="">{t('dis.reports.filter.all.option')}</option>
                {(plans.data ?? []).map((plan) => (
                  <option key={plan.id} value={plan.id}>
                    {plan.code}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <Field id="report-project" label={t('dis.reports.filter.project.label')} error={undefined}>
            <select id="report-project" value={filter.projectId} onChange={(event) => change({ projectId: event.target.value })}>
              <option value="">{t('dis.reports.filter.all.option')}</option>
              {(projects.data ?? []).map((project) => (
                <option key={project.id} value={project.id}>
                  {`${project.code} · ${project.name}`}
                </option>
              ))}
            </select>
          </Field>
          {isFiltered(filter) ? (
            <button type="button" onClick={() => change(NO_FILTER)}>
              {t('dis.reports.filter.clear.action')}
            </button>
          ) : null}
        </div>
      </div>
      <StateBoundary state={state} onRetry={() => void page.refetch()}>
        {data === undefined ? null : (
          <>
            {data.summary === undefined ? null : (
              <div className="aud-cards" data-testid="kpis">
                <Figures testId="kpi-filtered" title={data.summary.isFiltered ? t('dis.reports.kpi.filtered.title') : t('dis.reports.kpi.scope.title')} kpi={data.summary.filtered} />
                {data.summary.isFiltered ? <Figures testId="kpi-scope" title={t('dis.reports.kpi.scope.title')} kpi={data.summary.scope} /> : null}
                <p className="muted" data-testid="kpi-note">
                  {t('dis.reports.kpi.note')}
                </p>
              </div>
            )}
            <div className="card">
              {data.items.length === 0 ? (
                <p className="muted" data-testid="no-reports">
                  {t('dis.reports.empty.text')}
                </p>
              ) : (
                <div className="tablewrap">
                  <table className="table" aria-label={t('dis.reports.table.aria')}>
                    <thead>
                      <tr>
                        <th>{t('dis.reports.col.project')}</th>
                        <th>{t('dis.reports.col.period')}</th>
                        <th>{t('dis.reports.col.status')}</th>
                        <th className="num">{t('dis.reports.col.cumulative')}</th>
                        <th className="num">{t('dis.reports.col.ctmtqg')}</th>
                        <th>{t('dis.reports.col.updated')}</th>
                        <th>
                          <span className="sr-only">{t('dis.reports.col.actions')}</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.items.map((report) => (
                        <Row key={report.id} report={report} />
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <div className="actions" data-testid="pager">
                <button type="button" disabled={cursors.length === 1} onClick={() => setCursors(cursors.slice(0, -1))}>
                  {t('dis.reports.previous.action')}
                </button>
                <button type="button" disabled={data.nextCursor === null} onClick={() => setCursors(data.nextCursor === null ? cursors : [...cursors, data.nextCursor])}>
                  {t('dis.reports.next.action')}
                </button>
              </div>
            </div>
          </>
        )}
      </StateBoundary>
      <p className="prototype-note">{t('dis.reports.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function Figures({ title, kpi, testId }: { title: string; kpi: Kpi; testId: string }) {
  const { t } = useTranslation();
  return (
    <div className="card" data-testid={testId}>
      <h2>{title}</h2>
      <p data-testid={`${testId}-counts`}>{t('dis.reports.kpi.counts', { reports: kpi.reports, projects: kpi.projects })}</p>
      <p data-testid={`${testId}-money`}>{t('dis.reports.kpi.money', { amount: formatVnd(kpi.cumulativeVnd), ctmtqg: formatVnd(kpi.ctmtqgVnd) })}</p>
    </div>
  );
}

function Row({ report }: { report: ReportLine }) {
  const { t } = useTranslation();
  return (
    <tr data-report-id={report.id}>
      <td>
        <strong>{report.project.code}</strong>
        <span className="dis-code">{report.project.name}</span>
      </td>
      <td>
        {report.period.code}
        <span className="dis-code">{t('dis.reports.revision.text', { revision: report.revision })}</span>
      </td>
      <td>
        <span className="pill gray">{reportStatusLabel(t, report.status)}</span>
        {report.isLate ? <span className="pill warn">{t('dis.reports.late.text')}</span> : null}
      </td>
      <td className="num">{formatVnd(report.cumulativeVnd)}</td>
      <td className="num">{formatVnd(report.ctmtqgVnd)}</td>
      <td>
        <time dateTime={report.updatedAt}>{report.updatedAt.slice(0, 10)}</time>
      </td>
      <td>
        <Link to={`${report.status === 'DRAFT' ? EDIT_PATH : DETAIL_PATH}?report=${report.id}`}>{t('dis.reports.open.action', { code: report.project.code })}</Link>
      </td>
    </tr>
  );
}
