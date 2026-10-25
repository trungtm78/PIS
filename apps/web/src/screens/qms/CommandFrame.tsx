import { useId } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { NavigationDialog } from '../../shell/NavigationDialog';
import './qms.css';

/** The multiplication sign on the close button of a dialog. */
const CLOSE_GLYPH = '×';

export interface CommandFrameProps {
  title: string;
  /** The refusal of the server in words, when there is one. */
  refusal: string | undefined;
  pending: boolean;
  submitLabel: string;
  /** The words of the frame itself, in the language of the screen that asks. */
  words: { close: string; cancel: string; pending: string };
  onSubmit(event: FormEvent): void;
  onClose(): void;
  children: ReactNode;
}

/** The frame the commands of QMS are asked in: a title, the refusal of the server in words, the fields and the two buttons. */
export function CommandFrame({ title, refusal, pending, submitLabel, words, onSubmit, onClose, children }: CommandFrameProps) {
  const titleId = useId();
  return (
    <NavigationDialog className="catalog command-mode" onClose={onClose}>
      <section className="command-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="command-titlebar">
          <strong id={titleId}>{title}</strong>
          <button type="button" className="icon-button" aria-label={words.close} onClick={onClose}>
            {CLOSE_GLYPH}
          </button>
        </div>
        <div className="qms-dialog-body">
          <form onSubmit={onSubmit} noValidate>
            {refusal === undefined ? null : (
              <p className="callout warning" role="alert" data-testid="refusal">
                {refusal}
              </p>
            )}
            {children}
            <div className="formfooter">
              <button type="button" onClick={onClose}>
                {words.cancel}
              </button>
              <button type="submit" className="primary" disabled={pending}>
                {pending ? words.pending : submitLabel}
              </button>
            </div>
          </form>
        </div>
      </section>
    </NavigationDialog>
  );
}
