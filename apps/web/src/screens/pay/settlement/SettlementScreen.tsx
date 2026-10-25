import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { Fact } from '../../ctr/components';
import { instantText } from '../model';
import { useSettlement, useSettlements } from './hooks';
import { groupLabel, scopeLabel, statusLabel, urgencyLabel } from './labels';
import { CloseDialog, ExceptionDialog, OpenDialog, RefreshDialog, SubmitDialog, VerifyDialog } from './SettlementDialogs';
import { FINDINGS_PERMISSION, OPEN_PERMISSION, READ_PERMISSION, STATUSES, daysLeft, owes, settlementLink, urgencyOf, vietnamDay, vndText } from './model';
import type { Answer, Outcome, Settlement } from './model';
import '../pay.css';

type Dialog = { kind: 'open' } | { kind: 'refresh' } | { kind: 'submit' } | { kind: 'verify'; outcome: Outcome } | { kind: 'exception' } | { kind: 'close' };

/**
 * PAY-15: the settlement of a project, of a year or of a contract (ST-PAY-009, PAY 3.5). The settlements of the caller are listed with their figures (what was settled, what is still owed, what advance
 * is not recovered) and the verification deadline in days; one is picked to read in full and to work on. A draft is read again from the ledgers and sent, the deadline following the group of the project
 * on the day of the submission; another person takes the file up and verifies it or gives it back with the findings; with something still owed, an exception approved by a third person is what lets it
 * close, and the figures stay as they are. Every button is shown for exactly what the server says the caller may do.
 */
export default function SettlementScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The workspace belongs to one membership: a switch of tenant or of membership starts the screen over.
  return <SettlementContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function SettlementContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { permissions, mode } = useSession();
  const holds = (permission: string): boolean => permissions === undefined || permissions.includes(permission);
  const mayRead = holds(READ_PERMISSION);
  const mayOpen = holds(OPEN_PERMISSION) && mode !== 'READ_ONLY';
  const writable = mode !== 'READ_ONLY';
  const [search, setSearch] = useSearchParams();
  const picked = search.get('settlement');
  const [status, setStatus] = useState('');
  const list = useSettlements(status === '' ? null : status, mayRead);
  const detail = useSettlement(picked, mayRead && picked !== null);
  const [dialog, setDialog] = useState<Dialog | undefined>(undefined);
  const [done, setDone] = useState<string | undefined>(undefined);
  const today = vietnamDay(new Date());
  const state = useScreenState({ isLoading: list.isLoading, error: list.error, data: list.data, isEmpty: () => false });
  const current = detail.data ?? undefined;

  const finish = (message: string, answer: Answer | undefined): void => {
    setDone(message);
    setDialog(undefined);
    if (answer !== undefined) setSearch({ settlement: answer.id });
  };
  const money = (value: string): string => vndText(value, locale);

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('pay.settlement.title')}</h1>
          <p>{t('pay.settlement.subtitle')}</p>
        </div>
        {mayOpen ? (
          <button type="button" className="primary" data-action="open" onClick={() => setDialog({ kind: 'open' })}>
            {t('pay.settlement.action.open')}
          </button>
        ) : null}
      </div>
      {done === undefined ? null : (
        <p className="callout" role="status" data-testid="done">
          {done}
        </p>
      )}
      {!mayRead ? (
        <p className="callout" role="status" data-testid="no-read">
          {t('pay.settlement.read.denied')}
        </p>
      ) : (
        <>
          <article className="card" aria-label={t('pay.settlement.list.title')}>
            <h2>{t('pay.settlement.list.title')}</h2>
            <div className="field">
              <label htmlFor="settlement-status">{t('pay.settlement.filter.status')}</label>
              <select id="settlement-status" value={status} onChange={(event) => setStatus(event.target.value)}>
                <option value="">{t('pay.settlement.filter.all')}</option>
                {STATUSES.map((value) => (
                  <option key={value} value={value}>
                    {statusLabel(t, value)}
                  </option>
                ))}
              </select>
            </div>
            <StateBoundary state={state} onRetry={() => void list.refetch()}>
              {(list.data ?? []).length === 0 ? (
                <p className="sub" role="status" data-testid="none">
                  {t('pay.settlement.list.empty')}
                </p>
              ) : (
                <table className="table" data-testid="settlements">
                  <thead>
                    <tr>
                      <th scope="col">{t('pay.settlement.column.project')}</th>
                      <th scope="col">{t('pay.settlement.column.scope')}</th>
                      <th scope="col">{t('pay.settlement.column.status')}</th>
                      <th scope="col">{t('pay.settlement.column.group')}</th>
                      <th scope="col" className="pay-amount">
                        {t('pay.settlement.column.settled')}
                      </th>
                      <th scope="col" className="pay-amount">
                        {t('pay.settlement.column.outstanding')}
                      </th>
                      <th scope="col" className="pay-amount">
                        {t('pay.settlement.column.unrecovered')}
                      </th>
                      <th scope="col">{t('pay.settlement.column.due')}</th>
                      <th scope="col">{t('pay.settlement.column.actions')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(list.data ?? []).map((row) => (
                      <SettlementRow key={row.id} row={row} today={today} picked={row.id === picked} money={money} />
                    ))}
                  </tbody>
                </table>
              )}
            </StateBoundary>
          </article>
          {picked === null ? (
            <p className="sub" role="status" data-testid="pick">
              {t('pay.settlement.pick')}
            </p>
          ) : detail.isLoading ? null : detail.isError ? (
            <p className="callout warning" role="alert" data-testid="detail-failed">
              {t('pay.settlement.detail.failed')}
            </p>
          ) : current === undefined ? (
            <p className="callout" role="status" data-testid="detail-missing">
              {t('pay.settlement.detail.missing')}
            </p>
          ) : (
            <Detail settlement={current} today={today} writable={writable} money={money} onDialog={setDialog} />
          )}
        </>
      )}
      {dialog?.kind === 'open' ? <OpenDialog onClose={() => setDialog(undefined)} onDone={(answer) => finish(t('pay.settlement.done.opened'), answer)} /> : null}
      {current !== undefined && dialog?.kind === 'refresh' ? (
        <RefreshDialog settlement={current} onClose={() => setDialog(undefined)} onDone={(answer) => finish(t('pay.settlement.done.refreshed'), answer)} />
      ) : null}
      {current !== undefined && dialog?.kind === 'submit' ? (
        <SubmitDialog settlement={current} today={today} onClose={() => setDialog(undefined)} onDone={(answer) => finish(t('pay.settlement.done.submitted'), answer)} />
      ) : null}
      {current !== undefined && dialog?.kind === 'verify' ? (
        <VerifyDialog
          settlement={current}
          outcome={dialog.outcome}
          mayCiteFindings={holds(FINDINGS_PERMISSION)}
          onClose={() => setDialog(undefined)}
          onDone={(answer) => finish(verifyDone(t, dialog.outcome), answer)}
        />
      ) : null}
      {current !== undefined && dialog?.kind === 'exception' ? (
        <ExceptionDialog settlement={current} onClose={() => setDialog(undefined)} onDone={(answer) => finish(t('pay.settlement.done.exception'), answer)} />
      ) : null}
      {current !== undefined && dialog?.kind === 'close' ? (
        <CloseDialog settlement={current} onClose={() => setDialog(undefined)} onDone={(answer) => finish(t('pay.settlement.done.closed'), answer)} />
      ) : null}
      <p className="prototype-note">{t('pay.settlement.footer', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function verifyDone(t: ReturnType<typeof useTranslation>['t'], outcome: Outcome): string {
  switch (outcome) {
    case 'VERIFYING':
      return t('pay.settlement.done.verifying');
    case 'VERIFIED':
      return t('pay.settlement.done.verified');
    case 'RETURNED':
      return t('pay.settlement.done.returned');
  }
}

interface RowProps {
  row: Settlement;
  today: string;
  picked: boolean;
  money(value: string): string;
}

function SettlementRow({ row, today, picked, money }: RowProps) {
  const { t } = useTranslation();
  const urgency = urgencyOf(row, today);
  const left = row.verificationDueOn === null ? undefined : daysLeft(row.verificationDueOn, today);
  return (
    <tr data-settlement={row.id} data-picked={picked ? 'yes' : 'no'}>
      <td data-testid="project">{row.projectCode}</td>
      <td data-testid="scope">
        {scopeLabel(t, row.scope)}
        {row.fiscalYear === null ? '' : ` ${row.fiscalYear}`}
        {row.contractCode === null ? '' : ` ${row.contractCode}`}
        {row.revision > 1 ? ` · ${t('pay.settlement.revision', { revision: row.revision })}` : ''}
      </td>
      <td data-testid="status">{statusLabel(t, row.status)}</td>
      <td data-testid="group">{row.projectGroup === null ? '' : groupLabel(t, row.projectGroup)}</td>
      <td className="pay-amount" data-testid="settled">
        {money(row.settledVnd)}
      </td>
      <td className="pay-amount" data-testid="outstanding">
        {money(row.outstandingVnd)}
      </td>
      <td className="pay-amount" data-testid="unrecovered">
        {money(row.unrecoveredAdvanceVnd)}
      </td>
      <td data-testid="due" data-urgency={urgency ?? 'none'}>
        {row.verificationDueOn === null ? '' : row.verificationDueOn}
        {urgency === undefined || left === undefined ? null : (
          <span className={urgency === 'later' ? 'pay-badge' : 'pay-badge warning'} data-testid="days-left">
            {urgencyLabel(t, urgency, left)}
          </span>
        )}
      </td>
      <td>
        <Link to={settlementLink(row.id)} data-testid="open">
          {t('pay.settlement.action.pick')}
        </Link>
      </td>
    </tr>
  );
}

interface DetailProps {
  settlement: Settlement;
  today: string;
  writable: boolean;
  money(value: string): string;
  onDialog(dialog: Dialog): void;
}

function Detail({ settlement, today, writable, money, onDialog }: DetailProps) {
  const { t, locale } = useTranslation();
  const { actions } = settlement;
  const urgency = urgencyOf(settlement, today);
  const left = settlement.verificationDueOn === null ? undefined : daysLeft(settlement.verificationDueOn, today);
  const debt = owes(settlement);
  return (
    <article className="card" aria-label={t('pay.settlement.detail.title')} data-testid="detail" data-status={settlement.status}>
      <h2>{t('pay.settlement.detail.title')}</h2>
      <dl className="pay-facts">
        <Fact label={t('pay.settlement.fact.project')}>
          <span data-testid="fact-project">{settlement.projectCode}</span> {settlement.projectName}
        </Fact>
        <Fact label={t('pay.settlement.fact.scope')}>
          <span data-testid="fact-scope">{scopeLabel(t, settlement.scope)}</span>
          {settlement.fiscalYear === null ? '' : ` ${settlement.fiscalYear}`}
          {settlement.contractCode === null ? '' : ` ${settlement.contractCode}`}
        </Fact>
        <Fact label={t('pay.settlement.fact.revision')}>
          <span data-testid="fact-revision">{settlement.revision}</span>
        </Fact>
        <Fact label={t('pay.settlement.fact.status')}>
          <span data-testid="fact-status">{statusLabel(t, settlement.status)}</span>
        </Fact>
        <Fact label={t('pay.settlement.fact.settled')}>
          <span data-testid="fact-settled">{money(settlement.settledVnd)}</span>
        </Fact>
        <Fact label={t('pay.settlement.fact.outstanding')}>
          <span data-testid="fact-outstanding">{money(settlement.outstandingVnd)}</span>
        </Fact>
        <Fact label={t('pay.settlement.fact.unrecovered')}>
          <span data-testid="fact-unrecovered">{money(settlement.unrecoveredAdvanceVnd)}</span>
        </Fact>
        <Fact label={t('pay.settlement.fact.figures')}>
          <span data-testid="fact-figures">{instantText(settlement.figuresRefreshedAt, locale)}</span>
          {settlement.figuresNote === null ? null : <span data-testid="fact-note"> · {settlement.figuresNote}</span>}
        </Fact>
        <Fact label={t('pay.settlement.fact.group')}>
          <span data-testid="fact-group">{settlement.projectGroup === null ? t('pay.settlement.fact.none') : groupLabel(t, settlement.projectGroup)}</span>
        </Fact>
        <Fact label={t('pay.settlement.fact.submitted')}>
          <span data-testid="fact-submitted">{settlement.submittedOn ?? t('pay.settlement.fact.none')}</span>
        </Fact>
        <Fact label={t('pay.settlement.fact.deadline')}>
          <span data-testid="fact-deadline">{settlement.verificationDueOn ?? t('pay.settlement.fact.none')}</span>
          {settlement.deadlineDays === null ? null : <span data-testid="fact-days"> · {t('pay.settlement.fact.days', { days: settlement.deadlineDays })}</span>}
          {urgency === undefined || left === undefined ? null : (
            <span className={urgency === 'later' ? 'pay-badge' : 'pay-badge warning'} data-testid="fact-urgency">
              {urgencyLabel(t, urgency, left)}
            </span>
          )}
        </Fact>
        {settlement.ruleAwaitingConfirmation === true ? (
          <Fact label={t('pay.settlement.fact.rule')}>
            <span data-testid="fact-rule">{t('pay.settlement.fact.rule.awaiting')}</span>
          </Fact>
        ) : null}
        {settlement.verifiedOn === null ? null : (
          <Fact label={t('pay.settlement.fact.verified')}>
            <span data-testid="fact-verified">{settlement.verifiedOn}</span>
          </Fact>
        )}
        {settlement.verificationFindings === null ? null : (
          <Fact label={t('pay.settlement.fact.findings')}>
            <span data-testid="fact-findings">{settlement.verificationFindings}</span>
          </Fact>
        )}
        {settlement.auditFindingRefs === null || settlement.auditFindingRefs.length === 0 ? null : (
          <Fact label={t('pay.settlement.fact.refs')}>
            <span className="pay-key" data-testid="fact-refs">
              {settlement.auditFindingRefs.join(', ')}
            </span>
          </Fact>
        )}
        {settlement.exceptionApprovedAt === null ? null : (
          <Fact label={t('pay.settlement.fact.exception')}>
            <span data-testid="fact-exception">{settlement.exceptionReason}</span>
          </Fact>
        )}
        {settlement.closedAt === null ? null : (
          <Fact label={t('pay.settlement.fact.closed')}>
            <span data-testid="fact-closed">{instantText(settlement.closedAt, locale)}</span>
            {settlement.closeReason === null ? null : <span> · {settlement.closeReason}</span>}
          </Fact>
        )}
      </dl>
      {debt && settlement.status === 'VERIFIED' && settlement.exceptionApprovedAt === null ? (
        <p className="callout warning" role="status" data-testid="owes">
          {t('pay.settlement.owes.callout')}
        </p>
      ) : null}
      {writable ? (
        <div className="pay-row-actions">
          {actions.refresh ? (
            <button type="button" data-action="refresh" onClick={() => onDialog({ kind: 'refresh' })}>
              {t('pay.settlement.action.refresh')}
            </button>
          ) : null}
          {actions.submit ? (
            <button type="button" className="primary" data-action="submit" onClick={() => onDialog({ kind: 'submit' })}>
              {t('pay.settlement.action.submit')}
            </button>
          ) : null}
          {actions.takeUp ? (
            <button type="button" data-action="take-up" onClick={() => onDialog({ kind: 'verify', outcome: 'VERIFYING' })}>
              {t('pay.settlement.action.takeUp')}
            </button>
          ) : null}
          {actions.verify ? (
            <button type="button" className="primary" data-action="verify" onClick={() => onDialog({ kind: 'verify', outcome: 'VERIFIED' })}>
              {t('pay.settlement.action.verify')}
            </button>
          ) : null}
          {actions.returnBack ? (
            <button type="button" data-action="return" onClick={() => onDialog({ kind: 'verify', outcome: 'RETURNED' })}>
              {t('pay.settlement.action.return')}
            </button>
          ) : null}
          {actions.approveException ? (
            <button type="button" data-action="exception" onClick={() => onDialog({ kind: 'exception' })}>
              {t('pay.settlement.action.exception')}
            </button>
          ) : null}
          {actions.close ? (
            <button type="button" className="primary" data-action="close" onClick={() => onDialog({ kind: 'close' })}>
              {t('pay.settlement.action.close')}
            </button>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
