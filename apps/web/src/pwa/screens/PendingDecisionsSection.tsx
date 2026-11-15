import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '@machvon/api-client';
import { useTranslation } from '../../i18n';
import { StatusPill } from '../../ui';
import { RecordSummaryFacts, summaryDay } from './ApprovalRecordSummary';
import { DecisionSheet } from './DecisionSheet';
import { describeProblem } from './approval-model';
import { problemText } from './approval-problem';
import { useDecidePending } from './pending-hooks';
import { PENDING_KIND_KEYS, checkPendingComment, pendingLink } from './pending-model';
import type { PendingAction, PendingDecision } from './pending-model';

const KIND_WORDS = ['completion', 'exception', 'reschedule', 'adjustment'] as const;
type KindWord = (typeof KIND_WORDS)[number];
const kindWord = (kind: string): KindWord | undefined => KIND_WORDS.find((word) => word === PENDING_KIND_KEYS[kind]);

/** The refusals the commands of PWF give that the inbox of the engine never sees: a maker is not the approver, and a record that somebody decided or that moved meanwhile. */
function pendingProblemKey(error: unknown): 'maker' | 'moved' | undefined {
  if (!(error instanceof ApiError)) return undefined;
  if (error.code === 'MAKER_IS_APPROVER') return 'maker';
  if (['PWF_SCHEDULE_VERSION_CONFLICT', 'PWF_TASK_STATE_INVALID', 'PWF_EXCEPTION_INVALID', 'STAFF_SCORE_ADJUSTMENT_INVALID', 'STAFF_SCORE_PERIOD_LOCKED'].includes(error.code)) return 'moved';
  return undefined;
}

export interface PendingDecisionsSectionProps {
  items: readonly PendingDecision[];
  /** The session may change things (not read-only). */
  mayAct: boolean;
  onDecided(): void;
}

/**
 * The part of the approval queue that is not a task of the engine (PWF 20.9): each record with what the decider reads of it (the project, the task, the day, the reason, who asked, the period) and the decisions its
 * own command takes. The card is the detail: nobody decides a record they cannot read. The decision is one request of the command the item names, sent while the page is online, under the version on the screen.
 */
export function PendingDecisionsSection({ items, mayAct, onDecided }: PendingDecisionsSectionProps) {
  const { t } = useTranslation();
  const decide = useDecidePending();
  const [acting, setActing] = useState<{ item: PendingDecision; action: PendingAction } | undefined>(undefined);
  const [local, setLocal] = useState<'required' | 'tooShort' | 'tooLong' | undefined>(undefined);
  const [done, setDone] = useState<{ title: string; decision: PendingAction['decision'] } | undefined>(undefined);

  const titleOf = (item: PendingDecision): string => {
    const word = kindWord(item.kind);
    return word === undefined ? t('fix12.inbox.kind.other') : t(`fix12.inbox.kind.${word}`);
  };
  const close = (): void => {
    setActing(undefined);
    setLocal(undefined);
    decide.reset();
  };
  const send = (comment: string): void => {
    if (acting === undefined) return;
    const problem = checkPendingComment(acting.action, comment);
    setLocal(problem);
    if (problem !== undefined) return;
    const { item, action } = acting;
    decide.mutate(
      { item, action, comment },
      {
        onSuccess: () => {
          setDone({ title: titleOf(item), decision: action.decision });
          close();
          onDecided();
        },
      },
    );
  };

  const own = decide.isError ? pendingProblemKey(decide.error) : undefined;
  const sheetProblem =
    local === 'required'
      ? t('fix12.inbox.problem.required')
      : local === 'tooShort'
        ? t('fix12.inbox.problem.tooShort', { min: acting?.action.reasonMin ?? 0 })
        : local === 'tooLong'
          ? t('fix12.inbox.problem.tooLong', { max: acting?.action.reasonMax ?? 0 })
          : !decide.isError
            ? undefined
            : own !== undefined
              ? t(`fix12.inbox.problem.${own}`)
              : problemText(t, describeProblem(decide.error));

  if (items.length === 0 && done === undefined) return null;
  return (
    <section aria-labelledby="pending-decisions-title" data-testid="pending-decisions">
      <h2 id="pending-decisions-title" className="pwa-subhead">
        {t('fix12.inbox.section.title')}
      </h2>
      <p className="sub">{t('fix12.inbox.section.note')}</p>
      {done === undefined ? null : (
        <p className="callout pwa-receipt" role="status" data-testid="pending-receipt">
          <strong>{t(`fix12.inbox.receipt.${done.decision}`)}</strong> {done.title}{' '}
          <button type="button" className="ui-button ui-button--outline ui-button--small pwa-touch" onClick={() => setDone(undefined)}>
            {t('pwa.approvals.receipt.dismiss')}
          </button>
        </p>
      )}
      <ul className="pwa-cards" aria-label={t('fix12.inbox.section.title')}>
        {items.map((item) => {
          const link = pendingLink(item);
          return (
            <li key={item.id} className="pwa-card" data-pending={item.id} data-kind={item.kind}>
              <div className="pwa-card-head">
                <h3>{titleOf(item)}</h3>
                <span className="pwa-pills">
                  <StatusPill tone={item.overdue ? 'danger' : 'neutral'}>{item.overdue ? t('pwa.approvals.status.late') : t('pwa.approvals.status.pending')}</StatusPill>
                </span>
              </div>
              <p className="sub" data-testid="pending-submitted">
                {t('fix12.inbox.row.submitted', { day: summaryDay(item.submittedAt) })}
              </p>
              <RecordSummaryFacts summary={item.summary} sender={item.initiatorName} />
              {link === undefined ? null : (
                <Link to={link} className="ui-button ui-button--outline pwa-touch" data-action="open-record">
                  {t('fix12.inbox.action.open')}
                </Link>
              )}
              {mayAct && item.actions.length > 0 ? (
                <div className="pwa-actions">
                  {item.actions.map((action) => (
                    <button key={action.decision} type="button" className={`ui-button ${action.decision === 'approve' ? 'ui-button--primary' : 'ui-button--outline'} pwa-touch`} data-action={`pending-${action.decision}`} onClick={() => setActing({ item, action })}>
                      {t(`fix12.inbox.action.${action.decision}`)}
                    </button>
                  ))}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      {acting === undefined ? null : (
        <DecisionSheet
          title={t(`fix12.inbox.sheet.${acting.action.decision}`)}
          context={[
            { label: t('pwa.approvals.field.record'), value: titleOf(acting.item) },
            ...(acting.item.summary.project === null ? [] : [{ label: t('fix11.apv.project.label'), value: acting.item.summary.project.name }]),
            ...(acting.item.summary.subjectName === null ? [] : [{ label: t('fix11.apv.subject.label'), value: acting.item.summary.subjectName }]),
          ]}
          commentLabel={acting.action.reasonRequired ? t('fix12.inbox.sheet.reason') : t('pwa.approvals.sheet.approve.comment')}
          commentRequired={acting.action.reasonRequired}
          problem={sheetProblem}
          pending={decide.isPending}
          submitLabel={t(`fix12.inbox.action.${acting.action.decision}`)}
          cancelLabel={t('pwa.approvals.sheet.cancel')}
          pendingLabel={t('pwa.approvals.sheet.pending')}
          requiredLabel={t('pwa.approvals.sheet.required')}
          onSubmit={send}
          onCancel={close}
        />
      )}
    </section>
  );
}
