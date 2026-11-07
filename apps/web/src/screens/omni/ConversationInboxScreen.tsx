import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { instantText } from '../adm/audit/SealBanner';
import { DataTable, FilterPanel, StatusPill } from '../../ui';
import type { DataTableColumn } from '../../ui';
import '../not/delivery/delivery.css';
import './conversation/inbox.css';
import { useAssignConversation, useAssignees, useConversations } from './conversation/hooks';
import { channelLabel, problemMessage, statusLabel, statusTone } from './conversation/labels';
import { ASSIGN_PERMISSION, NO_FILTER, READ_PERMISSION, REASON_MAX, STATUSES, conversationLink, describeProblem, mayAssign, reasonProblem, windowClosed } from './conversation/model';
import type { Conversation, ConversationStatus, Filters } from './conversation/model';

/**
 * OMNI-01: the unified inbox. The conversations of the channel accounts of the tenant that are in the queue of the units of whoever reads and those assigned to them: the channel, the contact, the state, who has it, the window in which the provider lets
 * the tenant answer and the deadline of the first answer. A supervisor gives a conversation to an agent who may answer in its queue; the list of those agents is read when the assignment is opened, and the assignment goes with the version that was read.
 */
export default function ConversationInboxScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The filters and the form belong to one membership: switching tenant starts the screen over, so nothing typed for one is sent to another.
  return <InboxContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function InboxContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { permissions, mode } = useSession();
  const canRead = permissions === undefined || permissions.includes(READ_PERMISSION);
  const canAssign = (permissions === undefined || permissions.includes(ASSIGN_PERMISSION)) && mode !== 'READ_ONLY';
  const [filters, setFilters] = useState<Filters>(NO_FILTER);
  const pages = useConversations(filters, canRead);
  const rows = (pages.data?.pages ?? []).flatMap((page) => page.items);
  const state = useScreenState({ isLoading: pages.isLoading, error: pages.error, data: pages.data, isEmpty: () => rows.length === 0 });
  const [assigning, setAssigning] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const target = rows.find((row) => row.id === assigning);
  const now = new Date();
  const columns: DataTableColumn<Conversation>[] = [
    {
      key: 'channel',
      header: t('omni.inbox.col.channel'),
      pinned: true,
      render: (row) => (
        <span data-conversation-id={row.id} data-status={row.status}>
          {channelLabel(t, row.channel)}
          <div className="sub">{row.accountName}</div>
        </span>
      ),
    },
    {
      key: 'contact',
      header: t('omni.inbox.col.contact'),
      render: (row) => (
        <>
          {row.contactName}
          <div className="sub">{t('omni.inbox.messages.count', { count: row.messageCount })}</div>
        </>
      ),
    },
    {
      key: 'status',
      header: t('omni.inbox.col.status'),
      render: (row) => (
        <span data-conversation-status>
          <StatusPill tone={statusTone(row.status)}>{statusLabel(t, row.status)}</StatusPill>
        </span>
      ),
    },
    {
      key: 'assignee',
      header: t('omni.inbox.col.assignee'),
      render: (row) => (
        <span data-assignee>
          {row.assigneeName ?? <span className="sub">{t('omni.inbox.assignee.none')}</span>}
          {row.queueUnitName === undefined ? null : <div className="sub">{row.queueUnitName}</div>}
        </span>
      ),
    },
    {
      key: 'sla',
      header: t('omni.inbox.col.sla'),
      render: (row) => <span data-sla>{row.firstResponseDueAt === undefined ? <span className="sub">{t('omni.inbox.sla.none')}</span> : instantText(locale, row.firstResponseDueAt)}</span>,
    },
    {
      key: 'window',
      header: t('omni.inbox.col.window'),
      render: (row) => (
        <span data-window>
          {row.windowExpiresAt === undefined ? (
            <span className="sub">{t('omni.inbox.window.none')}</span>
          ) : windowClosed(row, now) ? (
            <StatusPill tone="warning">{t('omni.inbox.window.closed')}</StatusPill>
          ) : (
            instantText(locale, row.windowExpiresAt)
          )}
        </span>
      ),
    },
    { key: 'last', header: t('omni.inbox.col.last'), render: (row) => (row.lastInboundAt === undefined ? '' : instantText(locale, row.lastInboundAt)) },
    {
      key: 'actions',
      header: t('omni.inbox.col.actions'),
      render: (row) => (
        <span className="omni-row-actions">
          <Link className="ui-button ui-button--outline ui-button--small" to={conversationLink(row.id)} data-open={row.id} aria-label={t('omni.inbox.open.aria', { name: row.contactName })}>
            {t('omni.inbox.open.action')}
          </Link>
          {canAssign && mayAssign(row) ? (
            <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => (setAssigning(row.id), setNotice(undefined))} aria-label={t('omni.inbox.assign.aria', { name: row.contactName })}>
              {t('omni.inbox.assign.action')}
            </button>
          ) : null}
        </span>
      ),
    },
  ];
  const filtered = filters.status !== '' || filters.mine;
  const clearFilters = (): void => setFilters(NO_FILTER);
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title" className="not-queue omni-inbox">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('omni.inbox.page.title')}</h1>
          <p>{t('omni.inbox.page.subtitle')}</p>
        </div>
      </div>
      <FilterPanel applied={(filters.status === '' ? 0 : 1) + (filters.mine ? 1 : 0)}>
        <div>
          <label htmlFor="inbox-status">{t('omni.inbox.filter.status.label')}</label>
          <select id="inbox-status" value={filters.status} onChange={(event) => setFilters({ ...filters, status: event.target.value as ConversationStatus | '' })}>
            <option value="">{t('omni.inbox.filter.status.all')}</option>
            {STATUSES.map((status) => (
              <option key={status} value={status}>
                {statusLabel(t, status)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="inbox-mine">
            <input id="inbox-mine" type="checkbox" checked={filters.mine} onChange={(event) => setFilters({ ...filters, mine: event.target.checked })} /> {t('omni.inbox.filter.mine.label')}
          </label>
        </div>
      </FilterPanel>
      {notice === undefined ? null : (
        <p className="callout" role="status" data-notice>
          {notice}
        </p>
      )}
      <StateBoundary state={canRead ? state : 'denied'} onRetry={() => void pages.refetch()}>
        <DataTable caption={t('omni.inbox.page.title')} columns={columns} rows={rows} rowKey={(row) => row.id} emptyKind={filtered ? 'filtered' : 'none'} onClearFilters={clearFilters} />
        {pages.hasNextPage ? (
          <p>
            <button type="button" className="ui-button ui-button--outline" onClick={() => void pages.fetchNextPage()} disabled={pages.isFetchingNextPage}>
              {t('omni.inbox.more.action')}
            </button>
          </p>
        ) : null}
      </StateBoundary>
      {target === undefined ? null : (
        <AssignForm
          key={target.id}
          conversation={target}
          onClose={() => setAssigning(undefined)}
          onDone={() => {
            setAssigning(undefined);
            setNotice(t('omni.inbox.assign.done'));
          }}
        />
      )}
    </section>
  );
}

function AssignForm({ conversation, onClose, onDone }: { conversation: Conversation; onClose(): void; onDone(): void }) {
  const { t } = useTranslation();
  const assignees = useAssignees(conversation.id);
  const assign = useAssignConversation();
  const [chosen, setChosen] = useState('');
  const [reason, setReason] = useState('');
  const [missing, setMissing] = useState(false);
  const [long, setLong] = useState(false);
  const problem = assign.isError ? describeProblem(assign.error) : undefined;
  const members = assignees.data ?? [];
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (assign.isPending) return;
    setMissing(chosen === '');
    setLong(reasonProblem(reason));
    if (chosen === '' || reasonProblem(reason)) return;
    assign.reset();
    // The version the conversation was read at goes with the assignment: a conversation that someone else moved meanwhile is a conflict.
    assign.mutate({ conversationId: conversation.id, version: conversation.version, assigneeId: chosen, reason: reason.trim() === '' ? undefined : reason.trim() }, { onSuccess: onDone });
  };
  return (
    <form onSubmit={submit} noValidate aria-label={t('omni.inbox.assign.form.aria', { name: conversation.contactName })} className="card" data-assign-form>
      <h2>{t('omni.inbox.assign.title')}</h2>
      {problem === undefined ? null : (
        <p className="callout warning" role="alert" data-problem>
          {problemMessage(t, problem)}
        </p>
      )}
      {assignees.isError ? (
        <p className="callout warning" role="alert" data-assignees-problem>
          {t('omni.inbox.assign.assignees.failed')}
        </p>
      ) : null}
      {assignees.isSuccess && members.length === 0 ? (
        <p className="sub" role="status" data-no-assignee>
          {t('omni.inbox.assign.assignees.none')}
        </p>
      ) : null}
      <div className="field">
        <label htmlFor="assign-member">{t('omni.inbox.assign.member.label')}</label>
        <select id="assign-member" value={chosen} onChange={(event) => setChosen(event.target.value)} aria-invalid={missing}>
          <option value="">{t('omni.inbox.assign.member.choose')}</option>
          {members.map((member) => (
            <option key={member.membershipId} value={member.membershipId}>
              {member.displayName}
            </option>
          ))}
        </select>
        {missing ? (
          <small role="alert" className="field-error" data-member-problem>
            {t('omni.inbox.assign.member.invalid')}
          </small>
        ) : null}
      </div>
      <div className="field">
        <label htmlFor="assign-reason">{t('omni.inbox.assign.reason.label')}</label>
        <textarea id="assign-reason" value={reason} onChange={(event) => setReason(event.target.value)} />
        {long ? (
          <small role="alert" className="field-error" data-reason-problem>
            {t('omni.inbox.assign.reason.invalid', { max: REASON_MAX })}
          </small>
        ) : null}
      </div>
      <div className="formfooter">
        <button type="submit" className="ui-button ui-button--primary" disabled={assign.isPending}>
          {t('omni.inbox.assign.confirm.action')}
        </button>
        <button type="button" className="ui-button ui-button--outline" onClick={onClose}>
          {t('omni.inbox.assign.cancel.action')}
        </button>
      </div>
    </form>
  );
}
