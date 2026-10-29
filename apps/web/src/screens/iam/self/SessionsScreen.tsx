import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { Field } from '../../dgv/components';
import { CommandFrame } from '../../qms/CommandFrame';
import { useDevices, useRevokeDevice, useRevokeSession, useSessions } from './hooks';
import { assuranceLabel, platformLabel, problemMessage } from './labels';
import { MIN_REASON, describeProblem } from './model';
import type { DeviceView, SessionView } from './model';

type Dialog = { kind: 'session'; session: SessionView } | { kind: 'device'; device: DeviceView };

/**
 * IAM-06: the sessions and the devices of the person (ST-IAM-006). The session they are using is marked and cannot be revoked here; every other one can be signed out, and a device can be removed (its push token goes with it
 * and the sessions opened on it are signed out). A revoked session is refused within a minute, here at once.
 */
export default function SessionsScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <SessionsContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function SessionsContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { mode } = useSession();
  const sessions = useSessions();
  const devices = useDevices();
  const [dialog, setDialog] = useState<Dialog | undefined>(undefined);
  const state = useScreenState({ isLoading: sessions.isLoading || devices.isLoading, error: sessions.error ?? devices.error, data: sessions.data, isEmpty: () => false });
  const acting = mode !== 'READ_ONLY';
  const moment = (iso: string): string => (iso === '' ? t('iam.sessions.none') : new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date(iso)));
  const sessionRows = sessions.data ?? [];
  const deviceRows = devices.data ?? [];

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('iam.sessions.title')}</h1>
          <p>{t('iam.sessions.subtitle')}</p>
        </div>
      </div>
      <StateBoundary
        state={state}
        onRetry={() => {
          void sessions.refetch();
          void devices.refetch();
        }}
      >
        <div className="card">
          <h2>{t('iam.sessions.sessions.title')}</h2>
          {sessionRows.length === 0 ? (
            <p className="sub" data-testid="no-sessions">
              {t('iam.sessions.sessions.none')}
            </p>
          ) : (
            <table className="table" data-testid="sessions">
              <thead>
                <tr>
                  <th scope="col">{t('iam.sessions.column.client')}</th>
                  <th scope="col">{t('iam.sessions.column.assurance')}</th>
                  <th scope="col">{t('iam.sessions.column.started')}</th>
                  <th scope="col">{t('iam.sessions.column.lastSeen')}</th>
                  <th scope="col">
                    <span className="sr-only">{t('iam.sessions.column.actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {sessionRows.map((row) => (
                  <tr key={row.id} data-session={row.id} data-current={row.current ? 'yes' : 'no'}>
                    <td>
                      {row.userAgent === '' ? t('iam.sessions.none') : row.userAgent}
                      {row.devicePlatform === null ? null : <small className="sub">{platformLabel(t, row.devicePlatform)}</small>}
                    </td>
                    <td>{assuranceLabel(t, row.assurance)}</td>
                    <td>{moment(row.createdAt)}</td>
                    <td>{moment(row.lastSeenAt)}</td>
                    <td>
                      {row.current ? (
                        <span className="pill green" data-testid="current">
                          {t('iam.sessions.current')}
                        </span>
                      ) : acting ? (
                        <button type="button" data-action="revoke-session" onClick={() => setDialog({ kind: 'session', session: row })}>
                          {t('iam.sessions.revoke.action')}
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="card">
          <h2>{t('iam.sessions.devices.title')}</h2>
          {deviceRows.length === 0 ? (
            <p className="sub" data-testid="no-devices">
              {t('iam.sessions.devices.none')}
            </p>
          ) : (
            <table className="table" data-testid="devices">
              <thead>
                <tr>
                  <th scope="col">{t('iam.sessions.column.device')}</th>
                  <th scope="col">{t('iam.sessions.column.lastSeen')}</th>
                  <th scope="col">{t('iam.sessions.column.state')}</th>
                  <th scope="col">
                    <span className="sr-only">{t('iam.sessions.column.actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {deviceRows.map((row) => (
                  <tr key={row.id} data-device={row.id} data-revoked={row.revoked ? 'yes' : 'no'}>
                    <td>
                      {platformLabel(t, row.platform)}
                      <small className="sub">{row.devicePublicId}</small>
                    </td>
                    <td>{moment(row.lastSeenAt)}</td>
                    <td>
                      <span className={`pill ${row.revoked ? 'gray' : 'green'}`} data-testid="device-state">
                        {row.revoked ? t('iam.sessions.device.revoked') : t('iam.sessions.device.active')}
                      </span>
                    </td>
                    <td>
                      {row.revoked || !acting ? null : (
                        <button type="button" data-action="revoke-device" onClick={() => setDialog({ kind: 'device', device: row })}>
                          {t('iam.sessions.device.revoke.action')}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </StateBoundary>
      {dialog === undefined ? null : <RevokeDialog dialog={dialog} onClose={() => setDialog(undefined)} />}
      <p className="prototype-note">{t('iam.self.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function RevokeDialog({ dialog, onClose }: { dialog: Dialog; onClose: () => void }) {
  const { t } = useTranslation();
  const revokeSession = useRevokeSession();
  const revokeDevice = useRevokeDevice();
  const command = dialog.kind === 'session' ? revokeSession : revokeDevice;
  // The reason is asked for and kept in the audit trail; a default is offered so that a person who just wants it done is one click away.
  const [reason, setReason] = useState(dialog.kind === 'session' ? t('iam.sessions.revoke.reason.default') : t('iam.sessions.device.reason.default'));
  const [submitted, setSubmitted] = useState(false);
  const tooShort = reason.trim().length < MIN_REASON;
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (command.isPending || tooShort) return;
    if (dialog.kind === 'session') revokeSession.mutate({ id: dialog.session.id, reason: reason.trim() }, { onSuccess: onClose });
    else revokeDevice.mutate({ id: dialog.device.id, reason: reason.trim() }, { onSuccess: onClose });
  };
  return (
    <CommandFrame
      title={dialog.kind === 'session' ? t('iam.sessions.revoke.title') : t('iam.sessions.device.revoke.title')}
      refusal={command.isError ? problemMessage(t, describeProblem(command.error)) : undefined}
      pending={command.isPending}
      submitLabel={dialog.kind === 'session' ? t('iam.sessions.revoke.submit') : t('iam.sessions.device.revoke.submit')}
      words={{ close: t('iam.self.dialog.close'), cancel: t('iam.self.dialog.cancel'), pending: t('iam.self.pending') }}
      onSubmit={send}
      onClose={onClose}
    >
      <fieldset disabled={command.isPending}>
        <p>{dialog.kind === 'session' ? t('iam.sessions.revoke.text') : t('iam.sessions.device.revoke.text')}</p>
        <Field id="revoke-reason" label={t('iam.sessions.reason')} error={submitted && tooShort ? t('iam.sessions.problem.reasonShort') : undefined}>
          <textarea id="revoke-reason" value={reason} maxLength={2000} onChange={(event) => setReason(event.target.value)} />
        </Field>
      </fieldset>
    </CommandFrame>
  );
}
