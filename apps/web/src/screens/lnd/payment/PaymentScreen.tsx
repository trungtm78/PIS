import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { useHouseholds } from '../household/hooks';
import { todayInVietnam } from '../model';
import { usePlans } from '../plan/hooks';
import { planStatusLabel } from '../plan/labels';
import { formatVnd } from '../plan/model';
import type { PlanLine } from '../plan/model';
import { useProjectOptions } from '../read-hooks';
import { ConfirmDialog, DepositDialog, ScheduleDialog } from './dialogs';
import { usePayments } from './hooks';
import { paymentMethodLabel, paymentStatusLabel } from './labels';
import { canPayWrite, daysToDue, isOpen, payablePlans, takesPayments, totalsOf } from './model';
import type { PaymentLine } from './model';
import '../lnd.css';

type Dialog = { kind: 'schedule'; plan: PlanLine } | { kind: 'confirm'; plan: PlanLine; payment: PaymentLine } | { kind: 'deposit'; plan: PlanLine; payment: PaymentLine };

/**
 * LND-07: the payments of an approved plan to its households (ST-LND-007, BR-LND-03, UAT-AC378, UAT-AC383). The plans of a project that were approved are listed; the one that is open shows what is scheduled and
 * what is settled of what the plan holds and each payment with the day it is due, how it was made, its voucher and the advance it settled. A payment is made inside the 30 days that follow the approval and one made
 * after them says why; money a household does not take is deposited. The payments are read inside the units of the reader, and the account only masked. The server judges every request again.
 */
export default function PaymentScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The plans and the dialogs belong to one membership: a switch of tenant or of membership starts the screen over.
  return <PaymentContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function PaymentContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const [params, setParams] = useSearchParams();
  const projectId = params.get('project') ?? undefined;
  const planId = params.get('plan') ?? undefined;
  const today = todayInVietnam();
  const projects = useProjectOptions();
  const plans = usePlans(projectId);
  const mayWrite = canPayWrite(permissions, mode);
  const households = useHouseholds(mayWrite && projectId !== undefined ? projectId : undefined);
  const [dialog, setDialog] = useState<Dialog | undefined>(undefined);
  const shown = useMemo(() => payablePlans(plans.data ?? []), [plans.data]);
  const selected = shown.find((plan) => plan.id === planId);
  const payments = usePayments(selected?.id);
  const state = useScreenState({ isLoading: plans.isLoading, error: plans.error, data: plans.data, isEmpty: () => false });
  const totals = totalsOf(payments.data ?? []);

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('lnd.payments.page.title')}</h1>
          <p>{t('lnd.payments.page.subtitle')}</p>
        </div>
      </div>
      <p className="callout" data-testid="privacy-note">
        {t('lnd.payments.privacy.note')}
      </p>
      <div className="card">
        <div className="field">
          <label htmlFor="payments-project">{t('lnd.payments.project.label')}</label>
          <select id="payments-project" value={projectId ?? ''} onChange={(event) => setParams(event.target.value === '' ? {} : { project: event.target.value })}>
            <option value="">{t('lnd.payments.project.choose')}</option>
            {(projects.data ?? []).map((project) => (
              <option key={project.id} value={project.id}>
                {`${project.code} · ${project.name}`}
              </option>
            ))}
          </select>
        </div>
      </div>
      {projectId === undefined ? (
        <p className="callout" role="status" data-testid="choose-project">
          {t('lnd.payments.project.notice')}
        </p>
      ) : (
        <StateBoundary state={state} onRetry={() => void plans.refetch()}>
          <div className="card">
            {shown.length === 0 ? (
              <p className="callout" role="status" data-testid="no-plans">
                {t('lnd.payments.empty.notice')}
              </p>
            ) : (
              <table className="table" data-testid="plans">
                <thead>
                  <tr>
                    <th scope="col">{t('lnd.payments.column.code')}</th>
                    <th scope="col">{t('lnd.payments.column.revision')}</th>
                    <th scope="col">{t('lnd.payments.column.grand')}</th>
                    <th scope="col">{t('lnd.payments.column.status')}</th>
                    <th scope="col">{t('lnd.payments.column.approved')}</th>
                    <th scope="col">{t('lnd.payments.column.due')}</th>
                    <th scope="col">{t('lnd.payments.column.action')}</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((plan) => (
                    <tr key={plan.id} data-plan-id={plan.id} aria-selected={plan.id === selected?.id}>
                      <th scope="row">{plan.planCode}</th>
                      <td data-testid="revision">{plan.revision}</td>
                      <td className="lnd-numeric" data-testid="total-grand">
                        {formatVnd(plan.grandTotalVnd)}
                      </td>
                      <td>
                        <span className="lnd-badge" data-testid="status">
                          {planStatusLabel(t, plan.status)}
                        </span>
                      </td>
                      <td data-testid="approved">{plan.approvedOn ?? t('lnd.payments.value.none')}</td>
                      <td data-testid="due">{plan.paymentDueOn ?? t('lnd.payments.value.none')}</td>
                      <td>
                        <button type="button" className="button" aria-label={t('lnd.payments.open.aria', { code: plan.planCode, revision: plan.revision })} onClick={() => setParams({ project: projectId, plan: plan.id })}>
                          {t('lnd.payments.open.action')}
                        </button>
                        {mayWrite && takesPayments(plan) ? (
                          <button type="button" className="button" aria-label={t('lnd.payments.schedule.aria', { code: plan.planCode, revision: plan.revision })} onClick={() => setDialog({ kind: 'schedule', plan })}>
                            {t('lnd.payments.schedule.action')}
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          {selected === undefined ? null : (
            <div className="card" data-testid="payment-detail">
              <h2>{t('lnd.payments.detail.title', { code: selected.planCode, revision: selected.revision })}</h2>
              <div className="lnd-tiles">
                <div className="lnd-tile" data-testid="tile-plan">
                  <span>{t('lnd.payments.tile.plan')}</span>
                  <strong>{formatVnd(selected.grandTotalVnd)}</strong>
                </div>
                <div className="lnd-tile" data-testid="tile-scheduled">
                  <span>{t('lnd.payments.tile.scheduled')}</span>
                  <strong>{formatVnd(totals.scheduled.toString())}</strong>
                </div>
                <div className="lnd-tile" data-testid="tile-settled">
                  <span>{t('lnd.payments.tile.settled')}</span>
                  <strong>{formatVnd(totals.settled.toString())}</strong>
                </div>
                <div className="lnd-tile" data-testid="tile-pending">
                  <span>{t('lnd.payments.tile.pending')}</span>
                  <strong>{formatVnd(totals.pending.toString())}</strong>
                </div>
              </div>
              <p className="sub">{t('lnd.payments.tile.note')}</p>
              {payments.isError ? (
                <p className="callout warning" role="alert" data-testid="payments-failed">
                  {t('lnd.payments.list.failed')}
                </p>
              ) : payments.isLoading ? (
                <p role="status">{t('lnd.payments.list.loading')}</p>
              ) : (payments.data ?? []).length === 0 ? (
                <p className="callout" role="status" data-testid="payments-empty">
                  {t('lnd.payments.list.empty')}
                </p>
              ) : (
                <table className="table" data-testid="payments">
                  <thead>
                    <tr>
                      <th scope="col">{t('lnd.payments.paymentColumn.household')}</th>
                      <th scope="col">{t('lnd.payments.paymentColumn.amount')}</th>
                      <th scope="col">{t('lnd.payments.paymentColumn.due')}</th>
                      <th scope="col">{t('lnd.payments.paymentColumn.paid')}</th>
                      <th scope="col">{t('lnd.payments.paymentColumn.method')}</th>
                      <th scope="col">{t('lnd.payments.paymentColumn.voucher')}</th>
                      <th scope="col">{t('lnd.payments.paymentColumn.advance')}</th>
                      <th scope="col">{t('lnd.payments.paymentColumn.status')}</th>
                      <th scope="col">{t('lnd.payments.paymentColumn.action')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(payments.data ?? []).map((payment) => (
                      <PaymentRow
                        key={payment.id}
                        payment={payment}
                        today={today}
                        canPay={mayWrite && isOpen(payment) && takesPayments(selected)}
                        onConfirm={() => setDialog({ kind: 'confirm', plan: selected, payment })}
                        onDeposit={() => setDialog({ kind: 'deposit', plan: selected, payment })}
                      />
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </StateBoundary>
      )}
      {dialog?.kind === 'schedule' ? <ScheduleDialog plan={dialog.plan} households={households.data ?? []} onClose={() => setDialog(undefined)} /> : null}
      {dialog?.kind === 'confirm' ? <ConfirmDialog plan={dialog.plan} payment={dialog.payment} today={today} onClose={() => setDialog(undefined)} /> : null}
      {dialog?.kind === 'deposit' ? <DepositDialog plan={dialog.plan} payment={dialog.payment} today={today} onClose={() => setDialog(undefined)} /> : null}
      <p className="prototype-note">{t('lnd.payments.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

interface RowProps {
  payment: PaymentLine;
  today: string;
  canPay: boolean;
  onConfirm(): void;
  onDeposit(): void;
}

function PaymentRow({ payment, today, canPay, onConfirm, onDeposit }: RowProps) {
  const { t } = useTranslation();
  const none = t('lnd.payments.value.none');
  const left = daysToDue(payment, today);
  return (
    <tr data-payment-id={payment.id}>
      <th scope="row">{t('lnd.payments.paymentRow.household', { code: payment.householdCode, number: payment.paymentNo })}</th>
      <td className="lnd-numeric" data-testid="amount">
        {formatVnd(payment.amountVnd)}
      </td>
      <td data-testid="due">
        {payment.dueOn}
        {isOpen(payment) ? (
          <>
            <br />
            <small className={left < 0 ? 'sub lnd-late' : 'sub'} data-testid="left">
              {left < 0 ? t('lnd.payments.due.late', { days: -left }) : t('lnd.payments.due.left', { days: left })}
            </small>
          </>
        ) : null}
      </td>
      <td data-testid="paid">
        {payment.paidOn ?? none}
        {payment.lateReason === null ? null : (
          <>
            <br />
            <small className="sub" data-testid="late-reason">
              {t('lnd.payments.paymentRow.late', { reason: payment.lateReason })}
            </small>
          </>
        )}
      </td>
      <td data-testid="method">
        {payment.method === null ? none : paymentMethodLabel(t, payment.method)}
        {payment.bankAccountMasked === null ? null : (
          <>
            <br />
            <small className="sub" data-testid="account">
              {payment.bankAccountMasked}
            </small>
          </>
        )}
      </td>
      <td data-testid="voucher">{payment.voucherDocumentVersionId ?? none}</td>
      <td data-testid="advance">{payment.advanceId ?? none}</td>
      <td>
        <span className="lnd-badge" data-testid="payment-status">
          {paymentStatusLabel(t, payment.status)}
        </span>
        {payment.depositReason === null ? null : (
          <>
            <br />
            <small className="sub" data-testid="deposit-reason">
              {payment.depositReason}
            </small>
          </>
        )}
      </td>
      <td>
        {canPay ? (
          <>
            <button type="button" className="button" aria-label={t('lnd.payments.confirm.aria', { household: payment.householdCode, number: payment.paymentNo })} onClick={onConfirm}>
              {t('lnd.payments.confirm.action')}
            </button>
            <button type="button" className="button" aria-label={t('lnd.payments.deposit.aria', { household: payment.householdCode, number: payment.paymentNo })} onClick={onDeposit}>
              {t('lnd.payments.deposit.action')}
            </button>
          </>
        ) : null}
      </td>
    </tr>
  );
}
