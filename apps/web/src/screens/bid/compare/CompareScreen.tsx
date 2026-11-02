import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { usePackages } from '../analysis/hooks';
import { biddingPackages } from '../ocr/model';
import { ComparisonTable } from './ComparisonTable';
import { useComparison } from './hooks';
import { attributeLabel, exclusionLabel, failureMessage } from './labels';
import { FINDINGS_PERMISSION, hasTable, holds, packageFromParam, readFailure, validateVersion, versionFromParam } from './model';
import type { Comparison } from './model';
import './compare.css';
import '../bid.css';

/**
 * BID-10: the comparison of the proposals of a package (ST-BID-010, BID 3 F6, BR-BID-09/10/11). The proposals are set side by side on one version of the criteria, from what the experts decided: the analyses that ran on
 * other criteria are left out and named, and so are the personal attributes and the region that the comparison never looks at. There is no ranking, no total that names a winner and no award here: the award is the
 * decision of a person with the authority. A package exists only for whoever evaluates its project, and a proposal only for whoever has it in full.
 */
export default function CompareScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The packages and the comparison belong to one membership: a switch of tenant or of membership starts the screen over.
  return <CompareContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function Exclusions({ comparison }: { comparison: Comparison }) {
  const { t } = useTranslation();
  return (
    <>
      <div className="card" data-testid="excluded">
        <h2>{t('bid.compare.excluded.heading')}</h2>
        {comparison.excluded.length === 0 ? (
          <p className="sub" data-testid="excluded-none">
            {t('bid.compare.excluded.none')}
          </p>
        ) : (
          <ul className="bid-excluded">
            {comparison.excluded.map((entry) => (
              <li key={entry.proposalId} data-excluded={entry.proposalId} data-reason={entry.reason}>
                <strong>{entry.contractor.name}</strong>{' '}
                <span className="bid-badge warning" data-testid="excluded-reason">
                  {exclusionLabel(t, entry.reason)}
                </span>
                {entry.criteriaVersionId === null ? null : (
                  <small className="sub" data-testid="excluded-version">
                    {' '}
                    {t('bid.compare.excluded.version', { id: entry.criteriaVersionId })}
                  </small>
                )}
              </li>
            ))}
          </ul>
        )}
        {comparison.excludedCriteria.length === 0 ? null : (
          <p data-testid="excluded-criteria">
            {t('bid.compare.excluded.criteria', { criteria: comparison.excludedCriteria.map((criterion) => `${criterion.code} (${attributeLabel(t, criterion.rule)})`).join(', ') })}
          </p>
        )}
      </div>
      <div className="card" data-testid="attributes">
        <h2>{t('bid.compare.attributes.heading')}</h2>
        <p className="sub">{t('bid.compare.attributes.hint')}</p>
        <ul className="bid-attributes">
          {comparison.excludedAttributes.map((code) => (
            <li key={code} className="bid-badge" data-attribute={code}>
              {attributeLabel(t, code)}
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}

function CompareContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions } = useSession();
  const [search, setSearch] = useSearchParams();
  const allowed = holds(permissions, FINDINGS_PERMISSION);
  const packageId = packageFromParam(search.get('package'));
  const versionId = versionFromParam(search.get('criteria_version_id'));
  const packages = usePackages(allowed);
  const open = useMemo(() => biddingPackages(packages.data ?? []), [packages.data]);
  const read = useComparison(packageId, versionId, allowed);
  const [typed, setTyped] = useState(search.get('criteria_version_id') ?? '');
  const [problem, setProblem] = useState<ReturnType<typeof validateVersion>>(undefined);
  const failure = readFailure(read.error);
  // A package with nothing to set side by side is not an empty screen when proposals were left out: they are named.
  const state = useScreenState({
    isLoading: read.isLoading,
    error: failure === undefined ? read.error : undefined,
    data: read.data,
    isEmpty: (data) => {
      const found = data as Comparison | undefined;
      return found === undefined || (found.proposals.length === 0 && found.excluded.length === 0);
    },
  });
  const comparison = read.data;

  const choose = (change: Record<string, string>): void => {
    const next = new URLSearchParams(search);
    for (const [name, value] of Object.entries(change)) {
      if (value === '') next.delete(name);
      else next.set(name, value);
    }
    setSearch(next);
  };
  const choosePackage = (id: string): void => {
    setTyped('');
    setProblem(undefined);
    choose({ package: id, criteria_version_id: '' });
  };
  const apply = (event: FormEvent): void => {
    event.preventDefault();
    const found = validateVersion(typed);
    setProblem(found);
    if (found === undefined) choose({ criteria_version_id: typed.trim().toLowerCase() });
  };
  const clear = (): void => {
    setTyped('');
    setProblem(undefined);
    choose({ criteria_version_id: '' });
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('bid.compare.page.title')}</h1>
          <p>{t('bid.compare.page.subtitle')}</p>
        </div>
      </div>
      <StateBoundary state={allowed ? 'default' : 'denied'}>
        <p className="callout" role="note" data-testid="award-notice">
          {t('bid.compare.page.awardNotice')}
        </p>
        <form className="card bid-filters" onSubmit={apply} noValidate data-testid="compare-form">
          <div className="field">
            <label htmlFor="compare-package">{t('bid.compare.package.label')}</label>
            <select id="compare-package" value={open.some((pack) => pack.id === packageId) ? packageId : ''} onChange={(event) => choosePackage(event.target.value)}>
              <option value="">{t('bid.compare.package.choose')}</option>
              {open.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.title === null ? candidate.code : `${candidate.code} · ${candidate.title}`}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="compare-version">{t('bid.compare.version.label')}</label>
            <input id="compare-version" autoComplete="off" value={typed} onChange={(event) => setTyped(event.target.value)} />
            <small className="sub">{t('bid.compare.version.hint')}</small>
            {problem === undefined ? null : (
              <small role="alert" className="field-error">
                {t('bid.compare.version.notIdentity')}
              </small>
            )}
          </div>
          <button type="submit" disabled={packageId === ''}>
            {t('bid.compare.version.apply')}
          </button>
          {versionId === '' ? null : (
            <button type="button" onClick={clear}>
              {t('bid.compare.version.clear')}
            </button>
          )}
        </form>
        {packageId === '' ? (
          <p className="callout" role="status" data-testid="no-package">
            {t('bid.compare.package.none')}
          </p>
        ) : failure !== undefined ? (
          <p className="callout warning" role="alert" data-testid={`package-${failure}`}>
            {failureMessage(t, failure)}
          </p>
        ) : (
          <StateBoundary state={state} onRetry={() => void read.refetch()}>
            {comparison === undefined ? null : (
              <>
                <div className="card" data-testid="version-used" data-version={comparison.criteriaVersionId}>
                  <p>
                    {t('bid.compare.version.used', { id: comparison.criteriaVersionId, status: comparison.criteriaStatus })}
                  </p>
                </div>
                {hasTable(comparison) ? (
                  <ComparisonTable comparison={comparison} />
                ) : (
                  <p className="callout" role="status" data-testid="nothing-compared">
                    {t('bid.compare.table.none')}
                  </p>
                )}
                <Exclusions comparison={comparison} />
              </>
            )}
          </StateBoundary>
        )}
      </StateBoundary>
      <p className="prototype-note">{t('bid.compare.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
