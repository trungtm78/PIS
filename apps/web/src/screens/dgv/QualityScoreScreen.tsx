import { useState } from 'react';
import type { FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { Field, QualityPill } from './components';
import { NO_FILTER, useCatalog } from './hooks';
import { freshnessLabel } from './labels';
import { useRunChecks, useScorecard } from './quality-hooks';
import {
  actionLabel,
  dimensionLabel,
  durationLabel,
  failureLabel,
  overallLabel,
  qualityProblemMessage,
  resultLabel,
  resultTone,
  ruleErrorLabel,
  runProblemMessage,
  runStatusLabel,
  severityLabel,
  triggerLabel,
} from './quality-labels';
import { QUALITY_RUN_PERMISSION, describeQualityProblem, instantText, validateRunSnapshot } from './quality-model';
import type { DimensionView, RunProblem, RunView, ScoredRuleView, ScorecardView } from './quality-model';
import './dgv-kit.css';
import { StatusPill } from '../../ui';
import { pillTone } from './pill-tone';

const NEVER_EMPTY = (): boolean => false;
const DATASET_PARAM = 'dataset';
/** The definitions of the figures are the working assumption of the design until the capital business owner signs them (D03). */
const UNSIGNED_DEFINITIONS = 'PROPOSED_PENDING_SIGNOFF';

/**
 * DGV-07: profiling and score of one dataset. It shows what the latest finished run measured and nothing it did not: no run is "not assessed"
 * with no score; a dimension no rule measured has no score; a rule that could not be measured is told so; a run that is waiting or failed to
 * be measured is shown beside the result, never in its place. An integrity failure is a hard fail however high the score
 * (ST-DGV-002, BR-DGV-01, BR-DGV-03).
 */
export default function QualityScoreScreen({ route }: ScreenProps) {
  const tenantId = useSession().tenant?.id;
  // The chosen dataset and the open form belong to one tenant: a switch starts the screen over.
  return <ScoreContent key={tenantId ?? 'none'} route={route} />;
}

function ScoreContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const datasetId = params.get(DATASET_PARAM) ?? undefined;
  const catalog = useCatalog(NO_FILTER);
  const card = useScorecard(datasetId);
  const state = useScreenState({ isLoading: card.isLoading, error: card.error, data: card.data, isEmpty: NEVER_EMPTY });
  const datasets = catalog.data ?? [];
  const chosen = datasets.find((item) => item.id === datasetId);

  const choose = (id: string): void => setParams(id === '' ? {} : { [DATASET_PARAM]: id });

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('dgv.score.page.title')}</h1>
          <p>{t('dgv.score.page.subtitle')}</p>
        </div>
      </div>
      <div className="card">
        <Field id="score-dataset" label={t('dgv.score.dataset.label')} error={undefined}>
          <select id="score-dataset" value={datasetId ?? ''} onChange={(event) => choose(event.target.value)}>
            <option value="">{t('dgv.score.dataset.placeholder')}</option>
            {datasets.map((item) => (
              <option key={item.id} value={item.id}>
                {item.title} ({item.datasetCode})
              </option>
            ))}
          </select>
        </Field>
      </div>
      {datasetId === undefined ? (
        <p className="muted" data-testid="choose-dataset">
          {t('dgv.score.choose.text')}
        </p>
      ) : (
        <StateBoundary state={state} onRetry={() => void card.refetch()}>
          {card.data === undefined ? null : <Scorecard card={card.data} contractId={chosen?.workingContractId ?? null} />}
        </StateBoundary>
      )}
      <p className="prototype-note">{t('dgv.score.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function Scorecard({ card, contractId }: { card: ScorecardView; contractId: string | null }) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const mayRun = (permissions === undefined || permissions.includes(QUALITY_RUN_PERMISSION)) && mode !== 'READ_ONLY';
  const latest = card.latestRun;
  const slo = freshnessLabel(t, card.sloSeconds);
  return (
    <>
      <div className="card" data-testid="scorecard" data-badge={card.badge}>
        <div className="dgv-score-head">
          <div>
            <h2>
              {card.title}
              <code className="dgv-code">{card.datasetCode}</code>
            </h2>
            <QualityPill badge={card.badge} />
            {card.hardFail === true ? <StatusPill tone="danger">{t('dgv.score.hardFail.pill')}</StatusPill> : null}
          </div>
          <div className="dgv-score" data-testid="score">
            <span className="sub">{t('dgv.score.score.label')}</span>
            <strong>{card.score ?? t('dgv.score.score.none')}</strong>
          </div>
        </div>
        {card.assessed ? null : (
          <p className="callout" role="status" data-testid="not-assessed">
            {t('dgv.score.notAssessed.text')}
          </p>
        )}
        {card.hardFail === true ? (
          <p className="callout warning" role="alert" data-testid="hard-fail">
            {t('dgv.score.hardFail.text')}
          </p>
        ) : null}
        {card.certifiedBlocked === true ? (
          <p className="callout warning" role="alert" data-testid="certified-blocked">
            {t('dgv.score.certifiedBlocked.text')}
          </p>
        ) : null}
        {card.badge === 'STALE' && card.ageSeconds !== null ? (
          <p className="callout warning" role="status" data-testid="stale">
            {t('dgv.score.stale.text', { age: durationLabel(t, card.ageSeconds), slo })}
          </p>
        ) : null}
        {card.definitionStatus === UNSIGNED_DEFINITIONS ? (
          <p className="callout" role="status" data-testid="definitions-unsigned">
            {t('dgv.score.definitionsUnsigned.text')}
          </p>
        ) : null}
        <dl className="dgv-facts">
          <div>
            <dt>{t('dgv.score.freshness.label')}</dt>
            <dd>{card.ageSeconds === null ? t('dgv.score.freshness.none', { slo }) : t('dgv.score.freshness.text', { age: durationLabel(t, card.ageSeconds), slo })}</dd>
          </div>
          <div>
            <dt>{t('dgv.score.incidents.label')}</dt>
            <dd data-testid="incidents">{t('dgv.dashboard.incidents.text', { open: card.openIncidents, overdue: card.overdueIncidents })}</dd>
          </div>
          {latest === null ? null : <LatestRunFacts run={latest} />}
          <div>
            <dt>{t('dgv.score.asOf.label')}</dt>
            <dd>{t('dgv.score.instant.text', { value: instantText(card.asOf) })}</dd>
          </div>
        </dl>
      </div>
      {card.pendingAttempt === null ? null : <PendingAttempt run={card.pendingAttempt} />}
      <DimensionTable dimensions={card.dimensions} />
      <RuleTable rules={card.rules} />
      {mayRun ? <RunChecks contractId={contractId} /> : null}
    </>
  );
}

function LatestRunFacts({ run }: { run: RunView }) {
  const { t } = useTranslation();
  return (
    <>
      <div>
        <dt>{t('dgv.score.run.label')}</dt>
        <dd data-testid="latest-run">
          {run.overall === null ? runStatusLabel(t, run.status) : overallLabel(t, run.overall)} · {triggerLabel(t, run.trigger)}
        </dd>
      </div>
      <div>
        <dt>{t('dgv.score.snapshot.label')}</dt>
        <dd>
          <code data-testid="snapshot-id">{run.snapshotId}</code>
          {run.snapshotAsOf === null ? null : <span className="sub">{t('dgv.score.snapshot.asOf', { value: instantText(run.snapshotAsOf) })}</span>}
        </dd>
      </div>
      <div>
        <dt>{t('dgv.score.finished.label')}</dt>
        <dd>{run.finishedAt === null ? t('dgv.score.finished.none') : t('dgv.score.instant.text', { value: instantText(run.finishedAt) })}</dd>
      </div>
    </>
  );
}

/** A run after the latest result that has no result of its own: still waiting, or one that could not be measured and why. */
function PendingAttempt({ run }: { run: RunView }) {
  const { t } = useTranslation();
  return run.status === 'RUNNING' ? (
    <p className="callout" role="status" data-testid="pending-attempt">
      {t('dgv.score.pending.running.text', { value: instantText(run.startedAt) })}
    </p>
  ) : (
    <p className="callout warning" role="alert" data-testid="pending-attempt">
      {t('dgv.score.pending.failed.text', { reason: failureLabel(t, run.failureCode) })}
    </p>
  );
}

function DimensionTable({ dimensions }: { dimensions: DimensionView[] }) {
  const { t } = useTranslation();
  return (
    <div className="card">
      <h2>{t('dgv.score.dimensions.title')}</h2>
      <table className="table" aria-label={t('dgv.score.dimensions.aria')}>
        <thead>
          <tr>
            <th>{t('dgv.score.dimension.column')}</th>
            <th>{t('dgv.score.dimensionScore.column')}</th>
            <th>{t('dgv.score.dimensionRules.column')}</th>
          </tr>
        </thead>
        <tbody>
          {dimensions.map((dimension) => (
            <tr key={dimension.dimension} data-dimension={dimension.dimension} data-assessed={dimension.assessed}>
              <td>{dimensionLabel(t, dimension.dimension)}</td>
              <td data-testid="dimension-score">{dimension.assessed && dimension.score !== null ? dimension.score : t('dgv.score.dimension.notAssessed')}</td>
              <td>{t('dgv.score.dimensionRules.text', { total: dimension.rulesTotal, failed: dimension.rulesFailed })}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RuleTable({ rules }: { rules: ScoredRuleView[] }) {
  const { t } = useTranslation();
  return (
    <div className="card">
      <h2>{t('dgv.score.rules.title')}</h2>
      {rules.length === 0 ? (
        <p className="muted" data-testid="no-results">
          {t('dgv.score.rules.empty')}
        </p>
      ) : (
        <table className="table" aria-label={t('dgv.score.rules.aria')}>
          <thead>
            <tr>
              <th>{t('dgv.score.rule.column')}</th>
              <th>{t('dgv.score.ruleDimension.column')}</th>
              <th>{t('dgv.score.ruleMeasured.column')}</th>
              <th>{t('dgv.score.ruleThreshold.column')}</th>
              <th>{t('dgv.score.ruleCounts.column')}</th>
              <th>{t('dgv.score.ruleAction.column')}</th>
              <th>{t('dgv.score.ruleResult.column')}</th>
            </tr>
          </thead>
          <tbody>
            {rules.map((rule) => (
              <tr key={rule.ruleVersionId} data-rule-code={rule.code} data-result={rule.result}>
                <td>
                  {rule.code}
                  <span className="sub">{t('dgv.score.rule.revision', { revision: rule.revision })}</span>
                </td>
                <td>{dimensionLabel(t, rule.dimension)}</td>
                <td>{rule.measuredValue === null ? t('dgv.score.rule.notMeasured') : t('dgv.score.rule.percent', { value: rule.measuredValue })}</td>
                <td>{rule.minPassRate === null ? '' : t('dgv.score.rule.percent', { value: rule.minPassRate })}</td>
                <td>{t('dgv.score.rule.counts', { evaluated: rule.evaluated, failed: rule.failed, quarantined: rule.quarantined })}</td>
                <td>
                  {actionLabel(t, rule.action)}
                  <span className="sub">{severityLabel(t, rule.severity)}</span>
                </td>
                <td>
                  <StatusPill tone={pillTone(resultTone(rule.result))}>{resultLabel(t, rule.result)}</StatusPill>
                  {rule.result === 'ERROR' ? <span className="sub">{ruleErrorLabel(t, rule.errorCode)}</span> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** Runs the approved rules of the working contract on a frozen snapshot; the run is executed by the quality job, so the screen only says that it was requested. */
function RunChecks({ contractId }: { contractId: string | null }) {
  const { t } = useTranslation();
  const run = useRunChecks();
  const [snapshotId, setSnapshotId] = useState('');
  const [problem, setProblem] = useState<RunProblem | undefined>(undefined);
  const [requested, setRequested] = useState(false);
  const refused = run.isError ? describeQualityProblem(run.error) : undefined;

  const send = (event: FormEvent): void => {
    event.preventDefault();
    if (run.isPending || contractId === null) return;
    const found = validateRunSnapshot(snapshotId);
    setProblem(found);
    if (found !== undefined) return;
    run.mutate(
      { contractId, snapshotId: snapshotId.trim().toLowerCase() },
      {
        onSuccess: () => {
          setSnapshotId('');
          setRequested(true);
        },
      },
    );
  };

  return (
    <form className="card" onSubmit={send} noValidate aria-label={t('dgv.score.run.title')}>
      <h2>{t('dgv.score.run.title')}</h2>
      {contractId === null ? (
        <p className="callout" role="status" data-testid="no-contract">
          {t('dgv.score.run.noContract.text')}
        </p>
      ) : null}
      {refused === undefined ? null : (
        <p className="callout warning" role="alert">
          {qualityProblemMessage(t, refused)}
        </p>
      )}
      {requested ? (
        <p className="callout" role="status" data-testid="run-requested">
          {t('dgv.score.run.requested.notice')}
        </p>
      ) : null}
      <Field id="run-snapshot" label={t('dgv.score.run.snapshot.label')} error={problem === undefined ? undefined : runProblemMessage(t, problem)} hint={t('dgv.score.run.snapshot.hint')}>
        <input
          id="run-snapshot"
          value={snapshotId}
          aria-invalid={problem !== undefined}
          onChange={(event) => {
            setSnapshotId(event.target.value);
            setProblem(undefined);
            setRequested(false);
          }}
        />
      </Field>
      <div className="formfooter">
        <button type="submit" className="ui-button ui-button--primary" disabled={run.isPending || contractId === null}>
          {t('dgv.score.run.start.action')}
        </button>
      </div>
    </form>
  );
}
