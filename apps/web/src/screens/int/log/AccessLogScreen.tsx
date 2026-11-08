import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { Translator } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { useScreenState } from '../../../states/useScreenState';
import { DataTable, SectionCard, StatusPill } from '../../../ui';
import type { DataTableColumn, Tone } from '../../../ui';
import { CountInfo, DeniedBlock, EmptyBlock, ErrorBlock, MoreRow } from '../int-common';
import { useAccessLog } from '../int-hooks';
import { filtersOf, instantText, searchOf } from '../int-model';
import type { OpenAccessLogPage } from '../int-model';
import { outcomeLabel } from './log-labels';
import '../int.css';

type T = Translator['t'];
type Entry = OpenAccessLogPage['items'][number];

const OUTCOME_TONE: Readonly<Record<string, Tone>> = { OK: 'success', DENIED_CLIENT: 'danger', DENIED_SCOPE: 'danger', DENIED_DATASET: 'warning', RATE_LIMITED: 'warning', INVALID_REQUEST: 'info' };
const FILTERS = ['account_id', 'outcome', 'from', 'to'] as const;
const NEVER_EMPTY = (): boolean => false;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * INT-05, "Open API access log" (INT-1): one row for every call a machine made, the refused ones too (a scope it lacks, a dataset not certified, a client that did not authenticate, the rate limit). The log is
 * append-only for everyone and names the parameters that were sent, never their values. A BI tool's reads are not here: they are logged by the database server (pgaudit), as the screen says.
 */
export default function AccessLogScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The filters belong to one membership: a switch of tenant or of membership starts the screen over.
  return <LogContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function LogContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const [search, setSearch] = useSearchParams();
  const filters = useMemo(() => filtersOf(search, FILTERS), [search]);
  const list = useAccessLog(filters);
  const pages = list.data?.pages;
  const first = pages?.[0];
  const rows = useMemo(() => (pages ?? []).flatMap((page) => page.items), [pages]);
  const state = useScreenState({ isLoading: list.isLoading, error: list.data === undefined ? list.error : undefined, data: list.data, isEmpty: NEVER_EMPTY });
  const applied = Object.keys(filters).length;
  const change = (next: Record<string, string | undefined>): void => setSearch(searchOf(next));

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('int.log.page.title')}</h1>
          <p>{t('int.log.page.subtitle')}</p>
        </div>
      </div>
      <p className="callout" data-testid="log-note">
        {t('int.log.note.names')}
      </p>
      <p className="callout" data-testid="bi-note">
        {t('int.log.note.bi')}
      </p>
      {state === 'denied' ? (
        <DeniedBlock title={t('int.log.denied.title')} body={t('int.log.denied.body')} />
      ) : (
        <SectionCard
          title={t('int.log.list.title')}
          status={
            first === undefined ? undefined : (
              <span>
                {t('int.log.list.asOf', { time: instantText(first.as_of) })}{' '}
                <CountInfo name={t('int.log.info.name')} formula={t('int.log.info.formula')} source={t('int.log.info.source')} asOf={instantText(first.as_of)} owner={t('int.log.info.owner')} />
              </span>
            )
          }
        >
          <FilterBar filters={filters} outcomes={first?.outcomes ?? []} onChange={change} />
          {state === 'error' || state === 'offline' || state === 'signedOut' || state === 'expired' ? (
            <ErrorBlock title={t('int.log.error.title')} body={t('int.log.error.body')} onRetry={() => void list.refetch()} />
          ) : first !== undefined && applied === 0 && rows.length === 0 ? (
            <EmptyBlock title={t('int.log.empty.title')} body={t('int.log.empty.body')} />
          ) : (
            <>
              <DataTable
                caption={t('int.log.table.caption')}
                columns={columns(t)}
                rows={rows}
                rowKey={(row) => row.id}
                rowAttrs={(row) => ({ 'data-entry-id': row.id, 'data-outcome': row.outcome })}
                state={state === 'loading' ? 'loading' : 'ready'}
                emptyKind={applied > 0 ? 'filtered' : 'none'}
                onClearFilters={() => change({})}
              />
              {first !== undefined && <MoreRow shown={rows.length} hasNext={list.hasNextPage} loading={list.isFetchingNextPage} failed={list.isFetchNextPageError} onMore={() => void list.fetchNextPage()} />}
            </>
          )}
        </SectionCard>
      )}
      <p className="prototype-note">{t('int.log.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function FilterBar({ filters, outcomes, onChange }: { filters: Record<string, string | undefined>; outcomes: string[]; onChange: (next: Record<string, string | undefined>) => void }) {
  const { t } = useTranslation();
  const [account, setAccount] = useState(filters.account_id ?? '');
  const [from, setFrom] = useState(filters.from ?? '');
  const [to, setTo] = useState(filters.to ?? '');
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    setAccount(filters.account_id ?? '');
    setFrom(filters.from ?? '');
    setTo(filters.to ?? '');
  }, [filters.account_id, filters.from, filters.to]);
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const bad = account.trim() !== '' && !UUID.test(account.trim());
    setInvalid(bad);
    if (bad) return;
    onChange({ ...filters, account_id: account.trim() === '' ? undefined : account.trim(), from: from === '' ? undefined : from, to: to === '' ? undefined : to });
  };
  return (
    <form className="int-filters" role="search" aria-label={t('int.log.filter.group.label')} onSubmit={submit}>
      <div className="field">
        <label htmlFor="int-log-outcome">{t('int.log.filter.outcome.label')}</label>
        <select id="int-log-outcome" value={filters.outcome ?? ''} onChange={(event) => onChange({ ...filters, outcome: event.target.value === '' ? undefined : event.target.value })}>
          <option value="">{t('int.log.filter.all.option')}</option>
          {outcomes.map((outcome) => (
            <option key={outcome} value={outcome}>
              {outcomeLabel(t, outcome)}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="int-log-account">{t('int.log.filter.account.label')}</label>
        <input id="int-log-account" value={account} aria-invalid={invalid} autoComplete="off" onChange={(event) => setAccount(event.target.value)} />
        {invalid && (
          <span className="int-error" role="alert">
            {t('int.log.filter.account.error')}
          </span>
        )}
      </div>
      <div className="field">
        <label htmlFor="int-log-from">{t('int.log.filter.from.label')}</label>
        <input id="int-log-from" type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="int-log-to">{t('int.log.filter.to.label')}</label>
        <input id="int-log-to" type="date" value={to} onChange={(event) => setTo(event.target.value)} />
      </div>
      <button type="submit" className="ui-button ui-button--outline">
        {t('int.log.filter.apply.action')}
      </button>
    </form>
  );
}

function columns(t: T): Array<DataTableColumn<Entry>> {
  const none = t('int.log.cell.none');
  return [
    { key: 'time', header: t('int.log.column.time'), pinned: true, render: (row) => instantText(row.occurred_at) },
    { key: 'account', header: t('int.log.column.account'), render: (row) => row.account_name },
    { key: 'operation', header: t('int.log.column.operation'), render: (row) => <code>{row.operation}</code> },
    { key: 'scope', header: t('int.log.column.scope'), render: (row) => row.scope ?? none },
    { key: 'path', header: t('int.log.column.path'), render: (row) => <code>{row.path}</code> },
    { key: 'keys', header: t('int.log.column.keys'), render: (row) => (row.query_keys.length === 0 ? none : row.query_keys.join(', ')) },
    { key: 'outcome', header: t('int.log.column.outcome'), render: (row) => <StatusPill tone={OUTCOME_TONE[row.outcome] ?? 'neutral'}>{outcomeLabel(t, row.outcome)}</StatusPill> },
    { key: 'status', header: t('int.log.column.status'), align: 'right', render: (row) => row.status },
    { key: 'rows', header: t('int.log.column.rows'), align: 'right', render: (row) => (row.row_count === null ? none : row.row_count) },
    { key: 'correlation', header: t('int.log.column.correlation'), render: (row) => <code>{row.correlation_id}</code> },
  ];
}
