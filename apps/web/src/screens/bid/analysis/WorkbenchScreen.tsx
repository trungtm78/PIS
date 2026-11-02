import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { FindingCard } from './FindingCard';
import { useFindings } from './hooks';
import { classificationLabel, findingStatusLabel, routeLabel, runStatusLabel, runTone } from './labels';
import { FINDING_STATUSES, FINDINGS_PERMISSION, NO_FINDING_FILTER, findingStatusFromParam, hasFindingFilter, holds, missingFromParam, progressPath, readFailure } from './model';
import type { FindingFilter } from './model';
import '../bid.css';

/**
 * BID-09: the evidence workbench (ST-BID-009, BID 3 F5, BR-BID-07/08/09). The findings of a run with the citation under each and whether its words were found on the page it names; a finding that claimed
 * without such a citation is flagged as lacking a source. Everything on it is a proposal of the AI that an expert has to review, and nothing on it accepts a finding: the review is the expert's. A run exists only for
 * whoever has the full view of its proposal.
 */
export default function WorkbenchScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The findings belong to one membership: a switch of tenant or of membership starts the screen over.
  return <WorkbenchContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function WorkbenchContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions } = useSession();
  const [search, setSearch] = useSearchParams();
  const runId = search.get('run') ?? '';
  const allowed = holds(permissions, FINDINGS_PERMISSION);
  const filter: FindingFilter = { status: findingStatusFromParam(search.get('status')), missingSource: missingFromParam(search.get('missing')) };
  const read = useFindings(runId, filter, allowed);
  const failure = readFailure(read.error);
  // A filter that matches no finding is not an empty screen: the filters stay where they are, outside the boundary.
  const state = useScreenState({
    isLoading: read.isLoading,
    error: failure === undefined ? read.error : undefined,
    data: read.data,
    isEmpty: (data) => (data as { pages: Array<{ findings: unknown[] }> }).pages.every((page) => page.findings.length === 0),
  });
  const pages = read.data?.pages ?? [];
  const run = pages[0]?.run;
  const findings = pages.flatMap((page) => page.findings);

  const choose = (change: Record<string, string>): void => {
    const next = new URLSearchParams(search);
    for (const [name, value] of Object.entries(change)) {
      if (value === '') next.delete(name);
      else next.set(name, value);
    }
    setSearch(next);
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('bid.analysis.workbench.title')}</h1>
          <p>{t('bid.analysis.workbench.subtitle')}</p>
        </div>
      </div>
      <StateBoundary state={allowed ? 'default' : 'denied'}>
        <p className="callout" role="note" data-testid="ai-notice">
          {t('bid.analysis.workbench.aiNotice')}
        </p>
        {runId === '' ? (
          <p className="callout" role="status" data-testid="no-run">
            {t('bid.analysis.run.none')}
          </p>
        ) : failure !== undefined ? (
          <p className="callout warning" role="alert" data-testid={failure === 'notFound' ? 'run-not-found' : 'run-undeclared'}>
            {failure === 'notFound' ? t('bid.analysis.run.notFound') : t('bid.analysis.run.undeclared')}
          </p>
        ) : (
          <>
            {run === undefined ? null : (
              <div className="card" data-run={run.id} data-status={run.status}>
                <header className="heading">
                  <h2>{t('bid.analysis.progress.heading', { package: run.packageCode, contractor: run.contractorName })}</h2>
                  <span className={`bid-badge ${runTone(run.status)}`} data-testid="run-status">
                    {runStatusLabel(t, run.status)}
                  </span>
                </header>
                <p className="sub" data-testid="run-facts">
                  {t('bid.analysis.workbench.facts', { classification: classificationLabel(t, run.dataClassification), route: routeLabel(t, run.routeClass), count: run.findingCount, missing: run.missingSourceCount })}
                </p>
                <p>
                  <Link to={progressPath(run.id)}>{t('bid.analysis.link.progress')}</Link>
                </p>
              </div>
            )}
            <div className="card bid-filters">
              <div className="field">
                <label htmlFor="analysis-finding-status">{t('bid.analysis.filter.status.label')}</label>
                <select id="analysis-finding-status" value={filter.status} onChange={(event) => choose({ status: event.target.value })}>
                  <option value="">{t('bid.analysis.filter.status.all')}</option>
                  {FINDING_STATUSES.map((status) => (
                    <option key={status} value={status}>
                      {findingStatusLabel(t, status)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="analysis-finding-missing">{t('bid.analysis.filter.missing.label')}</label>
                <select id="analysis-finding-missing" value={filter.missingSource} onChange={(event) => choose({ missing: event.target.value })}>
                  <option value="">{t('bid.analysis.filter.missing.all')}</option>
                  <option value="true">{t('bid.analysis.filter.missing.only')}</option>
                  <option value="false">{t('bid.analysis.filter.missing.without')}</option>
                </select>
              </div>
              {hasFindingFilter(filter) ? (
                <button type="button" onClick={() => choose({ status: NO_FINDING_FILTER.status, missing: NO_FINDING_FILTER.missingSource })}>
                  {t('bid.analysis.filter.clear')}
                </button>
              ) : null}
            </div>
            <StateBoundary state={state} onRetry={() => void read.refetch()}>
              <div data-testid="findings">
                {findings.map((finding) => (
                  <FindingCard key={finding.id} finding={finding} />
                ))}
              </div>
              {read.hasNextPage ? (
                <div className="formfooter">
                  <button type="button" disabled={read.isFetchingNextPage} onClick={() => void read.fetchNextPage()}>
                    {t('bid.analysis.loadMore.action')}
                  </button>
                </div>
              ) : null}
            </StateBoundary>
          </>
        )}
      </StateBoundary>
      <p className="prototype-note">{t('bid.analysis.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
