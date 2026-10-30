import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import '../not/delivery/delivery.css';
import { useReplies, useSaveReply } from './policy/hooks';
import { channelLabel, classificationLabel, problemMessage, replyFieldMessage } from './policy/labels';
import { BODY_MAX, CHANNELS, CLASSIFICATIONS, MANAGE_PERMISSION, describeProblem, emptyReply, formOfReply, replyBody, replyFieldOf, replyProblems } from './policy/model';
import type { Reply, ReplyField, ReplyForm } from './policy/model';

/**
 * OMNI-08: canned replies. The answers agents reuse: a code, a title, the channels they are for, a class (public or internal) and a text with **no variable** (BR-OMNI-08): what has a place to fill is a template, made in NOT, which a provider
 * approves, and which is what a message outside the 24-hour window has to use. What the server would refuse is told next to the field before anything is sent, and what it refuses all the same is told there too.
 */
export default function CannedReplyScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The form belongs to one membership: switching tenant starts the screen over, so nothing typed for one is sent to another.
  return <ReplyContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function ReplyContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const canRead = permissions === undefined || permissions.includes(MANAGE_PERMISSION);
  const canWrite = canRead && mode !== 'READ_ONLY';
  const replies = useReplies(canRead);
  const rows = (replies.data?.pages ?? []).flatMap((page) => page.items);
  const state = useScreenState({ isLoading: replies.isLoading, error: replies.error, data: replies.data, isEmpty: () => rows.length === 0 });
  const [editing, setEditing] = useState<Reply | undefined>(undefined);
  // A form that was saved starts over: the next one is a new reply, or the change of another, never the same fields again.
  const [round, setRound] = useState(0);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title" className="not-queue">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('omni.reply.page.title')}</h1>
          <p>{t('omni.reply.page.subtitle')}</p>
        </div>
      </div>
      <p className="callout" data-window-notice>
        {t('omni.reply.window.notice')}
      </p>
      {notice === undefined ? null : (
        <p className="callout" role="status" data-notice>
          {notice}
        </p>
      )}
      <div className="card">
        <StateBoundary state={canRead ? state : 'denied'} onRetry={() => void replies.refetch()}>
          <table>
            <caption className="sr-only">{t('omni.reply.page.title')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('omni.reply.col.code')}</th>
                <th scope="col">{t('omni.reply.col.title')}</th>
                <th scope="col">{t('omni.reply.col.channels')}</th>
                <th scope="col">{t('omni.reply.col.class')}</th>
                <th scope="col">{t('omni.reply.col.status')}</th>
                <th scope="col">{t('omni.reply.col.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((reply) => (
                <tr key={reply.id} data-reply-id={reply.id}>
                  <td>
                    <code>{reply.code}</code>
                  </td>
                  <td>
                    {reply.title}
                    <div className="sub">{reply.bodyText}</div>
                  </td>
                  <td>{reply.channels.map((channel) => channelLabel(t, channel)).join(', ')}</td>
                  <td data-class>{classificationLabel(t, reply.classification)}</td>
                  <td>{reply.status === 'Active' ? t('omni.reply.status.active') : t('omni.reply.status.retired')}</td>
                  <td>
                    {canWrite ? (
                      <button type="button" onClick={() => (setEditing(reply), setNotice(undefined))} aria-label={t('omni.reply.edit.aria', { code: reply.code })}>
                        {t('omni.reply.edit.action')}
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {replies.hasNextPage ? (
            <button type="button" onClick={() => void replies.fetchNextPage()} disabled={replies.isFetchingNextPage}>
              {t('omni.reply.more.action')}
            </button>
          ) : null}
        </StateBoundary>
      </div>
      {canWrite ? (
        <ReplyFormCard
          key={`${round}:${editing === undefined ? 'new' : `${editing.id}:${editing.version}`}`}
          editing={editing}
          onDone={() => {
            setNotice(editing === undefined ? t('omni.reply.done.created') : t('omni.reply.done.changed'));
            setEditing(undefined);
            setRound((current) => current + 1);
          }}
          onCancel={() => setEditing(undefined)}
        />
      ) : null}
    </section>
  );
}

function ReplyFormCard({ editing, onDone, onCancel }: { editing: Reply | undefined; onDone(): void; onCancel(): void }) {
  const { t } = useTranslation();
  const save = useSaveReply();
  const [form, setForm] = useState<ReplyForm>(() => (editing === undefined ? emptyReply() : formOfReply(editing)));
  const [shown, setShown] = useState<Partial<Record<ReplyField, 'invalid' | 'variable' | 'class'>>>({});
  const problem = save.isError ? describeProblem(save.error) : undefined;
  // A refusal of the server that names a field is written next to that field, in the words of the form.
  const named = problem === undefined ? undefined : replyFieldOf(problem.field);
  const fieldMessage = (field: ReplyField): string | undefined => {
    const own = shown[field];
    if (own !== undefined) return replyFieldMessage(t, field, own);
    if (named === field) return problem?.reason === 'taken' ? t('omni.reply.problem.taken') : replyFieldMessage(t, field, field === 'bodyText' ? 'variable' : field === 'classification' ? 'class' : 'invalid');
    return undefined;
  };
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (save.isPending) return;
    const found = replyProblems(form);
    setShown(found);
    if (Object.keys(found).length > 0) return;
    save.reset();
    // The version the reply was read at goes with the change: a reply that was changed meanwhile is a conflict.
    save.mutate({ existing: editing === undefined ? undefined : { id: editing.id, version: editing.version }, body: replyBody(form) }, { onSuccess: onDone });
  };
  const update = (change: Partial<ReplyForm>): void => setForm((current) => ({ ...current, ...change }));
  const message = (field: ReplyField) => {
    const text = fieldMessage(field);
    return text === undefined ? null : (
      <small role="alert" className="field-error" data-field-problem={field}>
        {text}
      </small>
    );
  };
  return (
    <form onSubmit={submit} noValidate aria-label={editing === undefined ? t('omni.reply.form.new.aria') : t('omni.reply.form.edit.aria', { code: editing.code })} className="card" data-reply-form>
      <h2>{editing === undefined ? t('omni.reply.form.new.title') : t('omni.reply.form.edit.title')}</h2>
      {problem === undefined || named !== undefined ? null : (
        <p className="callout warning" role="alert" data-problem>
          {problemMessage(t, problem, 'reply')}
        </p>
      )}
      <div className="field">
        <label htmlFor="reply-code">{t('omni.reply.form.code.label')}</label>
        <input id="reply-code" value={form.code} readOnly={editing !== undefined} onChange={(event) => update({ code: event.target.value })} aria-invalid={fieldMessage('code') !== undefined} />
        {message('code')}
      </div>
      <div className="field">
        <label htmlFor="reply-title">{t('omni.reply.form.title.label')}</label>
        <input id="reply-title" value={form.title} onChange={(event) => update({ title: event.target.value })} aria-invalid={fieldMessage('title') !== undefined} />
        {message('title')}
      </div>
      <div className="field">
        <label htmlFor="reply-body">{t('omni.reply.form.body.label', { max: BODY_MAX })}</label>
        <textarea id="reply-body" value={form.bodyText} onChange={(event) => update({ bodyText: event.target.value })} aria-invalid={fieldMessage('bodyText') !== undefined} />
        {message('bodyText')}
      </div>
      <fieldset className="field">
        <legend>{t('omni.reply.form.channels.label')}</legend>
        {CHANNELS.map((channel) => (
          <label key={channel} htmlFor={`reply-channel-${channel}`}>
            <input
              id={`reply-channel-${channel}`}
              type="checkbox"
              checked={form.channels.includes(channel)}
              onChange={(event) => update({ channels: event.target.checked ? [...form.channels, channel] : form.channels.filter((candidate) => candidate !== channel) })}
            />{' '}
            {channelLabel(t, channel)}
          </label>
        ))}
        {message('channels')}
      </fieldset>
      <div className="field">
        <label htmlFor="reply-class">{t('omni.reply.form.class.label')}</label>
        <select id="reply-class" value={form.classification} onChange={(event) => update({ classification: event.target.value })} aria-invalid={fieldMessage('classification') !== undefined}>
          {CLASSIFICATIONS.map((classification) => (
            <option key={classification} value={classification}>
              {classificationLabel(t, classification)}
            </option>
          ))}
        </select>
        {message('classification')}
      </div>
      <div className="formfooter">
        <button type="submit" className="primary" disabled={save.isPending}>
          {t('omni.reply.form.submit.action')}
        </button>
        {editing === undefined ? null : (
          <button type="button" onClick={onCancel}>
            {t('omni.reply.form.cancel.action')}
          </button>
        )}
      </div>
    </form>
  );
}
