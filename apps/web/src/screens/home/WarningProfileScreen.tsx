import { ApiError } from '@machvon/api-client';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useEdition } from '../../editions/EditionContext';
import { useTranslation } from '../../i18n';
import type { Translator } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { formatVnd } from '../dis/report/money';
import { Field } from '../mne/components';
import { vietnamToday } from '../mne/model';
import { ContextBar, DataTable, SectionCard, StatusPill } from '../../ui';
import type { DataTableColumn, Tone } from '../../ui';
import '../dis/dis.css';
import './home.css';
import { FORMULA_REFERENCE, shortId } from './model';
import { dayText } from './overview-model';
import { ObservedText, SeverityBadge, explanationStatusLabel, warningStatusLabel } from './WarningsScreen';
import { useAcknowledgeWarning, useAskExplanation, useDismissWarning, useHomeWarning, useHomeWarnings } from './warning-hooks';
import { HANDLE_WARNING_PERMISSION, REQUEST_EXPLANATION_PERMISSION, WARNINGS_PATH, describeWarning, topWarning, trimmed } from './warning-model';
import type { EvidenceCell, HistoryEvent, WarningItem } from './warning-model';

type T = Translator['t'];
const REASON_MIN = 5;
const QUESTION_MIN = 10;
const NONE = '—';
/** The words of each key of a threshold (the rule carries the keys of the engine); a key nobody lists is left out, never shown as it came. */
const THRESHOLD_WORD: Readonly<Record<string, string>> = {
  points: 'home.profile.threshold.points',
  critical_points: 'home.profile.threshold.criticalPoints',
  grace_days: 'home.profile.threshold.graceDays',
  explanation_due_days: 'home.profile.threshold.explanationDueDays',
};

/** A threshold in sentences with their units (days, points), one per key the product lists. */
export function thresholdSentences(t: T, threshold: Readonly<Record<string, unknown>>): string[] {
  return Object.entries(threshold).flatMap(([key, value]) => {
    const word = THRESHOLD_WORD[key];
    return word === undefined || (typeof value !== 'string' && typeof value !== 'number') ? [] : [t(word, { value: String(value) })];
  });
}

const STATUS_TONE: Readonly<Record<string, Tone>> = { OPEN: 'warning', ACKNOWLEDGED: 'info', EXPLANATION_REQUESTED: 'info', RESOLVED: 'success', DISMISSED: 'neutral' };

function historyLabel(t: T, event: HistoryEvent): string {
  switch (event) {
    case 'OPENED':
      return t('home.profile.history.opened');
    case 'ACKNOWLEDGED':
      return t('home.profile.history.acknowledged');
    case 'EXPLANATION_REQUESTED':
      return t('home.profile.history.explanationRequested');
    case 'EXPLANATION_RESPONDED':
      return t('home.profile.history.explanationResponded');
    case 'RESOLVED':
      return t('home.profile.history.resolved');
    case 'DISMISSED':
      return t('home.profile.history.dismissed');
  }
}

type Action = 'explain' | 'acknowledge' | 'dismiss';

/** What a command of another module answered, in words: a warning that moved (409), a right that is not held (403), a request that is not good (422). */
function problemKey(error: unknown): 'conflict' | 'state' | 'denied' | 'validation' | 'general' {
  if (!(error instanceof ApiError)) return 'general';
  if (error.code === 'VERSION_CONFLICT') return 'conflict';
  if (error.code === 'WARNING_STATE_INVALID' || error.code === 'EXPLANATION_ALREADY_OPEN') return 'state';
  if (error.status === 403) return 'denied';
  if (error.status === 422) return 'validation';
  return 'general';
}

/** The day, with the end of it, that a request is due on: the date input gives a day, the server wants a moment. */
const dueMoment = (day: string): string => `${day}T16:59:59.000Z`;

/**
 * HOME-06: the profile of an early warning (ST-HOME-003, HOME 3 F4): the cause (the rule, its threshold and what was observed), the evidence (the cells of the project in the snapshot the warning was opened on), the
 * leader in charge now, the explanation that was asked for, and the history. The three actions are the commands of PRJ (ask for an explanation of the leader) and DIS (acknowledge, dismiss), sent under the right the reader
 * holds for each: a button for an action the reader may not take is not there.
 */
export default function WarningProfileScreen({ route }: ScreenProps) {
  const tenant = useSession().tenant;
  const [params] = useSearchParams();
  const named = params.get('warning') ?? '';
  // Opened without a warning in the address (a typed address, the menu), the top alert of the list is shown; the list stays one link away.
  const list = useHomeWarnings({ severity: '', ruleCode: '' }, named === '');
  const top = named === '' ? topWarning(list.data?.pages.flatMap((page) => page.items) ?? []) : undefined;
  const id = named !== '' ? named : (top?.id ?? '');
  // What is open belongs to one member of one tenant and to the warning that is shown: a switch of either starts the screen over.
  return <ProfileContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}:${id}`} route={route} id={id} chosen={named !== ''} loading={named === '' && list.isLoading} />;
}

function ProfileContent({ route, id, chosen, loading }: ScreenProps & { id: string; chosen: boolean; loading: boolean }) {
  const { t } = useTranslation();
  const query = useHomeWarning(id);
  const problem = query.error === null ? undefined : describeWarning(query.error);
  const state = useScreenState({ isLoading: query.isLoading, error: problem === 'notFound' ? undefined : query.error, data: problem === 'notFound' ? undefined : query.data });
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('home.profile.page.title')}</h1>
          <p>{t('home.profile.page.subtitle')}</p>
        </div>
        <div className="actions">
          <Link className="ui-button ui-button--outline" to={WARNINGS_PATH}>
            {t('home.profile.back')}
          </Link>
        </div>
      </div>
      {id === '' && loading ? <StateBoundary state="loading" /> : null}
      {id !== '' && !chosen ? (
        <p className="callout" role="status" data-testid="profile-default">
          {t('home.profile.default')}
        </p>
      ) : null}
      {id === '' && !loading ? (
        <div className="card statecard" role="alert" data-testid="profile-no-id">
          <p>{t('home.profile.noId')}</p>
        </div>
      ) : null}
      {problem === 'notFound' ? (
        <div className="card statecard" role="alert" data-testid="profile-not-found">
          <p>{t('home.profile.notFound')}</p>
        </div>
      ) : null}
      {id === '' ? null : (
        <StateBoundary state={state} onRetry={() => void query.refetch()}>
          {query.data === undefined || problem === 'notFound' ? null : <ProfileBody key={query.data.id} warning={query.data} />}
        </StateBoundary>
      )}
    </section>
  );
}

/** The words of the capital bucket of an evidence cell (the cell carries the code of the snapshot); a code nobody lists is shown as it came. */
const BUCKET_WORD: Readonly<Record<string, string>> = { CURRENT_YEAR: 'cap.bucket.currentYear.label', CARRYOVER: 'cap.bucket.carryover.label', EQUITY: 'cap.bucket.equity.label', LOAN: 'cap.bucket.loan.label', OTHER: 'cap.bucket.other.label' };

/**
 * The evidence cells an edition that has no local plan and no levels of budget shows: a cell of the local level that holds no figure at all is the empty half of a pair of the public product and is left out, and the
 * level is not part of the name of a cell. The public edition shows every cell as it came.
 */
export function evidenceRowsFor(cells: readonly EvidenceCell[], ownPlan: boolean): EvidenceCell[] {
  return ownPlan ? cells.filter((cell) => cell.budgetLevel !== 'LOCAL' || cell.planPmVnd !== '0' || cell.planLocalVnd !== '0' || cell.disbursedVnd !== null) : [...cells];
}

function ProfileBody({ warning }: { warning: WarningItem }) {
  const { t } = useTranslation();
  // An edition with its own frozen snapshot (the enterprise) has one plan, no local plan added and no level of budget: its columns say so in its words, with no codes of the public pack.
  const ownPlan = useEdition().slots?.homeFigures?.publicPlanBlocks === false;
  const { permissions, mode } = useSession();
  const frozen = mode === 'READ_ONLY';
  const holds = (permission: string): boolean => permissions === undefined || permissions.includes(permission);
  const [action, setAction] = useState<Action | undefined>(undefined);
  const [reason, setReason] = useState('');
  const [question, setQuestion] = useState('');
  const [due, setDue] = useState('');
  const [done, setDone] = useState<Action | undefined>(undefined);
  const acknowledge = useAcknowledgeWarning();
  const dismiss = useDismissWarning();
  const ask = useAskExplanation();
  const busy = acknowledge.isPending || dismiss.isPending || ask.isPending;
  const failure = action === 'acknowledge' ? acknowledge.error : action === 'dismiss' ? dismiss.error : action === 'explain' ? ask.error : null;
  const open = warning.status === 'OPEN';
  const canExplain = !frozen && holds(REQUEST_EXPLANATION_PERMISSION) && warning.project !== null && warning.leader !== null && (warning.status === 'OPEN' || warning.status === 'ACKNOWLEDGED');
  const canAcknowledge = !frozen && holds(HANDLE_WARNING_PERMISSION) && open;
  const canDismiss = !frozen && holds(HANDLE_WARNING_PERMISSION) && (open || warning.status === 'ACKNOWLEDGED');
  const today = vietnamToday();
  const reasonOk = reason.trim().length >= REASON_MIN;
  const askOk = question.trim().length >= QUESTION_MIN && due !== '' && due >= today;
  const close = (): void => {
    setAction(undefined);
    setReason('');
    setQuestion('');
    setDue('');
    acknowledge.reset();
    dismiss.reset();
    ask.reset();
  };
  const submit = (): void => {
    if (action === undefined || busy) return;
    const onSuccess = (): void => {
      setDone(action);
      close();
    };
    if (action === 'explain' && askOk) ask.mutate({ warning, question, dueAt: dueMoment(due) }, { onSuccess });
    if (action === 'acknowledge' && reasonOk) acknowledge.mutate({ warning, reason: reason.trim() }, { onSuccess });
    if (action === 'dismiss' && reasonOk) dismiss.mutate({ warning, reason: reason.trim() }, { onSuccess });
  };
  const sentences = warning.threshold === null ? [] : thresholdSentences(t, warning.threshold);
  const threshold = sentences.length === 0 ? null : sentences.join('; ');
  const gap = typeof warning.observed.gap_points === 'string' ? trimmed(warning.observed.gap_points) : null;

  const evidenceColumns: DataTableColumn<EvidenceCell>[] = [
    { key: 'cell', header: t('home.profile.evidence.cell'), pinned: true, render: (cell) => (ownPlan ? t(BUCKET_WORD[cell.bucket] ?? 'cap.bucket.other.label') : `${cell.bucket} · ${cell.budgetLevel}`) },
    { key: 'planPm', header: t('home.profile.evidence.planPm'), align: 'right', render: (cell) => formatVnd(cell.planPmVnd) },
    ...(ownPlan ? [] : [{ key: 'planLocal', header: t('home.profile.evidence.planLocal'), align: 'right' as const, render: (cell: EvidenceCell) => formatVnd(cell.planLocalVnd) }]),
    { key: 'disbursed', header: t('home.profile.evidence.disbursed'), align: 'right', render: (cell) => (cell.disbursedVnd === null ? t('home.tile.nullReason.noData') : formatVnd(cell.disbursedVnd)) },
    { key: 'ratePm', header: t('home.profile.evidence.ratePm'), align: 'right', render: (cell) => (cell.ratePmPct === null ? t('home.tile.nullReason.noData') : t('home.tile.value.percent', { value: cell.ratePmPct })) },
  ];
  const actionTitle = action === 'explain' ? t('home.profile.action.explain') : action === 'acknowledge' ? t('home.profile.action.acknowledge') : t('home.profile.action.dismiss');

  return (
    <div className="home-stack" data-testid="warning-profile" data-warning-status={warning.status}>
      <ContextBar
        items={[
          { label: t('home.profile.cause.rule'), value: `${warning.ruleCode} ${warning.ruleName}` },
          { label: t('home.profile.cause.project'), value: warning.project === null ? NONE : `${warning.project.code} ${warning.project.name}` },
        ]}
        {...(warning.evidence === null ? {} : { asOf: dayText(warning.evidence.asOfDate) })}
      />
      <div data-testid="profile-cause">
        <SectionCard
          title={t('home.profile.cause.title')}
          status={
            <span className="home-badges">
              <SeverityBadge severity={warning.severity} />
              <span data-testid="profile-status">
                <StatusPill tone={STATUS_TONE[warning.status] ?? 'neutral'}>{warningStatusLabel(t, warning.status)}</StatusPill>
              </span>
            </span>
          }
        >
          <dl className="aud-facts">
            <dt>{t('home.profile.cause.rule')}</dt>
            <dd data-testid="profile-rule">
              {warning.ruleCode} {warning.ruleName}
            </dd>
            <dt>{t('home.profile.cause.project')}</dt>
            <dd data-testid="profile-project">{warning.project === null ? NONE : `${warning.project.code} ${warning.project.name}`}</dd>
            <dt>{t('home.profile.cause.observed')}</dt>
            <dd data-testid="profile-observed">
              <ObservedText item={warning} />
            </dd>
            {gap === null ? null : (
              <>
                <dt>{t('home.profile.cause.gap')}</dt>
                <dd data-testid="profile-gap">{t('home.profile.cause.gap.value', { gap })}</dd>
              </>
            )}
            {threshold === null ? null : (
              <>
                <dt>{t('home.profile.cause.threshold')}</dt>
                <dd data-testid="profile-threshold" title={t('home.profile.cause.threshold.title', { ref: FORMULA_REFERENCE })}>
                  {threshold}
                </dd>
              </>
            )}
          </dl>
        </SectionCard>
      </div>
      <div data-testid="profile-evidence">
        <SectionCard title={t('home.profile.evidence.title')} {...(warning.evidence === null || warning.evidence.cells.length === 0 ? {} : { unit: t('dis.wr.unit') })}>
          {warning.evidence === null || warning.evidence.cells.length === 0 ? (
            <p>{t('home.profile.evidence.none')}</p>
          ) : (
            <>
              <p className="home-note" data-testid="evidence-context">
                {t('home.profile.evidence.context', { id: shortId(warning.evidence.snapshotId), date: dayText(warning.evidence.asOfDate) })}
              </p>
              <DataTable caption={t('home.profile.evidence.title')} columns={evidenceColumns} rows={evidenceRowsFor(warning.evidence.cells, ownPlan)} rowKey={(cell) => `${cell.bucket}|${cell.budgetLevel}`} />
            </>
          )}
        </SectionCard>
      </div>
      <div data-testid="profile-leader">
        <SectionCard title={t('home.profile.leader.title')}>
          <p>{warning.leader === null ? t('home.warnings.leader.none') : warning.leader.displayName}</p>
        </SectionCard>
      </div>
      <div data-testid="profile-explanation">
        <SectionCard title={t('home.profile.explanation.title')}>
          <p>
            {warning.explanation === null
              ? t('home.warnings.explanation.none')
              : t('home.profile.explanation.status', { status: explanationStatusLabel(t, warning.explanation.status), due: warning.explanation.dueAt.slice(0, 10) })}
          </p>
        </SectionCard>
      </div>
      <div data-testid="profile-history">
        <SectionCard title={t('home.profile.history.title')}>
          <ol className="home-lines">
            {warning.history.map((entry, index) => (
              <li key={`${entry.event}:${index}`} data-event={entry.event}>
                {entry.at.slice(0, 10)} · {historyLabel(t, entry.event)}
                {entry.note === null ? '' : `: ${entry.note}`}
              </li>
            ))}
          </ol>
        </SectionCard>
      </div>
      {done === undefined ? null : (
        <p role="status" data-testid="profile-done">
          <StatusPill tone="success">{done === 'explain' ? t('home.profile.done.explain') : done === 'acknowledge' ? t('home.profile.done.acknowledge') : t('home.profile.done.dismiss')}</StatusPill>
        </p>
      )}
      <div className="home-actions" data-testid="profile-actions">
        {canExplain ? (
          <button type="button" className="ui-button ui-button--outline" onClick={() => setAction('explain')}>
            {t('home.profile.action.explain')}
          </button>
        ) : null}
        {canAcknowledge ? (
          <button type="button" className="ui-button ui-button--outline" onClick={() => setAction('acknowledge')}>
            {t('home.profile.action.acknowledge')}
          </button>
        ) : null}
        {canDismiss ? (
          <button type="button" className="ui-button ui-button--outline" onClick={() => setAction('dismiss')}>
            {t('home.profile.action.dismiss')}
          </button>
        ) : null}
      </div>
      {holds(REQUEST_EXPLANATION_PERMISSION) && warning.project !== null && warning.leader === null && (warning.status === 'OPEN' || warning.status === 'ACKNOWLEDGED') ? <p className="home-note">{t('home.profile.explain.noLeader')}</p> : null}
      {action === undefined ? null : (
        <div className="home-dialog" role="dialog" aria-modal="false" aria-labelledby="profile-dialog-title" data-testid="profile-dialog">
          <h2 id="profile-dialog-title">{actionTitle}</h2>
          <dl className="aud-facts" data-testid="profile-dialog-context">
            <dt>{t('home.profile.cause.rule')}</dt>
            <dd>
              {warning.ruleCode} {warning.ruleName}
            </dd>
            <dt>{t('home.profile.cause.project')}</dt>
            <dd>{warning.project === null ? NONE : `${warning.project.code} ${warning.project.name}`}</dd>
            <dt>{t('w2dis.home.profile.dialog.status')}</dt>
            <dd>{warningStatusLabel(t, warning.status)}</dd>
          </dl>
          {action === 'explain' ? (
            <>
              <Field id="profile-question" label={t('home.profile.explain.question.label')} error={undefined}>
                <textarea id="profile-question" value={question} maxLength={2000} onChange={(event) => setQuestion(event.target.value)} />
              </Field>
              <Field id="profile-due" label={t('home.profile.explain.due.label')} error={undefined}>
                <input id="profile-due" type="date" min={today} value={due} onChange={(event) => setDue(event.target.value)} />
              </Field>
              <p className="home-note">{t('home.profile.explain.to', { leader: warning.leader?.displayName ?? '' })}</p>
            </>
          ) : (
            <Field id="profile-reason" label={t('home.profile.reason.label')} error={undefined}>
              <textarea id="profile-reason" value={reason} maxLength={2000} onChange={(event) => setReason(event.target.value)} />
            </Field>
          )}
          {failure === null || failure === undefined ? null : (
            <p role="alert" className="field-error" data-testid="profile-problem">
              {problemText(t, problemKey(failure))}
            </p>
          )}
          <div className="home-actions">
            <button type="button" className="ui-button ui-button--outline" onClick={close} disabled={busy}>
              {t('home.profile.cancel')}
            </button>
            <button type="button" className="ui-button ui-button--primary" onClick={submit} disabled={busy || (action === 'explain' ? !askOk : !reasonOk)}>
              {t('home.profile.confirm')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function problemText(t: T, key: ReturnType<typeof problemKey>): string {
  switch (key) {
    case 'conflict':
      return t('home.profile.problem.conflict');
    case 'state':
      return t('home.profile.problem.state');
    case 'denied':
      return t('home.profile.problem.denied');
    case 'validation':
      return t('home.profile.problem.validation');
    case 'general':
      return t('home.profile.problem.general');
  }
}
