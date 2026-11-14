import { useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import { DataTable, StatusPill } from '../../../ui';
import type { DataTableColumn } from '../../../ui';
import { gradeLook, gradeName, versionText } from '../codes';
import { FigureInfo } from '../components';
import { roleWord } from '../labels';
import { dayText, stampText } from '../model';
import { kpiFormula, kpiStateWord } from '../task/labels';
import { kpiInputs } from '../task/model';
import { useTaskKpiResults } from './hooks';
import { adjustmentStatusWord, excludedReasonWord, flagHint, flagWord, lineStateHint, lineStateWord, periodStatusHint, periodStatusWord, responseStatusWord, scoreProblemText } from './labels';
import { hasAdjustedScore, isRated, isRestricted, lineIcon, lineTone, periodIcon, periodTone, scoreTaskLink, scoreText } from './model';
import type { Adjustment, Contribution, Excluded, FlagCode, LineState, ScoreLine, ScorePeriod, ScoreProblem, ScoreResponse } from './model';
import './score.css';

/** Said on every screen that shows a score (BR-PWF-41): the score supports a decision of the person who has the authority, it decides nothing. */
export function SupportNotice() {
  const { t } = useTranslation();
  return (
    <p className="callout pwf-notice" role="note" data-testid="support-notice">
      <span aria-hidden="true">ⓘ </span>
      {t('pwfs.common.support.note')}
    </p>
  );
}

/** The refusal of a command in the words of the module; a refusal that says somebody changed it first offers to read the newer version. */
export function ScoreProblemBanner({ problem, onReload }: { problem: ScoreProblem; onReload?: (() => void) | undefined }) {
  const { t } = useTranslation();
  return (
    <div className="callout danger pwf-problem" role="alert" data-testid="problem" data-kind={problem.kind}>
      <p>{scoreProblemText(t, problem)}</p>
      {onReload !== undefined && problem.kind === 'versionConflict' ? (
        <button type="button" className="ui-button ui-button--outline ui-button--small" data-action="reload" onClick={onReload}>
          {t('pwfs.common.reload.action')}
        </button>
      ) : null}
    </div>
  );
}

export function PeriodStatusPill({ status }: { status: ScorePeriod['status'] }) {
  const { t } = useTranslation();
  return (
    <span title={periodStatusHint(t, status)}>
      <StatusPill tone={periodTone(status)} icon={periodIcon(status)}>
        {periodStatusWord(t, status)}
      </StatusPill>
    </span>
  );
}

export function LineStatePill({ state }: { state: LineState }) {
  const { t } = useTranslation();
  return (
    <StatusPill tone={lineTone(state)} icon={lineIcon(state)}>
      {lineStateWord(t, state)}
    </StatusPill>
  );
}

interface ScoreFigureProps {
  line: Pick<ScoreLine, 'score_computed' | 'score_adjusted' | 'rating' | 'state' | 'rated_task_count' | 'effective_weight'>;
}

/**
 * The score of a person: the computed score and, when an approved adjustment moved it, the adjusted one next to it (both always shown). A person with a small sample or nothing to rate gets the words "not enough data"
 * where the rating would be; the number of a small sample is still shown, never ranked (BR-PWF-36).
 */
export function ScoreFigure({ line }: ScoreFigureProps) {
  const { t } = useTranslation();
  const hint = lineStateHint(t, line.state);
  return (
    <div className="pwfs-figure" data-testid="score-figure" data-state={line.state}>
      <p className="pwfs-figure__main">
        <span className="pwfs-figure__score" data-testid="score-computed" aria-label={t('pwfs.figure.computed.label')}>
          {scoreText(line.score_computed)}
        </span>
        {hasAdjustedScore(line) ? (
          <>
            <span aria-hidden="true"> → </span>
            <span className="pwfs-figure__score pwfs-figure__score--adjusted" data-testid="score-adjusted" aria-label={t('pwfs.figure.adjusted.label')}>
              {scoreText(line.score_adjusted)}
            </span>
          </>
        ) : null}
      </p>
      <p className="pwfs-figure__rating">
        {isRated(line) && line.rating !== null ? (
          <RatingPill rating={line.rating} testId="rating" />
        ) : (
          <LineStatePill state={line.state} />
        )}
      </p>
      {hint === undefined ? null : (
        <p className="adm-kit-sub" data-testid="state-hint">
          {hint}
        </p>
      )}
      <p className="adm-kit-sub" data-testid="sample">
        {t('pwfs.figure.sample.text', { count: line.rated_task_count, weight: line.effective_weight })}
      </p>
    </div>
  );
}

/** The "i" of a score: how it is computed, from which policy, the day, the version and the hash of the snapshot it was taken from. */
export function ScoreInfo({ basis, asOf }: { basis: ScoreLine['basis']; asOf: string }) {
  const { t } = useTranslation();
  return (
    <FigureInfo
      name={t('pwfs.info.name.text')}
      formula={t('pwfs.info.formula.text')}
      source={t('pwfs.info.source.text', { policy: basis.policy_code, hash: basis.snapshot_hash === null ? t('pwfs.info.noHash.text') : basis.snapshot_hash.slice(0, 12) })}
      asOf={asOf}
      version={t('pwf6.score.policy.text', { version: versionText(t, basis.policy_version) })}
    />
  );
}

const percentText = (fraction: number): string => `${Math.round(fraction * 10_000) / 100}%`;

/** The results of the KPIs of one task of a line, each with the formula, the value, the score and the facts it was computed from; read when the person opens them. */
function TaskFacts({ taskId }: { taskId: string }) {
  const { t } = useTranslation();
  const results = useTaskKpiResults(taskId, true);
  if (results.isLoading) return <p role="status">{t('pwfs.facts.loading.text')}</p>;
  if (results.error !== null && results.error !== undefined) return <p role="alert">{t('pwfs.facts.error.text')}</p>;
  const items = results.data?.items ?? [];
  if (items.length === 0) return <p className="adm-kit-sub">{t('pwfs.facts.none.text')}</p>;
  return (
    <ul className="pwfs-facts" data-testid={`facts-${taskId}`}>
      {items.map((item) => (
        <li key={item.id}>
          <span className="pwf-figure">
            <strong>{item.kpi_code}</strong>: {item.value === null ? '–' : item.value} → {item.score === null ? '–' : item.score} ({kpiStateWord(t, item.state)}, {t('pwfs.facts.weight.text', { weight: item.weight })})
            <FigureInfo name={item.kpi_code} formula={kpiFormula(t, item.operation)} source={t('pwf.task.kpi.source.text', { hash: item.inputs_hash.slice(0, 12) })} asOf={item.computed_at} version={t('pwf.task.kpi.version.text', { version: item.kpi_set_version })} />
          </span>
          <dl className="pwf-facts">
            {kpiInputs(item.inputs).map(([name, value]) => (
              <div key={name} className="pwf-input">
                <dt>{name}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        </li>
      ))}
    </ul>
  );
}

function TaskCell({ contribution }: { contribution: Contribution }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  if (isRestricted(contribution)) {
    return (
      <span data-testid="restricted" className="pwfs-restricted">
        <span aria-hidden="true">⌁ </span>
        {t('pwfs.contribution.restricted.text')}
      </span>
    );
  }
  const taskId = contribution.task_id as string;
  return (
    <div>
      <Link to={scoreTaskLink(taskId)}>
        {contribution.task_code} · {contribution.name}
      </Link>{' '}
      <button type="button" className="ui-button ui-button--outline ui-button--small" aria-expanded={open} data-action={`facts-${contribution.task_code}`} onClick={() => setOpen(!open)}>
        {open ? t('pwfs.contribution.hideFacts.action') : t('pwfs.contribution.showFacts.action')}
      </button>
      {open ? <TaskFacts taskId={taskId} /> : null}
    </div>
  );
}

/** Every point of a score traced to a task: the part of the person in it (the days of the assignments inside the period, the share and the factor of the role), its weight and its score. */
/** A grade in words with a tone and a glyph of its own: the weakest grade is never green and never ticked. The code of the grade stays on the element for whoever needs it. */
export function RatingPill({ rating, testId }: { rating: string; testId?: string }) {
  const { t } = useTranslation();
  const look = gradeLook(rating);
  return (
    <StatusPill tone={look.tone} icon={look.icon}>
      <span data-testid={testId} data-rating={rating}>
        {gradeName(t, rating)}
      </span>
    </StatusPill>
  );
}

/** "Scoring policy: system default" or "version N"; the code of a policy that is not the default one is a note. */
export function PolicyBasis({ code, version }: { code: string; version: number }) {
  const { t } = useTranslation();
  return (
    <span data-testid="policy-basis">
      {t('pwf6.score.policy.text', { version: versionText(t, version) })}
      {code === 'DEFAULT' ? null : <span className="pwf-code"> {code}</span>}
    </span>
  );
}

export function ContributionsTable({ contributions }: { contributions: readonly Contribution[] }) {
  const { t } = useTranslation();
  const columns: DataTableColumn<Contribution>[] = [
    { key: 'task', header: t('pwfs.contribution.col.task'), render: (row) => <TaskCell contribution={row} /> },
    {
      key: 'spans',
      header: t('pwfs.contribution.col.spans'),
      render: (row) => (
        <ul className="pwfs-spans">
          {row.spans.map((span, at) => (
            <li key={at}>{t('pwfs.contribution.span.text', { role: roleWord(t, span.role), from: dayText(span.valid_from), to: span.valid_to === null ? t('pwfs.contribution.open.text') : dayText(span.valid_to), share: span.share_pct })}</li>
          ))}
        </ul>
      ),
    },
    { key: 'fraction', header: t('pwfs.contribution.col.fraction'), align: 'right', render: (row) => percentText(row.fraction) },
    { key: 'weight', header: t('pwfs.contribution.col.weight'), align: 'right', render: (row) => row.weight },
    { key: 'score', header: t('pwfs.contribution.col.score'), align: 'right', render: (row) => scoreText(row.score) },
  ];
  return (
    <div className="pwf-free">
      <DataTable columns={columns} rows={[...contributions]} rowKey={(row) => `${row.task_code}:${row.task_id ?? 'restricted'}`} caption={t('pwfs.contribution.caption.text')} state={contributions.length === 0 ? 'empty' : 'ready'} />
    </div>
  );;
}

/** The tasks left out of the score, each with the reason (a task that does not count is never hidden). */
export function ExcludedList({ excluded }: { excluded: readonly Excluded[] }) {
  const { t } = useTranslation();
  if (excluded.length === 0) return <p className="adm-kit-sub">{t('pwfs.excluded.none.text')}</p>;
  return (
    <ul data-testid="excluded" className="pwfs-excluded">
      {excluded.map((item) => (
        <li key={`${item.task_code}:${item.reason}`}>
          <strong>{item.task_code}</strong> · {excludedReasonWord(t, item.reason)}
        </li>
      ))}
    </ul>
  );
}

export interface AdjustmentListProps {
  adjustments: readonly Adjustment[];
  /** Renders what the viewer may do about one adjustment that is still requested (the decision form); nothing for a viewer who cannot. */
  renderDecision?: ((adjustment: Adjustment) => ReactNode) | undefined;
}

/** Every adjustment of the line: the person scored sees all of them, with the points, the reason and who decided. */
export function AdjustmentList({ adjustments, renderDecision }: AdjustmentListProps) {
  const { t } = useTranslation();
  if (adjustments.length === 0) return <p className="adm-kit-sub">{t('pwfs.adjustment.none.text')}</p>;
  return (
    <ul className="pwfs-list" data-testid="adjustments">
      {adjustments.map((item) => (
        <li key={item.id} data-adjustment={item.id} data-status={item.status}>
          <p>
            <StatusPill tone={item.status === 'APPROVED' ? 'success' : item.status === 'REJECTED' ? 'danger' : 'warning'} icon={item.status === 'APPROVED' ? '✓' : item.status === 'REJECTED' ? '✕' : '◐'}>
              {adjustmentStatusWord(t, item.status)}
            </StatusPill>{' '}
            <strong>{item.points > 0 ? `+${item.points}` : item.points}</strong> {t('pwfs.adjustment.points.text')}
          </p>
          <p>{item.reason}</p>
          {item.evidence_ref === null ? null : <p className="adm-kit-sub">{t('pwfs.adjustment.evidence.text', { ref: item.evidence_ref })}</p>}
          {item.decided_at === null ? null : <p className="adm-kit-sub">{t('pwfs.adjustment.decided.text', { at: stampText(item.decided_at) })}</p>}
          {renderDecision === undefined ? null : renderDecision(item)}
        </li>
      ))}
    </ul>
  );
}

export interface ResponseListProps {
  responses: readonly ScoreResponse[];
  renderHandle?: ((response: ScoreResponse) => ReactNode) | undefined;
}

/** The responses of the person scored and where each one stands (the decision of an open one runs through the approval engine of the tenant). */
export function ResponseList({ responses, renderHandle }: ResponseListProps) {
  const { t } = useTranslation();
  if (responses.length === 0) return <p className="adm-kit-sub">{t('pwfs.response.none.text')}</p>;
  return (
    <ul className="pwfs-list" data-testid="responses">
      {responses.map((item) => (
        <li key={item.id} data-response={item.id} data-status={item.status}>
          <p>
            <StatusPill tone={item.status === 'OPEN' ? 'warning' : 'success'} icon={item.status === 'OPEN' ? '◐' : '✓'}>
              {responseStatusWord(t, item.status)}
            </StatusPill>{' '}
            <span className="adm-kit-sub">{t('pwfs.response.submitted.text', { at: stampText(item.submitted_at) })}</span>
          </p>
          <p>{item.body}</p>
          {item.approval_instance_id === null ? null : <p className="adm-kit-sub">{t('pwfs.response.workflow.text')}</p>}
          {item.conclusion === null ? null : (
            <p data-testid="conclusion">
              <strong>{t('pwfs.response.conclusion.label')}</strong> {item.conclusion}
            </p>
          )}
          {renderHandle === undefined ? null : renderHandle(item)}
        </li>
      ))}
    </ul>
  );
}

/** The flags raised for the reviewers of a period; they never change a score and they are not shown to the person scored. */
export function FlagList({ flags }: { flags: ReadonlyArray<{ code: FlagCode; task_codes?: readonly string[] }> }) {
  const { t } = useTranslation();
  return (
    <ul className="pwfs-flags" data-testid="flags">
      {flags.map((flag) => (
        <li key={flag.code} data-flag={flag.code}>
          <StatusPill tone="warning" icon="⚑">
            {flagWord(t, flag.code)}
          </StatusPill>
          <span className="adm-kit-sub"> {flagHint(t, flag.code)}</span>
          {flag.task_codes === undefined || flag.task_codes.length === 0 ? null : <span className="adm-kit-sub"> · {flag.task_codes.join(', ')}</span>}
        </li>
      ))}
    </ul>
  );
}

/** A card that says the flags change nothing: the note every list of signals carries. */
export function FlagsNote() {
  const { t } = useTranslation();
  return (
    <p className="callout pwf-notice" role="note" data-testid="flags-note">
      {t('pwfs.flag.neverChanges.note')}
    </p>
  );
}

