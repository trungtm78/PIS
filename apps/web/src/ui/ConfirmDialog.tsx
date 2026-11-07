import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from '../i18n';

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  context: { label: string; value: string }[];
  confirmLabel: string;
  cancelLabel: string;
  /** Receives the reason when the dialog asks for one. */
  onConfirm: (reason?: string) => void;
  onCancel: () => void;
  pending?: boolean;
  /** `minLength` (of the trimmed text) keeps the button off until the reason is long enough; `hint` says how long. */
  reason?: { label: string; required?: boolean; minLength?: number; hint?: string };
  /** A refusal of the action, said inside the dialog (an alert) so that it is not behind the backdrop. */
  error?: string;
  /** Extra controls between the context and the reason (a day to choose, a note that explains a rule). */
  children?: ReactNode;
}

const FOCUSABLE = 'button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

/** A modal that names the record and the effect before a serious action; Escape cancels, Tab stays inside, a pending action locks it against a double send. */
export function ConfirmDialog({ open, title, context, confirmLabel, cancelLabel, onConfirm, onCancel, pending = false, reason, error, children }: ConfirmDialogProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const reasonId = useId();
  const [text, setText] = useState('');
  const dialog = useRef<HTMLDivElement>(null);
  const reasonField = useRef<HTMLTextAreaElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setText('');
    (reasonField.current ?? cancelButton.current)?.focus();
    return () => before?.focus();
  }, [open]);

  if (!open) return null;

  const missingReason = (reason?.required === true && text.trim() === '') || (reason?.minLength !== undefined && text.trim().length < reason.minLength);
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

  return createPortal(
    <div className="ui-dialog-backdrop">
      <div className="ui-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-busy={pending ? true : undefined} ref={dialog} onKeyDown={onKeyDown}>
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
        {children !== undefined && <div className="ui-dialog__extra">{children}</div>}
        {reason !== undefined && (
          <div className="ui-dialog__reason">
            <label htmlFor={reasonId}>
              {reason.label}
              {reason.required === true && <span className="ui-dialog__required"> ({t('ui.confirmDialog.required')})</span>}
            </label>
            <textarea id={reasonId} ref={reasonField} rows={3} value={text} required={reason.required === true} disabled={pending} aria-describedby={reason.hint === undefined ? undefined : `${reasonId}-hint`} onChange={(event) => setText(event.target.value)} />
            {reason.hint !== undefined && (
              <span className="ui-dialog__hint" id={`${reasonId}-hint`}>
                {reason.hint}
              </span>
            )}
          </div>
        )}
        {error !== undefined && (
          <p className="ui-dialog__error" role="alert">
            {error}
          </p>
        )}
        <div className="ui-dialog__actions">
          <button type="button" className="ui-button ui-button--outline" ref={cancelButton} disabled={pending} onClick={onCancel}>
            {cancelLabel}
          </button>
          <button type="button" className="ui-button ui-button--primary" disabled={pending || missingReason} onClick={() => onConfirm(reason === undefined ? undefined : text.trim())}>
            {pending ? t('ui.confirmDialog.pending') : confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
