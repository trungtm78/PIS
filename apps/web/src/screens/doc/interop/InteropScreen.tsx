import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { useMoment } from '../../bid/analysis/hooks';
import { useInteropMessages, useRetryInteropMessage } from './hooks';
import { adapterLabel, adapterPill, directionLabel, problemMessage, statusLabel, statusPill } from './labels';
import { DIRECTIONS, MAX_ATTEMPTS, NO_FILTER, READ_PERMISSION, STATUSES, describeProblem, holds, linkOf, mayRetry } from './model';
import type { Direction, Filter, InteropMessage, MessageStatus } from './model';
import './interop.css';

/**
 * DOC-20: the monitor of the interoperability of documents through the LGSP of the agency (ST-DOC-021, DOC.md F13). It lists the messages that left (one for each distribution on the LGSP channel) and those that arrived,
 * the latest first, with the id the gateway gave, the parties by their codes, the status, the attempts out of twenty, the code of the last failure and the state of the adapter; a message that failed or died can be sent
 * again by a person who may manage them. The envelope, which carries the letter itself, is never shown. While no adapter is verified the screen says so: nothing here claims a document reached the agency it was
 * addressed to unless the gateway said so.
 */
export default function InteropScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The messages, the filter and the refusals belong to one membership: a switch of tenant or of membership starts the screen over.
  return <InteropContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function InteropContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const moment = useMoment();
  const { permissions, mode } = useSession();
  const allowed = holds(permissions, READ_PERMISSION);
  const [filter, setFilter] = useState<Filter>(NO_FILTER);
  const read = useInteropMessages(filter, allowed);
  const retry = useRetryInteropMessage();
  const messages = useMemo(() => (read.data?.pages ?? []).flatMap((page) => page.items), [read.data]);
  const asOf = read.data?.pages.at(-1)?.asOf ?? '';
  const filtered = filter.status !== '' || filter.direction !== '';
  // A filter that matches nothing is not the "empty" state of the screen: the filter stays where it is.
  const state = useScreenState({ isLoading: read.isLoading, error: read.error ?? undefined, data: read.data, isEmpty: () => messages.length === 0 && !filtered });
  const dead = messages.filter((message) => message.status === 'DEAD').length;
  const refused = retry.isError ? describeProblem(retry.error) : undefined;
  const stamp = asOf === '' ? undefined : new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date(asOf));

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('doc.interop.page.title')}</h1>
          <p>{t('doc.interop.page.subtitle')}</p>
        </div>
        <div className="actions">
          {stamp === undefined ? null : (
            <span className="sub" data-testid="as-of">
              {t('doc.interop.asOf', { time: stamp })}
            </span>
          )}
          <button type="button" disabled={!allowed || read.isFetching} onClick={() => void read.refetch()}>
            {t('doc.interop.refresh')}
          </button>
        </div>
      </div>
      {/* A refusal can be the very reason a row has changed (the job took the message, another person sent it again), so it is not part of a row. */}
      {refused === undefined ? null : (
        <p className="callout warning" role="alert" data-testid="refusal">
          {problemMessage(t, refused)}
        </p>
      )}
      {allowed && (filtered || messages.length > 0) ? <Filters filter={filter} onChange={setFilter} /> : null}
      <StateBoundary state={allowed ? state : 'denied'} onRetry={() => void read.refetch()}>
        {dead === 0 ? null : (
          <p className="callout warning" role="status" data-testid="dead-note">
            {t('doc.interop.dead.note', { count: dead })}
          </p>
        )}
        {messages.length > 0 && messages.every((message) => message.adapterStatus !== 'VERIFIED') ? (
          <p className="callout" role="note" data-testid="adapter-note">
            {t('doc.interop.adapter.note')}
          </p>
        ) : null}
        {messages.length === 0 ? (
          <p className="muted" data-testid="no-match">
            {t('doc.interop.filter.empty')}
          </p>
        ) : (
          <div className="tablewrap">
            <table data-testid="messages">
              <thead>
                <tr>
                  <th>{t('doc.interop.col.direction')}</th>
                  <th>{t('doc.interop.col.message')}</th>
                  <th>{t('doc.interop.col.parties')}</th>
                  <th>{t('doc.interop.col.status')}</th>
                  <th>{t('doc.interop.col.attempts')}</th>
                  <th>{t('doc.interop.col.error')}</th>
                  <th>{t('doc.interop.col.adapter')}</th>
                  <th>{t('doc.interop.col.when')}</th>
                  <th>
                    <span className="sr-only">{t('doc.interop.col.actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {messages.map((message) => (
                  <Row
                    key={message.id}
                    message={message}
                    when={moment(message.updatedAt)}
                    next={message.nextAttemptAt === null ? undefined : moment(message.nextAttemptAt)}
                    retryable={mayRetry(message, permissions, mode)}
                    pending={retry.isPending && retry.variables?.id === message.id}
                    busy={retry.isPending && retry.variables?.id !== message.id}
                    onRetry={() => retry.mutate(message)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
        {read.hasNextPage ? (
          <p className="doc-interop-more">
            <button type="button" disabled={read.isFetchingNextPage} onClick={() => void read.fetchNextPage()}>
              {t('doc.interop.more')}
            </button>
          </p>
        ) : null}
      </StateBoundary>
      <p className="prototype-note">{t('doc.interop.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function Filters({ filter, onChange }: { filter: Filter; onChange(next: Filter): void }) {
  const { t } = useTranslation();
  return (
    <div className="doc-interop-filters" role="search" aria-label={t('doc.interop.filter.label')}>
      <div>
        <label htmlFor="interop-direction">{t('doc.interop.filter.direction')}</label>
        <select id="interop-direction" value={filter.direction} onChange={(event) => onChange({ ...filter, direction: event.target.value as '' | Direction })}>
          <option value="">{t('doc.interop.filter.all')}</option>
          {DIRECTIONS.map((direction) => (
            <option key={direction} value={direction}>
              {directionLabel(t, direction)}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor="interop-status">{t('doc.interop.filter.status')}</label>
        <select id="interop-status" value={filter.status} onChange={(event) => onChange({ ...filter, status: event.target.value as '' | MessageStatus })}>
          <option value="">{t('doc.interop.filter.all')}</option>
          {STATUSES.map((status) => (
            <option key={status} value={status}>
              {statusLabel(t, status)}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

interface RowProps {
  message: InteropMessage;
  when: string;
  next: string | undefined;
  retryable: boolean;
  pending: boolean;
  busy: boolean;
  onRetry(): void;
}

function Row({ message, when, next, retryable, pending, busy, onRetry }: RowProps) {
  const { t } = useTranslation();
  const link = linkOf(message);
  const parties = message.direction === 'OUTBOUND' ? t('doc.interop.parties.to', { code: message.receiverCode ?? '' }) : t('doc.interop.parties.from', { code: message.senderCode ?? '' });
  return (
    <tr data-message-id={message.id} data-status={message.status} data-direction={message.direction}>
      <td>{directionLabel(t, message.direction)}</td>
      <td>
        <code data-testid="external-id">{message.externalMessageId ?? t('doc.interop.message.none')}</code>
        {link === undefined ? null : (
          <div className="sub">
            <Link to={link}>{message.direction === 'OUTBOUND' ? t('doc.interop.link.outgoing') : t('doc.interop.link.incoming')}</Link>
          </div>
        )}
      </td>
      <td data-testid="parties">{parties}</td>
      <td>
        <span className={statusPill(message.status)} data-testid="status">
          {statusLabel(t, message.status)}
        </span>
        {next === undefined ? null : (
          <div className="sub" data-testid="next-attempt">
            {t('doc.interop.next.text', { at: next })}
          </div>
        )}
      </td>
      <td data-testid="attempts">{message.direction === 'OUTBOUND' ? t('doc.interop.attempts.text', { count: message.attempts, max: MAX_ATTEMPTS }) : ''}</td>
      <td data-testid="error">{message.errorCode ?? ''}</td>
      <td>
        <span className={`${adapterPill(message.adapterStatus)} doc-interop-adapter`} data-testid="adapter">
          {adapterLabel(t, message.adapterStatus)}
        </span>
        <div className="sub">{message.adapterCode}</div>
      </td>
      <td>{when}</td>
      <td className="row-actions">
        {!retryable ? null : (
          <button type="button" disabled={pending || busy} onClick={onRetry} aria-label={t('doc.interop.retry.label', { id: message.externalMessageId ?? message.id })}>
            {pending ? t('doc.interop.retry.pending') : t('doc.interop.retry.action')}
          </button>
        )}
      </td>
    </tr>
  );
}
