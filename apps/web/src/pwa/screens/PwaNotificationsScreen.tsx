import { newCommandAttempt } from '@machvon/api-client';
import { useCallback, useMemo, useState } from 'react';
import { useApiClient } from '../../api/ApiClientContext';
import { useTranslation } from '../../i18n';
import type { Translator } from '../../i18n';
import { readStoredDevice } from '../push-client';
import { browserPushDeps, usePushControl } from '../usePushControl';
import type { PushControlDeps } from '../usePushControl';
import { PwaBackLink } from './PwaBackLink';
import { pushStateText } from './PwaStartScreen';
import './pwa.css';

export const NOTIFICATIONS_PATH = '/m/notifications';
const START_PATH = '/m';

type T = Translator['t'];
type TestState = 'idle' | 'working' | 'SENT' | 'GONE' | 'RETRY_LATER' | 'CHANNEL_NOT_ACTIVE' | 'NO_TOKEN' | 'failed';

function permissionText(t: T, permission: NotificationPermission | undefined): string {
  switch (permission) {
    case 'granted':
      return t('webpush.permission.granted');
    case 'denied':
      return t('webpush.permission.denied');
    case 'default':
      return t('webpush.permission.default');
    default:
      return t('webpush.permission.unknown');
  }
}

function testText(t: T, state: TestState): string {
  switch (state) {
    case 'working':
      return t('webpush.test.state.working');
    case 'SENT':
      return t('webpush.test.state.sent');
    case 'GONE':
      return t('webpush.test.state.gone');
    case 'RETRY_LATER':
      return t('webpush.test.state.retry');
    case 'CHANNEL_NOT_ACTIVE':
      return t('webpush.test.state.inactive');
    case 'NO_TOKEN':
      return t('webpush.test.state.noToken');
    case 'failed':
      return t('webpush.test.state.failed');
    case 'idle':
      return '';
  }
}

const KNOWN_OUTCOMES: readonly string[] = ['SENT', 'GONE', 'RETRY_LATER', 'CHANNEL_NOT_ACTIVE', 'NO_TOKEN'];

export interface PwaNotificationsScreenProps {
  /** Tests pass their own; the page uses the browser's. */
  pushDeps?: PushControlDeps;
}

/**
 * The notification settings of the installed application (YCK.01): the permission the browser holds, whether this device is subscribed, the three actions of the person
 * (turn on, turn off, send a test notification to myself). The test message is the same as any push (the name of the product and the start page), sent by the server to
 * this device's own record; the answer says what the push service did without naming an address. Asking for the permission is always a tap.
 */
export default function PwaNotificationsScreen({ pushDeps }: PwaNotificationsScreenProps) {
  const { t } = useTranslation();
  const client = useApiClient();
  const deps = useMemo(() => pushDeps ?? browserPushDeps(), [pushDeps]);
  const push = usePushControl(deps);
  const [test, setTest] = useState<TestState>('idle');
  // The permission is read again whenever the state of push changes (a tap on "turn on" changes it).
  const permission = useMemo<NotificationPermission | undefined>(() => (deps.support === 'supported' && push.state !== 'checking' ? deps.permission() : undefined), [deps, push.state]);

  const sendTest = useCallback(async () => {
    const registrationId = readStoredDevice(deps.storage)?.registrationId;
    if (registrationId === undefined) {
      setTest('NO_TOKEN');
      return;
    }
    setTest('working');
    try {
      const answer = (await client.command('sendMyTestPush', { path: { deviceId: registrationId }, attempt: newCommandAttempt() } as never)) as { status?: string } | undefined;
      setTest(answer?.status !== undefined && KNOWN_OUTCOMES.includes(answer.status) ? (answer.status as TestState) : 'failed');
    } catch {
      setTest('failed');
    }
  }, [client, deps]);

  const busy = push.state === 'working' || test === 'working';
  return (
    <section className="pwa-screen" data-screen-id="PWA-10" aria-labelledby="screen-title">
      <PwaBackLink to={START_PATH} />
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('webpush.page.title')}</h1>
          <p>{t('webpush.page.subtitle')}</p>
        </div>
      </div>
      <section className="card pwa-card-panel" aria-labelledby="webpush-state-title" data-testid="webpush-state-card">
        <h2 id="webpush-state-title">{`${t('webpush.state.title')}: ${t('scr2.webpush.state.register')}`}</h2>
        <dl className="pwa-facts">
          <dt>{t('webpush.permission.label')}</dt>
          <dd data-testid="webpush-permission" data-permission={permission ?? 'unknown'}>
            {permissionText(t, permission)}
          </dd>
          <dt>{t('webpush.device.label')}</dt>
          <dd>
            <span role="status" data-testid="push-state" data-state={push.state}>
              {pushStateText(t, push.state)}
            </span>
          </dd>
        </dl>
        <p>{t('pwa.push.card.privacy')}</p>
        {push.state === 'off' || push.state === 'failed' ? (
          <button type="button" className="ui-button ui-button--primary pwa-touch" data-action="enable-push" disabled={busy} onClick={() => void push.enable()}>
            {t('pwa.push.action.enable')}
          </button>
        ) : null}
        {push.state === 'on' ? (
          <button type="button" className="ui-button ui-button--outline pwa-touch" data-action="disable-push" disabled={busy} onClick={() => void push.disable()}>
            {t('pwa.push.action.disable')}
          </button>
        ) : null}
      </section>
      <section className="card pwa-card-panel" aria-labelledby="webpush-test-title" data-testid="webpush-test-card">
        <h2 id="webpush-test-title">{t('scr2.webpush.test.title')}</h2>
        <p>{t('webpush.test.hint')}</p>
        <button type="button" className="ui-button ui-button--primary pwa-touch" data-action="send-test" disabled={busy || push.state !== 'on'} onClick={() => void sendTest()}>
          {t('webpush.test.action.send')}
        </button>
        {push.state !== 'on' ? <p data-testid="webpush-test-needs-on">{t('webpush.test.needsOn')}</p> : null}
        <p role="status" aria-live="polite" data-testid="webpush-test-state" data-state={test}>
          {testText(t, test)}
        </p>
      </section>
    </section>
  );
}
