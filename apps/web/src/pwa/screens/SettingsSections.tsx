import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../i18n';
import { useSession } from '../../session/SessionContext';
import { StatusPill, SectionCard } from '../../ui';
import { clockAndDay } from '../../ui/alerts/format';
import { useDevices, useProfile, useSessions, useUpdateProfile } from '../../screens/iam/self/hooks';
import { assuranceLabel, localeLabel, platformLabel, problemMessage } from '../../screens/iam/self/labels';
import { LOCALES, describeProblem } from '../../screens/iam/self/model';
import type { DeviceView, SessionView } from '../../screens/iam/self/model';
import { usePreferences, useSavePreferences } from '../../screens/not/preferences/hooks';
import { categoryName, channelName, digestName, problemMessage as preferenceProblem } from '../../screens/not/preferences/labels';
import { ALL_CATEGORIES, DIGEST_MODES, bodyOf, cellKey, draftOf, isLocked, problemReasonOf, quietProblem, tooManyItems } from '../../screens/not/preferences/model';
import type { DigestMode, PreferenceChannel, PreferenceDraft, PreferenceView } from '../../screens/not/preferences/model';

/** The channels a phone user decides here: the inbox, the push of this application and the mail. The other channels are set on the full screen NOT-03. */
export const PHONE_CHANNELS: readonly PreferenceChannel[] = ['IN_APP', 'PUSH', 'EMAIL'];

function Loading({ label }: { label: string }) {
  return (
    <div role="status" aria-busy="true" aria-label={label}>
      <span className="ui-skeleton ui-skeleton--line" />
      <span className="ui-skeleton ui-skeleton--line" />
    </div>
  );
}

function Failed({ text, retry }: { text: string; retry: () => void }) {
  const { t } = useTranslation();
  return (
    <p role="alert">
      {text}{' '}
      <button type="button" className="ui-button ui-button--outline ui-button--small pwa-touch" onClick={retry}>
        {t('states.retry.action')}
      </button>
    </p>
  );
}

export type RevokeTarget = { kind: 'session'; session: SessionView } | { kind: 'device'; device: DeviceView };

/** The sessions of the person with their assurance and when they were last seen; any but the current one can be ended (the current one is ended by signing out). */
export function SessionsCard({ canAct, onRevoke }: { canAct: boolean; onRevoke: (target: RevokeTarget) => void }) {
  const { t } = useTranslation();
  const sessions = useSessions();
  return (
    <SectionCard title={t('pwa2.settings.sessions.title')}>
      {sessions.isLoading ? (
        <Loading label={t('states.loading.label')} />
      ) : sessions.data === undefined ? (
        <Failed text={t('pwa2.settings.sessions.failed')} retry={() => void sessions.refetch()} />
      ) : sessions.data.length === 0 ? (
        <p role="status">{t('pwa2.settings.sessions.none')}</p>
      ) : (
        <ul className="pwa-cards pwa-cards--inner" aria-label={t('pwa2.settings.sessions.aria')} data-testid="sessions">
          {sessions.data.map((row) => (
            <li key={row.id} className="pwa-subcard" data-session={row.id} data-current={row.current ? 'yes' : 'no'}>
              <div className="pwa-card-head">
                <h3>{row.userAgent === '' ? t('iam.sessions.none') : row.userAgent}</h3>
                {row.current ? <StatusPill tone="success">{t('iam.sessions.current')}</StatusPill> : null}
              </div>
              <dl className="pwa-facts">
                <dt>{t('iam.sessions.column.assurance')}</dt>
                <dd>{assuranceLabel(t, row.assurance)}</dd>
                <dt>{t('iam.sessions.column.lastSeen')}</dt>
                <dd>{row.lastSeenAt === '' ? '—' : clockAndDay(row.lastSeenAt)}</dd>
                {row.devicePlatform === null ? null : (
                  <>
                    <dt>{t('iam.sessions.column.device')}</dt>
                    <dd>{platformLabel(t, row.devicePlatform)}</dd>
                  </>
                )}
              </dl>
              {row.current || !canAct ? null : (
                <button type="button" className="ui-button ui-button--outline pwa-touch" data-action="revoke-session" onClick={() => onRevoke({ kind: 'session', session: row })}>
                  {t('iam.sessions.revoke.action')}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

/** The devices registered to the person (the phone application and the installed web application are devices) and the way to remove one. */
export function DevicesCard({ canAct, onRevoke }: { canAct: boolean; onRevoke: (target: RevokeTarget) => void }) {
  const { t } = useTranslation();
  const devices = useDevices();
  return (
    <SectionCard title={t('pwa2.settings.devices.title')}>
      {devices.isLoading ? (
        <Loading label={t('states.loading.label')} />
      ) : devices.data === undefined ? (
        <Failed text={t('pwa2.settings.devices.failed')} retry={() => void devices.refetch()} />
      ) : devices.data.length === 0 ? (
        <p role="status">{t('iam.sessions.devices.none')}</p>
      ) : (
        <ul className="pwa-cards pwa-cards--inner" aria-label={t('pwa2.settings.devices.aria')} data-testid="devices">
          {devices.data.map((row) => (
            <li key={row.id} className="pwa-subcard" data-device={row.id} data-revoked={row.revoked ? 'yes' : 'no'}>
              <div className="pwa-card-head">
                <h3>{platformLabel(t, row.platform)}</h3>
                <StatusPill tone={row.revoked ? 'neutral' : 'success'}>{row.revoked ? t('iam.sessions.device.revoked') : t('iam.sessions.device.active')}</StatusPill>
              </div>
              <dl className="pwa-facts">
                <dt>{t('iam.sessions.column.lastSeen')}</dt>
                <dd>{row.lastSeenAt === '' ? '—' : clockAndDay(row.lastSeenAt)}</dd>
              </dl>
              {row.revoked || !canAct ? null : (
                <button type="button" className="ui-button ui-button--outline pwa-touch" data-action="revoke-device" onClick={() => onRevoke({ kind: 'device', device: row })}>
                  {t('iam.sessions.device.revoke.action')}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

/** The language of the interface: it changes on this device at once and is saved to the profile (under the version of the profile) so the other devices follow. */
export function LanguageCard({ canAct }: { canAct: boolean }) {
  const { t, locale, setLocale } = useTranslation();
  const profile = useProfile();
  const update = useUpdateProfile();
  const current = locale === 'vi' ? 'vi-VN' : 'en-US';
  const change = (value: string): void => {
    setLocale(value.startsWith('vi') ? 'vi' : 'en');
    if (profile.data != null && canAct && profile.data.locale !== value) update.mutate({ version: profile.data.version, body: { locale: value } });
  };
  return (
    <SectionCard title={t('pwa2.settings.language.title')}>
      <div className="field">
        <label htmlFor="pwa-settings-language">{t('pwa2.settings.language.label')}</label>
        <select id="pwa-settings-language" value={current} onChange={(event) => change(event.target.value)}>
          {LOCALES.map((code) => (
            <option key={code} value={code}>
              {localeLabel(t, code)}
            </option>
          ))}
        </select>
      </div>
      <p className="sub">{t('pwa2.settings.language.note')}</p>
      {update.isError ? (
        <p className="callout warning" role="alert" data-testid="language-problem">
          {problemMessage(t, describeProblem(update.error))}
        </p>
      ) : update.isSuccess ? (
        <p className="callout" role="status" data-testid="language-saved">
          {t('pwa2.settings.language.saved')}
        </p>
      ) : null}
    </SectionCard>
  );
}

/** Notifications per category: for each kind of event, whether it reaches the inbox, this application as a push, and the mail, and how often; plus the quiet hours. */
export function NotificationsCard() {
  const { t } = useTranslation();
  const preferences = usePreferences();
  const save = useSavePreferences();
  return (
    <SectionCard title={t('pwa2.settings.notifications.title')}>
      {preferences.isLoading ? (
        <Loading label={t('states.loading.label')} />
      ) : preferences.data === undefined ? (
        <Failed text={t('pwa2.settings.notifications.failed')} retry={() => void preferences.refetch()} />
      ) : (
        <NotificationsForm key={preferences.data.version} view={preferences.data} save={save} />
      )}
    </SectionCard>
  );
}

function NotificationsForm({ view, save }: { view: PreferenceView; save: ReturnType<typeof useSavePreferences> }) {
  const { t } = useTranslation();
  const { mode } = useSession();
  const readOnly = mode === 'READ_ONLY';
  const [draft, setDraft] = useState<PreferenceDraft>(() => draftOf(view));
  const [submitted, setSubmitted] = useState(false);
  const quiet = quietProblem(draft);
  const rows = [ALL_CATEGORIES, ...draft.categories];

  const toggle = (category: string, channel: string): void => {
    const key = cellKey(category, channel);
    const off = new Set(draft.off);
    if (off.has(key)) off.delete(key);
    else off.add(key);
    setDraft({ ...draft, off });
  };
  const setDigest = (category: string, value: DigestMode): void => {
    const digest = new Map(draft.digest);
    digest.set(category, value);
    setDraft({ ...draft, digest });
  };
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (quiet !== undefined || tooManyItems(draft)) return;
    save.mutate({ version: view.version, body: bodyOf(draft) });
  };

  return (
    <form onSubmit={submit} noValidate aria-label={t('pwa2.settings.notifications.title')} data-testid="preferences-form" className="pwa-sheet-form">
      {readOnly ? (
        <p className="callout warning" role="status">
          {t('not.pref.readOnly.message')}
        </p>
      ) : null}
      {view.isDefault ? <p className="sub">{t('not.pref.default.message')}</p> : null}
      {save.isError ? (
        <p className="callout warning" role="alert" data-testid="save-problem">
          {preferenceProblem(t, problemReasonOf(save.error))}
        </p>
      ) : null}
      {save.isSuccess ? (
        <p className="callout" role="status" data-testid="save-done">
          {t('not.pref.save.done')}
        </p>
      ) : null}
      {rows.map((category) => (
        <fieldset key={category} className="pwa-fieldset" data-category={category}>
          <legend>{categoryName(t, category)}</legend>
          {PHONE_CHANNELS.map((channel) => {
            const locked = isLocked(view, category, channel);
            return (
              <label key={channel} className="pwa-check" htmlFor={`pwa-pref-${category}-${channel}`}>
                <input
                  type="checkbox"
                  id={`pwa-pref-${category}-${channel}`}
                  checked={locked || !draft.off.has(cellKey(category, channel))}
                  disabled={locked || readOnly}
                  onChange={() => toggle(category, channel)}
                />
                <span>
                  {channelName(t, channel)}
                  {locked ? ` (${t('pwa2.settings.notifications.locked')})` : ''}
                </span>
              </label>
            );
          })}
          <div className="field">
            <label htmlFor={`pwa-pref-digest-${category}`}>{t('not.pref.col.digest')}</label>
            <select id={`pwa-pref-digest-${category}`} value={draft.digest.get(category) ?? 'IMMEDIATE'} disabled={readOnly} onChange={(event) => setDigest(category, event.target.value as DigestMode)}>
              {DIGEST_MODES.map((value) => (
                <option key={value} value={value}>
                  {digestName(t, value)}
                </option>
              ))}
            </select>
          </div>
        </fieldset>
      ))}
      <fieldset className="pwa-fieldset" data-testid="quiet">
        <legend>{t('pwa2.settings.notifications.quiet')}</legend>
        <label className="pwa-check" htmlFor="pwa-pref-quiet-on">
          <input type="checkbox" id="pwa-pref-quiet-on" checked={draft.quietOn} disabled={readOnly} onChange={(event) => setDraft({ ...draft, quietOn: event.target.checked })} />
          <span>{t('pwa2.settings.notifications.quietOn')}</span>
        </label>
        {draft.quietOn ? (
          <div className="pwa-filters">
            <div className="field">
              <label htmlFor="pwa-pref-quiet-start">{t('pwa2.settings.notifications.quietFrom')}</label>
              <input id="pwa-pref-quiet-start" type="time" value={draft.quietStart} disabled={readOnly} onChange={(event) => setDraft({ ...draft, quietStart: event.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="pwa-pref-quiet-end">{t('pwa2.settings.notifications.quietTo')}</label>
              <input id="pwa-pref-quiet-end" type="time" value={draft.quietEnd} disabled={readOnly} onChange={(event) => setDraft({ ...draft, quietEnd: event.target.value })} />
            </div>
          </div>
        ) : null}
        {submitted && quiet !== undefined ? (
          <p className="callout warning" role="alert" data-testid="quiet-problem">
            {quiet === 'empty' ? t('pwa2.settings.notifications.quietEmpty') : t('pwa2.settings.notifications.quietClock')}
          </p>
        ) : null}
      </fieldset>
      <p className="sub">{t('pwa2.settings.notifications.other')}</p>
      <button type="submit" className="ui-button ui-button--primary pwa-touch" disabled={readOnly || save.isPending}>
        {save.isPending ? t('pwa.approvals.sheet.pending') : t('pwa2.settings.notifications.save')}
      </button>
    </form>
  );
}
