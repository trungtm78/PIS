import { ApiError } from '@machvon/api-client';
import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
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
      <StateBoundary state={state} onRetry={() => {
          void plans.refetch();
          void found.refetch();
        }}>
        {selected === undefined ? null : (
          <>
            <div className="card cap-filters">
              <PlanChooser id="tracking-plan" plans={tracked} value={selected.id} onChange={choose} />
              <Field id="tracking-date" label={t('cap.tracking.date.label')} hint={t('cap.tracking.date.hint')} error={day.valid ? undefined : t('cap.tracking.date.invalid.error')}>
                <input id="tracking-date" type="date" value={typed} aria-invalid={!day.valid} onChange={(event) => setTyped(event.target.value)} />
              </Field>
            </div>
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
      <p className="prototype-note">{t('cap.tracking.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

/** The revision that was in force on the day, line by line; `revision` is its header in the list, where its decision is named. */
function Tracking({ found, revision }: { found: PlanAsOf; revision: PlanSummary | undefined }) {
  const { t } = useTranslation();
  const symbol = revision?.decisionSymbol ?? null;
  const issued = revision?.decisionIssuedOn ?? null;
  const citation = symbol === null ? t('cap.planHeader.noDecision.notice') : issued === null ? symbol : t('cap.decision.citation.label', { symbol, date: issued });
  return (
    <div className="card" data-testid="tracking" data-plan-id={found.planId} data-revision={found.revision}>
      <h2>{t('cap.tracking.revision.title', { code: found.planCode, revision: found.revision })}</h2>
      <p data-testid="in-force">{t('cap.tracking.revision.label', { status: planStatusLabel(t, found.status), date: (found.effectiveAt ?? '').slice(0, 10) })}</p>
      <p className="sub">{t('cap.tracking.scope.notice')}</p>
      {found.truncated ? (
        <p className="callout warning" role="status" data-testid="truncated">
          {t('cap.tracking.truncated.notice')}
        </p>
      ) : null}
      <div className="cap-scroll">
        <table className="table cap-table" aria-label={t('cap.tracking.table.aria', { code: found.planCode })}>
          <caption className="sr-only">{t('cap.tracking.table.caption')}</caption>
          <thead>
            <tr>
              <th scope="col">{t('cap.tracking.column.decision')}</th>
              <th scope="col">{t('cap.tracking.column.project')}</th>
              <th scope="col" className="cap-number">
                {t('cap.tracking.column.initial')}
              </th>
              <th scope="col" className="cap-number">
                {t('cap.tracking.column.adjustment')}
              </th>
              <th scope="col" className="cap-number">
                {t('cap.tracking.column.current')}
              </th>
              <th scope="col" className="cap-number">
                {t('cap.tracking.column.disbursed')}
              </th>
            </tr>
          </thead>
          <tbody>
            {found.lines.map((row) => (
              <tr key={row.line.id} data-project={row.line.project.code}>
                <td data-testid="decision">{citation}</td>
                <th scope="row">
                  {row.line.project.code} <small className="sub">{row.line.project.name}</small>
                </th>
                <td className="cap-number" data-testid="initial">
                  <Money vnd={row.initialVnd} />
                </td>
                <td className="cap-number" data-testid="adjustment">
                  <SignedMoney vnd={row.adjustmentVnd} />
                </td>
                <td className="cap-number" data-testid="current">
                  <Money vnd={row.line.amountVnd} />
                </td>
                <td className="cap-number" data-testid="disbursed">
                  <Money vnd={row.disbursedVnd} />
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row" colSpan={2}>
                {t('cap.tracking.total.label', { count: found.lines.length })}
              </th>
              <td className="cap-number" data-testid="total-initial">
                <Money vnd={found.totals.initialVnd} />
              </td>
              <td className="cap-number" data-testid="total-adjustment">
                <SignedMoney vnd={found.totals.adjustmentVnd} />
              </td>
              <td className="cap-number" data-testid="total-current">
                <Money vnd={found.totals.currentVnd} />
              </td>
              <td className="cap-number" data-testid="total-disbursed">
                <Money vnd={found.totals.disbursedVnd} />
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
