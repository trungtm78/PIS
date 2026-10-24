import { useMemo } from 'react';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { PolicyForm } from './PolicyForm';
import { PolicyTable } from './PolicyTable';
import { usePolicies, useUnits } from './hooks';
import { POLICY_MANAGE_PERMISSION, groupPolicies, vietnamToday } from './model';

const NEVER_EMPTY = (): boolean => false;

/**
 * ISS-09: the SLA policies by category, severity and unit, with the version history of each, and the form that publishes a new policy
 * or the next revision of one (ST-ISS-001). An issue keeps the version it was created under, so nothing here edits a version.
 */
export default function IssueSlaPolicyScreen({ route }: ScreenProps) {
  const tenantId = useSession().tenant?.id;
  // The forms and the open panels belong to one tenant: a switch starts the screen over.
  return <IssueSlaPolicyContent key={tenantId ?? 'none'} route={route} />;
}

function IssueSlaPolicyContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const mayManage = (permissions === undefined || permissions.includes(POLICY_MANAGE_PERMISSION)) && mode !== 'READ_ONLY';
  const policies = usePolicies();
  const units = useUnits();
  const state = useScreenState({ isLoading: policies.isLoading, error: policies.error, data: policies.data, isEmpty: NEVER_EMPTY });
  const today = vietnamToday();
  const groups = useMemo(() => groupPolicies(policies.data ?? [], today), [policies.data, today]);
  const unitsById = useMemo(() => new Map((units.data ?? []).map((unit) => [unit.id, unit])), [units.data]);

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('iss.sla.page.title')}</h1>
          <p>{t('iss.sla.page.subtitle')}</p>
        </div>
      </div>
      <StateBoundary state={state} onRetry={() => void policies.refetch()}>
        <div className="card">
          {groups.length === 0 ? (
            <p className="muted" data-testid="empty-policies">
              {t('iss.sla.empty.text')}
            </p>
          ) : (
            <PolicyTable groups={groups} units={unitsById} today={today} mayRetire={mayManage} />
          )}
          <p className="sub" data-testid="count">
            {t('iss.sla.count.text', { count: groups.length })}
          </p>
        </div>
        {mayManage ? <PolicyForm today={today} /> : null}
      </StateBoundary>
      <p className="prototype-note">{t('iss.sla.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
