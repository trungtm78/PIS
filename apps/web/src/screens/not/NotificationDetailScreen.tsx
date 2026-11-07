import { ApiError } from '@machvon/api-client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import { routeById } from '../../routes/registry';
import type { ScreenProps } from '../../routes/types';
import { WEB_ROUTES } from '../../routes/web-routes';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { StatusPill } from '../../ui';
import { itemsOf, useMyNotifications, useNotificationCommands } from './inbox/hooks';
import { acknowledgeError, categoryOf, pillToneOf, priorityLabel, titleOf } from './inbox/labels';
import { isUnavailable, isUnread, resolveDeepLink } from './inbox/model';
import type { NotificationItem } from './inbox/model';
import './inbox/inbox.css';

const INBOX_ROUTE = 'NOT-01';
/** A notification is looked for in at most this many pages before it is called missing. */
const MAX_PAGES = 40;
const ARROW = '←';

function isRefusal(error: unknown): boolean {
  return error instanceof ApiError && (error.code === 'SESSION_EXPIRED' || error.status === 401 || error.status === 403);
}

const formatTime = (iso: string): string => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
};

/**
 * NOT-02: one notification of the member. Opening it marks it read, once; acknowledging is a separate act that only
 * notifications that require one offer, and only after they are read. What the member may see is decided by the server on
 * every read: a notification whose record they lost access to shows nothing but that fact (NOT 3.2).
 */
export default function NotificationDetailScreen({ route }: ScreenProps) {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const id = params.get('id') ?? undefined;
  const notifications = useMyNotifications();
  const commands = useNotificationCommands();
  const items = useMemo(() => itemsOf(notifications.data), [notifications.data]);
  const found = id === undefined ? undefined : items?.find((item) => item.id === id);
  const inboxPath = routeById(INBOX_ROUTE)?.path ?? '/not/not-01';

  // The details are looked up in the pages of the inbox: load further pages until the notification shows up.
  // A failed page stops the search (it would ask for the same cursor for ever); the member retries it.
  const { hasNextPage, isFetchingNextPage, fetchNextPage, isFetchNextPageError } = notifications;
  const pages = notifications.data?.pages.length ?? 0;
  useEffect(() => {
    if (id !== undefined && found === undefined && hasNextPage && !isFetchingNextPage && !isFetchNextPageError && pages < MAX_PAGES) void fetchNextPage();
  }, [id, found, hasNextPage, isFetchingNextPage, isFetchNextPageError, pages, fetchNextPage]);

  // Opening it marks it read: once per notification, however often the page renders. Content the member may not read is not opened (the record is not shown),
  // so it is not marked read either: nothing of reading is written for a record the member could not see.
  const marked = useRef(new Set<string>());
  const [markFailed, setMarkFailed] = useState(false);
  const { markRead } = commands;
  useEffect(() => {
    if (found === undefined || isUnavailable(found) || !isUnread(found) || marked.current.has(found.id)) return;
    marked.current.add(found.id);
    markRead(found.id, { onError: () => setMarkFailed(true) });
  }, [found, markRead]);
  // A failed marking keeps its id in `marked` (no loop) and is retried by the member with the same idempotency attempt.
  const retryMarkRead = (): void => {
    if (found === undefined || isUnavailable(found)) return;
    setMarkFailed(false);
    markRead(found.id, { onError: () => setMarkFailed(true) });
  };

  const searching = id !== undefined && found === undefined && !isFetchNextPageError && (isFetchingNextPage || (hasNextPage && pages < MAX_PAGES));
  const refused = isRefusal(notifications.error);
  const state = useScreenState({
    isLoading: notifications.isLoading || searching,
    error: items === undefined || refused ? notifications.error : undefined,
    data: items,
    // A missing notification is a message of this screen, not the generic empty state.
    isEmpty: () => false,
  });

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <p className="back-link">
        <Link to={inboxPath}>
          <span aria-hidden="true">{ARROW} </span>
          {t('not.detail.back.link')}
        </Link>
      </p>
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('not.detail.page.title')}</h1>
          <p>{t('not.detail.page.subtitle')}</p>
        </div>
      </div>
      <StateBoundary state={state} onRetry={() => void notifications.refetch()}>
        {found === undefined && isFetchNextPageError ? (
          <div className="card" role="alert">
            <h2>{t('not.detail.search.error.title')}</h2>
            <p>{t('not.inbox.list.pageError.message')}</p>
            <button type="button" className="primary" onClick={() => void fetchNextPage()}>
              {t('not.detail.retry.action')}
            </button>
          </div>
        ) : found === undefined ? (
          <div className="card" role="status">
            <h2>{t('not.detail.notFound.title')}</h2>
            <p>{t('not.detail.notFound.body')}</p>
            <Link to={inboxPath}>{t('not.detail.back.action')}</Link>
          </div>
        ) : (
          <section className="standalone-notification card">
            <article className="notification-preview" aria-label={t('not.inbox.preview.label')}>
              <Link className="inbox-mobile-back" to={inboxPath}>
                <span aria-hidden="true">{ARROW} </span>
                {t('not.detail.back.action')}
              </Link>
              <Detail item={found} commands={commands} />
              {markFailed ? (
                <p className="callout warning" role="alert">
                  {t('not.inbox.markRead.error')}{' '}
                  <button type="button" onClick={retryMarkRead}>
                    {t('not.detail.retry.action')}
                  </button>
                </p>
              ) : null}
            </article>
          </section>
        )}
      </StateBoundary>
    </section>
  );
}

interface DetailProps {
  item: NotificationItem;
  commands: ReturnType<typeof useNotificationCommands>;
}

function Detail({ item, commands }: DetailProps) {
  const { t } = useTranslation();
  const [comment, setComment] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const [done, setDone] = useState(false);
  const unavailable = isUnavailable(item);
  const unread = isUnread(item);
  const link = unavailable ? undefined : resolveDeepLink(item.resourceRef, WEB_ROUTES);
  const acknowledged = item.acknowledgedAt !== undefined;
  const showAcknowledge = !unavailable && item.ackRequired && !acknowledged;

  const acknowledge = (): void => {
    setError(undefined);
    setDone(false);
    commands.acknowledgeAs(item.id, comment.trim(), {
      onSuccess: () => {
        setDone(true);
        setComment('');
      },
      onError: (failure) => setError(acknowledgeError(t, failure)),
    });
  };

  return (
    <>
      <div className="notification-preview-head">
        <StatusPill tone={pillToneOf(item)}>{categoryOf(t, item)}</StatusPill>
        <span>{acknowledged ? t('not.detail.status.acknowledged') : unread ? t('not.detail.status.unread') : t('not.detail.status.read')}</span>
      </div>
      <h2>{titleOf(t, item)}</h2>
      {unavailable ? (
        <p className="notification-preview-body">{t('not.detail.unavailable.body')}</p>
      ) : (
        <dl>
          <dt>{t('not.detail.priority.label')}</dt>
          <dd>{priorityLabel(t, item.priority)}</dd>
          {item.readAt === undefined ? null : (
            <>
              <dt>{t('not.detail.readAt.label')}</dt>
              <dd>
                <time dateTime={item.readAt}>{formatTime(item.readAt)}</time>
              </dd>
            </>
          )}
          {item.acknowledgedAt === undefined ? null : (
            <>
              <dt>{t('not.detail.acknowledgedAt.label')}</dt>
              <dd>
                <time dateTime={item.acknowledgedAt}>{formatTime(item.acknowledgedAt)}</time>
              </dd>
            </>
          )}
        </dl>
      )}
      {link === undefined ? null : (
        <Link className="notification-primary-action" to={link}>
          {t('not.detail.link.open.action')}
          <span aria-hidden="true">{'↗'}</span>
        </Link>
      )}
      {showAcknowledge ? (
        <div className="notification-acknowledge">
          <p className="notification-category">{t('not.detail.ack.required.label')}</p>
          <label className="field">
            <span>{t('not.detail.ack.comment.label')}</span>
            <textarea value={comment} maxLength={1000} onChange={(event) => setComment(event.target.value)} />
          </label>
          <button type="button" className="primary" disabled={unread || commands.acknowledge.isPending} onClick={acknowledge}>
            {t('not.detail.ack.action')}
          </button>
          {unread ? <p className="muted">{t('not.detail.ack.waitRead.hint')}</p> : null}
        </div>
      ) : null}
      {done ? (
        <p className="callout" role="status">
          {t('not.detail.ack.done.notice')}
        </p>
      ) : null}
      {error === undefined ? null : (
        <p className="callout warning" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
