import { ApiError } from '@machvon/api-client';
import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { ContextBar, DataTable, FilterPanel, SectionCard } from '../../ui';
import type { DataTableColumn } from '../../ui';
import { Field, Money } from './components';
import { PlanChooser, SignedMoney } from './plan-components';
import { usePlans } from './plan-hooks';
import { planStatusLabel } from './plan-labels';
import type { PlanSummary } from './plan-model';
import { usePlanAsOf } from './revision-hooks';
import { ADJUSTMENT_PATH, asOfDate, trackedPlans } from './revision-model';
import type { PlanAsOf } from './revision-model';
import './cap.css';

const NOT_FOUND = 404;

/**
 * CAP-15: the tracking of a capital plan. Each line shows what the first revision gave it (initial), what the revisions added or took
 * (adjustment), what the revision in force gives (current) and what was paid by the day chosen ("As of day"): the plan as it stood on
 * that day, with the decision that backed it. Only the lines in the scope of the caller are shown.
 */
export default function PlanTrackingScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <PlanTrackingContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function PlanTrackingContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const [typed, setTyped] = useState('');
  const plans = usePlans();
  const tracked = useMemo(() => trackedPlans(plans.data ?? []), [plans.data]);
  // The address may name any revision of a plan (the adjustment screen links to the one in work): the plan is the code it carries.
  const wantedCode = (plans.data ?? []).find((plan) => plan.id === params.get('plan'))?.planCode;
  const selected = tracked.find((plan) => plan.planCode === wantedCode) ?? tracked[0];
  const day = asOfDate(typed);
  const found = usePlanAsOf(selected?.id, day.valid ? day.at : undefined);
  // A plan that was not in force yet on the day is an answer, not a failure.
  const nothingInForce = found.error instanceof ApiError && found.error.status === NOT_FOUND;
  const state = useScreenState({
    isLoading: plans.isLoading || (found.isLoading && selected !== undefined),
    error: plans.error ?? (nothingInForce ? undefined : found.error),
    data: plans.data,
    isEmpty: () => tracked.length === 0,
  });
  const choose = (id: string): void => {
    const next = new URLSearchParams(params);
    next.set('plan', id);
    setParams(next, { replace: true });
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('cap.tracking.page.title')}</h1>
          <p>{t('cap.tracking.page.subtitle')}</p>
        </div>
      </div>
      <StateBoundary
        state={state}
        onRetry={() => {
          void plans.refetch();
          void found.refetch();
        }}
      >
        {selected === undefined ? null : (
          <>
            <ContextBar
              items={[
                { label: t('cap.tracking.ctx.plan'), value: selected.planCode },
                {
                  label: t('cap.tracking.ctx.day'),
                  value: day.valid && typed !== '' ? typed : t('cap.tracking.ctx.today'),
                },
              ]}
              unit={t('cap.ctx.unit')}
            />
            <FilterPanel applied={typed === '' ? 0 : 1}>
              <div className="cap-filters">
                <PlanChooser id="tracking-plan" plans={tracked} value={selected.id} onChange={choose} />
                <Field id="tracking-date" label={t('cap.tracking.date.label')} hint={t('cap.tracking.date.hint')} error={day.valid ? undefined : t('cap.tracking.date.invalid.error')}>
                  <input id="tracking-date" type="date" value={typed} aria-invalid={!day.valid} onChange={(event) => setTyped(event.target.value)} />
                </Field>
              </div>
            </FilterPanel>
            {nothingInForce ? (
              <p className="callout" role="status" data-testid="nothing">
                {t('cap.tracking.none.notice')}
              </p>
            ) : found.data === undefined ? null : (
              <Tracking found={found.data} revision={(plans.data ?? []).find((plan) => plan.id === found.data?.planId)} />
            )}
            <p>
              <Link to={`${ADJUSTMENT_PATH}?plan=${selected.id}`}>{t('cap.tracking.adjustment.link')}</Link>
            </p>
          </>
        )}
      </StateBoundary>
      <p className="prototype-note">
        {t('cap.tracking.footer.reference', {
          id: route.id,
          req: route.req ?? '',
        })}
      </p>
    </section>
  );
}

/** The revision that was in force on the day, line by line; `revision` is its header in the list, where its decision is named. */
function Tracking({ found, revision }: { found: PlanAsOf; revision: PlanSummary | undefined }) {
  const { t } = useTranslation();
  const symbol = revision?.decisionSymbol ?? null;
  const issued = revision?.decisionIssuedOn ?? null;
  const citation = symbol === null ? t('cap.planHeader.noDecision.notice') : issued === null ? symbol : t('cap.decision.citation.label', { symbol, date: issued });
  const columns: DataTableColumn<PlanAsOf['lines'][number]>[] = [
    {
      key: 'decision',
      header: t('cap.tracking.column.decision'),
      render: () => <span data-testid="decision">{citation}</span>,
    },
    {
      key: 'project',
      header: t('cap.tracking.column.project'),
      pinned: true,
      render: (row) => (
        <span data-project={row.line.project.code}>
          {row.line.project.code} <small className="sub">{row.line.project.name}</small>
        </span>
      ),
    },
    {
      key: 'initial',
      header: t('cap.tracking.column.initial'),
      align: 'right',
      render: (row) => (
        <span data-testid="initial">
          <Money vnd={row.initialVnd} />
        </span>
      ),
    },
    {
      key: 'adjustment',
      header: t('cap.tracking.column.adjustment'),
      align: 'right',
      render: (row) => (
        <span data-testid="adjustment">
          <SignedMoney vnd={row.adjustmentVnd} />
        </span>
      ),
    },
    {
      key: 'current',
      header: t('cap.tracking.column.current'),
      align: 'right',
      render: (row) => (
        <span data-testid="current">
          <Money vnd={row.line.amountVnd} />
        </span>
      ),
    },
    {
      key: 'disbursed',
      header: t('cap.tracking.column.disbursed'),
      align: 'right',
      render: (row) => (
        <span data-testid="disbursed">
          <Money vnd={row.disbursedVnd} />
        </span>
      ),
    },
  ];
  return (
    <div data-testid="tracking" data-plan-id={found.planId} data-revision={found.revision}>
      <SectionCard
        title={t('cap.tracking.revision.title', {
          code: found.planCode,
          revision: found.revision,
        })}
        unit={t('cap.ctx.unit')}
      >
        <p data-testid="in-force">
          {t('cap.tracking.revision.label', {
            status: planStatusLabel(t, found.status),
            date: (found.effectiveAt ?? '').slice(0, 10),
          })}
        </p>
        <p className="sub">{t('cap.tracking.scope.notice')}</p>
        {found.truncated ? (
          <p className="callout warning" role="status" data-testid="truncated">
            {t('cap.tracking.truncated.notice')}
          </p>
        ) : null}
        <DataTable
          caption={t('cap.tracking.table.aria', { code: found.planCode })}
          columns={columns}
          rows={found.lines}
          rowKey={(row) => row.line.id}
          rowAttrs={(row) => ({ 'data-project': row.line.project.code })}
          totalsLabel={t('cap.tracking.total.label', {
            count: found.lines.length,
          })}
          totals={{
            initial: (
              <span data-testid="total-initial">
                <Money vnd={found.totals.initialVnd} />
              </span>
            ),
            adjustment: (
              <span data-testid="total-adjustment">
                <SignedMoney vnd={found.totals.adjustmentVnd} />
              </span>
            ),
            current: (
              <span data-testid="total-current">
                <Money vnd={found.totals.currentVnd} />
              </span>
            ),
            disbursed: (
              <span data-testid="total-disbursed">
                <Money vnd={found.totals.disbursedVnd} />
              </span>
            ),
          }}
        />
      </SectionCard>
    </div>
  );
}
