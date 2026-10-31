import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { statusLabel as contractStatusLabel } from '../../ctr/labels';
import { CONTRACT_STATUSES, workspaceLink } from '../../ctr/model';
import { kindLabel as evaluationKindLabel, ratingLabel } from '../../ctr/scorecard/labels';
import { EVALUATION_KINDS, RATINGS } from '../../ctr/scorecard/model';
import HistoryFrame from './HistoryFrame';

/**
 * BID-14: the contracts of a contractor and its history of performance (ST-BID-013, BID 3.1 F9). BID keeps no scorecard of its own: the table is the approved scorecards of CTR that stand, the contract of each one
 * links to its workspace, and the contracts listed are those the caller reads. The evaluators of the criteria of experience rely on these lines and on no other.
 */
export default function ContractLinksScreen({ route }: ScreenProps) {
  const { t } = useTranslation();
  return (
    <HistoryFrame id={route.id} req={route.req ?? ''} title={t('bid.history.contracts.title')} subtitle={t('bid.history.contracts.subtitle')}>
      {(history) => (
        <>
          <section aria-labelledby="contracts-title">
            <h2 id="contracts-title">{t('bid.history.contracts.list.title')}</h2>
            {history.contracts.length === 0 ? (
              <p className="callout" role="status" data-testid="no-contracts">
                {t('bid.history.contracts.none.notice')}
              </p>
            ) : (
              <div className="tablewrap">
                <table className="table" aria-label={t('bid.history.contracts.aria', { name: history.contractor.legalName })} data-testid="contracts">
                  <thead>
                    <tr>
                      <th scope="col">{t('bid.history.col.contract')}</th>
                      <th scope="col">{t('bid.history.col.status')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.contracts.map((contract) => {
                      const status = CONTRACT_STATUSES.find((known) => known === contract.status);
                      return (
                        <tr key={contract.id} data-contract={contract.id}>
                          <td>
                            <Link to={workspaceLink(contract.id)}>{contract.code}</Link>
                          </td>
                          <td>{status === undefined ? contract.status : contractStatusLabel(t, status)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
          <section aria-labelledby="scorecards-title">
            <h2 id="scorecards-title">{t('bid.history.scorecards.title')}</h2>
            <p className="sub" data-testid="average">
              {history.averageOverallScore === null ? t('bid.history.scorecards.average.none') : t('bid.history.scorecards.average', { score: history.averageOverallScore, count: history.approvedCount })}
            </p>
            {history.scorecards.length === 0 ? (
              <p className="callout" role="status" data-testid="no-scorecards">
                {t('bid.history.scorecards.none.notice')}
              </p>
            ) : (
              <div className="tablewrap">
                <table className="table" aria-label={t('bid.history.scorecards.aria', { name: history.contractor.legalName })} data-testid="scorecards">
                  <thead>
                    <tr>
                      <th scope="col">{t('bid.history.col.contract')}</th>
                      <th scope="col">{t('bid.history.col.period')}</th>
                      <th scope="col">{t('bid.history.col.evaluation')}</th>
                      <th scope="col">{t('bid.history.col.score')}</th>
                      <th scope="col">{t('bid.history.col.rating')}</th>
                      <th scope="col">{t('bid.history.col.approvedAt')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.scorecards.map((card) => {
                      const kind = EVALUATION_KINDS.find((known) => known === card.kind);
                      const rating = RATINGS.find((known) => known === card.rating);
                      return (
                        <tr key={card.id} data-scorecard={card.id}>
                          <td>{card.contractCode}</td>
                          <td>{card.periodLabel}</td>
                          <td>{kind === undefined ? card.kind : evaluationKindLabel(t, kind)}</td>
                          <td>{card.overallScore}</td>
                          <td>{rating === undefined ? card.rating : ratingLabel(t, rating)}</td>
                          <td>{card.approvedAt ?? t('bid.history.none')}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </HistoryFrame>
  );
}
