import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../../i18n';
import { DialogFrame, Field } from '../components';
import type { HouseholdLine } from '../household/model';
import type { PlanLine } from '../plan/model';
import { useApprovePlan, useClosePosting, useHandleFeedback, usePostPlan, useRecordFeedback } from './hooks';
import { commandProblemMessage, feedbackChannelLabel, formProblemMessage } from './labels';
import {
  EMPTY_APPROVE_FORM,
  EMPTY_FEEDBACK_FORM,
  EMPTY_NOTE_FORM,
  EMPTY_POST_FORM,
  FEEDBACK_CHANNELS,
  approveBody,
  describeProblem,
  feedbackBody,
  postBody,
  validateApprove,
  validateFeedback,
  validateNote,
  validatePost,
} from './model';
import type { ApproveForm, FeedbackForm, FeedbackLine, NoteForm, PostForm } from './model';

/** The posting of a draft plan: the day it starts and the place it is posted at. The days it lasts are those of the rule in force that day, said after. */
export function PostDialog({ plan, today, onClose }: { plan: PlanLine; today: string; onClose(): void }) {
  const { t } = useTranslation();
  const post = usePostPlan();
  const [form, setForm] = useState<PostForm>({ ...EMPTY_POST_FORM, postingStartedOn: today });
  const [submitted, setSubmitted] = useState(false);
  const problems = validatePost(form, today);
  const error = (field: keyof PostForm): string | undefined => {
    const problem = problems[field];
    return submitted && problem !== undefined ? formProblemMessage(t, problem) : undefined;
  };
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (post.isPending || Object.keys(problems).length > 0) return;
    post.mutate({ id: plan.id, version: plan.version, body: postBody(form) }, { onSuccess: onClose });
  };
  return (
    <DialogFrame
      title={t('lnd.posting.postDialog.title.text', { code: plan.planCode, revision: plan.revision })}
      onClose={onClose}
      refusal={post.isError ? commandProblemMessage(t, describeProblem(post.error)) : undefined}
      pending={post.isPending}
      onSubmit={submit}
    >
      <Field id="posting-started-on" label={t('lnd.posting.postDialog.start.label')} error={error('postingStartedOn')} hint={t('lnd.posting.postDialog.start.help')}>
        <input id="posting-started-on" type="date" value={form.postingStartedOn} max={today} onChange={(event) => setForm({ ...form, postingStartedOn: event.target.value })} />
      </Field>
      <Field id="posting-place" label={t('lnd.posting.postDialog.place.label')} error={error('postingPlaceText')}>
        <input id="posting-place" value={form.postingPlaceText} onChange={(event) => setForm({ ...form, postingPlaceText: event.target.value })} />
      </Field>
    </DialogFrame>
  );
}

/** One opinion recorded while the plan is posted: from a household on the list or from somebody else, the way it reached the officer, and what it says. */
export function FeedbackDialog({ plan, households, onClose }: { plan: PlanLine; households: readonly HouseholdLine[]; onClose(): void }) {
  const { t } = useTranslation();
  const record = useRecordFeedback();
  const [form, setForm] = useState<FeedbackForm>(EMPTY_FEEDBACK_FORM);
  const [submitted, setSubmitted] = useState(false);
  const problems = validateFeedback(form);
  const error = (field: keyof FeedbackForm): string | undefined => {
    const problem = problems[field];
    return submitted && problem !== undefined ? formProblemMessage(t, problem) : undefined;
  };
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (record.isPending || Object.keys(problems).length > 0) return;
    record.mutate({ id: plan.id, body: feedbackBody(form) }, { onSuccess: onClose });
  };
  return (
    <DialogFrame
      title={t('lnd.posting.feedbackDialog.title.text', { code: plan.planCode, revision: plan.revision })}
      onClose={onClose}
      refusal={record.isError ? commandProblemMessage(t, describeProblem(record.error)) : undefined}
      pending={record.isPending}
      onSubmit={submit}
    >
      <Field id="feedback-household" label={t('lnd.posting.feedbackDialog.household.label')} error={undefined} hint={t('lnd.posting.feedbackDialog.household.help')}>
        <select id="feedback-household" value={form.householdId} onChange={(event) => setForm({ ...form, householdId: event.target.value })}>
          <option value="">{t('lnd.posting.feedbackDialog.household.none')}</option>
          {households.map((household) => (
            <option key={household.id} value={household.id}>
              {household.householdCode}
            </option>
          ))}
        </select>
      </Field>
      <Field id="feedback-channel" label={t('lnd.posting.feedbackDialog.channel.label')} error={error('channel')}>
        <select id="feedback-channel" value={form.channel} onChange={(event) => setForm({ ...form, channel: event.target.value as FeedbackForm['channel'] })}>
          <option value="">{t('lnd.posting.feedbackDialog.channel.choose')}</option>
          {FEEDBACK_CHANNELS.map((channel) => (
            <option key={channel} value={channel}>
              {feedbackChannelLabel(t, channel)}
            </option>
          ))}
        </select>
      </Field>
      <Field id="feedback-summary" label={t('lnd.posting.feedbackDialog.summary.label')} error={error('summary')}>
        <textarea id="feedback-summary" rows={4} value={form.summary} onChange={(event) => setForm({ ...form, summary: event.target.value })} />
      </Field>
    </DialogFrame>
  );
}

/** The handling of one opinion: what was done about it, in words. A handled opinion is final. */
export function HandleDialog({ plan, feedback, onClose }: { plan: PlanLine; feedback: FeedbackLine; onClose(): void }) {
  const { t } = useTranslation();
  const handle = useHandleFeedback();
  const [form, setForm] = useState<NoteForm>(EMPTY_NOTE_FORM);
  const [submitted, setSubmitted] = useState(false);
  const problem = validateNote(form).note;
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (handle.isPending || problem !== undefined) return;
    handle.mutate({ id: plan.id, feedbackId: feedback.id, note: form.note }, { onSuccess: onClose });
  };
  return (
    <DialogFrame
      title={t('lnd.posting.handleDialog.title.text', { code: plan.planCode, revision: plan.revision })}
      onClose={onClose}
      refusal={handle.isError ? commandProblemMessage(t, describeProblem(handle.error)) : undefined}
      pending={handle.isPending}
      onSubmit={submit}
    >
      <p className="callout" data-testid="handled-opinion">
        {feedback.summary}
      </p>
      <Field id="handle-note" label={t('lnd.posting.handleDialog.note.label')} error={submitted && problem !== undefined ? formProblemMessage(t, problem) : undefined} hint={t('lnd.posting.handleDialog.note.help')}>
        <textarea id="handle-note" rows={4} value={form.note} onChange={(event) => setForm({ note: event.target.value })} />
      </Field>
    </DialogFrame>
  );
}

/** The closing of the posting, with the summary of the opinions. It is offered when the days are over; the server counts them again. */
export function CloseDialog({ plan, onClose }: { plan: PlanLine; onClose(): void }) {
  const { t } = useTranslation();
  const close = useClosePosting();
  const [form, setForm] = useState<NoteForm>(EMPTY_NOTE_FORM);
  const [submitted, setSubmitted] = useState(false);
  const problem = validateNote(form).note;
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (close.isPending || problem !== undefined) return;
    close.mutate({ id: plan.id, version: plan.version, summary: form.note }, { onSuccess: onClose });
  };
  return (
    <DialogFrame
      title={t('lnd.posting.closeDialog.title.text', { code: plan.planCode, revision: plan.revision })}
      onClose={onClose}
      refusal={close.isError ? commandProblemMessage(t, describeProblem(close.error)) : undefined}
      pending={close.isPending}
      onSubmit={submit}
    >
      <Field id="close-summary" label={t('lnd.posting.closeDialog.summary.label')} error={submitted && problem !== undefined ? formProblemMessage(t, problem) : undefined} hint={t('lnd.posting.closeDialog.summary.help')}>
        <textarea id="close-summary" rows={4} value={form.note} onChange={(event) => setForm({ note: event.target.value })} />
      </Field>
    </DialogFrame>
  );
}

/** The approval of a plan whose posting is closed: the day, and the decision document that approves it. Someone other than the drafter approves; the server judges that again. */
export function ApproveDialog({ plan, today, onClose }: { plan: PlanLine; today: string; onClose(): void }) {
  const { t } = useTranslation();
  const approve = useApprovePlan();
  const [form, setForm] = useState<ApproveForm>({ ...EMPTY_APPROVE_FORM, approvedOn: today });
  const [submitted, setSubmitted] = useState(false);
  const problems = validateApprove(form, plan, today);
  const error = (field: keyof ApproveForm): string | undefined => {
    const problem = problems[field];
    return submitted && problem !== undefined ? formProblemMessage(t, problem) : undefined;
  };
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (approve.isPending || Object.keys(problems).length > 0) return;
    approve.mutate({ id: plan.id, version: plan.version, body: approveBody(form) }, { onSuccess: onClose });
  };
  return (
    <DialogFrame
      title={t('lnd.posting.approveDialog.title.text', { code: plan.planCode, revision: plan.revision })}
      onClose={onClose}
      refusal={approve.isError ? commandProblemMessage(t, describeProblem(approve.error)) : undefined}
      pending={approve.isPending}
      onSubmit={submit}
    >
      <Field id="approve-on" label={t('lnd.posting.approveDialog.date.label')} error={error('approvedOn')} hint={t('lnd.posting.approveDialog.date.help')}>
        <input id="approve-on" type="date" value={form.approvedOn} max={today} onChange={(event) => setForm({ ...form, approvedOn: event.target.value })} />
      </Field>
      <Field id="approve-document" label={t('lnd.posting.approveDialog.document.label')} error={error('decisionDocumentVersionId')} hint={t('lnd.posting.approveDialog.document.help')}>
        <input id="approve-document" value={form.decisionDocumentVersionId} onChange={(event) => setForm({ ...form, decisionDocumentVersionId: event.target.value })} />
      </Field>
    </DialogFrame>
  );
}
