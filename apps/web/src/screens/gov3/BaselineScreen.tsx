import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { ConfirmDialog, ContextBar, DataTable, KpiStrip, KpiTile, SectionCard, StatusPill } from '../../ui';
import { useDefaultProject } from '../prj/hooks';
import { LIST_PATH } from '../prj/model';
import { GovernanceAlertRegister } from './GovernanceAlertRegister';
import { useAcknowledgeAlert, useBaseline, useCaptureBaseline, useDecideReappraisal } from './hooks';
import { refusalText } from './labels';
import { asOfText, dayText, describeRefusal, deviationTone, idFrom, incompleteIssues, vnd } from './model';
import type { BaselinePolicy, BaselineVersion, GovernanceAlert, Reappraisal } from './model';
import './gov3.css';

type Translate = (key: string, params?: Record<string, string | number>) => string;
type Message = { tone: 'ok' | 'error'; text: string };

const policySource = (t: Translate, policy: BaselinePolicy): string => (policy.source === 'BUILT_IN' ? t('govb1.policy.builtIn') : t('govb1.policy.rule', { version: policy.version }));

const issueText = (t: Translate, problem: 'NO_FINISH_DATE' | 'FINISH_BEFORE_START' | 'OTHER'): string =>
  problem === 'NO_FINISH_DATE' ? t('govb1.issue.noFinish') : problem === 'FINISH_BEFORE_START' ? t('govb1.issue.beforeStart') : t('govb1.issue.other');

const reappraisalStatus = (t: Translate, request: Reappraisal): { tone: 'warning' | 'success' | 'neutral'; text: string } =>
  request.status === 'OPEN' ? { tone: 'warning', text: t('govb1.reapp.status.open') } : request.status === 'STARTED' ? { tone: 'success', text: t('govb1.reapp.status.started') } : { tone: 'neutral', text: t('govb1.reapp.status.waived') };

/**
 * PRJ-26: the baseline of a project (governance deepening G1-3): version 0 is chosen once from the approved work breakdown and the baseline days of the milestones and never changes; the revisions that follow
 * come from approved adjustments. What the project holds now is set against version 0: the cost, the budget at completion and the finish, with the threshold of the policy and the version of the rule that
 * judged. A date moved is counted for each milestone; the request to appraise again is decided by someone other than the maker of the change; the auditors acknowledge the alerts that reach them.
 */
export default function BaselineScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <BaselineContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function BaselineContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { tenant, mode } = useSession();
  const [params] = useSearchParams();
  const named = idFrom(params.get('project'));
  // Opened without a project in the address, the first project under way of the register is taken (the register stays one link away).
  const fallback = useDefaultProject(named === undefined, 'IMPLEMENTATION');
  const projectId = named ?? fallback.project?.id;
  const baseline = useBaseline(projectId);
  const state = useScreenState({ isLoading: baseline.isLoading, error: baseline.error, data: baseline.data, isEmpty: () => false });
  const money = (value: string | null | undefined): string => vnd(value, locale);
  const view = baseline.data ?? undefined;
  const writable = mode !== 'READ_ONLY';
  const [message, setMessage] = useState<Message | undefined>(undefined);
  const [capturing, setCapturing] = useState(false);
  const [captureError, setCaptureError] = useState<unknown>(undefined);
  const [decision, setDecision] = useState<{ request: Reappraisal; kind: 'START' | 'WAIVE' } | undefined>(undefined);
  const [acknowledging, setAcknowledging] = useState<GovernanceAlert | undefined>(undefined);
  const capture = useCaptureBaseline();
  const decide = useDecideReappraisal();
  const acknowledge = useAcknowledgeAlert();
  const issues = incompleteIssues(captureError);

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('govb1.baseline.title')}</h1>
          <p>{t('govb1.baseline.subtitle')}</p>
        </div>
      </div>
      <ContextBar
        items={[{ label: t('govb1.ctx.scope'), value: tenant?.name ?? t('govb1.ctx.scope.all') }, ...(view === undefined ? [] : [{ label: t('govb1.ctx.project'), value: view.projectCode }])]}
        unit={t('govb1.common.unit')}
        {...(view === undefined ? {} : { asOf: asOfText(view.asOf) })}
      />
      {projectId === undefined && named === undefined && fallback.isLoading ? (
        <StateBoundary state="loading" />
      ) : projectId === undefined ? (
        <>
          <p className="callout" data-testid="no-target">
            {t('govb1.baseline.noTarget')}
          </p>
          <GovernanceAlertRegister />
        </>
      ) : (
        <StateBoundary state={state} onRetry={() => void baseline.refetch()}>
          {named === undefined ? (
            <p className="callout" role="status" data-testid="default-project">
              {t('govb1.default.project.notice')} <Link to={LIST_PATH}>{t('govb1.default.project.link')}</Link>
            </p>
          ) : null}
          {view === undefined ? (
            <p className="callout" data-testid="missing">
              {t('govb1.baseline.missing')}
            </p>
          ) : (
            <>
              {message === undefined ? null : (
                <p className={message.tone === 'ok' ? 'callout' : 'callout gov3-error'} role={message.tone === 'ok' ? 'status' : 'alert'} data-testid="message">
                  {message.text}
                </p>
              )}
              <nav className="gov3-links" aria-label={t('govb1.baseline.links.label')}>
                <Link to={`/prj/prj-27?project=${view.projectId}`} data-testid="link-evm">
                  {t('govb1.baseline.link.evm')}
                </Link>
                <Link to={`/pay/pay-19?project=${view.projectId}`} data-testid="link-pay">
                  {t('govb1.baseline.link.pay')}
                </Link>
              </nav>

              {!view.hasBaseline ? (
                <SectionCard title={t('govb1.baseline.versions.title')} unit={t('govb1.common.unit')}>
                  <p className="callout" data-testid="no-baseline">
                    {t('govb1.baseline.none')}
                  </p>
                  <p className="muted">{t('govb1.baseline.none.hint')}</p>
                  {writable && view.actions.capture ? (
                    <button type="button" className="primary" data-testid="capture-open" onClick={() => setCapturing(true)}>
                      {t('govb1.baseline.capture.button')}
                    </button>
                  ) : null}
                  {captureError === undefined ? null : (
                    <div className="callout gov3-error" role="alert" data-testid="capture-problem">
                      <p>{refusalText(t, describeRefusal(captureError))}</p>
                      {issues.length === 0 ? null : (
                        <ul data-testid="capture-issues">
                          {issues.map((issue) => (
                            <li key={`${issue.componentCode}:${issue.problem}`}>{t('govb1.baseline.issue.line', { code: issue.componentCode, problem: issueText(t, issue.problem) })}</li>
                          ))}
                        </ul>
                      )}
                      <p className="gov3-links">
                        <Link to={`/prj/prj-05?project=${view.projectId}`} data-testid="fix-components">
                          {t('govb1.baseline.fix.components')}
                        </Link>
                        <Link to={`/prj/prj-07?project=${view.projectId}`} data-testid="fix-milestones">
                          {t('govb1.baseline.fix.milestones')}
                        </Link>
                      </p>
                    </div>
                  )}
                </SectionCard>
              ) : (
                <>
                  <SectionCard title={t('govb1.baseline.versions.title')} unit={t('govb1.common.unit')}>
                    <DataTable<BaselineVersion>
                      caption={t('govb1.baseline.versions.title')}
                      rows={view.versions}
                      rowKey={(row) => row.id}
                      state={view.versions.length === 0 ? 'empty' : 'ready'}
                      columns={[
                        { key: 'version', header: t('govb1.baseline.versions.version'), render: (row) => <StatusPill tone={row.kind === 'V0' ? 'info' : 'neutral'}>{row.kind === 'V0' ? t('govb1.baseline.kind.v0') : t('govb1.baseline.kind.revision', { version: row.version })}</StatusPill> },
                        { key: 'total', header: t('govb1.baseline.versions.total'), align: 'right', render: (row) => money(row.totalInvestmentVnd) },
                        { key: 'bac', header: t('govb1.baseline.versions.bac'), align: 'right', render: (row) => money(row.bacVnd) },
                        { key: 'start', header: t('govb1.baseline.versions.start'), render: (row) => dayText(row.plannedStart) },
                        { key: 'finish', header: t('govb1.baseline.versions.finish'), render: (row) => dayText(row.plannedFinish) },
                        { key: 'who', header: t('govb1.baseline.versions.who'), render: (row) => `${row.takenBy.slice(0, 8)} · ${asOfText(row.takenAt)}` },
                        { key: 'source', header: t('govb1.baseline.versions.source'), render: (row) => (row.sourceRevisionId === null ? t('govb1.baseline.versions.noSource') : row.sourceRevisionId.slice(0, 8)) },
                      ]}
                    />
                  </SectionCard>

                  <SectionCard
                    title={t('govb1.baseline.kpi.title')}
                    unit={t('govb1.common.unit')}
                    status={view.reasons.length === 0 ? <StatusPill tone="success">{t('govb1.baseline.within')}</StatusPill> : <StatusPill tone="danger">{t('govb1.baseline.beyond')}</StatusPill>}
                  >
                    {view.deviation === null ? (
                      <p className="callout" data-testid="no-deviation">
                        {t('govb1.baseline.deviation.none')}
                      </p>
                    ) : (
                      <KpiStrip label={t('govb1.baseline.kpi.title')}>
                        <KpiTile
                          label={t('govb1.baseline.kpi.cost')}
                          value={money(view.deviation.costVnd)}
                          tone={deviationTone(view.deviation.costPct, view.policy.costPct)}
                          sub={view.deviation.costPct === null ? t('govb1.baseline.kpi.pct.none') : t('govb1.baseline.kpi.pct', { pct: view.deviation.costPct })}
                        />
                        <KpiTile
                          label={t('govb1.baseline.kpi.bac')}
                          value={money(view.deviation.bacVnd)}
                          tone={deviationTone(view.deviation.bacPct, view.policy.costPct)}
                          sub={view.deviation.bacPct === null ? t('govb1.baseline.kpi.pct.none') : t('govb1.baseline.kpi.pct', { pct: view.deviation.bacPct })}
                        />
                        <KpiTile
                          label={t('govb1.baseline.kpi.slip')}
                          value={view.deviation.finishSlipDays === null ? t('govb1.common.na') : t('govb1.baseline.days', { count: view.deviation.finishSlipDays })}
                          tone={deviationTone(view.deviation.finishSlipDays, view.policy.slipDays)}
                          sub={view.deviation.finishSlipDays === null ? t('govb1.baseline.kpi.slip.none') : undefined}
                        />
                        <KpiTile label={t('govb1.baseline.kpi.forecast')} value={view.deviation.forecastFinish === null ? t('govb1.common.na') : dayText(view.deviation.forecastFinish)} sub={t('govb1.baseline.kpi.forecast.sub', { current: money(view.current.totalInvestmentVnd) })} />
                      </KpiStrip>
                    )}
                    {view.reasons.length === 0 ? null : (
                      <p data-testid="reasons">
                        {view.reasons.map((reason) => (
                          <StatusPill key={reason} tone="danger">
                            {reason === 'COST' ? t('govb1.baseline.reason.cost') : t('govb1.baseline.reason.slip')}
                          </StatusPill>
                        ))}
                      </p>
                    )}
                    <p className="muted" data-testid="policy">
                      {view.policy.costPct === null || view.policy.slipDays === null || view.policy.rescheduleAlertCount === null
                        ? t('govb1.baseline.policy.unknown')
                        : t('govb1.baseline.policy', { cost: view.policy.costPct, days: view.policy.slipDays, moves: view.policy.rescheduleAlertCount, version: view.policy.version })}{' '}
                      <StatusPill tone={view.policy.source === 'BUILT_IN' ? 'warning' : 'success'}>{policySource(t, view.policy)}</StatusPill>
                    </p>
                  </SectionCard>

                  <SectionCard title={t('govb1.baseline.milestones.title')} unit={t('govb1.common.days')}>
                    <DataTable
                      caption={t('govb1.baseline.milestones.title')}
                      rows={view.deviation?.milestones ?? []}
                      rowKey={(row) => row.code}
                      state={(view.deviation?.milestones.length ?? 0) === 0 ? 'empty' : 'ready'}
                      columns={[
                        { key: 'code', header: t('govb1.baseline.milestones.code'), render: (row) => row.code },
                        { key: 'baseline', header: t('govb1.baseline.milestones.baseline'), render: (row) => dayText(row.baselineDate) },
                        { key: 'planned', header: t('govb1.baseline.milestones.planned'), render: (row) => dayText(row.plannedDate) },
                        { key: 'slip', header: t('govb1.baseline.milestones.slip'), align: 'right', render: (row) => (row.slipDays === null ? t('govb1.common.na') : String(row.slipDays)) },
                        {
                          key: 'moves',
                          header: t('govb1.baseline.milestones.moves'),
                          align: 'right',
                          render: (row) => (
                            <span>
                              {row.moves}{' '}
                              {view.policy.rescheduleAlertCount !== null && row.moves >= view.policy.rescheduleAlertCount ? <StatusPill tone="warning">{t('govb1.baseline.milestones.alerted')}</StatusPill> : null}
                            </span>
                          ),
                        },
                      ]}
                    />
                  </SectionCard>

                  <SectionCard title={t('govb1.baseline.events.title')}>
                    <p className="muted" data-testid="reschedule-count">
                      {t('govb1.baseline.events.count', { count: view.reschedule.count, project: view.reschedule.projectMoves })}
                    </p>
                    <DataTable
                      caption={t('govb1.baseline.events.title')}
                      rows={view.reschedule.events}
                      rowKey={(row) => row.id}
                      state={view.reschedule.events.length === 0 ? 'empty' : 'ready'}
                      columns={[
                        { key: 'at', header: t('govb1.baseline.events.at'), render: (row) => asOfText(row.recordedAt) },
                        { key: 'source', header: t('govb1.baseline.events.source'), render: (row) => (row.source === 'REVISION' ? t('govb1.baseline.events.source.revision') : t('govb1.baseline.events.source.milestone')) },
                        { key: 'milestone', header: t('govb1.baseline.events.milestone'), render: (row) => row.milestoneCode ?? t('govb1.baseline.events.project') },
                        { key: 'from', header: t('govb1.baseline.events.from'), render: (row) => dayText(row.fromDate) },
                        { key: 'to', header: t('govb1.baseline.events.to'), render: (row) => dayText(row.toDate) },
                        { key: 'reason', header: t('govb1.baseline.events.reason'), render: (row) => row.reason },
                      ]}
                    />
                  </SectionCard>

                  <SectionCard title={t('govb1.reapp.title')}>
                    <DataTable<Reappraisal>
                      caption={t('govb1.reapp.title')}
                      rows={view.reappraisals}
                      rowKey={(row) => row.id}
                      state={view.reappraisals.length === 0 ? 'empty' : 'ready'}
                      columns={[
                        { key: 'status', header: t('govb1.reapp.status'), render: (row) => <StatusPill tone={reappraisalStatus(t, row).tone}>{reappraisalStatus(t, row).text}</StatusPill> },
                        { key: 'reasons', header: t('govb1.reapp.reasons'), render: (row) => row.reasons.map((reason) => (reason === 'COST' ? t('govb1.baseline.reason.cost') : t('govb1.baseline.reason.slip'))).join(', ') },
                        { key: 'cost', header: t('govb1.reapp.cost'), align: 'right', render: (row) => (row.costPct === null ? t('govb1.common.na') : t('govb1.reapp.cost.value', { pct: row.costPct, limit: row.thresholdCostPct })) },
                        { key: 'slip', header: t('govb1.reapp.slip'), align: 'right', render: (row) => (row.finishSlipDays === null ? t('govb1.common.na') : t('govb1.reapp.slip.value', { days: row.finishSlipDays, limit: row.thresholdSlipDays ?? 0 })) },
                        { key: 'asked', header: t('govb1.reapp.asked'), render: (row) => `${asOfText(row.requestedAt)} · ${t('govb1.reapp.rule', { version: row.ruleVersion })}` },
                        { key: 'decided', header: t('govb1.reapp.decided'), render: (row) => (row.decidedAt === null ? '' : `${asOfText(row.decidedAt)} · ${row.decisionReason ?? ''}`) },
                        {
                          key: 'actions',
                          header: t('govb1.reapp.actions'),
                          render: (row) =>
                            writable && view.actions.decideReappraisal && row.status === 'OPEN' ? (
                              <span className="gov3-actions">
                                <button type="button" data-action="start" onClick={() => setDecision({ request: row, kind: 'START' })}>
                                  {t('govb1.reapp.start')}
                                </button>
                                <button type="button" data-action="waive" onClick={() => setDecision({ request: row, kind: 'WAIVE' })}>
                                  {t('govb1.reapp.waive')}
                                </button>
                              </span>
                            ) : null,
                        },
                      ]}
                    />
                  </SectionCard>

                  <SectionCard title={t('govb1.alerts.title')}>
                    <p className="muted">{t('govb1.alerts.audience')}</p>
                    <DataTable<GovernanceAlert>
                      caption={t('govb1.alerts.title')}
                      rows={view.alerts}
                      rowKey={(row) => row.id}
                      state={view.alerts.length === 0 ? 'empty' : 'ready'}
                      columns={[
                        { key: 'status', header: t('govb1.alerts.status'), render: (row) => <StatusPill tone={row.status === 'OPEN' ? 'danger' : 'success'}>{row.status === 'OPEN' ? t('govb1.alerts.status.open') : t('govb1.alerts.status.acknowledged')}</StatusPill> },
                        { key: 'subject', header: t('govb1.alerts.subject'), render: (row) => (row.subjectKind === 'PROJECT' ? t('govb1.alerts.subject.project', { code: row.projectCode }) : t('govb1.alerts.subject.milestone', { code: row.subjectCode ?? '' })) },
                        { key: 'moves', header: t('govb1.alerts.moves'), align: 'right', render: (row) => t('govb1.alerts.moves.value', { count: row.moveCount, threshold: row.threshold }) },
                        { key: 'raised', header: t('govb1.alerts.raised'), render: (row) => `${asOfText(row.raisedAt)} · ${t('govb1.reapp.rule', { version: row.ruleVersion })}` },
                        { key: 'note', header: t('govb1.alerts.note'), render: (row) => (row.acknowledgedAt === null ? '' : `${asOfText(row.acknowledgedAt)} · ${row.acknowledgeNote ?? ''}`) },
                        {
                          key: 'actions',
                          header: t('govb1.alerts.actions'),
                          render: (row) =>
                            writable && view.actions.acknowledgeAlert && row.status === 'OPEN' ? (
                              <button type="button" data-action="acknowledge" onClick={() => setAcknowledging(row)}>
                                {t('govb1.alerts.acknowledge')}
                              </button>
                            ) : null,
                        },
                      ]}
                    />
                  </SectionCard>
                </>
              )}

              <ConfirmDialog
                open={capturing}
                title={t('govb1.baseline.capture.title')}
                context={[
                  { label: t('govb1.ctx.project'), value: view.projectCode },
                  { label: t('govb1.baseline.capture.total'), value: money(view.current.totalInvestmentVnd) },
                  { label: t('govb1.baseline.capture.effect'), value: t('govb1.baseline.capture.effect.text') },
                ]}
                confirmLabel={t('govb1.baseline.capture.confirm')}
                cancelLabel={t('govb1.common.cancel')}
                pending={capture.isPending}
                onCancel={() => setCapturing(false)}
                onConfirm={() => {
                  capture.mutate(
                    { projectId: view.projectId },
                    {
                      onSuccess: () => {
                        setCapturing(false);
                        setCaptureError(undefined);
                        setMessage({ tone: 'ok', text: t('govb1.baseline.capture.done') });
                      },
                      onError: (error) => {
                        setCapturing(false);
                        setCaptureError(error);
                        setMessage({ tone: 'error', text: refusalText(t, describeRefusal(error)) });
                      },
                    },
                  );
                }}
              />
              <ConfirmDialog
                open={decision !== undefined}
                title={decision?.kind === 'START' ? t('govb1.reapp.start.title') : t('govb1.reapp.waive.title')}
                context={decision === undefined ? [] : [{ label: t('govb1.reapp.reasons'), value: decision.request.reasons.map((reason) => (reason === 'COST' ? t('govb1.baseline.reason.cost') : t('govb1.baseline.reason.slip'))).join(', ') }, { label: t('govb1.reapp.asked'), value: asOfText(decision.request.requestedAt) }]}
                confirmLabel={decision?.kind === 'START' ? t('govb1.reapp.start') : t('govb1.reapp.waive')}
                cancelLabel={t('govb1.common.cancel')}
                pending={decide.isPending}
                reason={{ label: t('govb1.reapp.why'), required: true }}
                onCancel={() => setDecision(undefined)}
                onConfirm={(reason) => {
                  if (decision === undefined || reason === undefined || reason.trim() === '') return;
                  decide.mutate(
                    { id: decision.request.id, version: decision.request.version, body: { decision: decision.kind, reason: reason.trim() } },
                    {
                      onSuccess: () => {
                        setDecision(undefined);
                        setMessage({ tone: 'ok', text: t('govb1.reapp.done') });
                      },
                      onError: (error) => {
                        setDecision(undefined);
                        setMessage({ tone: 'error', text: refusalText(t, describeRefusal(error)) });
                      },
                    },
                  );
                }}
              />
              <ConfirmDialog
                open={acknowledging !== undefined}
                title={t('govb1.alerts.acknowledge.title')}
                context={acknowledging === undefined ? [] : [{ label: t('govb1.alerts.subject'), value: acknowledging.subjectKind === 'PROJECT' ? t('govb1.alerts.subject.project', { code: acknowledging.projectCode }) : t('govb1.alerts.subject.milestone', { code: acknowledging.subjectCode ?? '' }) }, { label: t('govb1.alerts.moves'), value: t('govb1.alerts.moves.value', { count: acknowledging.moveCount, threshold: acknowledging.threshold }) }]}
                confirmLabel={t('govb1.alerts.acknowledge')}
                cancelLabel={t('govb1.common.cancel')}
                pending={acknowledge.isPending}
                reason={{ label: t('govb1.alerts.acknowledge.note'), required: true }}
                onCancel={() => setAcknowledging(undefined)}
                onConfirm={(note) => {
                  if (acknowledging === undefined || note === undefined || note.trim() === '') return;
                  acknowledge.mutate(
                    { id: acknowledging.id, version: acknowledging.version, body: { note: note.trim() } },
                    {
                      onSuccess: () => {
                        setAcknowledging(undefined);
                        setMessage({ tone: 'ok', text: t('govb1.alerts.acknowledge.done') });
                      },
                      onError: (error) => {
                        setAcknowledging(undefined);
                        setMessage({ tone: 'error', text: refusalText(t, describeRefusal(error)) });
                      },
                    },
                  );
                }}
              />
            </>
          )}
        </StateBoundary>
      )}
      <p className="prototype-note">{t('govb1.baseline.footer', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
