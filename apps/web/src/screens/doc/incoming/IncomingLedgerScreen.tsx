import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { useIncomings } from './hooks';
import { statusLabel, urgencyLabel } from './labels';
import { INCOMING_STATUSES, NO_FILTER, RECEIVE_PERMISSION, canAct, handlingLink, holds, intakeLink } from './model';
import type { IncomingFilter, IncomingLine } from './model';
import './incoming.css';

/**
 * DOC-12: the ledger of the incoming letters and who they are assigned to (ST-DOC-011, DOC.md F10, BR-DOC-18). Each letter shows its number, its sender, when it came, its state, the unit and the handler it was given to, and its
 * deadline; a letter that is past its deadline carries the chip "overdue N days" (working days, by the calendar of the tenant). The ledger is read in the scope of the caller; the work itself is on DOC-13.
 */
export default function IncomingLedgerScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The list belongs to one membership: a switch of tenant or of membership starts the screen over.
  return <LedgerContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function LedgerContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { permissions, mode } = useSession();
  // A link from the overview (DOC-01) names the filter it leads to (`?overdue=true`, `?status=`); what is not one of ours is ignored.
  const [search] = useSearchParams();
  const [filter, setFilter] = useState<IncomingFilter>(() => ({ ...NO_FILTER, status: INCOMING_STATUSES.find((status) => status === search.get('status')) ?? '', overdue: search.get('overdue') === 'true' }));
  const list = useIncomings(filter);
  const lines = useMemo(() => (list.data?.pages ?? []).flatMap((page) => page.lines), [list.data]);
  const state = useScreenState({ isLoading: list.isLoading, error: list.error, data: list.data, isEmpty: () => false });
  const day = (iso: string | null): string => (iso === null ? t('doc.incoming.none') : new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date(iso.length === 10 ? `${iso}T00:00:00+07:00` : iso)));
  const change = (patch: Partial<IncomingFilter>): void => setFilter({ ...filter, ...patch });
  const years = useMemo(() => {
    const now = new Date().getFullYear();
    return [now, now - 1, now - 2].map(String);
  }, []);

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('doc.incoming.ledger.title')}</h1>
          <p>{t('doc.incoming.ledger.subtitle')}</p>
        </div>
        {canAct(mode) && holds(permissions, RECEIVE_PERMISSION) ? (
          <div className="actions">
            <Link className="button primary" to={intakeLink()}>
              {t('doc.incoming.intake.link')}
            </Link>
          </div>
        ) : null}
      </div>
      <div className="card">
        <div className="field">
          <label htmlFor="incoming-filter-status">{t('doc.incoming.column.status')}</label>
          <select id="incoming-filter-status" value={filter.status} onChange={(event) => change({ status: event.target.value })}>
            <option value="">{t('doc.incoming.filter.allStatuses')}</option>
            {INCOMING_STATUSES.map((status) => (
              <option key={status} value={status}>
                {statusLabel(t, status)}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="incoming-filter-year">{t('doc.incoming.filter.year')}</label>
          <select id="incoming-filter-year" value={filter.year} onChange={(event) => change({ year: event.target.value })}>
            <option value="">{t('doc.incoming.filter.allYears')}</option>
            {years.map((year) => (
              <option key={year} value={year}>
                {year}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="incoming-filter-overdue">
            <input id="incoming-filter-overdue" type="checkbox" checked={filter.overdue} onChange={(event) => change({ overdue: event.target.checked })} /> {t('doc.incoming.filter.overdue')}
          </label>
        </div>
      </div>
      <StateBoundary state={state} onRetry={() => void list.refetch()}>
        <div className="card">
          {lines.length === 0 ? (
            <p className="callout" role="status" data-testid="no-letters">
              {t('doc.incoming.none.notice')}
            </p>
          ) : (
            <table className="table" data-testid="letters">
              <thead>
                <tr>
                  <th scope="col">{t('doc.incoming.column.number')}</th>
                  <th scope="col">{t('doc.incoming.column.letter')}</th>
                  <th scope="col">{t('doc.incoming.column.received')}</th>
                  <th scope="col">{t('doc.incoming.column.assigned')}</th>
                  <th scope="col">{t('doc.incoming.column.status')}</th>
                  <th scope="col">
                    <span className="sr-only">{t('doc.incoming.column.actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line) => (
                  <LetterRow key={line.id} line={line} day={day} />
                ))}
              </tbody>
            </table>
          )}
          {list.hasNextPage ? (
            <button type="button" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
              {t('doc.incoming.more.action')}
            </button>
          ) : null}
        </div>
      </StateBoundary>
      <p className="prototype-note">{t('doc.incoming.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function LetterRow({ line, day }: { line: IncomingLine; day: (iso: string | null) => string }) {
  const { t } = useTranslation();
  return (
    <tr data-letter={line.id} data-status={line.status} data-overdue={line.isOverdue ? 'yes' : 'no'}>
      <td data-testid="number">{line.symbol ?? t('doc.incoming.none')}</td>
      <td data-testid="letter">
        <strong>{line.title}</strong>
        <small className="sub incoming-meta">
          {line.senderName}
          {line.originalSymbol === null ? '' : ` · ${line.originalSymbol}`}
          {line.originalIssuedOn === null ? '' : ` · ${day(line.originalIssuedOn)}`}
        </small>
        {line.urgency === 'NORMAL' ? null : <span className="incoming-chip warning">{urgencyLabel(t, line.urgency)}</span>}
      </td>
      <td data-testid="received">{day(line.receivedAt)}</td>
      <td data-testid="assigned">
        {line.assignedUnit === null ? (
          <span className="sub">{t('doc.incoming.none')}</span>
        ) : (
          <>
            {line.assignedUnit.name}
            {line.assignee === null ? null : <small className="sub incoming-meta">{line.assignee.name}</small>}
            {line.dueOn === null ? null : <small className="sub incoming-meta">{t('doc.incoming.due', { date: day(line.dueOn) })}</small>}
          </>
        )}
      </td>
      <td>
        <span className="incoming-chip" data-testid="status">
          {statusLabel(t, line.status)}
        </span>
        {line.overdueDays === null || line.dueOn === null ? null : (
          <span className="incoming-chip danger" data-testid="overdue">
            {t('doc.incoming.overdue', { days: line.overdueDays, date: day(line.dueOn) })}
          </span>
        )}
      </td>
      <td>
        <Link className="button" to={handlingLink(line.id)} data-open={line.id}>
          {t('doc.incoming.open.action')}
        </Link>
      </td>
    </tr>
  );
}
