import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import type { ScreenState } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { DataTable, MakerCheckerBadge, SectionCard, Stepper, StatusPill, Timeline } from '../../../ui';
import type { TimelineGroup } from '../../../ui';
import { useCase } from '../shared/vnd-hooks';
import { caseStatusLabel, groupLabel, moveLabel, scopeLabel, suggestionLabel, triggerLabel } from '../shared/vnd-labels';
import {
  PATHS,
  banLastDay,
  banRange,
  caseMoves,
  caseStatusTone,
  caseSteps,
  dayText,
  failureStatus,
  initialsOf,
  isFinalStatus,
  isProposer,
  numberText,
  paramNumber,
  periodsOf,
  vietnamDay,
  vietnamStamp,
} from '../shared/vnd-model';
import type { CaseDetail, CaseMember, CaseMoveCode } from '../shared/vnd-model';
import { ClockCell, CountInfo, Empty, Fact, PolicyInfo, ReadOnlyNote, ReceiptNote, Screen, ScreenFooter, ScreenHead, StaleNotice, UnverifiedPill, useReceipt, useWriter } from '../shared/vnd-ui';
import { AdvanceDialog, DecideDialog, EffectDialog, LiftDialog } from './case-dialogs';

type Dialog = { kind: 'advance'; move: CaseMoveCode } | { kind: 'decide' } | { kind: 'effect' } | { kind: 'lift' };

const NONE = '–';
const orNone = (value: string | null | undefined): string => (value === null || value === undefined || value === '' ? NONE : value);

/**
 * One debarment case: where it stands on the steps from the proposal to the end, the clock of the decision, the decision and the ban period it may take, the members it reaches, the suggestion to widen the ban (a suggestion, never an
 * action), and what happened when. The steps are offered by what the answer says the caller may do; the proposer cannot decide.
 */
export default function CaseDetailView({ route, id }: ScreenProps & { id: string }) {
  const { t } = useTranslation();
  const writer = useWriter();
  const { user } = useSession();
  const query = useCase(id);
  const [dialog, setDialog] = useState<Dialog | undefined>(undefined);
  const receipt = useReceipt();
  const detail = query.data;
  const base = useScreenState({ isLoading: query.isLoading, error: detail === undefined ? query.error : undefined, data: detail, isEmpty: () => false });
  const state: ScreenState = detail === undefined && failureStatus(query.error) === 404 ? 'empty' : base;
  const refreshFailed = query.isError && detail !== undefined;
  const done = (what: string): void => {
    setDialog(undefined);
    receipt.show(t('vnd.receipt.done.text', { what, time: vietnamStamp(new Date().toISOString()) }));
  };

  return (
    <Screen route={route}>
      <ScreenHead
        title={detail === undefined ? t('vnd.cases.detail.title') : detail.case.case_no}
        subtitle={t('vnd.cases.detail.subtitle')}
        asOf={detail?.as_of}
        stale={refreshFailed}
        actions={
          <Link className="ui-button ui-button--outline" to={PATHS.cases}>
            {t('vnd.cases.back.action')}
          </Link>
        }
      />
      <ReadOnlyNote show={writer.readOnly} />
      <ReceiptNote text={receipt.receipt} />
      {refreshFailed && <StaleNotice onRetry={() => void query.refetch()} />}
      <StateBoundary state={state} onRetry={() => void query.refetch()}>
        {detail !== undefined && (
          <div className="vnd-page">
            <CaseStepper detail={detail} />
            <Actions
              detail={detail}
              canAct={!writer.readOnly}
              proposer={isProposer(detail.case, user?.displayName)}
              onMove={(move) => setDialog({ kind: 'advance', move })}
              onDecide={() => setDialog({ kind: 'decide' })}
              onEffect={() => setDialog({ kind: 'effect' })}
              onLift={() => setDialog({ kind: 'lift' })}
            />
            <Summary detail={detail} />
            <div className="vnd-cols">
              <DecisionCard detail={detail} />
              <PeriodCard detail={detail} />
            </div>
            <EscalationCard detail={detail} />
            <MembersCard members={detail.members} />
            <HistoryCard detail={detail} />
          </div>
        )}
      </StateBoundary>
      {detail !== undefined && dialog?.kind === 'advance' && <AdvanceDialog line={detail.case} move={dialog.move} onClose={() => setDialog(undefined)} onDone={() => done(moveLabel(t, dialog.move))} />}
      {detail !== undefined && dialog?.kind === 'decide' && <DecideDialog detail={detail} onClose={() => setDialog(undefined)} onDone={() => done(t('vnd.cases.decide.title'))} />}
      {detail !== undefined && dialog?.kind === 'effect' && <EffectDialog line={detail.case} members={detail.members.length} onClose={() => setDialog(undefined)} onDone={() => done(t('vnd.cases.effect.title'))} />}
      {detail !== undefined && dialog?.kind === 'lift' && <LiftDialog line={detail.case} onClose={() => setDialog(undefined)} onDone={() => done(t('vnd.cases.lift.title'))} />}
      <ScreenFooter route={route} />
    </Screen>
  );
}

function CaseStepper({ detail }: { detail: CaseDetail }) {
  const { t } = useTranslation();
  const line = detail.case;
  const steps = caseSteps(line, detail.events).map((step) => ({
    code: step.code,
    status: step.status,
    label: step.code === 'END' ? (isFinalStatus(line.status) ? caseStatusLabel(t, line.status) : t('vnd.cases.step.end.name')) : caseStatusLabel(t, step.code),
  }));
  return (
    <SectionCard title={t('vnd.cases.section.steps.title')} status={<StatusPill tone={caseStatusTone(line.status)}>{caseStatusLabel(t, line.status)}</StatusPill>}>
      <div data-testid="case-stepper" data-status={line.status}>
        <Stepper steps={steps} label={t('vnd.cases.stepper.label')} />
      </div>
      <p className="vnd-note">{t('vnd.cases.stepper.note')}</p>
    </SectionCard>
  );
}

interface ActionsProps {
  detail: CaseDetail;
  canAct: boolean;
  proposer: boolean;
  onMove: (move: CaseMoveCode) => void;
  onDecide: () => void;
  onEffect: () => void;
  onLift: () => void;
}

/** What can be done next, by what the answer allows. A person who proposed the case sees the decision turned off with the reason, not hidden. */
function Actions({ detail, canAct, proposer, onMove, onDecide, onEffect, onLift }: ActionsProps) {
  const { t } = useTranslation();
  if (!canAct) return null;
  const moves = detail.may_advance ? caseMoves(detail.case.status) : [];
  const decide = detail.may_decide;
  const nothing = moves.length === 0 && !decide && !detail.may_put_into_effect && !detail.may_lift;
  return (
    <SectionCard title={t('vnd.cases.section.actions.title')}>
      {nothing ? (
        <Empty text={t('vnd.cases.actions.none.text')} testId="actions-none" />
      ) : (
        <div className="vnd-row" data-testid="case-actions">
          {moves.map((move) => (
            <button key={move} type="button" className={move === 'WITHDRAW' ? 'ui-button ui-button--outline' : 'ui-button ui-button--primary'} data-testid={`move-${move}`} onClick={() => onMove(move)}>
              {moveLabel(t, move)}
            </button>
          ))}
          {decide && (
            <button type="button" className="ui-button ui-button--primary" data-testid="decide" disabled={proposer} aria-describedby={proposer ? 'decide-blocked' : undefined} onClick={onDecide}>
              {t('vnd.cases.decide.action')}
            </button>
          )}
          {detail.may_put_into_effect && (
            <button type="button" className="ui-button ui-button--primary" data-testid="effect" onClick={onEffect}>
              {t('vnd.cases.effect.action')}
            </button>
          )}
          {detail.may_lift && (
            <button type="button" className="ui-button ui-button--outline" data-testid="lift" onClick={onLift}>
              {t('vnd.cases.lift.action')}
            </button>
          )}
        </div>
      )}
      {decide && proposer && (
        <p className="callout" id="decide-blocked" data-testid="decide-blocked">
          {t('vnd.cases.decide.proposer.text')}
        </p>
      )}
    </SectionCard>
  );
}

function Summary({ detail }: { detail: CaseDetail }) {
  const { t } = useTranslation();
  const line = detail.case;
  const periods = periodsOf(detail.periods);
  return (
    <SectionCard title={t('vnd.cases.section.summary.title')}>
      <dl className="vnd-facts" data-testid="case-facts">
        <Fact label={t('vnd.cases.fact.no.label')} testId="fact-no">
          <code>{line.case_no}</code>
        </Fact>
        <Fact label={t('vnd.cases.fact.subject.label')} testId="fact-subject">
          {line.contractor_id === null ? line.subject_name : <Link to={PATHS.profile(line.contractor_id)}>{line.subject_name}</Link>}{' '}
          <span className="vnd-days">{line.subject_kind === 'JOINT_VENTURE' ? t('vnd.subject.jointVenture.name') : t('vnd.subject.contractor.name')}</span>
        </Fact>
        <Fact label={t('vnd.cases.fact.trigger.label')} testId="fact-trigger">
          {triggerLabel(t, line.trigger_kind)}
          {line.trigger_ref !== null && <span className="vnd-days"> · {line.trigger_ref}</span>}
          {line.egp_record_id !== null && <span className="vnd-days"> · {t('vnd.cases.fact.egp.text', { id: line.egp_record_id })}</span>}
        </Fact>
        <Fact label={t('vnd.cases.fact.groups.label')} testId="fact-groups">
          <ul className="vnd-list">
            {line.violation_groups.map((group) => (
              <li key={group}>
                {groupLabel(t, group)}
                {periods[group] !== undefined && <span className="vnd-days"> · {periods[group]?.behaviours}</span>}
              </li>
            ))}
          </ul>
        </Fact>
        <Fact label={t('vnd.cases.fact.summary.label')} testId="fact-summary">
          {line.violation_summary}
        </Fact>
        <Fact label={t('vnd.cases.fact.violationOn.label')} testId="fact-violation-on">
          {dayText(line.violation_on)}
        </Fact>
        <Fact label={t('vnd.cases.fact.proposed.label')} testId="fact-proposed">
          <span className="vnd-stack">
            <span>{t('vnd.cases.fact.proposedAt.text', { name: orNone(line.proposed_by_name), time: vietnamStamp(line.received_at) })}</span>
            <MakerCheckerBadge maker={orNone(line.proposed_by_name)} checker={line.decided_by_name} />
          </span>
        </Fact>
        <Fact label={t('vnd.cases.fact.clock.label')} testId="fact-clock">
          <span className="vnd-row">
            <ClockCell clock={line.clock} dueAt={line.decide_by} asOf={detail.as_of} />
            <span>{t('vnd.cases.fact.decideBy.text', { time: vietnamStamp(line.decide_by) })}</span>
            <PolicyInfo name={t('vnd.cases.figure.clock.name')} policy={detail.policy} />
            {detail.policy.unverified && <UnverifiedPill />}
          </span>
        </Fact>
        {line.response_due_at !== null && (
          <Fact label={t('vnd.cases.fact.response.label')} testId="fact-response">
            {t('vnd.cases.fact.responseDue.text', { time: vietnamStamp(line.response_due_at) })}
            {line.response_outcome !== null && <span className="vnd-days"> · {line.response_outcome === 'RESPONDED' ? t('vnd.cases.response.responded.name') : t('vnd.cases.response.none.name')}</span>}
            {detail.response_summary !== null && <span className="vnd-days"> · {detail.response_summary}</span>}
          </Fact>
        )}
        <Fact label={t('vnd.cases.fact.documents.label')} testId="fact-documents">
          <ul className="vnd-list">
            {detail.proposal_document_id !== null && <li>{t('vnd.cases.fact.document.proposal', { id: detail.proposal_document_id })}</li>}
            {detail.notice_document_id !== null && <li>{t('vnd.cases.fact.document.notice', { id: detail.notice_document_id })}</li>}
            {detail.response_document_id !== null && <li>{t('vnd.cases.fact.document.response', { id: detail.response_document_id })}</li>}
            {detail.decision_document_id !== null && <li>{t('vnd.cases.fact.document.decision', { id: detail.decision_document_id })}</li>}
            {detail.lift_document_id !== null && <li>{t('vnd.cases.fact.document.lift', { id: detail.lift_document_id })}</li>}
          </ul>
        </Fact>
      </dl>
    </SectionCard>
  );
}

function DecisionCard({ detail }: { detail: CaseDetail }) {
  const { t } = useTranslation();
  const line = detail.case;
  const pending = line.decision === null && detail.end_reason === null;
  return (
    <SectionCard title={t('vnd.cases.section.decision.title')}>
      {pending ? (
        <Empty text={t('vnd.cases.decision.pending.text')} testId="decision-pending" />
      ) : (
        <dl className="vnd-facts" data-testid="decision-facts">
          {line.decision !== null && (
            <>
              <Fact label={t('vnd.cases.fact.decision.label')} testId="fact-decision">
                <StatusPill tone={line.decision === 'BAN' ? 'danger' : 'neutral'}>{line.decision === 'BAN' ? t('vnd.cases.decision.ban.name') : t('vnd.cases.decision.dismiss.name')}</StatusPill>
              </Fact>
              <Fact label={t('vnd.cases.fact.decidedBy.label')} testId="fact-decided-by">
                {t('vnd.cases.fact.decidedAt.text', { name: orNone(line.decided_by_name), time: line.decided_at === null ? NONE : vietnamStamp(line.decided_at) })}
                {line.decided_late === true && <StatusPill tone="warning">{t('vnd.cases.decision.late.badge')}</StatusPill>}
              </Fact>
            </>
          )}
          {line.decision === 'BAN' && (
            <>
              <Fact label={t('vnd.cases.fact.scope.label')} testId="fact-scope">
                {line.decision_scope === null ? NONE : scopeLabel(t, line.decision_scope)}
              </Fact>
              <Fact label={t('vnd.cases.fact.period.label')} testId="fact-period">
                {line.ban_months === null ? NONE : t('vnd.cases.decision.months.text', { months: line.ban_months })} {line.effective_from !== null && line.effective_until !== null ? `· ${dayText(line.effective_from)} – ${dayText(line.effective_until)}` : ''}
              </Fact>
            </>
          )}
          {detail.decision_reason !== null && (
            <Fact label={t('vnd.cases.fact.reason.label')} testId="fact-reason">
              {detail.decision_reason}
            </Fact>
          )}
          {detail.end_reason !== null && (
            <Fact label={t('vnd.cases.fact.endReason.label')} testId="fact-end-reason">
              {detail.end_reason}
            </Fact>
          )}
        </dl>
      )}
    </SectionCard>
  );
}

/** The months the violation groups allow and what a ban of the shortest and the longest length would end on: the numbers of the rule (the Gazette is not read by this system), so they carry the flag. */
function PeriodCard({ detail }: { detail: CaseDetail }) {
  const { t } = useTranslation();
  const line = detail.case;
  const periods = periodsOf(detail.periods);
  const range = banRange(line.violation_groups, periods, paramNumber(detail.policy, 'cumulative_max_months'));
  const from = line.effective_from ?? vietnamDay(detail.as_of);
  return (
    <SectionCard title={t('vnd.cases.section.period.title')} status={detail.policy.unverified ? <UnverifiedPill /> : undefined}>
      {range === null ? (
        <Empty text={t('vnd.cases.period.unknown.text')} testId="period-unknown" />
      ) : (
        <>
          <p className="vnd-period" data-testid="period-range">
            <strong>{t('vnd.cases.period.range.text', { min: range.min, max: range.max })}</strong>
            <PolicyInfo name={t('vnd.cases.figure.period.name')} policy={detail.policy} />
          </p>
          <p className="vnd-note" data-testid="period-example">
            {t('vnd.cases.period.example.text', { from: dayText(from), shortest: dayText(banLastDay(from, range.min)), longest: dayText(banLastDay(from, range.max)) })}
          </p>
        </>
      )}
    </SectionCard>
  );
}

/** Three decisions in force suggest a ban in the province, five a ban in the whole country (the numbers are the rule's). It is a suggestion for the authority; this screen has no command for it. */
function EscalationCard({ detail }: { detail: CaseDetail }) {
  const { t, locale } = useTranslation();
  const escalation = detail.escalation;
  return (
    <SectionCard title={t('vnd.cases.section.escalation.title')} status={<UnverifiedPill />}>
      <p className="vnd-row" data-testid="escalation-count">
        <span>{t('vnd.cases.escalation.count.text', { count: numberText(escalation.decisions_in_force, locale) })}</span>
        <CountInfo name={t('vnd.cases.figure.escalation.name')} formula={t('vnd.cases.figure.escalation.formula')} source={t('vnd.cases.figure.escalation.source')} asOf={detail.as_of} unverified />
      </p>
      {escalation.suggestion === 'NONE' ? (
        <p className="vnd-note" data-testid="escalation-none">
          {t('vnd.cases.escalation.none.text')}
        </p>
      ) : (
        <p className="callout vnd-suggestion" data-testid="escalation-suggestion" data-suggestion={escalation.suggestion}>
          {t('vnd.cases.escalation.suggestion.text', { scope: suggestionLabel(t, escalation.suggestion) })}
        </p>
      )}
    </SectionCard>
  );
}

function MembersCard({ members }: { members: CaseMember[] }) {
  const { t } = useTranslation();
  return (
    <SectionCard title={t('vnd.cases.members.title')}>
      {members.length === 0 ? (
        <Empty text={t('vnd.cases.members.empty.text')} testId="members-empty" />
      ) : (
        <DataTable<CaseMember>
          caption={t('vnd.cases.members.caption')}
          rows={members}
          rowKey={(row) => row.contractor_id}
          rowAttrs={(row) => ({ 'data-member-id': row.contractor_id })}
          columns={[
            { key: 'name', header: t('vnd.cases.members.column.name'), pinned: true, render: (row) => <Link to={PATHS.profile(row.contractor_id)}>{row.contractor_name}</Link> },
            {
              key: 'restriction',
              header: t('vnd.cases.members.column.restriction'),
              render: (row) =>
                row.restriction_id === null ? <StatusPill tone="neutral">{t('vnd.cases.members.notYet.text')}</StatusPill> : <StatusPill tone="danger" icon="⛔">{t('vnd.cases.members.recorded.text')}</StatusPill>,
            },
          ]}
        />
      )}
    </SectionCard>
  );
}

function HistoryCard({ detail }: { detail: CaseDetail }) {
  const { t } = useTranslation();
  const byDay = new Map<string, TimelineGroup['entries'][number][]>();
  for (const event of detail.events) {
    const day = vietnamDay(event.occurred_at);
    const entry: TimelineGroup['entries'][number] = {
      id: event.id,
      at: event.occurred_at,
      kind: 'transition',
      title: t('vnd.cases.timeline.entry.text', { move: moveLabel(t, event.move), from: event.from_status === null ? NONE : caseStatusLabel(t, event.from_status), to: caseStatusLabel(t, event.to_status) }),
      actor: event.actor_name === null ? null : { name: event.actor_name, initials: initialsOf(event.actor_name) },
      ...(event.note === null ? {} : { note: event.note }),
    };
    byDay.set(day, [...(byDay.get(day) ?? []), entry]);
  }
  const groups: TimelineGroup[] = [...byDay.entries()].map(([date, entries]) => ({ date, entries }));
  return (
    <SectionCard title={t('vnd.cases.section.history.title')}>
      <Timeline groups={groups} caption={t('vnd.cases.timeline.caption')} today={vietnamDay(detail.as_of)} gaps={false} />
    </SectionCard>
  );
}
