import { useId, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { useTranslation } from '../../../i18n';
import { NavigationDialog } from '../../../shell/NavigationDialog';
import { wireControl } from '../../field-wiring';
import { Field } from '../components';
import { useContractorOptions } from '../proposal/hooks';
import type { TrackedPackage } from '../procurement/model';
import { useDecideResult, useSubmitResult } from './hooks';
import { formProblemMessage, outcomeLabel, problemMessage } from './labels';
import { EMPTY_DECIDE, EMPTY_SUBMIT, MAX_COMMENT, OUTCOMES, decideBody, describeProblem, submitBody, validateDecide, validateSubmit } from './model';
import type { DecideForm, FormProblem, ResultLine, SubmitForm } from './model';
import '../bid.css';

/** The multiplication sign on the close button of a dialog. */
const CLOSE_GLYPH = '\u00d7';

interface FrameProps {
  title: string;
  error: unknown;
  hasError: boolean;
  pending: boolean;
  submitLabel: string;
  onSubmit(event: FormEvent): void;
  onClose(): void;
  children: ReactNode;
}

/** The frame both commands are asked in: a title, the refusal of the server in words, the fields and the two buttons. */
function Frame({ title, error, hasError, pending, submitLabel, onSubmit, onClose, children }: FrameProps) {
  const { t } = useTranslation();
  const titleId = useId();
  return (
    <NavigationDialog className="catalog command-mode" onClose={onClose}>
      <section className="command-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="command-titlebar">
          <strong id={titleId}>{title}</strong>
          <button type="button" className="icon-button" aria-label={t('bid.results.dialog.close')} onClick={onClose}>
            {CLOSE_GLYPH}
          </button>
        </div>
        <div className="bid-dialog-body">
          <form onSubmit={onSubmit} noValidate>
            {hasError ? (
              <p className="callout warning" role="alert" data-testid="refusal">
                {problemMessage(t, describeProblem(error))}
              </p>
            ) : null}
            {children}
            <div className="formfooter">
              <button type="button" onClick={onClose}>
                {t('bid.results.dialog.cancel')}
              </button>
              <button type="submit" className="primary" disabled={pending}>
                {pending ? t('bid.results.dialog.pending') : submitLabel}
              </button>
            </div>
          </form>
        </div>
      </section>
    </NavigationDialog>
  );
}

/**
 * The submission of the result of a package: the outcome, and for an award the winner and the price (the price of the package is the ceiling; the server judges it with the
 * restriction on the winner and the evaluation that was issued). Nothing of an analysis made by a machine is asked for or offered.
 */
export function SubmitDialog({ pack, onClose }: { pack: TrackedPackage; onClose(): void }) {
  const { t } = useTranslation();
  const contractors = useContractorOptions(true);
  const submit = useSubmitResult();
  const [form, setForm] = useState<SubmitForm>(EMPTY_SUBMIT);
  const [submitted, setSubmitted] = useState(false);
  const problems = validateSubmit(form);
  const shown = (field: keyof SubmitForm): string | undefined => {
    const problem: FormProblem | undefined = problems[field];
    return submitted && problem !== undefined ? formProblemMessage(t, problem) : undefined;
  };
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (submit.isPending || Object.keys(problems).length > 0) return;
    submit.mutate(submitBody(pack.id, form), { onSuccess: onClose });
  };
  const awarded = form.outcome === 'AWARDED';
  return (
    <Frame title={t('bid.results.submit.title', { code: pack.code })} error={submit.error} hasError={submit.isError} pending={submit.isPending} submitLabel={t('bid.results.submit.action')} onSubmit={send} onClose={onClose}>
      <Field id="result-outcome" label={t('bid.results.field.outcome')} error={shown('outcome')}>
        {wireControl(
          <select id="result-outcome" value={form.outcome} onChange={(event) => setForm({ ...form, outcome: OUTCOMES.find((outcome) => outcome === event.target.value) ?? '', winnerId: '', awardPriceVnd: '' })}>
            <option value="">{t('bid.results.field.outcome.choose')}</option>
            {OUTCOMES.map((outcome) => (
              <option key={outcome} value={outcome}>
                {outcomeLabel(t, outcome)}
              </option>
            ))}
          </select>,
          'result-outcome',
          { hint: false, error: shown('outcome') !== undefined },
        )}
      </Field>
      {awarded ? (
        <>
          <Field id="result-winner" label={t('bid.results.field.winner')} error={shown('winnerId')}>
            {wireControl(
              <select id="result-winner" value={form.winnerId} onChange={(event) => setForm({ ...form, winnerId: event.target.value })}>
                <option value="">{t('bid.results.field.winner.choose')}</option>
                {(contractors.data ?? []).map((contractor) => (
                  <option key={contractor.id} value={contractor.id}>
                    {contractor.legalName}
                  </option>
                ))}
              </select>,
              'result-winner',
              { hint: false, error: shown('winnerId') !== undefined },
            )}
          </Field>
          <Field id="result-price" label={t('bid.results.field.price')} error={shown('awardPriceVnd')} hint={t('bid.results.field.price.hint')}>
            {wireControl(<input id="result-price" inputMode="numeric" autoComplete="off" value={form.awardPriceVnd} onChange={(event) => setForm({ ...form, awardPriceVnd: event.target.value })} />, 'result-price', {
              hint: false,
              error: shown('awardPriceVnd') !== undefined,
            })}
          </Field>
        </>
      ) : null}
      <Field id="result-minutes" label={t('bid.results.field.minutes')} error={shown('minutesId')} hint={t('bid.results.field.minutes.hint')}>
        {wireControl(<input id="result-minutes" autoComplete="off" value={form.minutesId} onChange={(event) => setForm({ ...form, minutesId: event.target.value })} />, 'result-minutes', {
          hint: false,
          error: shown('minutesId') !== undefined,
        })}
      </Field>
    </Frame>
  );
}

/**
 * The decision of a result that was submitted: approve it on a decision document of the authority (with a note if there is one) or turn it down with the reason in words. The
 * decision is a person's; the screen offers no suggestion, no score and no shortcut that a machine produced.
 */
export function DecideDialog({ line, onClose }: { line: ResultLine; onClose(): void }) {
  const { t } = useTranslation();
  const decide = useDecideResult();
  const [form, setForm] = useState<DecideForm>(EMPTY_DECIDE);
  const [submitted, setSubmitted] = useState(false);
  const problems = validateDecide(form);
  const shown = (field: keyof DecideForm): string | undefined => {
    const problem: FormProblem | undefined = problems[field];
    return submitted && problem !== undefined ? formProblemMessage(t, problem) : undefined;
  };
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (decide.isPending || Object.keys(problems).length > 0) return;
    decide.mutate({ id: line.id, version: line.version, body: decideBody(form) }, { onSuccess: onClose });
  };
  return (
    <Frame
      title={t('bid.results.decide.title', { code: line.package.code })}
      error={decide.error}
      hasError={decide.isError}
      pending={decide.isPending}
      submitLabel={form.decision === 'REJECT' ? t('bid.results.decide.reject') : t('bid.results.decide.approve')}
      onSubmit={send}
      onClose={onClose}
    >
      <fieldset className="field" data-field="result-decision">
        <legend>{t('bid.results.field.decision')}</legend>
        {(['APPROVE', 'REJECT'] as const).map((kind) => (
          <label key={kind} className="radio">
            <input type="radio" name="result-decision" value={kind} data-decision={kind} checked={form.decision === kind} onChange={() => setForm({ ...form, decision: kind })} />{' '}
            {kind === 'APPROVE' ? t('bid.results.decide.approve') : t('bid.results.decide.reject')}
          </label>
        ))}
        {shown('decision') === undefined ? null : (
          <small role="alert" className="field-error">
            {shown('decision')}
          </small>
        )}
      </fieldset>
      {form.decision === 'APPROVE' ? (
        <Field id="result-document" label={t('bid.results.field.document')} error={shown('documentId')} hint={t('bid.results.field.document.hint')}>
          {wireControl(<input id="result-document" autoComplete="off" value={form.documentId} onChange={(event) => setForm({ ...form, documentId: event.target.value })} />, 'result-document', {
            hint: false,
            error: shown('documentId') !== undefined,
          })}
        </Field>
      ) : null}
      {form.decision === '' ? null : (
        <Field id="result-comment" label={form.decision === 'REJECT' ? t('bid.results.field.reason') : t('bid.results.field.note')} error={shown('comment')}>
          {wireControl(<textarea id="result-comment" rows={3} maxLength={MAX_COMMENT} value={form.comment} onChange={(event) => setForm({ ...form, comment: event.target.value })} />, 'result-comment', {
            hint: false,
            error: shown('comment') !== undefined,
          })}
        </Field>
      )}
    </Frame>
  );
}
