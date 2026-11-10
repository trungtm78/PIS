import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useEdition } from '../../editions/EditionContext';
import { useFundName } from '../../editions/fund-name';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { APPROVAL_PATH, baseOf } from './approval-model';
import { Field, Money } from './components';
import { PlanChooser, PlanCitation, PlanHeader, SignedMoney } from './plan-components';
import { usePlanLines, usePlans } from './plan-hooks';
import { ALLOCATION_GRID_PATH } from './plan-model';
import type { PlanSummary } from './plan-model';
import { useCreateRevision } from './revision-hooks';
import { reasonProblemMessage, revisionProblemMessage } from './revision-labels';
import { REASON_MAX, TRACKING_PATH, describeRevisionProblem, mayRevise, pendingRevisionOf, transferBetween, validateRevisionReason } from './revision-model';
import type { ReasonProblem, Transfer } from './revision-model';
import './cap.css';

/**
 * CAP-07: the adjustment of a published capital plan. The planner asks for a revision with a reason (the lines are copied into a draft that
 * is edited, approved and published like any plan), and the screen shows what the revision moves: the lines that give capital up beside the
 * lines that receive it, with the exact totals of both sides, so that a transfer between projects is seen to keep the total.
 */
export default function PlanAdjustmentScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <PlanAdjustmentContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function PlanAdjustmentContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const [params, setParams] = useSearchParams();
  const plans = usePlans();
  const list = useMemo(() => plans.data ?? [], [plans.data]);
  const wanted = params.get('plan');
  const selected = list.find((plan) => plan.id === wanted) ?? list.find((plan) => plan.status === 'PUBLISHED') ?? list[0];
  const base = selected === undefined ? undefined : baseOf(selected, list);
  const lines = usePlanLines(selected?.id);
  const baseLines = usePlanLines(base?.id);
  const state = useScreenState({ isLoading: plans.isLoading || lines.isLoading || baseLines.isLoading, error: plans.error ?? lines.error ?? baseLines.error, data: plans.data });
  const transfer = useMemo(() => (base === undefined || lines.data === undefined || baseLines.data === undefined ? undefined : transferBetween(lines.data.lines, baseLines.data.lines)), [base, lines.data, baseLines.data]);
  const revise = useCreateRevision();
  const choose = (id: string): void => {
    const next = new URLSearchParams(params);
    next.set('plan', id);
    setParams(next, { replace: true });
    revise.reset();
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('cap.adjustment.page.title')}</h1>
          <p>{t('cap.adjustment.page.subtitle')}</p>
        </div>
      </div>
      <StateBoundary state={state} onRetry={() => void plans.refetch()}>
        {selected === undefined ? null : (
          <>
            <div className="card">
              <PlanChooser id="adjustment-plan" plans={list} value={selected.id} onChange={choose} />
            </div>
            <PlanHeader plan={selected} />
            <ReviseCard
              plan={selected}
              plans={list}
              permissions={permissions}
              mode={mode}
              pending={revise.isPending}
              failure={revise.error}
              createdId={revise.isSuccess ? revise.data.resource_id : undefined}
              onRevise={(reason) => revise.mutate({ planId: selected.id, version: selected.version, reason })}
              onOpen={choose}
            />
            <TransferCard plan={selected} base={base} transfer={transfer} />
          </>
        )}
      </StateBoundary>
      <p className="prototype-note">{t('cap.adjustment.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

interface ReviseCardProps {
  plan: PlanSummary;
  plans: readonly PlanSummary[];
  permissions: readonly string[] | undefined;
  mode: string | undefined;
  pending: boolean;
  failure: unknown;
  /** The revision the command just made. */
  createdId: string | undefined;
  onRevise: (reason: string) => void;
  onOpen: (id: string) => void;
}

function ReviseCard({ plan, plans, permissions, mode, pending, failure, createdId, onRevise, onOpen }: ReviseCardProps) {
  const { t } = useTranslation();
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<ReasonProblem | undefined>(undefined);
  const inWork = pendingRevisionOf(plan, plans);
  const refusal = failure === null || failure === undefined ? undefined : describeRevisionProblem(failure);

  if (plan.status !== 'PUBLISHED') {
    return (
      <div className="card" data-testid="revise">
        <p className="callout" role="status" data-testid="revise-state" data-state="not-published">
          {t('cap.adjustment.notPublished.notice')}
        </p>
      </div>
    );
  }
  if (inWork !== undefined) {
    return (
      <div className="card" data-testid="revise">
        {createdId === inWork.id ? (
          // The revision this screen just made is the one in work: the notice of the command is not lost when the list is read again.
          <p className="callout" role="status" data-testid="created">
            {t('cap.adjustment.revise.done')}
          </p>
        ) : null}
        <p className="callout" role="status" data-testid="revise-state" data-state="pending">
          {t('cap.adjustment.pending.notice', { code: inWork.planCode, revision: inWork.revision })}
        </p>
        <p>
          <button type="button" onClick={() => onOpen(inWork.id)}>
            {t('cap.adjustment.pending.open')}
          </button>
        </p>
      </div>
    );
  }
  if (!mayRevise(plan, plans, permissions, mode)) {
    return (
      <div className="card" data-testid="revise">
        <p className="callout" role="status" data-testid="revise-state" data-state="denied">
          {mode === 'READ_ONLY' ? t('cap.readOnly.frozen.notice') : t('cap.adjustment.denied.notice')}
        </p>
      </div>
    );
  }
  const send = (event: FormEvent): void => {
    event.preventDefault();
    if (pending) return;
    const found = validateRevisionReason(reason);
    setProblem(found);
    if (found === undefined) onRevise(reason.trim());
  };
  return (
    <form className="card cap-decision" data-testid="revise" aria-label={t('cap.adjustment.revise.title')} onSubmit={send} noValidate>
      <h2>{t('cap.adjustment.revise.title')}</h2>
      {createdId === undefined ? null : (
        <p className="callout" role="status" data-testid="created">
          {t('cap.adjustment.revise.done')}{' '}
          <button type="button" onClick={() => onOpen(createdId)}>
            {t('cap.adjustment.revise.open')}
          </button>
        </p>
      )}
      {refusal === undefined ? null : (
        <p className="callout warning" role="alert" data-testid="problem" data-problem={refusal}>
          {revisionProblemMessage(t, refusal)}
        </p>
      )}
      <Field id="revision-reason" label={t('cap.adjustment.reason.label')} error={problem === undefined ? undefined : reasonProblemMessage(t, problem)} hint={t('cap.adjustment.reason.hint')}>
        <textarea
          id="revision-reason"
          value={reason}
          maxLength={REASON_MAX}
          aria-invalid={problem !== undefined}
          onChange={(event) => {
            setReason(event.target.value);
            setProblem(undefined);
          }}
        />
      </Field>
      <div className="formfooter">
        <button type="submit" className="button primary" disabled={pending}>
          {pending ? t('cap.adjustment.revise.pending') : t('cap.adjustment.revise.action')}
        </button>
      </div>
    </form>
  );
}

interface TransferCardProps {
  plan: PlanSummary;
  base: PlanSummary | undefined;
  transfer: Transfer | undefined;
}

function TransferCard({ plan, base, transfer }: TransferCardProps) {
  const { t } = useTranslation();
  if (base === undefined || transfer === undefined) {
    return (
      <p className="callout" role="status" data-testid="no-base">
        {t('cap.adjustment.transfer.noBase.notice')}
      </p>
    );
  }
  const none = transfer.down.length === 0 && transfer.up.length === 0;
  return (
    <div className="card" data-testid="transfer">
      <h2>{t('cap.adjustment.transfer.title')}</h2>
      <p>{t('cap.adjustment.transfer.base.label', { code: base.planCode, revision: base.revision })}</p>
      {none ? (
        <p className="callout" role="status" data-testid="transfer-none">
          {t('cap.adjustment.transfer.none.notice')}
        </p>
      ) : (
        <>
          <p className={transfer.balanced ? 'callout' : 'callout warning'} role="status" data-testid="balance" data-balanced={transfer.balanced ? 'true' : 'false'}>
            {transfer.balanced ? t('cap.adjustment.balance.same.notice') : t('cap.adjustment.balance.changed.notice')} <SignedMoney vnd={transfer.netVnd} />
          </p>
          <TransferSide kind="down" rows={transfer.down} total={transfer.downVnd} basis={base} />
          <TransferSide kind="up" rows={transfer.up} total={transfer.upVnd} basis={plan} />
        </>
      )}
      <p>
        <Link to={`${ALLOCATION_GRID_PATH}?plan=${plan.id}`}>{t('cap.adjustment.edit.link')}</Link> · <Link to={`${APPROVAL_PATH}?plan=${plan.id}`}>{t('cap.adjustment.approval.link')}</Link> ·{' '}
        <Link to={`${TRACKING_PATH}?plan=${plan.id}`}>{t('cap.adjustment.tracking.link')}</Link>
      </p>
    </div>
  );
}

interface TransferSideProps {
  kind: 'down' | 'up';
  rows: Transfer['down'];
  total: string;
  /** The plan whose decision backs this side: the plan in force for what is given up, the revision for what is received. */
  basis: PlanSummary;
}

function TransferSide({ kind, rows, total, basis }: TransferSideProps) {
  const { t } = useTranslation();
  const enterprise = useEdition().manifest.edition === 'enterprise';
  const fundName = useFundName();
  const title = kind === 'down' ? t('cap.adjustment.down.title') : t('cap.adjustment.up.title');
  if (rows.length === 0) {
    return (
      <p data-testid={`side-${kind}`} data-empty="true">
        {title}: {t('cap.adjustment.side.none.notice')}
      </p>
    );
  }
  return (
    <div className="cap-scroll" data-testid={`side-${kind}`}>
      <table className="table cap-table" aria-label={title}>
        <caption>{title}</caption>
        <thead>
          <tr>
            <th scope="col">{t('cap.adjustment.column.project')}</th>
            <th scope="col">{t('cap.adjustment.column.fund')}</th>
            <th scope="col" className="cap-number">
              {t('cap.adjustment.column.value')}
            </th>
            <th scope="col">{t('cap.adjustment.column.basis')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} data-kind={row.kind}>
              <th scope="row">
                {row.projectCode} <small className="sub">{row.projectName}</small>
              </th>
              <td>{enterprise ? fundName(row.fundLabel, row.fundName) : row.fundLabel}</td>
              <td className="cap-number" data-testid="value">
                <Money vnd={row.deltaVnd.replace('-', '')} />
              </td>
              <td>
                <PlanCitation plan={basis} />
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row" colSpan={2}>
              {t('cap.adjustment.total.label')}
            </th>
            <td className="cap-number" data-testid="side-total">
              <Money vnd={total} />
            </td>
            <td />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
