import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { Field } from '../components';
import { usePeriods } from '../hooks';
import '../dis.css';
import { useBoard, useDrill } from './hooks';
import { projectState, stateLabel } from './labels';
import { DETAIL_PATH, asDrillState, countOf, defaultPeriod, describeBoard, drillLink } from './model';
import type { Counts, DrillState } from './model';

/**
 * DIS-15: how many projects of each unit must report for a period, have handed in (and how many of those late), have a draft, have not started and are overdue (ST-DIS-015, FR-DIS-15). Every number leads
 * to the exact projects it counted; lateness is the one stored when the report came in. A project that came in after the deadline is submitted and late, and is not overdue: overdue is what is still not in.
 */
export default function SubmissionBoardScreen({ route }: ScreenProps) {
  const tenantId = useSession().tenant?.id;
  return <BoardContent key={tenantId ?? 'none'} route={route} />;
}

const NUMBERS: ReadonlyArray<DrillState> = ['MUST_REPORT', 'SUBMITTED', 'DRAFT', 'NOT_STARTED', 'OVERDUE'];

function BoardContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const periods = usePeriods();
  const today = new Date().toISOString().slice(0, 10);
  const chosen = params.get('period') ?? defaultPeriod(periods.data ?? [], today)?.id;
  const board = useBoard(chosen);
  const unitId = params.get('unit') ?? undefined;
  const drillState = asDrillState(params.get('state'));
  const drill = useDrill(chosen, drillState === undefined ? undefined : { unitId, state: drillState, withNarrative: false });
  const state = useScreenState({ isLoading: (chosen === undefined && periods.isLoading) || board.isLoading, error: chosen === undefined ? periods.error : board.error, data: board.data, isEmpty: (data) => (data as { units: unknown[] }).units.length === 0 });
  const projects = (drill.data?.pages ?? []).flatMap((page) => page?.projects ?? []);
  const unitName = board.data?.units.find((unit) => unit.unit.id === unitId)?.unit.name;
  const choose = (next: string): void => setParams(new URLSearchParams({ period: next }), { replace: true });
  const numberCell = (counts: Counts, unit: string | undefined, key: DrillState) => {
    const value = countOf(counts, key);
    return value === 0 ? <span>{value}</span> : <Link to={drillLink(chosen ?? '', unit, key)}>{value}</Link>;
  };
  const lateNote = (counts: Counts, unit: string | undefined) =>
    counts.submittedLate === 0 ? null : (
      <span className="dis-code" data-late-note>
        <Link to={drillLink(chosen ?? '', unit, 'LATE_SUBMITTED')}>{t('dis.board.late.note', { count: String(counts.submittedLate) })}</Link>
      </span>
    );
  const refused = board.isError ? describeBoard(board.error) : undefined;
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('dis.board.page.title')}</h1>
          <p>{t('dis.board.page.subtitle')}</p>
        </div>
      </div>
      <div className="card">
        <div className="dis-filters" role="group" aria-label={t('dis.board.filter.title')}>
          <Field id="board-period" label={t('dis.board.period.label')} error={undefined}>
            <select id="board-period" value={chosen ?? ''} onChange={(event) => choose(event.target.value)}>
              {[...(periods.data ?? []), ...(chosen !== undefined && board.data !== undefined && !(periods.data ?? []).some((period) => period.id === chosen) ? [{ id: chosen, code: board.data.periodCode, startDate: '', endDate: '' }] : [])]
                .sort((left, right) => (left.startDate < right.startDate ? 1 : left.startDate > right.startDate ? -1 : 0))
                .map((period) => (
                  <option key={period.id} value={period.id}>
                    {period.startDate === '' ? period.code : t('dis.board.period.option', { code: period.code, start: period.startDate, end: period.endDate })}
                  </option>
                ))}
            </select>
          </Field>
        </div>
      </div>
      {refused === 'notFound' || refused === 'validation' ? (
        <p className="callout warning" role="alert" data-testid="board-refusal">
          {refused === 'notFound' ? t('dis.board.problem.notFound') : t('dis.board.problem.validation')}
        </p>
      ) : null}
      <StateBoundary state={refused === 'notFound' || refused === 'validation' ? 'default' : chosen === undefined && !periods.isLoading && !periods.isError ? 'empty' : state} onRetry={() => void Promise.all([periods.refetch(), board.refetch()])}>
        {board.data === undefined ? null : (
          <section className="card" aria-labelledby="board-table-title">
            <h2 id="board-table-title">{t('dis.board.table.title', { code: board.data.periodCode })}</h2>
            <p className="sub" data-testid="board-deadline">
              {board.data.deadlinePassed ? t('dis.board.deadline.passed', { deadline: board.data.deadlineAt.slice(0, 10) }) : t('dis.board.deadline.open', { deadline: board.data.deadlineAt.slice(0, 10) })}
            </p>
            <div className="tablewrap">
              <table className="table" aria-label={t('dis.board.table.aria')} data-testid="board-table">
                <thead>
                  <tr>
                    <th scope="col">{t('dis.board.col.unit')}</th>
                    {NUMBERS.map((key) => (
                      <th key={key} scope="col" className="num">
                        {stateLabel(t, key)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {board.data.units.map((row) => (
                    <tr key={row.unit.id} data-unit={row.unit.id}>
                      <td>
                        {row.unit.name}
                        <span className="dis-code">{row.unit.code}</span>
                      </td>
                      {NUMBERS.map((key) => (
                        <td key={key} className="num" data-cell={key}>
                          {numberCell(row, row.unit.id, key)}
                          {key === 'SUBMITTED' ? lateNote(row, row.unit.id) : null}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr data-testid="board-total">
                    <th scope="row">{t('dis.board.total.label')}</th>
                    {NUMBERS.map((key) => (
                      <td key={key} className="num" data-cell={key}>
                        {numberCell(board.data?.total as Counts, undefined, key)}
                        {key === 'SUBMITTED' ? lateNote(board.data?.total as Counts, undefined) : null}
                      </td>
                    ))}
                  </tr>
                </tfoot>
              </table>
            </div>
          </section>
        )}
        {drillState === undefined ? null : (
          <section className="card" aria-labelledby="drill-title" data-testid="drill">
            <h2 id="drill-title">{t('dis.board.drill.title', { state: stateLabel(t, drillState), unit: unitName ?? t('dis.board.drill.allUnits') })}</h2>
            {drill.isLoading ? <p role="status">{t('states.loading.label')}</p> : null}
            {drill.isError ? (
              <p className="callout warning" role="alert" data-testid="drill-refusal">
                {t('dis.board.problem.general')}
              </p>
            ) : null}
            {!drill.isLoading && !drill.isError && projects.length === 0 ? <p className="muted">{t('dis.board.drill.empty.text')}</p> : null}
            {projects.length === 0 ? null : (
              <div className="tablewrap">
                <table className="table" aria-label={t('dis.board.drill.aria')} data-testid="drill-table">
                  <thead>
                    <tr>
                      <th scope="col">{t('dis.board.drill.col.project')}</th>
                      <th scope="col">{t('dis.board.col.unit')}</th>
                      <th scope="col">{t('dis.board.drill.col.state')}</th>
                      <th scope="col">
                        <span className="sr-only">{t('dis.board.drill.col.report')}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {projects.map((project) => (
                      <tr key={project.projectId} data-project={project.projectId}>
                        <td>
                          {project.projectCode}
                          <span className="dis-code">{project.projectName}</span>
                        </td>
                        <td>{project.unit.name}</td>
                        <td>
                          <span className={`pill ${project.state === 'SUBMITTED' ? 'green' : project.overdue ? 'warn' : 'gray'}`}>{projectState(t, project)}</span>
                          {project.isLate ? <span className="pill warn">{t('dis.board.flag.late')}</span> : null}
                          {project.overdue ? <span className="pill warn">{t('dis.board.flag.overdue')}</span> : null}
                        </td>
                        <td>{project.report === null ? null : <Link to={`${DETAIL_PATH}?report=${project.report.id}`}>{t('dis.board.drill.report.link')}</Link>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {drill.hasNextPage ? (
              <p>
                <button type="button" disabled={drill.isFetchingNextPage} onClick={() => void drill.fetchNextPage()}>
                  {t('dis.board.drill.more.action')}
                </button>
              </p>
            ) : null}
          </section>
        )}
      </StateBoundary>
      <p className="prototype-note">{t('dis.board.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
