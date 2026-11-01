import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../../i18n';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { vietnamDay } from '../llm-model';
import { Field } from '../../mne/components';
import { useReconciliations, useRunReconciliation } from './hooks';
import { directionLabel, problemMessage, statusLabel } from './labels';
import { EMPTY_RUN, RECONCILIATION_STATUSES, direction, describeProblem, money, toRunResult, validateRun } from './model';
import type { FormProblem, Reconciliation, RunField, RunForm, RunResult } from './model';

/**
 * The reconciliation of the invoices of the providers (ST-LLM-008, LLM F3, BR-LLM-06): an invoice is set against the sum of the attempts of the provider in a period. A difference inside the tolerance is
 * reconciled; one outside it is a variance with an owner, and the attempts that still wait for their usage are listed, none of them edited to make the figures agree.
 */
export function ReconcileSection() {
  const { t } = useTranslation();
  const [status, setStatus] = useState('');
  const [opened, setOpened] = useState<string | undefined>(undefined);
  const list = useReconciliations(status);
  const rows = list.data?.pages.flatMap((page) => page.items) ?? [];
  const state = useScreenState({
    isLoading: list.isLoading,
    error: list.isFetchNextPageError ? null : list.error,
    data: list.data === undefined ? undefined : { rows },
  });
  const chosen = rows.find((row) => row.id === opened);
  return (
    <section aria-labelledby="reconcile-title" data-testid="reconcile-section">
      <h2 id="reconcile-title">{t('llm.routelog.rec.title')}</h2>
      <p className="sub">{t('llm.routelog.rec.subtitle')}</p>
      <RunPanel />
      <div className="card">
        <div className="mne-filters">
          <Field id="reconcile-status" label={t('llm.routelog.rec.filter')} error={undefined}>
            <select id="reconcile-status" value={status} onChange={(event) => setStatus(event.target.value)}>
              <option value="">{t('llm.requests.filter.all')}</option>
              {RECONCILIATION_STATUSES.map((entry) => (
                <option key={entry} value={entry}>
                  {statusLabel(t, entry)}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </div>
      <StateBoundary state={state} onRetry={() => void list.refetch()}>
        {rows.length === 0 ? (
          <p data-testid="reconcile-none">{t('llm.routelog.rec.none')}</p>
        ) : (
          <div className="tablewrap">
            <table className="table" data-testid="reconcile-table" aria-label={t('llm.routelog.rec.table')}>
              <thead>
                <tr>
                  <th scope="col">{t('llm.routelog.rec.col.provider')}</th>
                  <th scope="col">{t('llm.routelog.rec.col.invoice')}</th>
                  <th scope="col">{t('llm.routelog.rec.col.period')}</th>
                  <th scope="col">{t('llm.routelog.rec.col.amount')}</th>
                  <th scope="col">{t('llm.routelog.rec.col.attempts')}</th>
                  <th scope="col">{t('llm.routelog.rec.col.variance')}</th>
                  <th scope="col">{t('llm.routelog.rec.col.status')}</th>
                  <th scope="col">{t('llm.routelog.rec.col.detail')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} data-reconciliation={row.id} data-status={row.status}>
                    <td>{row.providerCode}</td>
                    <td>
                      <code>{row.invoiceRef}</code>
                    </td>
                    <td>
                      {t('llm.routelog.rec.period', {
                        from: row.periodFrom,
                        to: row.periodTo,
                      })}
                    </td>
                    <td>
                      {t('llm.routelog.rec.money', {
                        value: money(row.invoiceAmount),
                        currency: row.currency,
                      })}
                    </td>
                    <td>
                      {t('llm.routelog.rec.money', {
                        value: money(row.attemptsTotal),
                        currency: row.currency,
                      })}
                    </td>
                    <td data-testid="variance">
                      {t('llm.routelog.rec.money', {
                        value: money(row.variance),
                        currency: row.currency,
                      })}
                    </td>
                    <td>
                      <span className={`pill ${row.status === 'RECONCILED' ? 'green' : 'amber'}`} data-testid="status">
                        {statusLabel(t, row.status)}
                      </span>
                    </td>
                    <td>
                      <button type="button" onClick={() => setOpened(row.id)}>
                        {t('llm.routelog.rec.open', { ref: row.invoiceRef })}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {list.hasNextPage ? (
          <button type="button" className="btn" data-testid="reconcile-more" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
            {t('llm.requests.more')}
          </button>
        ) : null}
        {list.isFetchNextPageError ? (
          <p className="callout warning" role="alert" data-testid="reconcile-more-failed">
            {t('llm.requests.moreFailed')}
          </p>
        ) : null}
        {chosen === undefined ? null : <VarianceDetail row={chosen} onClose={() => setOpened(undefined)} />}
      </StateBoundary>
    </section>
  );
}

function VarianceDetail({ row, onClose }: { row: Reconciliation; onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <section className="card" aria-label={t('llm.routelog.rec.detail.title')} data-testid="reconcile-detail" data-status={row.status}>
      <div className="heading">
        <h3>{t('llm.routelog.rec.detail.title')}</h3>
        <button type="button" onClick={onClose}>
          {t('llm.routelog.rec.close')}
        </button>
      </div>
      <dl>
        <div>
          <dt>{t('llm.routelog.rec.col.attempts')}</dt>
          <dd data-testid="detail-attempts">
            {t('llm.routelog.rec.money', {
              value: money(row.attemptsTotal),
              currency: row.currency,
            })}
          </dd>
        </div>
        <div>
          <dt>{t('llm.routelog.rec.col.amount')}</dt>
          <dd data-testid="detail-invoice">
            {t('llm.routelog.rec.money', {
              value: money(row.invoiceAmount),
              currency: row.currency,
            })}
          </dd>
        </div>
        <div>
          <dt>{t('llm.routelog.rec.col.variance')}</dt>
          <dd data-testid="detail-variance" data-direction={direction(row.variance)}>
            {t('llm.routelog.rec.money', {
              value: money(row.variance),
              currency: row.currency,
            })}{' '}
            · {directionLabel(t, direction(row.variance))}
          </dd>
        </div>
        <div>
          <dt>{t('llm.routelog.rec.detail.tolerance')}</dt>
          <dd data-testid="detail-tolerance">
            {t('llm.routelog.rec.detail.pct', {
              value: money(row.tolerancePct),
            })}
          </dd>
        </div>
        <div>
          <dt>{t('llm.routelog.rec.detail.counted')}</dt>
          <dd data-testid="detail-counted">
            {t('llm.routelog.rec.detail.countedText', {
              count: row.attemptCount,
              reconciled: row.reconciledCount,
            })}
          </dd>
        </div>
        <div>
          <dt>{t('llm.routelog.rec.detail.pending')}</dt>
          <dd data-testid="detail-pending">{row.pendingAttemptIds.length}</dd>
        </div>
        <div>
          <dt>{t('llm.routelog.rec.detail.settled')}</dt>
          <dd data-testid="detail-settled">{row.reservationsSettled}</dd>
        </div>
        <div>
          <dt>{t('llm.routelog.rec.detail.owner')}</dt>
          <dd data-testid="detail-owner">{row.ownerId === null ? '—' : <code title={row.ownerId}>{row.ownerId.slice(0, 8)}</code>}</dd>
        </div>
        <div>
          <dt>{t('llm.routelog.rec.detail.runs')}</dt>
          <dd data-testid="detail-runs">
            {t('llm.routelog.rec.detail.runsText', {
              count: row.runCount,
              at: row.lastRunAt === null ? '—' : vietnamDay(row.lastRunAt),
            })}
          </dd>
        </div>
      </dl>
      {row.pendingAttemptIds.length === 0 ? (
        <p data-testid="no-pending">{t('llm.routelog.rec.detail.noPending')}</p>
      ) : (
        <>
          <p>{t('llm.routelog.rec.detail.pendingNote')}</p>
          <ul data-testid="pending-list">
            {row.pendingAttemptIds.map((id) => (
              <li key={id}>
                <code>{id}</code>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function RunPanel() {
  const { t } = useTranslation();
  const { mode } = useSession();
  const send = useRunReconciliation();
  const [form, setForm] = useState<RunForm>(EMPTY_RUN);
  const [problems, setProblems] = useState<Partial<Record<RunField, FormProblem>>>({});
  const [result, setResult] = useState<RunResult | undefined>(undefined);
  const failure = send.isError ? describeProblem(send.error) : undefined;
  if (mode === 'READ_ONLY') return null;
  const set = (patch: Partial<RunForm>): void => setForm((value) => ({ ...value, ...patch }));
  const message = (problem: FormProblem | undefined): string | undefined =>
    problem === undefined ? undefined : problem === 'required' ? t('llm.routelog.run.required') : t('llm.routelog.run.invalid');

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setResult(undefined);
    const found = validateRun(form);
    setProblems(found);
    if (Object.keys(found).length > 0 || send.isPending) return;
    // The form stays as it is: the run is asked again with the same figures once the late usage is in.
    send.mutate(form, {
      onSuccess: (answer) => setResult(toRunResult(answer)),
    });
  };

  return (
    <form className="card" onSubmit={submit} noValidate aria-label={t('llm.routelog.run.title')}>
      <h3>{t('llm.routelog.run.title')}</h3>
      <Field id="run-ref" label={t('llm.routelog.run.ref')} hint={t('llm.routelog.run.refHint')} error={message(problems.invoiceRef)}>
        <input id="run-ref" value={form.invoiceRef} maxLength={120} aria-invalid={problems.invoiceRef !== undefined} onChange={(event) => set({ invoiceRef: event.target.value })} />
      </Field>
      <Field id="run-amount" label={t('llm.routelog.run.amount')} hint={t('llm.routelog.run.amountHint')} error={message(problems.invoiceAmount)}>
        <input id="run-amount" inputMode="decimal" value={form.invoiceAmount} aria-invalid={problems.invoiceAmount !== undefined} onChange={(event) => set({ invoiceAmount: event.target.value })} />
      </Field>
      <Field id="run-currency" label={t('llm.routelog.run.currency')} error={message(problems.currency)}>
        <input id="run-currency" value={form.currency} maxLength={3} aria-invalid={problems.currency !== undefined} onChange={(event) => set({ currency: event.target.value })} />
      </Field>
      <Field id="run-from" label={t('llm.routelog.run.from')} error={message(problems.periodFrom)}>
        <input id="run-from" type="date" value={form.periodFrom} aria-invalid={problems.periodFrom !== undefined} onChange={(event) => set({ periodFrom: event.target.value })} />
      </Field>
      <Field id="run-to" label={t('llm.routelog.run.to')} hint={t('llm.routelog.run.toHint')} error={message(problems.periodTo)}>
        <input id="run-to" type="date" value={form.periodTo} aria-invalid={problems.periodTo !== undefined} onChange={(event) => set({ periodTo: event.target.value })} />
      </Field>
      {failure === undefined ? null : (
        <p className="callout warning" role="alert" data-testid="run-refusal" data-reason={failure.reason}>
          {problemMessage(t, failure)}
        </p>
      )}
      {result === undefined ? null : (
        <p className="callout" role="status" data-testid="run-result" data-status={result.status}>
          {t('llm.routelog.run.result', {
            status: statusLabel(t, result.status),
            variance: money(result.variance),
            total: money(result.attemptsTotal),
            pending: result.pendingCount,
            settled: result.reservationsSettled,
          })}
        </p>
      )}
      <div className="formfooter">
        <button type="submit" className="primary" disabled={send.isPending}>
          {t('llm.routelog.run.submit')}
        </button>
      </div>
    </form>
  );
}
