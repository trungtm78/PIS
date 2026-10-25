import { Fragment, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { useLedger } from './hooks';
import { entryKindLabel } from './labels';
import { availableVnd, dateTimeText, filterOptions, isReversal, signedAmountText } from './model';
import type { Balance, Ledger, LedgerLine } from './model';
import '../pay.css';

/**
 * PAY-10: the cumulative ledger of a contract (ST-PAY-001, PAY 3.1, UC-PAY-01). For each BOQ item of each acceptance it shows what was accepted, requested, paid, recovered from the advance and
 * held back, with the entries that make each balance. The figures are held by the database: a balance is the sum of its entries, an entry is never changed or deleted, and a mistake is
 * corrected by an entry that reverses it. The screen only reads; the contractor of a contract never sees it (the server refuses).
 */
export default function LedgerScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The ledger and the filters belong to one membership: a switch of tenant or of membership starts the screen over.
  return <LedgerContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function LedgerContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const [search, setSearch] = useSearchParams();
  const contractId = search.get('contract');
  const itemId = search.get('item');
  const acceptanceId = search.get('acceptance');
  const query = useLedger(contractId, { itemId, acceptanceId });
  // The filters offer every item and acceptance seen so far, also while one of them is chosen and the lines shown are fewer.
  const seen = useRef({ items: new Map<string, string>(), acceptances: new Map<string, string>() });
  const options = filterOptions(query.ledger?.items ?? []);
  for (const option of options.items) seen.current.items.set(option.id, option.label);
  for (const option of options.acceptances) seen.current.acceptances.set(option.id, option.label);
  const state = useScreenState({
    isLoading: query.isLoading,
    error: query.error,
    data: contractId === null || query.isLoading ? undefined : query.missing ? null : query.ledger,
    isEmpty: (data) => data === null,
  });
  const setFilter = (name: 'item' | 'acceptance', value: string): void => {
    const next = new URLSearchParams(search);
    if (value === '') next.delete(name);
    else next.set(name, value);
    setSearch(next, { replace: true });
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('pay.ledger.title')}</h1>
          <p>{t('pay.ledger.subtitle')}</p>
        </div>
      </div>
      {contractId === null ? (
        <p className="callout" role="status" data-testid="no-contract">
          {t('pay.ledger.none.notice')}
        </p>
      ) : (
        <StateBoundary state={state} onRetry={() => void query.refetch()}>
          {query.ledger === undefined ? null : (
            <Content
              ledger={query.ledger}
              filter={{ itemId, acceptanceId }}
              items={[...seen.current.items].map(([id, label]) => ({ id, label }))}
              acceptances={[...seen.current.acceptances].map(([id, label]) => ({ id, label }))}
              onFilter={setFilter}
              more={{ available: query.hasNextPage, loading: query.isFetchingNextPage, load: () => void query.fetchNextPage() }}
            />
          )}
        </StateBoundary>
      )}
      <p className="prototype-note">{t('pay.ledger.footer', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

interface ContentProps {
  ledger: Ledger;
  filter: { itemId: string | null; acceptanceId: string | null };
  items: Array<{ id: string; label: string }>;
  acceptances: Array<{ id: string; label: string }>;
  onFilter: (name: 'item' | 'acceptance', value: string) => void;
  more: { available: boolean; loading: boolean; load: () => void };
}

function Content({ ledger, filter, items, acceptances, onFilter, more }: ContentProps) {
  const { t, locale } = useTranslation();
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const money = (amount: string): string => signedAmountText(amount, locale) ?? amount;
  const toggle = (id: string): void =>
    setOpen((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const { contract } = ledger;
  const filtered = filter.itemId !== null || filter.acceptanceId !== null;

  return (
    <>
      <article className="card" aria-label={t('pay.ledger.contract.title')}>
        <h2>{t('pay.ledger.contract.title')}</h2>
        <p>
          <strong data-testid="contract-code">{contract.code}</strong>{' '}
          <span className={ledger.reconciled ? 'pay-badge' : 'pay-badge warning'} role="status" data-testid="reconciled" data-reconciled={String(ledger.reconciled)}>
            {ledger.reconciled ? t('pay.ledger.reconciled.yes') : t('pay.ledger.reconciled.no')}
          </span>
        </p>
        <dl className="pay-facts">
          <dt>{t('pay.ledger.contract.value')}</dt>
          <dd data-testid="contract-value">{money(contract.contractValueVnd)}</dd>
          <dt>{t('pay.ledger.contract.accepted')}</dt>
          <dd data-testid="contract-accepted">{money(contract.acceptedTotalVnd)}</dd>
          <dt>{t('pay.ledger.contract.requested')}</dt>
          <dd data-testid="contract-requested">{money(contract.requestedTotalVnd)}</dd>
          <dt>{t('pay.ledger.contract.paid')}</dt>
          <dd data-testid="contract-paid">{money(contract.paidTotalVnd)}</dd>
          <dt>{t('pay.ledger.contract.advanceOutstanding')}</dt>
          <dd data-testid="contract-advance">{money(contract.advanceOutstandingVnd)}</dd>
          <dt>{t('pay.ledger.contract.retentionHeld')}</dt>
          <dd data-testid="contract-retention-held">{money(contract.retentionHeldVnd)}</dd>
          <dt>{t('pay.ledger.contract.retentionReleased')}</dt>
          <dd data-testid="contract-retention-released">{money(contract.retentionReleasedVnd)}</dd>
        </dl>
      </article>
      <article className="card" aria-label={t('pay.ledger.filter.title')}>
        <h2>{t('pay.ledger.filter.title')}</h2>
        <div className="pay-form-grid">
          <label>
            {t('pay.ledger.filter.item')}
            <select value={filter.itemId ?? ''} onChange={(event) => onFilter('item', event.target.value)} data-testid="filter-item">
              <option value="">{t('pay.ledger.filter.all')}</option>
              {items.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t('pay.ledger.filter.acceptance')}
            <select value={filter.acceptanceId ?? ''} onChange={(event) => onFilter('acceptance', event.target.value)} data-testid="filter-acceptance">
              <option value="">{t('pay.ledger.filter.all')}</option>
              {acceptances.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </article>
      <article className="card" aria-label={t('pay.ledger.list.title')}>
        <h2>{t('pay.ledger.list.title')}</h2>
        {ledger.items.length === 0 ? (
          <p className="sub" data-testid="no-lines">
            {t('pay.ledger.list.empty')}
          </p>
        ) : (
          <table className="table" data-testid="ledger">
            <thead>
              <tr>
                <th scope="col">{t('pay.ledger.column.item')}</th>
                <th scope="col">{t('pay.ledger.column.acceptance')}</th>
                <th scope="col" className="pay-amount">
                  {t('pay.ledger.column.accepted')}
                </th>
                <th scope="col" className="pay-amount">
                  {t('pay.ledger.column.requested')}
                </th>
                <th scope="col" className="pay-amount">
                  {t('pay.ledger.column.paid')}
                </th>
                <th scope="col" className="pay-amount">
                  {t('pay.ledger.column.recovered')}
                </th>
                <th scope="col" className="pay-amount">
                  {t('pay.ledger.column.held')}
                </th>
                <th scope="col" className="pay-amount">
                  {t('pay.ledger.column.available')}
                </th>
                <th scope="col">
                  <span className="sr-only">{t('pay.ledger.column.entries')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {ledger.items.map((line) => (
                <Row key={line.id} line={line} open={open.has(line.id)} onToggle={() => toggle(line.id)} money={money} locale={locale} />
              ))}
            </tbody>
            <tfoot>
              <tr data-testid="total">
                <th scope="row" colSpan={2}>
                  {filtered ? t('pay.ledger.total.filtered') : t('pay.ledger.total.all')}
                </th>
                <Cells balance={ledger.total} money={money} />
                <td />
              </tr>
            </tfoot>
          </table>
        )}
        {more.available ? (
          <div className="pay-row-actions">
            <button type="button" onClick={more.load} disabled={more.loading} data-testid="more">
              {t('pay.ledger.more.action')}
            </button>
          </div>
        ) : null}
      </article>
    </>
  );
}

/** The five amounts of a balance and what is still free to request, in the columns of the table. */
function Cells({ balance, money }: { balance: Balance; money: (amount: string) => string }) {
  return (
    <>
      <td className="pay-amount" data-testid="accepted">
        {money(balance.acceptedVnd)}
      </td>
      <td className="pay-amount" data-testid="requested">
        {money(balance.requestedVnd)}
      </td>
      <td className="pay-amount" data-testid="paid">
        {money(balance.paidVnd)}
      </td>
      <td className="pay-amount" data-testid="recovered">
        {money(balance.advanceRecoveredVnd)}
      </td>
      <td className="pay-amount" data-testid="held">
        {money(balance.retentionHeldVnd)}
      </td>
      <td className="pay-amount" data-testid="available">
        {money(availableVnd(balance))}
      </td>
    </>
  );
}

interface RowProps {
  line: LedgerLine;
  open: boolean;
  onToggle: () => void;
  money: (amount: string) => string;
  locale: string;
}

function Row({ line, open, onToggle, money, locale }: RowProps) {
  const { t } = useTranslation();
  return (
    <Fragment>
      <tr data-line={line.id} data-item={line.boqItemId}>
        <td>
          <strong data-testid="item">{line.boqItemKey}</strong>
          <small className="sub"> {line.description}</small>
        </td>
        <td data-testid="acceptance">{line.acceptanceNo ?? ''}</td>
        <Cells balance={line} money={money} />
        <td>
          <button type="button" aria-expanded={open} onClick={onToggle} data-entries={line.id}>
            {open ? t('pay.ledger.entries.hide') : t('pay.ledger.entries.show', { count: line.entries.length })}
          </button>
        </td>
      </tr>
      {open ? (
        <tr data-entries-of={line.id}>
          <td colSpan={9}>
            <table className="table pay-entries" aria-label={t('pay.ledger.entries.title', { item: line.boqItemKey })}>
              <thead>
                <tr>
                  <th scope="col">{t('pay.ledger.entries.column.kind')}</th>
                  <th scope="col">{t('pay.ledger.entries.column.postedAt')}</th>
                  <th scope="col" className="pay-amount">
                    {t('pay.ledger.column.accepted')}
                  </th>
                  <th scope="col" className="pay-amount">
                    {t('pay.ledger.column.requested')}
                  </th>
                  <th scope="col" className="pay-amount">
                    {t('pay.ledger.column.paid')}
                  </th>
                  <th scope="col" className="pay-amount">
                    {t('pay.ledger.column.recovered')}
                  </th>
                  <th scope="col" className="pay-amount">
                    {t('pay.ledger.column.held')}
                  </th>
                  <th scope="col" className="pay-amount">
                    {t('pay.ledger.entries.column.outstanding')}
                  </th>
                  <th scope="col">{t('pay.ledger.entries.column.reason')}</th>
                </tr>
              </thead>
              <tbody>
                {line.entries.map((entry) => (
                  <tr key={entry.id} data-entry={entry.id} data-kind={entry.kind}>
                    <td>
                      {entryKindLabel(t, entry.kind)}
                      {isReversal(entry) ? <span className="pay-badge warning"> {t('pay.ledger.entry.reverses')}</span> : null}
                    </td>
                    <td>{dateTimeText(entry.postedAt, locale)}</td>
                    <td className="pay-amount">{money(entry.acceptedDeltaVnd)}</td>
                    <td className="pay-amount">{money(entry.requestedDeltaVnd)}</td>
                    <td className="pay-amount">{money(entry.paidDeltaVnd)}</td>
                    <td className="pay-amount">{money(entry.advanceRecoveryDeltaVnd)}</td>
                    <td className="pay-amount">{money(entry.retentionDeltaVnd)}</td>
                    <td className="pay-amount">{money(entry.advanceOutstandingAfterVnd)}</td>
                    <td>{entry.reason ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </td>
        </tr>
      ) : null}
    </Fragment>
  );
}
