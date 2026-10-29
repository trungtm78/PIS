import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { Field } from '../../dgv/components';
import { useProfile, useUpdateProfile } from './hooks';
import { fieldLabel, formProblemMessage, localeLabel, problemMessage } from './labels';
import { LOCALES, TIME_ZONES, describeProblem, differences, formOf, profileBody, validateProfile } from './model';
import type { ProfileForm, ProfileView } from './model';

/**
 * IAM-05: the profile of the person (ST-IAM-006). The name, the language, the time zone and the phone number are theirs to change; the email is shown masked and is not changed here. The change is made at the version that
 * was read: if the profile changed meanwhile (another device, another tab) nothing is lost; what the person entered stays in the form beside what the profile says now, and they choose.
 */
export default function ProfileScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The form belongs to one membership: a switch starts the screen over.
  return <ProfileContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function ProfileContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const profile = useProfile();
  // A saved change starts the form over on the profile as it is now; a conflict does not: what was entered stays.
  const [epoch, setEpoch] = useState(0);
  const [saved, setSaved] = useState(false);
  const state = useScreenState({ isLoading: profile.isLoading, error: profile.error, data: profile.data, isEmpty: (data) => data === null });
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('iam.profile.title')}</h1>
          <p>{t('iam.profile.subtitle')}</p>
        </div>
      </div>
      {saved ? (
        <p className="callout" role="status" data-testid="saved">
          {t('iam.profile.saved')}
        </p>
      ) : null}
      <StateBoundary state={state} onRetry={() => void profile.refetch()}>
        {profile.data === undefined || profile.data === null ? null : (
          <ProfileEditor
            key={epoch}
            profile={profile.data}
            reload={() => profile.refetch().then(() => undefined)}
            onEdit={() => setSaved(false)}
            onRestart={() => setEpoch(epoch + 1)}
            onSaved={() => {
              setSaved(true);
              setEpoch(epoch + 1);
            }}
          />
        )}
      </StateBoundary>
      <p className="prototype-note">{t('iam.self.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

/** `profile` is always the latest the server said; what the form was opened on is kept apart. */
function ProfileEditor({ profile, reload, onEdit, onRestart, onSaved }: { profile: ProfileView; reload: () => Promise<void>; onEdit: () => void; onRestart: () => void; onSaved: () => void }) {
  const { t } = useTranslation();
  const { mode } = useSession();
  const update = useUpdateProfile();
  // The profile as it was when the form was opened: the version the change is made at, and what "changed" is measured against.
  const [opened] = useState(profile);
  const [form, setForm] = useState<ProfileForm>(() => formOf(profile));
  const [submitted, setSubmitted] = useState(false);
  const [conflict, setConflict] = useState(false);
  const problems = validateProfile(form);
  const body = profileBody(form, opened);
  const acting = mode !== 'READ_ONLY';
  const shown = (field: keyof ProfileForm): string | undefined => {
    const problem = problems[field];
    return submitted && problem !== undefined ? formProblemMessage(t, problem) : undefined;
  };
  const set = (patch: Partial<ProfileForm>): void => {
    onEdit();
    setForm({ ...form, ...patch });
  };
  const current = profile;
  const side = conflict ? differences(form, opened, current) : [];
  const send =
    (version: number) =>
    (event: FormEvent): void => {
      event.preventDefault();
      setSubmitted(true);
      if (update.isPending || Object.keys(problems).length > 0 || Object.keys(body).length === 0) return;
      update.mutate(
        { version, body },
        {
          onSuccess: () => {
            setConflict(false);
            onSaved();
          },
          onError: (error) => {
            // The profile is read again; what was entered stays where it is.
            if (describeProblem(error) === 'versionConflict') {
              void reload().then(() => setConflict(true));
            }
          },
        },
      );
    };
  const refusal = update.isError ? problemMessage(t, describeProblem(update.error)) : undefined;

  return (
    <form className="card" onSubmit={send(opened.version)} noValidate aria-label={t('iam.profile.form.aria')} data-testid="profile-form">
      {refusal === undefined ? null : (
        <p className="callout warning" role="alert" data-testid="refusal">
          {refusal}
        </p>
      )}
      <fieldset disabled={!acting || update.isPending}>
        <Field id="profile-name" label={t('iam.profile.field.name')} error={shown('displayName')}>
          <input id="profile-name" value={form.displayName} maxLength={120} onChange={(event) => set({ displayName: event.target.value })} />
        </Field>
        <Field id="profile-email" label={t('iam.profile.field.email')} error={undefined} hint={t('iam.profile.email.hint')}>
          <input id="profile-email" value={profile.emailMasked} readOnly />
        </Field>
        <Field id="profile-phone" label={t('iam.profile.field.phone')} error={shown('phone')} hint={profile.phoneMasked === null ? t('iam.profile.phone.none') : t('iam.profile.phone.current', { phone: profile.phoneMasked })}>
          <input id="profile-phone" inputMode="tel" placeholder="+84901234567" value={form.phone} maxLength={16} onChange={(event) => set({ phone: event.target.value })} />
        </Field>
        <Field id="profile-locale" label={t('iam.profile.field.locale')} error={undefined}>
          <select id="profile-locale" value={form.locale} onChange={(event) => set({ locale: event.target.value })}>
            {LOCALES.map((locale) => (
              <option key={locale} value={locale}>
                {localeLabel(t, locale)}
              </option>
            ))}
          </select>
        </Field>
        <Field id="profile-zone" label={t('iam.profile.field.timeZone')} error={undefined}>
          <select id="profile-zone" value={form.timeZone} onChange={(event) => set({ timeZone: event.target.value })}>
            {(TIME_ZONES as readonly string[]).includes(form.timeZone) ? null : <option value={form.timeZone}>{form.timeZone}</option>}
            {TIME_ZONES.map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </select>
        </Field>
      </fieldset>
      {conflict ? (
        <section className="callout warning" role="alert" aria-label={t('iam.profile.conflict.title')} data-testid="conflict">
          <strong>{t('iam.profile.conflict.title')}</strong>
          <p>{t('iam.profile.conflict.text')}</p>
          {side.length > 0 ? (
            <table className="table" data-testid="conflict-table">
              <thead>
                <tr>
                  <th scope="col">{t('iam.profile.conflict.field')}</th>
                  <th scope="col">{t('iam.profile.conflict.entered')}</th>
                  <th scope="col">{t('iam.profile.conflict.current')}</th>
                </tr>
              </thead>
              <tbody>
                {side.map((entry) => (
                  <tr key={entry.field} data-field={entry.field}>
                    <td>{fieldLabel(t, entry.field)}</td>
                    <td data-testid="entered">{entry.entered}</td>
                    <td data-testid="current">{entry.current}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
          <div className="formfooter">
            <button type="button" data-action="use-current" onClick={onRestart}>
              {t('iam.profile.conflict.useCurrent')}
            </button>
            <button type="button" className="primary" data-action="keep-mine" disabled={update.isPending} onClick={(event) => send(current.version)(event as unknown as FormEvent)}>
              {t('iam.profile.conflict.keepMine')}
            </button>
          </div>
        </section>
      ) : null}
      {acting ? (
        <div className="formfooter">
          <button type="submit" className="primary" disabled={update.isPending || conflict}>
            {update.isPending ? t('iam.self.pending') : t('iam.profile.save')}
          </button>
        </div>
      ) : null}
    </form>
  );
}
