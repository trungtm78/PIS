import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { ContextBar, DataTable, SectionCard } from '../../ui';
import type { DataTableColumn } from '../../ui';
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
  const state = useScreenState({
    isLoading: plans.isLoading || detail.isLoading,
    error: plans.error ?? detail.error,
    data: annual,
  });
  const plan = detail.data?.plan;
  const lines = detail.data?.lines ?? [];
  const totals = detail.data?.totals;
  const columns: DataTableColumn<(typeof lines)[number]>[] = [
    {
      key: 'year',
      header: t('cap.annual.column.year'),
      render: (line) => plan?.planYear ?? line.appropriation?.planYear,
    },
    {
      key: 'project',
      header: t('cap.annual.column.project'),
      pinned: true,
      render: (line) => (
        <span data-line-id={line.id} data-bucket={line.bucket}>
          {line.project.code} <small className="sub">{line.project.name}</small>
        </span>
      ),
    },
    {
      key: 'fund',
      header: t('cap.annual.column.fund'),
      render: (line) => (
        <>
          {line.fundSource.businessKey} <small className="sub">{bucketLabel(t, line.bucket)}</small>
        </>
      ),
    },
    {
      key: 'yearAmount',
      header: t('cap.annual.column.yearAmount'),
      align: 'right',
      render: (line) => <span data-testid="year-amount">{isCarryover(line) ? '' : <Money vnd={line.amountVnd} />}</span>,
    },
    {
      key: 'carryAmount',
      header: t('cap.annual.column.carryAmount'),
      align: 'right',
      render: (line) => <span data-testid="carry-amount">{isCarryover(line) ? <Money vnd={line.amountVnd} /> : ''}</span>,
    },
    {
      key: 'sourceYear',
      header: t('cap.annual.column.sourceYear'),
      render: (line) => line.sourceYear,
    },
    {
      key: 'extendedTo',
      header: t('cap.annual.column.extendedTo'),
      render: (line) => line.extendedTo ?? '',
    },
    {
      key: 'extensionDocument',
      header: t('cap.annual.column.extensionDocument'),
      render: (line) => (line.extensionDocument === null ? '' : (line.extensionDocument.symbol ?? t('cap.decision.noSymbol.label'))),
    },
    {
      key: 'ctmtqg',
      header: t('cap.annual.column.ctmtqg'),
      align: 'right',
      render: (line) => <span data-testid="ctmtqg">{line.ctmtqgSubsetVnd === '0' ? '' : <Money vnd={line.ctmtqgSubsetVnd} />}</span>,
    },
  ];

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('cap.annual.page.title')}</h1>
          <p>{t('cap.annual.page.subtitle')}</p>
        </div>
        {plan !== undefined && isDraft(plan) && mayDraft ? (
          <div className="cap-actions">
            <Link className="ui-button ui-button--outline" to={`${PROPOSAL_PATH}?plan=${plan.id}`}>
              {t('cap.annual.propose.action')}
            </Link>
            <Link className="ui-button ui-button--outline" to={`${ALLOCATION_GRID_PATH}?plan=${plan.id}`}>
              {t('cap.annual.edit.action')}
            </Link>
          </div>
        ) : null}
      </div>
      <StateBoundary state={state} onRetry={() => void plans.refetch()}>
        <ContextBar items={[{ label: t('cap.ctx.plans'), value: String(annual.length) }]} unit={t('cap.ctx.unit')} />
        <PlanChooser id="annual-plan" plans={annual} value={planId} onChange={choose} />
        {plan === undefined ? null : <PlanHeader plan={plan} />}
        {lines.length === 0 ? (
          <p className="callout" role="status" data-testid="no-lines">
            {t('cap.annual.noLines.notice')}
          </p>
        ) : (
          <SectionCard title={t('cap.annual.table.aria')} unit={t('cap.ctx.unit')}>
            <div data-testid="lines">
              <DataTable caption={t('cap.annual.table.caption')} columns={columns} rows={lines} rowKey={(line) => line.id} />
            </div>
            <dl className="cap-totals" data-testid="totals">
              <div>
                <dt>{t('cap.annual.total.label')}</dt>
                <dd data-testid="total">
                  <Money vnd={totals?.allocatedVnd ?? '0'} />
                </dd>
              </div>
              <div>
                <dt>{t('cap.annual.column.ctmtqg')}</dt>
                <dd data-testid="total-ctmtqg">
                  <Money vnd={totals?.ctmtqgSubsetVnd ?? '0'} />
                </dd>
              </div>
              <p className="sub">{t('cap.annual.total.note')}</p>
            </dl>
          </SectionCard>
        )}
      </StateBoundary>
      <p className="prototype-note">
        {t('cap.annual.footer.reference', {
          id: route.id,
          req: route.req ?? '',
        })}
      </p>
    </section>
  );
}
