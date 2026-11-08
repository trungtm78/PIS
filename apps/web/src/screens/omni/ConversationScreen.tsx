import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { instantText } from '../adm/audit/SealBanner';
import '../not/delivery/delivery.css';
import { channelLabel, statusLabel, statusPill } from './conversation/labels';
import { conversionLink } from './conversation/model';
import { LinkPanel } from './thread/LinkPanel';
import { useConversation, useMessageText, useMessages, useMoveConversation, useSendMessage } from './thread/hooks';
import { deliveryLabel, directionLabel, problemMessage, purposeLabel } from './thread/labels';
import {
  CONVERT_PERMISSION,
  MESSAGE_READ_PERMISSION,
  PURPOSES,
  READ_PERMISSION,
  REPLY_PERMISSION,
  TEXT_MAX,
  countdownOf,
  describeProblem,
  emptyDraft,
  mayNote,
  mayReopen,
  mayReply,
  mayResolve,
  reasonProblem,
  sendBody,
  shownError,
  textProblem,
} from './thread/model';
import type { Conversation, Draft, Purpose, ThreadMessage } from './thread/model';
import { StatusPill } from '../../ui';
import './thread/thread.css';

/**
 * OMNI-02: one conversation. The messages of the person and of the agents oldest first, with where each stands (the text is read when asked, since it is personal data), the window in which the provider lets the tenant answer freely, and what
 * the agent can do: say something to the person on the channel they used, leave a note for the colleagues (the switch changes how the form looks, so a note is never taken for a message), resolve or reopen. The server judges consent,
 * window and account; what it refuses is told in words.
 */
export default function ConversationScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The forms belong to one membership: switching tenant starts the screen over, so nothing typed for one is sent to another.
  return <ThreadContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function ThreadContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const [search] = useSearchParams();
  const id = search.get('id') ?? undefined;
  const canRead = permissions === undefined || (permissions.includes(READ_PERMISSION) && permissions.includes(MESSAGE_READ_PERMISSION));
  const canReply = (permissions === undefined || permissions.includes(REPLY_PERMISSION)) && mode !== 'READ_ONLY';
  const canConvert = (permissions === undefined || permissions.includes(CONVERT_PERMISSION)) && mode !== 'READ_ONLY';
  const conversation = useConversation(id, canRead);
  const messages = useMessages(id, canRead);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    // The countdown of the window follows the clock, a minute at a time.
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const state = useScreenState({
    isLoading: conversation.isLoading || messages.isLoading,
    // A refresh that fails for a break in the network or the server while there is something to show does not take the screen away: the forms keep what was typed and the attempt of a message whose answer was lost. A refusal does: the
    // conversation may have gone out of the scope of the agent, and what was loaded is not shown any more.
    error: shownError(conversation.error, conversation.data != null) ?? shownError(messages.error, messages.data !== undefined),
    // A record that came back unreadable is as good as none.
    data: conversation.data,
    isEmpty: (data: unknown) => data === null,
  });
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const current = conversation.data ?? undefined;
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title" className="not-queue omni-thread">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('omni.thread.page.title')}</h1>
          <p>
            <Link to="/omni/omni-01">{t('omni.thread.back.action')}</Link>
          </p>
        </div>
      </div>
      <p className="callout" data-petition-notice>
        {t('omni.thread.petition.notice')}
      </p>
      {notice === undefined ? null : (
        <p className="callout" role="status" data-notice>
          {notice}
        </p>
      )}
      <StateBoundary state={id === undefined ? 'empty' : canRead ? state : 'denied'} onRetry={() => void Promise.all([conversation.refetch(), messages.refetch()])}>
        {current === undefined ? null : (
          <>
            <Header conversation={current} now={now} />
            <div className="card">
              <MessageList messages={messages.data ?? []} />
            </div>
            {canConvert && mayNote(current) ? (
              <p data-convert>
                <Link to={conversionLink(current.id)}>{t('omni.thread.convert.action')}</Link>
              </p>
            ) : null}
            {canReply ? <LinkPanel key={`${current.id}:link`} conversation={current} onDone={setNotice} /> : null}
            {canReply ? <Actions key={current.id} conversation={current} onDone={setNotice} /> : null}
            {canReply ? <Composer key={`${current.id}:composer`} conversation={current} onDone={setNotice} /> : null}
          </>
        )}
      </StateBoundary>
    </section>
  );
}

function Header({ conversation, now }: { conversation: Conversation; now: Date }) {
  const { t, locale } = useTranslation();
  const countdown = countdownOf(conversation, now);
  return (
    <div className="card" data-conversation-header>
      <h2>{conversation.contactName}</h2>
      <p>
        {channelLabel(t, conversation.channel)} · {conversation.accountName} ·{' '}
        <span className={statusPill(conversation.status)} data-conversation-status>
          {statusLabel(t, conversation.status)}
        </span>
      </p>
      <p data-assignee>
        {t('omni.thread.assignee.label')}: {conversation.assigneeName ?? t('omni.inbox.assignee.none')}
        {conversation.queueUnitName === undefined ? null : ` · ${conversation.queueUnitName}`}
      </p>
      <p data-window className={countdown?.closed === true ? 'window closed' : 'window'}>
        {countdown === undefined
          ? t('omni.inbox.window.none')
          : countdown.closed
            ? t('omni.thread.window.closed')
            : t('omni.thread.window.left', { hours: countdown.hours, minutes: countdown.minutes })}
        {conversation.windowExpiresAt === undefined ? null : <small> · {instantText(locale, conversation.windowExpiresAt)}</small>}
      </p>
    </div>
  );
}

function MessageList({ messages }: { messages: readonly ThreadMessage[] }) {
  const { t } = useTranslation();
  if (messages.length === 0) {
    return (
      <p className="sub" role="status" data-no-messages>
        {t('omni.thread.messages.none')}
      </p>
    );
  }
  return (
    <ol className="messages" aria-label={t('omni.thread.messages.aria')}>
      {messages.map((message) => (
        <MessageRow key={message.id} message={message} />
      ))}
    </ol>
  );
}

function MessageRow({ message }: { message: ThreadMessage }) {
  const { t, locale } = useTranslation();
  const [shown, setShown] = useState(false);
  const body = useMessageText(message.id, shown);
  return (
    <li className="message" data-message-id={message.id} data-direction={message.direction}>
      <strong>{directionLabel(t, message.direction)}</strong> · <small>{instantText(locale, message.createdAt)}</small>
      {message.deliveryStatus === undefined ? null : (
        <span data-delivery>
          <StatusPill tone={message.deliveryStatus === 'Failed' ? 'danger' : 'neutral'}>{deliveryLabel(t, message.deliveryStatus)}</StatusPill>
        </span>
      )}
      {shown ? (
        body.isError ? (
          <p className="callout warning" role="alert" data-text-problem>
            {t('omni.thread.text.failed')}
          </p>
        ) : (
          <p data-text>{body.data ?? t('omni.thread.text.loading')}</p>
        )
      ) : (
        <p>
          <button type="button" onClick={() => setShown(true)}>
            {t('omni.thread.text.show.action')}
          </button>
        </p>
      )}
    </li>
  );
}

function Actions({ conversation, onDone }: { conversation: Conversation; onDone(notice: string): void }) {
  const resolvable = mayResolve(conversation);
  const reopenable = mayReopen(conversation);
  if (!resolvable && !reopenable) return null;
  const action = resolvable ? 'resolve' : 'reopen';
  // The form belongs to the action it was opened for: when a refresh changes what can be done (the conversation was resolved, by this answer that was lost or by someone else), it starts over, so a confirmation is never given to the opposite action.
  return <MoveForm key={action} conversation={conversation} action={action} onDone={onDone} />;
}

function MoveForm({ conversation, action, onDone }: { conversation: Conversation; action: 'resolve' | 'reopen'; onDone(notice: string): void }) {
  const { t } = useTranslation();
  const move = useMoveConversation(conversation.id);
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState('');
  const [invalid, setInvalid] = useState(false);
  const problem = move.isError ? describeProblem(move.error) : undefined;
  const label = action === 'resolve' ? t('omni.thread.resolve.action') : t('omni.thread.reopen.action');
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (move.isPending) return;
    setInvalid(reasonProblem(reason));
    if (reasonProblem(reason)) return;
    move.reset();
    // The version the conversation was read at goes with it: a conversation that someone else moved meanwhile is a conflict.
    move.mutate(
      { conversationId: conversation.id, version: conversation.version, reason: reason.trim(), action },
      {
        onSuccess: () => {
          setAsking(false);
          setReason('');
          onDone(action === 'resolve' ? t('omni.thread.resolve.done') : t('omni.thread.reopen.done'));
        },
      },
    );
  };
  return (
    <div className="card" data-actions>
      <button type="button" onClick={() => setAsking(!asking)} data-move={action}>
        {label}
      </button>
      {asking ? (
        <form onSubmit={submit} noValidate aria-label={t('omni.thread.move.form.aria', { action: label })} data-move-form>
          {problem === undefined ? null : (
            <p className="callout warning" role="alert" data-problem>
              {problemMessage(t, problem)}
            </p>
          )}
          <label htmlFor="move-reason">{t('omni.thread.move.reason.label')}</label>
          <textarea id="move-reason" value={reason} onChange={(event) => setReason(event.target.value)} />
          {invalid ? (
            <small role="alert" className="field-error" data-reason-problem>
              {t('omni.thread.move.reason.invalid')}
            </small>
          ) : null}
          <button type="submit" className="primary" disabled={move.isPending}>
            {t('omni.thread.move.confirm.action', { action: label })}
          </button>
        </form>
      ) : null}
    </div>
  );
}

function Composer({ conversation, onDone }: { conversation: Conversation; onDone(notice: string): void }) {
  const { t } = useTranslation();
  const send = useSendMessage(conversation.id);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [invalid, setInvalid] = useState(false);
  const toPerson = mayReply(conversation);
  // A conversation nobody has taken up, or that is resolved, takes notes only; one that is closed takes nothing.
  const note = draft.note || !toPerson;
  const problem = send.isError ? describeProblem(send.error) : undefined;
  if (!mayNote(conversation)) {
    return (
      <p className="sub" role="status" data-closed>
        {t('omni.thread.composer.closed')}
      </p>
    );
  }
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (send.isPending) return;
    const found = textProblem(draft);
    setInvalid(found);
    if (found) return;
    send.reset();
    send.mutate(
      { conversationId: conversation.id, version: conversation.version, body: sendBody({ ...draft, note }, conversation.channelAccountId) },
      {
        onSuccess: () => {
          // Only the words that were sent are cleared: what the agent has begun to write since stays.
          setDraft((current) => (current.text === draft.text ? { ...current, text: '' } : current));
          onDone(note ? t('omni.thread.note.done') : t('omni.thread.send.done'));
        },
      },
    );
  };
  return (
    <form onSubmit={submit} noValidate aria-label={note ? t('omni.thread.composer.note.aria') : t('omni.thread.composer.send.aria')} className={note ? 'card composer note-mode' : 'card composer'} data-composer data-mode={note ? 'note' : 'message'}>
      {problem === undefined ? null : (
        <p className="callout warning" role="alert" data-problem>
          {problemMessage(t, problem)}
        </p>
      )}
      <label htmlFor="composer-note">
        <input id="composer-note" type="checkbox" role="switch" checked={note} disabled={!toPerson} onChange={(event) => setDraft({ ...draft, note: event.target.checked })} /> {t('omni.thread.composer.note.switch')}
      </label>
      <p className={note ? 'callout warning' : 'sub'} data-mode-hint>
        {note ? t('omni.thread.composer.note.hint') : t('omni.thread.composer.send.hint', { channel: channelLabel(t, conversation.channel) })}
      </p>
      {note ? null : (
        <div className="field">
          <label htmlFor="composer-purpose">{t('omni.thread.composer.purpose.label')}</label>
          <select id="composer-purpose" value={draft.purpose} onChange={(event) => setDraft({ ...draft, purpose: event.target.value as Purpose })}>
            {PURPOSES.map((purpose) => (
              <option key={purpose} value={purpose}>
                {purposeLabel(t, purpose)}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="field">
        <label htmlFor="composer-text">{t('omni.thread.composer.text.label')}</label>
        <textarea id="composer-text" value={draft.text} onChange={(event) => setDraft({ ...draft, text: event.target.value })} aria-invalid={invalid} />
        {invalid ? (
          <small role="alert" className="field-error" data-text-problem>
            {t('omni.thread.composer.text.invalid', { max: TEXT_MAX })}
          </small>
        ) : null}
      </div>
      <button type="submit" className="primary" disabled={send.isPending}>
        {note ? t('omni.thread.composer.note.action') : t('omni.thread.composer.send.action')}
      </button>
    </form>
  );
}
