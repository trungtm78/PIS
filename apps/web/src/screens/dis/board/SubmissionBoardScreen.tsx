import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { ContextBar, DataTable, FilterPanel, KpiStrip, KpiTile, SectionCard, StatusPill } from '../../../ui';
import type { DataTableColumn } from '../../../ui';
import { Field } from '../components';
import { usePeriods } from '../hooks';
import '../dis.css';
import { useBoard, useDrill } from './hooks';
import { projectState, stateLabel } from './labels';
import { DETAIL_PATH, asDrillState, countOf, defaultPeriod, describeBoard, drillLink } from './model';
import type { BoardProject, Counts, DrillState, UnitCounts } from './model';

/**
 * DIS-15: how many projects of each unit must report for a period, have handed in (and how many of those late), have a draft, have not started and are overdue (ST-DIS-015, FR-DIS-15). Every number leads
 * to the exact projects it counted; lateness is the one stored when the report came in. A project that came in after the deadline is submitted and late, and is not overdue: overdue is what is still not in.
 */
export default function SubmissionBoardScreen({ route }: ScreenProps) {
  const tenantId = useSession().tenant?.id;
  return <BoardContent key={tenantId ?? 'none'} route={route} />;
}

const NUMBERS: ReadonlyArray<DrillState> = ['MUST_REPORT', 'SUBMITTED', 'DRAFT', 'NOT_STARTED', 'OVERDUE'];

type T = ReturnType<typeof useTranslation>['t'];

function BoardContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const tenant = useSession().tenant;
  const [params, setParams] = useSearchParams();
  const periods = usePeriods();
  const today = new Date().toISOString().slice(0, 10);
  const chosen = params.get('period') ?? defaultPeriod(periods.data ?? [], today)?.id;
  const board = useBoard(chosen);
  const unitId = params.get('unit') ?? undefined;
  const drillState = asDrillState(params.get('state'));
  const drill = useDrill(chosen, drillState === undefined ? undefined : { unitId, state: drillState, withNarrative: false });
  const state = useScreenState({
    isLoading: (chosen === undefined && periods.isLoading) || board.isLoading,
    error: chosen === undefined ? periods.error : board.error,
    data: board.data,
    isEmpty: (data) => (data as { units: unknown[] }).units.length === 0,
  });
  const projects = (drill.data?.pages ?? []).flatMap((page) => page?.projects ?? []);
  const data = board.data;
  const unitName = data?.units.find((unit) => unit.unit.id === unitId)?.unit.name;
  const choose = (next: string): void => setParams(new URLSearchParams({ period: next }), { replace: true });
  const refused = board.isError ? describeBoard(board.error) : undefined;
  const deadline = data?.deadlineAt.slice(0, 10);
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('dis.board.page.title')}</h1>
          <p>{t('dis.board.page.subtitle')}</p>
        </div>
      </div>
      <ContextBar
        items={[
          { label: t('dis.wr.ctx.scope'), value: tenant?.name ?? t('dis.wr.ctx.scope.all') },
          { label: t('dis.wr.ctx.period'), value: data?.periodCode ?? t('dis.wr.ctx.period.none') },
          { label: t('dis.wr.ctx.deadline'), value: deadline ?? t('dis.wr.ctx.period.none') },
        ]}
      />
      <FilterPanel>
        <div className="dis-filters" role="group" aria-label={t('dis.board.filter.title')}>
          <Field id="board-period" label={t('dis.board.period.label')} error={undefined}>
            <select id="board-period" value={chosen ?? ''} onChange={(event) => choose(event.target.value)}>
              {[...(periods.data ?? []), ...(chosen !== undefined && data !== undefined && !(periods.data ?? []).some((period) => period.id === chosen) ? [{ id: chosen, code: data.periodCode, startDate: '', endDate: '' }] : [])]
                .sort((left, right) => (left.startDate < right.startDate ? 1 : left.startDate > right.startDate ? -1 : 0))
                .map((period) => (
                  <option key={period.id} value={period.id}>
                    {period.startDate === '' ? period.code : t('dis.board.period.option', { code: period.code, start: period.startDate, end: period.endDate })}
                  </option>
                ))}
            </select>
          </Field>
        </div>
      </FilterPanel>
      {refused === 'notFound' || refused === 'validation' ? (
        <p className="dis-w2-banner" role="alert" data-testid="board-refusal">
          {refused === 'notFound' ? t('dis.board.problem.notFound') : t('dis.board.problem.validation')}
        </p>
      ) : null}
      <StateBoundary
        state={refused === 'notFound' || refused === 'validation' ? 'default' : chosen === undefined && !periods.isLoading && !periods.isError ? 'empty' : state}
        onRetry={() => void Promise.all([periods.refetch(), board.refetch()])}
      >
        {data === undefined ? null : (
          <div className="dis-w2-stack">
            <TotalsTiles total={data.total} />
            <SectionCard
              title={t('dis.board.table.title', { code: data.periodCode })}
              status={
                <span data-testid="board-deadline">
                  <StatusPill tone={data.deadlinePassed ? 'warning' : 'info'}>
                    {data.deadlinePassed ? t('dis.board.deadline.passed', { deadline: data.deadlineAt.slice(0, 10) }) : t('dis.board.deadline.open', { deadline: data.deadlineAt.slice(0, 10) })}
                  </StatusPill>
                </span>
              }
            >
              <BoardTable units={data.units} total={data.total} period={chosen ?? ''} />
            </SectionCard>
          </div>
        )}
        {drillState === undefined ? null : (
          <div data-testid="drill">
            <SectionCard title={t('dis.board.drill.title', { state: stateLabel(t, drillState), unit: unitName ?? t('dis.board.drill.allUnits') })}>
              {drill.isError ? (
                <p className="dis-w2-banner" role="alert" data-testid="drill-refusal">
                  {t('dis.board.problem.general')}
                  <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => void drill.refetch()}>
                    {t('states.retry.action')}
                  </button>
                </p>
              ) : null}
              {!drill.isLoading && !drill.isError && projects.length === 0 ? <p className="dis-w2-empty">{t('dis.board.drill.empty.text')}</p> : null}
              {drill.isLoading || projects.length > 0 ? (
                <DataTable caption={t('dis.board.drill.aria')} columns={drillColumns(t)} rows={projects} rowKey={(project) => project.projectId} state={drill.isLoading ? 'loading' : 'ready'} />
              ) : null}
              {drill.hasNextPage ? (
                <p className="dis-w2-more">
                  <button type="button" className="ui-button ui-button--outline" disabled={drill.isFetchingNextPage} onClick={() => void drill.fetchNextPage()}>
                    {t('dis.board.drill.more.action')}
                  </button>
                </p>
              ) : null}
            </SectionCard>
          </div>
        )}
      </StateBoundary>
      <p className="prototype-note">{t('dis.board.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

/** The five numbers of the whole scope, before the table that breaks them down by unit: what was handed in is read against what had to be, and a scope with nothing to report has no rate. */
function TotalsTiles({ total }: { total: Counts }) {
  const { t } = useTranslation();
  const share = total.mustReport === 0 ? undefined : Math.round((total.submitted / total.mustReport) * 100);
  return (
    <KpiStrip label={t('w2dis.board.kpi.label')}>
      <KpiTile label={stateLabel(t, 'MUST_REPORT')} value={String(total.mustReport)} tone="neutral" />
      <KpiTile label={stateLabel(t, 'SUBMITTED')} value={String(total.submitted)} tone="success" sub={share === undefined ? t('w2dis.board.kpi.na') : t('w2dis.board.kpi.share', { percent: share, late: total.submittedLate })} />
      <KpiTile label={stateLabel(t, 'DRAFT')} value={String(total.draft)} tone="info" />
      <KpiTile label={stateLabel(t, 'NOT_STARTED')} value={String(total.notStarted)} tone="neutral" />
      <KpiTile label={stateLabel(t, 'OVERDUE')} value={String(total.overdue)} tone={total.overdue > 0 ? 'danger' : 'success'} />
    </KpiStrip>
  );
}

function BoardTable({ units, total, period }: { units: UnitCounts[]; total: Counts; period: string }) {
  const { t } = useTranslation();
  const numberCell = (counts: Counts, unit: string | undefined, key: DrillState) => {
    const value = countOf(counts, key);
    return value === 0 ? <span>{value}</span> : <Link to={drillLink(period, unit, key)}>{value}</Link>;
  };
  const lateNote = (counts: Counts, unit: string | undefined) =>
    counts.submittedLate === 0 ? null : (
      <span className="dis-code" data-late-note>
        <Link to={drillLink(period, unit, 'LATE_SUBMITTED')}>{t('dis.board.late.note', { count: String(counts.submittedLate) })}</Link>
      </span>
    );
  const cell = (counts: Counts, unit: string | undefined, key: DrillState) => (
    <span data-cell={key}>
      {numberCell(counts, unit, key)}
      {key === 'SUBMITTED' ? lateNote(counts, unit) : null}
    </span>
  );
  const columns: DataTableColumn<UnitCounts>[] = [
    {
      key: 'unit',
      header: t('dis.board.col.unit'),
      pinned: true,
      render: (row) => (
        <span data-unit={row.unit.id}>
          <strong>{row.unit.name}</strong>
          <span className="dis-code">{row.unit.code}</span>
        </span>
      ),
    },
    ...NUMBERS.map((key): DataTableColumn<UnitCounts> => ({ key, header: stateLabel(t, key), group: t('w2dis.board.group.numbers'), align: 'right', render: (row) => cell(row, row.unit.id, key) })),
  ];
  return (
    <DataTable
      caption={t('dis.board.table.aria')}
      columns={columns}
      rows={units}
      rowKey={(row) => row.unit.id}
      totalsLabel={t('dis.board.total.label')}
      totals={Object.fromEntries(NUMBERS.map((key) => [key, cell(total, undefined, key)]))}
    />
  );
}

function drillColumns(t: T): DataTableColumn<BoardProject>[] {
  return [
    {
      key: 'project',
      header: t('dis.board.drill.col.project'),
      pinned: true,
      render: (project) => (
        <span data-project={project.projectId}>
          <strong>{project.projectCode}</strong>
          <span className="dis-code">{project.projectName}</span>
        </span>
      ),
    },
    { key: 'unit', header: t('dis.board.col.unit'), render: (project) => project.unit.name },
    {
      key: 'state',
      header: t('dis.board.drill.col.state'),
      render: (project) => (
        <span className="dis-w2-pills">
          <StatusPill tone={project.state === 'SUBMITTED' ? 'success' : project.overdue ? 'warning' : 'neutral'}>{projectState(t, project)}</StatusPill>
          {project.isLate ? <StatusPill tone="warning">{t('dis.board.flag.late')}</StatusPill> : null}
          {project.overdue ? <StatusPill tone="danger">{t('dis.board.flag.overdue')}</StatusPill> : null}
        </span>
      ),
    },
    {
      key: 'report',
      header: t('dis.board.drill.col.report'),
      render: (project) => (project.report === null ? null : <Link to={`${DETAIL_PATH}?report=${project.report.id}`}>{t('dis.board.drill.report.link')}</Link>),
    },
  ];
}
