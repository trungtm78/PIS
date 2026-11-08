import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { Translator } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { useScreenState } from '../../states/useScreenState';
import { ContextBar, DataTable, SectionCard, StatusPill } from '../../ui';
import type { DataTableColumn } from '../../ui';
import { useFeedConnection, useFeedMappings, useUnmapped } from './feed-hooks';
import { MAPPING_ICON, MAPPING_TONE, mappingStatusLabel, methodLabel } from './feed-labels';
import { EMPTY_PROPOSE, MAPPING_STATUSES, PATHS, appliedFilters, dayText, mappingFiltersOf, mappingSearchOf, proposeFromUnmapped, totalOfMappings, vietnamStamp } from './feed-model';
import type { Mapping, MappingFilters, MappingPage, MappingStatus, ProposeForm, Unmapped } from './feed-model';
import { AcceptanceBadge, DASH, FeedLinks, Figure, ListState, PagingFoot, StaleNote } from './feed-parts';
import { MappingDialogs } from './mapping-dialogs';
import type { MappingDialog } from './mapping-dialogs';
import './feed.css';

type T = Translator['t'];

/**
 * FEED-03, the project codes of the Finance Department and the projects of ours they stand for, on `master_crosswalk`. A code stands for one project at a time; a mapping is proposed by one person and approved by another (the person who
 * proposed it does not approve it); a wrong mapping is retired with a reason and replaced by a new proposal, the history stays. The codes that no mapping holds yet are listed on top as the work that waits for a person.
 * The layout of the files the codes come from is a working assumption (PENDING-EXTERNAL).
 */
export default function MappingScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The filters, the dialogs and the receipt belong to one membership: a switch of tenant or of membership starts the screen over.
  return <MappingContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function MappingContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { mode, tenant } = useSession();
  const connection = useFeedConnection();
  const [search, setSearch] = useSearchParams();
  const filters = useMemo(() => mappingFiltersOf(search), [search]);
  const list = useFeedMappings(filters);
  const [dialog, setDialog] = useState<MappingDialog | undefined>(undefined);
  const [receipt, setReceipt] = useState<string | undefined>(undefined);
  const [nonce, setNonce] = useState(0);

  const frozen = mode === 'READ_ONLY';
  const actions = connection.data?.actions;
  const mayPropose = actions?.proposeMapping === true && !frozen;
  const pages = list.data?.pages;
  const first = pages?.[0];
  const rows = useMemo(() => (pages ?? []).flatMap((page) => page.items), [pages]);
  const applied = appliedFilters(filters);
  const state = useScreenState({ isLoading: list.isLoading, error: list.data === undefined ? list.error : undefined, data: list.data, isEmpty: () => rows.length === 0 && applied === 0 && first !== undefined && totalOfMappings(first.counts) === 0 });
  const denied = state === 'denied';
  const refreshFailed = list.isError && list.data !== undefined && !list.isFetchNextPageError;
  const mine = (row: Mapping): boolean => row.proposedBy !== null && row.proposedBy === tenant?.membershipId;
  const change = (next: MappingFilters): void => setSearch(mappingSearchOf(next));
  const openPropose = (form: ProposeForm = EMPTY_PROPOSE, fixedExternal = false): void => {
    setReceipt(undefined);
    setNonce((value) => value + 1);
    setDialog({ kind: 'propose', form, nonce: nonce + 1, fixedExternal });
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title" className="feed-page">
      <div className="feed-head">
        <div>
          <h1 id="screen-title">{t('feed.mapping.page.title')}</h1>
          <p>{t('feed.mapping.page.subtitle')}</p>
          <FeedLinks current="mapping" />
          <div className="feed-badges">
            <AcceptanceBadge acceptance={connection.data?.acceptance ?? 'PENDING_EXTERNAL'} />
          </div>
        </div>
        {mayPropose && !denied && (
          <div className="feed-actions">
            <button type="button" className="ui-button ui-button--primary" onClick={() => openPropose()}>
              {t('feed.mapping.action.propose')}
            </button>
          </div>
        )}
      </div>
      <ContextBar items={[{ label: t('feed.mapping.context.scope.label'), value: tenant?.name ?? '' }]} {...(first?.asOf === undefined || first.asOf === null ? {} : { asOf: vietnamStamp(first.asOf) })} stale={refreshFailed} />
      <p className="callout" data-testid="maker-note">
        {t('feed.mapping.note.maker')}
      </p>
      {receipt !== undefined && (
        <p className="callout feed-receipt" role="status" data-testid="receipt">
          {receipt}
        </p>
      )}
      {!mayPropose && !denied && connection.data !== undefined && (
        <p className="callout" role="status" data-testid="readonly-note">
          {frozen ? t('feed.common.readonly.mode') : t('feed.common.readonly.right')}
        </p>
      )}
      {refreshFailed && <StaleNote asOf={first?.asOf ?? null} onRetry={() => void list.refetch()} />}
      {denied ? (
        <ListState state="denied" onRetry={() => void list.refetch()} />
      ) : (
        <>
          <UnmappedSection canPropose={mayPropose} onPropose={(item) => openPropose(proposeFromUnmapped(item), true)} />
          <SectionCard title={t('feed.mapping.list.title')}>
            {first !== undefined && (totalOfMappings(first.counts) > 0 || applied > 0) && <Chips filters={filters} page={first} onChange={change} />}
            <FilterBar filters={filters} onChange={change} />
            <ListState
              state={state}
              onRetry={() => void list.refetch()}
              empty={
                <div className="feed-state" role="status" data-testid="empty">
                  <h2>{t('feed.mapping.empty.title')}</h2>
                  <p>{t('feed.mapping.empty.body')}</p>
                  <Link to={PATHS.runs}>{t('feed.mapping.empty.import.link')}</Link>
                </div>
              }
            />
            {state === 'default' && (
              <>
                <DataTable
                  caption={t('feed.mapping.table.caption')}
                  columns={columns(t, first, { decide: !frozen, retire: mayPropose }, mine, (next) => setDialog(next))}
                  rows={rows}
                  rowKey={(row) => row.id}
                  rowAttrs={(row) => ({ 'data-mapping-id': row.id, 'data-status': row.status, 'data-external-code': row.externalCode })}
                  severity={(row) => (row.canDecide && !frozen ? 'ACTION' : null)}
                  emptyKind={applied > 0 ? 'filtered' : 'none'}
                  onClearFilters={() => change({})}
                />
                <PagingFoot shown={rows.length} hasMore={list.hasNextPage} loadingMore={list.isFetchingNextPage} failedMore={list.isFetchNextPageError} onMore={() => void list.fetchNextPage()} />
              </>
            )}
          </SectionCard>
        </>
      )}
      <MappingDialogs dialog={dialog} onClose={() => setDialog(undefined)} onDone={(text) => setReceipt(text)} />
      <p className="prototype-note">{t('feed.common.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

/** The project codes of the Finance Department that no mapping holds: the work that waits for a person. A list that is cut says how many there are in all (partial). */
function UnmappedSection({ canPropose, onPropose }: { canPropose: boolean; onPropose: (item: Unmapped) => void }) {
  const { t, locale } = useTranslation();
  const query = useUnmapped();
  const data = query.data;
  const state = useScreenState({ isLoading: query.isLoading, error: data === undefined ? query.error : undefined, data, isEmpty: () => data?.items.length === 0 });
  return (
    <SectionCard
      title={t('feed.mapping.unmapped.title')}
      status={data === undefined ? undefined : <StatusPill tone={data.total > 0 ? 'warning' : 'success'}>{t('feed.mapping.unmapped.total.text', { count: data.total.toLocaleString(locale) })}</StatusPill>}
    >
      <p className="feed-note">
        {t('feed.mapping.unmapped.intro.text')}{' '}
        <Figure
          name={t('feed.mapping.unmapped.figure.name')}
          formula={t('feed.mapping.unmapped.figure.formula')}
          source={t('feed.mapping.unmapped.figure.source')}
          asOf={vietnamStamp(data?.asOf ?? null)}
        />
      </p>
      <ListState
        state={state}
        onRetry={() => void query.refetch()}
        empty={
          <p className="feed-none" role="status" data-testid="unmapped-empty">
            {t('feed.mapping.unmapped.empty.text')}
          </p>
        }
      />
      {state === 'default' && data !== undefined && (
        <>
          <DataTable<Unmapped>
            caption={t('feed.mapping.unmapped.caption')}
            rows={data.items}
            rowKey={(row) => row.feedProjectCode}
            rowAttrs={(row) => ({ 'data-external-code': row.feedProjectCode })}
            columns={[
              { key: 'code', header: t('feed.mapping.unmapped.column.code'), pinned: true, render: (row) => <span className="feed-code">{row.feedProjectCode}</span> },
              { key: 'name', header: t('feed.mapping.unmapped.column.name'), render: (row) => row.projectName ?? DASH },
              { key: 'investor', header: t('feed.mapping.unmapped.column.investor'), render: (row) => row.investorCode ?? DASH },
              { key: 'hint', header: t('feed.mapping.unmapped.column.hint'), render: (row) => row.ourCodeHint ?? t('feed.mapping.unmapped.hint.none') },
              { key: 'asOf', header: t('feed.mapping.unmapped.column.asOf'), render: (row) => dayText(row.asOfStatement) },
              {
                key: 'action',
                header: t('feed.mapping.unmapped.column.action'),
                render: (row) =>
                  canPropose ? (
                    <button type="button" className="ui-button ui-button--primary ui-button--small" aria-label={t('feed.mapping.unmapped.propose.label', { code: row.feedProjectCode })} onClick={() => onPropose(row)}>
                      {t('feed.mapping.unmapped.propose.action')}
                    </button>
                  ) : (
                    DASH
                  ),
              },
            ]}
          />
          {data.total > data.items.length && (
            <p className="sub" role="status" data-testid="unmapped-partial">
              {t('feed.mapping.unmapped.partial.text', { shown: data.items.length, total: data.total })}
            </p>
          )}
        </>
      )}
    </SectionCard>
  );
}

/** The state of the mappings as chips, each with its count: a press sets the status in the address, "all" clears it. */
function Chips({ filters, page, onChange }: { filters: MappingFilters; page: MappingPage; onChange: (next: MappingFilters) => void }) {
  const { t } = useTranslation();
  const choose = (status: MappingStatus | undefined): void => {
    const next: MappingFilters = { ...filters };
    if (status === undefined) delete next.status;
    else next.status = status;
    onChange(next);
  };
  return (
    <fieldset className="feed-chips">
      <legend>{t('feed.mapping.chip.group.label')}</legend>
      <button type="button" className="feed-chip" aria-pressed={filters.status === undefined} onClick={() => choose(undefined)}>
        {t('feed.mapping.chip.all', { count: totalOfMappings(page.counts) })}
      </button>
      {MAPPING_STATUSES.map((status) => (
        <button key={status} type="button" className="feed-chip" aria-pressed={filters.status === status} onClick={() => choose(status)}>
          {t('feed.mapping.chip.label', { label: mappingStatusLabel(t, status), count: page.counts[status] })}
        </button>
      ))}
    </fieldset>
  );
}

/** The free text; the status is the chips. They live in the address, so a link keeps the view. */
function FilterBar({ filters, onChange }: { filters: MappingFilters; onChange: (next: MappingFilters) => void }) {
  const { t } = useTranslation();
  const [text, setText] = useState(filters.q ?? '');
  useEffect(() => setText(filters.q ?? ''), [filters.q]);
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const next: MappingFilters = { ...filters };
    if (text.trim() === '') delete next.q;
    else next.q = text.trim();
    onChange(next);
  };
  return (
    <form className="feed-filters" role="search" aria-label={t('feed.mapping.filter.group.label')} onSubmit={submit}>
      <div className="field">
        <label htmlFor="feed-mapping-q">{t('feed.mapping.filter.q.label')}</label>
        <input id="feed-mapping-q" type="search" value={text} autoComplete="off" onChange={(event) => setText(event.target.value)} />
      </div>
      <button type="submit" className="ui-button ui-button--outline">
        {t('feed.mapping.filter.apply.action')}
      </button>
    </form>
  );
}

function columns(t: T, page: MappingPage | undefined, can: { decide: boolean; retire: boolean }, mine: (row: Mapping) => boolean, open: (dialog: MappingDialog) => void): Array<DataTableColumn<Mapping>> {
  const none = t('feed.mapping.cell.none');
  const person = (name: string | null): string => name ?? none;
  const asOf = vietnamStamp(page?.asOf ?? null);
  return [
    {
      key: 'external',
      header: t('feed.mapping.column.external'),
      pinned: true,
      render: (row) => (
        <span className="feed-cell">
          <span className="feed-code">{row.externalCode}</span>
        </span>
      ),
    },
    {
      key: 'ours',
      header: t('feed.mapping.column.ours'),
      render: (row) => (
        <span className="feed-cell">
          <span className="feed-code">{row.ourCode}</span>
          {row.ourName !== null && <small>{row.ourName}</small>}
        </span>
      ),
    },
    { key: 'method', header: t('feed.mapping.column.method'), render: (row) => methodLabel(t, row.matchMethod) },
    { key: 'validity', header: t('feed.mapping.column.validity'), render: (row) => t('feed.mapping.cell.validity', { from: dayText(row.validFrom), until: row.validUntil === null ? t('feed.mapping.cell.unlimited') : dayText(row.validUntil) }) },
    {
      key: 'status',
      header: t('feed.mapping.column.status'),
      render: (row) => (
        <span className="feed-stack">
          <StatusPill tone={MAPPING_TONE[row.status]} icon={MAPPING_ICON[row.status]}>
            {mappingStatusLabel(t, row.status)}
          </StatusPill>
          <Figure
            name={t('feed.mapping.figure.status.name')}
            formula={t('feed.mapping.figure.status.formula')}
            source={t('feed.mapping.figure.status.source')}
            asOf={asOf}
            version={t('feed.mapping.figure.status.version', { version: row.version })}
          />
        </span>
      ),
    },
    {
      key: 'people',
      header: t('feed.mapping.column.people'),
      render: (row) => {
        const reason = row.retireReason ?? row.decisionReason ?? row.proposalReason;
        return (
          <span className="feed-cell">
            <small data-testid="proposed-by">{t('feed.mapping.cell.proposed', { name: person(row.proposedByName), day: row.createdAt === null ? none : dayText(row.createdAt) })}</small>
            {row.status !== 'PROPOSED' && row.approvedByName !== null && (
              <small data-testid="decided-by">{t(row.status === 'REJECTED' ? 'feed.mapping.cell.rejected' : 'feed.mapping.cell.approved', { name: row.approvedByName, day: row.approvedAt === null ? none : dayText(row.approvedAt) })}</small>
            )}
            {row.retiredByName !== null && <small data-testid="retired-by">{t('feed.mapping.cell.retired', { name: row.retiredByName, day: row.retiredAt === null ? none : dayText(row.retiredAt) })}</small>}
            {reason !== null && <small>{t('feed.mapping.cell.reason', { reason })}</small>}
          </span>
        );
      },
    },
    {
      key: 'actions',
      header: t('feed.mapping.column.actions'),
      render: (row) => {
        const codes = { ours: row.ourCode, external: row.externalCode };
        const decide = can.decide && row.canDecide;
        const retire = can.retire && row.canRetire;
        return (
          <span className="feed-row-actions">
            {decide && (
              <>
                <button type="button" className="ui-button ui-button--primary ui-button--small" aria-label={t('feed.mapping.action.approve.label', codes)} onClick={() => open({ kind: 'decide', row, decision: 'APPROVE' })}>
                  {t('feed.mapping.action.approve')}
                </button>
                <button type="button" className="ui-button ui-button--outline ui-button--small" aria-label={t('feed.mapping.action.reject.label', codes)} onClick={() => open({ kind: 'decide', row, decision: 'REJECT' })}>
                  {t('feed.mapping.action.reject')}
                </button>
              </>
            )}
            {retire && (
              <button type="button" className="ui-button ui-button--outline ui-button--small" aria-label={t('feed.mapping.action.retire.label', codes)} onClick={() => open({ kind: 'retire', row })}>
                {t('feed.mapping.action.retire')}
              </button>
            )}
            {row.status === 'PROPOSED' && !decide && (
              <span className="feed-words" data-testid={mine(row) ? 'maker-words' : 'waiting-words'}>
                {mine(row) ? t('feed.mapping.row.selfApproval') : t('feed.mapping.row.waiting')}
              </span>
            )}
          </span>
        );
      },
    },
  ];
}
