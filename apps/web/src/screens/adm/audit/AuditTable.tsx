import { useTranslation } from '../../../i18n';
import { DataTable, StatusPill } from '../../../ui';
import type { DataTableColumn } from '../../../ui';
import { instantText } from './SealBanner';
import { outcomeLabel, outcomeTone } from './labels';
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
  const columns: DataTableColumn<AuditEventView>[] = [
    {
      key: 'time',
      header: t('adm.audit.col.time'),
      pinned: true,
      render: (event) => <span data-event-id={event.id} data-outcome={event.outcome}>{instantText(locale, event.occurredAt)}</span>,
    },
    { key: 'actor', header: t('adm.audit.col.actor'), render: (event) => <span title={event.actorId}>{shortId(event.actorId)}</span> },
    {
      key: 'action',
      header: t('adm.audit.col.action'),
      render: (event) => (
        <>
          <strong>{event.action}</strong>
          <Diff event={event} />
        </>
      ),
    },
    {
      key: 'resource',
      header: t('adm.audit.col.resource'),
      render: (event) => (
        <>
          {event.resourceType}
          <div className="sub" title={event.resourceId}>
            {shortId(event.resourceId)}
          </div>
        </>
      ),
    },
    { key: 'outcome', header: t('adm.audit.col.outcome'), render: (event) => <StatusPill tone={outcomeTone(event.outcome)}>{outcomeLabel(t, event.outcome)}</StatusPill> },
    { key: 'behalf', header: t('adm.audit.col.behalf'), render: (event) => <Behalf event={event} /> },
    {
      key: 'seal',
      header: t('adm.audit.col.seal'),
      render: (event) =>
        event.sealHash === null ? (
          <span className="muted" data-seal-hash="pending">
            {t('adm.audit.seal.pending.text')}
          </span>
        ) : (
          <span className="hash" title={event.sealHash} data-seal-hash={event.sealHash}>
            {shortHash(event.sealHash)}
          </span>
        ),
    },
  ];
  return <DataTable caption={t('w2adm.audit.table.caption')} columns={columns} rows={[...events]} rowKey={(event) => event.id} rowAttrs={(event) => ({ 'data-event-id': event.id, 'data-outcome': event.outcome })} />;
}
