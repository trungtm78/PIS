import { useMemo, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { useTranslation } from '../../../i18n';
import { useBoqLines } from '../../ctr/boq-hooks';
import { Field } from '../../ctr/components';
import type { ContractLine } from '../../ctr/model';
import { useMembers } from '../../dgv/hooks';
import { wireControl } from '../../field-wiring';
import { CommandFrame } from '../CommandFrame';
import { useCancelInspection, useRecordInspectionResult, useRequestInspection, useScheduleInspection } from './hooks';
import { formProblemMessage, outcomeLabel, problemMessage, resultLabel, typeLabel } from './labels';
import { EMPTY_SCHEDULE, INSPECTION_TYPES, OUTCOMES, RESULTS, describeProblem, emptyRequest, emptyResult, hasProblems, requestBody, resultBody, scheduleBody, validateReason, validateRequest, validateResult, validateSchedule, vietnamToday } from './model';
import type { AnswerForm, InspectionLine, RequestForm, ResultForm, ScheduleForm } from './model';

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

/** The frame the four commands are asked in: the title, the refusal of the server in words, the fields and the two buttons. */
function Frame({ title, error, hasError, pending, submitLabel, onSubmit, onClose, children }: FrameProps) {
  const { t } = useTranslation();
  const words = { close: t('qms.inspection.dialog.close'), cancel: t('qms.inspection.dialog.cancel'), pending: t('qms.inspection.dialog.pending') };
  return (
    <CommandFrame title={title} refusal={hasError ? problemMessage(t, describeProblem(error)) : undefined} pending={pending} submitLabel={submitLabel} words={words} onSubmit={onSubmit} onClose={onClose}>
      {children}
    </CommandFrame>
  );
}

/**
 * Asking for an inspection of work under a contract that is being performed: the item of the BOQ it is about, the kind of inspection, the place, the day it is asked for and the
 * diary of the site it came from. The regime in force on that day gives the checklist and the roles that sign the minutes; the screen shows both once the inspection is asked for.
 */
export function RequestDialog({ contracts, initialContractId, onClose }: { contracts: readonly ContractLine[]; initialContractId: string; onClose(): void }) {
  const { t } = useTranslation();
  const today = vietnamToday();
  const request = useRequestInspection();
  const [form, setForm] = useState<RequestForm>(emptyRequest(today, contracts.some((contract) => contract.id === initialContractId) ? initialContractId : ''));
  const [submitted, setSubmitted] = useState(false);
  const lines = useBoqLines(form.contractId === '' ? null : form.contractId);
  // The items are those the BOQ prices; whoever may not read the BOQ asks without one.
  const items = useMemo(() => {
    const seen = new Map<string, string>();
    for (const line of lines.data ?? []) if (line.boqItemId !== null && !seen.has(line.boqItemId)) seen.set(line.boqItemId, `${line.businessKey} · ${line.description}`);
    return [...seen.entries()];
  }, [lines.data]);
  const problems = validateRequest(form);
  const shown = (field: keyof RequestForm): string | undefined => {
    const problem = problems[field];
    return submitted && problem !== undefined ? formProblemMessage(t, problem) : undefined;
  };
  const set = (patch: Partial<RequestForm>): void => setForm({ ...form, ...patch });
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (request.isPending || Object.keys(problems).length > 0) return;
    request.mutate(requestBody(form), { onSuccess: onClose });
  };
  return (
    <Frame title={t('qms.inspection.request.title')} error={request.error} hasError={request.isError} pending={request.isPending} submitLabel={t('qms.inspection.request.submit')} onSubmit={send} onClose={onClose}>
      <Field id="inspection-contract" label={t('qms.inspection.field.contract')} error={shown('contractId')}>
        <select id="inspection-contract" value={form.contractId} onChange={(event) => set({ contractId: event.target.value, boqItemId: '' })}>
          <option value="">{t('qms.inspection.field.contract.choose')}</option>
          {contracts.map((contract) => (
            <option key={contract.id} value={contract.id}>
              {contract.title === null ? contract.code : `${contract.code} · ${contract.title}`}
            </option>
          ))}
        </select>
      </Field>
      <Field id="inspection-item" label={t('qms.inspection.field.item')} error={undefined} hint={t('qms.inspection.field.item.hint')}>
        <select id="inspection-item" value={form.boqItemId} onChange={(event) => set({ boqItemId: event.target.value })}>
          <option value="">{t('qms.inspection.field.item.none')}</option>
          {items.map(([id, label]) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </select>
      </Field>
      <Field id="inspection-type" label={t('qms.inspection.field.type')} error={shown('inspectionType')}>
        <select id="inspection-type" value={form.inspectionType} onChange={(event) => set({ inspectionType: INSPECTION_TYPES.find((type) => type === event.target.value) ?? '' })}>
          <option value="">{t('qms.inspection.field.type.choose')}</option>
          {INSPECTION_TYPES.map((type) => (
            <option key={type} value={type}>
              {typeLabel(t, type)}
            </option>
          ))}
        </select>
      </Field>
      <Field id="inspection-title" label={t('qms.inspection.field.title')} error={shown('title')}>
        <input id="inspection-title" autoComplete="off" value={form.title} onChange={(event) => set({ title: event.target.value })} />
      </Field>
      <Field id="inspection-location" label={t('qms.inspection.field.location')} error={shown('locationText')}>
        <input id="inspection-location" autoComplete="off" value={form.locationText} onChange={(event) => set({ locationText: event.target.value })} />
      </Field>
      <Field id="inspection-day" label={t('qms.inspection.field.day')} error={shown('requestedFor')} hint={t('qms.inspection.field.day.hint')}>
        <input id="inspection-day" type="date" value={form.requestedFor} onChange={(event) => set({ requestedFor: event.target.value })} />
      </Field>
      <Field id="inspection-diary" label={t('qms.inspection.field.diary')} error={shown('siteDiaryId')} hint={t('qms.inspection.field.diary.hint')}>
        <input id="inspection-diary" autoComplete="off" value={form.siteDiaryId} onChange={(event) => set({ siteDiaryId: event.target.value })} />
      </Field>
    </Frame>
  );
}

/** Scheduling a requested inspection: when it takes place and the people who take part. */
export function ScheduleDialog({ line, onClose }: { line: InspectionLine; onClose(): void }) {
  const { t } = useTranslation();
  const schedule = useScheduleInspection();
  const members = useMembers(true);
  const [form, setForm] = useState<ScheduleForm>(EMPTY_SCHEDULE);
  const [submitted, setSubmitted] = useState(false);
  const problems = validateSchedule(form, new Date());
  const shown = (field: keyof ScheduleForm): string | undefined => {
    const problem = problems[field];
    return submitted && problem !== undefined ? formProblemMessage(t, problem) : undefined;
  };
  const toggle = (id: string): void => setForm({ ...form, participantIds: form.participantIds.includes(id) ? form.participantIds.filter((member) => member !== id) : [...form.participantIds, id] });
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (schedule.isPending || Object.keys(problems).length > 0) return;
    schedule.mutate({ id: line.id, version: line.version, body: scheduleBody(form) }, { onSuccess: onClose });
  };
  return (
    <Frame title={t('qms.inspection.schedule.title', { no: line.inspectionNo })} error={schedule.error} hasError={schedule.isError} pending={schedule.isPending} submitLabel={t('qms.inspection.schedule.submit')} onSubmit={send} onClose={onClose}>
      <Field id="inspection-at" label={t('qms.inspection.field.at')} error={shown('scheduledAt')} hint={t('qms.inspection.field.at.hint')}>
        <input id="inspection-at" type="datetime-local" value={form.scheduledAt} onChange={(event) => setForm({ ...form, scheduledAt: event.target.value })} />
      </Field>
      <fieldset className="field" data-field="inspection-participants">
        <legend>{t('qms.inspection.field.participants')}</legend>
        {members.isError ? (
          <p className="callout warning" role="status" data-testid="members-failed">
            {t('qms.inspection.field.participants.failed')}
          </p>
        ) : (
          (members.data ?? []).map((member) => (
            <label key={member.id} className="checkbox">
              <input type="checkbox" data-member={member.id} checked={form.participantIds.includes(member.id)} onChange={() => toggle(member.id)} /> {member.name}
            </label>
          ))
        )}
        {shown('participantIds') === undefined ? null : (
          <small role="alert" className="field-error">
            {shown('participantIds')}
          </small>
        )}
      </fieldset>
    </Frame>
  );
}

/**
 * The result of a scheduled inspection, against the checklist the regime in force on the day of the request gave it: every item answered, the result the answers allow (a PASS has no
 * failed item; a FAIL or a CONDITIONAL has at least one, and a CONDITIONAL says its condition in the note of each failed item) and a note.
 */
export function ResultDialog({ line, onClose }: { line: InspectionLine; onClose(): void }) {
  const { t } = useTranslation();
  const record = useRecordInspectionResult();
  const [form, setForm] = useState<ResultForm>(emptyResult(line.checklist));
  const [submitted, setSubmitted] = useState(false);
  const problems = validateResult(form, line.checklist);
  const answer = (code: string): AnswerForm => form.answers[code] ?? { outcome: '', note: '' };
  const setAnswer = (code: string, patch: Partial<AnswerForm>): void => setForm({ ...form, answers: { ...form.answers, [code]: { ...answer(code), ...patch } } });
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (record.isPending || hasProblems(problems)) return;
    record.mutate({ id: line.id, version: line.version, body: resultBody(form, line.checklist) }, { onSuccess: onClose });
  };
  const resultError = submitted && problems.result !== undefined ? formProblemMessage(t, problems.result) : undefined;
  const noteError = submitted && problems.resultNote !== undefined ? formProblemMessage(t, problems.resultNote) : undefined;
  return (
    <Frame title={t('qms.inspection.record.title', { no: line.inspectionNo })} error={record.error} hasError={record.isError} pending={record.isPending} submitLabel={t('qms.inspection.record.submit')} onSubmit={send} onClose={onClose}>
      <fieldset className="field" data-field="inspection-checklist">
        <legend>{t('qms.inspection.field.checklist')}</legend>
        {line.checklist.map((item, index) => {
          const problem = submitted ? problems.answers[item.code] : undefined;
          const selectId = `inspection-answer-${index}`;
          const noteId = `inspection-answer-note-${index}`;
          return (
            <div key={item.code} className="qms-checklist-row" data-item={item.code}>
              <label htmlFor={selectId}>{item.label}</label>
              {wireControl(
                <select id={selectId} value={answer(item.code).outcome} onChange={(event) => setAnswer(item.code, { outcome: OUTCOMES.find((outcome) => outcome === event.target.value) ?? '' })}>
                  <option value="">{t('qms.inspection.field.outcome.choose')}</option>
                  {OUTCOMES.map((outcome) => (
                    <option key={outcome} value={outcome}>
                      {outcomeLabel(t, outcome)}
                    </option>
                  ))}
                </select>,
                selectId,
                { hint: false, error: problem === 'unanswered' },
              )}
              <input id={noteId} aria-label={t('qms.inspection.field.itemNote', { item: item.label })} autoComplete="off" value={answer(item.code).note} onChange={(event) => setAnswer(item.code, { note: event.target.value })} />
              {problem === undefined ? null : (
                <small role="alert" className="field-error">
                  {formProblemMessage(t, problem)}
                </small>
              )}
            </div>
          );
        })}
      </fieldset>
      <Field id="inspection-result" label={t('qms.inspection.field.result')} error={resultError}>
        <select id="inspection-result" value={form.result} onChange={(event) => setForm({ ...form, result: RESULTS.find((result) => result === event.target.value) ?? '' })}>
          <option value="">{t('qms.inspection.field.result.choose')}</option>
          {RESULTS.map((result) => (
            <option key={result} value={result}>
              {resultLabel(t, result)}
            </option>
          ))}
        </select>
      </Field>
      {submitted && problems.whole !== undefined ? (
        <p className="callout warning" role="alert" data-testid="contradiction">
          {formProblemMessage(t, problems.whole)}
        </p>
      ) : null}
      <Field id="inspection-result-note" label={t('qms.inspection.field.resultNote')} error={noteError}>
        <textarea id="inspection-result-note" rows={3} value={form.resultNote} onChange={(event) => setForm({ ...form, resultNote: event.target.value })} />
      </Field>
    </Frame>
  );
}

/** Cancelling an inspection that has not been recorded: a reason, kept with it. */
export function CancelDialog({ line, onClose }: { line: InspectionLine; onClose(): void }) {
  const { t } = useTranslation();
  const cancel = useCancelInspection();
  const [reason, setReason] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const problem = validateReason(reason);
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (cancel.isPending || problem !== undefined) return;
    cancel.mutate({ id: line.id, version: line.version, body: { reason: reason.trim() } }, { onSuccess: onClose });
  };
  return (
    <Frame title={t('qms.inspection.cancel.title', { no: line.inspectionNo })} error={cancel.error} hasError={cancel.isError} pending={cancel.isPending} submitLabel={t('qms.inspection.cancel.submit')} onSubmit={send} onClose={onClose}>
      <Field id="inspection-cancel-reason" label={t('qms.inspection.field.cancelReason')} error={submitted && problem !== undefined ? formProblemMessage(t, problem) : undefined} hint={t('qms.inspection.field.cancelReason.hint')}>
        <textarea id="inspection-cancel-reason" rows={3} value={reason} onChange={(event) => setReason(event.target.value)} />
      </Field>
    </Frame>
  );
}
