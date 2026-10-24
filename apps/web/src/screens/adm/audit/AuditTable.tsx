import { useTranslation } from '../../../i18n';
import { instantText } from './SealBanner';
import { outcomeLabel, outcomePill } from './labels';
import { shortHash } from './model';
import type { AuditEventView } from './model';

const SHORT_ID = 8;
const shortId = (id: string): string => id.slice(0, SHORT_ID);

function Behalf({ event }: { event: AuditEventView }) {
  const { t } = useTranslation();
  if (event.impersonatorId === null && event.onBehalfOfId === null) return <span className="muted">{t('adm.audit.behalf.none')}</span>;
  return (
    <>
      {event.impersonatorId === null ? null : <div title={event.impersonatorId}>{t('adm.audit.behalf.impersonator', { id: shortId(event.impersonatorId) })}</div>}
      {event.onBehalfOfId === null ? null : <div title={event.onBehalfOfId}>{t('adm.audit.behalf.onBehalf', { id: shortId(event.onBehalfOfId) })}</div>}
    </>
  );
}

/** The diff is shown as the server redacted it, and only on request: it is long and rarely what the person came for. */
function Diff({ event }: { event: AuditEventView }) {
  const { t } = useTranslation();
  if (event.safeDiff === null && event.reason === null) return null;
  return (
    <details className="diff-toggle">
      <summary>{t('adm.audit.diff.show.action')}</summary>
      {event.reason === null ? null : <p className="sub">{t('adm.audit.diff.reason.text', { reason: event.reason })}</p>}
      {event.safeDiff === null ? null : <pre className="diff">{JSON.stringify(event.safeDiff, null, 2)}</pre>}
    </details>
  );
}

/** The rows of the trail. The identities are the ids of memberships: the viewer never joins them to a name or an email. */
export function AuditTable({ events }: { events: readonly AuditEventView[] }) {
  const { t, locale } = useTranslation();
  return (
    <div className="tablewrap">
      <table>
        <thead>
          <tr>
            <th>{t('adm.audit.col.time')}</th>
            <th>{t('adm.audit.col.actor')}</th>
            <th>{t('adm.audit.col.action')}</th>
            <th>{t('adm.audit.col.resource')}</th>
            <th>{t('adm.audit.col.outcome')}</th>
            <th>{t('adm.audit.col.behalf')}</th>
            <th>{t('adm.audit.col.seal')}</th>
          </tr>
        </thead>
        <tbody>
          {events.map((event) => (
            <tr key={event.id} data-event-id={event.id} data-outcome={event.outcome}>
              <td>{instantText(locale, event.occurredAt)}</td>
              <td title={event.actorId}>{shortId(event.actorId)}</td>
              <td>
                <strong>{event.action}</strong>
                <Diff event={event} />
              </td>
              <td>
                {event.resourceType}
                <div className="sub" title={event.resourceId}>
                  {shortId(event.resourceId)}
                </div>
              </td>
              <td>
                <span className={outcomePill(event.outcome)}>{outcomeLabel(t, event.outcome)}</span>
              </td>
              <td>
                <Behalf event={event} />
              </td>
              <td>
                {event.sealHash === null ? (
                  <span className="muted" data-seal-hash="pending">
                    {t('adm.audit.seal.pending.text')}
                  </span>
                ) : (
                  <span className="hash" title={event.sealHash} data-seal-hash={event.sealHash}>
                    {shortHash(event.sealHash)}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
