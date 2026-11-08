import { useTranslation } from '../../i18n';
import { DataTable, SectionCard, StatusPill } from '../../ui';
import type { DataTableColumn } from '../../ui';
import { statusTone, word } from './model';
import type { Summary } from './model';

type Acceptance = Summary['acceptance'];

/** The status and the acceptance in words, without the test ids of the catalogue above (the same word is not claimed twice by one screen). */
function Words({ status, acceptance }: { status?: Summary['status']; acceptance?: Acceptance }) {
  const { t } = useTranslation();
  return (
    <>
      {status === undefined ? null : <StatusPill tone={statusTone(status)}>{t(`hub.status.${word(status)}`)}</StatusPill>}
      {acceptance === undefined || acceptance === 'NOT_APPLICABLE' ? null : <StatusPill tone={acceptance === 'PENDING_EXTERNAL' ? 'warning' : 'success'}>{t(`hub.acceptance.${word(acceptance)}`)}</StatusPill>}
    </>
  );
}

/**
 * The registry of the connectors (HUB-2): beside the status of each connection, what its descriptor says: the way the data moves, the layouts with their version and whether the other side has confirmed them, the
 * freshness policy in force, the credential it needs, who reads it, the alerts it can raise, who owns its switch and where its history lives. A connection that is not in this list is not managed by the hub.
 */
export function RegistrySection({ items }: { items: Summary[] }) {
  const { t } = useTranslation();
  const columns: DataTableColumn<Summary>[] = [
    {
      key: 'connector',
      header: t('hub.reg.col.connector'),
      pinned: true,
      render: (row) => (
        <>
          <strong>{row.code}</strong>
          <div>
            <Words status={row.status} acceptance={row.acceptance} />
          </div>
        </>
      ),
    },
    {
      key: 'transport',
      header: t('hub.reg.col.transport'),
      render: (row) => (row.registry === undefined ? '–' : row.registry.transports.map((transport) => t(`hub.reg.transport.${word(transport)}`)).join(', ')),
    },
    {
      key: 'layouts',
      header: t('hub.reg.col.layouts'),
      render: (row) =>
        row.registry === undefined || row.registry.layouts.length === 0 ? (
          <span className="hub-muted">{t('hub.reg.layouts.none')}</span>
        ) : (
          row.registry.layouts.map((layout) => (
            <div key={`${layout.code}@${layout.version}`}>
              {layout.code} @ {layout.version} <Words acceptance={layout.acceptance} />
            </div>
          ))
        ),
    },
    {
      key: 'freshness',
      header: t('hub.reg.col.freshness'),
      render: (row) =>
        row.registry === undefined || row.registry.freshness_rule === null || row.registry.max_age_hours === null ? (
          <span className="hub-muted">{t('hub.reg.freshness.none')}</span>
        ) : (
          <>
            {t('hub.reg.freshness.line', { rule: row.registry.freshness_rule, warn: row.registry.warn_after_hours ?? 0, max: row.registry.max_age_hours })}
            <div className="hub-muted">{t(`hub.reg.ruleSource.${word(row.registry.rule_source)}`)}</div>
          </>
        ),
    },
    {
      key: 'credential',
      header: t('hub.reg.col.credential'),
      render: (row) =>
        row.registry === undefined ? '–' : (
          <>
            {t(`hub.reg.credential.${word(row.registry.credential_kind)}`)}
            {row.registry.scopes.length === 0 ? null : <div className="hub-muted">{t('hub.reg.scopes', { count: row.registry.scopes.length })}</div>}
          </>
        ),
    },
    { key: 'consumers', header: t('hub.reg.col.consumers'), render: (row) => row.consumers.join(', ') },
    { key: 'alerts', header: t('hub.reg.col.alerts'), render: (row) => (row.registry === undefined ? '–' : row.registry.alert_types.join(', ')) },
    {
      key: 'egress',
      header: t('hub.reg.col.egress'),
      render: (row) => t(`hub.reg.egress.${word(row.egress_policy)}`),
    },
    {
      key: 'ownership',
      header: t('hub.reg.col.ownership'),
      render: (row) =>
        row.registry === undefined ? (
          '–'
        ) : (
          <>
            {t(`hub.reg.switch.${word(row.registry.state_owner)}`)}
            <div className="hub-muted">{t(`hub.reg.history.${word(row.registry.history)}`)}</div>
          </>
        ),
    },
  ];
  return (
    <SectionCard title={t('hub.reg.section')} status={<span className="hub-muted">{t('hub.reg.count', { count: items.length })}</span>}>
      <DataTable caption={t('hub.reg.table.caption')} columns={columns} rows={items} rowKey={(row) => row.code} />
    </SectionCard>
  );
}
