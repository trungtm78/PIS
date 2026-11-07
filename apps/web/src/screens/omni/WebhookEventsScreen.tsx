import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { instantText } from '../adm/audit/SealBanner';
import { READ_INTEGRATION_PERMISSION } from '../adm/connectors/model';
import { useInboxEvents, useReplayInboxEvent } from '../adm/inbox/hooks';
import { inboxStatusLabel, inboxStatusPill, problemMessage } from '../adm/inbox/labels';
import { INBOX_STATUSES, OPERATE_INTEGRATION_PERMISSION, REASON_MAX_LENGTH, REASON_MIN_LENGTH, describeProblem, mayReplay } from '../adm/inbox/model';
import type { InboxStatus } from '../adm/inbox/model';
import { StatusPill } from '../../ui';
import '../not/delivery/delivery.css';

/**
 * OMNI-11: the webhook events of the channel accounts and their reconciliation. It is the inbox of the integration events (ADM-10) narrowed to the events a provider sent for a channel account of the tenant: who sent them, the key of the event, that its signature
 * was good (an event is stored only after the signature was checked, so every one shown is), when it came, where it stands and what failed. A failed or dead event is taken up again with a reason; its payload is never shown.
 */
export default function WebhookEventsScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The filter and the open replay belong to one tenant: switching starts the screen over.
  return <EventsContent key={tenant?.id ?? 'none'} route={route} />;
}

function EventsContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { permissions, mode } = useSession();
  const canRead = permissions === undefined || permissions.includes(READ_INTEGRATION_PERMISSION);
  // A suspended tenant (READ_ONLY mode) is read-only for everyone, whatever the grants say.
  const canReplay = (permissions === undefined || permissions.includes(OPERATE_INTEGRATION_PERMISSION)) && mode !== 'READ_ONLY';
  const events = useInboxEvents(canRead);
  const replay = useReplayInboxEvent();
  const [filter, setFilter] = useState<'' | InboxStatus>('');
  const [replaying, setReplaying] = useState<string | undefined>(undefined);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState(false);
  const channelEvents = (events.data ?? []).filter((event) => event.channelAccountId !== null);
  const shown = filter === '' ? channelEvents : channelEvents.filter((event) => event.status === filter);
  const target = channelEvents.find((event) => event.id === replaying);
  const problem = replay.isError ? describeProblem(replay.error) : undefined;
  const state = useScreenState({ isLoading: events.isLoading, error: events.error ?? undefined, data: events.data, isEmpty: () => channelEvents.length === 0 });

  const confirm = (event: FormEvent): void => {
    event.preventDefault();
    if (target === undefined || replay.isPending) return;
    const trimmed = reason.trim();
    if (trimmed.length < REASON_MIN_LENGTH || trimmed.length > REASON_MAX_LENGTH) {
      setReasonError(true);
      return;
    }
    setReasonError(false);
    replay.mutate(
      { id: target.id, version: target.version, reason: trimmed },
      {
        onSuccess: () => {
          setReplaying(undefined);
          setReason('');
        },
      },
    );
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title" className="not-queue">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('omni.webhook.page.title')}</h1>
          <p>{t('omni.webhook.page.subtitle')}</p>
        </div>
      </div>
      <div className="card">
        <p className="sub">{t('omni.webhook.rule.text')}</p>
        <div className="filters">
          <div>
            <label htmlFor="webhook-status">{t('omni.webhook.filter.status.label')}</label>
            <select id="webhook-status" value={filter} onChange={(event) => setFilter(event.target.value as '' | InboxStatus)}>
              <option value="">{t('omni.webhook.filter.status.all')}</option>
              {INBOX_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {inboxStatusLabel(t, status)}
                </option>
              ))}
            </select>
          </div>
        </div>
        {problem === undefined ? null : (
          <p className="callout warning" role="alert" data-replay-problem>
            {problemMessage(t, problem)}
          </p>
        )}
        <StateBoundary state={canRead ? state : 'denied'} onRetry={() => void events.refetch()}>
          {shown.length === 0 ? (
            <p className="muted" data-no-match>
              {t('omni.webhook.events.none')}
            </p>
          ) : (
            <table>
              <caption className="sr-only">{t('omni.webhook.page.title')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('omni.webhook.col.provider')}</th>
                  <th scope="col">{t('omni.webhook.col.event')}</th>
                  <th scope="col">{t('omni.webhook.col.signature')}</th>
                  <th scope="col">{t('omni.webhook.col.received')}</th>
                  <th scope="col">{t('omni.webhook.col.status')}</th>
                  <th scope="col">{t('omni.webhook.col.attempts')}</th>
                  <th scope="col">{t('omni.webhook.col.error')}</th>
                  <th scope="col">{t('omni.webhook.col.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((event) => (
                  <tr key={event.id} data-event-id={event.id} data-status={event.status}>
                    <td>{event.provider}</td>
                    <td>
                      <code>{event.eventKey}</code>
                      {event.eventType === null ? null : <div className="sub">{event.eventType}</div>}
                    </td>
                    <td data-signature>
                      <StatusPill tone="success">{t('omni.webhook.signature.valid')}</StatusPill>
                    </td>
                    <td>{instantText(locale, event.receivedAt)}</td>
                    <td>
                      <span className={inboxStatusPill(event.status)}>{inboxStatusLabel(t, event.status)}</span>
                    </td>
                    <td>{event.attempts}</td>
                    <td>{event.errorCode ?? ''}</td>
                    <td>
                      {!canReplay || !(event.status === 'FAILED' || event.status === 'DEAD') ? null : mayReplay(event) ? (
                        <button type="button" onClick={() => (setReplaying(event.id), setReason(''), setReasonError(false))}>
                          {t('omni.webhook.replay.action')}
                        </button>
                      ) : (
                        <span className="sub" data-payload-gone>
                          {t('omni.webhook.replay.gone')}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </StateBoundary>
        {target === undefined ? null : (
          <form onSubmit={confirm} noValidate aria-label={t('omni.webhook.replay.form.aria')} className="card" data-replay-form>
            <h2>{t('omni.webhook.replay.title')}</h2>
            <p>
              <strong>{target.provider}</strong> · {target.eventType ?? target.eventKey} · {inboxStatusLabel(t, target.status)}
            </p>
            <p className="sub">{t('omni.webhook.replay.hint')}</p>
            <div className="field">
              <label htmlFor="webhook-reason">{t('omni.webhook.replay.reason.label')}</label>
              <textarea id="webhook-reason" value={reason} onChange={(event) => setReason(event.target.value)} />
              {reasonError ? (
                <small role="alert" className="field-error" data-reason-problem>
                  {t('omni.webhook.replay.reason.invalid')}
                </small>
              ) : null}
            </div>
            <div className="formfooter">
              <button type="submit" className="primary" disabled={replay.isPending}>
                {t('omni.webhook.replay.confirm.action')}
              </button>
              <button type="button" onClick={() => setReplaying(undefined)}>
                {t('omni.webhook.replay.cancel.action')}
              </button>
            </div>
          </form>
        )}
      </div>
    </section>
  );
}
