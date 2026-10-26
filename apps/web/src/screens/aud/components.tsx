import { useId } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { useTranslation } from '../../i18n';
import { NavigationDialog } from '../../shell/NavigationDialog';
import { errorIdOf, hintIdOf, wireControl } from '../field-wiring';
import './aud.css';

/** The multiplication sign on the close button of a dialog. */
const CLOSE_GLYPH = '×';

interface FieldProps {
  id: string;
  label: string;
  error: string | undefined;
  hint?: string;
  children: ReactNode;
}

/** A label, its control, the hint under it and the problem with it; the control is tied to both for assistive technology. */
export function Field({ id, label, error, hint, children }: FieldProps) {
  return (
    <div className="field" data-field={id}>
      <label htmlFor={id}>{label}</label>
      {wireControl(children, id, { hint: hint !== undefined, error: error !== undefined })}
      {hint === undefined ? null : (
        <small className="sub" id={hintIdOf(id)}>
          {hint}
        </small>
      )}
      {error === undefined ? null : (
        <small role="alert" className="field-error" id={errorIdOf(id)}>
          {error}
        </small>
      )}
    </div>
  );
}

interface DialogFrameProps {
  title: string;
  onClose(): void;
  refusal: string | undefined;
  pending: boolean;
  onSubmit(event: FormEvent): void;
  children: ReactNode;
}

/** The frame the commands share: the title bar, the refusal of the server, the form and its two buttons. */
export function DialogFrame({ title, onClose, refusal, pending, onSubmit, children }: DialogFrameProps) {
  const { t } = useTranslation();
  const titleId = useId();
  return (
    <NavigationDialog className="catalog command-mode" onClose={onClose}>
      <section className="command-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="command-titlebar">
          <strong id={titleId}>{title}</strong>
          <button type="button" className="icon-button" aria-label={t('aud.dialog.close.label')} onClick={onClose}>
            {CLOSE_GLYPH}
          </button>
        </div>
        <div className="aud-dialog-body">
          <form onSubmit={onSubmit} noValidate>
            {refusal === undefined ? null : (
              <p className="callout warning" role="alert" data-testid="refusal">
                {refusal}
              </p>
            )}
            <div className="formgrid">{children}</div>
            <div className="formfooter">
              <button type="button" onClick={onClose}>
                {t('aud.dialog.cancel.action')}
              </button>
              <button type="submit" className="primary" disabled={pending}>
                {pending ? t('aud.dialog.submit.pending') : t('aud.dialog.submit.action')}
              </button>
            </div>
          </form>
        </div>
      </section>
    </NavigationDialog>
  );
}
