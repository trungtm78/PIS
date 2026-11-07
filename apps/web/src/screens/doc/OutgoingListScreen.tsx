import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { listItems, useDraftList } from './drafts/hooks';
import type { DraftFilter } from './drafts/hooks';
import { DataTable, FilterPanel, StatusPill } from '../../ui';
import type { DataTableColumn } from '../../ui';
import { effectLabel, statusLabel, statusMark, statusTone } from './drafts/labels';
import { nextRoute } from './drafts/rules';
import { CREATE_DOCUMENT_PERMISSION, DOCUMENT_STATUSES, EDIT_DOCUMENT_PERMISSION, REVIEW_DOCUMENT_PERMISSION } from './drafts/types';
import type { DraftRow } from './drafts/types';
import './drafts/drafts.css';

const YEARS_BACK = 3;
const EDITOR_PATH = '/doc/doc-02';
const REVIEW_PATH = '/doc/doc-04';
const SIGNING_PATH = '/doc/doc-05';
const NUMBERING_PATH = '/doc/doc-06';
const SHORT_ID = 8;

const shortId = (id: string | null): string => (id === null || id === '' ? '' : id.slice(-SHORT_ID));

/** DOC-03: the outgoing documents the caller may see, with where each one stands and where its work goes next. */
export default function OutgoingListScreen({ route }: ScreenProps) {
  const tenantId = useSession().tenant?.id;
  // The filters and the list belong to one tenant: a switch starts the screen over.
  return <OutgoingListContent key={tenantId ?? 'none'} route={route} />;
}

function OutgoingListContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  // A suspended tenant (READ_ONLY mode) is read-only for everyone, whatever the grants say.
  const frozen = mode === 'READ_ONLY';
  const holds = (permission: string): boolean => (permissions === undefined || permissions.includes(permission)) && !frozen;
  const canCreate = holds(CREATE_DOCUMENT_PERMISSION);
  const thisYear = new Date().getFullYear();
  const years = Array.from({ length: YEARS_BACK + 1 }, (_, index) => String(thisYear - index));
  // A link from the overview (DOC-01) names the state it leads to; a state that is not one of ours is ignored.
  const [search] = useSearchParams();
  const named = DOCUMENT_STATUSES.find((status) => status === search.get('status'));
  const initial: DraftFilter = { status: named ?? '', docTypeCode: '', year: '' };
  const [draft, setDraft] = useState<DraftFilter>(initial);
  const [applied, setApplied] = useState<DraftFilter>(initial);
  const list = useDraftList(applied);
  const rows = useMemo(() => listItems(list.data), [list.data]);
  const state = useScreenState({ isLoading: list.isLoading, error: list.error, data: list.data === undefined ? undefined : rows });

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setApplied({ ...draft, docTypeCode: draft.docTypeCode.trim() });
  };

  const target = (row: DraftRow): { path: string; label: string } | undefined => {
    switch (nextRoute(row.status)) {
      case 'editor':
        return holds(EDIT_DOCUMENT_PERMISSION) ? { path: EDITOR_PATH, label: t('doc.list.open.edit') } : { path: EDITOR_PATH, label: t('doc.list.open.view') };
      case 'review':
        return holds(REVIEW_DOCUMENT_PERMISSION) ? { path: REVIEW_PATH, label: t('doc.list.open.review') } : { path: EDITOR_PATH, label: t('doc.list.open.view') };
      case 'signing':
        return { path: SIGNING_PATH, label: t('doc.list.open.sign') };
      case 'numbering':
        return { path: NUMBERING_PATH, label: t('doc.list.open.number') };
      case 'none':
        return { path: EDITOR_PATH, label: t('doc.list.open.view') };
    }
  };

  const columns: DataTableColumn<DraftRow>[] = [
    {
      key: 'number',
      header: t('doc.list.col.number'),
      pinned: true,
      render: (row) => (
        <>
          {row.symbol === null ? <span className="muted">{t('doc.list.number.pending')}</span> : <strong>{row.symbol}</strong>}
          <div className="sub">{row.docTypeCode}</div>
        </>
      ),
    },
    { key: 'summary', header: t('doc.list.col.summary'), render: (row) => row.title },
    {
      key: 'status',
      header: t('doc.list.col.status'),
      render: (row) => (
        <StatusPill tone={statusTone(row.status)} icon={statusMark(row.status)}>
          {statusLabel(t, row.status)}
        </StatusPill>
      ),
    },
    { key: 'drafter', header: t('doc.list.col.drafter'), render: (row) => <span title={row.drafterUserId}>{shortId(row.drafterUserId)}</span> },
    { key: 'signer', header: t('doc.list.col.signer'), render: (row) => <span title={row.signerUserId ?? undefined}>{shortId(row.signerUserId)}</span> },
    { key: 'issuedOn', header: t('doc.list.col.issuedOn'), render: (row) => row.issuedOn ?? '' },
    { key: 'effect', header: t('doc.list.col.effect'), render: (row) => (row.effectStatus === 'PENDING' ? '' : effectLabel(t, row.effectStatus)) },
    { key: 'source', header: t('doc.list.col.source'), render: (row) => row.sourceModule ?? '' },
    {
      key: 'actions',
      header: t('w2doc.list.col.actions'),
      render: (row) => {
        const open = target(row);
        return open === undefined ? null : (
          <Link to={`${open.path}?doc=${row.id}`} aria-label={t('doc.list.open.label', { title: row.title })}>
            {open.label}
          </Link>
        );
      },
    },
  ];
  const filtered = applied.status !== '' || applied.docTypeCode !== '' || applied.year !== '';
  const clear = (): void => {
    const none: DraftFilter = { status: '', docTypeCode: '', year: '' };
    setDraft(none);
    setApplied(none);
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title" className="doc-drafts">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('doc.list.page.title')}</h1>
          <p>{t('doc.list.page.subtitle')}</p>
        </div>
        <div className="actions">
          {canCreate ? (
            <Link className="ui-button ui-button--primary" to={EDITOR_PATH}>
              {t('doc.list.create.action')}
            </Link>
          ) : null}
        </div>
      </div>
      <FilterPanel applied={[applied.status, applied.docTypeCode, applied.year].filter((value) => value !== '').length}>
        <form className="doc-filter-form" onSubmit={submit}>
          <div>
            <label htmlFor="draft-status">{t('doc.list.status.label')}</label>
            <select id="draft-status" value={draft.status} onChange={(event) => setDraft({ ...draft, status: event.target.value })}>
              <option value="">{t('doc.list.status.all')}</option>
              {DOCUMENT_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {statusLabel(t, status)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="draft-type">{t('doc.list.type.label')}</label>
            <input id="draft-type" type="search" value={draft.docTypeCode} placeholder={t('doc.list.type.placeholder')} onChange={(event) => setDraft({ ...draft, docTypeCode: event.target.value })} />
          </div>
          <div>
            <label htmlFor="draft-year">{t('doc.list.year.label')}</label>
            <select id="draft-year" value={draft.year} onChange={(event) => setDraft({ ...draft, year: event.target.value })}>
              <option value="">{t('doc.list.year.all')}</option>
              {years.map((year) => (
                <option key={year} value={year}>
                  {year}
                </option>
              ))}
            </select>
          </div>
          <button type="submit" className="ui-button ui-button--outline">
            {t('doc.list.filter.action')}
          </button>
        </form>
      </FilterPanel>
      {frozen ? (
        <p className="callout warning" role="status">
          {t('doc.list.frozen.notice')}
        </p>
      ) : null}
      <StateBoundary state={state} onRetry={() => void list.refetch()}>
        <DataTable caption={t('w2doc.list.table.caption')} columns={columns} rows={rows} rowKey={(row) => row.id} rowAttrs={(row) => ({ 'data-document-id': row.id, 'data-status': row.status })} emptyKind={filtered ? 'filtered' : 'none'} onClearFilters={clear} />
        <div className="row between gap tiny muted doc-list-foot">
          <span>{t('doc.list.count.text', { count: rows.length })}</span>
          {list.hasNextPage ? (
            <button type="button" className="ui-button ui-button--outline ui-button--small" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
              {t('doc.list.more.action')}
            </button>
          ) : null}
        </div>
      </StateBoundary>
      <p className="prototype-note">{t('doc.list.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
