import { useState } from 'react';
import { useTranslation } from '../../i18n';
import { useSession } from '../../session/SessionContext';
import { DeadlinePreferenceCard } from '../../screens/pwf/preference/DeadlinePreferenceCard';
import { useRevokeDevice, useRevokeSession } from '../../screens/iam/self/hooks';
import { problemMessage } from '../../screens/iam/self/labels';
import { MIN_REASON, describeProblem } from '../../screens/iam/self/model';
import { DecisionSheet } from './DecisionSheet';
import { PwaBackLink } from './PwaBackLink';
import { DevicesCard, LanguageCard, NotificationsCard, SessionsCard } from './SettingsSections';
import type { RevokeTarget } from './SettingsSections';
import './pwa.css';

const START_PATH = '/m';

/**
 * The settings of the installed application (PWA-07, YCK.01): the sessions and devices of the person with the way to end one (`listMySessions`,
 * `listMyDevices`, `revokeMySession`, `revokeMyDevice`: the operations of IAM-06), the language of the interface, and the notifications per category and
 * the quiet hours (`getMyNotificationPreferences`, `updateMyNotificationPreferences`: NOT-03). Every card reads on its own, so one failure never hides the
 * others. Ending a session or a device asks for the reason (at least 10 characters, which the audit keeps); the current session is ended by signing out.
 */
export default function SettingsScreen() {
  const { tenant } = useSession();
  return <SettingsContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} />;
}

function SettingsContent() {
  const { t } = useTranslation();
  const { mode } = useSession();
  const canAct = mode !== 'READ_ONLY';
  const [target, setTarget] = useState<RevokeTarget | undefined>(undefined);
  const [tooShort, setTooShort] = useState(false);
  const [done, setDone] = useState<'session' | 'device' | undefined>(undefined);
  const revokeSession = useRevokeSession();
  const revokeDevice = useRevokeDevice();
  const active = target?.kind === 'device' ? revokeDevice : revokeSession;

  const close = (): void => {
    setTarget(undefined);
    setTooShort(false);
    revokeSession.reset();
    revokeDevice.reset();
  };
  const send = (reason: string): void => {
    if (target === undefined) return;
    const text = reason.trim();
    if (text.length < MIN_REASON) {
      setTooShort(true);
      return;
    }
    setTooShort(false);
    const kind = target.kind;
    const onSuccess = (): void => {
      setDone(kind);
      close();
    };
    if (target.kind === 'session') revokeSession.mutate({ id: target.session.id, reason: text }, { onSuccess });
    else revokeDevice.mutate({ id: target.device.id, reason: text }, { onSuccess });
  };

  return (
    <section className="pwa-screen" data-screen-id="PWA-07" aria-labelledby="screen-title">
      <PwaBackLink to={START_PATH} />
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('pwa2.settings.page.title')}</h1>
          <p>{t('pwa2.settings.page.subtitle')}</p>
        </div>
      </div>
      {done === undefined ? null : (
        <p className="callout" role="status" data-testid="revoked">
          {done === 'session' ? t('pwa2.settings.revoke.sessionDone') : t('pwa2.settings.revoke.deviceDone')}
        </p>
      )}
      <SessionsCard canAct={canAct} onRevoke={setTarget} />
      <DevicesCard canAct={canAct} onRevoke={setTarget} />
      <LanguageCard canAct={canAct} />
      <NotificationsCard />
      <DeadlinePreferenceCard />
      {target === undefined ? null : (
        <DecisionSheet
          title={target.kind === 'session' ? t('pwa2.settings.revoke.session.title') : t('pwa2.settings.revoke.device.title')}
          context={[
            target.kind === 'session'
              ? { label: t('iam.sessions.column.client'), value: target.session.userAgent === '' ? t('iam.sessions.none') : target.session.userAgent }
              : { label: t('iam.sessions.column.device'), value: target.device.devicePublicId === '' ? target.device.platform : target.device.devicePublicId },
          ]}
          commentLabel={t('pwa2.settings.revoke.reason')}
          commentRequired
          problem={tooShort ? t('pwa2.settings.revoke.tooShort', { min: MIN_REASON }) : active.isError ? problemMessage(t, describeProblem(active.error)) : undefined}
          pending={active.isPending}
          submitLabel={t('pwa2.settings.revoke.submit')}
          cancelLabel={t('pwa.approvals.sheet.cancel')}
          pendingLabel={t('pwa.approvals.sheet.pending')}
          requiredLabel={t('pwa.approvals.sheet.required')}
          onSubmit={send}
          onCancel={close}
        />
      )}
    </section>
  );
}
