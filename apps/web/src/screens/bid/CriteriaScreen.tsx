import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { Field } from './components';
import { CriteriaForm } from './CriteriaForm';
import { CriteriaVersions } from './CriteriaVersions';
import { useCriteriaPackages, useCriteriaVersions } from './criteria-hooks';
import { APPROVE_CRITERIA_PERMISSION, MANAGE_CRITERIA_PERMISSION, defaultVersion, draftOf } from './criteria-model';
import './bid.css';

/**
 * BID-04: the evaluation criteria of a package. The versions of a package with the criteria of the one shown and the sum of its weights, the
 * approval that locks a draft, and the editor of the next revision (ST-BID-003). Criteria are made for the packages of an approved plan.
 */
export default function CriteriaScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // What the criteria show depends on the membership (a draft is for those who draft and approve): a switch starts the screen over.
  return <CriteriaContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function CriteriaContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const [params, setParams] = useSearchParams();
  const packages = useCriteriaPackages();
  const state = useScreenState({ isLoading: packages.isLoading, error: packages.error, data: packages.data });
  // The package of the address when it is one of the packages, else the first.
  const known = (packages.data ?? []).find((item) => item.id === params.get('package'))?.id ?? packages.data?.[0]?.id;
  const mayManage = mode !== 'READ_ONLY' && (permissions === undefined || permissions.includes(MANAGE_CRITERIA_PERMISSION));
  const mayApprove = mode !== 'READ_ONLY' && (permissions === undefined || permissions.includes(APPROVE_CRITERIA_PERMISSION));

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('bid.criteria.page.title')}</h1>
          <p>{t('bid.criteria.page.subtitle')}</p>
        </div>
      </div>
      <StateBoundary state={state} onRetry={() => void packages.refetch()}>
        <div className="card">
          <Field id="criteria-package" label={t('bid.criteria.package.label')} error={undefined} hint={t('bid.criteria.package.hint')}>
            <select id="criteria-package" value={known ?? ''} onChange={(event) => setParams(event.target.value === '' ? {} : { package: event.target.value })}>
              {(packages.data ?? []).map((item) => (
                <option key={item.id} value={item.id}>
                  {`${item.code} · ${item.title ?? item.project.name} · ${item.project.code}`}
                </option>
              ))}
            </select>
          </Field>
        </div>
        {known === undefined ? null : <PackageCriteria key={known} packageId={known} mayManage={mayManage} mayApprove={mayApprove} />}
      </StateBoundary>
      <p className="prototype-note">{t('bid.criteria.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function PackageCriteria({ packageId, mayManage, mayApprove }: { packageId: string; mayManage: boolean; mayApprove: boolean }) {
  const { t } = useTranslation();
  const versions = useCriteriaVersions(packageId);
  // A package without criteria is not an empty screen: it is where the first version is made.
  const state = useScreenState({ isLoading: versions.isLoading, error: versions.error, data: versions.data, isEmpty: () => false });
  const [pick, setPick] = useState<string | undefined>(undefined);
  const list = versions.data ?? [];
  const shown = list.find((version) => version.id === pick) ?? defaultVersion(list);

  return (
    <StateBoundary state={state} onRetry={() => void versions.refetch()}>
      <div className="card">
        <CriteriaVersions versions={list} shown={shown} onShow={setPick} mayApprove={mayApprove} />
      </div>
      {mayManage ? (
        <CriteriaForm packageId={packageId} shown={shown} draft={draftOf(list)} />
      ) : (
        <p className="sub" data-testid="read-only">
          {t('bid.criteria.readonly.notice')}
        </p>
      )}
    </StateBoundary>
  );
}
