import { ApiError } from '@machvon/api-client';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../../i18n';
import type { Translator } from '../../../i18n';
import { usePlaceHold, useReleaseHold } from './hooks';
import { EMPTY_HOLD, HOLD_KIND_CHOICES, HOLD_SCOPE_CHOICES, holdBody, holdHasProblems, validateHold, validateRelease } from './hold-forms';
import type { HoldForm, HoldProblem } from './hold-forms';
import { holdKindLabel, holdScopeLabel } from './labels';
import type { HoldView } from './model';

type T = Translator['t'];

export const MANAGE_HOLD_PERMISSION = 'legal_hold.manage';

function problemText(t: T, problem: HoldProblem | undefined): string | undefined {
  switch (problem) {
    case undefined:
      return undefined;
    case 'required':
      return t('adm.retention.hold.formError.required');
    case 'tooShort':
      return t('adm.retention.hold.formError.tooShort');
    case 'tooLong':
      return t('adm.retention.hold.formError.tooLong');
    case 'invalid':
      return t('adm.retention.hold.formError.invalid');
    case 'noIds':
      return t('adm.retention.hold.formError.noIds');
    case 'idsNotAllowed':
      return t('adm.retention.hold.formError.idsNotAllowed');
    case 'tooManyIds':
      return t('adm.retention.hold.formError.tooManyIds');
  }
}

/** The refusal of a hold command in words: a release by the person who placed the hold, a hold that is not active any more, a version that moved, a scope the person does not reach. */
function refusalText(t: T, error: unknown): string {
  const code = error instanceof ApiError ? error.code : undefined;
  switch (code) {
    case 'SELF_APPROVAL_DENIED':
      return t('adm.retention.hold.error.self');
    case 'LEGAL_HOLD_STATE_INVALID':
      return t('adm.retention.hold.error.state');
    case 'VERSION_CONFLICT':
      return t('adm.retention.hold.error.conflict');
    case 'SCOPE_DENIED':
      return t('adm.retention.hold.error.scope');
    case 'VALIDATION_FAILED':
      return t('adm.retention.hold.error.invalid');
    default:
      return t('adm.retention.hold.error.general');
  }
}

/** Places a legal hold on the paper of an authority: the kind, what it covers, the reference of the paper and the reason. While a hold is active nothing it covers is disposed of, whatever a rule says. */
export function PlaceHoldForm({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const place = usePlaceHold();
  const [form, setForm] = useState<HoldForm>(EMPTY_HOLD);
  const [attempted, setAttempted] = useState(false);
  const problems = attempted ? validateHold(form) : {};
  const set = (change: Partial<HoldForm>): void => setForm({ ...form, ...change });
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setAttempted(true);
    if (place.isPending || holdHasProblems(validateHold(form))) return;
    place.mutate(holdBody(form), { onSuccess: onClose });
  };
  return (
    <form onSubmit={submit} noValidate aria-label={t('adm.retention.hold.place.title')} data-testid="place-hold-form">
      <h3>{t('adm.retention.hold.place.title')}</h3>
      <p className="sub">{t('adm.retention.hold.place.help')}</p>
      {place.isError ? (
        <p className="callout warning" role="alert" data-testid="hold-refusal">
          {refusalText(t, place.error)}
        </p>
      ) : null}
      <div className="field">
        <label htmlFor="hold-kind">{t('adm.retention.hold.form.kind')}</label>
        <select id="hold-kind" value={form.holdKind} onChange={(event) => set({ holdKind: event.target.value as HoldForm['holdKind'] })}>
          {HOLD_KIND_CHOICES.map((kind) => (
            <option key={kind} value={kind}>
              {holdKindLabel(t, kind)}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="hold-scope">{t('adm.retention.hold.form.scope')}</label>
        <select id="hold-scope" value={form.scopeKind} onChange={(event) => {
            const scopeKind = event.target.value as HoldForm['scopeKind'];
            // The whole tenant takes no ids: what was typed for another scope is cleared, so the disabled field cannot hold a value that blocks the form.
            set(scopeKind === 'TENANT' ? { scopeKind, ids: '' } : { scopeKind });
          }}>
          {HOLD_SCOPE_CHOICES.map((kind) => (
            <option key={kind} value={kind}>
              {holdScopeLabel(t, kind)}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="hold-ids">{t('adm.retention.hold.form.ids')}</label>
        <textarea id="hold-ids" rows={2} value={form.ids} disabled={form.scopeKind === 'TENANT'} aria-invalid={problems.ids !== undefined} onChange={(event) => set({ ids: event.target.value })} />
        <small className="sub">{form.scopeKind === 'TENANT' ? t('adm.retention.hold.form.idsTenant') : t('adm.retention.hold.form.idsHint')}</small>
        {problems.ids === undefined ? null : <small role="alert">{problemText(t, problems.ids)}</small>}
      </div>
      <div className="field">
        <label htmlFor="hold-authority">{t('adm.retention.hold.form.authority')}</label>
        <input id="hold-authority" value={form.authorityReference} aria-invalid={problems.authorityReference !== undefined} onChange={(event) => set({ authorityReference: event.target.value })} />
        {problems.authorityReference === undefined ? null : <small role="alert">{problemText(t, problems.authorityReference)}</small>}
      </div>
      <div className="field">
        <label htmlFor="hold-reason">{t('adm.retention.hold.form.reason')}</label>
        <textarea id="hold-reason" rows={3} value={form.reason} aria-invalid={problems.reason !== undefined} onChange={(event) => set({ reason: event.target.value })} />
        {problems.reason === undefined ? null : <small role="alert">{problemText(t, problems.reason)}</small>}
      </div>
      <div className="field">
        <label htmlFor="hold-effective">{t('adm.retention.hold.form.effective')}</label>
        <input id="hold-effective" type="datetime-local" value={form.effectiveAt} aria-invalid={problems.effectiveAt !== undefined} onChange={(event) => set({ effectiveAt: event.target.value })} />
        {problems.effectiveAt === undefined ? null : <small role="alert">{problemText(t, problems.effectiveAt)}</small>}
      </div>
      <div className="formfooter">
        <button type="button" onClick={onClose}>
          {t('adm.retention.hold.form.cancel')}
        </button>
        <button type="submit" className="primary" disabled={place.isPending}>
          {t('adm.retention.hold.place.submit')}
        </button>
      </div>
    </form>
  );
}

/** Releases a hold: the reason is recorded, and the person who placed the hold cannot release it (a second person confirms the end of the paper of the authority). */
export function ReleaseHoldForm({ hold, onClose }: { hold: HoldView; onClose: () => void }) {
  const { t } = useTranslation();
  const release = useReleaseHold();
  const [reason, setReason] = useState('');
  const [attempted, setAttempted] = useState(false);
  const problem = attempted ? validateRelease(reason) : undefined;
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setAttempted(true);
    if (release.isPending || validateRelease(reason) !== undefined) return;
    release.mutate({ id: hold.id, version: hold.version ?? 1, reason: reason.trim() }, { onSuccess: onClose });
  };
  return (
    <form onSubmit={submit} noValidate aria-label={t('adm.retention.hold.release.title')} data-testid="release-hold-form">
      <h3>{t('adm.retention.hold.release.title')}</h3>
      <p className="sub">{t('adm.retention.hold.release.help', { authority: hold.authorityReference })}</p>
      {release.isError ? (
        <p className="callout warning" role="alert" data-testid="hold-refusal">
          {refusalText(t, release.error)}
        </p>
      ) : null}
      <div className="field">
        <label htmlFor="release-reason">{t('adm.retention.hold.form.reason')}</label>
        <textarea id="release-reason" rows={3} value={reason} aria-invalid={problem !== undefined} onChange={(event) => setReason(event.target.value)} />
        {problem === undefined ? null : <small role="alert">{problemText(t, problem)}</small>}
      </div>
      <div className="formfooter">
        <button type="button" onClick={onClose}>
          {t('adm.retention.hold.form.cancel')}
        </button>
        <button type="submit" className="primary" disabled={release.isPending}>
          {t('adm.retention.hold.release.submit')}
        </button>
      </div>
    </form>
  );
}
