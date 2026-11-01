import { useTranslation } from '../../../i18n';
import type { Translator } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { isolationLabel, licenseLabel, statusLabel, statusTone, toneClass } from '../tenants/labels';
import { READ_TENANTS_PERMISSION } from '../tenants/types';
import { usePlatformHealth } from './hooks';
import { PENDING_INDICATORS } from './model';
import type { Count, PendingIndicator, PlatformHealth } from './model';

const holds = (permissions: readonly string[] | undefined, permission: string): boolean => permissions === undefined || permissions.includes(permission);

function pendingLabel(t: Translator['t'], indicator: PendingIndicator): string {
  switch (indicator) {
    case 'slo':
      return t('sas.health.pending.slo');
    case 'incidents':
      return t('sas.health.pending.incidents');
    case 'licenseLag':
      return t('sas.health.pending.licenseLag');
    case 'outboxAge':
      return t('sas.health.pending.outboxAge');
    case 'failedInbox':
      return t('sas.health.pending.failedInbox');
  }
}

/**
 * SAS-18: the health of the platform (ST-SAS-021, FR-SAS-18, UI-SAS-18). A platform operator sees how many tenants are in each state of their life, where they are placed, how their licences stand, and the registry by tenant code: the
 * operational side only, never a tenant's name, people or business data. The indicators the API does not report yet (SLO, incidents, licence propagation lag, outbox age, failed inbox) are listed as such, not shown as zero.
 */
export default function HealthScreen({ route }: ScreenProps) {
  const tenant = useSession().tenant;
  // What is read belongs to one member of the control plane: a switch starts the screen over.
  return <HealthContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function HealthContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions } = useSession();
  const allowed = holds(permissions, READ_TENANTS_PERMISSION);
  const health = usePlatformHealth(allowed);
  const state = useScreenState({ isLoading: health.isLoading, error: health.error, data: health.data, isEmpty: (data) => (data as PlatformHealth).tenants === 0 });
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('sas.health.page.title')}</h1>
          <p>{t('sas.health.page.subtitle')}</p>
        </div>
        {allowed ? (
          <div className="actions">
            <button type="button" onClick={() => void health.refetch()} disabled={health.isFetching}>
              {t('sas.health.refresh.action')}
            </button>
          </div>
        ) : null}
      </div>
      {allowed ? (
        <StateBoundary state={state} onRetry={() => void health.refetch()}>
          {health.data === undefined ? null : <Dashboard health={health.data} readAt={health.dataUpdatedAt} />}
        </StateBoundary>
      ) : (
        <div data-testid="health-denied">
          <StateBoundary state="denied" />
        </div>
      )}
      <p className="prototype-note">{t('sas.health.footer', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function Tiles({ title, counts, label }: { title: string; counts: Count[]; label: (key: string) => string }) {
  return (
    <section className="card" aria-label={title}>
      <h2>{title}</h2>
      <ul>
        {counts.map((entry) => (
          <li key={entry.key} className="item" data-key={entry.key}>
            <span>{label(entry.key)}</span> <strong>{entry.count}</strong>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Dashboard({ health, readAt }: { health: PlatformHealth; readAt: number }) {
  const { t } = useTranslation();
  return (
    <>
      <div className="grid" data-testid="health-tiles">
        <div className="card metric" data-testid="health-tenants">
          <span className="sub">{t('sas.health.tenants.label')}</span>
          <div className="value">{health.tenants}</div>
        </div>
        <div className="card metric" data-testid="health-attention">
          <span className="sub">{t('sas.health.attention.label')}</span>
          <div className="value">{health.attention}</div>
          <span className="change">{t('sas.health.attention.hint')}</span>
        </div>
      </div>
      <p className="sub" data-testid="health-readat">
        {t('sas.health.readat.text', { time: new Date(readAt).toLocaleString('vi-VN') })}
      </p>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }}>
        <Tiles title={t('sas.health.status.title')} counts={health.byStatus} label={(key) => statusLabel(t, key)} />
        <Tiles title={t('sas.health.placement.title')} counts={health.byPlacement} label={(key) => isolationLabel(t, key)} />
        <Tiles title={t('sas.health.license.title')} counts={health.byLicense} label={(key) => licenseLabel(t, key === '' ? undefined : key)} />
      </div>
      <section className="card" aria-label={t('sas.health.pending.title')} data-testid="health-pending">
        <h2>{t('sas.health.pending.title')}</h2>
        <p className="sub">{t('sas.health.pending.note')}</p>
        <ul>
          {PENDING_INDICATORS.map((indicator) => (
            <li key={indicator} data-indicator={indicator}>
              {pendingLabel(t, indicator)}
            </li>
          ))}
        </ul>
      </section>
      <section className="card" aria-label={t('sas.health.table.title')}>
        <h2>{t('sas.health.table.title')}</h2>
        <div className="tablewrap">
          <table className="table" aria-label={t('sas.health.table.title')}>
            <thead>
              <tr>
                <th scope="col">{t('sas.health.column.code')}</th>
                <th scope="col">{t('sas.health.column.status')}</th>
                <th scope="col">{t('sas.health.column.placement')}</th>
                <th scope="col">{t('sas.health.column.plan')}</th>
                <th scope="col">{t('sas.health.column.license')}</th>
              </tr>
            </thead>
            <tbody>
              {health.rows.map((row) => (
                <tr key={row.id} data-tenant-code={row.code}>
                  <th scope="row">{row.code}</th>
                  <td>
                    <span className={toneClass(statusTone(row.status))}>{statusLabel(t, row.status)}</span>
                  </td>
                  <td>{isolationLabel(t, row.isolationMode)}</td>
                  <td>{row.planCode ?? t('sas.tenants.none')}</td>
                  <td>{licenseLabel(t, row.licenseStatus)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
