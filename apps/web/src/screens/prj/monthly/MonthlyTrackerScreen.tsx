import { useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { Field } from '../../dis/components';
import { useDrill } from '../../dis/board/hooks';
import { projectState } from '../../dis/board/labels';
import { defaultPeriod } from '../../dis/board/model';
import { usePeriods } from '../../dis/hooks';

const SECTIONS = ['results', 'causes', 'solutions', 'proposals'] as const;

/**
 * PRJ-13: the monthly follow-up of the projects: for a month, each project that must report with whether its monthly report came in and the narrative the investor wrote (ST-DIS-015, FR-PRJ-13). The words are
 * those of the report that stands for the project (the one handed in, else the latest draft); a project that wrote nothing says so, and is not shown as if it had.
 */
export default function MonthlyTrackerScreen({ route }: ScreenProps) {
  const tenantId = useSession().tenant?.id;
  return <TrackerContent key={tenantId ?? 'none'} route={route} />;
}

function TrackerContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const periods = usePeriods();
  const months = (periods.data ?? []).filter((period) => period.periodType === 'MONTH');
  // A month named in the address opens without the list of periods, which needs a permission of its own.
  const [params, setParams] = useSearchParams();
  const chosen = params.get('period') ?? defaultPeriod(months, new Date().toISOString().slice(0, 10))?.id;
  const drill = useDrill(chosen, chosen === undefined ? undefined : { unitId: undefined, state: 'MUST_REPORT', withNarrative: true });
  const state = useScreenState({
    isLoading: (chosen === undefined && periods.isLoading) || (chosen !== undefined && drill.isLoading),
    error: chosen === undefined ? periods.error : drill.error,
    data: chosen === undefined ? [] : drill.data,
    isEmpty: (data) => (Array.isArray(data) ? true : (data as { pages: Array<{ projects: unknown[] } | undefined> }).pages.every((page) => (page?.projects.length ?? 0) === 0)),
  });
  const projects = (drill.data?.pages ?? []).flatMap((page) => page?.projects ?? []);
  const label = (section: (typeof SECTIONS)[number]): string => {
    switch (section) {
      case 'results':
        return t('prj.monthly.section.results');
      case 'causes':
        return t('prj.monthly.section.causes');
      case 'solutions':
        return t('prj.monthly.section.solutions');
      case 'proposals':
        return t('prj.monthly.section.proposals');
    }
  };
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('prj.monthly.page.title')}</h1>
          <p>{t('prj.monthly.page.subtitle')}</p>
        </div>
      </div>
      <div className="card">
        <div className="dis-filters" role="group" aria-label={t('prj.monthly.filter.title')}>
          <Field id="monthly-period" label={t('prj.monthly.period.label')} error={undefined}>
            <select id="monthly-period" value={chosen ?? ''} onChange={(event) => setParams(new URLSearchParams({ period: event.target.value }), { replace: true })}>
              {[...months, ...(chosen !== undefined && drill.data?.pages[0] !== undefined && !months.some((period) => period.id === chosen) ? [{ id: chosen, code: drill.data.pages[0].periodCode, startDate: '', endDate: '' }] : [])]
                .sort((left, right) => (left.startDate < right.startDate ? 1 : left.startDate > right.startDate ? -1 : 0))
                .map((period) => (
                  <option key={period.id} value={period.id}>
                    {period.startDate === '' ? period.code : t('prj.monthly.period.option', { code: period.code, start: period.startDate, end: period.endDate })}
                  </option>
                ))}
            </select>
          </Field>
        </div>
      </div>
      <StateBoundary state={state} onRetry={() => void Promise.all([periods.refetch(), drill.refetch()])}>
        <section className="card" aria-labelledby="monthly-table-title">
          <h2 id="monthly-table-title">{t('prj.monthly.table.title')}</h2>
          <div className="tablewrap">
            <table className="table" aria-label={t('prj.monthly.table.aria')} data-testid="monthly-table">
              <thead>
                <tr>
                  <th scope="col">{t('prj.monthly.col.project')}</th>
                  <th scope="col">{t('prj.monthly.col.state')}</th>
                  <th scope="col">{t('prj.monthly.col.narrative')}</th>
                </tr>
              </thead>
              <tbody>
                {projects.map((project) => (
                  <tr key={project.projectId} data-project={project.projectId}>
                    <td>
                      {project.projectCode}
                      <span className="dis-code">{project.projectName}</span>
                      <span className="dis-code">{project.unit.name}</span>
                    </td>
                    <td>
                      <span className={`pill ${project.state === 'SUBMITTED' ? 'green' : 'gray'}`}>{projectState(t, project)}</span>
                      {project.isLate ? <span className="pill warn">{t('dis.board.flag.late')}</span> : null}
                    </td>
                    <td data-cell="narrative">
                      {project.narrative === null ? (
                        <span className="muted">{t('prj.monthly.narrative.none')}</span>
                      ) : (
                        SECTIONS.map((section) =>
                          project.narrative?.[section] == null ? null : (
                            <p key={section} data-section={section}>
                              <strong>{label(section)}: </strong>
                              {project.narrative[section]}
                            </p>
                          ),
                        )
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {drill.hasNextPage ? (
            <p>
              <button type="button" disabled={drill.isFetchingNextPage} onClick={() => void drill.fetchNextPage()}>
                {t('prj.monthly.more.action')}
              </button>
            </p>
          ) : null}
        </section>
      </StateBoundary>
      <p className="prototype-note">{t('prj.monthly.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
