import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { useContracts } from '../../ctr/hooks';
import { NewDiaryDialog } from './DiaryDialogs';
import { useDiaries } from './hooks';
import { roleLabel, statusLabel } from './labels';
import { DIARY_ROLES, DIARY_STATUSES, NO_FILTER, canWrite, composeLink, pendingConflicts, reviewLink, vietnamToday } from './model';
import type { DiaryFilter } from './model';
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
  const { permissions, mode } = useSession();
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

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('qms.diary.catalogue.title')}</h1>
          <p>{t('qms.diary.catalogue.subtitle')}</p>
        </div>
        {writable ? (
          <div className="actions">
            <button type="button" className="primary" onClick={() => setCreating(true)}>
              {t('qms.diary.new.action')}
            </button>
          </div>
        ) : null}
      </div>
      <div className="card">
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
      <StateBoundary state={state} onRetry={() => void list.refetch()}>
        <div className="card">
          {lines.length === 0 ? (
            <p className="callout" role="status" data-testid="no-diaries">
              {t('qms.diary.none.notice')}
            </p>
          ) : (
            <table className="table" data-testid="diaries">
              <thead>
                <tr>
                  <th scope="col">{t('qms.diary.column.diary')}</th>
                  <th scope="col">{t('qms.diary.column.day')}</th>
                  <th scope="col">{t('qms.diary.column.signatures')}</th>
                  <th scope="col">{t('qms.diary.column.status')}</th>
                  <th scope="col">
                    <span className="sr-only">{t('qms.diary.column.actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line) => (
                  <tr key={line.id} data-diary={line.id} data-status={line.status}>
                    <td data-testid="diary">
                      <strong>{line.diaryNo}</strong>
                      <small className="sub qms-regime">{line.contract.code}</small>
                      {line.correctionOfId === null ? null : <span className="qms-badge">{t('qms.diary.correction.badge')}</span>}
                      {pendingConflicts(line).length === 0 ? null : (
                        <span className="qms-badge warning" data-testid="conflicts-waiting">
                          {t('qms.diary.conflicts.count', { count: pendingConflicts(line).length })}
                        </span>
                      )}
                    </td>
                    <td data-testid="day">{line.recordDate}</td>
                    <td data-testid="chain">
                      <ul className="qms-signers">
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
                    </td>
                    <td>
                      <span className={line.status === 'LOCKED' || line.status === 'OWNER_CONFIRMED' ? 'qms-badge ok' : line.status === 'SUPERSEDED' ? 'qms-badge warning' : 'qms-badge'} data-testid="status">
                        {statusLabel(t, line.status)}
                      </span>
                    </td>
                    <td>
                      <Link className="button" to={composeLink(line.id)} data-open={line.id}>
                        {t('qms.diary.open.action')}
                      </Link>
                      {line.actions.supervise || line.actions.ownerConfirm || line.actions.lock || line.actions.resolveConflict ? (
                        <Link className="button" to={reviewLink(line.id)} data-review={line.id}>
                          {t('qms.diary.review.action')}
                        </Link>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {list.hasNextPage ? (
            <button type="button" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
              {t('qms.diary.more.action')}
            </button>
          ) : null}
        </div>
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
