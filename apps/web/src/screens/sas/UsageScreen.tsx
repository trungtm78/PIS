import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { useTenantList } from './tenants/hooks';
import { toneClass } from './tenants/labels';
import { useUsage } from './usage/hooks';
import { counterLabel, levelLabel, levelTone, unitLabel } from './usage/labels';
import { READ_TENANT_USAGE_PERMISSION, levelOf, shareOf } from './usage/model';
import type { SeatRow } from './usage/model';
import { SectionCard, StatusPill } from '../../ui';
import { KitTable } from '../adm/KitTable';
import '../adm/adm-kit.css';
import './tenants/sas.css';
import './usage/usage.css';
import { toneOfPill } from '../adm/kit-tone';

/**
 * SAS-11: what a tenant used this month against its limits. The control plane (the Billing Operator, the System Admin) picks a tenant and also sees the
 * latest events the counters were made of; the tenant plane sees its own counters and seats. Each counter says in words where it stands (fine, near,
 * full, over) next to its numbers, and a counter without a limit says so: it is only reported.
 */
export default function UsageScreen({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { permissions } = useSession();
  const [params, setParams] = useSearchParams();
  const control = permissions?.includes(READ_TENANT_USAGE_PERMISSION) === true;
  const tenants = useTenantList(control);
  const loaded = useMemo(() => tenants.data?.pages.flatMap((page) => page.items) ?? [], [tenants.data]);
  const chosen = control ? (params.get('tenant') ?? loaded[0]?.id) : undefined;
  // A tenant named in the address may lie beyond the pages loaded so far: it still has an option, so the select shows what is read.
  const options = chosen !== undefined && !loaded.some((tenant) => tenant.id === chosen) ? [...loaded, { id: chosen, name: chosen, code: '' }] : loaded;
  // The control plane has no usage of its own: it waits until it knows which tenant to read.
  const usage = useUsage(chosen, !control || chosen !== undefined);
  const waitingForTenants = control && chosen === undefined && tenants.isLoading;
  const state = useScreenState({
    isLoading: usage.isLoading || waitingForTenants,
    error: control && chosen === undefined ? tenants.error : usage.error,
    data: control && chosen === undefined ? undefined : usage.data,
    isEmpty: (data) => (data as { meters: unknown[] }).meters.length === 0,
  });
  const date = (value: string): string => new Date(value).toLocaleDateString(locale, { timeZone: 'UTC' });
  const data = usage.data;

  const seatRow = (key: string, label: string, seat: SeatRow) => {
    const level = levelOf(seat.used, seat.limit);
    const share = shareOf(seat.used, seat.limit);
    return (
      <tr key={key} data-seat={key} data-level={level}>
        <td>
          <b>{label}</b>
        </td>
        <td>{seat.used}</td>
        <td>{seat.limit ?? t('sas.usage.limit.none')}</td>
        <td>
          <StatusPill tone={toneOfPill(toneClass(levelTone(level)))}>{levelLabel(t, level)}</StatusPill>
          {share === undefined ? null : <small className="sub"> {t('sas.usage.share.text', { percent: share })}</small>}
        </td>
      </tr>
    );
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title" className="sas-usage">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('sas.usage.page.title')}</h1>
          <p>{t('sas.usage.page.subtitle')}</p>
        </div>
      </div>
      {control ? (
        // Outside the state boundary: an empty or failed read never takes the way to another tenant with it.
        <div className="card">
          <div className="filters">
            <div>
              <label htmlFor="usage-tenant">{t('sas.usage.tenant.label')}</label>
              <select id="usage-tenant" value={chosen ?? ''} onChange={(event) => setParams({ tenant: event.target.value })}>
                {options.map((tenant) => (
                  <option key={tenant.id} value={tenant.id}>
                    {tenant.code === '' ? tenant.name : `${tenant.name} (${tenant.code})`}
                  </option>
                ))}
              </select>
              {tenants.hasNextPage ? (
                <button type="button" disabled={tenants.isFetchingNextPage} onClick={() => void tenants.fetchNextPage()}>
                  {t('sas.usage.tenant.more.action')}
                </button>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
      <StateBoundary state={state} onRetry={() => void (control && chosen === undefined ? tenants.refetch() : usage.refetch())}>
        {data === undefined ? null : (
          <>
            <SectionCard title={t('sas.usage.meters.title')}>
              <p className="sub" data-window-start={data.windowStart}>
                {t('sas.usage.window.text', { from: date(data.windowStart), until: date(new Date(new Date(data.windowEnd).getTime() - 1).toISOString()) })}
              </p>
                <KitTable caption={t('w2sas.usage.table.meters')} aria-label={t('sas.usage.meters.title')}>
                  <thead>
                    <tr>
                      <th>{t('sas.usage.col.meter')}</th>
                      <th>{t('sas.usage.col.unit')}</th>
                      <th>{t('sas.usage.col.used')}</th>
                      <th>{t('sas.usage.col.limit')}</th>
                      <th>{t('sas.usage.col.level')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.meters.map((meter) => {
                      const level = levelOf(meter.used, meter.limit);
                      const share = shareOf(meter.used, meter.limit);
                      return (
                        <tr key={meter.counter} data-counter={meter.counter} data-level={level}>
                          <td>
                            <b>{counterLabel(t, meter.counter)}</b>
                            <div className="sub">{meter.counter}</div>
                          </td>
                          <td>{unitLabel(t, meter.unit)}</td>
                          <td>{meter.used}</td>
                          <td>{meter.limit ?? t('sas.usage.limit.none')}</td>
                          <td>
                            <StatusPill tone={toneOfPill(toneClass(levelTone(level)))}>{levelLabel(t, level)}</StatusPill>
                            {share === undefined ? null : <small className="sub"> {t('sas.usage.share.text', { percent: share })}</small>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </KitTable>
            </SectionCard>
            <SectionCard title={t('sas.usage.seats.title')}>
                <KitTable caption={t('w2sas.usage.table.seats')} aria-label={t('sas.usage.seats.title')}>
                  <thead>
                    <tr>
                      <th>{t('sas.usage.col.seats')}</th>
                      <th>{t('sas.usage.col.used')}</th>
                      <th>{t('sas.usage.col.limit')}</th>
                      <th>{t('sas.usage.col.level')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {seatRow('staff', t('sas.usage.seats.staff'), data.seats)}
                    {seatRow('guests', t('sas.usage.seats.guests'), data.guestSeats)}
                  </tbody>
                </KitTable>
              <p className="sub">{t('sas.usage.seats.note')}</p>
            </SectionCard>
            {data.recentEvents === undefined ? null : (
              <SectionCard title={t('sas.usage.events.title')}>
                {data.recentEvents.length === 0 ? (
                  <p className="sub" role="status">
                    {t('sas.usage.events.empty')}
                  </p>
                ) : (
                    <KitTable caption={t('w2sas.usage.table.events')} aria-label={t('sas.usage.events.title')}>
                      <thead>
                        <tr>
                          <th>{t('sas.usage.col.occurred')}</th>
                          <th>{t('sas.usage.col.meter')}</th>
                          <th>{t('sas.usage.col.quantity')}</th>
                          <th>{t('sas.usage.col.source')}</th>
                          <th>{t('sas.usage.col.key')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.recentEvents.map((event) => (
                          <tr key={event.id} data-event-id={event.id}>
                            <td>{new Date(event.occurredAt).toLocaleString(locale, { timeZone: 'UTC' })}</td>
                            <td>{event.meter}</td>
                            <td>
                              {event.quantity} {unitLabel(t, event.unit)}
                            </td>
                            <td>{event.sourceReference}</td>
                            <td>
                              <code>{event.externalEventKey}</code>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </KitTable>
                )}
              </SectionCard>
            )}
          </>
        )}
      </StateBoundary>
      <p className="prototype-note">{t('sas.usage.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
