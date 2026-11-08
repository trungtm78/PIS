import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { useTranslation } from '../../../i18n';
import { useSession } from '../../../session/SessionContext';
import { Field } from '../../dgv/components';
import { CommandFrame } from '../../qms/CommandFrame';
import { useUnits } from '../members/hooks';
import { useCreatePeriodScope, useCreateStandingRequest, useDecideActing, useDecideStandingRequest, useGrantOptions, useRequestActing, useReviewDelegation, useStaff } from './hooks';
import {
  actingProblemMessage,
  defectLabel,
  endKindLabel,
  problemMessage,
  refusedWhyLabel,
  reviewProblemMessage,
  scopeKindLabel,
  scopeProblemMessage,
  standingProblemMessage,
} from './labels';
import {
  ACTING_MAX_HOURS,
  END_KINDS,
  REASON_MIN,
  SCOPE_KINDS,
  actingProblems,
  describeProblem,
  emptyActingForm,
  emptyScopeForm,
  emptyStandingForm,
  offeredPermissions,
  parsePeriods,
  readDefects,
  reviewProblems,
  scopeProblems,
  standingProblems,
  toActingBody,
  toLocalInput,
  toStandingBody,
} from './model';
import type { ActingForm, ActingProblem, ActingView, PermanentView, ScopeForm, ScopeProblem, StandingForm, StandingProblem, StandingRequestView } from './model';

/** The words of the frame every dialog of these screens is asked in. */
function useFrameWords() {
  const { t } = useTranslation();
  return { close: t('adm.authority.dialog.close'), cancel: t('adm.authority.dialog.cancel'), pending: t('adm.authority.dialog.pending') };
}

/** The defects a refused request names, one line each with its field. */
function Defects({ error }: { error: unknown }) {
  const { t } = useTranslation();
  const defects = readDefects(error);
  if (defects.length === 0) return null;
  return (
    <ul className="callout warning" role="alert" data-testid="defects">
      {defects.map((defect) => (
        <li key={`${defect.field}:${defect.code}`} data-field={defect.field}>
          <code>{defect.field}</code> {defectLabel(t, defect.code)}
        </li>
      ))}
    </ul>
  );
}

function PeriodsField({ id, value, onChange, error }: { id: string; value: string; onChange: (value: string) => void; error: string | undefined }) {
  const { t } = useTranslation();
  const parsed = parsePeriods(value);
  return (
    <Field id={id} label={t('adm.authority.form.periods')} error={error} hint={t('adm.authority.form.periods.hint')}>
      <input id={id} value={value} placeholder={t('adm.authority.form.periodsExample')} onChange={(event) => onChange(event.target.value)} />
      {parsed.codes.length === 0 ? null : (
        <span className="authority-chips" data-testid="period-chips">
          {parsed.codes.map((code) => (
            <code key={code} className="authority-chip">
              {code}
            </code>
          ))}
        </span>
      )}
    </Field>
  );
}

/** A dialog that asks for a reason and nothing else: cancelling a request, revoking, lifting a limit, rejecting. */
export function ReasonDialog({
  title,
  text,
  submitLabel,
  pending,
  refusal,
  onSubmit,
  onClose,
  minimum = REASON_MIN,
  reasonLabel,
  children,
}: {
  title: string;
  text: string;
  submitLabel: string;
  pending: boolean;
  refusal: unknown;
  onSubmit: (reason: string) => void;
  onClose: () => void;
  minimum?: number;
  reasonLabel?: string;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const words = useFrameWords();
  const [reason, setReason] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const tooShort = reason.trim().length < minimum;
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (pending || tooShort) return;
    onSubmit(reason.trim());
  };
  return (
    <CommandFrame title={title} refusal={refusal === undefined || refusal === null ? undefined : problemMessage(t, describeProblem(refusal))} pending={pending} submitLabel={submitLabel} words={words} onSubmit={send} onClose={onClose}>
      <fieldset disabled={pending}>
        <p>{text}</p>
        {children}
        <Field id="authority-reason" label={reasonLabel ?? t('adm.authority.form.reason')} error={submitted && tooShort ? t('adm.authority.problem.reasonMin', { min: minimum }) : undefined}>
          <textarea id="authority-reason" value={reason} maxLength={2000} onChange={(event) => setReason(event.target.value)} />
        </Field>
      </fieldset>
    </CommandFrame>
  );
}

// ---- ADM-25 ---------------------------------------------------------------------------------------------------------------------------------

export function StandingRequestDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const { permissions } = useSession();
  const words = useFrameWords();
  const create = useCreateStandingRequest();
  const members = useStaff(true);
  const units = useUnits(true);
  const [now] = useState(() => new Date());
  const [form, setForm] = useState<StandingForm>(() => emptyStandingForm(now));
  const [submitted, setSubmitted] = useState(false);
  const problems = standingProblems(form, new Date());
  const shown = (...which: StandingProblem[]): string | undefined => {
    const found = submitted ? problems.find((problem) => which.includes(problem)) : undefined;
    return found === undefined ? undefined : standingProblemMessage(t, found);
  };
  const set = (patch: Partial<StandingForm>): void => setForm({ ...form, ...patch });
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (create.isPending || problems.length > 0) return;
    create.mutate(toStandingBody(form), { onSuccess: onClose });
  };
  return (
    <CommandFrame
      title={t('adm.authority.standing.new.title')}
      refusal={create.isError ? problemMessage(t, describeProblem(create.error)) : undefined}
      pending={create.isPending}
      submitLabel={t('adm.authority.standing.new.submit')}
      words={words}
      onSubmit={send}
      onClose={onClose}
    >
      {members.isError || units.isError ? (
        <p className="callout warning" role="alert" data-testid="lookup-failed">
          {t('adm.authority.form.lookupFailed')}
        </p>
      ) : null}
      <Defects error={create.error} />
      <fieldset disabled={create.isPending}>
        <p className="sub">{t('adm.authority.standing.new.note')}</p>
        <Field id="standing-delegate" label={t('adm.authority.form.delegate')} error={shown('delegateRequired')}>
          <select id="standing-delegate" value={form.delegateId} onChange={(event) => set({ delegateId: event.target.value })}>
            <option value="">{t('adm.authority.form.choose')}</option>
            {(members.data ?? []).map((member) => (
              <option key={member.id} value={member.id}>
                {member.name}
              </option>
            ))}
          </select>
        </Field>
        <fieldset>
          <legend>{t('adm.authority.form.permissions')}</legend>
          {offeredPermissions(permissions).map((permission) => (
            <label key={permission} className="authority-permission">
              <input type="checkbox" value={permission} checked={form.permissions.includes(permission)} onChange={(event) => set({ permissions: event.target.checked ? [...form.permissions, permission] : form.permissions.filter((entry) => entry !== permission) })} /> {permission}
            </label>
          ))}
          {shown('permissionsRequired') === undefined ? null : <p className="field-error">{shown('permissionsRequired')}</p>}
        </fieldset>
        <Field id="standing-scope-kind" label={t('adm.authority.form.scopeKind')} error={undefined}>
          <select id="standing-scope-kind" value={form.scopeKind} onChange={(event) => set({ scopeKind: event.target.value as StandingForm['scopeKind'] })}>
            {SCOPE_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {scopeKindLabel(t, kind)}
              </option>
            ))}
          </select>
        </Field>
        <Field id="standing-unit" label={t('adm.authority.form.unit')} error={shown('unitRequired')}>
          <select id="standing-unit" value={form.unitId} onChange={(event) => set({ unitId: event.target.value })}>
            <option value="">{t('adm.authority.form.choose')}</option>
            {(units.data ?? []).map((unit) => (
              <option key={unit.id} value={unit.id}>
                {unit.name}
              </option>
            ))}
          </select>
        </Field>
        <PeriodsField id="standing-periods" value={form.periods} onChange={(periods) => set({ periods })} error={shown('periodMalformed', 'periodOverlap', 'periodTooMany')} />
        <Field id="standing-from" label={t('adm.authority.form.from')} error={shown('startPast')}>
          <input id="standing-from" type="datetime-local" value={form.validFrom} onChange={(event) => set({ validFrom: event.target.value })} />
        </Field>
        <Field id="standing-review" label={t('adm.authority.form.review')} error={shown('reviewInvalid', 'reviewTooFar', 'reviewPast', 'reviewAfterEnd')} hint={t('adm.authority.form.review.hint')}>
          <input id="standing-review" type="datetime-local" value={form.reviewDueAt} onChange={(event) => set({ reviewDueAt: event.target.value })} />
        </Field>
        <Field id="standing-end-kind" label={t('adm.authority.form.endKind')} error={undefined}>
          <select id="standing-end-kind" value={form.endKind} onChange={(event) => set({ endKind: event.target.value as StandingForm['endKind'] })}>
            {END_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {endKindLabel(t, kind)}
              </option>
            ))}
          </select>
        </Field>
        <Field id="standing-end-text" label={t('adm.authority.form.endText')} error={shown('endTextShort')} hint={t('adm.authority.form.endText.hint')}>
          <textarea id="standing-end-text" value={form.endText} maxLength={500} onChange={(event) => set({ endText: event.target.value })} />
        </Field>
        {form.endKind === 'UNTIL_DATE' ? (
          <Field id="standing-end-on" label={t('adm.authority.form.endOn')} error={shown('endOnRequired', 'endOnInvalid')}>
            <input id="standing-end-on" type="datetime-local" value={form.endOn} onChange={(event) => set({ endOn: event.target.value })} />
          </Field>
        ) : null}
        <Field id="standing-reason" label={t('adm.authority.form.reason')} error={shown('reasonShort')}>
          <textarea id="standing-reason" value={form.reason} maxLength={2000} onChange={(event) => set({ reason: event.target.value })} />
        </Field>
        <Field id="standing-basis" label={t('adm.authority.form.basis')} error={undefined}>
          <input id="standing-basis" value={form.legalBasis} onChange={(event) => set({ legalBasis: event.target.value })} />
        </Field>
      </fieldset>
    </CommandFrame>
  );
}

/** The decision on a request: approve, or reject with the reason; the one who decides is the second person, and the server refuses the two parties. */
export function StandingDecisionDialog({ request, onClose }: { request: StandingRequestView; onClose: () => void }) {
  const { t } = useTranslation();
  const words = useFrameWords();
  const decide = useDecideStandingRequest();
  const [choice, setChoice] = useState<'approve' | 'reject'>('approve');
  const [reason, setReason] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const tooShort = choice === 'reject' && reason.trim().length < REASON_MIN;
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (decide.isPending || tooShort) return;
    decide.mutate({ id: request.id, version: request.version, decision: choice, reason: reason.trim() }, { onSuccess: onClose });
  };
  return (
    <CommandFrame
      title={t('adm.authority.standing.decide.title')}
      refusal={decide.isError ? problemMessage(t, describeProblem(decide.error)) : undefined}
      pending={decide.isPending}
      submitLabel={choice === 'approve' ? t('adm.authority.standing.decide.approve') : t('adm.authority.standing.decide.reject')}
      words={words}
      onSubmit={send}
      onClose={onClose}
    >
      <Defects error={decide.error} />
      <fieldset disabled={decide.isPending}>
        <p>{t('adm.authority.standing.decide.text', { delegator: request.delegatorName, delegate: request.delegateName })}</p>
        <p className="sub">{t('adm.authority.standing.decide.rule')}</p>
        <Field id="standing-decision" label={t('adm.authority.standing.decide.choice')} error={undefined}>
          <select id="standing-decision" value={choice} onChange={(event) => setChoice(event.target.value as 'approve' | 'reject')}>
            <option value="approve">{t('adm.authority.standing.decide.approve')}</option>
            <option value="reject">{t('adm.authority.standing.decide.reject')}</option>
          </select>
        </Field>
        <Field id="standing-decision-reason" label={t('adm.authority.form.reason')} error={submitted && tooShort ? t('adm.authority.problem.reasonMin', { min: REASON_MIN }) : undefined}>
          <textarea id="standing-decision-reason" value={reason} maxLength={2000} onChange={(event) => setReason(event.target.value)} />
        </Field>
      </fieldset>
    </CommandFrame>
  );
}

/** The review of a permanent delegation: the delegator confirms they still need it and moves the date it works until. */
export function ReviewDialog({ delegation, onClose }: { delegation: PermanentView; onClose: () => void }) {
  const { t } = useTranslation();
  const words = useFrameWords();
  const review = useReviewDelegation();
  const [now] = useState(() => new Date());
  const [next, setNext] = useState(() => toLocalInput(new Date(now.getTime() + 180 * 86_400_000)));
  const [note, setNote] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const problems = reviewProblems(delegation, next, new Date());
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (review.isPending || problems.length > 0) return;
    review.mutate({ id: delegation.id, version: delegation.version, reviewDueAt: new Date(next).toISOString(), note: note.trim() }, { onSuccess: onClose });
  };
  return (
    <CommandFrame
      title={t('adm.authority.review.title')}
      refusal={review.isError ? problemMessage(t, describeProblem(review.error)) : undefined}
      pending={review.isPending}
      submitLabel={t('adm.authority.review.submit')}
      words={words}
      onSubmit={send}
      onClose={onClose}
    >
      <Defects error={review.error} />
      <fieldset disabled={review.isPending}>
        <p>{t('adm.authority.review.text', { name: delegation.delegateName })}</p>
        <Field id="review-next" label={t('adm.authority.form.review')} error={submitted && problems[0] !== undefined ? reviewProblemMessage(t, problems[0]) : undefined} hint={t('adm.authority.form.review.hint')}>
          <input id="review-next" type="datetime-local" value={next} onChange={(event) => setNext(event.target.value)} />
        </Field>
        <Field id="review-note" label={t('adm.authority.review.note')} error={undefined}>
          <textarea id="review-note" value={note} maxLength={2000} onChange={(event) => setNote(event.target.value)} />
        </Field>
      </fieldset>
    </CommandFrame>
  );
}

// ---- ADM-26 ---------------------------------------------------------------------------------------------------------------------------------

export function ActingRequestDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const words = useFrameWords();
  const request = useRequestActing();
  const members = useStaff(true);
  const [form, setForm] = useState<ActingForm>(() => emptyActingForm());
  const [submitted, setSubmitted] = useState(false);
  const checked = actingProblems(form);
  const shown = (...which: ActingProblem[]): string | undefined => {
    const found = submitted ? checked.problems.find((problem) => which.includes(problem)) : undefined;
    return found === undefined ? undefined : actingProblemMessage(t, found);
  };
  const set = (patch: Partial<ActingForm>): void => setForm({ ...form, ...patch });
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (request.isPending || checked.problems.length > 0) return;
    request.mutate(toActingBody(form), { onSuccess: onClose });
  };
  return (
    <CommandFrame
      title={t('adm.authority.acting.new.title')}
      refusal={request.isError ? problemMessage(t, describeProblem(request.error)) : undefined}
      pending={request.isPending}
      submitLabel={t('adm.authority.acting.new.submit')}
      words={words}
      onSubmit={send}
      onClose={onClose}
    >
      {members.isError ? (
        <p className="callout warning" role="alert" data-testid="lookup-failed">
          {t('adm.authority.form.lookupFailed')}
        </p>
      ) : null}
      <Defects error={request.error} />
      <fieldset disabled={request.isPending}>
        <p className="sub">{t('adm.authority.acting.new.note', { hours: ACTING_MAX_HOURS })}</p>
        <Field id="acting-subject" label={t('adm.authority.acting.form.subject')} error={shown('subjectRequired')}>
          <select id="acting-subject" value={form.subjectId} onChange={(event) => set({ subjectId: event.target.value })}>
            <option value="">{t('adm.authority.form.choose')}</option>
            {(members.data ?? []).map((member) => (
              <option key={member.id} value={member.id}>
                {member.name}
              </option>
            ))}
          </select>
        </Field>
        <Field id="acting-permissions" label={t('adm.authority.acting.form.permissions')} error={shown('permissionsRequired', 'permissionRefused')} hint={t('adm.authority.acting.form.permissionsHint')}>
          <textarea id="acting-permissions" value={form.permissions} onChange={(event) => set({ permissions: event.target.value })} />
          {submitted && checked.refused.length > 0 ? (
            <ul data-testid="refused">
              {checked.refused.map((entry) => (
                <li key={entry.permission} data-permission={entry.permission}>
                  <code>{entry.permission}</code> {refusedWhyLabel(t, entry.why)}
                </li>
              ))}
            </ul>
          ) : null}
        </Field>
        <PeriodsField id="acting-periods" value={form.periods} onChange={(periods) => set({ periods })} error={shown('periodMalformed', 'periodOverlap', 'periodTooMany')} />
        <Field id="acting-hours" label={t('adm.authority.acting.form.hours')} error={shown('hoursInvalid')}>
          <input id="acting-hours" type="number" min={1} max={ACTING_MAX_HOURS} value={form.hours} onChange={(event) => set({ hours: event.target.value })} />
        </Field>
        <Field id="acting-reason" label={t('adm.authority.form.reason')} error={shown('reasonShort')}>
          <textarea id="acting-reason" value={form.reason} maxLength={1000} onChange={(event) => set({ reason: event.target.value })} />
        </Field>
      </fieldset>
    </CommandFrame>
  );
}

export function ActingDecisionDialog({ grant, onClose }: { grant: ActingView; onClose: () => void }) {
  const { t } = useTranslation();
  const words = useFrameWords();
  const decide = useDecideActing();
  const [choice, setChoice] = useState<'approve' | 'reject'>('approve');
  const [reason, setReason] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const tooShort = choice === 'reject' && reason.trim().length < REASON_MIN;
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (decide.isPending || tooShort) return;
    decide.mutate({ id: grant.id, version: grant.version, decision: choice, reason: reason.trim() }, { onSuccess: onClose });
  };
  return (
    <CommandFrame
      title={t('adm.authority.acting.decide.title')}
      refusal={decide.isError ? problemMessage(t, describeProblem(decide.error)) : undefined}
      pending={decide.isPending}
      submitLabel={choice === 'approve' ? t('adm.authority.acting.decide.approve') : t('adm.authority.acting.decide.reject')}
      words={words}
      onSubmit={send}
      onClose={onClose}
    >
      <fieldset disabled={decide.isPending}>
        <p>{t('adm.authority.acting.decide.text', { requester: grant.requesterName, subject: grant.subjectName, hours: grant.hours })}</p>
        <p className="sub">{t('adm.authority.acting.decide.rule')}</p>
        <p data-testid="decide-permissions">
          <code>{grant.permissions.join(', ')}</code>
        </p>
        <Field id="acting-decision" label={t('adm.authority.acting.decide.choice')} error={undefined}>
          <select id="acting-decision" value={choice} onChange={(event) => setChoice(event.target.value as 'approve' | 'reject')}>
            <option value="approve">{t('adm.authority.acting.decide.approve')}</option>
            <option value="reject">{t('adm.authority.acting.decide.reject')}</option>
          </select>
        </Field>
        <Field id="acting-decision-reason" label={t('adm.authority.form.reason')} error={submitted && tooShort ? t('adm.authority.problem.reasonMin', { min: REASON_MIN }) : undefined}>
          <textarea id="acting-decision-reason" value={reason} maxLength={2000} onChange={(event) => setReason(event.target.value)} />
        </Field>
      </fieldset>
    </CommandFrame>
  );
}

// ---- ADM-27 ---------------------------------------------------------------------------------------------------------------------------------

export function ScopeDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const words = useFrameWords();
  const create = useCreatePeriodScope();
  const grants = useGrantOptions(true);
  const members = useStaff(true);
  const [form, setForm] = useState<ScopeForm>(() => emptyScopeForm());
  const [submitted, setSubmitted] = useState(false);
  const problems = scopeProblems(form);
  const shown = (...which: ScopeProblem[]): string | undefined => {
    const found = submitted ? problems.find((problem) => which.includes(problem)) : undefined;
    return found === undefined ? undefined : scopeProblemMessage(t, found);
  };
  const memberName = (id: string): string => members.data?.find((member) => member.id === id)?.name ?? id.slice(0, 8);
  const set = (patch: Partial<ScopeForm>): void => setForm({ ...form, ...patch });
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (create.isPending || problems.length > 0) return;
    create.mutate({ grantId: form.grantId, periodCodes: parsePeriods(form.periods).codes, reason: form.reason.trim() }, { onSuccess: onClose });
  };
  return (
    <CommandFrame
      title={t('adm.authority.scopes.new.title')}
      refusal={create.isError ? problemMessage(t, describeProblem(create.error)) : undefined}
      pending={create.isPending}
      submitLabel={t('adm.authority.scopes.new.submit')}
      words={words}
      onSubmit={send}
      onClose={onClose}
    >
      {grants.isError ? (
        <p className="callout warning" role="alert" data-testid="lookup-failed">
          {t('adm.authority.form.lookupFailed')}
        </p>
      ) : null}
      <Defects error={create.error} />
      <fieldset disabled={create.isPending}>
        <p className="sub">{t('adm.authority.scopes.new.note')}</p>
        <Field id="scope-grant" label={t('adm.authority.scopes.form.grant')} error={shown('grantRequired')}>
          <select id="scope-grant" value={form.grantId} onChange={(event) => set({ grantId: event.target.value })}>
            <option value="">{t('adm.authority.form.choose')}</option>
            {(grants.data ?? []).map((grant) => (
              <option key={grant.id} value={grant.id}>
                {memberName(grant.membershipId)} - {grant.roleCode}
              </option>
            ))}
          </select>
        </Field>
        <PeriodsField id="scope-periods" value={form.periods} onChange={(periods) => set({ periods })} error={shown('periodsRequired', 'periodMalformed', 'periodOverlap', 'periodTooMany')} />
        <Field id="scope-reason" label={t('adm.authority.form.reason')} error={shown('reasonShort')}>
          <textarea id="scope-reason" value={form.reason} maxLength={2000} onChange={(event) => set({ reason: event.target.value })} />
        </Field>
      </fieldset>
    </CommandFrame>
  );
}
