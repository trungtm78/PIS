import { useState } from 'react';
import { useTranslation } from '../../../i18n';
import { StatusPill } from '../../../ui';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { CommandDialog } from './CommandDialog';
import { useAddComment, useComments, useReopenComment, useResolveComment } from './hooks';
import { problemText } from './labels';
import { stamp } from './model';
import type { CommentView } from './model';

interface CommentsProps {
  versionId: string;
  /** The place the thread is narrowed to, or null for every comment of the version. */
  anchor: { citationId: string; label: string } | null;
  onClearAnchor: () => void;
  mayComment: boolean;
  frozen: boolean;
  locked: boolean;
}

/**
 * The comments of a version (DOC-25, PD.02): the words of a reviewer or an author about the version or one place of it. A comment is kept as it was said; only its state moves, resolved by someone who answers it and reopened by
 * someone who does not accept the answer. A locked version is commented on like any other: a comment does not change the file.
 */
export function Comments({ versionId, anchor, onClearAnchor, mayComment, frozen, locked }: CommentsProps) {
  const { t } = useTranslation();
  const list = useComments(versionId);
  const add = useAddComment();
  const reopen = useReopenComment();
  const resolve = useResolveComment();
  const [body, setBody] = useState('');
  const [replyTo, setReplyTo] = useState<string | undefined>(undefined);
  const [resolving, setResolving] = useState<CommentView | undefined>(undefined);
  const [hint, setHint] = useState<string | undefined>(undefined);
  const state = useScreenState({ isLoading: list.isLoading, error: list.data === undefined ? list.error : undefined, data: list.data, isEmpty: () => false });
  const all = list.data?.items ?? [];
  const shown = all.filter((item) => anchor === null || item.citation_id === anchor.citationId);
  const roots = shown.filter((item) => item.parent_id === null);
  const repliesOf = (id: string): CommentView[] => all.filter((item) => item.parent_id === id);
  const acting = mayComment && !frozen;

  const send = (parentId: string | null): void => {
    if (body.trim().length < 2) return setHint(t('doc.repo.comments.tooShort'));
    setHint(undefined);
    add.mutate(
      { versionId, citationId: parentId === null ? (anchor?.citationId ?? null) : null, parentId, body: body.trim() },
      {
        onSuccess: () => {
          setBody('');
          setReplyTo(undefined);
        },
      },
    );
  };

  const entry = (comment: CommentView, reply: boolean) => (
    <li key={comment.id} className={reply ? 'doc2-comment doc2-reply' : 'doc2-comment'} data-comment={comment.id} data-status={comment.status}>
      <div className="doc2-comment-head">
        <strong>{comment.author_name ?? t('doc.repo.comments.unknownAuthor')}</strong> <span className="muted">{stamp(comment.created_at)}</span>{' '}
        <StatusPill tone={comment.status === 'OPEN' ? 'info' : 'success'}>{comment.status === 'OPEN' ? t('doc.repo.comments.open') : t('doc.repo.comments.resolved')}</StatusPill>
        {comment.citation_label !== null && <span className="muted"> {t('doc.repo.comments.at', { place: comment.citation_label })}</span>}
      </div>
      <p>{comment.body}</p>
      {comment.status === 'RESOLVED' && comment.resolution_note !== null && <p className="muted">{t('doc.repo.comments.note', { note: comment.resolution_note })}</p>}
      {acting && (
        <div className="doc2-comment-actions">
          {!reply && (
            <button type="button" className="ui-button ui-button--outline ui-button--small" data-reply={comment.id} onClick={() => setReplyTo(replyTo === comment.id ? undefined : comment.id)}>
              {t('doc.repo.comments.reply')}
            </button>
          )}
          {!reply && comment.status === 'OPEN' && (
            <button type="button" className="ui-button ui-button--outline ui-button--small" data-resolve={comment.id} onClick={() => setResolving(comment)}>
              {t('doc.repo.comments.resolve')}
            </button>
          )}
          {!reply && comment.status === 'RESOLVED' && (
            <button type="button" className="ui-button ui-button--outline ui-button--small" data-reopen={comment.id} disabled={reopen.isPending} onClick={() => reopen.mutate({ id: comment.id })}>
              {t('doc.repo.comments.reopen')}
            </button>
          )}
        </div>
      )}
      {replyTo === comment.id && acting && (
        <div className="field">
          <label htmlFor={`reply-${comment.id}`}>{t('doc.repo.comments.replyLabel')}</label>
          <textarea id={`reply-${comment.id}`} value={body} rows={2} maxLength={4000} onChange={(event) => setBody(event.target.value)} />
          <button type="button" className="ui-button ui-button--primary ui-button--small" data-send-reply={comment.id} disabled={add.isPending} onClick={() => send(comment.id)}>
            {t('doc.repo.comments.send')}
          </button>
        </div>
      )}
      {!reply && repliesOf(comment.id).length > 0 && <ul className="doc2-replies">{repliesOf(comment.id).map((child) => entry(child, true))}</ul>}
    </li>
  );

  return (
    <section aria-labelledby="comments-title" data-testid="comments">
      <h2 id="comments-title">{t('doc.repo.comments.title')}</h2>
      <p className="muted" data-testid="comments-count">
        {t('doc.repo.comments.count', { open: list.data?.open_count ?? 0, total: all.length })}
      </p>
      {locked && <p className="muted">{t('doc.repo.comments.lockedNote')}</p>}
      {anchor !== null && (
        <p className="callout" data-testid="anchor">
          {t('doc.repo.comments.anchored', { place: anchor.label })}{' '}
          <button type="button" className="ui-button ui-button--outline ui-button--small" data-testid="clear-anchor" onClick={onClearAnchor}>
            {t('doc.repo.comments.showAll')}
          </button>
        </p>
      )}
      {(reopen.isError || add.isError) && (
        <p className="callout warning" role="alert" data-testid="comment-error">
          {problemText(t, reopen.error ?? add.error)}
        </p>
      )}
      <StateBoundary state={state} onRetry={() => void list.refetch()}>
        {roots.length === 0 ? (
          <p className="callout" role="status" data-testid="comments-empty">
            {anchor === null ? t('doc.repo.comments.empty') : t('doc.repo.comments.emptyAnchor')}
          </p>
        ) : (
          <ul className="doc2-comments">{roots.map((comment) => entry(comment, false))}</ul>
        )}
      </StateBoundary>
      {acting ? (
        <div className="field">
          <label htmlFor="comment-body">{anchor === null ? t('doc.repo.comments.newLabel') : t('doc.repo.comments.newAnchored', { place: anchor.label })}</label>
          <textarea id="comment-body" value={replyTo === undefined ? body : ''} rows={3} maxLength={4000} disabled={replyTo !== undefined} onChange={(event) => setBody(event.target.value)} />
          {hint !== undefined && (
            <p role="alert" className="callout warning" data-testid="comment-hint">
              {hint}
            </p>
          )}
          <button type="button" className="ui-button ui-button--primary" data-testid="send-comment" disabled={add.isPending || replyTo !== undefined} onClick={() => send(null)}>
            {t('doc.repo.comments.send')}
          </button>
        </div>
      ) : (
        <p className="muted" data-testid="comment-denied">
          {frozen ? t('doc.repo.readonly.mode') : t('doc.repo.comments.noRight')}
        </p>
      )}
      {resolving !== undefined && (
        <CommandDialog
          title={t('doc.repo.comments.resolveTitle')}
          context={[{ label: t('doc.repo.comments.author'), value: resolving.author_name ?? t('doc.repo.comments.unknownAuthor') }]}
          confirmLabel={t('doc.repo.comments.resolve')}
          reason={{ label: t('doc.repo.comments.resolveNote'), required: false }}
          pending={resolve.isPending}
          error={resolve.error ?? undefined}
          onCancel={() => setResolving(undefined)}
          onConfirm={(note) => resolve.mutate({ id: resolving.id, note }, { onSuccess: () => setResolving(undefined) })}
        />
      )}
    </section>
  );
}
