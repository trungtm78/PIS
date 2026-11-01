import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { useProject } from '../prj/hooks';
import { stageLabel } from '../prj/labels';
import { Field } from './components';
import { useForms, useObligations, useReport } from './hooks';
import { reportKindLabel, reportStatusLabel } from './labels';
import { vietnamToday, yearsAround } from './model';
import { figuresOf, projectObligations } from './project-report-model';
import { ReportEditor } from './ReportScreen';
import { READ_PERMISSION } from './types';
import type { ReportView } from './types';
import './mne.css';

const NO_FILTER = { reportKind: '', effectiveOn: '' } as const;
const REPORT_PATH = '/mne/mne-03';

/**
 * MNE-04: the monitoring report of a project (ST-MNE-008, MNE F4): the project, the kind of report, the milestone that asked for it, the figures filled from PRJ, CAP and DIS and the proposals written by the preparer. The shell of
 * a report that an event of the project asks for (start, revision, completion) is made by the server; here it is opened and written like any report, with the project in front of it.
 */
export default function ProjectReportScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // What is open belongs to one member of one tenant: a switch starts the screen over.
  return <ProjectReportContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function ProjectReportContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions } = useSession();
  const [params, setParams] = useSearchParams();
  const reportId = params.get('report') ?? '';
  const readable = permissions === undefined || permissions.includes(READ_PERMISSION);
  return (
    <section className="mne" data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('mne.project.page.title')}</h1>
          <p>{t('mne.project.page.subtitle')}</p>
        </div>
        {reportId === '' || !readable ? null : (
          <button type="button" className="btn" onClick={() => setParams({})}>
            {t('mne.project.back.action')}
          </button>
        )}
      </div>
      {!readable ? <StateBoundary state="denied" /> : reportId === '' ? <ProjectReportPicker onOpen={(id) => setParams({ report: id })} /> : <OpenProjectReport id={reportId} />}
    </section>
  );
}

/** The project reports of the calendar of a year, whatever their state: where a report is opened from. */
function ProjectReportPicker({ onOpen }: { onOpen: (id: string) => void }) {
  const { t } = useTranslation();
  const today = vietnamToday();
  // The reports of a project are due in the year of the event, or after it: the year is the person's to choose.
  const [year, setYear] = useState(Number(today.slice(0, 4)));
  const list = useObligations({ year, status: '' });
  const forms = useForms(NO_FILTER);
  const rows = useMemo(() => projectObligations(list.data?.pages.flatMap((page) => page.items) ?? [], forms.data ?? []), [list.data, forms.data]);
  // A page with none of the reports wanted is not the end of the list: the next page is read until one is found or there is none.
  const searching = forms.data !== undefined && rows.length === 0 && list.hasNextPage === true && list.error === null;
  const { fetchNextPage, isFetchingNextPage } = list;
  useEffect(() => {
    if (searching && !isFetchingNextPage) void fetchNextPage();
  }, [searching, isFetchingNextPage, fetchNextPage]);
  const state = useScreenState({
    isLoading: list.isLoading || forms.isLoading || searching,
    error: list.error ?? forms.error,
    data: list.data === undefined || forms.data === undefined ? undefined : rows,
  });
  return (
    <div className="card">
      <h2>{t('mne.project.picker.title')}</h2>
      <p className="sub">{t('mne.project.picker.help')}</p>
      <div className="mne-filters">
        <Field id="project-report-year" label={t('mne.calendar.filter.year.label')} error={undefined}>
          <select id="project-report-year" value={year} onChange={(event) => setYear(Number(event.target.value))}>
            {yearsAround(today, [year]).map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <StateBoundary state={state} onRetry={() => void Promise.all([list.refetch(), forms.refetch()])}>
        <div className="tablewrap">
          <table aria-label={t('mne.project.picker.aria')} data-testid="project-reports">
            <thead>
              <tr>
                <th scope="col">{t('mne.project.picker.column.kind')}</th>
                <th scope="col">{t('mne.project.picker.column.milestone')}</th>
                <th scope="col">{t('mne.project.picker.column.unit')}</th>
                <th scope="col">{t('mne.project.picker.column.due')}</th>
                <th scope="col">{t('mne.project.picker.column.status')}</th>
                <th scope="col" />
              </tr>
            </thead>
            <tbody>
              {rows.map(({ item, kind }) => (
                <tr key={item.reportId} data-report-id={item.reportId} data-kind={kind}>
                  <td>
                    {reportKindLabel(t, kind)} <span className="sub">{item.formCode}</span>
                  </td>
                  <td>{item.periodLabel}</td>
                  <td>
                    {item.unitCode} <span className="sub">{item.unitName}</span>
                  </td>
                  <td>{item.dueDate}</td>
                  <td>{reportStatusLabel(t, item.status)}</td>
                  <td>
                    <button type="button" className="btn" onClick={() => onOpen(item.reportId)}>
                      {t('mne.project.picker.open', { milestone: item.periodLabel })}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {list.hasNextPage ? (
          <div className="mne-actions">
            <button type="button" className="btn" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
              {t('mne.calendar.more.action')}
            </button>
          </div>
        ) : null}
      </StateBoundary>
    </div>
  );
}

/** One report: the project in front of it when it is a project report, else the way to the screen that writes the reports of a unit. */
function OpenProjectReport({ id }: { id: string }) {
  const { t } = useTranslation();
  const query = useReport(id);
  const state = useScreenState({ isLoading: query.isLoading, error: query.error, data: query.data, isEmpty: () => false });
  const report = query.data;
  return (
    <StateBoundary state={state} onRetry={() => void query.refetch()}>
      {report === undefined ? null : report.projectId === null ? (
        <div className="card" data-testid="not-project-report">
          <p role="status">{t('mne.project.notProject.notice')}</p>
          <Link className="btn" to={`${REPORT_PATH}?report=${id}`}>
            {t('mne.project.notProject.action')}
          </Link>
        </div>
      ) : (
        <>
          <ProjectCard report={report} projectId={report.projectId} />
          <ReportEditor id={id} />
        </>
      )}
    </StateBoundary>
  );
}

/** The project the report is about, the kind of report and the milestone, and how far the figures and the proposals are filled. */
function ProjectCard({ report, projectId }: { report: ReportView; projectId: string }) {
  const { t } = useTranslation();
  const project = useProject(projectId);
  const cells = figuresOf(report);
  const found = project.data ?? undefined;
  return (
    <div className="card" data-testid="project-card">
      <dl className="mne-facts">
        <dt>{t('mne.project.field.project')}</dt>
        <dd data-testid="project-name">
          {project.isLoading ? (
            <span className="sub" aria-busy="true">
              …
            </span>
          ) : found === undefined ? (
            <span className="sub">{t('mne.project.project.unreadable.notice')}</span>
          ) : (
            <>
              {found.code} {found.name} <span className="pill">{stageLabel(t, found.status)}</span>
            </>
          )}
        </dd>
        <dt>{t('mne.project.field.kind')}</dt>
        <dd data-testid="project-kind">{t('mne.project.kind.text', { title: report.formTitle, code: report.formCode, revision: report.formRevision })}</dd>
        <dt>{t('mne.project.field.milestone')}</dt>
        <dd data-testid="project-milestone">{t('mne.project.milestone.text', { milestone: report.periodLabel, due: report.dueDate })}</dd>
        <dt>{t('mne.project.field.figures')}</dt>
        <dd data-testid="project-figures">{cells.figures === 0 ? t('mne.project.figures.none') : t('mne.project.figures.text', { count: cells.figures, empty: cells.empty })}</dd>
        <dt>{t('mne.project.field.proposals')}</dt>
        <dd data-testid="project-proposals">{cells.written === 0 ? t('mne.project.proposals.none') : t('mne.project.proposals.text', { filled: cells.writtenFilled, count: cells.written })}</dd>
      </dl>
    </div>
  );
}
