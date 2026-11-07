import { useEffect, useState } from 'react';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { useEntitlements } from '../sas/tenants/hooks';
import { featureLabel, modeLabel, modeTone, toneClass } from '../sas/tenants/labels';
import { PermissionChips } from './effective-access/PermissionChips';
import { GrantCard } from './effective-access/GrantCard';
import { useEffectiveAccess } from './effective-access/hooks';
import { dayOf, scopeLabel, stateLabel, statePill } from './effective-access/labels';
import { NO_FILTER, filterGrants, groupGrants, isScopeKind, isStale, permissionRows, summaryOf } from './effective-access/model';
import type { GrantFilter } from './effective-access/model';
import { SCOPE_KINDS } from './effective-access/types';
import type { AccessGrant, EffectiveAccessView } from './effective-access/types';
import { KitTable } from '../adm/KitTable';
import '../adm/adm-kit.css';
import '../sas/tenants/sas.css';
import { SectionCard, StatusPill } from '../../ui';
import { toneOfPill } from '../adm/kit-tone';

function GrantSection({ title, grants, emptyText }: { title: string; grants: readonly AccessGrant[]; emptyText: string }) {
  return (
    <section aria-label={title} data-grant-section>
      <h3>
        {title} <StatusPill tone="neutral">{grants.length}</StatusPill>
      </h3>
      {grants.length === 0 ? <p className="muted tiny">{emptyText}</p> : grants.map((grant) => <GrantCard key={grant.id} grant={grant} />)}
    </section>
  );
}

/**
 * IAM-09: what the signed-in person may do, and where. Their own grants with the units, projects and contracts the scopes
 * name, the permissions those grants give and the role each comes from, the delegations they received, and what their plan
 * allows. Nothing of anyone else is on this page: the server answers for the caller only. The server still decides every
 * request; this is the explanation. When a newer reading shows another scope version a banner offers to reload, so the
 * person never works from an explanation that is out of date without knowing it.
 */
export default function EffectiveAccessScreen({ route }: ScreenProps) {
  const { t } = useTranslation();
  const query = useEffectiveAccess();
  const plan = useEntitlements(undefined, true);
  const { tenant } = useSession();
  // The reading on screen belongs to one tenant and membership: after a switch it is not shown, whatever its scope version.
  const owner = `${tenant?.id ?? ''}/${tenant?.membershipId ?? ''}`;
  const [pinned, setPinned] = useState<{ owner: string; view: EffectiveAccessView } | undefined>(undefined);
  const shown = pinned?.owner === owner ? pinned.view : undefined;
  const [filter, setFilter] = useState<GrantFilter>(NO_FILTER);
  // The first reading is the one on screen. A later one replaces it by itself only when the scope version is the same
  // (the grants did not change; their states move with the clock: a grant starts or ends). Another scope version means
  // the access was changed, and then the person decides when to reload (the banner).
  useEffect(() => {
    const latest = query.data;
    if (latest === undefined || latest === shown) return;
    if (shown === undefined || shown.scopeVersion === latest.scopeVersion) setPinned({ owner, view: latest });
  }, [owner, shown, query.data]);

  const access = shown ?? query.data;
  const state = useScreenState({
    isLoading: query.isLoading,
    error: query.error ?? undefined,
    data: access,
    isEmpty: (data) => (data as EffectiveAccessView).grants.length === 0 && (data as EffectiveAccessView).delegations.length === 0,
  });
  const stale = isStale(shown?.scopeVersion, query.data?.scopeVersion);
  const groups = groupGrants(filterGrants(access?.grants ?? [], filter));
  const summary = access === undefined ? undefined : summaryOf(access);
  const rows = access === undefined ? [] : permissionRows(access.grants, access.delegations);
  const features = plan.data?.features.filter((feature) => feature.allowed) ?? [];

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('iam.effectiveAccess.page.title')}</h1>
          <p>{t('iam.effectiveAccess.page.subtitle')}</p>
        </div>
      </div>
      {stale ? (
        <div className="callout warning" role="status" data-stale-banner>
          <span>{t('iam.effectiveAccess.stale.banner')}</span>{' '}
          <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => (query.data === undefined ? undefined : setPinned({ owner, view: query.data }))}>
            {t('iam.effectiveAccess.stale.reload')}
          </button>
        </div>
      ) : null}
      <div className="two">
        <SectionCard title={t('iam.effectiveAccess.card.title')}>
          <StateBoundary state={state} onRetry={() => void query.refetch()}>
            {access === undefined || summary === undefined ? null : (
              <>
                <dl className="kv">
                  <div className="row between">
                    <dt>{t('iam.effectiveAccess.summary.role.label')}</dt>
                    <dd>{t('iam.effectiveAccess.summary.role.value', { count: summary.activeRoles })}</dd>
                  </div>
                  <div className="row between">
                    <dt>{t('iam.effectiveAccess.summary.scope.label')}</dt>
                    <dd>{t('iam.effectiveAccess.summary.scope.value', { count: summary.scopes })}</dd>
                  </div>
                  <div className="row between">
                    <dt>{t('iam.effectiveAccess.summary.validity.label')}</dt>
                    <dd>{summary.endedOrPending === 0 ? t('iam.effectiveAccess.summary.validity.none') : t('iam.effectiveAccess.summary.validity.value', { count: summary.endedOrPending })}</dd>
                  </div>
                  <div className="row between">
                    <dt>{t('iam.effectiveAccess.summary.delegations.label')}</dt>
                    <dd>{t('iam.effectiveAccess.summary.delegations.value', { count: summary.delegations })}</dd>
                  </div>
                  <div className="row between">
                    <dt>{t('iam.effectiveAccess.summary.plan.label')}</dt>
                    <dd>{plan.data === undefined ? t('iam.effectiveAccess.summary.plan.unavailable') : t('iam.effectiveAccess.summary.plan.value', { count: features.length })}</dd>
                  </div>
                </dl>

                <div className="filters">
                  <div>
                    <label htmlFor="access-filter-permission">{t('iam.effectiveAccess.filter.permission.label')}</label>
                    <input id="access-filter-permission" type="search" value={filter.permission} onChange={(event) => setFilter({ ...filter, permission: event.target.value })} />
                  </div>
                  <div>
                    <label htmlFor="access-filter-scope">{t('iam.effectiveAccess.filter.scope.label')}</label>
                    <select
                      id="access-filter-scope"
                      value={filter.scope}
                      onChange={(event) => setFilter({ ...filter, scope: isScopeKind(event.target.value) ? event.target.value : 'ALL' })}
                    >
                      <option value="ALL">{t('iam.effectiveAccess.filter.scope.all')}</option>
                      {SCOPE_KINDS.map((kind) => (
                        <option key={kind} value={kind}>
                          {scopeLabel(t, kind)}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <GrantSection title={t('iam.effectiveAccess.section.active')} grants={groups.active} emptyText={t('iam.effectiveAccess.section.empty')} />
                <GrantSection title={t('iam.effectiveAccess.section.future')} grants={groups.future} emptyText={t('iam.effectiveAccess.section.empty')} />
                <GrantSection title={t('iam.effectiveAccess.section.expired')} grants={groups.expired} emptyText={t('iam.effectiveAccess.section.empty')} />

                <section aria-label={t('iam.effectiveAccess.permissions.title')}>
                  <h3>{t('iam.effectiveAccess.permissions.title')}</h3>
                  {rows.length === 0 ? (
                    <p className="muted tiny">{t('iam.effectiveAccess.permissions.empty')}</p>
                  ) : (
                    <KitTable caption={t('w2iam.effectiveAccess.table.permissions')}>
                        <thead>
                          <tr>
                            <th>{t('iam.effectiveAccess.permissions.col.permission')}</th>
                            <th>{t('iam.effectiveAccess.permissions.col.source')}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map((row) => (
                            <tr key={row.permission} data-permission={row.permission}>
                              <td>
                                <code>{row.permission}</code>
                              </td>
                              <td>{[...row.roles, ...(row.delegated ? [t('iam.effectiveAccess.permissions.delegated')] : [])].join(', ')}</td>
                            </tr>
                          ))}
                        </tbody>
                      </KitTable>
                  )}
                </section>

                <section aria-label={t('iam.effectiveAccess.delegations.title')}>
                  <h3>{t('iam.effectiveAccess.delegations.title')}</h3>
                  {access.delegations.length === 0 ? (
                    <p className="muted tiny">{t('iam.effectiveAccess.delegations.empty')}</p>
                  ) : (
                    <KitTable caption={t('w2iam.effectiveAccess.table.delegations')}>
                        <thead>
                          <tr>
                            <th>{t('iam.effectiveAccess.delegations.col.permissions')}</th>
                            <th>{t('iam.effectiveAccess.delegations.col.window')}</th>
                            <th>{t('iam.effectiveAccess.delegations.col.state')}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {access.delegations.map((delegation) => (
                            <tr key={delegation.id} data-delegation-state={delegation.state}>
                              <td>
                                <PermissionChips permissions={delegation.permissions} />
                              </td>
                              <td>
                                {dayOf(delegation.validFrom)} → {dayOf(delegation.validUntil)}
                              </td>
                              <td>
                                <StatusPill tone={toneOfPill(statePill(delegation.state))}>{stateLabel(t, delegation.state)}</StatusPill>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </KitTable>
                  )}
                </section>
              </>
            )}
          </StateBoundary>
        </SectionCard>
        <SectionCard title={t('iam.effectiveAccess.plan.title')}>
          <div data-plan-card>
          {plan.isLoading ? (
            <p className="muted tiny" role="status">
              {t('iam.effectiveAccess.plan.loading')}
            </p>
          ) : plan.error !== null && plan.error !== undefined ? (
            <p className="callout warning" role="alert">
              {t('iam.effectiveAccess.plan.error')}{' '}
              <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => void plan.refetch()}>
                {t('states.retry.action')}
              </button>
            </p>
          ) : features.length === 0 ? (
            <p className="muted tiny">{t('iam.effectiveAccess.plan.empty')}</p>
          ) : (
            <ul className="plain">
              {features.map((feature) => (
                <li key={feature.featureCode} className="row between" data-feature={feature.featureCode}>
                  <span>{featureLabel(t, feature.featureCode)}</span>
                  <StatusPill tone={toneOfPill(toneClass(modeTone(feature.mode)))}>{modeLabel(t, feature.mode)}</StatusPill>
                </li>
              ))}
            </ul>
          )}
          {access?.entitlementHash === undefined ? null : (
            <p className="tiny muted">
              {t('iam.effectiveAccess.plan.hash')}: <code>{access.entitlementHash}</code>
            </p>
          )}
          </div>
        </SectionCard>
      </div>
      <p className="prototype-note">{t('iam.effectiveAccess.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
