import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { CancelPanel } from './CancelPanel';
import { useCancelRun, useMoment, useRun } from './hooks';
import { classificationLabel, failureMessage, routeLabel, runStatusLabel, runTone, stepLabel, stepStateLabel } from './labels';
import { RUN_READ_PERMISSION, canCancel, configPath, failureKind, formatVnd, hasFindings, holds, isCancellable, progressPath, readFailure, workbenchPath } from './model';
import type { Run } from './model';
import '../bid.css';

/** The steps of a run in the order they ran: what was done, where it failed and what never ran. */
function Timeline({ run }: { run: Run }) {
  const { t } = useTranslation();
  return (
    <ol className="bid-milestones" aria-label={t('bid.analysis.timeline.aria')} data-testid="timeline">
      {run.timeline.map((entry) => (
        <li key={entry.step} data-step={entry.step} data-state={entry.state}>
          <strong>{stepLabel(t, entry.step)}</strong>
          <span className={`bid-badge ${entry.state === 'FAILED' ? 'danger' : entry.state === 'DONE' ? 'ok' : 'warning'}`}>{stepStateLabel(t, entry.state)}</span>
        </li>
      ))}
    </ol>
  );
}

/**
 * BID-08: how a run went (ST-BID-009). The steps it took, where it failed and why, the class of its data and the route it went over under the policy in force, what it cost, and what it found. A run that waits
 * for the experts and has no finding reviewed can be cancelled with a reason; the run itself is never rewritten.
 */
export default function ProgressScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The run belongs to one membership: a switch of tenant or of membership starts the screen over.
  return <ProgressContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function ProgressContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { permissions, mode } = useSession();
  const moment = useMoment();
  const [search] = useSearchParams();
  const runId = search.get('run') ?? '';
  const allowed = holds(permissions, RUN_READ_PERMISSION);
  const read = useRun(runId, allowed);
  const cancel = useCancelRun();
  const failure = readFailure(read.error);
  const state = useScreenState({ isLoading: read.isLoading, error: failure === undefined ? read.error : undefined, data: read.data });
  const run = read.data;
  const kind = run === undefined ? undefined : failureKind(run.failureCode);

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('bid.analysis.progress.title')}</h1>
          <p>{t('bid.analysis.progress.subtitle')}</p>
        </div>
      </div>
      <StateBoundary state={allowed ? state : 'denied'} onRetry={() => void read.refetch()}>
        {runId === '' ? (
          <p className="callout" role="status" data-testid="no-run">
            {t('bid.analysis.run.none')}
          </p>
        ) : failure !== undefined ? (
          <p className="callout warning" role="alert" data-testid={failure === 'notFound' ? 'run-not-found' : 'run-undeclared'}>
            {failure === 'notFound' ? t('bid.analysis.run.notFound') : t('bid.analysis.run.undeclared')}
          </p>
        ) : run === undefined ? null : (
          <>
            <div className="card" data-run={run.id} data-status={run.status}>
              <header className="heading">
                <h2>{t('bid.analysis.progress.heading', { package: run.packageCode, contractor: run.contractorName })}</h2>
                <span className={`bid-badge ${runTone(run.status)}`} data-testid="run-status">
                  {runStatusLabel(t, run.status)}
                </span>
              </header>
              <Timeline run={run} />
              {kind === undefined ? null : (
                <p className="callout warning" role="alert" data-testid="failure">
                  {failureMessage(t, kind)}
                </p>
              )}
              {run.cancelReason === null ? null : (
                <p data-testid="cancel-reason">
                  <strong>{t('bid.analysis.cancel.reason.label')}</strong> {run.cancelReason}
                </p>
              )}
              <dl className="bid-facts" data-testid="facts">
                <dt>{t('bid.analysis.facts.classification')}</dt>
                <dd>{classificationLabel(t, run.dataClassification)}</dd>
                <dt>{t('bid.analysis.facts.route')}</dt>
                <dd>{routeLabel(t, run.routeClass)}</dd>
                <dt>{t('bid.analysis.facts.policy')}</dt>
                <dd data-testid="policy">{run.policyVersionId ?? t('bid.analysis.facts.baseline')}</dd>
                <dt>{t('bid.analysis.facts.started')}</dt>
                <dd>{moment(run.startedAt)}</dd>
                <dt>{t('bid.analysis.facts.finished')}</dt>
                <dd>{run.finishedAt === null ? t('bid.analysis.facts.notFinished') : moment(run.finishedAt)}</dd>
                <dt>{t('bid.analysis.facts.cost')}</dt>
                <dd data-testid="cost">{run.costVnd === null ? t('bid.analysis.facts.noCost') : t('bid.analysis.facts.vnd', { amount: formatVnd(run.costVnd, locale) })}</dd>
                <dt>{t('bid.analysis.facts.findings')}</dt>
                <dd data-testid="counts">{t('bid.analysis.facts.counts', { count: run.findingCount, missing: run.missingSourceCount, reviewed: run.reviewedCount })}</dd>
              </dl>
              <p>
                {run.supersedesRunId === null ? null : (
                  <>
                    <Link to={progressPath(run.supersedesRunId)} data-testid="supersedes">
                      {t('bid.analysis.link.supersedes')}
                    </Link>
                    {' · '}
                  </>
                )}
                {hasFindings(run) ? (
                  <>
                    <Link to={workbenchPath(run.id)} data-testid="to-workbench">
                      {t('bid.analysis.link.workbench')}
                    </Link>
                    {' · '}
                  </>
                ) : null}
                <Link to={configPath(run.packageId, run.proposalId)}>{t('bid.analysis.link.config')}</Link>
              </p>
            </div>
            {isCancellable(run, canCancel(permissions, mode)) ? (
              <CancelPanel key={run.id} pending={cancel.isPending} refusal={cancel.variables?.run.id === run.id ? cancel.error : undefined} onCancel={(reason) => cancel.mutate({ run, reason })} />
            ) : null}
          </>
        )}
      </StateBoundary>
      <p className="prototype-note">{t('bid.analysis.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
