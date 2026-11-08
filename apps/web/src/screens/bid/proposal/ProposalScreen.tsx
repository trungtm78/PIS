import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { useMilestones, useTrackedPackages } from '../procurement/hooks';
import { formatVnd } from '../plan-model';
import { DeclarationPanel } from './DeclarationPanel';
import { useOpenProposal, useProposals } from './hooks';
import { accessLabel, problemMessage, statusLabel } from './labels';
import { IntakeDialog } from './IntakeDialog';
import { PassageSearchPanel } from './PassageSearchPanel';
import { canEvaluate, canReceive, describeProblem, momentText, openPackages, openingOf, orderedProposals } from './model';
import type { Proposal } from './model';
import { ProposalDetailDialog } from './ProposalDetailDialog';
import '../bid.css';
import { SectionCard } from '../../../ui';

/**
 * BID-05: the proposals of a package (ST-BID-004, BID 3 F3, BR-BID-03). A proposal is confidential and sealed until the opening of the bids of its package: a clerk who may
 * receive proposals logs the files a contractor handed in and sees the receipt of each, never the price or a file; a member of the evaluation team sees a proposal in full only
 * from the opening and only after declaring that no conflict of interest stands between them and the bidder. The server decides what each caller sees; this screen says why the rest is missing.
 */
export default function ProposalScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The packages, the proposals and the dialogs belong to one membership: a switch of tenant or of membership starts the screen over.
  return <ProposalContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function ProposalContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const [search, setSearch] = useSearchParams();
  const packages = useTrackedPackages();
  const milestones = useMilestones();
  const open = useMemo(() => openPackages(packages.data ?? []), [packages.data]);
  const wanted = search.get('package') ?? '';
  const packageId = open.some((pack) => pack.id === wanted) ? wanted : '';
  const pack = open.find((candidate) => candidate.id === packageId);
  const proposals = useProposals(packageId);
  const opener = useOpenProposal();
  const [intake, setIntake] = useState(false);
  const [detail, setDetail] = useState<Proposal | undefined>(undefined);
  const mayReceive = canReceive(permissions, mode);
  const mayEvaluate = canEvaluate(permissions, mode);
  const state = useScreenState({
    isLoading: packages.isLoading,
    error: packages.error,
    data: packages.data,
    isEmpty: (data) => openPackages(data as typeof open).length === 0,
  });
  const opening = packageId === '' ? null : openingOf(packageId, milestones.data ?? []);
  const opened = opening !== null && Date.parse(opening) <= Date.now();
  const rows = useMemo(() => orderedProposals(proposals.data ?? []), [proposals.data]);
  const choose = (id: string): void => {
    opener.reset();
    setSearch(id === '' ? {} : { package: id });
  };
  const view = (proposal: Proposal): void =>
    opener.mutate(proposal.id, {
      onSuccess: (full) => {
        if (full !== undefined) setDetail(full);
      },
    });

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('bid.proposals.page.title')}</h1>
          <p>{t('bid.proposals.page.subtitle')}</p>
        </div>
      </div>
      <StateBoundary
        state={state}
        onRetry={() => {
          void packages.refetch();
          void milestones.refetch();
        }}
      >
        <div className="card">
          <div className="field">
            <label htmlFor="proposals-package">{t('bid.proposals.package.label')}</label>
            <select id="proposals-package" value={packageId} onChange={(event) => choose(event.target.value)}>
              <option value="">{t('bid.proposals.package.choose')}</option>
              {open.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.title === null ? candidate.code : `${candidate.code} · ${candidate.title}`}
                </option>
              ))}
            </select>
          </div>
          {pack === undefined ? (
            <p className="sub" data-testid="choose-package">
              {t('bid.proposals.package.hint')}
            </p>
          ) : (
            <>
              {opening === null ? (
                <p className="callout warning" role="status" data-testid="opening-unset">
                  {t('bid.proposals.opening.unset')}
                </p>
              ) : (
                <p className="callout" role="status" data-testid="opening">
                  {opened ? t('bid.proposals.released.text', { date: momentText(opening) }) : t('bid.proposals.locked.text', { date: momentText(opening) })}
                </p>
              )}
              {mayReceive ? (
                <div className="formfooter">
                  <button type="button" className="button primary" disabled={opening === null || opened} onClick={() => setIntake(true)}>
                    {t('bid.proposals.intake.action')}
                  </button>
                </div>
              ) : null}
            </>
          )}
        </div>
        {pack === undefined ? null : (
          <>
            {mayEvaluate ? <PassageSearchPanel packageId={packageId} /> : null}
            <SectionCard title={t('bid.proposals.table.title')}>
              {opener.isError ? (
                <p className="callout warning" role="alert" data-testid="open-refusal">
                  {problemMessage(t, describeProblem(opener.error))}
                </p>
              ) : null}
              {proposals.isLoading ? (
                <p role="status">{t('bid.proposals.loading.text')}</p>
              ) : proposals.isError ? (
                <p className="callout warning" role="alert" data-testid="proposals-error">
                  {t('bid.proposals.error.load')}{' '}
                  <button type="button" className="button" onClick={() => void proposals.refetch()}>
                    {t('bid.proposals.error.retry')}
                  </button>
                </p>
              ) : rows.length === 0 ? (
                <p className="callout" role="status" data-testid="no-proposals">
                  {t('bid.proposals.none.notice')}
                </p>
              ) : (
                <table className="table" data-testid="proposals">
                  <thead>
                    <tr>
                      <th scope="col">{t('bid.proposals.column.contractor')}</th>
                      <th scope="col">{t('bid.proposals.column.revision')}</th>
                      <th scope="col">{t('bid.proposals.column.received')}</th>
                      <th scope="col">{t('bid.proposals.column.files')}</th>
                      <th scope="col">{t('bid.proposals.column.state')}</th>
                      <th scope="col">{t('bid.proposals.column.price')}</th>
                      <th scope="col">{t('bid.proposals.column.action')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((proposal) => (
                      <tr key={proposal.id} data-proposal-id={proposal.id} data-access={proposal.access} data-status={proposal.status}>
                        <th scope="row">{proposal.contractorName}</th>
                        <td>{t('bid.proposals.revision.text', { revision: proposal.revision })}</td>
                        <td>{momentText(proposal.submittedAt)}</td>
                        <td>{proposal.fileCount}</td>
                        <td>
                          <span className={proposal.access === 'FULL' ? 'bid-badge ok' : 'bid-badge'} data-testid="access">
                            {accessLabel(t, proposal.access, proposal.locked)}
                          </span>
                          {proposal.status === 'RECEIVED' ? null : <span className="bid-badge">{statusLabel(t, proposal.status)}</span>}
                        </td>
                        <td data-testid="price">{proposal.bidPriceVnd === null ? <span className="sub">{t('bid.proposals.price.hidden')}</span> : formatVnd(proposal.bidPriceVnd)}</td>
                        <td>
                          {proposal.access !== 'FULL' ? null : (
                            <button type="button" className="button" aria-label={t('bid.proposals.open.aria', { name: proposal.contractorName })} disabled={opener.isPending} onClick={() => view(proposal)}>
                              {t('bid.proposals.open.action')}
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </SectionCard>
            <DeclarationPanel pack={pack} mayEvaluate={mayEvaluate} />
          </>
        )}
      </StateBoundary>
      {intake && pack !== undefined ? <IntakeDialog pack={pack} onClose={() => setIntake(false)} /> : null}
      {detail === undefined ? null : <ProposalDetailDialog proposal={detail} onClose={() => setDetail(undefined)} />}
      <p className="prototype-note">{t('bid.proposals.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
