import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { useHouseholds } from '../household/hooks';
import { useProjectOptions, useUnits } from '../read-hooks';
import { DraftDialog, ItemDialog, ReviseDialog } from './dialogs';
import { usePlanItems, usePlans } from './hooks';
import { executorKindLabel, planItemKindLabel, planStatusLabel } from './labels';
import { PLAN_STATUSES, acceptsItems, canRevise, canWritePlan, formatVnd, plansOf } from './model';
import type { PlanItem, PlanLine, PlanStatus } from './model';
import { ScrollRegion } from '../../scroll-region';
import '../lnd.css';

type Dialog = { kind: 'draft' } | { kind: 'items'; plan: PlanLine } | { kind: 'revise'; plan: PlanLine };

/**
 * LND-05: the plan of compensation, support and resettlement (ST-LND-005, BR-LND-05). Every revision of the plans of a project is listed with its totals; a plan that is a draft takes items, and one that was
 * posted or approved is revised into a new revision while the earlier one stays readable. A compensation is counted from a confirmed record of the inventory at the price decision it was counted by; a support or
 * a resettlement is an amount of a policy with its legal basis. The items of a plan are read inside the units of the reader. The server judges every request again.
 */
export default function PlanScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The plans and the dialogs belong to one membership: a switch of tenant or of membership starts the screen over.
  return <PlanContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function PlanContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const [params, setParams] = useSearchParams();
  const projectId = params.get('project') ?? undefined;
  const planId = params.get('plan') ?? undefined;
  const projects = useProjectOptions();
  const plans = usePlans(projectId);
  const mayWrite = canWritePlan(permissions, mode);
  const units = useUnits(mayWrite && projectId !== undefined);
  const households = useHouseholds(mayWrite && projectId !== undefined ? projectId : undefined);
  const [status, setStatus] = useState<'' | PlanStatus>('');
  const [dialog, setDialog] = useState<Dialog | undefined>(undefined);
  const selected = plans.data?.find((plan) => plan.id === planId);
  const items = usePlanItems(selected?.id);
  const state = useScreenState({ isLoading: plans.isLoading, error: plans.error, data: plans.data, isEmpty: () => false });
  const shown = useMemo(() => plansOf(plans.data ?? [], status), [plans.data, status]);

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('lnd.plans.page.title')}</h1>
          <p>{t('lnd.plans.page.subtitle')}</p>
        </div>
        {mayWrite && projectId !== undefined ? (
          <div className="actions">
            <button type="button" className="primary" onClick={() => setDialog({ kind: 'draft' })}>
              {t('lnd.plans.draft.action')}
            </button>
          </div>
        ) : null}
      </div>
      <p className="callout" data-testid="privacy-note">
        {t('lnd.plans.privacy.note')}
      </p>
      <div className="card">
        <div className="field">
          <label htmlFor="plan-project">{t('lnd.plans.project.label')}</label>
          <select
            id="plan-project"
            value={projectId ?? ''}
            onChange={(event) => {
              setStatus('');
              setParams(event.target.value === '' ? {} : { project: event.target.value });
            }}
          >
            <option value="">{t('lnd.plans.project.choose')}</option>
            {(projects.data ?? []).map((project) => (
              <option key={project.id} value={project.id}>
                {`${project.code} · ${project.name}`}
              </option>
            ))}
          </select>
        </div>
      </div>
      <PlanTotals plan={projectId === undefined ? undefined : inForce(plans.data ?? [])} />
      {projectId === undefined ? (
        <div className="card">
          <PlansTable empty={t('lnd.plans.project.notice')} emptyTestId="choose-project">
            {null}
          </PlansTable>
        </div>
      ) : (
        <StateBoundary state={state} onRetry={() => void plans.refetch()}>
          <div className="card">
            <form className="lnd-filters" role="search" aria-label={t('lnd.plans.filters.title')} onSubmit={(event) => event.preventDefault()}>
              <div className="field">
                <label htmlFor="plan-status">{t('lnd.plans.status.label')}</label>
                <select id="plan-status" value={status} onChange={(event) => setStatus(event.target.value as '' | PlanStatus)}>
                  <option value="">{t('lnd.plans.status.all')}</option>
                  {PLAN_STATUSES.map((value) => (
                    <option key={value} value={value}>
                      {planStatusLabel(t, value)}
                    </option>
                  ))}
                </select>
              </div>
            </form>
            <PlansTable empty={shown.length > 0 ? undefined : (plans.data ?? []).length === 0 ? t('lnd.plans.empty.notice') : t('lnd.plans.noMatch.notice')} emptyTestId="no-match">
              {shown.map((plan) => (
                <PlanRow
                  key={plan.id}
                  plan={plan}
                  open={plan.id === selected?.id}
                  canAdd={mayWrite && acceptsItems(plan)}
                  canReviseIt={mayWrite && canRevise(plan)}
                  onOpen={() => setParams({ project: projectId, plan: plan.id })}
                  onAdd={() => setDialog({ kind: 'items', plan })}
                  onRevise={() => setDialog({ kind: 'revise', plan })}
                />
              ))}
            </PlansTable>
          </div>
          {selected === undefined ? null : <PlanDetail plan={selected} items={items.data ?? []} loading={items.isLoading} failed={items.isError} />}
        </StateBoundary>
      )}
      {dialog?.kind === 'draft' && projectId !== undefined ? <DraftDialog projectId={projectId} units={units.data ?? []} onClose={() => setDialog(undefined)} /> : null}
      {dialog?.kind === 'items' ? <ItemDialog plan={dialog.plan} households={households.data ?? []} items={dialog.plan.id === selected?.id ? (items.data ?? []) : []} onClose={() => setDialog(undefined)} /> : null}
      {dialog?.kind === 'revise' ? <ReviseDialog plan={dialog.plan} onClose={() => setDialog(undefined)} /> : null}
      <p className="prototype-note">{t('lnd.plans.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

/** The statuses of a plan that a decision approved (BR-LND-05): the plan in force is the newest revision among them. */
const DECIDED: readonly PlanStatus[] = ['APPROVED', 'PAYING', 'COMPLETED'];

/** The plan of the project that a decision approved, the newest revision first; none before the first approval. */
function inForce(plans: readonly PlanLine[]): PlanLine | null {
  return [...plans].filter((plan) => DECIDED.includes(plan.status)).sort((left, right) => right.revision - left.revision)[0] ?? null;
}

/** The totals of the plan in force: what the decision approved for compensation, support and resettlement, and the sum (computed by the server). */
function PlanTotals({ plan }: { plan: PlanLine | null | undefined }) {
  const { t } = useTranslation();
  const value = (amount: string | undefined): string => (amount === undefined ? t('scr2.lnd.plans.totals.none') : formatVnd(amount));
  return (
    <div className="card" data-testid="plan-totals">
      <h2>{t('scr2.lnd.plans.totals.title')}</h2>
      <p className="sub">
        {plan === undefined ? t('lnd.plans.project.notice') : plan === null ? t('scr2.lnd.plans.totals.noDecision') : t('scr2.lnd.plans.totals.of', { code: plan.planCode, revision: plan.revision })}
      </p>
      <dl className="lnd-totals">
        <dt>{t('scr2.lnd.plans.totals.compensation')}</dt>
        <dd className="lnd-numeric">{value(plan?.totalCompensationVnd)}</dd>
        <dt>{t('scr2.lnd.plans.totals.support')}</dt>
        <dd className="lnd-numeric">{value(plan?.totalSupportVnd)}</dd>
        <dt>{t('scr2.lnd.plans.totals.resettlement')}</dt>
        <dd className="lnd-numeric">{value(plan?.totalResettlementVnd)}</dd>
        <dt>{t('scr2.lnd.plans.totals.grand')}</dt>
        <dd className="lnd-numeric">{value(plan?.grandTotalVnd)}</dd>
      </dl>
    </div>
  );
}

/** The columns of the plans, for the one row that stands in for none. */
const COLUMNS = 10;

/** The table of the plans of a project: its columns stand even before a project is chosen, and the one row then says what to choose. */
function PlansTable({ empty, emptyTestId, children }: { empty: string | undefined; emptyTestId: string; children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <ScrollRegion label={t('lnd.plans.page.title')}>
      <table className="table" data-testid="plans">
        <thead>
          <tr>
            <th scope="col">{t('lnd.plans.column.code')}</th>
            <th scope="col">{t('lnd.plans.column.revision')}</th>
            <th scope="col">{t('lnd.plans.column.executor')}</th>
            <th scope="col">{t('lnd.plans.column.compensation')}</th>
            <th scope="col">{t('lnd.plans.column.support')}</th>
            <th scope="col">{t('lnd.plans.column.resettlement')}</th>
            <th scope="col">{t('lnd.plans.column.grand')}</th>
            <th scope="col">{t('lnd.plans.column.status')}</th>
            <th scope="col">{t('scr2.lnd.plans.column.decision')}</th>
            <th scope="col">{t('lnd.plans.column.action')}</th>
          </tr>
        </thead>
        <tbody>
          {empty === undefined ? null : (
            <tr>
              <td colSpan={COLUMNS} role="status" data-testid={emptyTestId}>
                {empty}
              </td>
            </tr>
          )}
          {children}
        </tbody>
      </table>
    </ScrollRegion>
  );
}

interface RowProps {
  plan: PlanLine;
  open: boolean;
  canAdd: boolean;
  canReviseIt: boolean;
  onOpen(): void;
  onAdd(): void;
  onRevise(): void;
}

function PlanRow({ plan, open, canAdd, canReviseIt, onOpen, onAdd, onRevise }: RowProps) {
  const { t } = useTranslation();
  return (
    <tr data-plan-id={plan.id} aria-selected={open}>
      <th scope="row">{plan.planCode}</th>
      <td data-testid="revision">{plan.revision}</td>
      <td>{executorKindLabel(t, plan.executorKind)}</td>
      <td className="lnd-numeric" data-testid="total-compensation">
        {formatVnd(plan.totalCompensationVnd)}
      </td>
      <td className="lnd-numeric" data-testid="total-support">
        {formatVnd(plan.totalSupportVnd)}
      </td>
      <td className="lnd-numeric" data-testid="total-resettlement">
        {formatVnd(plan.totalResettlementVnd)}
      </td>
      <td className="lnd-numeric" data-testid="total-grand">
        {formatVnd(plan.grandTotalVnd)}
      </td>
      <td>
        <span className="lnd-badge" data-testid="status">
          {planStatusLabel(t, plan.status)}
        </span>
        {plan.revisionReason === null ? null : (
          <>
            <br />
            <small className="sub" data-testid="reason">
              {plan.revisionReason}
            </small>
          </>
        )}
      </td>
      <td data-testid="decision">{plan.approvedOn === null ? t('scr2.lnd.plans.decision.none') : t('scr2.lnd.plans.decision.line', { on: plan.approvedOn, doc: plan.decisionDocumentVersionId?.slice(0, 8) ?? '' })}</td>
      <td>
        <button type="button" className="button" aria-label={t('lnd.plans.open.aria', { code: plan.planCode, revision: plan.revision })} onClick={onOpen}>
          {t('lnd.plans.open.action')}
        </button>
        {canAdd ? (
          <button type="button" className="button" aria-label={t('lnd.plans.items.aria', { code: plan.planCode, revision: plan.revision })} onClick={onAdd}>
            {t('lnd.plans.items.action')}
          </button>
        ) : null}
        {canReviseIt ? (
          <button type="button" className="button" aria-label={t('lnd.plans.revise.aria', { code: plan.planCode, revision: plan.revision })} onClick={onRevise}>
            {t('lnd.plans.revise.action')}
          </button>
        ) : null}
      </td>
    </tr>
  );
}

function PlanDetail({ plan, items, loading, failed }: { plan: PlanLine; items: readonly PlanItem[]; loading: boolean; failed: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="card" data-testid="plan-detail">
      <h2>{t('lnd.plans.detail.title', { code: plan.planCode, revision: plan.revision })}</h2>
      {failed ? (
        <p className="callout warning" role="alert" data-testid="items-failed">
          {t('lnd.plans.items.failed')}
        </p>
      ) : loading ? (
        <p role="status">{t('lnd.plans.items.loading')}</p>
      ) : items.length === 0 ? (
        <p className="callout" role="status" data-testid="items-empty">
          {t('lnd.plans.items.empty')}
        </p>
      ) : (
        <table className="table" data-testid="items">
          <thead>
            <tr>
              <th scope="col">{t('lnd.plans.itemColumn.household')}</th>
              <th scope="col">{t('lnd.plans.itemColumn.kind')}</th>
              <th scope="col">{t('lnd.plans.itemColumn.parcel')}</th>
              <th scope="col">{t('lnd.plans.itemColumn.count')}</th>
              <th scope="col">{t('lnd.plans.itemColumn.amount')}</th>
              <th scope="col">{t('lnd.plans.itemColumn.decision')}</th>
              <th scope="col">{t('lnd.plans.itemColumn.legalBasis')}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id} data-item-id={item.id}>
                <th scope="row">{item.householdCode}</th>
                <td>{planItemKindLabel(t, item.itemKind)}</td>
                <td>{item.parcelCode ?? t('lnd.plans.item.none')}</td>
                <td data-testid="count" className="lnd-numeric">
                  {item.quantity === null || item.unitPriceVnd === null
                    ? t('lnd.plans.item.none')
                    : t('lnd.plans.item.count', { quantity: item.quantity, unit: item.unitCode ?? '', price: formatVnd(item.unitPriceVnd) })}
                </td>
                <td data-testid="amount" className="lnd-numeric">
                  {formatVnd(item.amountVnd)}
                </td>
                <td data-testid="decision">{item.priceDecisionRef === null ? t('lnd.plans.item.none') : t('lnd.plans.item.decision', { ref: item.priceDecisionRef, revision: item.priceDecisionRevision ?? 0 })}</td>
                <td>{item.legalBasis}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
