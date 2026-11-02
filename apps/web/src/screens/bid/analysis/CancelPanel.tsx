import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../../i18n';
import { describeProblem, validateReason } from './model';
import type { ReasonProblem } from './model';
import { problemMessage, reasonProblemMessage } from './labels';
import '../bid.css';

export interface CancelPanelProps {
  /** The cancellation is being sent: what was typed is what is sent, so the field does not change meanwhile. */
  pending: boolean;
  /** The refusal of the last attempt, when there was one. */
  refusal: unknown;
  onCancel(reason: string): void;
}

/**
 * The cancellation of a run that waits for the experts, with the reason of the person who cancels it (BID-08). It frees the input of the run to be asked again; the run and its findings stay as they were, and
 * what the run cost stays settled. What was typed is kept when the server refuses, so that nothing has to be typed again.
 */
export function CancelPanel({ pending, refusal, onCancel }: CancelPanelProps) {
  const { t } = useTranslation();
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<ReasonProblem | undefined>(undefined);
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const found = validateReason(reason);
    setProblem(found);
    if (found === undefined && !pending) onCancel(reason);
  };
  return (
    <form className="card" onSubmit={submit} noValidate data-testid="cancel-form">
      <h2>{t('bid.analysis.cancel.heading')}</h2>
      <p className="sub">{t('bid.analysis.cancel.hint')}</p>
      {refusal === undefined || refusal === null ? null : (
        <p className="callout warning" role="alert" data-testid="cancel-refusal">
          {problemMessage(t, describeProblem(refusal))}
        </p>
      )}
      <div className="field">
        <label htmlFor="analysis-cancel-reason">{t('bid.analysis.cancel.label')}</label>
        <textarea id="analysis-cancel-reason" rows={3} readOnly={pending} value={reason} onChange={(event) => setReason(event.target.value)} />
        {problem === undefined ? null : (
          <small role="alert" className="field-error">
            {reasonProblemMessage(t, problem)}
          </small>
        )}
      </div>
      <div className="formfooter">
        <button type="submit" disabled={pending}>
          {pending ? t('bid.analysis.cancel.pending') : t('bid.analysis.cancel.action')}
        </button>
      </div>
    </form>
  );
}
