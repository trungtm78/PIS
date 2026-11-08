import { useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { Translator } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { ContextBar, DataTable, FilterPanel, KpiTile } from '../../../ui';
import type { DataTableColumn } from '../../../ui';
import { CalendarNotice, FigureInfo, StatePill, TruncatedNotice, WithInfo } from './components';
import { camel, can, dayText, stampText, vnd } from './common';
import { useClaims, useContractChoices } from './hooks';
import { kindLabel, sideLabel, statusLabel } from './labels';
import { EMPTY_FILTER, LIMITATIONS, MANAGE_PERMISSION, PATHS, SIDES, STATUSES, isFiltered } from './model';
import type { ClaimFilter, ClaimLine, ClaimPage } from './model';
import { RegisterClaimDialog } from './RegisterClaimDialog';
import './claims.css';

type T = Translator['t'];
const NONE = '–';

/**
 * CTR-32, the claim register of the contracts in scope (G1-9). Each claim is the demand of one side of a contract on the other because of an event; the limitation date of a claim is counted by the server from the term of its own
 * contract (approved by a second person) and never from a default: a claim whose contract has no approved term says so. The numbers carry their "i"; the totals are the server's, over the whole filter.
 */
export default function ClaimRegisterScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The register belongs to one membership: a switch of tenant or of membership starts the screen over.
  return <ClaimRegisterContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

type FigureKind = 'count' | 'money' | 'days' | 'withoutTerm';

function Figure({ kind, name, page }: { kind: FigureKind; name: string; page: ClaimPage }) {
  const { t } = useTranslation();
  const formula =
    kind === 'count' ? t('ctrClaim.figure.count.formula') : kind === 'money' ? t('ctrClaim.figure.money.formula') : kind === 'days' ? t('ctrClaim.figure.days.formula') : t('ctrClaim.figure.withoutTerm.formula');
  return <FigureInfo name={name} formula={formula} source={t('ctrClaim.figure.register.source')} asOf={dayText(page.as_of)} />;
}

function Summary({ page }: { page: ClaimPage }) {
  const { t, locale } = useTranslation();
  const totals = page.totals;
  const lower = page.truncated ? t('ctrClaim.summary.lowerBound.text') : undefined;
  const tile = (key: string, label: string, value: string, kind: FigureKind, unit?: string): ReactNode => (
    <div className="ctrreg-tile" data-testid={`tile-${key}`} key={key}>
      <KpiTile label={label} value={value} {...(unit === undefined ? {} : { unit })} {...(lower === undefined ? {} : { sub: lower })} />
      <Figure kind={kind} name={label} page={page} />
    </div>
  );
  return (
    <div className="ctrreg-tiles">
      {tile('count', t('ctrClaim.summary.count.label'), String(totals.count), 'count')}
      {tile('open', t('ctrClaim.summary.open.label'), String(totals.open), 'count')}
      {tile('withoutTerm', t('ctrClaim.summary.withoutTerm.label'), String(totals.without_term), 'withoutTerm')}
      {tile('claimed', t('ctrClaim.summary.claimed.label'), vnd(totals.claimed_vnd, locale), 'money', t('ctrClaim.unit.vnd.text'))}
      {tile('openClaimed', t('ctrClaim.summary.openClaimed.label'), vnd(totals.open_claimed_vnd, locale), 'money', t('ctrClaim.unit.vnd.text'))}
      {tile('settled', t('ctrClaim.summary.settled.label'), vnd(totals.settled_vnd, locale), 'money', t('ctrClaim.unit.vnd.text'))}
    </div>
  );
}

function LimitationCell({ line, page }: { line: ClaimLine; page: ClaimPage }) {
  const { t } = useTranslation();
  const limitation = line.limitation;
  return (
    <span className="ctrreg-limitation" data-testid="limitation">
      <StatePill group="limitation" state={limitation.status} />
      {limitation.due_on !== null && (
        <WithInfo
          info={
            <FigureInfo
              name={t('ctrClaim.column.limitation.label')}
              formula={t('ctrClaim.figure.limitation.formula')}
              source={t('ctrClaim.figure.limitation.source')}
              asOf={dayText(page.as_of)}
              rule={page.policy}
            />
          }
        >
          <span className="ctrreg-day">{dayText(limitation.due_on)}</span>
        </WithInfo>
      )}
    </span>
  );
}

function columnsOf(t: T, locale: string, page: ClaimPage): DataTableColumn<ClaimLine>[] {
  return [
    {
      key: 'code',
      header: t('ctrClaim.column.code.label'),
      pinned: true,
      render: (line) => (
        <Link to={`${PATHS.record}?claim=${line.id}`} data-testid="claim-link">
          {line.code}
        </Link>
      ),
    },
    { key: 'title', header: t('ctrClaim.column.title.label'), render: (line) => line.title },
    { key: 'contract', header: t('ctrClaim.column.contract.label'), render: (line) => line.contract.code },
    { key: 'side', header: t('ctrClaim.column.side.label'), render: (line) => sideLabel(t, line.claimant_side) },
    { key: 'kind', header: t('ctrClaim.column.kind.label'), render: (line) => kindLabel(t, line.kind) },
    { key: 'status', header: t('ctrClaim.column.status.label'), render: (line) => statusLabel(t, line.status) },
    { key: 'awareness', header: t('ctrClaim.column.awareness.label'), render: (line) => dayText(line.awareness_on) },
    { key: 'limitation', header: t('ctrClaim.column.limitation.label'), render: (line) => <LimitationCell line={line} page={page} /> },
    { key: 'claimed', header: t('ctrClaim.column.claimed.label'), align: 'right', render: (line) => (line.claimed_amount_vnd === null ? NONE : vnd(line.claimed_amount_vnd, locale)) },
    { key: 'days', header: t('ctrClaim.column.days.label'), align: 'right', render: (line) => (line.claimed_days === null ? NONE : String(line.claimed_days)) },
    { key: 'settled', header: t('ctrClaim.column.settled.label'), align: 'right', render: (line) => (line.settled_amount_vnd === null ? NONE : vnd(line.settled_amount_vnd, locale)) },
  ];
}

function Filters({ filter, onChange, onClear }: { filter: ClaimFilter; onChange: (next: ClaimFilter) => void; onClear: () => void }) {
  const { t } = useTranslation();
  const contracts = useContractChoices();
  const set = (patch: Partial<ClaimFilter>): void => onChange({ ...filter, ...patch });
  return (
    <FilterPanel applied={Object.values(filter).filter((value) => value !== '' && value !== false).length}>
      <label className="ctrreg-filter">
        <span>{t('ctrClaim.filter.contract.label')}</span>
        <select value={filter.contractId} onChange={(event) => set({ contractId: event.target.value })} data-testid="filter-contract">
          <option value="">{t('ctrClaim.filter.all.option')}</option>
          {(contracts.data ?? []).map((contract) => (
            <option key={contract.id} value={contract.id}>
              {contract.code}
            </option>
          ))}
        </select>
      </label>
      <label className="ctrreg-filter">
        <span>{t('ctrClaim.filter.status.label')}</span>
        <select value={filter.status} onChange={(event) => set({ status: event.target.value })} data-testid="filter-status">
          <option value="">{t('ctrClaim.filter.all.option')}</option>
          {STATUSES.map((status) => (
            <option key={status} value={status}>
              {statusLabel(t, status)}
            </option>
          ))}
        </select>
      </label>
      <label className="ctrreg-filter">
        <span>{t('ctrClaim.filter.side.label')}</span>
        <select value={filter.side} onChange={(event) => set({ side: event.target.value })} data-testid="filter-side">
          <option value="">{t('ctrClaim.filter.all.option')}</option>
          {SIDES.map((side) => (
            <option key={side} value={side}>
              {sideLabel(t, side)}
            </option>
          ))}
        </select>
      </label>
      <label className="ctrreg-filter">
        <span>{t('ctrClaim.filter.limitation.label')}</span>
        <select value={filter.limitation} onChange={(event) => set({ limitation: event.target.value })} data-testid="filter-limitation">
          <option value="">{t('ctrClaim.filter.all.option')}</option>
          {LIMITATIONS.map((state) => (
            <option key={state} value={state}>
              {t(`ctrClaim.limitation.state.${camel(state)}.label`)}
            </option>
          ))}
        </select>
      </label>
      <label className="ctrreg-check">
        <input type="checkbox" checked={filter.open} onChange={(event) => set({ open: event.target.checked })} data-testid="filter-open" />
        <span>{t('ctrClaim.filter.open.label')}</span>
      </label>
      <label className="ctrreg-check">
        <input type="checkbox" checked={filter.mine} onChange={(event) => set({ mine: event.target.checked })} data-testid="filter-mine" />
        <span>{t('ctrClaim.filter.mine.label')}</span>
      </label>
      {isFiltered(filter) && (
        <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={onClear} data-testid="filter-clear">
          {t('ctrClaim.filter.clear.action')}
        </button>
      )}
    </FilterPanel>
  );
}

function ClaimRegisterContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { permissions, mode } = useSession();
  const [params] = useSearchParams();
  const [filter, setFilter] = useState<ClaimFilter>({ ...EMPTY_FILTER, contractId: params.get('contract') ?? '' });
  const [dialog, setDialog] = useState(false);
  const [receipt, setReceipt] = useState<string | undefined>(undefined);
  const query = useClaims(filter);
  const pages = query.data?.pages;
  const first = pages?.[0];
  const rows = (pages ?? []).flatMap((page) => page.items);
  const state = useScreenState({ isLoading: query.isLoading, error: first === undefined ? query.error : undefined, data: first, isEmpty: () => false });
  const refreshFailed = query.isError && first !== undefined;
  const canManage = can(permissions, MANAGE_PERMISSION, mode === 'READ_ONLY');

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title" className="ctrreg-page">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('ctrClaim.register.page.title')}</h1>
          <p>{t('ctrClaim.register.page.subtitle')}</p>
        </div>
        {canManage && (
          <div className="actions">
            <button type="button" className="ui-button ui-button--primary" onClick={() => setDialog(true)} data-testid="register-button">
              {t('ctrClaim.register.open.action')}
            </button>
          </div>
        )}
      </div>
      <ContextBar
        items={[{ label: t('ctrClaim.context.policy.label'), value: first === undefined ? NONE : first.policy.unverified ? t('ctrClaim.context.policy.unverified') : t('ctrClaim.context.policy.set') }]}
        unit={t('ctrClaim.unit.vnd.text')}
        stale={refreshFailed}
        {...(first === undefined ? {} : { asOf: stampText(first.as_of) })}
      />
      {receipt !== undefined && (
        <p className="ctrreg-receipt" role="status" data-testid="receipt">
          {receipt}
        </p>
      )}
      <Filters filter={filter} onChange={setFilter} onClear={() => setFilter(EMPTY_FILTER)} />
      <StateBoundary state={state} onRetry={() => void query.refetch()}>
        {first !== undefined && (
          <>
            <CalendarNotice published={first.calendar_published} />
            <TruncatedNotice truncated={first.truncated} />
            <Summary page={first} />
            <DataTable
              caption={t('ctrClaim.register.table.caption')}
              columns={columnsOf(t, locale, first)}
              rows={rows}
              rowKey={(line) => line.id}
              rowAttrs={(line) => ({ 'data-claim': line.id, 'data-limitation': line.limitation.status })}
              severity={(line) => (line.limitation.status === 'MISSED' ? 'URGENT' : line.limitation.status === 'APPROACHING' ? 'ACTION' : null)}
              emptyKind={isFiltered(filter) ? 'filtered' : 'none'}
              onClearFilters={() => setFilter(EMPTY_FILTER)}
              totalsLabel={t('ctrClaim.register.totals.label')}
              totals={{
                claimed: vnd(first.totals.claimed_vnd, locale),
                days: String(first.totals.claimed_days),
                settled: vnd(first.totals.settled_vnd, locale),
              }}
            />
            {query.hasNextPage && (
              <button type="button" className="ui-button ui-button--outline" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()} data-testid="load-more">
                {t('ctrClaim.register.more.action')}
              </button>
            )}
          </>
        )}
      </StateBoundary>
      {dialog && (
        <RegisterClaimDialog
          initialContract={filter.contractId}
          onClose={() => setDialog(false)}
          onDone={(title) => {
            setReceipt(t('ctrClaim.register.success.text', { title }));
            setDialog(false);
          }}
        />
      )}
    </section>
  );
}
