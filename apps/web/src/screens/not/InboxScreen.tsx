import { ApiError } from '@machvon/api-client';
import { useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import { StatusPill } from '../../ui';
import { routeById } from '../../routes/registry';
import type { ScreenProps } from '../../routes/types';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { itemsOf, useMyNotifications, useNotificationCommands } from './inbox/hooks';
import { categoryOf, pillToneOf, priorityLabel, symbolOf, titleOf, toneOf } from './inbox/labels';
import { filterNotifications, isUnavailable, isUnread, needsAction, unreadCount } from './inbox/model';
import type { InboxFilter, NotificationItem } from './inbox/model';
import './inbox/inbox.css';

const FILTERS: readonly InboxFilter[] = ['all', 'unread', 'action'];
const DETAIL_ROUTE = 'NOT-02';

/** A refusal (lapsed session, missing permission) is final: unlike a network or server failure it never leaves the list on screen. */
function isRefusal(error: unknown): boolean {
  return error instanceof ApiError && (error.code === 'SESSION_EXPIRED' || error.status === 401 || error.status === 403);
}

/** The path of the details screen of one notification. */
export function detailPathOf(id: string): string {
  return `${routeById(DETAIL_ROUTE)?.path ?? '/not/not-02'}?id=${encodeURIComponent(id)}`;
}

/**
 * NOT-01: the member's own notifications. The list is on the left (filters, search, keyset paging), the selected
 * notification on the right. Selecting only shows it: a notification is read when its details are opened or when the member says
 * so (BR-NOT-05), and an acknowledgement is a separate act on the details screen.
 */
export default function InboxScreen({ route }: ScreenProps) {
  const { t } = useTranslation();
  const notifications = useMyNotifications();
  const commands = useNotificationCommands();
  const items = useMemo(() => itemsOf(notifications.data), [notifications.data]);
  const refused = isRefusal(notifications.error);
  const state = useScreenState({
    isLoading: notifications.isLoading,
    error: items === undefined || refused ? notifications.error : undefined,
    data: items,
  });

  const [filter, setFilter] = useState<InboxFilter>('all');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  // Below 720 px the stylesheet shows the preview instead of the list only while the desk carries `preview-open`.
  const [previewOpen, setPreviewOpen] = useState(false);
  const [markError, setMarkError] = useState(false);
  const list = useRef<HTMLDivElement>(null);

  const all = items ?? [];
  const shown = filterNotifications(all, filter, query, (item) => titleOf(t, item));
  const selected = all.find((item) => item.id === selectedId);
  const counts: Record<InboxFilter, number> = {
    all: all.length,
    unread: unreadCount(all),
    action: all.filter(needsAction).length,
  };
  const pageFailed = notifications.isFetchNextPageError;

  const select = (id: string): void => {
    setSelectedId(id);
    setPreviewOpen(true);
    setMarkError(false);
  };

  const markRead = (id: string): void => {
    setMarkError(false);
    commands.markRead(id, { onError: () => setMarkError(true) });
  };

  // Arrow keys, Home and End move the focus between the rows, as in a list box.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const rows = Array.from(list.current?.querySelectorAll<HTMLButtonElement>('button.notification-row') ?? []);
    const index = rows.findIndex((row) => row === document.activeElement);
    const target =
      event.key === 'ArrowDown' ? rows[Math.min(index + 1, rows.length - 1)] : event.key === 'ArrowUp' ? rows[Math.max(index - 1, 0)] : event.key === 'Home' ? rows[0] : event.key === 'End' ? rows[rows.length - 1] : undefined;
    if (target === undefined) return;
    event.preventDefault();
    target.focus();
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('not.inbox.page.title')}</h1>
          <p>{t('not.inbox.page.subtitle')}</p>
        </div>
      </div>
      <StateBoundary state={state} onRetry={() => void notifications.refetch()}>
        <section className="notification-workspace">
          <div className={`notification-desk${previewOpen ? ' preview-open' : ''}`}>
            <section className="inbox-card">
              <div className="inbox-tabs" role="group" aria-label={t('not.inbox.tabs.label')}>
                {FILTERS.map((name) => (
                  <button key={name} type="button" aria-pressed={filter === name} onClick={() => setFilter(name)}>
                    {name === 'all' ? t('not.inbox.tab.all') : name === 'unread' ? t('not.inbox.tab.unread') : t('not.inbox.tab.action')} <span>{counts[name]}</span>
                  </button>
                ))}
              </div>
              <label className="inbox-search">
                <input
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={t('not.inbox.search.placeholder')}
                  aria-label={t('not.inbox.search.label')}
                />
              </label>
              <div className="notification-items" ref={list} onKeyDown={onKeyDown}>
                {shown.length === 0 ? (
                  <div className="notification-empty">
                    <strong>{t('not.inbox.list.empty.title')}</strong>
                    <p>{t('not.inbox.list.empty.body')}</p>
                  </div>
                ) : (
                  shown.map((item) => <NotificationRow key={item.id} item={item} selected={item.id === selectedId} onSelect={select} />)
                )}
              </div>
              <footer className="inbox-list-footer">
                <span>{t('not.inbox.list.footer.count', { count: all.length })}</span>
                {pageFailed ? (
                  <span className="callout warning" role="alert">
                    {t('not.inbox.list.pageError.message')}
                  </span>
                ) : null}
                {notifications.hasNextPage ? (
                  <button type="button" className="inbox-more" disabled={notifications.isFetchingNextPage} onClick={() => void notifications.fetchNextPage()}>
                    {t('not.inbox.list.more.action')}
                  </button>
                ) : null}
              </footer>
            </section>
            <aside className="notification-preview" aria-label={t('not.inbox.preview.label')}>
              {selected === undefined ? (
                <div className="notification-empty">
                  <strong>{t('not.inbox.preview.empty.title')}</strong>
                  <p>{t('not.inbox.preview.empty.body')}</p>
                </div>
              ) : (
                <Preview item={selected} markError={markError} pending={commands.read.isPending} onMarkRead={markRead} onBack={() => setPreviewOpen(false)} />
              )}
            </aside>
          </div>
        </section>
      </StateBoundary>
    </section>
  );
}

interface RowProps {
  item: NotificationItem;
  selected: boolean;
  onSelect(id: string): void;
}

function NotificationRow({ item, selected, onSelect }: RowProps) {
  const { t } = useTranslation();
  return (
    <button type="button" className={`notification-row${selected ? ' selected' : ''}`} aria-pressed={selected} onClick={() => onSelect(item.id)}>
      <span className={`notification-symbol ${toneOf(item)}`} aria-hidden="true">
        {symbolOf(item)}
      </span>
      <span className="notification-copy">
        <span className="notification-category">
          <StatusPill tone={pillToneOf(item)}>{categoryOf(t, item)}</StatusPill>
        </span>
        <strong>{titleOf(t, item)}</strong>
      </span>
      <span
        className={`notification-unread${isUnread(item) ? ' unread' : ''}`}
        role="img"
        aria-label={isUnread(item) ? t('not.inbox.row.unread.label') : t('not.inbox.row.read.label')}
      />
    </button>
  );
}

interface PreviewProps {
  item: NotificationItem;
  markError: boolean;
  pending: boolean;
  onMarkRead(id: string): void;
  onBack(): void;
}

function Preview({ item, markError, pending, onMarkRead, onBack }: PreviewProps) {
  const { t } = useTranslation();
  return (
    <>
      <button type="button" className="inbox-mobile-back" onClick={onBack}>
        {t('not.detail.back.action')}
      </button>
      <div className="notification-preview-head">
        <StatusPill tone={pillToneOf(item)}>{categoryOf(t, item)}</StatusPill>
        <span>{isUnread(item) ? t('not.inbox.row.unread.label') : t('not.inbox.row.read.label')}</span>
      </div>
      <h2>{titleOf(t, item)}</h2>
      {isUnavailable(item) ? null : (
        <dl>
          <dt>{t('not.inbox.preview.priority.label')}</dt>
          <dd>
            <StatusPill tone={pillToneOf(item)}>{priorityLabel(t, item.priority)}</StatusPill>
          </dd>
        </dl>
      )}
      <Link className="notification-primary-action ui-button ui-button--primary" to={detailPathOf(item.id)}>
        {t('not.inbox.preview.open.action')}
        <span aria-hidden="true">{'↗'}</span>
      </Link>
      {isUnread(item) ? (
        <button type="button" className="notification-read-action ui-button ui-button--outline" disabled={pending} onClick={() => onMarkRead(item.id)}>
          {t('not.inbox.preview.markRead.action')}
        </button>
      ) : null}
      {markError ? (
        <p className="callout warning" role="alert">
          {t('not.inbox.markRead.error')}
        </p>
      ) : null}
    </>
  );
}
