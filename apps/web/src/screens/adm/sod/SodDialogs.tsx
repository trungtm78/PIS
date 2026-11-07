import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../../i18n';
import { ConfirmDialog } from '../../../ui';
import { Field } from '../../dgv/components';
import { CommandFrame } from '../../qms/CommandFrame';
import { useApproveException, useRejectException, useRequestException, useRevokeException, useStaff, useSubjects } from './hooks';
import { actionLabel, formProblemMessage, problemMessage, scopeLabel } from './labels';
import { REASON_MAX, REASON_MIN, SUBJECT_LIST, describeProblem, emptyForm, formProblems, pairKeyOf, refusedField, toBody } from './model';
import type { ExceptionView, Form, FormProblem, MatrixView } from './model';

/** The request for an exception: the pair (from the matrix, only the pairs that take one), the subject, the person it covers, the days and the reason. */
export function RequestDialog({ matrix, today, preset, onClose }: { matrix: MatrixView; today: string; preset?: string; onClose: () => void }) {
  const { t } = useTranslation();
  const request = useRequestException();
  const staff = useStaff(true);
  const [form, setForm] = useState<Form>(() => ({ ...emptyForm(today), pair: preset ?? '' }));
  const [submitted, setSubmitted] = useState(false);
  const conflict = matrix.conflicts.find((entry) => pairKeyOf(entry) === form.pair);
  const subjects = useSubjects(conflict === undefined ? 'record' : SUBJECT_LIST[conflict.scope], conflict !== undefined);
  const problems = formProblems(form, today, matrix);
  const has = (problem: FormProblem): boolean => submitted && problems.includes(problem);
  const set = (patch: Partial<Form>): void => setForm({ ...form, ...patch });
  const named = refusedField(request.error);
  const offered = matrix.conflicts.filter((entry) => entry.maxDays > 0);
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (request.isPending || problems.length > 0) return;
    request.mutate(toBody(form), { onSuccess: onClose });
  };
  return (
    <CommandFrame
      title={t('govd.sod.request.title')}
      refusal={request.isError ? problemMessage(t, describeProblem(request.error)) : undefined}
      pending={request.isPending}
      submitLabel={t('govd.sod.request.submit')}
      words={{ close: t('govd.sod.dialog.close'), cancel: t('govd.sod.dialog.cancel'), pending: t('govd.sod.dialog.pending') }}
      onSubmit={send}
      onClose={onClose}
    >
      <p className="sub" data-testid="request-note">
        {t('govd.sod.request.note', { approvers: matrix.approvers })}
      </p>
      <fieldset disabled={request.isPending}>
        <Field id="sod-pair" label={t('govd.sod.form.pair')} error={has('pairRequired') ? formProblemMessage(t, 'pairRequired') : has('noException') ? formProblemMessage(t, 'noException') : undefined}>
          <select id="sod-pair" value={form.pair} onChange={(event) => set({ pair: event.target.value, subjectId: '' })}>
            <option value="">{t('govd.sod.form.choose')}</option>
            {offered.map((entry) => (
              <option key={pairKeyOf(entry)} value={pairKeyOf(entry)}>
                {`${actionLabel(t, entry.actionA)} / ${actionLabel(t, entry.actionB)} (${scopeLabel(t, entry.scope)})`}
              </option>
            ))}
          </select>
        </Field>
        <Field
          id="sod-subject"
          label={t('govd.sod.form.subject')}
          hint={conflict === undefined ? undefined : t('govd.sod.form.subject.hint', { scope: scopeLabel(t, conflict.scope) })}
          error={has('subjectRequired') || named === 'subject_id' ? formProblemMessage(t, 'subjectRequired') : undefined}
        >
          {(subjects.data ?? []).length > 0 ? (
            <select id="sod-subject" value={form.subjectId} onChange={(event) => set({ subjectId: event.target.value })}>
              <option value="">{t('govd.sod.form.choose')}</option>
              {(subjects.data ?? []).map((subject) => (
                <option key={subject.id} value={subject.id}>
                  {subject.label}
                </option>
              ))}
            </select>
          ) : (
            <input id="sod-subject" type="text" value={form.subjectId} autoComplete="off" onChange={(event) => set({ subjectId: event.target.value })} />
          )}
        </Field>
        <Field id="sod-member" label={t('govd.sod.form.member')} error={has('memberRequired') || named === 'member_id' ? formProblemMessage(t, 'memberRequired') : undefined}>
          <select id="sod-member" value={form.memberId} onChange={(event) => set({ memberId: event.target.value })}>
            <option value="">{t('govd.sod.form.choose')}</option>
            {(staff.data ?? []).map((member) => (
              <option key={member.id} value={member.id}>
                {member.name}
              </option>
            ))}
          </select>
        </Field>
        <Field id="sod-from" label={t('govd.sod.form.from')} error={has('datesInvalid') || has('inThePast') ? formProblemMessage(t, has('inThePast') ? 'inThePast' : 'datesInvalid') : undefined}>
          <input id="sod-from" type="date" value={form.validFrom} min={today} onChange={(event) => set({ validFrom: event.target.value })} />
        </Field>
        <Field
          id="sod-to"
          label={t('govd.sod.form.to')}
          hint={conflict === undefined || conflict.maxDays === 0 ? undefined : t('govd.sod.form.to.hint', { days: conflict.maxDays })}
          error={has('tooLong') || named === 'valid_to' ? formProblemMessage(t, 'tooLong') : undefined}
        >
          <input id="sod-to" type="date" value={form.validTo} min={form.validFrom} onChange={(event) => set({ validTo: event.target.value })} />
        </Field>
        <Field id="sod-reason" label={t('govd.sod.form.reason')} hint={t('govd.sod.form.reason.hint', { min: REASON_MIN, max: REASON_MAX })} error={has('reasonShort') ? formProblemMessage(t, 'reasonShort') : undefined}>
          <textarea id="sod-reason" rows={3} value={form.reason} maxLength={REASON_MAX} onChange={(event) => set({ reason: event.target.value })} />
        </Field>
      </fieldset>
    </CommandFrame>
  );
}

/** What names the exception in a decision dialog: the pair, the person it covers and the days. */
function contextOf(t: ReturnType<typeof useTranslation>['t'], row: ExceptionView): { label: string; value: string }[] {
  return [
    { label: t('govd.sod.column.pair'), value: `${actionLabel(t, row.actionA)} / ${actionLabel(t, row.actionB)}` },
    { label: t('govd.sod.column.member'), value: row.memberName === '' ? row.memberId.slice(0, 8) : row.memberName },
    { label: t('govd.sod.column.window'), value: `${row.validFrom} - ${row.validTo}` },
  ];
}

export function ApproveDialog({ row, onClose }: { row: ExceptionView; onClose: () => void }) {
  const { t } = useTranslation();
  const approve = useApproveException();
  return (
    <ConfirmDialog
      open
      title={t('govd.sod.approve.title')}
      context={contextOf(t, row)}
      confirmLabel={t('govd.sod.approve.confirm')}
      cancelLabel={t('govd.sod.dialog.cancel')}
      pending={approve.isPending}
      reason={{ label: t('govd.sod.approve.comment') }}
      error={approve.isError ? problemMessage(t, describeProblem(approve.error)) : undefined}
      onConfirm={(comment) => approve.mutate({ id: row.id, version: row.version, comment: comment === undefined || comment.trim() === '' ? undefined : comment.trim() }, { onSuccess: onClose })}
      onCancel={onClose}
    >
      <p className="sub">{t('govd.sod.approve.note', { given: row.approvals, needed: row.approversNeeded })}</p>
    </ConfirmDialog>
  );
}

export function RejectDialog({ row, onClose }: { row: ExceptionView; onClose: () => void }) {
  const { t } = useTranslation();
  const reject = useRejectException();
  return (
    <ConfirmDialog
      open
      title={t('govd.sod.reject.title')}
      context={contextOf(t, row)}
      confirmLabel={t('govd.sod.reject.confirm')}
      cancelLabel={t('govd.sod.dialog.cancel')}
      pending={reject.isPending}
      reason={{ label: t('govd.sod.reject.reason'), required: true, minLength: REASON_MIN, hint: t('govd.sod.form.reason.hint', { min: REASON_MIN, max: REASON_MAX }) }}
      error={reject.isError ? problemMessage(t, describeProblem(reject.error)) : undefined}
      onConfirm={(reason) => reject.mutate({ id: row.id, version: row.version, reason: (reason ?? '').trim() }, { onSuccess: onClose })}
      onCancel={onClose}
    />
  );
}

export function RevokeDialog({ row, onClose }: { row: ExceptionView; onClose: () => void }) {
  const { t } = useTranslation();
  const revoke = useRevokeException();
  return (
    <ConfirmDialog
      open
      title={t('govd.sod.revoke.title')}
      context={contextOf(t, row)}
      confirmLabel={t('govd.sod.revoke.confirm')}
      cancelLabel={t('govd.sod.dialog.cancel')}
      pending={revoke.isPending}
      reason={{ label: t('govd.sod.revoke.reason'), required: true, minLength: REASON_MIN, hint: t('govd.sod.form.reason.hint', { min: REASON_MIN, max: REASON_MAX }) }}
      error={revoke.isError ? problemMessage(t, describeProblem(revoke.error)) : undefined}
      onConfirm={(reason) => revoke.mutate({ id: row.id, version: row.version, reason: (reason ?? '').trim() }, { onSuccess: onClose })}
      onCancel={onClose}
    >
      <p className="sub">{t('govd.sod.revoke.note')}</p>
    </ConfirmDialog>
  );
}
