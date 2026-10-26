import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../i18n';
import { useSession } from '../../session/SessionContext';
import { DialogFrame, Field } from './components';
import { useCancelEngagement, useCoordinatorOptions, useCreateEngagement, useEndFieldwork, usePlaceOptions, useStartEngagement } from './hooks';
import { authorityKindLabel, commandProblemMessage, engagementTypeLabel, formProblemMessage, scopeKindLabel } from './labels';
import {
  AUTHORITY_KINDS,
  EMPTY_CANCEL_FORM,
  EMPTY_CREATE_FORM,
  EMPTY_END_FORM,
  EMPTY_START_FORM,
  ENGAGEMENT_TYPES,
  SCOPE_KINDS,
  cancelBody,
  createBody,
  describeProblem,
  endBody,
  startBody,
  validateCancel,
  validateCreate,
  validateEnd,
  validateStart,
} from './model';
import type { CancelForm, CreateForm, EndForm, EngagementDetail, ScopeItem, ScopeKind, StartForm } from './model';

type Problems<F> = Partial<Record<keyof F, Parameters<typeof formProblemMessage>[1]>>;

/** The error of a field once the person has tried to send the form. */
function errorOf<F>(problems: Problems<F>, submitted: boolean, field: keyof F, message: (problem: NonNullable<Problems<F>[keyof F]>) => string): string | undefined {
  const problem = problems[field];
  return submitted && problem !== undefined ? message(problem as NonNullable<Problems<F>[keyof F]>) : undefined;
}

/** The places of the scope of an engagement: a kind, a place of that kind chosen from what the caller may read, and the list of what was added. */
function ScopePicker({ value, onChange, error }: { value: ScopeItem[]; onChange(next: ScopeItem[]): void; error: string | undefined }) {
  const { t } = useTranslation();
  const [kind, setKind] = useState<ScopeKind>('PROJECT');
  const [placeId, setPlaceId] = useState('');
  const places = usePlaceOptions(kind, true);
  const options = (places.data ?? []).filter((place) => !value.some((item) => item.kind === kind && item.id === place.id));
  const add = (): void => {
    const place = options.find((candidate) => candidate.id === placeId);
    if (place === undefined) return;
    onChange([...value, { kind, id: place.id, code: place.code, name: place.name }]);
    setPlaceId('');
  };
  return (
    <Field id="engagement-scope-place" label={t('aud.engagementDialog.scope.label')} error={error} hint={t('aud.engagementDialog.scope.help')}>
      <div className="aud-scope-picker">
        <div className="aud-scope-add">
          <select
            id="engagement-scope-kind"
            aria-label={t('aud.engagementDialog.scope.kind.label')}
            value={kind}
            onChange={(event) => {
              setKind(event.target.value as ScopeKind);
              setPlaceId('');
            }}
          >
            {SCOPE_KINDS.map((candidate) => (
              <option key={candidate} value={candidate}>
                {scopeKindLabel(t, candidate)}
              </option>
            ))}
          </select>
          <select id="engagement-scope-place" value={placeId} onChange={(event) => setPlaceId(event.target.value)} disabled={places.isLoading}>
            <option value="">{places.isLoading ? t('aud.engagementDialog.scope.loading') : t('aud.engagementDialog.scope.choose')}</option>
            {options.map((place) => (
              <option key={place.id} value={place.id}>
                {`${place.code} · ${place.name}`}
              </option>
            ))}
          </select>
          <button type="button" onClick={add} disabled={placeId === ''}>
            {t('aud.engagementDialog.scope.add')}
          </button>
        </div>
        {value.length === 0 ? (
          <p className="sub">{t('aud.engagementDialog.scope.empty')}</p>
        ) : (
          <ul className="aud-scope-list" data-testid="scope-list">
            {value.map((item) => (
              <li key={`${item.kind}:${item.id}`}>
                <span>{`${scopeKindLabel(t, item.kind)}: ${item.code} · ${item.name}`}</span>
                <button type="button" aria-label={t('aud.engagementDialog.scope.remove', { code: item.code })} onClick={() => onChange(value.filter((other) => other !== item))}>
                  {t('aud.engagementDialog.scope.removeAction')}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Field>
  );
}

/** The registration of an engagement: the code, the kind, the authority, the decision of DOC that is in force, the period, the coordinator and the places it is about. */
export function CreateDialog({ onClose, onCreated }: { onClose(): void; onCreated(id: string): void }) {
  const { t } = useTranslation();
  const { tenant, user } = useSession();
  const create = useCreateEngagement();
  const coordinators = useCoordinatorOptions(true);
  const [form, setForm] = useState<CreateForm>({ ...EMPTY_CREATE_FORM, coordinatorId: tenant?.membershipId ?? '' });
  const [submitted, setSubmitted] = useState(false);
  const problems = validateCreate(form);
  const error = (field: keyof CreateForm): string | undefined => errorOf(problems, submitted, field, (problem) => formProblemMessage(t, problem));
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (create.isPending || Object.keys(problems).length > 0) return;
    create.mutate(createBody(form), {
      onSuccess: (result) => {
        onCreated(result.resource_id ?? '');
        onClose();
      },
    });
  };
  // The caller is always an option: a caller who may not read the directory coordinates the engagement themselves.
  const self = { id: tenant?.membershipId ?? '', name: user?.displayName ?? t('aud.engagementDialog.coordinator.self') };
  const people = [self, ...(coordinators.data ?? []).filter((person) => person.id !== self.id)].filter((person) => person.id !== '');
  return (
    <DialogFrame
      title={t('aud.engagementDialog.create.title')}
      onClose={onClose}
      refusal={create.isError ? commandProblemMessage(t, describeProblem(create.error)) : undefined}
      pending={create.isPending}
      onSubmit={submit}
    >
      <Field id="engagement-code" label={t('aud.engagementDialog.code.label')} error={error('code')} hint={t('aud.engagementDialog.code.help')}>
        <input id="engagement-code" value={form.code} onChange={(event) => setForm({ ...form, code: event.target.value })} />
      </Field>
      <Field id="engagement-type" label={t('aud.engagementDialog.type.label')} error={error('type')}>
        <select id="engagement-type" value={form.type} onChange={(event) => setForm({ ...form, type: event.target.value as CreateForm['type'] })}>
          <option value="">{t('aud.engagementDialog.type.choose')}</option>
          {ENGAGEMENT_TYPES.map((type) => (
            <option key={type} value={type}>
              {engagementTypeLabel(t, type)}
            </option>
          ))}
        </select>
      </Field>
      <Field id="engagement-authority-kind" label={t('aud.engagementDialog.authorityKind.label')} error={error('authorityKind')}>
        <select id="engagement-authority-kind" value={form.authorityKind} onChange={(event) => setForm({ ...form, authorityKind: event.target.value as CreateForm['authorityKind'] })}>
          <option value="">{t('aud.engagementDialog.authorityKind.choose')}</option>
          {AUTHORITY_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {authorityKindLabel(t, kind)}
            </option>
          ))}
        </select>
      </Field>
      <Field id="engagement-authority-name" label={t('aud.engagementDialog.authorityName.label')} error={error('authorityName')}>
        <input id="engagement-authority-name" value={form.authorityName} onChange={(event) => setForm({ ...form, authorityName: event.target.value })} />
      </Field>
      <Field id="engagement-decision" label={t('aud.engagementDialog.decision.label')} error={error('decisionDocumentId')} hint={t('aud.engagementDialog.decision.help')}>
        <input id="engagement-decision" value={form.decisionDocumentId} onChange={(event) => setForm({ ...form, decisionDocumentId: event.target.value })} />
      </Field>
      <Field id="engagement-title" label={t('aud.engagementDialog.title.label')} error={error('title')}>
        <input id="engagement-title" value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} />
      </Field>
      <Field id="engagement-period-from" label={t('aud.engagementDialog.periodFrom.label')} error={error('periodFrom')}>
        <input id="engagement-period-from" type="date" value={form.periodFrom} onChange={(event) => setForm({ ...form, periodFrom: event.target.value })} />
      </Field>
      <Field id="engagement-period-to" label={t('aud.engagementDialog.periodTo.label')} error={error('periodTo')}>
        <input id="engagement-period-to" type="date" value={form.periodTo} onChange={(event) => setForm({ ...form, periodTo: event.target.value })} />
      </Field>
      <Field id="engagement-coordinator" label={t('aud.engagementDialog.coordinator.label')} error={error('coordinatorId')}>
        <select id="engagement-coordinator" value={form.coordinatorId} onChange={(event) => setForm({ ...form, coordinatorId: event.target.value })}>
          <option value="">{t('aud.engagementDialog.coordinator.choose')}</option>
          {people.map((person) => (
            <option key={person.id} value={person.id}>
              {person.name}
            </option>
          ))}
        </select>
      </Field>
      <div className="wide">
        <ScopePicker value={form.scope} onChange={(scope) => setForm({ ...form, scope })} error={error('scope')} />
      </div>
    </DialogFrame>
  );
}

/** The start of an engagement: the day it starts and whether the legal hold that covers its scope is placed with it (BR-AUD-10). */
export function StartDialog({ engagement, today, onClose }: { engagement: EngagementDetail; today: string; onClose(): void }) {
  const { t } = useTranslation();
  const start = useStartEngagement();
  const [form, setForm] = useState<StartForm>({ ...EMPTY_START_FORM, startedOn: today });
  const [submitted, setSubmitted] = useState(false);
  const problems = validateStart(form, today);
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (start.isPending || Object.keys(problems).length > 0) return;
    start.mutate({ id: engagement.id, version: engagement.version, body: startBody(form) }, { onSuccess: onClose });
  };
  return (
    <DialogFrame
      title={t('aud.engagementDialog.start.title', { code: engagement.code })}
      onClose={onClose}
      refusal={start.isError ? commandProblemMessage(t, describeProblem(start.error)) : undefined}
      pending={start.isPending}
      onSubmit={submit}
    >
      <Field id="engagement-started-on" label={t('aud.engagementDialog.startedOn.label')} error={errorOf(problems, submitted, 'startedOn', (problem) => formProblemMessage(t, problem))}>
        <input id="engagement-started-on" type="date" max={today} value={form.startedOn} onChange={(event) => setForm({ ...form, startedOn: event.target.value })} />
      </Field>
      <div className="field wide">
        <label className="check" htmlFor="engagement-place-hold">
          <input id="engagement-place-hold" type="checkbox" checked={form.placeLegalHold} onChange={(event) => setForm({ ...form, placeLegalHold: event.target.checked })} />
          {t('aud.engagementDialog.placeHold.label')}
        </label>
        <small className="sub">{t('aud.engagementDialog.placeHold.help')}</small>
      </div>
    </DialogFrame>
  );
}

/** The end of the fieldwork of an engagement: the day it ended, between the start and today. */
export function EndFieldworkDialog({ engagement, today, onClose }: { engagement: EngagementDetail; today: string; onClose(): void }) {
  const { t } = useTranslation();
  const end = useEndFieldwork();
  const [form, setForm] = useState<EndForm>({ ...EMPTY_END_FORM, onDate: today });
  const [submitted, setSubmitted] = useState(false);
  const problems = validateEnd(form, engagement, today);
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (end.isPending || Object.keys(problems).length > 0) return;
    end.mutate({ id: engagement.id, version: engagement.version, body: endBody(form) }, { onSuccess: onClose });
  };
  return (
    <DialogFrame
      title={t('aud.engagementDialog.end.title', { code: engagement.code })}
      onClose={onClose}
      refusal={end.isError ? commandProblemMessage(t, describeProblem(end.error)) : undefined}
      pending={end.isPending}
      onSubmit={submit}
    >
      <Field id="engagement-end-on" label={t('aud.engagementDialog.endOn.label')} error={errorOf(problems, submitted, 'onDate', (problem) => formProblemMessage(t, problem))} hint={t('aud.engagementDialog.endOn.help')}>
        <input id="engagement-end-on" type="date" max={today} value={form.onDate} onChange={(event) => setForm({ ...form, onDate: event.target.value })} />
      </Field>
    </DialogFrame>
  );
}

/** The cancellation of an engagement that has no conclusion: a day and a reason in words; the hold that covers its scope is released with it. */
export function CancelDialog({ engagement, today, onClose }: { engagement: EngagementDetail; today: string; onClose(): void }) {
  const { t } = useTranslation();
  const cancel = useCancelEngagement();
  const [form, setForm] = useState<CancelForm>({ ...EMPTY_CANCEL_FORM, onDate: today });
  const [submitted, setSubmitted] = useState(false);
  const problems = validateCancel(form, today);
  const error = (field: keyof CancelForm): string | undefined => errorOf(problems, submitted, field, (problem) => formProblemMessage(t, problem));
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (cancel.isPending || Object.keys(problems).length > 0) return;
    cancel.mutate({ id: engagement.id, version: engagement.version, body: cancelBody(form) }, { onSuccess: onClose });
  };
  return (
    <DialogFrame
      title={t('aud.engagementDialog.cancel.title', { code: engagement.code })}
      onClose={onClose}
      refusal={cancel.isError ? commandProblemMessage(t, describeProblem(cancel.error)) : undefined}
      pending={cancel.isPending}
      onSubmit={submit}
    >
      <Field id="engagement-cancel-on" label={t('aud.engagementDialog.cancelOn.label')} error={error('onDate')}>
        <input id="engagement-cancel-on" type="date" max={today} value={form.onDate} onChange={(event) => setForm({ ...form, onDate: event.target.value })} />
      </Field>
      <div className="wide">
        <Field id="engagement-cancel-reason" label={t('aud.engagementDialog.cancelReason.label')} error={error('reason')} hint={t('aud.engagementDialog.cancelReason.help')}>
          <textarea id="engagement-cancel-reason" rows={4} value={form.reason} onChange={(event) => setForm({ ...form, reason: event.target.value })} />
        </Field>
      </div>
    </DialogFrame>
  );
}
