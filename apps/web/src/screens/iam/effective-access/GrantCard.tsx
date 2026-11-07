import { PermissionChips } from './PermissionChips';
import { useTranslation } from '../../../i18n';
import { customRoleName, scopeLabel, stateLabel, statePill, windowLabel } from './labels';
import { breadcrumbText } from './model';
import type { AccessGrant } from './types';
import { StatusPill } from '../../../ui';

/** One grant of the person: the role, where it applies (units with their place in the tree), when, and what it allows. */
export function GrantCard({ grant }: { grant: AccessGrant }) {
  const { t } = useTranslation();
  const name = customRoleName(grant.roleCode, grant.roleName);
  const hasNamedScope = grant.units.length + grant.projects.length + grant.contracts.length > 0;
  return (
    <article className="card" data-grant-id={grant.id} data-grant-state={grant.state}>
      <div className="row between">
        <h3>
          {grant.roleCode}
          {name === undefined ? null : <span className="sub"> · {name}</span>}
        </h3>
        <span className="row gap">
          <StatusPill tone="neutral">{t('iam.effectiveAccess.grant.rank', { rank: grant.rank })}</StatusPill>
          <span className={statePill(grant.state)}>{stateLabel(t, grant.state)}</span>
        </span>
      </div>
      <p>
        <b>{scopeLabel(t, grant.scopeKind)}</b>
        {' · '}
        {windowLabel(t, grant.effectiveFrom, grant.effectiveUntil)}
      </p>
      {hasNamedScope ? (
        <ul className="tiny">
          {grant.units.map((unit) => (
            <li key={unit.id}>
              {t('iam.effectiveAccess.grant.unit')}: <span data-breadcrumb>{breadcrumbText(unit)}</span>
            </li>
          ))}
          {grant.projects.map((project) => (
            <li key={project.id}>
              {t('iam.effectiveAccess.grant.project')}: {project.code} · {project.name}
            </li>
          ))}
          {grant.contracts.map((contract) => (
            <li key={contract.id}>
              {t('iam.effectiveAccess.grant.contract')}: {contract.code}
            </li>
          ))}
        </ul>
      ) : null}
      <p className="tiny">
        {grant.permissions.length === 0 ? (
          t('iam.effectiveAccess.grant.noPermissions')
        ) : (
          <>
            {t('iam.effectiveAccess.grant.permissions')}:{' '}
            <PermissionChips permissions={grant.permissions} />
          </>
        )}
      </p>
    </article>
  );
}
