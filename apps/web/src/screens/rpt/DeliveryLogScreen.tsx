import { useState } from 'react';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { ContextBar, DataTable, StatusPill } from '../../ui';
import type { DataTableColumn } from '../../ui';
import { HashLine } from './components';
import { useDeliveries } from './hooks';
import { statusWord, vietnamDateTime } from './model';
import type { Delivery } from './model';
import './rpt.css';

/**
 * RPT-04, the log of what happened when issued copies went to receivers (RPT-1 part 2, R17, R18): when, which form, period and revision, to whom, by which channel, what happened (delivered, accepted, returned), the reference,
 * who recorded it and whether it counts as accepted. The log only grows; a copy made on a DEMO form is delivered but is never one that counts as accepted, and the line says so.
 */
export default function DeliveryLogScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <DeliveryLogContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function DeliveryLogContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { tenant } = useSession();
  const [receiver, setReceiver] = useState('');
  const query = useDeliveries(undefined, receiver === '' ? undefined : receiver);
  const data = query.data;
  const state = useScreenState({ isLoading: query.isLoading, error: data === undefined ? query.error : undefined, data, isEmpty: (value) => (value as { items: unknown[] }).items.length === 0 });

  const columns: DataTableColumn<Delivery>[] = [
    { key: 'when', header: t('rpt.log.col.when'), pinned: true, render: (row) => vietnamDateTime(row.occurred_at) },
    { key: 'form', header: t('rpt.log.col.form'), render: (row) => <strong>{row.layout_code}</strong> },
    { key: 'period', header: t('rpt.log.col.period'), render: (row) => row.period_code },
    { key: 'revision', header: t('rpt.log.col.revision'), render: (row) => row.revision },
    { key: 'receiver', header: t('rpt.log.col.receiver'), render: (row) => row.receiver },
    { key: 'channel', header: t('rpt.log.col.channel'), render: (row) => t(`rpt.common.channel.${statusWord(row.channel)}`) },
    {
      key: 'event',
      header: t('rpt.log.col.event'),
      render: (row) => <StatusPill tone={row.event === 'ACCEPTED' ? 'success' : row.event === 'REJECTED' ? 'danger' : 'info'}>{t(`rpt.common.event.${statusWord(row.event)}`)}</StatusPill>,
    },
    { key: 'reference', header: t('rpt.log.col.reference'), render: (row) => row.reference ?? '–' },
    { key: 'by', header: t('rpt.log.col.by'), render: (row) => row.recorded_by_name ?? '–' },
    { key: 'counts', header: t('rpt.log.col.counts'), render: (row) => (row.counts_as_accepted ? t('rpt.log.counts.yes') : t('rpt.log.counts.no')) },
    { key: 'hash', header: t('rpt.log.col.hash'), render: (row) => <HashLine sha={row.sha256} /> },
  ];

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('rpt.log.page.title')}</h1>
          <p>{t('rpt.log.page.subtitle')}</p>
        </div>
      </div>
      <ContextBar items={[{ label: t('rpt.log.context.scope'), value: tenant?.name ?? '–' }]} {...(data === undefined ? {} : { asOf: vietnamDateTime(data.as_of) })} stale={query.isError && data !== undefined} />
      <label className="rpt-filter">
        {t('rpt.log.filter.receiver')}{' '}
        <input type="text" maxLength={60} value={receiver} data-testid="filter-receiver" onChange={(event) => setReceiver(event.target.value.trim())} />
      </label>
      <StateBoundary state={state} onRetry={() => void query.refetch()}>
        {data !== undefined && (
          <>
            <DataTable caption={t('rpt.log.table.caption')} columns={columns} rows={data.items as Delivery[]} rowKey={(row) => row.id} />
            {data.truncated ? (
              <p className="callout" role="status">
                {t('rpt.common.list.truncated')}
              </p>
            ) : null}
          </>
        )}
      </StateBoundary>
      <p className="prototype-note">{t('rpt.common.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
