import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { ConfirmDialog, ContextBar, DataTable, FilterPanel, FlowChart, KpiStrip, KpiTile, SectionCard, StatusPill } from '../../../ui';
import type { FlowSeries } from '../../../ui';
import { dayText, idFrom } from '../../gov3/model';
import { BackLink } from '../components';
import { EvidenceSummary, LevelPill, RuleInfo, RuleThresholds, TrendCell, UnverifiedPill } from './components';
import { useAcknowledgeRiskAlert, useProjectSignals, useRiskBoard } from './hooks';
import { alertStatusText, alertTypeText, kindText, levelText, refusalText } from './labels';
import { KINDS, LEVELS, describeRefusal, newestFirst, tracksOf } from './model';
import type { BoardItem, HistoryRow, Level, ProjectSignals, RiskAlert, SignalLine, Track } from './model';
import './risk-signals.css';

/**
 * PRJ-28: the risk board scored from signals and from the history of the scores (MR-1, MR.02). Five kinds of signal read from the facts of the system, and the risks of the register of PRJ-16, are ranked by score
 * across the projects the caller may see; a score is a word and a number with its trend, and every figure it came from says its unit or says it could not be known. Opened on a project (`?id=`) the screen shows how the
 * score of each line moved day by day, the lines with their evidence and the alerts, which a person with the right takes in with a note. The numbers come from the server; the browser never scores.
 */
export default function RiskSignalBoardScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  const [params] = useSearchParams();
  // The address decides the view: a move to another project (or back to the board) starts the screen over, so no filter or dialog of one view reaches another.
  const projectId = idFrom(params.get('id'));
  const key = `${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}:${projectId ?? ''}`;
  return projectId === undefined ? <BoardContent key={key} route={route} /> : <ProjectContent key={key} route={route} projectId={projectId} />;
}

const severityOf = (level: Level): 'URGENT' | 'WATCH' | null => (level === 'CRITICAL' ? 'URGENT' : level === 'MEDIUM' ? 'WATCH' : null);

// ---- the board ------------------------------------------------------------------------------------------------------------------

function BoardContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { tenant } = useSession();
  const [kind, setKind] = useState('');
  const [level, setLevel] = useState('');
  const board = useRiskBoard({ kind, level });
  const head = board.data?.pages[0];
  const items = (board.data?.pages ?? []).flatMap((page) => page.items);
  const state = useScreenState({ isLoading: board.isLoading, error: board.error, data: head, isEmpty: () => false });
  const applied = (kind === '' ? 0 : 1) + (level === '' ? 0 : 1);
  const clear = (): void => {
    setKind('');
    setLevel('');
  };
  const criticalScore = head?.policy.params.criticalScore ?? null;

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('mr1.risk.board.title')}</h1>
          <p>{t('mr1.risk.board.subtitle')}</p>
        </div>
      </div>
      <ContextBar items={[{ label: t('mr1.risk.ctx.scope'), value: tenant?.name ?? t('mr1.risk.ctx.scope.all') }]} {...(head === undefined ? {} : { asOf: dayText(head.asOf) })} />
      <FilterPanel applied={applied}>
        <label>
          {t('mr1.risk.filter.kind')}
          <select value={kind} data-testid="filter-kind" onChange={(event) => setKind(event.target.value)}>
            <option value="">{t('mr1.risk.filter.all')}</option>
            {KINDS.map((value) => (
              <option key={value} value={value}>
                {kindText(t, value)}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('mr1.risk.filter.level')}
          <select value={level} data-testid="filter-level" onChange={(event) => setLevel(event.target.value)}>
            <option value="">{t('mr1.risk.filter.all')}</option>
            {LEVELS.map((value) => (
              <option key={value} value={value}>
                {levelText(t, value)}
              </option>
            ))}
          </select>
        </label>
      </FilterPanel>
      <StateBoundary state={state} onRetry={() => void board.refetch()}>
        {head === undefined ? null : (
          <>
            {head.policy.unverified ? (
              <p className="callout warning" role="status" data-testid="unverified-notice">
                {t('mr1.risk.unverified.notice')}
              </p>
            ) : null}
            <KpiStrip label={t('mr1.risk.kpi.label')}>
              <KpiTile label={t('mr1.risk.kpi.total')} value={String(head.counts.total)} sub={<RuleInfo policy={head.policy} asOf={head.asOf} name={t('mr1.risk.kpi.total')} />} />
              <KpiTile
                label={t('mr1.risk.kpi.critical')}
                value={String(head.counts.critical)}
                tone="danger"
                sub={
                  <>
                    {criticalScore === null ? t('mr1.risk.kpi.critical.unknown') : t('mr1.risk.kpi.critical.sub', { score: criticalScore })} <RuleInfo policy={head.policy} asOf={head.asOf} name={t('mr1.risk.kpi.critical')} />
                  </>
                }
              />
              <KpiTile label={t('mr1.risk.kpi.medium')} value={String(head.counts.medium)} tone="warning" sub={<RuleInfo policy={head.policy} asOf={head.asOf} name={t('mr1.risk.kpi.medium')} />} />
              <KpiTile label={t('mr1.risk.kpi.low')} value={String(head.counts.low)} tone="success" sub={<RuleInfo policy={head.policy} asOf={head.asOf} name={t('mr1.risk.kpi.low')} />} />
              <KpiTile label={t('mr1.risk.kpi.alerts')} value={String(head.counts.openAlerts)} tone={head.counts.openAlerts > 0 ? 'warning' : 'default'} sub={<RuleInfo policy={head.policy} asOf={head.asOf} name={t('mr1.risk.kpi.alerts')} />} />
            </KpiStrip>
            <SectionCard title={t('mr1.risk.board.table.title')}>
              <DataTable<BoardItem>
                caption={t('mr1.risk.board.table.title')}
                rows={items}
                rowKey={(row) => `${row.origin}:${row.id}`}
                severity={(row) => severityOf(row.level)}
                rowAttrs={(row) => ({ 'data-origin': row.origin, 'data-level': row.level, 'data-project': row.projectId })}
                state={items.length === 0 ? 'empty' : 'ready'}
                emptyKind={applied > 0 ? 'filtered' : 'none'}
                onClearFilters={clear}
                columns={[
                  {
                    key: 'project',
                    header: t('mr1.risk.col.project'),
                    pinned: true,
                    render: (row) => (
                      <span>
                        <Link to={{ search: `?id=${row.projectId}` }} data-testid="open-project">
                          {row.projectCode}
                        </Link>
                        <span className="muted rs-block">{row.projectName}</span>
                      </span>
                    ),
                  },
                  {
                    key: 'kind',
                    header: t('mr1.risk.col.kind'),
                    render: (row) => (
                      <span>
                        {kindText(t, row.kind)}
                        {row.title === null ? null : <span className="muted rs-block">{row.title}</span>}
                        {row.origin === 'REGISTER' ? (
                          <Link className="rs-block" to={`/prj/prj-16?id=${row.projectId}`} data-testid="open-register">
                            {t('mr1.risk.board.openRegister')}
                          </Link>
                        ) : null}
                      </span>
                    ),
                  },
                  {
                    key: 'score',
                    header: t('mr1.risk.col.score'),
                    align: 'right',
                    render: (row) => (
                      <span className="rs-score">
                        <strong>{row.score}</strong> <LevelPill level={row.level} />
                        <span className="muted rs-block">{t('mr1.risk.score.factors', { likelihood: row.likelihood, impact: row.impact })}</span>
                        <RuleInfo policy={head.policy} asOf={head.asOf} name={t('mr1.risk.score.name', { project: row.projectCode })} />
                      </span>
                    ),
                  },
                  { key: 'trend', header: t('mr1.risk.col.trend'), render: (row) => <TrendCell trend={row.trend} previous={row.previousScore} /> },
                  { key: 'evidence', header: t('mr1.risk.col.evidence'), render: (row) => <EvidenceSummary evidence={row.evidence} /> },
                  { key: 'owner', header: t('mr1.risk.col.owner'), render: (row) => row.owner?.displayName ?? (row.owner === null ? t('mr1.risk.owner.none') : row.owner.membershipId.slice(0, 8)) },
                  {
                    key: 'alert',
                    header: t('mr1.risk.col.alert'),
                    render: (row) => (row.alertOpen ? <StatusPill tone="danger" icon={<span aria-hidden="true">!</span>}>{t('mr1.risk.alert.open')}</StatusPill> : <span className="muted">{t('mr1.risk.alert.none')}</span>),
                  },
                  { key: 'scored', header: t('mr1.risk.col.scoredOn'), render: (row) => dayText(row.scoredOn) },
                  { key: 'rule', header: t('mr1.risk.col.rule'), render: (row) => <UnverifiedPill unverified={row.ruleUnverified} /> },
                ]}
              />
              {board.hasNextPage ? (
                <p>
                  <button type="button" className="ui-button ui-button--outline" data-testid="load-more" disabled={board.isFetchingNextPage} onClick={() => void board.fetchNextPage()}>
                    {t('mr1.risk.board.more')}
                  </button>
                </p>
              ) : null}
            </SectionCard>
            <RuleThresholds policy={head.policy} asOf={head.asOf} />
          </>
        )}
      </StateBoundary>
      <p className="prototype-note">{t('mr1.risk.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

// ---- one project ----------------------------------------------------------------------------------------------------------------

type Message = { tone: 'ok' | 'error'; text: string };

/** The level a line stands at is the one the server wrote with its newest score: the browser does not score. */
function levelOfLine(line: SignalLine, history: readonly HistoryRow[]): Level | undefined {
  return newestFirst(history).find((row) => row.signalId === line.id)?.level;
}

function ProjectContent({ route, projectId }: ScreenProps & { projectId: string }) {
  const { t } = useTranslation();
  const { tenant, mode } = useSession();
  const signals = useProjectSignals(projectId);
  const state = useScreenState({ isLoading: signals.isLoading, error: signals.error, data: signals.data, isEmpty: () => false });
  const view = signals.data ?? undefined;
  const writable = mode !== 'READ_ONLY';
  const [acknowledging, setAcknowledging] = useState<RiskAlert | undefined>(undefined);
  const [refusal, setRefusal] = useState<string | undefined>(undefined);
  const [message, setMessage] = useState<Message | undefined>(undefined);
  const acknowledge = useAcknowledgeRiskAlert();
  const close = (): void => {
    setAcknowledging(undefined);
    setRefusal(undefined);
    acknowledge.reset();
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <BackLink to={route.path}>{t('mr1.risk.project.back')}</BackLink>
      <div className="heading">
        <div>
          <h1 id="screen-title">{view === undefined ? t('mr1.risk.project.title') : t('mr1.risk.project.titleOf', { code: view.project.code })}</h1>
          <p>{view === undefined ? t('mr1.risk.project.subtitle') : t('mr1.risk.project.subtitleOf', { name: view.project.name })}</p>
        </div>
      </div>
      <ContextBar
        items={[{ label: t('mr1.risk.ctx.scope'), value: tenant?.name ?? t('mr1.risk.ctx.scope.all') }, ...(view === undefined ? [] : [{ label: t('mr1.risk.ctx.project'), value: view.project.code }])]}
        {...(view === undefined ? {} : { asOf: dayText(view.asOf) })}
      />
      <StateBoundary state={state} onRetry={() => void signals.refetch()}>
        {signals.data === null ? (
          <p className="callout warning" role="alert" data-testid="project-missing">
            {t('mr1.risk.project.missing')}
          </p>
        ) : view === undefined ? null : (
          <>
            {message === undefined ? null : (
              <p className={message.tone === 'ok' ? 'callout' : 'callout warning'} role={message.tone === 'ok' ? 'status' : 'alert'} data-testid="message">
                {message.text}
              </p>
            )}
            {view.policy.unverified ? (
              <p className="callout warning" role="status" data-testid="unverified-notice">
                {t('mr1.risk.unverified.notice')}
              </p>
            ) : null}
            <LinesSection view={view} />
            <ChartsSection view={view} />
            <HistorySection view={view} />
            <SectionCard title={t('mr1.risk.alerts.title')} status={<RuleInfo policy={view.policy} asOf={view.asOf} name={t('mr1.risk.alerts.title')} />}>
              <DataTable<RiskAlert>
                caption={t('mr1.risk.alerts.title')}
                rows={view.alerts}
                rowKey={(row) => row.id}
                rowAttrs={(row) => ({ 'data-alert': row.id, 'data-status': row.status })}
                state={view.alerts.length === 0 ? 'empty' : 'ready'}
                columns={[
                  { key: 'status', header: t('mr1.risk.alerts.status'), render: (row) => <StatusPill tone={row.status === 'OPEN' ? 'danger' : row.status === 'ACKNOWLEDGED' ? 'info' : 'success'}>{alertStatusText(t, row.status)}</StatusPill> },
                  { key: 'type', header: t('mr1.risk.alerts.type'), render: (row) => alertTypeText(t, row.type) },
                  { key: 'subject', header: t('mr1.risk.alerts.subject'), render: (row) => (row.kind === null ? t('mr1.risk.kind.register') : kindText(t, row.kind)) },
                  {
                    key: 'score',
                    header: t('mr1.risk.alerts.score'),
                    align: 'right',
                    render: (row) => (
                      <span>
                        {row.type === 'RISK_SCORE_JUMP' && row.priorScore !== null ? t('mr1.risk.alerts.jump', { prior: row.priorScore, score: row.score, threshold: row.threshold }) : t('mr1.risk.alerts.critical', { score: row.score, threshold: row.threshold })}{' '}
                        <RuleInfo policy={view.policy} asOf={view.asOf} name={t('mr1.risk.alerts.score')} />
                      </span>
                    ),
                  },
                  { key: 'raised', header: t('mr1.risk.alerts.raised'), render: (row) => `${dayText(row.raisedOn)} · ${t('mr1.risk.rule.version', { version: row.ruleVersion })}` },
                  { key: 'rule', header: t('mr1.risk.col.rule'), render: (row) => <UnverifiedPill unverified={row.ruleUnverified} /> },
                  { key: 'note', header: t('mr1.risk.alerts.note'), render: (row) => (row.acknowledgedAt === null ? '' : `${dayText(row.acknowledgedAt.slice(0, 10))} · ${row.acknowledgeNote ?? ''}`) },
                  {
                    key: 'actions',
                    header: t('mr1.risk.alerts.actions'),
                    render: (row) =>
                      writable && view.canAcknowledge && row.status === 'OPEN' ? (
                        <button type="button" className="ui-button ui-button--outline ui-button--small" data-action="acknowledge" onClick={() => setAcknowledging(row)}>
                          {t('mr1.risk.alerts.acknowledge')}
                        </button>
                      ) : null,
                  },
                ]}
              />
            </SectionCard>
            <RuleThresholds policy={view.policy} asOf={view.asOf} />
            <ConfirmDialog
              open={acknowledging !== undefined}
              title={t('mr1.risk.acknowledge.title')}
              context={
                acknowledging === undefined
                  ? []
                  : [
                      { label: t('mr1.risk.ctx.project'), value: view.project.code },
                      { label: t('mr1.risk.alerts.type'), value: alertTypeText(t, acknowledging.type) },
                      { label: t('mr1.risk.alerts.subject'), value: acknowledging.kind === null ? t('mr1.risk.kind.register') : kindText(t, acknowledging.kind) },
                      { label: t('mr1.risk.alerts.score'), value: t('mr1.risk.alerts.critical', { score: acknowledging.score, threshold: acknowledging.threshold }) },
                    ]
              }
              confirmLabel={t('mr1.risk.alerts.acknowledge')}
              cancelLabel={t('mr1.risk.common.cancel')}
              pending={acknowledge.isPending}
              reason={{ label: t('mr1.risk.acknowledge.note'), required: true, hint: t('mr1.risk.acknowledge.hint') }}
              {...(refusal === undefined ? {} : { error: refusal })}
              onCancel={close}
              onConfirm={(note) => {
                if (acknowledging === undefined || note === undefined || note.trim() === '') return;
                setRefusal(undefined);
                acknowledge.mutate(
                  { id: acknowledging.id, version: acknowledging.version, body: { note: note.trim() } },
                  {
                    onSuccess: () => {
                      close();
                      setMessage({ tone: 'ok', text: t('mr1.risk.acknowledge.done') });
                    },
                    onError: (error) => setRefusal(refusalText(t, describeRefusal(error))),
                  },
                );
              }}
            />
          </>
        )}
      </StateBoundary>
      <p className="prototype-note">{t('mr1.risk.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function LinesSection({ view }: { view: ProjectSignals }) {
  const { t } = useTranslation();
  return (
    <SectionCard title={t('mr1.risk.lines.title')} status={<RuleInfo policy={view.policy} asOf={view.asOf} name={t('mr1.risk.lines.title')} />}>
      <DataTable<SignalLine>
        caption={t('mr1.risk.lines.title')}
        rows={view.lines}
        rowKey={(row) => row.id}
        rowAttrs={(row) => ({ 'data-line': row.id, 'data-status': row.status })}
        state={view.lines.length === 0 ? 'empty' : 'ready'}
        columns={[
          { key: 'kind', header: t('mr1.risk.col.kind'), render: (row) => kindText(t, row.kind) },
          { key: 'status', header: t('mr1.risk.lines.status'), render: (row) => <StatusPill tone={row.status === 'ACTIVE' ? 'warning' : 'neutral'}>{row.status === 'ACTIVE' ? t('mr1.risk.lines.active') : t('mr1.risk.lines.cleared')}</StatusPill> },
          {
            key: 'score',
            header: t('mr1.risk.col.score'),
            align: 'right',
            render: (row) => {
              const level = levelOfLine(row, view.history);
              return (
                <span className="rs-score">
                  <strong>{row.score}</strong> {level === undefined ? <StatusPill tone="neutral">{t('mr1.risk.evidence.unknown')}</StatusPill> : <LevelPill level={level} />}
                  <span className="muted rs-block">{t('mr1.risk.score.factors', { likelihood: row.likelihood, impact: row.impact })}</span>
                  <RuleInfo policy={view.policy} asOf={view.asOf} name={t('mr1.risk.score.name', { project: view.project.code })} />
                </span>
              );
            },
          },
          { key: 'evidence', header: t('mr1.risk.col.evidence'), render: (row) => <EvidenceSummary evidence={row.evidence} withFacts /> },
          { key: 'first', header: t('mr1.risk.lines.first'), render: (row) => dayText(row.firstScoredOn) },
          { key: 'last', header: t('mr1.risk.lines.last'), render: (row) => (row.clearedOn === null ? dayText(row.lastScoredOn) : t('mr1.risk.lines.clearedOn', { day: dayText(row.clearedOn) })) },
          { key: 'rule', header: t('mr1.risk.col.rule'), render: (row) => t('mr1.risk.rule.version', { version: row.ruleVersion }) },
          { key: 'unverified', header: t('mr1.risk.col.ruleState'), render: (row) => <UnverifiedPill unverified={row.ruleUnverified} /> },
        ]}
      />
    </SectionCard>
  );
}

function ChartsSection({ view }: { view: ProjectSignals }) {
  const { t } = useTranslation();
  const tracks = tracksOf(view.history);
  const critical = view.policy.params.criticalScore;
  const label = (track: Track): string => (track.subjectKind === 'RISK' ? t('mr1.risk.chart.register') : kindText(t, track.kind));
  const series = (track: Track): FlowSeries[] => [
    { label: t('mr1.risk.chart.score', { name: label(track) }), style: 'actual', points: track.points.map((point) => ({ x: dayText(point.day), y: point.score })) },
    ...(critical === null ? [] : [{ label: t('mr1.risk.chart.critical', { score: critical }), style: 'plan' as const, points: track.points.map((point) => ({ x: dayText(point.day), y: critical })) }]),
  ];
  return (
    <SectionCard title={t('mr1.risk.charts.title')} unit={t('mr1.risk.charts.unit')}>
      {tracks.length === 0 ? (
        <p className="callout" data-testid="no-history">
          {t('mr1.risk.charts.none')}
        </p>
      ) : (
        <div className="rs-charts">
          {tracks.map((track) => (
            <div key={track.key} data-track={track.key}>
              <h3>{label(track)}</h3>
              <FlowChart series={series(track)} unit={t('mr1.risk.charts.unit')} caption={t('mr1.risk.chart.caption', { name: label(track) })} />
            </div>
          ))}
        </div>
      )}
    </SectionCard>
  );
}

function HistorySection({ view }: { view: ProjectSignals }) {
  const { t } = useTranslation();
  const rows = newestFirst(view.history);
  return (
    <SectionCard title={t('mr1.risk.history.title')} status={<RuleInfo policy={view.policy} asOf={view.asOf} name={t('mr1.risk.history.title')} />}>
      <DataTable<HistoryRow>
        caption={t('mr1.risk.history.title')}
        rows={rows}
        rowKey={(row) => row.id}
        rowAttrs={(row) => ({ 'data-history': row.id })}
        state={rows.length === 0 ? 'empty' : 'ready'}
        columns={[
          { key: 'day', header: t('mr1.risk.history.day'), render: (row) => dayText(row.scoredOn) },
          { key: 'subject', header: t('mr1.risk.alerts.subject'), render: (row) => (row.subjectKind === 'RISK' ? t('mr1.risk.chart.register') : kindText(t, row.kind)) },
          { key: 'source', header: t('mr1.risk.history.source'), render: (row) => (row.source === 'MANUAL' ? t('mr1.risk.history.source.manual') : t('mr1.risk.history.source.job')) },
          { key: 'factors', header: t('mr1.risk.history.factors'), render: (row) => t('mr1.risk.score.factors', { likelihood: row.likelihood, impact: row.impact }) },
          {
            key: 'score',
            header: t('mr1.risk.col.score'),
            align: 'right',
            render: (row) => (
              <span className="rs-score">
                <strong>{row.score}</strong> <LevelPill level={row.level} />
                <RuleInfo policy={view.policy} asOf={view.asOf} name={t('mr1.risk.score.name', { project: view.project.code })} />
              </span>
            ),
          },
          { key: 'prior', header: t('mr1.risk.history.prior'), align: 'right', render: (row) => (row.priorScore === null ? t('mr1.risk.history.noPrior') : String(row.priorScore)) },
          { key: 'evidence', header: t('mr1.risk.col.evidence'), render: (row) => <EvidenceSummary evidence={row.evidence} /> },
          { key: 'rule', header: t('mr1.risk.col.rule'), render: (row) => t('mr1.risk.rule.version', { version: row.ruleVersion }) },
        ]}
      />
    </SectionCard>
  );
}
