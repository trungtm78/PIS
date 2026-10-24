import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { Money } from './components';
import { PlanChooser, PlanHeader, usePlanChoice } from './plan-components';
import { usePlanLines, usePlans } from './plan-hooks';
import { bucketLabel } from './plan-labels';
import { ALLOCATION_GRID_PATH, PROPOSAL_PATH, canDraft, plansOfKind, isDraft } from './plan-model';
import type { PlanLine } from './plan-model';
import './cap.css';

/**
 * CAP-03: the lines of an annual plan, project by project: the capital of the year and the capital carried over from an earlier year, the year
 * the capital comes from, the day the extension ends and the document that allowed it, and the part of the line that belongs to a national
 * target programme. That part is inside the line and is never added to the total.
 */
export default function AnnualPlanScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <AnnualContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

const isCarryover = (line: PlanLine): boolean => line.bucket === 'CARRYOVER';

function AnnualContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const mayDraft = canDraft(permissions, mode);
  const plans = usePlans();
  const annual = useMemo(() => plansOfKind(plans.data ?? [], 'ANNUAL'), [plans.data]);
  const { planId, choose } = usePlanChoice(annual);
  const detail = usePlanLines(planId);
  const state = useScreenState({ isLoading: plans.isLoading || detail.isLoading, error: plans.error ?? detail.error, data: annual });
  const plan = detail.data?.plan;
  const lines = detail.data?.lines ?? [];
  const totals = detail.data?.totals;

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('cap.annual.page.title')}</h1>
          <p>{t('cap.annual.page.subtitle')}</p>
        </div>
        {plan !== undefined && isDraft(plan) && mayDraft ? (
          <div className="cap-actions">
            <Link className="button" to={`${PROPOSAL_PATH}?plan=${plan.id}`}>
              {t('cap.annual.propose.action')}
            </Link>
            <Link className="button" to={`${ALLOCATION_GRID_PATH}?plan=${plan.id}`}>
              {t('cap.annual.edit.action')}
            </Link>
          </div>
        ) : null}
      </div>
      <StateBoundary state={state} onRetry={() => void plans.refetch()}>
        <PlanChooser id="annual-plan" plans={annual} value={planId} onChange={choose} />
        {plan === undefined ? null : <PlanHeader plan={plan} />}
        {lines.length === 0 ? (
          <p className="callout" role="status" data-testid="no-lines">
            {t('cap.annual.noLines.notice')}
          </p>
        ) : (
          <div className="card cap-scroll">
            <table className="table cap-table" data-testid="lines" aria-label={t('cap.annual.table.aria')}>
              <caption className="sr-only">{t('cap.annual.table.caption')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('cap.annual.column.year')}</th>
                  <th scope="col">{t('cap.annual.column.project')}</th>
                  <th scope="col">{t('cap.annual.column.fund')}</th>
                  <th scope="col" className="cap-number">
                    {t('cap.annual.column.yearAmount')}
                  </th>
                  <th scope="col" className="cap-number">
                    {t('cap.annual.column.carryAmount')}
                  </th>
                  <th scope="col">{t('cap.annual.column.sourceYear')}</th>
                  <th scope="col">{t('cap.annual.column.extendedTo')}</th>
                  <th scope="col">{t('cap.annual.column.extensionDocument')}</th>
                  <th scope="col" className="cap-number">
                    {t('cap.annual.column.ctmtqg')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line) => (
                  <tr key={line.id} data-line-id={line.id} data-bucket={line.bucket}>
                    <td>{plan?.planYear ?? line.appropriation?.planYear}</td>
                    <th scope="row">
                      {line.project.code} <small className="sub">{line.project.name}</small>
                    </th>
                    <td>
                      {line.fundSource.businessKey} <small className="sub">{bucketLabel(t, line.bucket)}</small>
                    </td>
                    <td className="cap-number" data-testid="year-amount">
                      {isCarryover(line) ? '' : <Money vnd={line.amountVnd} />}
                    </td>
                    <td className="cap-number" data-testid="carry-amount">
                      {isCarryover(line) ? <Money vnd={line.amountVnd} /> : ''}
                    </td>
                    <td>{line.sourceYear}</td>
                    <td>{line.extendedTo ?? ''}</td>
                    <td>{line.extensionDocument === null ? '' : (line.extensionDocument.symbol ?? t('cap.decision.noSymbol.label'))}</td>
                    <td className="cap-number" data-testid="ctmtqg">
                      {line.ctmtqgSubsetVnd === '0' ? '' : <Money vnd={line.ctmtqgSubsetVnd} />}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr data-testid="totals">
                  <th scope="row" colSpan={3}>
                    {t('cap.annual.total.label')}
                  </th>
                  <td className="cap-number" colSpan={2} data-testid="total">
                    <Money vnd={totals?.allocatedVnd ?? '0'} />
                  </td>
                  <td colSpan={2}>{t('cap.annual.total.note')}</td>
                  <td />
                  <td className="cap-number" data-testid="total-ctmtqg">
                    <Money vnd={totals?.ctmtqgSubsetVnd ?? '0'} />
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </StateBoundary>
      <p className="prototype-note">{t('cap.annual.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
