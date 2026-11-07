import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import { routeById } from '../../routes/registry';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { FilterPanel, SectionCard } from '../../ui';
import { KitTable } from '../adm/KitTable';
import { useTenantList } from './tenants/hooks';
import { statusLabel } from './tenants/labels';
import { TenantRow } from './tenants/TenantRow';
import { MANAGE_TENANTS_PERMISSION, TENANT_STATUSES } from './tenants/types';
import type { TenantSummary } from './tenants/types';
import '../adm/adm-kit.css';
import './tenants/sas.css';

interface Filter {
  text: string;
  status: string;
}

const NO_FILTER: Filter = { text: '', status: '' };

const matches = (tenant: TenantSummary, filter: Filter): boolean =>
  (filter.status === '' || tenant.status === filter.status) &&
  (filter.text === '' || `${tenant.code} ${tenant.name}`.toLowerCase().includes(filter.text.toLowerCase()));

/** SAS-01: the registry of tenants of the control plane, with the provisioning run under every unsettled tenant. */
export default function TenantListScreen({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions } = useSession();
  const canManage = permissions === undefined || permissions.includes(MANAGE_TENANTS_PERMISSION);
  const list = useTenantList();
  const [draft, setDraft] = useState<Filter>(NO_FILTER);
  const [applied, setApplied] = useState<Filter>(NO_FILTER);
  const all = useMemo(() => list.data?.pages.flatMap((page) => page.items) ?? [], [list.data]);
  const shown = useMemo(() => all.filter((tenant) => matches(tenant, applied)), [all, applied]);
  const state = useScreenState({ isLoading: list.isLoading, error: list.error, data: list.data === undefined ? undefined : all });
  const create = routeById('SAS-02');

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setApplied(draft);
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('sas.tenants.page.title')}</h1>
          <p>{t('sas.tenants.page.subtitle')}</p>
        </div>
        {canManage && create !== undefined && state !== 'denied' && state !== 'signedOut' ? (
          <div className="actions">
            <Link className="ui-button ui-button--primary" to={create.path}>
              {t('sas.tenants.create.action')}
            </Link>
          </div>
        ) : null}
      </div>
      <StateBoundary state={state} onRetry={() => void list.refetch()}>
        <form className="adm-kit-form" onSubmit={submit} aria-label={t('sas.tenants.filter.action')}>
          <FilterPanel
            applied={[applied.text, applied.status].filter((value) => value !== '').length}
            actions={
              <button type="submit" className="ui-button ui-button--primary">
                {t('sas.tenants.filter.action')}
              </button>
            }
          >
            <div className="field">
              <label htmlFor="tenant-search">{t('sas.tenants.search.label')}</label>
              <input id="tenant-search" type="search" value={draft.text} placeholder={t('sas.tenants.search.placeholder')} onChange={(event) => setDraft({ ...draft, text: event.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="tenant-status">{t('sas.tenants.status.label')}</label>
              <select id="tenant-status" value={draft.status} onChange={(event) => setDraft({ ...draft, status: event.target.value })}>
                <option value="">{t('sas.tenants.status.all')}</option>
                {TENANT_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {statusLabel(t, status)}
                  </option>
                ))}
              </select>
            </div>
          </FilterPanel>
        </form>
        <SectionCard title={t('sas.tenants.page.title')}>
          <KitTable caption={t('w2sas.tenants.table.caption')}>
            <thead>
              <tr>
                <th>{t('sas.tenants.col.tenant')}</th>
                <th>{t('sas.tenants.col.plan')}</th>
                <th>{t('sas.tenants.col.isolation')}</th>
                <th>{t('sas.tenants.col.status')}</th>
                <th>{t('sas.tenants.col.license')}</th>
                <th>{t('ui.stickyActions.label')}</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((tenant) => (
                <TenantRow key={tenant.id} tenant={tenant} canManage={canManage} />
              ))}
            </tbody>
          </KitTable>
          {shown.length === 0 ? (
            <p className="adm-kit-empty" role="status">
              {t('sas.tenants.filtered.empty')}
            </p>
          ) : null}
          <div className="adm-kit-foot">
            <span>{t('sas.tenants.count.text', { count: shown.length })}</span>
            {list.hasNextPage ? (
              <button type="button" className="ui-button ui-button--outline ui-button--small" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
                {t('sas.tenants.more.action')}
              </button>
            ) : null}
          </div>
        </SectionCard>
      </StateBoundary>
      <p className="prototype-note">{t('sas.tenants.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
