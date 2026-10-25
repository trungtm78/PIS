import { useId, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { useTranslation } from '../../../i18n';
import { NavigationDialog } from '../../../shell/NavigationDialog';
import { Field } from '../components';
import { useEvaluateChange, usePromoteChange, useWithdrawChange } from './hooks';
import { formProblemMessage, problemMessage, stageLabel } from './labels';
import { EMPTY_REASON, MAX_TEXT, describeProblem, emptyEvaluate, evaluateBody, isIncrease, validateEvaluate, validateReason } from './model';
import type { ChangeRequest, EvaluateForm, ReasonForm } from './model';
import '../ctr.css';

/** The multiplication sign on the close button of a dialog. */
const CLOSE_GLYPH = '×';

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

/** The frame the three commands of a request are asked in: a title, the refusal of the server in words, the fields and the two buttons. */
function Frame({ title, error, hasError, pending, submitLabel, onSubmit, onClose, children }: FrameProps) {
  const { t } = useTranslation();
  const titleId = useId();
  return (
    <NavigationDialog className="catalog command-mode" onClose={onClose}>
      <section className="command-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="command-titlebar">
          <strong id={titleId}>{title}</strong>
          <button type="button" className="icon-button" aria-label={t('ctr.change.dialog.close')} onClick={onClose}>
            {CLOSE_GLYPH}
          </button>
        </div>
        <div className="ctr-dialog-body">
          <form onSubmit={onSubmit} noValidate>
            {hasError ? (
              <p className="callout warning" role="alert" data-testid="refusal">
                {problemMessage(t, describeProblem(error))}
              </p>
            ) : null}
            {children}
            <div className="formfooter">
              <button type="button" onClick={onClose}>
                {t('ctr.change.dialog.cancel')}
              </button>
              <button type="submit" className="primary" disabled={pending}>
                {pending ? t('ctr.change.dialog.pending') : submitLabel}
              </button>
            </div>
          </form>
        </div>
      </section>
    </NavigationDialog>
  );
}

export interface DialogProps {
  request: ChangeRequest;
  onClose(): void;
}

/** What the person says to promote a request to the next tier of the chain, or to withdraw it. */
export function ReasonDialog({ kind, request, onClose }: DialogProps & { kind: 'promote' | 'withdraw' }) {
  const { t } = useTranslation();
  const promote = usePromoteChange();
  const withdraw = useWithdrawChange();
  const command = kind === 'promote' ? promote : withdraw;
  const [form, setForm] = useState<ReasonForm>(EMPTY_REASON);
  const [submitted, setSubmitted] = useState(false);
  const problems = validateReason(form);
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (command.isPending || Object.keys(problems).length > 0) return;
    command.mutate({ id: request.id, version: request.version, reason: form.reason.trim() }, { onSuccess: onClose });
  };
  const code = request.code ?? request.id;
  return (
    <Frame
      title={kind === 'promote' ? t('ctr.change.promote.title', { code }) : t('ctr.change.withdraw.title', { code })}
      error={command.error}
      hasError={command.isError}
      pending={command.isPending}
      submitLabel={kind === 'promote' ? t('ctr.change.promote.submit') : t('ctr.change.withdraw.submit')}
      onSubmit={send}
      onClose={onClose}
    >
      <Field id="change-reason" label={kind === 'promote' ? t('ctr.change.promote.field') : t('ctr.change.withdraw.field')} error={submitted && problems.reason !== undefined ? formProblemMessage(t, problems.reason) : undefined}>
        <textarea id="change-reason" rows={4} maxLength={MAX_TEXT} value={form.reason} onChange={(event) => setForm({ reason: event.target.value })} />
      </Field>
    </Frame>
  );
}

/**
 * The assessment of a PCO or a CO: the cost, the schedule, the scope and the funding. An increase has to fit the line of capital it is paid from, so the line is named; the server asks
 * the availability control of the capital and answers with the reason when the line cannot take it.
 */
export function EvaluateDialog({ request, onClose }: DialogProps) {
  const { t } = useTranslation();
  const evaluate = useEvaluateChange();
  const [form, setForm] = useState<EvaluateForm>(emptyEvaluate(request));
  const [submitted, setSubmitted] = useState(false);
  const problems = validateEvaluate(form);
  const error = (field: keyof EvaluateForm): string | undefined => {
    const problem = problems[field];
    return submitted && problem !== undefined ? formProblemMessage(t, problem) : undefined;
  };
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (evaluate.isPending || Object.keys(problems).length > 0) return;
    evaluate.mutate({ id: request.id, version: request.version, body: evaluateBody(form) }, { onSuccess: onClose });
  };
  const set = (patch: Partial<EvaluateForm>): void => setForm({ ...form, ...patch });
  return (
    <Frame
      title={t('ctr.change.evaluate.title', { code: request.code ?? request.id, stage: stageLabel(t, request.stage) })}
      error={evaluate.error}
      hasError={evaluate.isError}
      pending={evaluate.isPending}
      submitLabel={t('ctr.change.evaluate.submit')}
      onSubmit={send}
      onClose={onClose}
    >
      <div className="formgrid">
        <Field id="change-evaluated" label={t('ctr.change.evaluate.amount.label')} error={error('evaluatedDeltaVnd')} hint={t('ctr.change.evaluate.amount.hint')}>
          <input id="change-evaluated" inputMode="numeric" autoComplete="off" value={form.evaluatedDeltaVnd} onChange={(event) => set({ evaluatedDeltaVnd: event.target.value })} />
        </Field>
        <Field id="change-days" label={t('ctr.change.evaluate.days.label')} error={error('scheduleImpactDays')} hint={t('ctr.change.evaluate.days.hint')}>
          <input id="change-days" inputMode="numeric" autoComplete="off" value={form.scheduleImpactDays} onChange={(event) => set({ scheduleImpactDays: event.target.value })} />
        </Field>
        <Field id="change-funding" label={t('ctr.change.evaluate.funding.label')} error={error('fundingImpactNote')}>
          <textarea id="change-funding" rows={3} maxLength={MAX_TEXT} value={form.fundingImpactNote} onChange={(event) => set({ fundingImpactNote: event.target.value })} />
        </Field>
        <Field id="change-scope" label={t('ctr.change.evaluate.scope.label')} error={error('scopeImpactNote')}>
          <textarea id="change-scope" rows={3} maxLength={MAX_TEXT} value={form.scopeImpactNote} onChange={(event) => set({ scopeImpactNote: event.target.value })} />
        </Field>
        <Field
          id="change-line"
          label={t('ctr.change.evaluate.line.label')}
          error={error('allocationLineId')}
          hint={isIncrease(form.evaluatedDeltaVnd) ? t('ctr.change.evaluate.line.required') : t('ctr.change.evaluate.line.optional')}
        >
          <input id="change-line" autoComplete="off" value={form.allocationLineId} onChange={(event) => set({ allocationLineId: event.target.value })} />
        </Field>
      </div>
    </Frame>
  );
}
