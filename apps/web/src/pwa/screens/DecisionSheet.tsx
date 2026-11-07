import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';

const FOCUSABLE = 'button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), a[href]';

export interface DecisionSheetProps {
  title: string;
  /** What is decided: the record, the step, the amount; named before the person confirms. */
  context: { label: string; value: string }[];
  commentLabel: string;
  commentRequired: boolean;
  /** The refusal of the check or of the server in words, shown above the comment. */
  problem?: string;
  /** What the person can do about the refusal (ask for the second factor, load again). */
  remedy?: ReactNode;
  pending: boolean;
  submitLabel: string;
  cancelLabel: string;
  pendingLabel: string;
  requiredLabel: string;
  onSubmit(comment: string): void;
  onCancel(): void;
}

/**
 * The sheet a decision is made in: it names the record and the effect, takes the comment (required for a return), locks against a double send while it is
 * pending and shows the refusal of the server in place. Escape cancels unless the request is on its way, Tab stays inside, focus returns to the button that opened it.
 */
export function DecisionSheet({ title, context, commentLabel, commentRequired, problem, remedy, pending, submitLabel, cancelLabel, pendingLabel, requiredLabel, onSubmit, onCancel }: DecisionSheetProps) {
  const titleId = useId();
  const commentId = useId();
  const [comment, setComment] = useState('');
  const dialog = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    field.current?.focus();
    return () => before?.focus();
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      if (!pending) onCancel();
      return;
    }
    if (event.key !== 'Tab' || dialog.current === null) return;
    const items = Array.from(dialog.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    const first = items[0];
    const last = items[items.length - 1];
    if (first === undefined || last === undefined) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (!pending) onSubmit(comment);
  };

  return createPortal(
    <div className="ui-dialog-backdrop pwa-sheet-backdrop">
      <div className="ui-dialog pwa-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-busy={pending ? true : undefined} ref={dialog} onKeyDown={onKeyDown}>
        <h2 className="ui-dialog__title" id={titleId}>
          {title}
        </h2>
        <dl className="ui-dialog__context">
          {context.map((item) => (
            <div className="ui-dialog__row" key={item.label}>
              <dt>{item.label}</dt>
              <dd>{item.value}</dd>
            </div>
          ))}
        </dl>
        <form onSubmit={submit} noValidate className="pwa-sheet-form">
          {problem === undefined ? null : (
            <p className="callout warning" role="alert" data-testid="decision-problem">
              {problem}
            </p>
          )}
          {remedy}
          <div className="ui-dialog__reason">
            <label htmlFor={commentId}>
              {commentLabel}
              {commentRequired ? <span className="ui-dialog__required"> ({requiredLabel})</span> : null}
            </label>
            <textarea id={commentId} ref={field} rows={4} maxLength={2000} value={comment} required={commentRequired} aria-required={commentRequired} disabled={pending} onChange={(event) => setComment(event.target.value)} />
          </div>
          <div className="ui-dialog__actions">
            <button type="button" className="ui-button ui-button--outline pwa-touch" disabled={pending} onClick={onCancel}>
              {cancelLabel}
            </button>
            <button type="submit" className="ui-button ui-button--primary pwa-touch" disabled={pending}>
              {pending ? pendingLabel : submitLabel}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}
