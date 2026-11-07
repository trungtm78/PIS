import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../i18n';
import type { WebRoute } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { adapterLabel, cursorStatusLabel } from '../mdm/labels';
import type { CursorView } from '../mdm/model';
import { instantText } from './audit/SealBanner';
import { adapterTone } from './connectors/labels';
import { useReplayInboxEvent } from './inbox/hooks';
import { inboxStatusLabel, inboxStatusTone, problemMessage } from './inbox/labels';
import { INBOX_STATUSES, OPERATE_INTEGRATION_PERMISSION, REASON_MAX_LENGTH, REASON_MIN_LENGTH, describeProblem, mayReplay } from './inbox/model';
import type { InboxEventView, InboxStatus } from './inbox/model';
import { SectionCard, StatusPill } from '../../ui';
import { KitTable } from './KitTable';
import './adm-kit.css';
import './inbox/inbox.css';

export interface SyncMonitorWorkspaceProps {
  route: WebRoute;
  /** The positions of the connectors that read files for master data (the integration cursors of ST-MDM-007), with their adapter status. */
  cursors: readonly CursorView[];
  /** The events of the inbound inbox, newest first, without their payload. */
  events: readonly InboxEventView[];
}

/**
 * ADM-10: the sync monitor of the tenant (ST-ADM-018). It shows where each connector has read to and which inbound events wait, failed or
 * died, and lets an operator take a failed or dead event up again with a reason. The payload of an event is never shown and never edited.
 */
export function SyncMonitorWorkspace({ route, cursors, events }: SyncMonitorWorkspaceProps) {
  const tenantId = useSession().tenant?.id;
  // Everything the screen holds (the filter, the open replay, the reason) belongs to one tenant: a switch starts it over.
  return <WorkspaceContent key={tenantId ?? 'none'} route={route} cursors={cursors} events={events} />;
}

function WorkspaceContent({ route, cursors, events }: SyncMonitorWorkspaceProps) {
  const { t, locale } = useTranslation();
  const { permissions, mode } = useSession();
  // A suspended tenant (READ_ONLY mode) is read-only for everyone, whatever the grants say.
  const canOperate = (permissions === undefined || permissions.includes(OPERATE_INTEGRATION_PERMISSION)) && mode !== 'READ_ONLY';
  const replay = useReplayInboxEvent();
  const [filter, setFilter] = useState<'' | InboxStatus>('');
  const [replaying, setReplaying] = useState<string | undefined>(undefined);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState(false);
  const shown = useMemo(() => (filter === '' ? events : events.filter((event) => event.status === filter)), [events, filter]);
  const dead = events.filter((event) => event.status === 'DEAD').length;
  const target = events.find((event) => event.id === replaying);
  const problem = replay.isError ? describeProblem(replay.error) : undefined;

  const confirm = (event: FormEvent): void => {
    event.preventDefault();
    if (target === undefined) return;
    const trimmed = reason.trim();
    if (trimmed.length < REASON_MIN_LENGTH || trimmed.length > REASON_MAX_LENGTH) {
      setReasonError(true);
      return;
    }
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
    <section data-screen-id={route.id} aria-labelledby="screen-title" className="adm-sync">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('adm.sync.page.title')}</h1>
          <p>{t('adm.sync.page.subtitle')}</p>
        </div>
      </div>

      <SectionCard title={t('adm.sync.cursor.title')}>
        <div data-testid="cursors">
        {cursors.length === 0 ? <p className="muted">{t('adm.sync.cursor.empty')}</p> : null}
        {cursors.length === 0 ? null : (
          <KitTable caption={t('w2adm.sync.table.cursors')}>
              <thead>
                <tr>
                  <th>{t('adm.sync.cursor.col.connector')}</th>
                  <th>{t('adm.sync.cursor.col.adapter')}</th>
                  <th>{t('adm.sync.cursor.col.status')}</th>
                  <th>{t('adm.sync.cursor.col.lastSuccess')}</th>
                  <th>{t('adm.sync.cursor.col.error')}</th>
                </tr>
              </thead>
              <tbody>
                {cursors.map((cursor) => (
                  <tr key={cursor.id} data-cursor-id={cursor.id} data-adapter={cursor.adapterStatus}>
                    <td>
                      <code>{cursor.connectorCode}</code>
                      <div className="sub">{cursor.sourceScope}</div>
                    </td>
                    <td>
                      <StatusPill tone={adapterTone(cursor.adapterStatus)}>{adapterLabel(t, cursor.adapterStatus)}</StatusPill>
                    </td>
                    <td>{cursorStatusLabel(t, cursor.status)}</td>
                    <td>{cursor.lastSuccessAt === null ? t('adm.sync.cursor.never.text') : instantText(locale, cursor.lastSuccessAt)}</td>
                    <td>{cursor.lastErrorCode ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </KitTable>
        )}
        </div>
      </SectionCard>

      <SectionCard title={t('adm.sync.events.title')}>
        <div data-testid="events">
        <p className="sub">{t('adm.sync.events.hint')}</p>
        {dead === 0 ? null : (
          <p className="callout warning" role="status" data-testid="dead-note">
            {t('adm.sync.events.dead.note', { count: dead })}
          </p>
        )}
        {problem === undefined ? null : (
          <p className="callout warning" role="alert" data-testid="replay-problem">
            {problemMessage(t, problem)}
          </p>
        )}
        <div className="filters">
          <div>
            <label htmlFor="sync-status">{t('adm.sync.filter.status.label')}</label>
            <select id="sync-status" value={filter} onChange={(event) => setFilter(event.target.value as '' | InboxStatus)}>
              <option value="">{t('adm.sync.filter.status.all')}</option>
              {INBOX_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {inboxStatusLabel(t, status)}
                </option>
              ))}
            </select>
          </div>
        </div>
        {shown.length === 0 ? <p className="muted">{t('adm.sync.events.empty')}</p> : null}
        {shown.length === 0 ? null : (
          <KitTable caption={t('w2adm.sync.table.events')}>
              <thead>
                <tr>
                  <th>{t('adm.sync.events.col.event')}</th>
                  <th>{t('adm.sync.events.col.status')}</th>
                  <th>{t('adm.sync.events.col.attempts')}</th>
                  <th>{t('adm.sync.events.col.next')}</th>
                  <th>{t('adm.sync.events.col.error')}</th>
                  <th>{t('adm.sync.events.col.received')}</th>
                  <th>
                    {t('adm.sync.events.col.actions')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {shown.map((event) => (
                  <tr key={event.id} data-event-id={event.id} data-status={event.status}>
                    <td>
                      <strong>{event.provider}</strong>
                      <div className="sub">{event.eventType ?? event.eventKey}</div>
                    </td>
                    <td>
                      <StatusPill tone={inboxStatusTone(event.status)}>{inboxStatusLabel(t, event.status)}</StatusPill>
                      {event.replayCount === 0 ? null : <div className="sub">{t('adm.sync.events.replayed.text', { count: event.replayCount })}</div>}
                    </td>
                    <td>{event.attempts}</td>
                    <td>{event.nextAttemptAt === null ? '' : instantText(locale, event.nextAttemptAt)}</td>
                    <td>{event.errorCode ?? ''}</td>
                    <td>{instantText(locale, event.receivedAt)}</td>
                    <td className="row-actions">
                      {!canOperate || !(event.status === 'FAILED' || event.status === 'DEAD') ? null : mayReplay(event) ? (
                        <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => (setReplaying(event.id), setReason(''), setReasonError(false))}>
                          {t('adm.sync.replay.action')}
                        </button>
                      ) : (
                        <span className="sub" data-testid="payload-gone">
                          {t('adm.sync.replay.gone.hint')}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </KitTable>
        )}
        {target === undefined ? null : (
          <form className="replay-panel" onSubmit={confirm} aria-label={t('adm.sync.replay.title')} data-testid="replay-panel">
            <h3>{t('adm.sync.replay.title')}</h3>
            <p>
              <strong>{target.provider}</strong> · {target.eventType ?? target.eventKey} · {inboxStatusLabel(t, target.status)}
            </p>
            <p className="sub">{t('adm.sync.replay.hint')}</p>
            <div className="field" data-field="replay-reason">
              <label htmlFor="replay-reason">{t('adm.sync.replay.reason.label')}</label>
              <textarea id="replay-reason" value={reason} onChange={(event) => setReason(event.target.value)} />
              {reasonError ? (
                <small role="alert" className="field-error" id="replay-reason-error">
                  {t('adm.sync.replay.reason.error')}
                </small>
              ) : null}
            </div>
            <div className="adm-kit-actions">
              <button type="submit" className="ui-button ui-button--primary" disabled={replay.isPending}>
                {t('adm.sync.replay.confirm.action')}
              </button>
              <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => setReplaying(undefined)}>
                {t('adm.sync.replay.cancel.action')}
              </button>
            </div>
          </form>
        )}
        </div>
      </SectionCard>
      <p className="prototype-note">{t('adm.sync.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
