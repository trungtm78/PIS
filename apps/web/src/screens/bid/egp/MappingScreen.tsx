import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { Translator } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { useScreenState } from '../../../states/useScreenState';
import { DataTable, SectionCard, StatusPill } from '../../../ui';
import type { DataTableColumn, Tone } from '../../../ui';
import { Likeness } from './MappingInfo';
import { MappingDialogs } from './MappingDialogs';
import type { MappingDialog } from './MappingDialogs';
import { MappingSuggestions } from './MappingSuggestions';
import { useMappings } from './mapping-hooks';
import { methodLabel, statusLabel, subjectLabel } from './mapping-labels';
import { EMPTY_FORM, MAP_PERMISSION, STATUSES, SUBJECT_TYPES, appliedCount, dayText, filtersOf, instantDay, likenessText, methodKind, searchOf, totalOf } from './mapping-model';
import type { Filters, MappingPage, MappingRow, MappingStatus, SubjectType } from './mapping-model';
import './mapping.css';

type T = Translator['t'];

const STATUS_TONE: Readonly<Record<MappingStatus, Tone>> = { PROPOSED: 'info', ACTIVE: 'success', REJECTED: 'danger', RETIRED: 'neutral' };
const STATUS_ICON: Readonly<Record<MappingStatus, string>> = { PROPOSED: '◔', ACTIVE: '✓', REJECTED: '✕', RETIRED: '○' };
const NEVER_EMPTY = (): boolean => false;
const BID_IMPORT_PATH = '/bid/bid-24';

/**
 * BID-23, "Ánh xạ mã hệ thống mạng đấu thầu quốc gia" (EGP-1): the codes of the national bidding network and the records of ours they stand for, on `master_crosswalk`. A code stands for one record at a time;
 * a mapping is proposed by one person and approved by another; a suggestion by name and price is a hint a person confirms, never a link; a record that holds another code is not relinked silently.
 * The layout of the files the codes come from is a working assumption (PENDING-EXTERNAL).
 */
export default function MappingScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The filters, the dialogs and the receipt belong to one membership: a switch of tenant or of membership starts the screen over.
  return <MappingContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function MappingContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode, tenant, identity } = useSession();
  const [search, setSearch] = useSearchParams();
  const filters = useMemo(() => filtersOf(search), [search]);
  const list = useMappings(filters);
  const [dialog, setDialog] = useState<MappingDialog | undefined>(undefined);
  const [receipt, setReceipt] = useState<string | undefined>(undefined);
  const [nonce, setNonce] = useState(0);

  const frozen = mode === 'READ_ONLY';
  const mayPropose = (permissions === undefined || permissions.includes(MAP_PERMISSION)) && !frozen;
  const pages = list.data?.pages;
  const first = pages?.[0];
  const rows = useMemo(() => (pages ?? []).flatMap((page) => page.items), [pages]);
  const state = useScreenState({ isLoading: list.isLoading, error: list.data === undefined ? list.error : undefined, data: list.data, isEmpty: NEVER_EMPTY });
  const applied = appliedCount(filters);
  const mine = (row: MappingRow): boolean => row.proposedBy !== null && (row.proposedBy === tenant?.membershipId || row.proposedBy === identity?.subject);

  const change = (next: Filters): void => setSearch(searchOf(next));
  const openPropose = (form = EMPTY_FORM): void => {
    setReceipt(undefined);
    setNonce((value) => value + 1);
    setDialog({ kind: 'propose', form, nonce: nonce + 1 });
  };
  const denied = state === 'denied';

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('egp.mapping.page.title')}</h1>
          <p>{t('egp.mapping.page.subtitle')}</p>
          <div className="mapping-badges">
            <span className="bid-badge warning" data-testid="assumption-badge">
              {t('egp.mapping.badge.assumption')}
            </span>
          </div>
        </div>
        {mayPropose && !denied && (
          <div className="actions mapping-actions">
            <button type="button" className="ui-button ui-button--primary" onClick={() => openPropose()}>
              {t('egp.mapping.action.propose')}
            </button>
          </div>
        )}
      </div>
      <p className="callout" data-testid="relink-note">
        {t('egp.mapping.note.relink')}
      </p>
      {receipt !== undefined && (
        <p className="callout mapping-receipt" role="status" data-testid="receipt">
          {receipt}
        </p>
      )}
      {!mayPropose && !denied && (
        <p className="callout" role="status" data-testid="readonly-note">
          {t('egp.mapping.readonly.notice')}
        </p>
      )}
      {denied ? (
        <div className="mapping-state mapping-state--denied" role="alert" data-testid="denied">
          <h2>{t('egp.mapping.denied.title')}</h2>
          <p>{t('egp.mapping.denied.body')}</p>
        </div>
      ) : (
        <>
          <MappingSuggestions canPropose={mayPropose} onPropose={(form) => openPropose(form)} />
          <SectionCard title={t('egp.mapping.list.title')} status={first === undefined ? undefined : <span>{t('egp.mapping.list.asOf', { day: instantDay(first.asOf) })}</span>}>
            {first !== undefined && (totalOf(first.counts) > 0 || applied > 0) && <Chips filters={filters} page={first} onChange={change} />}
            <FilterBar filters={filters} onChange={change} />
            {state === 'error' || state === 'offline' || state === 'signedOut' || state === 'expired' ? (
              <div className="mapping-state mapping-state--error" role="alert" data-testid="error">
                <h2>{t('egp.mapping.error.title')}</h2>
                <p>{t('egp.mapping.error.body')}</p>
                <button type="button" className="ui-button ui-button--outline" onClick={() => void list.refetch()}>
                  {t('states.retry.action')}
                </button>
              </div>
            ) : first !== undefined && applied === 0 && totalOf(first.counts) === 0 && rows.length === 0 ? (
              <div className="mapping-state" role="status" data-testid="empty">
                <h2>{t('egp.mapping.empty.title')}</h2>
                <p>{t('egp.mapping.empty.body')}</p>
                <Link to={BID_IMPORT_PATH}>{t('egp.mapping.empty.import.link')}</Link>
              </div>
            ) : (
              <>
                <DataTable
                  caption={t('egp.mapping.table.caption')}
                  columns={columns(t, first, { decide: !frozen, retire: mayPropose }, mine, (next) => setDialog(next))}
                  rows={rows}
                  rowKey={(row) => row.id}
                  rowAttrs={(row) => ({ 'data-mapping-id': row.id, 'data-status': row.status, 'data-external-code': row.externalCode })}
                  severity={(row) => (row.canDecide && !frozen ? 'ACTION' : null)}
                  state={state === 'loading' ? 'loading' : 'ready'}
                  emptyKind={applied > 0 ? 'filtered' : 'none'}
                  onClearFilters={() => change({})}
                />
                {first !== undefined && (
                  <div className="mapping-more">
                    <span className="sub" role="status" data-testid="shown">
                      {t('egp.mapping.paging.summary', { shown: rows.length })}
                    </span>
                    {list.isFetchNextPageError && <span role="alert">{t('egp.mapping.paging.error')}</span>}
                    {list.hasNextPage && (
                      <button type="button" className="ui-button ui-button--outline" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
                        {list.isFetchingNextPage ? t('egp.mapping.paging.loading') : t('egp.mapping.paging.more')}
                      </button>
                    )}
                  </div>
                )}
              </>
            )}
          </SectionCard>
        </>
      )}
      <MappingDialogs
        dialog={dialog}
        onClose={() => setDialog(undefined)}
        onDone={(text) => {
          setReceipt(text);
        }}
      />
      <p className="prototype-note">{t('egp.mapping.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

/** The state of the mappings as chips, each with its count: a press sets the status in the address, "all" clears it. */
function Chips({ filters, page, onChange }: { filters: Filters; page: MappingPage; onChange: (next: Filters) => void }) {
  const { t } = useTranslation();
  const choose = (status: MappingStatus | undefined): void => {
    const next: Filters = { ...filters };
    if (status === undefined) delete next.status;
    else next.status = status;
    onChange(next);
  };
  return (
    <fieldset className="mapping-chips">
      <legend>{t('egp.mapping.chip.group.label')}</legend>
      <button type="button" className="mapping-chip" aria-pressed={filters.status === undefined} onClick={() => choose(undefined)}>
        {t('egp.mapping.chip.all', { count: totalOf(page.counts) })}
      </button>
      {STATUSES.map((status) => (
        <button key={status} type="button" className="mapping-chip" aria-pressed={filters.status === status} onClick={() => choose(status)}>
          {t('egp.mapping.chip.label', { label: statusLabel(t, status), count: page.counts[status] })}
        </button>
      ))}
    </fieldset>
  );
}

/** The subject and the free text; the status is the chips. They live in the address, so a link keeps the view. */
function FilterBar({ filters, onChange }: { filters: Filters; onChange: (next: Filters) => void }) {
  const { t } = useTranslation();
  const [text, setText] = useState(filters.q ?? '');
  useEffect(() => setText(filters.q ?? ''), [filters.q]);
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const next: Filters = { ...filters };
    if (text.trim() === '') delete next.q;
    else next.q = text.trim();
    onChange(next);
  };
  return (
    <form className="mapping-filters" role="search" aria-label={t('egp.mapping.filter.group.label')} onSubmit={submit}>
      <div className="field">
        <label htmlFor="mapping-filter-subject">{t('egp.mapping.filter.subject.label')}</label>
        <select
          id="mapping-filter-subject"
          value={filters.subject_type ?? ''}
          onChange={(event) => {
            const next: Filters = { ...filters };
            if (event.target.value === '') delete next.subject_type;
            else next.subject_type = event.target.value as SubjectType;
            onChange(next);
          }}
        >
          <option value="">{t('egp.mapping.filter.all.option')}</option>
          {SUBJECT_TYPES.map((subject) => (
            <option key={subject} value={subject}>
              {subjectLabel(t, subject)}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="mapping-filter-q">{t('egp.mapping.filter.q.label')}</label>
        <input id="mapping-filter-q" type="search" value={text} autoComplete="off" onChange={(event) => setText(event.target.value)} />
      </div>
      <button type="submit" className="ui-button ui-button--outline">
        {t('egp.mapping.filter.apply.action')}
      </button>
    </form>
  );
}

function columns(t: T, page: MappingPage | undefined, can: { decide: boolean; retire: boolean }, mine: (row: MappingRow) => boolean, open: (dialog: MappingDialog) => void): Array<DataTableColumn<MappingRow>> {
  const none = t('egp.mapping.cell.none');
  const person = (name: string | null): string => name ?? none;
  return [
    { key: 'subject', header: t('egp.mapping.column.subject'), pinned: true, render: (row) => subjectLabel(t, row.subjectType) },
    {
      key: 'ours',
      header: t('egp.mapping.column.ours'),
      render: (row) => (
        <span className="mapping-cell">
          {row.ourCode === null ? <span>{t('egp.mapping.cell.noOurCode')}</span> : <span className="mapping-code">{row.ourCode}</span>}
          {row.projectCode !== null && <small>{t('egp.mapping.cell.project', { code: row.projectCode })}</small>}
        </span>
      ),
    },
    {
      key: 'external',
      header: t('egp.mapping.column.external'),
      render: (row) => (
        <span className="mapping-cell">
          <span className="mapping-code">{row.externalCode}</span>
          <small>{row.externalType}</small>
        </span>
      ),
    },
    { key: 'method', header: t('egp.mapping.column.method'), render: (row) => methodLabel(t, methodKind(row)) },
    {
      key: 'confidence',
      header: t('egp.mapping.column.confidence'),
      align: 'right',
      render: (row) =>
        row.confidence === null ? (
          none
        ) : (
          <span className="mapping-candidate__likeness">
            <ConfidenceNumber value={row.confidence} />
            <Likeness asOf={page?.asOf ?? ''} />
          </span>
        ),
    },
    { key: 'validity', header: t('egp.mapping.column.validity'), render: (row) => t('egp.mapping.cell.validity', { from: dayText(row.validFrom), until: row.validUntil === null ? t('egp.mapping.cell.unlimited') : dayText(row.validUntil) }) },
    {
      key: 'status',
      header: t('egp.mapping.column.status'),
      render: (row) => (
        <StatusPill tone={STATUS_TONE[row.status]} icon={STATUS_ICON[row.status]}>
          {statusLabel(t, row.status)}
        </StatusPill>
      ),
    },
    {
      key: 'people',
      header: t('egp.mapping.column.people'),
      render: (row) => {
        const reason = row.retireReason ?? row.decisionReason ?? row.proposalReason;
        return (
          <span className="mapping-people">
            <small data-testid="proposed-by">{t('egp.mapping.cell.proposed', { name: person(row.proposedByName), day: row.createdAt === null ? none : instantDay(row.createdAt) })}</small>
            {row.status !== 'PROPOSED' && row.approvedByName !== null && (
              <small data-testid="decided-by">{t(row.status === 'REJECTED' ? 'egp.mapping.cell.rejected' : 'egp.mapping.cell.approved', { name: row.approvedByName, day: row.approvedAt === null ? none : instantDay(row.approvedAt) })}</small>
            )}
            {row.retiredByName !== null && <small data-testid="retired-by">{t('egp.mapping.cell.retired', { name: row.retiredByName, day: row.retiredAt === null ? none : instantDay(row.retiredAt) })}</small>}
            {reason !== null && <small>{t('egp.mapping.cell.reason', { reason })}</small>}
          </span>
        );
      },
    },
    {
      key: 'actions',
      header: t('egp.mapping.column.actions'),
      render: (row) => {
        const codes = { ours: row.ourCode ?? none, external: row.externalCode };
        const decide = can.decide && row.canDecide;
        const retire = can.retire && row.canRetire;
        return (
          <span className="mapping-row-actions">
            {decide && (
              <>
                <button type="button" className="ui-button ui-button--primary ui-button--small" aria-label={t('egp.mapping.action.approve.label', codes)} onClick={() => open({ kind: 'decide', row, decision: 'APPROVE' })}>
                  {t('egp.mapping.action.approve')}
                </button>
                <button type="button" className="ui-button ui-button--outline ui-button--small" aria-label={t('egp.mapping.action.reject.label', codes)} onClick={() => open({ kind: 'decide', row, decision: 'REJECT' })}>
                  {t('egp.mapping.action.reject')}
                </button>
              </>
            )}
            {retire && (
              <button type="button" className="ui-button ui-button--outline ui-button--small" aria-label={t('egp.mapping.action.retire.label', codes)} onClick={() => open({ kind: 'retire', row })}>
                {t('egp.mapping.action.retire')}
              </button>
            )}
            {row.status === 'PROPOSED' && !decide && (
              <span className="mapping-words" data-testid={mine(row) ? 'maker-words' : 'waiting-words'}>
                {mine(row) ? t('egp.mapping.row.selfApproval') : t('egp.mapping.row.waiting')}
              </span>
            )}
          </span>
        );
      },
    },
  ];
}

function ConfidenceNumber({ value }: { value: number }) {
  const { locale } = useTranslation();
  return <span>{likenessText(value, locale)}</span>;
}
