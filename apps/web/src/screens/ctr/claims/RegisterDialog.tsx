import type { ReactNode } from 'react';
import { useTranslation } from '../../../i18n';
import { ConfirmDialog } from '../../../ui';
import { problemText } from './common';
import type { Problem } from './common';

export interface RegisterDialogProps {
  title: string;
  /** What the dialog is about: the record and the effect, shown before the fields. */
  context: Array<{ label: string; value: string }>;
  confirmLabel: string;
  /** The words of the reason or note the command carries; the dialog keeps the button off until they are long enough. */
  note?: { label: string; hint?: string; minLength: number };
  pending: boolean;
  problem: Problem | undefined;
  /** The fields besides the note. */
  children?: ReactNode;
  onSubmit: (note: string) => void;
  onCancel: () => void;
  onReload?: () => void;
}

/** The dialog of a command of the registers (claims, terms, warnings): it names the record and the effect, asks for the words, locks while it sends and says in place why a command was refused (a version conflict also offers the reload). */
export function RegisterDialog({ title, context, confirmLabel, note, pending, problem, children, onSubmit, onCancel, onReload }: RegisterDialogProps) {
  const { t } = useTranslation();
  return (
    <ConfirmDialog
      open
      title={title}
      context={context}
      confirmLabel={confirmLabel}
      cancelLabel={t('ctrReg.dialog.cancel.action')}
      pending={pending}
      {...(note === undefined ? {} : { reason: { label: note.label, required: true, minLength: note.minLength, ...(note.hint === undefined ? {} : { hint: note.hint }) } })}
      {...(problem === undefined ? {} : { error: problemText(t, problem) })}
      onConfirm={(text) => onSubmit(text ?? '')}
      onCancel={onCancel}
    >
      {children}
      {problem?.kind === 'versionConflict' && onReload !== undefined && (
        <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={onReload}>
          {t('ctrReg.problem.reload.action')}
        </button>
      )}
    </ConfirmDialog>
  );
}
