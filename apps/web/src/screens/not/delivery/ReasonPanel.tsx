import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { REASON_MAX_LENGTH, reasonIsValid } from './model';

export interface ReasonPanelProps {
  /** For the browser flows and the tests. */
  testId: string;
  title: string;
  /** What the command does, in one sentence. */
  hint: string;
  /** A warning the operator must read before confirming (a replay that may send the message twice). */
  risk?: string | undefined;
  reasonLabel: string;
  reasonError: string;
  confirmLabel: string;
  dismissLabel: string;
  pending: boolean;
  /** The message of the last failure of the command, if any. */
  problem?: string | undefined;
  onConfirm(reason: string): void;
  onDismiss(): void;
}

/**
 * The reason an operator gives for a command on a notification (10 to 2000 characters, kept in the audit trail). The panel holds the text and the
 * validation; the command and its messages belong to the screen that opens it.
 */
export function ReasonPanel(props: ReasonPanelProps) {
  const [reason, setReason] = useState('');
  const [invalid, setInvalid] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);

  // The panel opens under the table the operator was in: the keyboard goes to the reason, the one thing the command needs.
  useEffect(() => field.current?.focus(), []);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (!reasonIsValid(reason)) {
      setInvalid(true);
      field.current?.focus();
      return;
    }
    props.onConfirm(reason.trim());
  };

  return (
    <form className="replay-panel" onSubmit={submit} aria-label={props.title} data-testid={props.testId}>
      <h3>{props.title}</h3>
      <p className="sub">{props.hint}</p>
      {props.risk === undefined ? null : (
        <p className="callout warning" role="status" data-testid={`${props.testId}-risk`}>
          {props.risk}
        </p>
      )}
      {props.problem === undefined ? null : (
        <p className="callout warning" role="alert" data-testid={`${props.testId}-problem`}>
          {props.problem}
        </p>
      )}
      <div className="field" data-field={`${props.testId}-reason`}>
        <label htmlFor={`${props.testId}-reason`}>{props.reasonLabel}</label>
        <textarea
          id={`${props.testId}-reason`}
          ref={field}
          value={reason}
          maxLength={REASON_MAX_LENGTH + 1}
          aria-invalid={invalid ? true : undefined}
          aria-describedby={invalid ? `${props.testId}-reason-error` : undefined}
          onChange={(event) => setReason(event.target.value)}
        />
        {invalid ? (
          <small role="alert" className="field-error" id={`${props.testId}-reason-error`}>
            {props.reasonError}
          </small>
        ) : null}
      </div>
      <div className="formfooter">
        <button type="submit" className="primary" disabled={props.pending}>
          {props.confirmLabel}
        </button>
        <button type="button" onClick={props.onDismiss}>
          {props.dismissLabel}
        </button>
      </div>
    </form>
  );
}
