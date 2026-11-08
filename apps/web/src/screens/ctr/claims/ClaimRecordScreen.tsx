import { useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { ContextBar, SectionCard, StatusPill } from '../../../ui';
import { ClaimDialogs } from './ClaimDialogs';
import type { ClaimDialog } from './ClaimDialogs';
import { BackLink, CalendarNotice, FigureInfo, StatePill, WithInfo } from './components';
import { can, dayText, stampText, vnd } from './common';
import { useClaim } from './hooks';
import { basisLabel, decisionLabel, deadlineLabel, effectLabel, kindLabel, owedByLabel, sideLabel, statusLabel, stepLabel } from './labels';
import { BAR_PERMISSION, DEADLINE_CODES, MANAGE_PERMISSION, PATHS, SETTLE_PERMISSION, periodsOf } from './model';
import type { Claim, ClaimDeadline, RecordableStep } from './model';
import './claims.css';

const NONE = '–';

/**
 * CTR-33, one claim with the clocks of its contract's term (G1-9): the four deadlines (notice, particulars, response, settlement) counted by the server from the approved term and the days of the timeline, the limitation, the
 * timeline itself (append-only, each step on the day it happened), the settlement (proposed by one person, approved by another) and the links to a change order and a payment. A claim whose contract has no approved term shows no clock and says so.
 */
export default function ClaimRecordScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  const [params] = useSearchParams();
  // The claim belongs to one membership: a switch of tenant or of membership starts the screen over.
  return <ClaimRecordContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}:${params.get('claim') ?? ''}`} route={route} claimId={params.get('claim')} />;
}

function DeadlineCard({ claim, deadline }: { claim: Claim; deadline: ClaimDeadline }) {
  const { t } = useTranslation();
  const term = claim.term;
  const name = deadlineLabel(t, deadline.code);
  const defined = deadline.state !== 'NOT_DEFINED';
  return (
    <li className="ctrreg-clock" data-testid={`clock-${deadline.code.toLowerCase()}`} data-state={deadline.state}>
      <header>
        <h3>{name}</h3>
        <StatePill group="deadline" state={deadline.state} />
      </header>
      {!defined && <p className="sub">{t('ctrClaim.clock.notDefined.text')}</p>}
      {deadline.state === 'CALENDAR_UNAVAILABLE' && <p className="sub">{t('ctrClaim.clock.calendar.text')}</p>}
      {defined && (
        <dl className="ctrreg-facts">
          {deadline.period_days !== null && deadline.basis !== null && (
            <>
              <dt>{t('ctrClaim.clock.period.label')}</dt>
              <dd>{t('ctrClaim.clock.period.text', { days: deadline.period_days, basis: basisLabel(t, deadline.basis) })}</dd>
            </>
          )}
          <dt>{t('ctrClaim.clock.startedOn.label')}</dt>
          <dd>{deadline.started_on === null ? NONE : dayText(deadline.started_on)}</dd>
          <dt>{t('ctrClaim.clock.dueOn.label')}</dt>
          <dd data-testid="due">
            {deadline.due_on === null ? (
              NONE
            ) : (
              <WithInfo
                info={
                  <FigureInfo
                    name={name}
                    formula={t('ctrClaim.figure.deadline.formula')}
                    source={term === null ? t('ctrClaim.figure.deadline.noClause') : t('ctrClaim.figure.deadline.source', { clause: term.clause_reference })}
                    asOf={dayText(claim.as_of)}
                    version={term === null ? t('ctrReg.info.noRule.text') : t('ctrClaim.figure.deadline.version', { version: term.version, status: term.status })}
                  />
                }
              >
                <span>{dayText(deadline.due_on)}</span>
              </WithInfo>
            )}
          </dd>
          {deadline.days_left !== null && (
            <>
              <dt>{t('ctrClaim.clock.daysLeft.label')}</dt>
              <dd>{deadline.days_left >= 0 ? t('ctrClaim.clock.daysLeft.text', { days: deadline.days_left }) : t('ctrClaim.clock.daysPast.text', { days: -deadline.days_left })}</dd>
            </>
          )}
          <dt>{t('ctrClaim.clock.doneOn.label')}</dt>
          <dd>{deadline.done_on === null ? NONE : dayText(deadline.done_on)}</dd>
          <dt>{t('ctrClaim.clock.owedBy.label')}</dt>
          <dd>
            {owedByLabel(t, deadline.owed_by)}
            {deadline.owed_by_owner ? ` · ${t('ctrClaim.clock.owedByOwner.text')}` : ''}
          </dd>
        </dl>
      )}
    </li>
  );
}

function Fact({ label, children, testId }: { label: string; children: ReactNode; testId?: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd {...(testId === undefined ? {} : { 'data-testid': testId })}>{children}</dd>
    </>
  );
}

function ClaimRecordContent({ route, claimId }: ScreenProps & { claimId: string | null }) {
  const { t, locale } = useTranslation();
  const { permissions, mode } = useSession();
  const query = useClaim(claimId);
  const [dialog, setDialog] = useState<ClaimDialog | undefined>(undefined);
  const [receipt, setReceipt] = useState<string | undefined>(undefined);
  const claim = query.data;
  const state = useScreenState({ isLoading: query.isLoading, error: claim === undefined ? query.error : undefined, data: claim, isEmpty: () => false });
  const frozen = mode === 'READ_ONLY';
  const canManage = can(permissions, MANAGE_PERMISSION, frozen);
  const canSettle = can(permissions, SETTLE_PERMISSION, frozen);
  const canBar = can(permissions, BAR_PERMISSION, frozen);
  const refreshFailed = query.isError && claim !== undefined;

  if (claimId === null) {
    return (
      <section data-screen-id={route.id} aria-labelledby="screen-title">
        <h1 id="screen-title">{t('ctrClaim.record.page.title')}</h1>
        <div className="card" role="status" data-testid="no-claim">
          <p>{t('ctrClaim.record.noClaim.text')}</p>
          <Link to={PATHS.register}>{t('ctrClaim.record.toRegister.action')}</Link>
        </div>
      </section>
    );
  }

  const open = (next: ClaimDialog): void => {
    setReceipt(undefined);
    setDialog(next);
  };
  const stepButton = (step: RecordableStep, claimNow: Claim): ReactNode =>
    claimNow.allowed.steps.includes(step) ? (
      <button type="button" key={step} className="ui-button ui-button--outline" onClick={() => open({ kind: 'step', step })} data-testid={`step-${step.toLowerCase()}`}>
        {stepLabel(t, step)}
      </button>
    ) : null;

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title" className="ctrreg-page">
      <BackLink to={PATHS.register}>{t('ctrClaim.record.back.action')}</BackLink>
      <div className="heading">
        <div>
          <h1 id="screen-title">{claim === undefined ? t('ctrClaim.record.page.title') : `${claim.code} · ${claim.title}`}</h1>
          <p>{t('ctrClaim.record.page.subtitle')}</p>
        </div>
        {claim !== undefined && (
          <div className="actions" data-testid="status">
            <StatusPill tone={claim.status === 'SETTLED' ? 'success' : claim.status === 'TIME_BARRED' ? 'danger' : 'info'}>{statusLabel(t, claim.status)}</StatusPill>
          </div>
        )}
      </div>
      {claim !== undefined && <ContextBar items={[{ label: t('ctrClaim.context.contract.label'), value: claim.contract.code }]} stale={refreshFailed} asOf={stampText(claim.as_of)} unit={t('ctrClaim.unit.vnd.text')} />}
      {receipt !== undefined && (
        <p className="ctrreg-receipt" role="status" data-testid="receipt">
          {receipt}
        </p>
      )}
      <StateBoundary state={state} onRetry={() => void query.refetch()}>
        {claim !== undefined && (
          <>
            <CalendarNotice published={claim.calendar_published} />
            <SectionCard title={t('ctrClaim.record.facts.title')}>
              <dl className="ctrreg-facts">
                <Fact label={t('ctrClaim.record.contract.label')}>
                  <Link to={`${PATHS.terms}?contract=${claim.contract.id}`}>{claim.contract.code}</Link>
                </Fact>
                <Fact label={t('ctrClaim.record.side.label')}>{sideLabel(t, claim.claimant_side)}</Fact>
                <Fact label={t('ctrClaim.record.kind.label')}>{kindLabel(t, claim.kind)}</Fact>
                <Fact label={t('ctrClaim.record.event.label')}>{claim.event_description}</Fact>
                <Fact label={t('ctrClaim.record.eventOn.label')}>{dayText(claim.event_on)}</Fact>
                <Fact label={t('ctrClaim.record.awarenessOn.label')}>{dayText(claim.awareness_on)}</Fact>
                <Fact label={t('ctrClaim.record.responsible.label')}>{claim.responsible_name ?? NONE}</Fact>
                <Fact label={t('ctrClaim.record.registeredBy.label')}>{claim.registered_by_name ?? NONE}</Fact>
                <Fact label={t('ctrClaim.record.claimed.label')} testId="claimed">
                  {claim.claimed_amount_vnd === null ? NONE : vnd(claim.claimed_amount_vnd, locale)}
                  {claim.claimed_days === null ? '' : ` · ${t('ctrClaim.record.days.text', { days: claim.claimed_days })}`}
                </Fact>
                <Fact label={t('ctrClaim.record.settled.label')} testId="settled">
                  {claim.settled_amount_vnd === null && claim.granted_days === null ? NONE : claim.settled_amount_vnd === null ? '' : vnd(claim.settled_amount_vnd, locale)}
                  {claim.granted_days === null ? '' : ` · ${t('ctrClaim.record.days.text', { days: claim.granted_days })}`}
                </Fact>
              </dl>
            </SectionCard>

            <SectionCard title={t('ctrClaim.record.term.title')}>
              {claim.term === null ? (
                <div data-testid="no-term">
                  <p>{t('ctrClaim.record.term.none.text')}</p>
                  <Link to={`${PATHS.terms}?contract=${claim.contract.id}`}>{t('ctrClaim.record.term.propose.action')}</Link>
                </div>
              ) : (
                <div data-testid="term">
                  <p>{t('ctrClaim.record.term.clause.text', { clause: claim.term.clause_reference })}</p>
                  <ul className="ctrreg-periods">
                    {periodsOf(claim.term).map((period) => (
                      <li key={period.code}>{t('ctrClaim.record.term.period.text', { step: deadlineLabel(t, period.code), days: period.days, basis: basisLabel(t, claim.term?.basis ?? 'CALENDAR_DAYS') })}</li>
                    ))}
                  </ul>
                  <p>{t('ctrClaim.record.term.effect.text', { effect: effectLabel(t, claim.term.bar_effect) })}</p>
                </div>
              )}
            </SectionCard>

            <SectionCard
              title={t('ctrClaim.record.limitation.title')}
              status={<StatePill group="limitation" state={claim.limitation.status} />}
            >
              <dl className="ctrreg-facts" data-testid="limitation">
                <Fact label={t('ctrClaim.record.limitation.nextDay.label')}>
                  {claim.limitation.due_on === null ? (
                    NONE
                  ) : (
                    <WithInfo
                      info={
                        <FigureInfo
                          name={t('ctrClaim.record.limitation.nextDay.label')}
                          formula={t('ctrClaim.figure.limitation.formula')}
                          source={t('ctrClaim.figure.limitation.source')}
                          asOf={dayText(claim.as_of)}
                          rule={claim.policy}
                        />
                      }
                    >
                      <span>{`${dayText(claim.limitation.due_on)}${claim.limitation.code === null ? '' : ` · ${deadlineLabel(t, claim.limitation.code)}`}`}</span>
                    </WithInfo>
                  )}
                </Fact>
                {claim.limitation.bar_effect !== null && <Fact label={t('ctrClaim.record.limitation.effect.label')}>{effectLabel(t, claim.limitation.bar_effect)}</Fact>}
                {claim.limitation.missed.length > 0 && <Fact label={t('ctrClaim.record.limitation.missed.label')}>{claim.limitation.missed.map((code) => deadlineLabel(t, code)).join(', ')}</Fact>}
              </dl>
            </SectionCard>

            <SectionCard title={t('ctrClaim.record.clocks.title')}>
              <ul className="ctrreg-clocks" aria-label={t('ctrClaim.record.clocks.title')}>
                {DEADLINE_CODES.map((code) => (
                  <DeadlineCard key={code} claim={claim} deadline={claim.deadlines[code]} />
                ))}
              </ul>
            </SectionCard>

            <SectionCard title={t('ctrClaim.record.actions.title')}>
              <div className="ctrreg-actions" data-testid="actions">
                {canManage && (['NOTICE', 'PARTICULARS', 'RESPONSE', 'SETTLEMENT_PROPOSAL', 'WITHDRAWAL', 'REFERRAL'] as const).map((step) => stepButton(step, claim))}
                {canSettle && claim.allowed.decide_settlement && (
                  <>
                    <button type="button" className="ui-button ui-button--primary" onClick={() => open({ kind: 'settlement', decision: 'APPROVE' })} data-testid="settlement-approve">
                      {t('ctrClaim.record.settlement.approve.action')}
                    </button>
                    <button type="button" className="ui-button ui-button--outline" onClick={() => open({ kind: 'settlement', decision: 'REJECT' })} data-testid="settlement-reject">
                      {t('ctrClaim.record.settlement.reject.action')}
                    </button>
                  </>
                )}
                {canBar && claim.allowed.declare_bar && (
                  <button type="button" className="ui-button ui-button--outline" onClick={() => open({ kind: 'bar' })} data-testid="bar-button">
                    {t('ctrClaim.record.bar.action')}
                  </button>
                )}
                {canManage && claim.allowed.link && (
                  <button type="button" className="ui-button ui-button--outline" onClick={() => open({ kind: 'links' })} data-testid="links-button">
                    {t('ctrClaim.record.links.action')}
                  </button>
                )}
              </div>
              {claim.status === 'SETTLEMENT_PROPOSED' && claim.settlement_proposed_by_name !== null && (
                <p className="sub" data-testid="proposed-by">
                  {t('ctrClaim.record.settlement.proposedBy.text', { name: claim.settlement_proposed_by_name })}
                </p>
              )}
              {claim.settlement_approved_by_name !== null && <p className="sub">{t('ctrClaim.record.settlement.approvedBy.text', { name: claim.settlement_approved_by_name })}</p>}
            </SectionCard>

            <SectionCard title={t('ctrClaim.record.links.title')}>
              <dl className="ctrreg-facts" data-testid="links">
                <Fact label={t('ctrClaim.record.links.change.label')}>{claim.change_request === null ? NONE : (claim.change_request.code ?? claim.change_request.id)}</Fact>
                <Fact label={t('ctrClaim.record.links.payment.label')}>
                  {claim.payment_request === null
                    ? NONE
                    : t('ctrClaim.record.links.payment.text', { status: claim.payment_request.status, gross: vnd(claim.payment_request.gross_vnd, locale), net: vnd(claim.payment_request.net_vnd, locale) })}
                </Fact>
              </dl>
            </SectionCard>

            <SectionCard title={t('ctrClaim.record.timeline.title')}>
              <ol className="ctrreg-timeline" data-testid="timeline" aria-label={t('ctrClaim.record.timeline.title')}>
                {claim.steps.map((step) => (
                  <li key={step.id} data-step={step.kind}>
                    <strong>{stepLabel(t, step.kind)}</strong>
                    <span className="ctrreg-day">{dayText(step.occurred_on)}</span>
                    <span className="sub">{t('ctrClaim.record.timeline.by.text', { name: step.actor_name ?? NONE, at: stampText(step.created_at) })}</span>
                    {step.decision !== null && <span>{decisionLabel(t, step.decision)}</span>}
                    {step.kind === 'TERM_BOUND' ? <p>{t('ctrClaim.record.timeline.termBound.text')}</p> : <p>{step.note}</p>}
                    {(step.claimed_amount_vnd !== null || step.claimed_days !== null) && (
                      <span>
                        {t('ctrClaim.record.timeline.claimed.text', { amount: step.claimed_amount_vnd === null ? NONE : vnd(step.claimed_amount_vnd, locale), days: step.claimed_days === null ? NONE : step.claimed_days })}
                      </span>
                    )}
                    {(step.settled_amount_vnd !== null || step.granted_days !== null) && (
                      <span>
                        {t('ctrClaim.record.timeline.settled.text', { amount: step.settled_amount_vnd === null ? NONE : vnd(step.settled_amount_vnd, locale), days: step.granted_days === null ? NONE : step.granted_days })}
                      </span>
                    )}
                  </li>
                ))}
              </ol>
            </SectionCard>
          </>
        )}
      </StateBoundary>
      {claim !== undefined && dialog !== undefined && (
        <ClaimDialogs
          claim={claim}
          dialog={dialog}
          onClose={() => setDialog(undefined)}
          onDone={(text) => {
            setReceipt(text);
            setDialog(undefined);
          }}
        />
      )}
    </section>
  );
}
