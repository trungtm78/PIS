import { useTranslation } from '../../i18n';
import { planProblemMessage, planStatusLabel } from './plan-labels';
import { formatVnd } from './plan-model';
import type { PlanStatus, ProblemView } from './plan-model';
import './bid.css';

const STATUS_TONE: Readonly<Record<PlanStatus, string>> = { DRAFT: 'warning', IN_REVIEW: 'warning', APPROVED: 'ok', SUPERSEDED: '', CANCELLED: 'danger' };

/** The state of a plan in words: a state is never told by colour alone. */
export function PlanStatusBadge({ status }: { status: PlanStatus }) {
  const { t } = useTranslation();
  return (
    <span className={`bid-badge ${STATUS_TONE[status]}`.trim()} data-testid="plan-status" data-status={status}>
      {planStatusLabel(t, status)}
    </span>
  );
}

/** A refusal of a command of the plans; the refusal of the budget check names every line over its limit with the figures. */
export function PlanRefusal({ problem, testId }: { problem: ProblemView; testId: string }) {
  const { t } = useTranslation();
  return (
    <div className="callout warning" role="alert" data-testid={testId} data-reason={problem.reason}>
      <p>{planProblemMessage(t, problem)}</p>
      {problem.lines.length === 0 ? null : (
        <table className="table" data-testid="excess-lines">
          <thead>
            <tr>
              <th scope="col">{t('bid.excess.column.line')}</th>
              <th scope="col">{t('bid.excess.column.allocated')}</th>
              <th scope="col">{t('bid.excess.column.packages')}</th>
              <th scope="col">{t('bid.excess.column.excess')}</th>
            </tr>
          </thead>
          <tbody>
            {problem.lines.map((line) => (
              <tr key={line.allocationLineId} data-line-id={line.allocationLineId}>
                <th scope="row">
                  <code>{line.allocationLineId}</code>
                </th>
                <td>{formatVnd(line.allocatedVnd)}</td>
                <td>{formatVnd(line.packagesVnd)}</td>
                <td>{formatVnd(line.excessVnd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
