import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
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
  reason?: { label: string; required?: boolean };
}

const FOCUSABLE = 'button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

/** A modal that names the record and the effect before a serious action; Escape cancels, Tab stays inside, a pending action locks it against a double send. */
export function ConfirmDialog({ open, title, context, confirmLabel, cancelLabel, onConfirm, onCancel, pending = false, reason }: ConfirmDialogProps) {
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

  const missingReason = reason?.required === true && text.trim() === '';
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
        {reason !== undefined && (
          <div className="ui-dialog__reason">
            <label htmlFor={reasonId}>
              {reason.label}
              {reason.required === true && <span className="ui-dialog__required"> ({t('ui.confirmDialog.required')})</span>}
            </label>
            <textarea id={reasonId} ref={reasonField} rows={3} value={text} required={reason.required === true} disabled={pending} onChange={(event) => setText(event.target.value)} />
          </div>
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
