import { useId, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { useTranslation } from '../../../i18n';
import { NavigationDialog } from '../../../shell/NavigationDialog';
import type { PeriodView } from '../../dis/model';
import { MAX_TEXT } from '../change/model';
import { Field } from '../components';
import { useCorrectMeasurement, useDecideMeasurement, useRecordMeasurement } from './hooks';
import { decisionLabel, decisionSubmitLabel, formProblemMessage, measurementProblemMessage } from './labels';
import { DECISIONS, EMPTY_DECIDE, correctBody, decideBody, describeMeasurementProblem, emptyCorrect, emptyRecord, quantityText, recordBody, validateCorrect, validateDecide, validateRecord } from './model';
import type { CorrectForm, DecideForm, ItemRow, Measurement, RecordForm } from './model';
import '../ctr.css';

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

/** The frame the commands on a measurement are asked in: a title, the refusal of the server in words, the fields and the two buttons. */
function Frame({ title, error, hasError, pending, submitLabel, onSubmit, onClose, children }: FrameProps) {
  const { t, locale } = useTranslation();
  const titleId = useId();
  return (
    <NavigationDialog className="catalog command-mode" onClose={onClose}>
      <section className="command-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="command-titlebar">
          <strong id={titleId}>{title}</strong>
          <button type="button" className="icon-button" aria-label={t('ctr.measurement.dialog.close')} onClick={onClose}>
            {CLOSE_GLYPH}
          </button>
        </div>
        <div className="ctr-dialog-body">
          <form onSubmit={onSubmit} noValidate>
            {hasError ? (
              <p className="callout warning" role="alert" data-testid="refusal">
                {measurementProblemMessage(t, describeMeasurementProblem(error), locale)}
              </p>
            ) : null}
            {children}
            <div className="formfooter">
              <button type="button" onClick={onClose}>
                {t('ctr.measurement.dialog.cancel')}
              </button>
              <button type="submit" className="primary" disabled={pending}>
                {pending ? t('ctr.measurement.dialog.pending') : submitLabel}
              </button>
            </div>
          </form>
        </div>
      </section>
    </NavigationDialog>
  );
}

export interface RecordDialogProps {
  contractId: string;
  revisionId: string;
  row: ItemRow;
  /** The periods of the tenant; undefined when the caller cannot read them, and then the period is typed as an identifier. */
  periods: readonly PeriodView[] | undefined;
  onDone(): void;
  onClose(): void;
}

/**
 * The quantity of one item done in one period. The dialog shows what is left of the item, so the person sees the limit before sending; the server judges the total against the
 * quantity of the item in the revision in force, and a number of record used before, unless a reason is given for using it again.
 */
export function RecordDialog({ contractId, revisionId, row, periods, onDone, onClose }: RecordDialogProps) {
  const { t, locale } = useTranslation();
  const record = useRecordMeasurement();
  const itemId = row.itemId ?? '';
  const [form, setForm] = useState<RecordForm>(emptyRecord(itemId));
  const [submitted, setSubmitted] = useState(false);
  const problems = validateRecord(form);
  const error = (field: keyof RecordForm): string | undefined => {
    const problem = problems[field];
    return submitted && problem !== undefined ? formProblemMessage(t, problem) : undefined;
  };
  const set = (patch: Partial<RecordForm>): void => setForm({ ...form, ...patch });
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (record.isPending || Object.keys(problems).length > 0) return;
    record.mutate({ contractId, body: recordBody(form, revisionId) }, { onSuccess: onDone });
  };
  const duplicate = record.isError && describeMeasurementProblem(record.error).problem === 'duplicateReference';
  return (
    <Frame
      title={t('ctr.measurement.record.title', { item: `${row.line.businessKey} · ${row.line.description}` })}
      error={record.error}
      hasError={record.isError}
      pending={record.isPending}
      submitLabel={t('ctr.measurement.record.submit')}
      onSubmit={send}
      onClose={onClose}
    >
      <p className="sub" data-testid="record-left">
        {t('ctr.measurement.record.left', { remaining: quantityText(row.remaining, locale), unit: row.line.unitCode })}
      </p>
      <Field id="record-period" label={t('ctr.measurement.field.period')} error={error('periodId')} hint={periods === undefined ? t('ctr.measurement.field.period.hint') : undefined}>
        {periods === undefined ? (
          <input id="record-period" autoComplete="off" value={form.periodId} onChange={(event) => set({ periodId: event.target.value })} />
        ) : (
          <select id="record-period" value={form.periodId} onChange={(event) => set({ periodId: event.target.value })}>
            <option value="">{t('ctr.measurement.field.period.choose')}</option>
            {periods.map((period) => (
              <option key={period.id} value={period.id}>
                {period.code}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field id="record-quantity" label={t('ctr.measurement.field.quantity', { unit: row.line.unitCode })} error={error('quantity')} hint={t('ctr.measurement.field.quantity.hint')}>
        <input id="record-quantity" inputMode="decimal" autoComplete="off" value={form.quantity} onChange={(event) => set({ quantity: event.target.value })} />
      </Field>
      <Field id="record-reference" label={t('ctr.measurement.field.reference')} error={error('referenceNo')}>
        <input id="record-reference" autoComplete="off" maxLength={MAX_TEXT} value={form.referenceNo} onChange={(event) => set({ referenceNo: event.target.value })} />
      </Field>
      {duplicate || form.overrideReason !== '' ? (
        <Field id="record-override" label={t('ctr.measurement.field.override')} error={error('overrideReason')} hint={t('ctr.measurement.field.override.hint')}>
          <textarea id="record-override" rows={2} maxLength={MAX_TEXT} value={form.overrideReason} onChange={(event) => set({ overrideReason: event.target.value })} />
        </Field>
      ) : null}
      <Field id="record-evidence" label={t('ctr.measurement.field.evidence')} error={error('evidence')} hint={t('ctr.measurement.field.evidence.hint')}>
        <textarea id="record-evidence" rows={2} value={form.evidence} onChange={(event) => set({ evidence: event.target.value })} />
      </Field>
    </Frame>
  );
}

export interface MeasurementDialogProps {
  measurement: Measurement;
  onDone(): void;
  onClose(): void;
}

/** The new quantity of an approved measurement, with the reason and the evidence; the old one is kept as superseded and the new one is written as a draft. */
export function CorrectDialog({ measurement, onDone, onClose }: MeasurementDialogProps) {
  const { t, locale } = useTranslation();
  const correct = useCorrectMeasurement();
  const [form, setForm] = useState<CorrectForm>(emptyCorrect(measurement.quantityPeriod));
  const [submitted, setSubmitted] = useState(false);
  const problems = validateCorrect(form);
  const error = (field: keyof CorrectForm): string | undefined => {
    const problem = problems[field];
    return submitted && problem !== undefined ? formProblemMessage(t, problem) : undefined;
  };
  const set = (patch: Partial<CorrectForm>): void => setForm({ ...form, ...patch });
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (correct.isPending || Object.keys(problems).length > 0) return;
    correct.mutate({ id: measurement.id, version: measurement.version, body: correctBody(form) }, { onSuccess: onDone });
  };
  return (
    <Frame
      title={t('ctr.measurement.correct.title', { item: measurement.boqItem.businessKey, period: measurement.period.code })}
      error={correct.error}
      hasError={correct.isError}
      pending={correct.isPending}
      submitLabel={t('ctr.measurement.correct.submit')}
      onSubmit={send}
      onClose={onClose}
    >
      <p className="sub" data-testid="correct-was">
        {t('ctr.measurement.correct.was', { quantity: quantityText(measurement.quantityPeriod, locale), unit: measurement.boqItem.unitCode })}
      </p>
      <Field id="correct-quantity" label={t('ctr.measurement.field.quantity.new', { unit: measurement.boqItem.unitCode })} error={error('quantity')} hint={t('ctr.measurement.field.quantity.hint')}>
        <input id="correct-quantity" inputMode="decimal" autoComplete="off" value={form.quantity} onChange={(event) => set({ quantity: event.target.value })} />
      </Field>
      <Field id="correct-reason" label={t('ctr.measurement.field.correction')} error={error('reason')}>
        <textarea id="correct-reason" rows={3} maxLength={MAX_TEXT} value={form.reason} onChange={(event) => set({ reason: event.target.value })} />
      </Field>
      <Field id="correct-evidence" label={t('ctr.measurement.field.evidence')} error={error('evidence')} hint={t('ctr.measurement.field.evidence.hint')}>
        <textarea id="correct-evidence" rows={2} value={form.evidence} onChange={(event) => set({ evidence: event.target.value })} />
      </Field>
    </Frame>
  );
}

/** Approve, give back or reject a measurement that was sent, with the reason; the server refuses whoever recorded or sent it. */
export function DecideDialog({ measurement, onDone, onClose }: MeasurementDialogProps) {
  const { t, locale } = useTranslation();
  const decide = useDecideMeasurement();
  const [form, setForm] = useState<DecideForm>(EMPTY_DECIDE);
  const [submitted, setSubmitted] = useState(false);
  const problems = validateDecide(form);
  const error = (field: keyof DecideForm): string | undefined => {
    const problem = problems[field];
    return submitted && problem !== undefined ? formProblemMessage(t, problem) : undefined;
  };
  const set = (patch: Partial<DecideForm>): void => setForm({ ...form, ...patch });
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (decide.isPending || form.decision === '' || Object.keys(problems).length > 0) return;
    decide.mutate({ id: measurement.id, version: measurement.version, body: decideBody(form, form.decision) }, { onSuccess: onDone });
  };
  return (
    <Frame
      title={t('ctr.measurement.decide.title', { item: measurement.boqItem.businessKey, period: measurement.period.code })}
      error={decide.error}
      hasError={decide.isError}
      pending={decide.isPending}
      submitLabel={form.decision === '' ? t('ctr.measurement.decide.submit') : decisionSubmitLabel(t, form.decision)}
      onSubmit={send}
      onClose={onClose}
    >
      <p className="sub" data-testid="decide-quantity">
        {t('ctr.measurement.decide.quantity', { quantity: quantityText(measurement.quantityPeriod, locale), unit: measurement.boqItem.unitCode })}
      </p>
      <fieldset className="field" data-field="decision">
        <legend>{t('ctr.measurement.decide.legend')}</legend>
        {DECISIONS.map((decision) => (
          <label key={decision} className="radio">
            <input type="radio" name="decision" value={decision} data-decision={decision} checked={form.decision === decision} onChange={() => set({ decision })} /> {decisionLabel(t, decision)}
          </label>
        ))}
        {error('decision') === undefined ? null : (
          <small role="alert" className="field-error">
            {error('decision')}
          </small>
        )}
      </fieldset>
      <Field id="decide-reason" label={t('ctr.measurement.field.reason')} error={error('reason')}>
        <textarea id="decide-reason" rows={3} maxLength={MAX_TEXT} value={form.reason} onChange={(event) => set({ reason: event.target.value })} />
      </Field>
      <Field id="decide-evidence" label={t('ctr.measurement.field.decisionEvidence')} error={error('evidence')} hint={t('ctr.measurement.field.decisionEvidence.hint')}>
        <textarea id="decide-evidence" rows={2} value={form.evidence} onChange={(event) => set({ evidence: event.target.value })} />
      </Field>
    </Frame>
  );
}
