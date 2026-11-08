import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import { DataTable, MakerCheckerBadge, SectionCard, StatusPill } from '../../../ui';
import type { Tone } from '../../../ui';
import { callbackOutcomeLabel, changeStatusLabel, changeStepLabel, payeeReasonLabel, warningLabel } from '../shared/vnd-labels';
import { PATHS, countdown, dayText, maskedAccount, vietnamStamp } from '../shared/vnd-model';
import type { Account, BankEvent, PayeeChange, Policy, Verdict } from '../shared/vnd-model';
import { CountInfo, Empty, Fact, PolicyInfo, UnverifiedPill } from '../shared/vnd-ui';

const NONE = '–';

// ---- the verdict: can this contractor be paid now ----------------------------------------------------------------------------------------------------------------------

/** The red banner when payments are blocked (with the reasons in words), a plain green note when they are allowed. Colour is never the only sign: the banner says it. */
export function VerdictBanner({ verdict, policy }: { verdict: Verdict; policy: Policy }) {
  const { t } = useTranslation();
  if (!verdict.allowed) {
    return (
      <div className="vnd-block" role="alert" data-testid="payee-block">
        <strong>{t('vnd.payee.block.title')}</strong>
        <div>
          <ul data-testid="payee-block-reasons">
            {verdict.reason !== null && <li>{payeeReasonLabel(t, verdict.reason)}</li>}
            {verdict.warnings.map((warning) => (
              <li key={warning}>{warningLabel(t, warning)}</li>
            ))}
          </ul>
          <span className="vnd-row">
            <PolicyInfo name={t('vnd.payee.figure.verdict.name')} policy={policy} />
            {(verdict.unverified || policy.unverified) && <UnverifiedPill />}
          </span>
        </div>
      </div>
    );
  }
  return (
    <div className="vnd-ok" role="status" data-testid="payee-allowed">
      <strong>{t('vnd.payee.allowed.title')}</strong>
      <span>{verdict.valid_from === null ? t('vnd.payee.allowed.text') : t('vnd.payee.allowed.since.text', { day: dayText(verdict.valid_from) })}</span>
      {verdict.warnings.length > 0 && <span data-testid="payee-warnings">{verdict.warnings.map((warning) => warningLabel(t, warning)).join(' · ')}</span>}
      <PolicyInfo name={t('vnd.payee.figure.verdict.name')} policy={policy} />
      {(verdict.unverified || policy.unverified) && <UnverifiedPill />}
    </div>
  );
}

// ---- the account in force --------------------------------------------------------------------------------------------------------------------------------------------------

/**
 * The account the contractor is paid on, as a masked number only. While the waiting period runs the screen counts what is left against the moment of the answer (never this machine's clock); a payment is blocked until it ends.
 * An account that no longer holds is listed under the one in force, with the day it ended.
 */
export function AccountsCard({ accounts, asOf, policy, canClose, onClose }: { accounts: Account[]; asOf: string; policy: Policy; canClose: boolean; onClose: (account: Account) => void }) {
  const { t } = useTranslation();
  const active = accounts.find((account) => account.state === 'ACTIVE');
  const others = accounts.filter((account) => account.state !== 'ACTIVE');
  const wait = active === undefined ? undefined : countdown(active.effective_after, asOf);
  return (
    <SectionCard title={t('vnd.payee.section.account.title')} status={policy.unverified ? <UnverifiedPill /> : undefined}>
      {active === undefined ? (
        <Empty text={t('vnd.payee.account.none.text')} testId="account-none" />
      ) : (
        <dl className="vnd-facts" data-testid="active-account">
          <Fact label={t('vnd.payee.change.bank.label')} testId="account-bank">
            {active.bank_name}
          </Fact>
          <Fact label={t('vnd.payee.change.holder.label')} testId="account-holder">
            {active.account_holder}{' '}
            <StatusPill tone={active.holder_matches_legal_name ? 'success' : 'danger'} icon={active.holder_matches_legal_name ? '✓' : '⛔'}>
              {active.holder_matches_legal_name ? t('vnd.payee.holder.matches') : t('vnd.payee.holder.differs')}
            </StatusPill>
          </Fact>
          <Fact label={t('vnd.payee.change.number.label')} testId="account-number">
            <code>{maskedAccount(active.account_no_masked)}</code>
          </Fact>
          <Fact label={t('vnd.payee.account.waiting.label')} testId="account-waiting">
            {wait === undefined || wait.done ? (
              <StatusPill tone="success" icon="✓">
                {t('vnd.payee.account.inForce.text', { time: vietnamStamp(active.effective_after) })}
              </StatusPill>
            ) : (
              <span className="vnd-row">
                <StatusPill tone="warning" icon="◔">
                  {t('vnd.payee.account.countdown.text', { days: wait.days, hours: wait.hours })}
                </StatusPill>
                <span>{t('vnd.payee.account.until.text', { time: vietnamStamp(active.effective_after) })}</span>
                <CountInfo name={t('vnd.payee.figure.waiting.name')} formula={t('vnd.payee.figure.waiting.formula')} source={t('vnd.payee.figure.waiting.source')} asOf={asOf} unverified={policy.unverified} />
              </span>
            )}
          </Fact>
        </dl>
      )}
      {active !== undefined && canClose && (
        <p>
          <button type="button" className="ui-button ui-button--outline" data-testid="close-account" onClick={() => onClose(active)}>
            {t('vnd.payee.close.action')}
          </button>
        </p>
      )}
      {others.length > 0 && (
        <DataTable<Account>
          caption={t('vnd.payee.account.history.caption')}
          rows={others}
          rowKey={(row) => row.id}
          columns={[
            { key: 'bank', header: t('vnd.payee.change.bank.label'), pinned: true, render: (row) => row.bank_name },
            { key: 'number', header: t('vnd.payee.change.number.label'), render: (row) => <code>{maskedAccount(row.account_no_masked)}</code> },
            { key: 'state', header: t('vnd.payee.account.state.label'), render: (row) => (row.state === 'SUPERSEDED' ? t('vnd.payee.account.superseded.text', { day: dayText(row.superseded_at) }) : t('vnd.payee.account.closed.text', { reason: row.closed_reason ?? NONE })) },
          ]}
        />
      )}
    </SectionCard>
  );
}

// ---- a change request: three steps ----------------------------------------------------------------------------------------------------------------------------------

const STATUS_TONE: Readonly<Record<PayeeChange['status'], Tone>> = { REQUESTED: 'info', ACTIVATED: 'success', REJECTED: 'danger', CANCELLED: 'neutral', EXPIRED: 'neutral' };

interface Step {
  code: 'CONTRACT_MATCH' | 'ACCOUNT_MATCH' | 'CALLBACK';
  done: boolean;
  who: string | null;
  at: string | null;
  note: string | null;
  detail?: string | null;
}

function stepsOf(change: PayeeChange, t: ReturnType<typeof useTranslation>['t']): Step[] {
  const callbackDone = change.callback_at !== null;
  return [
    { code: 'CONTRACT_MATCH', done: change.contract_match_at !== null, who: change.contract_match_by_name, at: change.contract_match_at, note: change.contract_match_note },
    { code: 'ACCOUNT_MATCH', done: change.account_match_at !== null, who: change.account_match_by_name, at: change.account_match_at, note: change.account_match_note },
    {
      code: 'CALLBACK',
      done: callbackDone,
      who: change.callback_by_name,
      at: change.callback_at,
      note: change.callback_note,
      detail:
        callbackDone && change.callback_outcome !== null
          ? `${callbackOutcomeLabel(t, change.callback_outcome)}${change.callback_number_last4 === null ? '' : ` · ${t('vnd.payee.callback.last4.text', { last4: change.callback_number_last4 })}`}`
          : null,
    },
  ];
}

export interface ChangeCardProps {
  change: PayeeChange;
  focus: boolean;
  showContractor: boolean;
  canAct: boolean;
  onApprove: (change: PayeeChange, role: 'CONTRACT_MATCH' | 'ACCOUNT_MATCH') => void;
  onCallback: (change: PayeeChange) => void;
  onCancel: (change: PayeeChange) => void;
  onReject: (change: PayeeChange) => void;
}

/**
 * A request to change the account, with who asked and what is left. The three steps (the contract matches, the account matches, the call-back) are said one by one with who did them and when; a step that is waiting offers its
 * button only to the person the answer says may do it. The number is masked here as everywhere.
 */
export function ChangeCard({ change, focus, showContractor, canAct, onApprove, onCallback, onCancel, onReject }: ChangeCardProps) {
  const { t } = useTranslation();
  const steps = stepsOf(change, t);
  const open = change.status === 'REQUESTED';
  return (
    <article className="vnd-change" data-testid="change" data-change-id={change.id} data-status={change.status} data-focus={focus ? 'true' : 'false'}>
      <header className="vnd-row">
        <StatusPill tone={STATUS_TONE[change.status]}>{changeStatusLabel(t, change.status)}</StatusPill>
        <strong>{change.bank_name}</strong>
        <code data-testid="change-number">{maskedAccount(change.account_no_masked)}</code>
        {showContractor && <Link to={PATHS.payee(change.contractor_id)}>{change.contractor_name}</Link>}
      </header>
      <dl className="vnd-facts">
        <Fact label={t('vnd.payee.change.holder.label')} testId="change-holder">
          {change.account_holder}{' '}
          <StatusPill tone={change.holder_matches_legal_name ? 'success' : 'danger'} icon={change.holder_matches_legal_name ? '✓' : '⛔'}>
            {change.holder_matches_legal_name ? t('vnd.payee.holder.matches') : t('vnd.payee.holder.differs')}
          </StatusPill>
        </Fact>
        <Fact label={t('vnd.payee.change.reason.label')} testId="change-reason">
          {change.reason}
        </Fact>
        <Fact label={t('vnd.payee.change.requested.label')} testId="change-requested">
          <span className="vnd-stack">
            <span>{t('vnd.payee.change.requestedAt.text', { name: change.requested_by_name ?? NONE, time: vietnamStamp(change.requested_at) })}</span>
            <MakerCheckerBadge maker={change.requested_by_name ?? NONE} checker={change.callback_by_name ?? change.account_match_by_name ?? change.contract_match_by_name} />
          </span>
        </Fact>
        <Fact label={t('vnd.payee.change.evidence.label')} testId="change-evidence">
          <code>{change.evidence_document_id}</code>
        </Fact>
        <Fact label={t('vnd.payee.change.expires.label')} testId="change-expires">
          {vietnamStamp(change.expires_at)}
        </Fact>
        {change.closed_at !== null && (
          <Fact label={t('vnd.payee.change.closed.label')} testId="change-closed">
            {t('vnd.payee.change.closedAt.text', { time: vietnamStamp(change.closed_at), reason: change.closed_reason ?? NONE })}
          </Fact>
        )}
      </dl>
      <ol className="vnd-steps" aria-label={t('vnd.payee.steps.label')}>
        {steps.map((step) => (
          <li className="vnd-step" key={step.code} data-step={step.code} data-done={step.done ? 'true' : 'false'}>
            <strong>{changeStepLabel(t, step.code)}</strong>
            {step.done ? (
              <>
                <StatusPill tone="success" icon="✓">
                  {t('vnd.payee.step.done.text')}
                </StatusPill>
                <span className="vnd-step__who">{t('vnd.payee.step.by.text', { name: step.who ?? NONE, time: step.at === null ? NONE : vietnamStamp(step.at) })}</span>
                {step.detail !== undefined && step.detail !== null && <span className="vnd-step__who">{step.detail}</span>}
                {step.note !== null && <span className="vnd-step__who">{step.note}</span>}
              </>
            ) : (
              <>
                <StatusPill tone={open ? 'warning' : 'neutral'} icon={open ? '◔' : '○'}>
                  {open ? t('vnd.payee.step.waiting.text') : t('vnd.payee.step.skipped.text')}
                </StatusPill>
                {open && canAct && step.code === 'CONTRACT_MATCH' && change.may_approve_contract_match && (
                  <button type="button" className="ui-button ui-button--primary ui-button--small" data-testid="approve-contract" onClick={() => onApprove(change, 'CONTRACT_MATCH')}>
                    {t('vnd.payee.approve.action')}
                  </button>
                )}
                {open && canAct && step.code === 'ACCOUNT_MATCH' && change.may_approve_account_match && (
                  <button type="button" className="ui-button ui-button--primary ui-button--small" data-testid="approve-account" onClick={() => onApprove(change, 'ACCOUNT_MATCH')}>
                    {t('vnd.payee.approve.action')}
                  </button>
                )}
                {open && canAct && step.code === 'CALLBACK' && change.may_callback && (
                  <button type="button" className="ui-button ui-button--primary ui-button--small" data-testid="record-callback" onClick={() => onCallback(change)}>
                    {t('vnd.payee.callback.action')}
                  </button>
                )}
              </>
            )}
          </li>
        ))}
      </ol>
      {open && canAct && (change.may_cancel || change.may_reject) && (
        <p className="vnd-row">
          {change.may_cancel && (
            <button type="button" className="ui-button ui-button--outline ui-button--small" data-testid="cancel-change" onClick={() => onCancel(change)}>
              {t('vnd.payee.cancel.action')}
            </button>
          )}
          {change.may_reject && (
            <button type="button" className="ui-button ui-button--outline ui-button--small" data-testid="reject-change" onClick={() => onReject(change)}>
              {t('vnd.payee.reject.action')}
            </button>
          )}
        </p>
      )}
    </article>
  );
}

// ---- the chain log ------------------------------------------------------------------------------------------------------------------------------------------------------------

export function ChainLog({ events }: { events: BankEvent[] }) {
  const { t } = useTranslation();
  return (
    <SectionCard title={t('vnd.payee.section.log.title')}>
      {events.length === 0 ? (
        <Empty text={t('vnd.payee.log.empty.text')} testId="log-empty" />
      ) : (
        <DataTable<BankEvent>
          caption={t('vnd.payee.log.caption')}
          rows={events}
          rowKey={(row) => row.id}
          rowAttrs={(row) => ({ 'data-event-id': row.id })}
          columns={[
            { key: 'at', header: t('vnd.payee.log.column.at'), pinned: true, render: (row) => vietnamStamp(row.occurred_at) },
            { key: 'action', header: t('vnd.payee.log.column.action'), render: (row) => row.action },
            { key: 'who', header: t('vnd.payee.log.column.who'), render: (row) => row.actor_name ?? t('vnd.payee.log.system.text') },
            { key: 'note', header: t('vnd.payee.log.column.note'), render: (row) => row.note ?? NONE },
          ]}
        />
      )}
    </SectionCard>
  );
}
