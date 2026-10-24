import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { useTypePolicies } from './hooks';
import { scopeExplanation, scopeLabel } from './labels';
import './mdm.css';
import type { TypeScope } from './model';

const SCOPES: readonly TypeScope[] = ['PLATFORM_ONLY', 'PLATFORM_WITH_TENANT_EXTENSION', 'TENANT_ONLY'];

/** MDM-33: which catalogue types the platform publishes, which a tenant may extend and which it owns; read-only, the control plane sets the policy (ST-MDM-002). */
export default function MasterScopeScreen({ route }: ScreenProps) {
  const tenantId = useSession().tenant?.id;
  return <MasterScopeContent key={tenantId ?? 'none'} route={route} />;
}

function MasterScopeContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const policies = useTypePolicies();
  const state = useScreenState({ isLoading: policies.isLoading, error: policies.error, data: policies.data });
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('mdm.scope.page.title')}</h1>
          <p>{t('mdm.scope.page.subtitle')}</p>
        </div>
      </div>
      <StateBoundary state={state} onRetry={() => void policies.refetch()}>
        <div className="card">
          <table className="table">
            <thead>
              <tr>
                <th>{t('mdm.scope.col.type')}</th>
                <th>{t('mdm.scope.col.platform')}</th>
                <th>{t('mdm.scope.col.tenant')}</th>
                <th>{t('mdm.scope.col.policy')}</th>
              </tr>
            </thead>
            <tbody>
              {(policies.data ?? []).map((policy) => (
                <tr key={policy.masterType} data-master-type={policy.masterType} data-scope={policy.scope}>
                  <td>
                    <strong>{policy.masterType}</strong>
                  </td>
                  <td>{policy.platformRecords}</td>
                  <td>{policy.tenantRecords}</td>
                  <td>
                    <span className={policy.locked ? 'pill gray' : 'pill'} data-testid="scope">
                      {scopeLabel(t, policy.scope)}
                    </span>
                    {policy.locked ? <span className="pill gray">{t('mdm.scope.locked.pill')}</span> : null}
                    {policy.retireRequiresSuccessor ? <span className="pill gray">{t('mdm.scope.successor.pill')}</span> : null}
                    {policy.source === 'TENANT' ? <span className="pill">{t('mdm.scope.override.pill')}</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="card" aria-label={t('mdm.scope.legend.title')}>
          <h2>{t('mdm.scope.legend.title')}</h2>
          <dl>
            {SCOPES.map((scope) => (
              <div key={scope}>
                <dt>{scopeLabel(t, scope)}</dt>
                <dd>{scopeExplanation(t, scope)}</dd>
              </div>
            ))}
          </dl>
          <p className="sub">{t('mdm.scope.alias.note')}</p>
        </div>
      </StateBoundary>
      <p className="prototype-note">{t('mdm.scope.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
