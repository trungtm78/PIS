import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import { findingStatusLabel } from '../analysis/labels';
import { decisionLabel } from '../review/labels';
import { riskLabel, riskTone } from './labels';
import { cellOf, reviewPath } from './model';
import type { Cell, Comparison, Criterion } from './model';
import './compare.css';
import '../bid.css';

function CriterionHeader({ criterion }: { criterion: Criterion }) {
  const { t } = useTranslation();
  return (
    <>
      <strong>{criterion.name}</strong> <small className="sub">{criterion.code}</small>
      <small className="sub bid-criterion-facts">
        {criterion.kind === 'SCORED' ? t('bid.compare.criterion.scored', { weight: criterion.weight ?? 0, max: criterion.maxScore ?? 0 }) : t('bid.compare.criterion.passFail')}
        {criterion.mandatory ? ` · ${t('bid.compare.criterion.mandatory')}` : ''}
      </small>
    </>
  );
}

/** One cell: only what a person decided about the finding, or that nobody has; what the model said is not here. */
function DecisionCell({ cell }: { cell: Cell | undefined }) {
  const { t } = useTranslation();
  if (cell === undefined || cell.decided === null) {
    return (
      <td data-risk="UNDECIDED" data-testid="cell">
        <span className="bid-badge" data-testid="undecided">
          {t('bid.compare.cell.undecided')}
        </span>
      </td>
    );
  }
  return (
    <td data-risk={cell.risk} data-testid="cell" data-decision={cell.decided.decision}>
      <span data-testid="decided-status">{findingStatusLabel(t, cell.decided.status)}</span>
      {cell.decided.score === null ? null : <span data-testid="decided-score"> · {t('bid.compare.cell.score', { score: cell.decided.score })}</span>}
      <br />
      <small className="sub" data-testid="decided-decision">
        {decisionLabel(t, cell.decided.decision)}
      </small>
      <br />
      <span className={`bid-badge ${riskTone(cell.risk)}`} data-testid="risk">
        {riskLabel(t, cell.risk)}
      </span>
    </td>
  );
}

/**
 * The proposals of a package side by side, criterion by criterion (BID-10, BR-BID-09/10). The columns stand in the order the server gave them, which is the order of the names of the contractors, never a ranking;
 * a cell holds only what an expert decided; the summary under it says how far each proposal is decided and carries no total that names a winner and no award.
 */
export function ComparisonTable({ comparison }: { comparison: Comparison }) {
  const { t } = useTranslation();
  return (
    <div className="card" data-testid="comparison">
      <table className="table bid-compare">
        <caption>{t('bid.compare.table.caption', { package: comparison.packageCode })}</caption>
        <thead>
          <tr>
            <th scope="col">{t('bid.compare.table.criterion')}</th>
            {comparison.proposals.map((proposal) => (
              <th scope="col" key={proposal.proposalId} data-proposal={proposal.proposalId}>
                <Link to={reviewPath({ runId: proposal.runId, proposalId: proposal.proposalId, packageId: comparison.packageId })} data-testid="review-link">
                  {proposal.contractor.name}
                </Link>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {comparison.rows.map((row) => (
            <tr key={row.criterion.code} data-criterion={row.criterion.code}>
              <th scope="row">
                <CriterionHeader criterion={row.criterion} />
              </th>
              {comparison.proposals.map((proposal) => (
                <DecisionCell key={proposal.proposalId} cell={cellOf(row, proposal.proposalId)} />
              ))}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr data-summary="decided">
            <th scope="row">{t('bid.compare.summary.decided')}</th>
            {comparison.proposals.map((proposal) => (
              <td key={proposal.proposalId} data-testid="summary-decided">
                {t('bid.compare.summary.decidedOf', { decided: proposal.decidedCount, total: proposal.criteriaCount })}
              </td>
            ))}
          </tr>
          <tr data-summary="mandatory">
            <th scope="row">{t('bid.compare.summary.mandatory')}</th>
            {comparison.proposals.map((proposal) => (
              <td key={proposal.proposalId} data-testid="summary-mandatory">
                {proposal.mandatoryNotMet}
              </td>
            ))}
          </tr>
          <tr data-summary="weighted">
            <th scope="row">{t('bid.compare.summary.weighted')}</th>
            {comparison.proposals.map((proposal) => (
              <td key={proposal.proposalId} data-testid="summary-weighted">
                {proposal.weightedScore !== null ? t('bid.compare.summary.weightedValue', { score: proposal.weightedScore }) : t('bid.compare.summary.incomplete')}
              </td>
            ))}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
