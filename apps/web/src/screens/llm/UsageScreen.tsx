import { useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { Field } from '../mne/components';
import '../dis/dis.css';
import { useBudgets, useReservations, useSpend } from './hooks';
import { budgetPeriodLabel, budgetScopeLabel, reservationStatusLabel } from './labels';
import { groupDigits, usedPercent } from './llm-model';
import type { ReservationEntry } from './llm-model';

const dong = groupDigits;
const count = groupDigits;

/**
 * LLM-09: the usage of a budget and its reconciliation (ST-LLM-003, LLM F3, BR-LLM-06): for the period, the limit, what has been settled, what is held and what is left; the tokens of the attempts that settled against it, the
 * cached and the uncached input apart; and the reservations, with those that wait for the reconciliation set apart. A reservation whose usage never came back is not shown as if it had cost nothing: it stays held,
 * and the screen says so. The detail of each attempt (the model it ran on, its route and its invoice) comes with the gateway (ST-LLM-005).
 */
export default function UsageScreen({ route }: ScreenProps) {
  const tenant = useSession().tenant;
  // What is open belongs to one member of one tenant: a switch starts the screen over.
  return <UsageContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function UsageContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const budgets = useBudgets();
  const asked = params.get('budget') ?? '';
  const chosen = (budgets.data ?? []).find((budget) => budget.id === asked) ?? budgets.data?.[0];
  const spend = useSpend(chosen?.id);
  const waiting = useReservations('PENDING_RECONCILE');
  const recent = useReservations();
  // The reservations are a list of their own that grows with every request: a failure to read them is told beside them and does not hide the budget.
  const state = useScreenState({
    isLoading: budgets.isLoading || (chosen !== undefined && spend.isLoading),
    error: budgets.error ?? spend.error,
    data: budgets.data === undefined ? undefined : { rows: budgets.data },
  });
  const current = spend.data;
  const counter = current?.budget.counter ?? null;
  const waitingRows = waiting.data?.pages.flatMap((page) => page.items) ?? [];
  const recentRows = recent.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('llm.usage.page.title')}</h1>
          <p>{t('llm.usage.page.subtitle')}</p>
        </div>
      </div>
      <StateBoundary
        state={state}
        onRetry={() => {
          void budgets.refetch();
          void spend.refetch();
        }}
      >
        <div className="card">
          <Field id="usage-budget" label={t('llm.usage.budget')} error={undefined}>
            <select id="usage-budget" value={chosen?.id ?? ''} onChange={(event) => setParams({ budget: event.target.value }, { replace: true })}>
              {(budgets.data ?? []).map((budget) => (
                <option key={budget.id} value={budget.id}>
                  {budgetScopeLabel(t, budget.scope)} · {budgetPeriodLabel(t, budget.period)}
                  {budget.scopeRefId === null ? '' : ` · ${budget.scopeRefId.slice(0, 8)}`}
                </option>
              ))}
            </select>
          </Field>
        </div>
        {chosen === undefined ? (
          <p data-testid="usage-none">{t('llm.usage.none')}</p>
        ) : current === undefined ? null : (
          <>
            <dl className="card" data-testid="usage-counter">
              <dt>{t('llm.usage.limit')}</dt>
              <dd>{dong(current.budget.limit)}</dd>
              <dt>{t('llm.usage.settled')}</dt>
              <dd>{counter === null ? t('llm.usage.notUsed') : dong(counter.settled)}</dd>
              <dt>{t('llm.usage.held')}</dt>
              <dd>{counter === null ? t('llm.usage.notUsed') : dong(counter.held)}</dd>
              <dt>{t('llm.usage.available')}</dt>
              <dd>{counter === null ? dong(current.budget.limit) : dong(counter.available)}</dd>
              <dt>{t('llm.usage.used')}</dt>
              <dd>{t('llm.usage.percent', { percent: usedPercent(counter, current.budget.limit) })}</dd>
              <dt>{t('llm.usage.requests')}</dt>
              <dd>{counter === null ? '0' : counter.requests}</dd>
              <dt>{t('llm.usage.exceptions')}</dt>
              <dd>{counter === null ? '0' : counter.exceptions}</dd>
            </dl>
            <table className="table" data-testid="usage-tokens" aria-label={t('llm.usage.tokens.aria')}>
              <thead>
                <tr>
                  <th scope="col">{t('llm.usage.tokens.attempts')}</th>
                  <th scope="col">{t('llm.usage.tokens.input')}</th>
                  <th scope="col">{t('llm.usage.tokens.cached')}</th>
                  <th scope="col">{t('llm.usage.tokens.noncached')}</th>
                  <th scope="col">{t('llm.usage.tokens.output')}</th>
                  <th scope="col">{t('llm.usage.tokens.cost')}</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>{current.attempts}</td>
                  <td>{count(current.inputTotal)}</td>
                  <td>{count(current.cachedInput)}</td>
                  <td>{count(current.noncachedInput)}</td>
                  <td>{count(current.outputTotal)}</td>
                  <td>{dong(current.costVnd)}</td>
                </tr>
              </tbody>
            </table>
            {current.pendingReconcile > 0 ? (
              <p className="callout warning" role="status" data-testid="usage-pending">
                {t('llm.usage.pending', { count: current.pendingReconcile })}
              </p>
            ) : null}
          </>
        )}
        <ReservationList
          title={t('llm.usage.reservations.waitingTitle')}
          tableId="waiting-table"
          noneId="waiting-none"
          none={t('llm.usage.reservations.waitingNone')}
          rows={waitingRows}
          query={waiting}
        />
        <ReservationList title={t('llm.usage.reservations.title')} tableId="reservation-table" noneId="reservations-none" none={t('llm.usage.reservations.none')} rows={recentRows} query={recent} />
      </StateBoundary>
    </section>
  );
}

interface ListQuery {
  isLoading: boolean;
  isError: boolean;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage(): unknown;
  refetch(): unknown;
}

/** A list of reservations a page at a time: it can fail on its own without taking the budget with it, and asks for the next page only when the person does. */
function ReservationList({ title, tableId, noneId, none, rows, query }: { title: string; tableId: string; noneId: string; none: string; rows: ReservationEntry[]; query: ListQuery }) {
  const { t } = useTranslation();
  return (
    <>
      <h2>{title}</h2>
      {query.isError ? (
        <p className="callout warning" role="alert" data-testid={`${tableId}-failed`}>
          {t('llm.usage.reservations.failed')}{' '}
          <button type="button" className="btn" onClick={() => void query.refetch()}>
            {t('llm.usage.reservations.retry')}
          </button>
        </p>
      ) : (
        <>
          <table className="table" data-testid={tableId} aria-label={title}>
            <thead>
              <tr>
                <th scope="col">{t('llm.usage.reservations.request')}</th>
                <th scope="col">{t('llm.usage.reservations.amount')}</th>
                <th scope="col">{t('llm.usage.reservations.status')}</th>
                <th scope="col">{t('llm.usage.reservations.settled')}</th>
                <th scope="col">{t('llm.usage.reservations.released')}</th>
                <th scope="col">{t('llm.usage.reservations.note')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((entry) => (
                <tr key={entry.id} data-reservation-id={entry.id} data-status={entry.status}>
                  <td>{entry.requestId.slice(0, 8)}</td>
                  <td>{dong(entry.amount)}</td>
                  <td>{reservationStatusLabel(t, entry.status)}</td>
                  <td>{entry.settledAmount === null ? '' : dong(entry.settledAmount)}</td>
                  <td>{entry.releasedAmount === null ? '' : dong(entry.releasedAmount)}</td>
                  <td>{entry.note ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length === 0 && !query.isLoading ? <p data-testid={noneId}>{none}</p> : null}
          {query.hasNextPage ? (
            <button type="button" className="btn" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
              {t('llm.usage.reservations.more')}
            </button>
          ) : null}
        </>
      )}
    </>
  );
}
