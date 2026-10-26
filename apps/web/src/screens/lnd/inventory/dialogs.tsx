import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../../i18n';
import { DialogFrame, Field } from '../components';
import { useAnswerInventory, useRecordInventory } from './hooks';
import { commandProblemMessage, formProblemMessage, itemKindLabel, outcomeLabel } from './labels';
import { EMPTY_ANSWER_FORM, EMPTY_RECORD_FORM, ITEM_KINDS, OUTCOMES, amountOf, answerBody, describeProblem, formatVnd, recordBody, validateAnswer, validateRecord } from './model';
import type { AnswerForm, InventoryLine, RecordForm } from './model';

/** The counting of one asset of a household on a parcel it holds a right on: the amount is shown as the server will compute it, and the price decision is the one in force on the day of the survey. */
export function RecordDialog({ householdId, parcels, today, onClose }: { householdId: string; parcels: ReadonlyArray<{ id: string; parcelCode: string }>; today: string; onClose(): void }) {
  const { t } = useTranslation();
  const record = useRecordInventory();
  const [form, setForm] = useState<RecordForm>(EMPTY_RECORD_FORM);
  const [submitted, setSubmitted] = useState(false);
  const problems = validateRecord(form, today);
  const amount = amountOf(form.quantity, form.unitPriceVnd);
  const error = (field: keyof RecordForm): string | undefined => {
    const problem = problems[field];
    return submitted && problem !== undefined ? formProblemMessage(t, problem) : undefined;
  };
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (record.isPending || Object.keys(problems).length > 0) return;
    record.mutate(recordBody(householdId, form), { onSuccess: onClose });
  };
  return (
    <DialogFrame
      title={t('lnd.inventory.recordDialog.title.text')}
      onClose={onClose}
      refusal={record.isError ? commandProblemMessage(t, describeProblem(record.error)) : undefined}
      pending={record.isPending}
      onSubmit={submit}
    >
      <Field id="inventory-parcel" label={t('lnd.inventory.recordDialog.parcel.label')} error={error('parcelId')} hint={t('lnd.inventory.recordDialog.parcel.help')}>
        <select id="inventory-parcel" value={form.parcelId} onChange={(event) => setForm({ ...form, parcelId: event.target.value })}>
          <option value="">{t('lnd.inventory.recordDialog.parcel.choose')}</option>
          {parcels.map((parcel) => (
            <option key={parcel.id} value={parcel.id}>
              {parcel.parcelCode}
            </option>
          ))}
        </select>
      </Field>
      <Field id="inventory-kind" label={t('lnd.inventory.recordDialog.kind.label')} error={error('itemKind')}>
        <select id="inventory-kind" value={form.itemKind} onChange={(event) => setForm({ ...form, itemKind: event.target.value as RecordForm['itemKind'] })}>
          <option value="">{t('lnd.inventory.recordDialog.kind.choose')}</option>
          {ITEM_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {itemKindLabel(t, kind)}
            </option>
          ))}
        </select>
      </Field>
      <Field id="inventory-description" label={t('lnd.inventory.recordDialog.description.label')} error={error('description')} hint={t('lnd.inventory.recordDialog.description.help')}>
        <input id="inventory-description" autoComplete="off" value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} />
      </Field>
      <Field id="inventory-quantity" label={t('lnd.inventory.recordDialog.quantity.label')} error={error('quantity')} hint={t('lnd.inventory.recordDialog.quantity.help')}>
        <input id="inventory-quantity" inputMode="decimal" value={form.quantity} onChange={(event) => setForm({ ...form, quantity: event.target.value })} />
      </Field>
      <Field id="inventory-unit" label={t('lnd.inventory.recordDialog.unit.label')} error={error('unitCode')}>
        <input id="inventory-unit" value={form.unitCode} onChange={(event) => setForm({ ...form, unitCode: event.target.value })} />
      </Field>
      <Field id="inventory-price" label={t('lnd.inventory.recordDialog.price.label')} error={error('unitPriceVnd')} hint={t('lnd.inventory.recordDialog.price.help')}>
        <input id="inventory-price" inputMode="numeric" value={form.unitPriceVnd} onChange={(event) => setForm({ ...form, unitPriceVnd: event.target.value })} />
      </Field>
      <p data-testid="amount-preview" className="sub">
        {amount === undefined ? t('lnd.inventory.recordDialog.amount.none') : t('lnd.inventory.recordDialog.amount.text', { amount: formatVnd(amount) })}
      </p>
      <Field id="inventory-decision" label={t('lnd.inventory.recordDialog.decision.label')} error={error('priceDecisionRef')} hint={t('lnd.inventory.recordDialog.decision.help')}>
        <input id="inventory-decision" value={form.priceDecisionRef} onChange={(event) => setForm({ ...form, priceDecisionRef: event.target.value })} />
      </Field>
      <Field id="inventory-surveyed" label={t('lnd.inventory.recordDialog.surveyed.label')} error={error('surveyedOn')}>
        <input id="inventory-surveyed" type="date" max={today} value={form.surveyedOn} onChange={(event) => setForm({ ...form, surveyedOn: event.target.value })} />
      </Field>
      <Field id="inventory-document" label={t('lnd.inventory.recordDialog.document.label')} error={error('documentVersionId')} hint={t('lnd.inventory.recordDialog.document.help')}>
        <input id="inventory-document" value={form.documentVersionId} onChange={(event) => setForm({ ...form, documentVersionId: event.target.value })} />
      </Field>
    </DialogFrame>
  );
}

/** The answer of the household to a record: it accepts the count, or it objects and says why. */
export function AnswerDialog({ record, today, onClose }: { record: InventoryLine; today: string; onClose(): void }) {
  const { t } = useTranslation();
  const answer = useAnswerInventory();
  const [form, setForm] = useState<AnswerForm>(EMPTY_ANSWER_FORM);
  const [submitted, setSubmitted] = useState(false);
  const problems = validateAnswer(form, record, today);
  const error = (field: keyof AnswerForm): string | undefined => {
    const problem = problems[field];
    return submitted && problem !== undefined ? formProblemMessage(t, problem) : undefined;
  };
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (answer.isPending || Object.keys(problems).length > 0) return;
    answer.mutate({ id: record.id, version: record.version, body: answerBody(form) }, { onSuccess: onClose });
  };
  return (
    <DialogFrame
      title={t('lnd.inventory.answerDialog.title.text', { code: record.parcelCode })}
      onClose={onClose}
      refusal={answer.isError ? commandProblemMessage(t, describeProblem(answer.error)) : undefined}
      pending={answer.isPending}
      onSubmit={submit}
    >
      <p data-testid="answer-summary">{t('lnd.inventory.answerDialog.summary.text', { kind: itemKindLabel(t, record.itemKind), amount: formatVnd(record.amountVnd) })}</p>
      <Field id="answer-outcome" label={t('lnd.inventory.answerDialog.outcome.label')} error={error('outcome')}>
        <select id="answer-outcome" value={form.outcome} onChange={(event) => setForm({ ...form, outcome: event.target.value as AnswerForm['outcome'] })}>
          <option value="">{t('lnd.inventory.answerDialog.outcome.choose')}</option>
          {OUTCOMES.map((outcome) => (
            <option key={outcome} value={outcome}>
              {outcomeLabel(t, outcome)}
            </option>
          ))}
        </select>
      </Field>
      <Field id="answer-date" label={t('lnd.inventory.answerDialog.date.label')} error={error('answeredOn')} hint={t('lnd.inventory.answerDialog.date.help')}>
        <input id="answer-date" type="date" min={record.surveyedOn} max={today} value={form.answeredOn} onChange={(event) => setForm({ ...form, answeredOn: event.target.value })} />
      </Field>
      <Field id="answer-note" label={t('lnd.inventory.answerDialog.note.label')} error={error('note')} hint={t('lnd.inventory.answerDialog.note.help')}>
        <input id="answer-note" autoComplete="off" value={form.note} onChange={(event) => setForm({ ...form, note: event.target.value })} />
      </Field>
    </DialogFrame>
  );
}
