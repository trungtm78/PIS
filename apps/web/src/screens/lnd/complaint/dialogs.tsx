import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../../i18n';
import { DialogFrame, Field } from '../components';
import type { HouseholdLine } from '../household/model';
import type { PlanLine } from '../plan/model';
import { useFileComplaint, useResolveComplaint } from './hooks';
import { commandProblemMessage, complaintChannelLabel, complaintStatusLabel, complaintSubjectLabel, formProblemMessage } from './labels';
import { COMPLAINT_CHANNELS, COMPLAINT_OUTCOMES, COMPLAINT_SUBJECTS, EMPTY_FILE_FORM, EMPTY_RESOLVE_FORM, describeProblem, fileBody, resolveBody, validateFile, validateResolve } from './model';
import type { ComplaintLine, FileForm, ResolveForm } from './model';

/** The filing of a complaint of a household of the project: how it came, what it is about, what it says and the day it was filed; the unit that answers is the unit of the household. */
export function FileDialog({ projectId, households, plans, today, onClose }: { projectId: string; households: readonly HouseholdLine[]; plans: readonly PlanLine[]; today: string; onClose(): void }) {
  const { t } = useTranslation();
  const file = useFileComplaint();
  const [form, setForm] = useState<FileForm>({ ...EMPTY_FILE_FORM, filedOn: today });
  const [submitted, setSubmitted] = useState(false);
  const problems = validateFile(form, today);
  const error = (field: keyof FileForm): string | undefined => {
    const problem = problems[field];
    return submitted && problem !== undefined ? formProblemMessage(t, problem) : undefined;
  };
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (file.isPending || Object.keys(problems).length > 0) return;
    // The household is one of the options of the select, which are these households.
    const household = households.find((candidate) => candidate.id === form.householdId) as HouseholdLine;
    file.mutate(fileBody(projectId, household.ownerUnitId, form), { onSuccess: onClose });
  };
  return (
    <DialogFrame
      title={t('lnd.complaints.fileDialog.title.text')}
      onClose={onClose}
      refusal={file.isError ? commandProblemMessage(t, describeProblem(file.error)) : undefined}
      pending={file.isPending}
      onSubmit={submit}
    >
      <Field id="complaint-household" label={t('lnd.complaints.fileDialog.household.label')} error={error('householdId')}>
        <select id="complaint-household" value={form.householdId} onChange={(event) => setForm({ ...form, householdId: event.target.value })}>
          <option value="">{t('lnd.complaints.fileDialog.household.choose')}</option>
          {households.map((household) => (
            <option key={household.id} value={household.id}>
              {household.householdCode}
            </option>
          ))}
        </select>
      </Field>
      <Field id="complaint-plan" label={t('lnd.complaints.fileDialog.plan.label')} error={undefined} hint={t('lnd.complaints.fileDialog.plan.help')}>
        <select id="complaint-plan" value={form.planId} onChange={(event) => setForm({ ...form, planId: event.target.value })}>
          <option value="">{t('lnd.complaints.fileDialog.plan.none')}</option>
          {plans.map((plan) => (
            <option key={plan.id} value={plan.id}>
              {`${plan.planCode} · ${plan.revision}`}
            </option>
          ))}
        </select>
      </Field>
      <Field id="complaint-channel" label={t('lnd.complaints.fileDialog.channel.label')} error={error('channel')}>
        <select id="complaint-channel" value={form.channel} onChange={(event) => setForm({ ...form, channel: event.target.value as FileForm['channel'] })}>
          <option value="">{t('lnd.complaints.fileDialog.channel.choose')}</option>
          {COMPLAINT_CHANNELS.map((channel) => (
            <option key={channel} value={channel}>
              {complaintChannelLabel(t, channel)}
            </option>
          ))}
        </select>
      </Field>
      <Field id="complaint-subject" label={t('lnd.complaints.fileDialog.subject.label')} error={error('subject')}>
        <select id="complaint-subject" value={form.subject} onChange={(event) => setForm({ ...form, subject: event.target.value as FileForm['subject'] })}>
          <option value="">{t('lnd.complaints.fileDialog.subject.choose')}</option>
          {COMPLAINT_SUBJECTS.map((subject) => (
            <option key={subject} value={subject}>
              {complaintSubjectLabel(t, subject)}
            </option>
          ))}
        </select>
      </Field>
      <Field id="complaint-filed-on" label={t('lnd.complaints.fileDialog.date.label')} error={error('filedOn')} hint={t('lnd.complaints.fileDialog.date.help')}>
        <input id="complaint-filed-on" type="date" value={form.filedOn} max={today} onChange={(event) => setForm({ ...form, filedOn: event.target.value })} />
      </Field>
      <Field id="complaint-description" label={t('lnd.complaints.fileDialog.description.label')} error={error('description')} hint={t('lnd.complaints.fileDialog.description.help')}>
        <textarea id="complaint-description" rows={4} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} />
      </Field>
    </DialogFrame>
  );
}

/**
 * The answer to a complaint: accepted or rejected with the reply document, or escalated to a higher level with a note. The document is asked for when the answer is an acceptance or a rejection; the days it was
 * answered in are counted by the server, and the issue of ISS is closed by ISS.
 */
export function ResolveDialog({ complaint, today, onClose }: { complaint: ComplaintLine; today: string; onClose(): void }) {
  const { t } = useTranslation();
  const resolve = useResolveComplaint();
  const [form, setForm] = useState<ResolveForm>({ ...EMPTY_RESOLVE_FORM, resolvedOn: today });
  const [submitted, setSubmitted] = useState(false);
  const problems = validateResolve(form, complaint, today);
  const error = (field: keyof ResolveForm): string | undefined => {
    const problem = problems[field];
    return submitted && problem !== undefined ? formProblemMessage(t, problem) : undefined;
  };
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (resolve.isPending || Object.keys(problems).length > 0) return;
    resolve.mutate({ id: complaint.id, version: complaint.version, body: resolveBody(form) }, { onSuccess: onClose });
  };
  return (
    <DialogFrame
      title={t('lnd.complaints.resolveDialog.title.text', { number: complaint.complaintNo })}
      onClose={onClose}
      refusal={resolve.isError ? commandProblemMessage(t, describeProblem(resolve.error)) : undefined}
      pending={resolve.isPending}
      onSubmit={submit}
    >
      <Field id="resolve-outcome" label={t('lnd.complaints.resolveDialog.outcome.label')} error={error('outcome')}>
        <select id="resolve-outcome" value={form.outcome} onChange={(event) => setForm({ ...form, outcome: event.target.value as ResolveForm['outcome'] })}>
          <option value="">{t('lnd.complaints.resolveDialog.outcome.choose')}</option>
          {COMPLAINT_OUTCOMES.filter((outcome) => !(complaint.status === 'ESCALATED' && outcome === 'ESCALATED')).map((outcome) => (
            <option key={outcome} value={outcome}>
              {complaintStatusLabel(t, outcome)}
            </option>
          ))}
        </select>
      </Field>
      <Field id="resolve-date" label={t('lnd.complaints.resolveDialog.date.label')} error={error('resolvedOn')} hint={t('lnd.complaints.resolveDialog.date.help', { date: complaint.filedOn })}>
        <input id="resolve-date" type="date" value={form.resolvedOn} max={today} onChange={(event) => setForm({ ...form, resolvedOn: event.target.value })} />
      </Field>
      <Field id="resolve-document" label={t('lnd.complaints.resolveDialog.document.label')} error={error('resolutionDocumentVersionId')} hint={t('lnd.complaints.resolveDialog.document.help')}>
        <input id="resolve-document" value={form.resolutionDocumentVersionId} onChange={(event) => setForm({ ...form, resolutionDocumentVersionId: event.target.value })} />
      </Field>
      <Field id="resolve-note" label={t('lnd.complaints.resolveDialog.note.label')} error={error('note')}>
        <textarea id="resolve-note" rows={4} value={form.note} onChange={(event) => setForm({ ...form, note: event.target.value })} />
      </Field>
    </DialogFrame>
  );
}
