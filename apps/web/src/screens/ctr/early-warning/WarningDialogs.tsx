import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from '../../../i18n';
import { dayText, describeProblem, formProblemText, todayInVietnam } from '../claims/common';
import type { Problem } from '../claims/common';
import { Field } from '../claims/components';
import { useReloadRegisters } from '../claims/hooks';
import { RegisterDialog } from '../claims/RegisterDialog';
import { useAddAction, useAssessWarning, useCloseWarning, useCompleteAction, useIssueRegister, useMemberOptions, useOpenWarnings, useRaiseWarning, useRecordMeeting } from './hooks';
import { categoryLabel, closeHint, closeLabel, intoLabel, likelihoodLabel, partyLabel, reviewLabel } from './labels';
import {
  CATEGORIES,
  CLOSE_OUTCOMES,
  LIKELIHOODS,
  MIN_REASON,
  MIN_TEXT,
  PARTIES,
  REVIEW_OUTCOMES,
  actionBody,
  assessBody,
  assessFormOf,
  closeBody,
  emptyAction,
  emptyClose,
  emptyMeeting,
  emptyRaise,
  issueBody,
  meetingBody,
  meetingsAwaitingIssue,
  raiseBody,
  validateAction,
  validateAssess,
  validateClose,
  validateIssue,
  validateMeeting,
  validateRaise,
} from './model';
import type { ActionForm, AssessForm, CloseForm, FormErrors, IssueForm, MeetingForm, RaiseForm, Register, Warning, WarningAction } from './model';

export type WarningDialog =
  | { kind: 'raise'; contract: { id: string; code: string } }
  | { kind: 'assess'; warning: Warning }
  | { kind: 'action'; warning: Warning }
  | { kind: 'complete'; warning: Warning; action: WarningAction; outcome: 'DONE' | 'CANCELLED' }
  | { kind: 'close'; warning: Warning }
  | { kind: 'meeting'; register: Register }
  | { kind: 'issue'; register: Register };

export interface WarningDialogsProps {
  dialog: WarningDialog;
  onClose: () => void;
  /** Called after a command succeeded, with the sentence of the receipt. */
  onDone: (receipt: string) => void;
}

export function WarningDialogs({ dialog, onClose, onDone }: WarningDialogsProps) {
  switch (dialog.kind) {
    case 'raise':
      return <RaiseDialog contract={dialog.contract} onClose={onClose} onDone={onDone} />;
    case 'assess':
      return <AssessDialog warning={dialog.warning} onClose={onClose} onDone={onDone} />;
    case 'action':
      return <ActionDialog warning={dialog.warning} onClose={onClose} onDone={onDone} />;
    case 'complete':
      return <CompleteDialog key={`${dialog.action.id}:${dialog.outcome}`} warning={dialog.warning} action={dialog.action} outcome={dialog.outcome} onClose={onClose} onDone={onDone} />;
    case 'close':
      return <CloseDialog warning={dialog.warning} onClose={onClose} onDone={onDone} />;
    case 'meeting':
      return <MeetingDialog register={dialog.register} onClose={onClose} onDone={onDone} />;
    case 'issue':
      return <IssueDialog register={dialog.register} onClose={onClose} onDone={onDone} />;
  }
}

function useSender() {
  const [problem, setProblem] = useState<Problem | undefined>(undefined);
  const sending = useRef(false);
  const reload = useReloadRegisters();
  return {
    problem,
    reload: () => void reload(),
    run: (start: (handlers: { onSuccess: () => void; onError: (error: unknown) => void }) => void, done: () => void): void => {
      if (sending.current) return;
      sending.current = true;
      setProblem(undefined);
      start({
        onSuccess: () => {
          sending.current = false;
          done();
        },
        onError: (error) => {
          sending.current = false;
          setProblem(describeProblem(error));
        },
      });
    },
  };
}

function useErrors<F>(): [FormErrors<F>, (errors: FormErrors<F>) => void, (field: keyof F) => string | undefined] {
  const { t } = useTranslation();
  const [errors, setErrors] = useState<FormErrors<F>>({});
  return [
    errors,
    setErrors,
    (field) => {
      const found = errors[field];
      return found === undefined ? undefined : formProblemText(t, found);
    },
  ];
}

function MemberSelect({ id, label, value, error, onChange }: { id: string; label: string; value: string; error: string | undefined; onChange: (value: string) => void }): ReactNode {
  const { t } = useTranslation();
  const members = useMemberOptions();
  return (
    <Field id={id} label={label} error={error}>
      <select id={id} value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">{t('ctrWarn.dialog.pick.option')}</option>
        {(members.data ?? []).map((member) => (
          <option key={member.id} value={member.id}>
            {member.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

const warningContext = (t: ReturnType<typeof useTranslation>['t'], warning: Warning): Array<{ label: string; value: string }> => [
  { label: t('ctrWarn.dialog.warning.label'), value: `${warning.code} · ${warning.title}` },
  { label: t('ctrWarn.dialog.contract.label'), value: warning.contract.code },
];

function RaiseDialog({ contract, onClose, onDone }: { contract: { id: string; code: string }; onClose: () => void; onDone: (receipt: string) => void }) {
  const { t } = useTranslation();
  const today = todayInVietnam();
  const raise = useRaiseWarning();
  const sender = useSender();
  const [form, setForm] = useState<RaiseForm>(emptyRaise(today));
  const [, setErrors, message] = useErrors<RaiseForm>();
  const set = (patch: Partial<RaiseForm>): void => setForm((current) => ({ ...current, ...patch }));
  const submit = (): void => {
    const found = validateRaise(form, today);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    sender.run(
      (handlers) => raise.mutate({ contractId: contract.id, body: raiseBody(form) }, handlers),
      () => onDone(t('ctrWarn.success.raised.text', { title: form.title.trim() })),
    );
  };
  return (
    <RegisterDialog
      title={t('ctrWarn.raiseDialog.title')}
      context={[{ label: t('ctrWarn.dialog.contract.label'), value: contract.code }]}
      confirmLabel={t('ctrWarn.raiseDialog.confirm.action')}
      pending={raise.isPending}
      problem={sender.problem}
      onSubmit={submit}
      onCancel={onClose}
      onReload={sender.reload}
    >
      <p className="sub">{t('ctrWarn.raiseDialog.effect.text')}</p>
      <Field id="warn-title" label={t('ctrWarn.raiseDialog.warnTitle.label')} error={message('title')}>
        <input id="warn-title" type="text" value={form.title} onChange={(event) => set({ title: event.target.value })} />
      </Field>
      <Field id="warn-description" label={t('ctrWarn.raiseDialog.description.label')} error={message('description')}>
        <textarea id="warn-description" rows={3} value={form.description} onChange={(event) => set({ description: event.target.value })} />
      </Field>
      <Field id="warn-category" label={t('ctrWarn.raiseDialog.category.label')} error={message('category')}>
        <select id="warn-category" value={form.category} onChange={(event) => set({ category: event.target.value })}>
          {CATEGORIES.map((category) => (
            <option key={category} value={category}>
              {categoryLabel(t, category)}
            </option>
          ))}
        </select>
      </Field>
      <Field id="warn-party" label={t('ctrWarn.raiseDialog.party.label')} hint={t('ctrWarn.raiseDialog.party.hint')} error={message('party')}>
        <select id="warn-party" value={form.party} onChange={(event) => set({ party: event.target.value })}>
          {PARTIES.map((party) => (
            <option key={party} value={party}>
              {partyLabel(t, party)}
            </option>
          ))}
        </select>
      </Field>
      <Field id="warn-day" label={t('ctrWarn.raiseDialog.raisedOn.label')} error={message('raisedOn')}>
        <input id="warn-day" type="date" value={form.raisedOn} max={today} onChange={(event) => set({ raisedOn: event.target.value })} />
      </Field>
    </RegisterDialog>
  );
}

function AssessDialog({ warning, onClose, onDone }: { warning: Warning; onClose: () => void; onDone: (receipt: string) => void }) {
  const { t } = useTranslation();
  const assess = useAssessWarning();
  const sender = useSender();
  const [form, setForm] = useState<AssessForm>(assessFormOf(warning));
  const [, setErrors, message] = useErrors<AssessForm>();
  const set = (patch: Partial<AssessForm>): void => setForm((current) => ({ ...current, ...patch }));
  const submit = (): void => {
    const found = validateAssess(form);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    sender.run(
      (handlers) => assess.mutate({ id: warning.id, version: warning.version, body: assessBody(form) }, handlers),
      () => onDone(t('ctrWarn.success.assessed.text', { code: warning.code })),
    );
  };
  return (
    <RegisterDialog
      title={t('ctrWarn.assessDialog.title')}
      context={warningContext(t, warning)}
      confirmLabel={t('ctrWarn.assessDialog.confirm.action')}
      pending={assess.isPending}
      problem={sender.problem}
      onSubmit={submit}
      onCancel={onClose}
      onReload={sender.reload}
    >
      <p className="sub">{t('ctrWarn.assessDialog.effect.text')}</p>
      <MemberSelect id="assess-owner" label={t('ctrWarn.assessDialog.owner.label')} value={form.ownerId} error={message('ownerId')} onChange={(ownerId) => set({ ownerId })} />
      <Field id="assess-likelihood" label={t('ctrWarn.assessDialog.likelihood.label')} error={message('likelihood')}>
        <select id="assess-likelihood" value={form.likelihood} onChange={(event) => set({ likelihood: event.target.value })}>
          <option value="">{t('ctrWarn.dialog.pick.option')}</option>
          {LIKELIHOODS.map((likelihood) => (
            <option key={likelihood} value={likelihood}>
              {likelihoodLabel(t, likelihood)}
            </option>
          ))}
        </select>
      </Field>
      <Field id="assess-days" label={t('ctrWarn.assessDialog.timeDays.label')} error={message('timeDays')}>
        <input id="assess-days" type="text" inputMode="numeric" value={form.timeDays} onChange={(event) => set({ timeDays: event.target.value })} />
      </Field>
      <Field id="assess-cost" label={t('ctrWarn.assessDialog.costVnd.label')} error={message('costVnd')}>
        <input id="assess-cost" type="text" inputMode="numeric" value={form.costVnd} onChange={(event) => set({ costVnd: event.target.value })} />
      </Field>
      <label className="ctrreg-check">
        <input type="checkbox" checked={form.noImpact} onChange={(event) => set({ noImpact: event.target.checked })} />
        <span>{t('ctrWarn.assessDialog.noImpact.label')}</span>
      </label>
      {message('noImpact') !== undefined && (
        <small role="alert" className="field-error">
          {message('noImpact')}
        </small>
      )}
    </RegisterDialog>
  );
}

function ActionDialog({ warning, onClose, onDone }: { warning: Warning; onClose: () => void; onDone: (receipt: string) => void }) {
  const { t } = useTranslation();
  const today = todayInVietnam();
  const add = useAddAction();
  const sender = useSender();
  const [form, setForm] = useState<ActionForm>(emptyAction(today));
  const [, setErrors, message] = useErrors<ActionForm>();
  const set = (patch: Partial<ActionForm>): void => setForm((current) => ({ ...current, ...patch }));
  const submit = (): void => {
    const found = validateAction(form, today);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    sender.run(
      (handlers) => add.mutate({ id: warning.id, body: actionBody(form) }, handlers),
      () => onDone(t('ctrWarn.success.actionAdded.text', { code: warning.code })),
    );
  };
  return (
    <RegisterDialog
      title={t('ctrWarn.actionDialog.title')}
      context={warningContext(t, warning)}
      confirmLabel={t('ctrWarn.actionDialog.confirm.action')}
      pending={add.isPending}
      problem={sender.problem}
      onSubmit={submit}
      onCancel={onClose}
      onReload={sender.reload}
    >
      <p className="sub">{t('ctrWarn.actionDialog.effect.text')}</p>
      <Field id="action-description" label={t('ctrWarn.actionDialog.description.label')} error={message('description')}>
        <textarea id="action-description" rows={3} value={form.description} onChange={(event) => set({ description: event.target.value })} />
      </Field>
      <MemberSelect id="action-owner" label={t('ctrWarn.actionDialog.owner.label')} value={form.ownerId} error={message('ownerId')} onChange={(ownerId) => set({ ownerId })} />
      <Field id="action-due" label={t('ctrWarn.actionDialog.dueOn.label')} error={message('dueOn')}>
        <input id="action-due" type="date" value={form.dueOn} min={today} onChange={(event) => set({ dueOn: event.target.value })} />
      </Field>
    </RegisterDialog>
  );
}

function CompleteDialog({ warning, action, outcome, onClose, onDone }: { warning: Warning; action: WarningAction; outcome: 'DONE' | 'CANCELLED'; onClose: () => void; onDone: (receipt: string) => void }) {
  const { t } = useTranslation();
  const complete = useCompleteAction();
  const sender = useSender();
  const submit = (note: string): void =>
    sender.run(
      (handlers) => complete.mutate({ id: action.id, version: action.version, body: { outcome, note: note.trim() } }, handlers),
      () => onDone(t('ctrWarn.success.actionEnded.text', { code: warning.code })),
    );
  return (
    <RegisterDialog
      title={outcome === 'DONE' ? t('ctrWarn.completeDialog.done.title') : t('ctrWarn.completeDialog.cancel.title')}
      context={[...warningContext(t, warning), { label: t('ctrWarn.dialog.action.label'), value: action.description }]}
      confirmLabel={outcome === 'DONE' ? t('ctrWarn.completeDialog.done.action') : t('ctrWarn.completeDialog.cancel.action')}
      note={{ label: t('ctrWarn.completeDialog.note.label'), minLength: MIN_TEXT }}
      pending={complete.isPending}
      problem={sender.problem}
      onSubmit={submit}
      onCancel={onClose}
      onReload={sender.reload}
    />
  );
}

function CloseDialog({ warning, onClose, onDone }: { warning: Warning; onClose: () => void; onDone: (receipt: string) => void }) {
  const { t } = useTranslation();
  const close = useCloseWarning();
  const sender = useSender();
  const [form, setForm] = useState<CloseForm>(emptyClose());
  const [, setErrors, message] = useErrors<CloseForm>();
  const [reasonError, setReasonError] = useState<string | undefined>(undefined);
  const openActions = warning.actions.filter((action) => action.status === 'OPEN').length;
  const set = (patch: Partial<CloseForm>): void => setForm((current) => ({ ...current, ...patch }));
  const submit = (reason: string): void => {
    const checked = validateClose(form, reason, openActions);
    setErrors(checked.errors);
    setReasonError(checked.reason === undefined ? undefined : formProblemText(t, checked.reason));
    if (Object.keys(checked.errors).length > 0 || checked.reason !== undefined) return;
    sender.run(
      (handlers) => close.mutate({ id: warning.id, version: warning.version, body: closeBody(form, reason) }, handlers),
      () => onDone(t('ctrWarn.success.closed.text', { code: warning.code })),
    );
  };
  return (
    <RegisterDialog
      title={t('ctrWarn.closeDialog.title')}
      context={warningContext(t, warning)}
      confirmLabel={t('ctrWarn.closeDialog.confirm.action')}
      note={{ label: t('ctrWarn.closeDialog.reason.label'), hint: t('ctrWarn.closeDialog.reason.hint'), minLength: MIN_REASON }}
      pending={close.isPending}
      problem={sender.problem}
      onSubmit={submit}
      onCancel={onClose}
      onReload={sender.reload}
    >
      <Field id="close-outcome" label={t('ctrWarn.closeDialog.outcome.label')} hint={closeHint(t, form.outcome)} error={message('outcome')}>
        <select id="close-outcome" value={form.outcome} onChange={(event) => set({ outcome: event.target.value })}>
          {CLOSE_OUTCOMES.map((outcome) => (
            <option key={outcome} value={outcome}>
              {closeLabel(t, outcome)}
            </option>
          ))}
        </select>
      </Field>
      {form.outcome === 'RESOLVED' && openActions > 0 && (
        <p className="ctrreg-notice" role="status" data-testid="actions-open-note">
          {t('ctrWarn.closeDialog.actionsOpen.text', { count: openActions })}
        </p>
      )}
      {form.outcome === 'RESOLVED' && (
        <p className="sub" data-testid="four-eyes-note">
          {t('ctrWarn.closeDialog.fourEyes.text')}
        </p>
      )}
      {form.outcome === 'MATERIALISED' && (
        <>
          <Field id="close-into" label={t('ctrWarn.closeDialog.into.label')} error={message('into')}>
            <select id="close-into" value={form.into} onChange={(event) => set({ into: event.target.value })}>
              {(['CHANGE_REQUEST', 'CLAIM'] as const).map((into) => (
                <option key={into} value={into}>
                  {intoLabel(t, into)}
                </option>
              ))}
            </select>
          </Field>
          <Field id="close-id" label={t('ctrWarn.closeDialog.materialisedId.label')} hint={t('ctrWarn.closeDialog.materialisedId.hint')} error={message('materialisedId')}>
            <input id="close-id" type="text" value={form.materialisedId} onChange={(event) => set({ materialisedId: event.target.value })} />
          </Field>
        </>
      )}
      {reasonError !== undefined && (
        <small role="alert" className="field-error">
          {reasonError}
        </small>
      )}
    </RegisterDialog>
  );
}

function MeetingDialog({ register, onClose, onDone }: { register: Register; onClose: () => void; onDone: (receipt: string) => void }) {
  const { t } = useTranslation();
  const today = todayInVietnam();
  const open = useOpenWarnings(register.contract.id);
  const record = useRecordMeeting();
  const sender = useSender();
  const [form, setForm] = useState<MeetingForm>(emptyMeeting(today));
  const [, setErrors, message] = useErrors<MeetingForm>();
  const [missing, setMissing] = useState<string[]>([]);
  const lines = open.data ?? [];
  const lastMeetingOn = register.meetings[0]?.held_on ?? null;
  const submit = (): void => {
    if (open.data === undefined) return;
    const ids = lines.map((line) => line.id);
    const checked = validateMeeting(form, ids, today, lastMeetingOn, register.contract.effective_from);
    setErrors(checked.errors);
    setMissing(checked.missing);
    if (Object.keys(checked.errors).length > 0 || checked.missing.length > 0) return;
    sender.run(
      (handlers) => record.mutate({ contractId: register.contract.id, body: meetingBody(form, ids) }, handlers),
      () => onDone(t('ctrWarn.success.meeting.text', { contract: register.contract.code })),
    );
  };
  return (
    <RegisterDialog
      title={t('ctrWarn.meetingDialog.title')}
      context={[{ label: t('ctrWarn.dialog.contract.label'), value: register.contract.code }]}
      confirmLabel={t('ctrWarn.meetingDialog.confirm.action')}
      pending={record.isPending || open.isLoading}
      problem={sender.problem}
      onSubmit={submit}
      onCancel={onClose}
      onReload={sender.reload}
    >
      <p className="sub">{t('ctrWarn.meetingDialog.effect.text')}</p>
      <Field id="meeting-day" label={t('ctrWarn.meetingDialog.heldOn.label')} hint={lastMeetingOn === null ? undefined : t('ctrWarn.meetingDialog.heldOn.hint', { day: dayText(lastMeetingOn) })} error={message('heldOn')}>
        <input id="meeting-day" type="date" value={form.heldOn} max={today} onChange={(event) => setForm({ ...form, heldOn: event.target.value })} />
      </Field>
      <Field id="meeting-attendees" label={t('ctrWarn.meetingDialog.attendees.label')} error={message('attendees')}>
        <textarea id="meeting-attendees" rows={2} value={form.attendees} onChange={(event) => setForm({ ...form, attendees: event.target.value })} />
      </Field>
      <Field id="meeting-notes" label={t('ctrWarn.meetingDialog.notes.label')} error={undefined}>
        <textarea id="meeting-notes" rows={2} value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} />
      </Field>
      {open.isLoading && (
        <p role="status" aria-busy="true">
          {t('ctrWarn.meetingDialog.loading.text')}
        </p>
      )}
      {open.isError && (
        <p role="alert" data-testid="open-error">
          {t('ctrWarn.meetingDialog.error.text')}
        </p>
      )}
      {open.data !== undefined && lines.length === 0 && <p className="sub">{t('ctrWarn.meetingDialog.none.text')}</p>}
      {lines.length > 0 && (
        <fieldset className="ctrreg-reviews" data-testid="reviews">
          <legend>{t('ctrWarn.meetingDialog.reviews.legend')}</legend>
          {lines.map((line) => (
            <div key={line.id} className="ctrreg-review" data-warning={line.id}>
              <strong>{`${line.code} · ${line.title}`}</strong>
              <label>
                <span>{t('ctrWarn.meetingDialog.outcome.label')}</span>
                <select
                  value={form.outcomes[line.id] ?? ''}
                  aria-invalid={missing.includes(line.id) ? true : undefined}
                  onChange={(event) => setForm({ ...form, outcomes: { ...form.outcomes, [line.id]: event.target.value } })}
                >
                  <option value="">{t('ctrWarn.dialog.pick.option')}</option>
                  {REVIEW_OUTCOMES.map((outcome) => (
                    <option key={outcome} value={outcome}>
                      {reviewLabel(t, outcome)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>{t('ctrWarn.meetingDialog.note.label')}</span>
                <input type="text" value={form.notesOf[line.id] ?? ''} onChange={(event) => setForm({ ...form, notesOf: { ...form.notesOf, [line.id]: event.target.value } })} />
              </label>
            </div>
          ))}
        </fieldset>
      )}
      {missing.length > 0 && (
        <small role="alert" className="field-error" data-testid="missing-reviews">
          {t('ctrWarn.meetingDialog.missing.error', { count: missing.length })}
        </small>
      )}
    </RegisterDialog>
  );
}

function IssueDialog({ register, onClose, onDone }: { register: Register; onClose: () => void; onDone: (receipt: string) => void }) {
  const { t } = useTranslation();
  const today = todayInVietnam();
  const issue = useIssueRegister();
  const sender = useSender();
  const waiting = meetingsAwaitingIssue(register);
  const [form, setForm] = useState<IssueForm>({ issuedOn: today, meetingId: waiting[0]?.id ?? '' });
  const [, setErrors, message] = useErrors<IssueForm>();
  const submit = (): void => {
    const found = validateIssue(form, today);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    sender.run(
      (handlers) => issue.mutate({ contractId: register.contract.id, body: issueBody(form) }, handlers),
      () => onDone(t('ctrWarn.success.issued.text', { contract: register.contract.code })),
    );
  };
  return (
    <RegisterDialog
      title={t('ctrWarn.issueDialog.title')}
      context={[{ label: t('ctrWarn.dialog.contract.label'), value: register.contract.code }]}
      confirmLabel={t('ctrWarn.issueDialog.confirm.action')}
      pending={issue.isPending}
      problem={sender.problem}
      onSubmit={submit}
      onCancel={onClose}
      onReload={sender.reload}
    >
      <p className="sub">{t('ctrWarn.issueDialog.effect.text')}</p>
      <Field id="issue-day" label={t('ctrWarn.issueDialog.issuedOn.label')} error={message('issuedOn')}>
        <input id="issue-day" type="date" value={form.issuedOn} max={today} onChange={(event) => setForm({ ...form, issuedOn: event.target.value })} />
      </Field>
      <Field id="issue-meeting" label={t('ctrWarn.issueDialog.meeting.label')} hint={t('ctrWarn.issueDialog.meeting.hint')} error={undefined}>
        <select id="issue-meeting" value={form.meetingId} onChange={(event) => setForm({ ...form, meetingId: event.target.value })}>
          <option value="">{t('ctrWarn.issueDialog.noMeeting.option')}</option>
          {waiting.map((meeting) => (
            <option key={meeting.id} value={meeting.id}>
              {t('ctrWarn.issueDialog.meeting.option', { ordinal: meeting.ordinal, day: dayText(meeting.held_on) })}
            </option>
          ))}
        </select>
      </Field>
    </RegisterDialog>
  );
}
