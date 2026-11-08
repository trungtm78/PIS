import type { ReactNode } from 'react';
import { useTranslation } from '../../../i18n';
import { ConfirmDialog } from '../../../ui';
import { problemText } from './labels';
import { MIN_REASON, describeProblem } from './model';

export interface CommandDialogProps {
  title: string;
  context: { label: string; value: string }[];
  confirmLabel: string;
  /** The reason the command asks for: `required` keeps the button off until it has the length the contract asks for. */
  reason?: { label: string; required: boolean };
  pending: boolean;
  /** What the last attempt failed with, said inside the dialog; a version conflict also offers to read the record again. */
  error: unknown;
  /** A refusal the dialog found before it sent anything (a missing field). */
  hint?: string | undefined;
  children?: ReactNode;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
  onReload?: () => void;
}

/** The dialog every command with a reason goes through: names the record, says the effect, locks while the command is sent, says a refusal in place and offers the fresh read after a conflict. */
export function CommandDialog({ title, context, confirmLabel, reason, pending, error, hint, children, onCancel, onConfirm, onReload }: CommandDialogProps) {
  const { t } = useTranslation();
  const failed = error !== undefined && error !== null;
  return (
    <ConfirmDialog
      open
      title={title}
      context={context}
      confirmLabel={confirmLabel}
      cancelLabel={t('doc.repo.dialog.cancel')}
      pending={pending}
      {...(reason === undefined ? {} : { reason: { label: reason.label, required: reason.required, ...(reason.required ? { minLength: MIN_REASON, hint: t('doc.repo.dialog.reasonHint', { count: MIN_REASON }) } : {}) } })}
      error={hint ?? (failed ? problemText(t, error) : undefined)}
      onCancel={onCancel}
      onConfirm={(text) => onConfirm((text ?? '').trim())}
    >
      {children}
      {failed && describeProblem(error) === 'versionConflict' && onReload !== undefined && (
        <button type="button" className="ui-button ui-button--outline ui-button--small" data-testid="reload" onClick={onReload}>
          {t('doc.repo.dialog.reload')}
        </button>
      )}
    </ConfirmDialog>
  );
}
