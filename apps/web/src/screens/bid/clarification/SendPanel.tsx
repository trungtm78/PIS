import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../../i18n';
import { wireControl } from '../../field-wiring';
import { Field } from '../components';
import { useSendClarification } from './hooks';
import { formProblemMessage, problemMessage } from './labels';
import { MAX_QUESTION, MIN_QUESTION, describeProblem, emptySend, sendBody, validateSend } from './model';
import type { Recipient, SendForm } from './model';
import './clarification.css';
import '../bid.css';

export interface SendPanelProps {
  packageCode: string;
  recipients: readonly Recipient[];
  /** The proposal named in the address, when it is one of the recipients: the recipient starts there. */
  preselected: string;
}

/**
 * The question of the evaluation team to the contractor of a proposal (BID-11): the recipient, the words, the finding of the analysis they rest on when one is named, and the moment by which the contractor
 * answers. The server judges everything again; a refusal is shown in words and the question stays as it was typed.
 */
export function SendPanel({ packageCode, recipients, preselected }: SendPanelProps) {
  const { t } = useTranslation();
  const ids = { proposal: useId(), question: useId(), basis: useId(), due: useId() };
  const send = useSendClarification();
  const [form, setForm] = useState<SendForm>(emptySend());
  const [submitted, setSubmitted] = useState(false);
  // The recipient is the one the person chose among the proposals of this package, else the one the address names: a choice made for another package is not one.
  const chosen = recipients.some((recipient) => recipient.proposalId === form.proposalId) ? form.proposalId : '';
  const proposalId = chosen !== '' ? chosen : preselected;
  const current: SendForm = { ...form, proposalId };
  const problems = validateSend(current, new Date());
  const shown = (field: keyof SendForm): string | undefined => {
    const problem = problems[field];
    return submitted && problem !== undefined ? formProblemMessage(t, problem) : undefined;
  };
  const pending = send.isPending;
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (pending || Object.keys(problems).length > 0) return;
    send.mutate(sendBody(current), {
      onSuccess: () => {
        setForm({ ...emptySend(), proposalId });
        setSubmitted(false);
      },
    });
  };

  return (
    <div className="card" data-testid="send-panel">
      <h2>{t('bid.clarifications.send.title', { code: packageCode })}</h2>
      {recipients.length === 0 ? (
        <p className="callout" role="status" data-testid="no-recipients">
          {t('bid.clarifications.send.noRecipients')}
        </p>
      ) : (
        <form onSubmit={submit} noValidate data-testid="send-form">
          {send.isError ? (
            <p className="callout warning" role="alert" data-testid="send-refusal">
              {problemMessage(t, describeProblem(send.error))}
            </p>
          ) : null}
          {send.isSuccess ? (
            <p className="callout" role="status" data-testid="sent">
              {t('bid.clarifications.send.sent')}
            </p>
          ) : null}
          <Field id={ids.proposal} label={t('bid.clarifications.send.recipient.label')} error={shown('proposalId')}>
            {wireControl(
              <select id={ids.proposal} value={proposalId} disabled={pending} onChange={(event) => setForm({ ...form, proposalId: event.target.value })}>
                <option value="">{t('bid.clarifications.send.recipient.choose')}</option>
                {recipients.map((recipient) => (
                  <option key={recipient.proposalId} value={recipient.proposalId}>
                    {recipient.contractorName}
                  </option>
                ))}
              </select>,
              ids.proposal,
              { hint: false, error: shown('proposalId') !== undefined },
            )}
          </Field>
          <Field id={ids.question} label={t('bid.clarifications.send.question.label')} error={shown('question')}>
            {wireControl(<textarea id={ids.question} rows={4} readOnly={pending} value={form.question} onChange={(event) => setForm({ ...form, question: event.target.value })} />, ids.question, {
              hint: false,
              error: shown('question') !== undefined,
            })}
            <small className="sub" data-testid="question-count">
              {t('bid.clarifications.send.question.count', { count: form.question.trim().length, min: MIN_QUESTION, max: MAX_QUESTION })}
            </small>
          </Field>
          <Field id={ids.basis} label={t('bid.clarifications.send.basis.label')} error={shown('basisFindingId')} hint={t('bid.clarifications.send.basis.hint')}>
            {wireControl(<input id={ids.basis} autoComplete="off" readOnly={pending} value={form.basisFindingId} onChange={(event) => setForm({ ...form, basisFindingId: event.target.value })} />, ids.basis, {
              hint: false,
              error: shown('basisFindingId') !== undefined,
            })}
          </Field>
          <Field id={ids.due} label={t('bid.clarifications.send.due.label')} error={shown('dueAt')} hint={t('bid.clarifications.send.due.hint')}>
            {wireControl(<input id={ids.due} type="datetime-local" readOnly={pending} value={form.dueAt} onChange={(event) => setForm({ ...form, dueAt: event.target.value })} />, ids.due, {
              hint: false,
              error: shown('dueAt') !== undefined,
            })}
          </Field>
          <div className="formfooter">
            <button type="submit" className="primary" disabled={pending}>
              {pending ? t('bid.clarifications.send.pending') : t('bid.clarifications.send.submit')}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
