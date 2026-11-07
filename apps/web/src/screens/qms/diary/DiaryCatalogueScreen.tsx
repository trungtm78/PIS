import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { ContextBar, DataTable, FilterPanel, StatusPill } from '../../../ui';
import type { DataTableColumn } from '../../../ui';
import { useContracts } from '../../ctr/hooks';
import { NewDiaryDialog } from './DiaryDialogs';
import { useDiaries } from './hooks';
import { roleLabel, statusLabel } from './labels';
import { DIARY_ROLES, DIARY_STATUSES, NO_FILTER, canWrite, composeLink, pendingConflicts, reviewLink, vietnamToday } from './model';
import type { DiaryFilter, DiaryLine, DiaryStatus } from './model';
import '../qms.css';

/**
 * QMS-01: the catalogue of the site diaries (ST-QMS-001, QMS 3.1, BR-QMS-01, BR-QMS-03). One diary per contract and day, newest day first, with who has signed it so far (the contractor, then the
 * supervisor, then the owner). Drafting a diary opens it on QMS-02; the diaries that wait for the supervisor or the owner are on QMS-03. The server judges every command again.
 */
export default function DiaryCatalogueScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The list and the dialogs belong to one membership: a switch of tenant or of membership starts the screen over.
  return <CatalogueContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function CatalogueContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode, tenant } = useSession();
  const navigate = useNavigate();
  const contracts = useContracts();
  const options = useMemo(() => contracts.data ?? [], [contracts.data]);
  const [filter, setFilter] = useState<DiaryFilter>(NO_FILTER);
  const [creating, setCreating] = useState(false);
  const list = useDiaries(filter);
  const lines = useMemo(() => (list.data?.pages ?? []).flatMap((page) => page.lines), [list.data]);
  // A tenant with no diary is not an empty screen: the contractor still drafts the first.
  const state = useScreenState({ isLoading: list.isLoading, error: list.error, data: list.data, isEmpty: () => false });
  const writable = canWrite(permissions, mode);
  const change = (next: Partial<DiaryFilter>): void => setFilter({ ...filter, ...next });
  const applied = [filter.contractId !== '', filter.status !== '', filter.hasConflict, filter.from !== '', filter.to !== ''].filter(Boolean).length;

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('qms.diary.catalogue.title')}</h1>
          <p>{t('qms.diary.catalogue.subtitle')}</p>
        </div>
        {writable ? (
          <div className="actions">
            <button type="button" className="ui-button ui-button--primary" onClick={() => setCreating(true)}>
              {t('qms.diary.new.action')}
            </button>
          </div>
        ) : null}
      </div>
      <ContextBar items={[{ label: t('w2iss.ctx.scope'), value: tenant?.name ?? t('w2iss.ctx.scope.all') }]} />
      <FilterPanel
        applied={applied}
        actions={
          applied === 0 ? undefined : (
            <button type="button" className="ui-button ui-button--outline" onClick={() => setFilter(NO_FILTER)}>
              {t('w2iss.qms.filter.clear')}
            </button>
          )
        }
      >
        <div className="qms-filters">
          <div className="field">
            <label htmlFor="diary-filter-contract">{t('qms.diary.field.contract')}</label>
            <select id="diary-filter-contract" value={filter.contractId} onChange={(event) => change({ contractId: event.target.value })}>
              <option value="">{t('qms.diary.filter.allContracts')}</option>
              {options.map((contract) => (
                <option key={contract.id} value={contract.id}>
                  {contract.title === null ? contract.code : `${contract.code} · ${contract.title}`}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="diary-filter-status">{t('qms.diary.column.status')}</label>
            <select id="diary-filter-status" value={filter.status} onChange={(event) => change({ status: event.target.value })}>
              <option value="">{t('qms.diary.filter.allStatuses')}</option>
              {DIARY_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {statusLabel(t, status)}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="diary-filter-conflict">
              <input id="diary-filter-conflict" type="checkbox" checked={filter.hasConflict} onChange={(event) => change({ hasConflict: event.target.checked })} /> {t('qms.diary.filter.conflict')}
            </label>
          </div>
          <div className="field">
            <label htmlFor="diary-filter-from">{t('qms.diary.filter.from')}</label>
            <input id="diary-filter-from" type="date" value={filter.from} onChange={(event) => change({ from: event.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="diary-filter-to">{t('qms.diary.filter.to')}</label>
            <input id="diary-filter-to" type="date" value={filter.to} onChange={(event) => change({ to: event.target.value })} />
          </div>
        </div>
      </FilterPanel>
      <StateBoundary state={state} onRetry={() => void list.refetch()}>
        {lines.length === 0 ? (
          <p className="callout" role="status" data-testid="no-diaries">
            {t('qms.diary.none.notice')}
          </p>
        ) : (
          <div data-testid="diaries">
            <DiaryTable lines={lines} />
          </div>
        )}
        {list.hasNextPage ? (
          <p>
            <button type="button" className="ui-button ui-button--outline" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
              {t('qms.diary.more.action')}
            </button>
          </p>
        ) : null}
      </StateBoundary>
      {creating ? (
        <NewDiaryDialog
          contracts={options.filter((contract) => contract.status === 'ACTIVE')}
          today={vietnamToday()}
          initialContract={options.some((contract) => contract.id === filter.contractId) ? filter.contractId : ''}
          onClose={() => setCreating(false)}
          onSaved={(id) => {
            setCreating(false);
            if (id !== '') navigate(composeLink(id));
          }}
        />
      ) : null}
      <p className="prototype-note">{t('qms.diary.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

const STATUS_TONE: Readonly<Record<DiaryStatus, 'neutral' | 'info' | 'success' | 'warning'>> = {
  DRAFT: 'neutral',
  CONTRACTOR_SIGNED: 'info',
  SUPERVISED: 'info',
  OWNER_CONFIRMED: 'success',
  LOCKED: 'success',
  SUPERSEDED: 'warning',
};

/** The diaries, newest day first as the server answers: the number and the contract, the day, the three signatures in the order they are made, the status and the way to the diary. */
function DiaryTable({ lines }: { lines: DiaryLine[] }) {
  const { t } = useTranslation();
  const columns: DataTableColumn<DiaryLine>[] = [
    {
      key: 'diary',
      header: t('qms.diary.column.diary'),
      pinned: true,
      render: (line) => (
        <span data-testid="diary" data-diary={line.id}>
          <strong>{line.diaryNo}</strong>
          <small className="sub qms-regime">{line.contract.code}</small>
          <span className="qms-chips">
            {line.correctionOfId === null ? null : <StatusPill tone="neutral">{t('qms.diary.correction.badge')}</StatusPill>}
            {pendingConflicts(line).length === 0 ? null : (
              <span data-testid="conflicts-waiting">
                <StatusPill tone="warning">{t('qms.diary.conflicts.count', { count: pendingConflicts(line).length })}</StatusPill>
              </span>
            )}
          </span>
        </span>
      ),
    },
    { key: 'day', header: t('qms.diary.column.day'), render: (line) => <span data-testid="day">{line.recordDate}</span> },
    {
      key: 'signatures',
      header: t('qms.diary.column.signatures'),
      render: (line) => (
        <ul className="qms-signers" data-testid="chain">
          {DIARY_ROLES.map((role) => {
            const signature = line.signatures.find((candidate) => candidate.role === role);
            return (
              <li key={role} data-role={role} data-signed={signature === undefined ? 'no' : signature.valid ? 'yes' : 'void'}>
                <strong>{roleLabel(t, role)}</strong>
                <span className="sub"> — {signature === undefined ? t('qms.diary.signature.missing') : signature.valid ? signature.signerName : t('qms.diary.signature.void')}</span>
              </li>
            );
          })}
        </ul>
      ),
    },
    {
      key: 'status',
      header: t('qms.diary.column.status'),
      render: (line) => (
        <span data-testid="status" data-status={line.status}>
          <StatusPill tone={STATUS_TONE[line.status]}>{statusLabel(t, line.status)}</StatusPill>
        </span>
      ),
    },
    {
      key: 'actions',
      header: t('qms.diary.column.actions'),
      render: (line) => (
        <span className="qms-row-actions">
          <Link className="ui-button ui-button--outline ui-button--small" to={composeLink(line.id)} data-open={line.id}>
            {t('qms.diary.open.action')}
          </Link>
          {line.actions.supervise || line.actions.ownerConfirm || line.actions.lock || line.actions.resolveConflict ? (
            <Link className="ui-button ui-button--outline ui-button--small" to={reviewLink(line.id)} data-review={line.id}>
              {t('qms.diary.review.action')}
            </Link>
          ) : null}
        </span>
      ),
    },
  ];
  return <DataTable caption={t('w2iss.qms.diaries.aria')} columns={columns} rows={lines} rowKey={(line) => line.id} />;
}
