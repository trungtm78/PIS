import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { useCriteriaVersions } from '../criteria-hooks';
import { biddingPackages } from '../ocr/model';
import { useProposals } from '../proposal/hooks';
import { useOcrGate, usePackages, useRuns, useStartRun } from './hooks';
import { runStatusLabel } from './labels';
import { CRITERIA_READ_PERMISSION, EMPTY_FORM, OCR_READ_PERMISSION, RUN_READ_PERMISSION, RUN_STATUSES, START_PERMISSION, canStart, holds, runStatusFromParam } from './model';
import type { RunForm as RunFormValue } from './model';
import { RunForm } from './RunForm';
import { RunList } from './RunList';
import '../bid.css';

/**
 * BID-07: the configuration of an AI analysis of a proposal (ST-BID-009, BID 3 F5). A member of the evaluation team chooses the proposal they have in full, the criteria in force and the profile of the task, and asks
 * for the run; the class of the data and the routes it may take are the server's and are shown, not asked. The runs the proposal already has are listed below with the way to their progress and their evidence.
 */
export default function ConfigScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The packages, the proposals, the runs and what was typed belong to one membership: a switch of tenant or of membership starts the screen over.
  return <ConfigContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function ConfigContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const [search, setSearch] = useSearchParams();
  const permitted = holds(permissions, START_PERMISSION);
  const packages = usePackages(permitted);
  const open = useMemo(() => biddingPackages(packages.data ?? []), [packages.data]);
  const wantedPackage = search.get('package') ?? '';
  const packageId = open.some((pack) => pack.id === wantedPackage) ? wantedPackage : '';
  const proposals = useProposals(permitted ? packageId : '');
  // Only a proposal the caller has in full can be analysed by them; the others are not offered.
  const readable = useMemo(() => (proposals.data ?? []).filter((proposal) => proposal.access === 'FULL' && proposal.status === 'RECEIVED'), [proposals.data]);
  const wantedProposal = search.get('proposal') ?? '';
  const proposalId = readable.some((proposal) => proposal.id === wantedProposal) ? wantedProposal : '';
  const statusFilter = runStatusFromParam(search.get('status'));
  const mayReadCriteria = holds(permissions, CRITERIA_READ_PERMISSION);
  const mayReadRuns = holds(permissions, RUN_READ_PERMISSION);
  const versions = useCriteriaVersions(proposalId !== '' && mayReadCriteria ? packageId : undefined);
  const approved = useMemo(() => (versions.data ?? []).filter((version) => version.status === 'APPROVED'), [versions.data]);
  const gate = useOcrGate(proposalId, holds(permissions, OCR_READ_PERMISSION));
  const runs = useRuns(proposalId, statusFilter, mayReadRuns);
  const start = useStartRun();
  const [typed, setTyped] = useState<Omit<RunFormValue, 'proposalId'>>({ criteriaVersionId: '', profileVersionId: '', maxCostVnd: '' });
  // With one version of criteria in force there is nothing to choose.
  const criteriaVersionId = typed.criteriaVersionId !== '' ? typed.criteriaVersionId : approved.length === 1 ? (approved[0]?.id ?? '') : '';
  const form: RunFormValue = { ...EMPTY_FORM, ...typed, criteriaVersionId, proposalId };

  const state = useScreenState({ isLoading: packages.isLoading, error: packages.error, data: packages.data, isEmpty: (data) => biddingPackages(data as typeof open).length === 0 });
  // A filter that matches no run is not an empty screen: the filter stays where it is, outside the boundary.
  const runsState = useScreenState({
    isLoading: runs.isLoading,
    error: runs.error,
    data: runs.data,
    isEmpty: (data) => (data as { pages: Array<{ runs: unknown[] }> }).pages.every((page) => page.runs.length === 0),
  });
  const list = runs.data?.pages.flatMap((page) => page.runs) ?? [];

  const choose = (change: Record<string, string>): void => {
    const next = new URLSearchParams(search);
    for (const [name, value] of Object.entries(change)) {
      if (value === '') next.delete(name);
      else next.set(name, value);
    }
    setSearch(next);
  };
  const chooseProposal = (id: string): void => {
    start.reset();
    setTyped((current) => ({ ...current, criteriaVersionId: '' }));
    choose({ proposal: id, status: '' });
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('bid.analysis.config.title')}</h1>
          <p>{t('bid.analysis.config.subtitle')}</p>
        </div>
      </div>
      <StateBoundary state={permitted ? state : 'denied'} onRetry={() => void packages.refetch()}>
        <div className="card">
          <div className="field">
            <label htmlFor="analysis-package">{t('bid.analysis.package.label')}</label>
            <select id="analysis-package" value={packageId} onChange={(event) => choose({ package: event.target.value, proposal: '', status: '' })}>
              <option value="">{t('bid.analysis.package.choose')}</option>
              {open.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.title === null ? candidate.code : `${candidate.code} · ${candidate.title}`}
                </option>
              ))}
            </select>
          </div>
          {packageId === '' ? (
            <p className="sub" data-testid="choose-package">
              {t('bid.analysis.package.hint')}
            </p>
          ) : proposals.isLoading ? (
            <p role="status">{t('bid.analysis.loading.text')}</p>
          ) : proposals.isError ? (
            <p className="callout warning" role="alert" data-testid="proposals-error">
              {t('bid.analysis.proposals.error')}{' '}
              <button type="button" onClick={() => void proposals.refetch()}>
                {t('bid.analysis.retry.action')}
              </button>
            </p>
          ) : readable.length === 0 ? (
            <p className="callout" role="status" data-testid="no-proposals">
              {t('bid.analysis.proposals.none')}
            </p>
          ) : (
            <div className="field">
              <label htmlFor="analysis-proposal">{t('bid.analysis.proposal.label')}</label>
              <select id="analysis-proposal" value={proposalId} onChange={(event) => chooseProposal(event.target.value)}>
                <option value="">{t('bid.analysis.proposal.choose')}</option>
                {readable.map((proposal) => (
                  <option key={proposal.id} value={proposal.id}>
                    {t('bid.analysis.proposal.option', { name: proposal.contractorName, revision: proposal.revision })}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
        {proposalId === '' ? null : (
          <>
            <RunForm
              form={form}
              criteria={approved}
              mayReadCriteria={mayReadCriteria}
              gate={gate.data}
              allowed={canStart(permissions, mode)}
              pending={start.isPending}
              started={start.data}
              refusal={start.error}
              onChange={(change) => setTyped((current) => ({ ...current, ...change }))}
              onStart={(body) => start.mutate(body)}
            />
            <div className="card">
              <h2>{t('bid.analysis.runs.heading')}</h2>
              {mayReadRuns ? (
                <>
                  <div className="bid-filters">
                    <div className="field">
                      <label htmlFor="analysis-status">{t('bid.analysis.runs.filter.label')}</label>
                      <select id="analysis-status" value={statusFilter} onChange={(event) => choose({ status: event.target.value })}>
                        <option value="">{t('bid.analysis.runs.filter.all')}</option>
                        {RUN_STATUSES.map((status) => (
                          <option key={status} value={status}>
                            {runStatusLabel(t, status)}
                          </option>
                        ))}
                      </select>
                    </div>
                    {statusFilter === '' ? null : (
                      <button type="button" onClick={() => choose({ status: '' })}>
                        {t('bid.analysis.runs.filter.clear')}
                      </button>
                    )}
                  </div>
                  <StateBoundary state={runsState} onRetry={() => void runs.refetch()}>
                    <RunList runs={list} />
                    {runs.hasNextPage ? (
                      <div className="formfooter">
                        <button type="button" disabled={runs.isFetchingNextPage} onClick={() => void runs.fetchNextPage()}>
                          {t('bid.analysis.loadMore.action')}
                        </button>
                      </div>
                    ) : null}
                  </StateBoundary>
                </>
              ) : (
                <p className="callout" role="status" data-testid="runs-hidden">
                  {t('bid.analysis.runs.hidden')}
                </p>
              )}
            </div>
          </>
        )}
      </StateBoundary>
      <p className="prototype-note">{t('bid.analysis.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
