import { useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { DataTable, FilterPanel, SectionCard, StatusPill } from '../../../ui';
import type { DataTableColumn } from '../../../ui';
import { ScopeBar } from '../../ctr/kit';
import { useLedger } from './hooks';
import { entryKindLabel } from './labels';
import { availableVnd, dateTimeText, filterOptions, isReversal, signedAmountText } from './model';
import type { Ledger, LedgerEntry, LedgerLine } from './model';
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
  const { t, locale } = useTranslation();
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
  const none = t('w2pay.pay.ledger.ctx.none');

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('pay.ledger.title')}</h1>
          <p>{t('pay.ledger.subtitle')}</p>
        </div>
      </div>
      <ScopeBar
        money
        extra={[
          { label: t('w2pay.pay.ledger.ctx.contract'), value: query.ledger?.contract.code ?? none },
          { label: t('w2pay.pay.ledger.ctx.asOf'), value: query.ledger === undefined ? none : dateTimeText(query.ledger.asOf, locale) },
        ]}
        stale={query.isRefetchError}
      />
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
              onClear={() => {
                const next = new URLSearchParams(search);
                next.delete('item');
                next.delete('acceptance');
                setSearch(next, { replace: true });
              }}
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
  onClear: () => void;
  more: { available: boolean; loading: boolean; load: () => void };
}

function Content({ ledger, filter, items, acceptances, onFilter, onClear, more }: ContentProps) {
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
  const unit = t('w2pay.ctx.unit');
  const figure = (testId: string, value: string) => <span data-testid={testId}>{money(value)}</span>;
  const columns: DataTableColumn<LedgerLine>[] = [
    {
      key: 'item',
      header: t('pay.ledger.column.item'),
      pinned: true,
      render: (line) => (
        <span>
          <strong data-testid="item">{line.boqItemKey}</strong>
          <small className="sub"> {line.description}</small>
        </span>
      ),
    },
    { key: 'acceptance', header: t('pay.ledger.column.acceptance'), render: (line) => <span data-testid="acceptance">{line.acceptanceNo ?? ''}</span> },
    { key: 'accepted', header: t('pay.ledger.column.accepted'), align: 'right', render: (line) => figure('accepted', line.acceptedVnd) },
    { key: 'requested', header: t('pay.ledger.column.requested'), align: 'right', render: (line) => figure('requested', line.requestedVnd) },
    { key: 'paid', header: t('pay.ledger.column.paid'), align: 'right', render: (line) => figure('paid', line.paidVnd) },
    { key: 'recovered', header: t('pay.ledger.column.recovered'), align: 'right', render: (line) => figure('recovered', line.advanceRecoveredVnd) },
    { key: 'held', header: t('pay.ledger.column.held'), align: 'right', render: (line) => figure('held', line.retentionHeldVnd) },
    { key: 'available', header: t('pay.ledger.column.available'), align: 'right', render: (line) => figure('available', availableVnd(line)) },
    {
      key: 'entries',
      header: t('pay.ledger.column.entries'),
      render: (line) => (
        <button type="button" className="ui-button ui-button--outline ui-button--small" aria-expanded={open.has(line.id)} onClick={() => toggle(line.id)} data-entries={line.id}>
          {open.has(line.id) ? t('pay.ledger.entries.hide') : t('pay.ledger.entries.show', { count: line.entries.length })}
        </button>
      ),
    },
  ];
  const opened = ledger.items.filter((line) => open.has(line.id));

  return (
    <>
      <SectionCard
        title={t('pay.ledger.contract.title')}
        unit={unit}
        status={
          <span data-testid="reconciled" data-reconciled={String(ledger.reconciled)} role="status">
            <StatusPill tone={ledger.reconciled ? 'success' : 'warning'}>{ledger.reconciled ? t('pay.ledger.reconciled.yes') : t('pay.ledger.reconciled.no')}</StatusPill>
          </span>
        }
      >
        <p>
          <strong data-testid="contract-code">{contract.code}</strong>
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
      </SectionCard>
      <FilterPanel
        unitLabel={unit}
        applied={[filter.itemId, filter.acceptanceId].filter((value) => value !== null).length}
        updatedAt={dateTimeText(ledger.asOf, locale)}
        actions={
          filtered ? (
            <button type="button" className="ui-button ui-button--outline" onClick={onClear}>
              {t('ui.dataTable.clearFilters')}
            </button>
          ) : undefined
        }
      >
        <div className="pay-form-grid" role="group" aria-label={t('pay.ledger.filter.title')}>
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
      </FilterPanel>
      <SectionCard title={t('pay.ledger.list.title')} unit={unit}>
        {ledger.items.length === 0 ? (
          <p className="sub" data-testid="no-lines">
            {t('pay.ledger.list.empty')}
          </p>
        ) : (
          <div data-testid="ledger">
            <DataTable
              caption={t('pay.ledger.list.title')}
              columns={columns}
              rows={ledger.items}
              rowKey={(line) => line.id}
              rowAttrs={(line) => ({ 'data-line': line.id, 'data-item': line.boqItemId })}
              totalsLabel={filtered ? t('pay.ledger.total.filtered') : t('pay.ledger.total.all')}
              totals={{
                accepted: figure('accepted', ledger.total.acceptedVnd),
                requested: figure('requested', ledger.total.requestedVnd),
                paid: figure('paid', ledger.total.paidVnd),
                recovered: figure('recovered', ledger.total.advanceRecoveredVnd),
                held: figure('held', ledger.total.retentionHeldVnd),
                available: figure('available', availableVnd(ledger.total)),
              }}
            />
          </div>
        )}
        {more.available ? (
          <div className="pay-row-actions">
            <button type="button" className="ui-button ui-button--outline" onClick={more.load} disabled={more.loading} data-testid="more">
              {t('pay.ledger.more.action')}
            </button>
          </div>
        ) : null}
      </SectionCard>
      {opened.map((line) => (
        <div key={line.id} data-entries-of={line.id}>
          <SectionCard title={t('pay.ledger.entries.title', { item: line.boqItemKey })} unit={unit}>
            <Entries line={line} money={money} locale={locale} />
          </SectionCard>
        </div>
      ))}
    </>
  );
}

interface EntriesProps {
  line: LedgerLine;
  money: (amount: string) => string;
  locale: string;
}

/** The entries behind one balance, oldest first as the server keeps them; an entry that reverses another is marked in words. */
function Entries({ line, money, locale }: EntriesProps) {
  const { t } = useTranslation();
  const columns: DataTableColumn<LedgerEntry>[] = [
    {
      key: 'kind',
      header: t('pay.ledger.entries.column.kind'),
      pinned: true,
      render: (entry) => (
        <span data-entry={entry.id} data-kind={entry.kind}>
          {entryKindLabel(t, entry.kind)}
          {isReversal(entry) ? (
            <>
              {' '}
              <StatusPill tone="warning">{t('pay.ledger.entry.reverses')}</StatusPill>
            </>
          ) : null}
        </span>
      ),
    },
    { key: 'postedAt', header: t('pay.ledger.entries.column.postedAt'), render: (entry) => dateTimeText(entry.postedAt, locale) },
    { key: 'accepted', header: t('pay.ledger.column.accepted'), align: 'right', render: (entry) => money(entry.acceptedDeltaVnd) },
    { key: 'requested', header: t('pay.ledger.column.requested'), align: 'right', render: (entry) => money(entry.requestedDeltaVnd) },
    { key: 'paid', header: t('pay.ledger.column.paid'), align: 'right', render: (entry) => money(entry.paidDeltaVnd) },
    { key: 'recovered', header: t('pay.ledger.column.recovered'), align: 'right', render: (entry) => money(entry.advanceRecoveryDeltaVnd) },
    { key: 'held', header: t('pay.ledger.column.held'), align: 'right', render: (entry) => money(entry.retentionDeltaVnd) },
    { key: 'outstanding', header: t('pay.ledger.entries.column.outstanding'), align: 'right', render: (entry) => money(entry.advanceOutstandingAfterVnd) },
    { key: 'reason', header: t('pay.ledger.entries.column.reason'), render: (entry) => entry.reason ?? '' },
  ];
  return <DataTable caption={t('pay.ledger.entries.title', { item: line.boqItemKey })} columns={columns} rows={line.entries} rowKey={(entry) => entry.id} rowAttrs={(entry) => ({ 'data-entry': entry.id, 'data-kind': entry.kind })} />;
}
