import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { useDecidePlan, usePublishPlan, useSubmitPlan } from './approval-hooks';
import { approvalProblemMessage, belowCommittedText, decisionDoneNotice, impactKindLabel, publishProblemMessage, reasonProblemMessage, stateNotice } from './approval-labels';
import {
  DECIDE_PERMISSION,
  EMPTY_PUBLISH_FORM,
  PUBLISH_PERMISSION,
  REASON_MAX,
  REASON_MIN,
  SUBMIT_PERMISSION,
  baseOf,
  computeImpact,
  describeApprovalProblem,
  firstToWorkOn,
  mayAct,
  publishBody,
  validatePublishForm,
  validateReason,
} from './approval-model';
import type { PublishField, PublishForm, PublishProblem, ReasonProblem } from './approval-model';
import { Field, Money } from './components';
import { PlanChooser, PlanHeader, SignedMoney } from './plan-components';
import { usePlanLines, usePlans } from './plan-hooks';
import { ALLOCATION_GRID_PATH } from './plan-model';
import type { PlanSummary } from './plan-model';
import './cap.css';

/**
 * CAP-10: the approval of a capital plan revision. The person sees the revision beside the one it replaces, line by line (what grows, what
 * shrinks, what is new or dropped, and which lines are below what is already committed and disbursed), and acts on the step the revision is
 * at: the planner submits a draft, an approver who did not make it approves, returns or rejects it with a reason, and a publisher gives the
 * decision document and publishes it. Every step is judged again by the server (four eyes, the permission, the unit of the plan).
 */
export default function PlanApprovalScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <PlanApprovalContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function PlanApprovalContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { permissions, mode } = useSession();
  const [params, setParams] = useSearchParams();
  const plans = usePlans();
  const list = useMemo(() => plans.data ?? [], [plans.data]);
  const wanted = params.get('plan');
  const selected = list.find((plan) => plan.id === wanted) ?? firstToWorkOn(list);
  const base = selected === undefined ? undefined : baseOf(selected, list);
  const lines = usePlanLines(selected?.id);
  const baseLines = usePlanLines(base?.id);
  const state = useScreenState({ isLoading: plans.isLoading || lines.isLoading || baseLines.isLoading, error: plans.error ?? lines.error ?? baseLines.error, data: plans.data });
  const impact = useMemo(() => (lines.data === undefined ? undefined : computeImpact(lines.data.lines, baseLines.data?.lines ?? [])), [lines.data, baseLines.data]);
  const submit = useSubmitPlan();
  const decide = useDecidePlan();
  const publish = usePublishPlan();
  const failure = submit.error ?? decide.error ?? publish.error;
  const problem = failure === null ? undefined : describeApprovalProblem(failure);
  const projectOf = (lineId: string): string | undefined => lines.data?.lines.find((line) => line.id === lineId)?.project.code;
  const choose = (id: string): void => {
    const next = new URLSearchParams(params);
    next.set('plan', id);
    setParams(next, { replace: true });
    submit.reset();
    decide.reset();
    publish.reset();
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('cap.approval.page.title')}</h1>
          <p>{t('cap.approval.page.subtitle')}</p>
        </div>
      </div>
      <StateBoundary state={state} onRetry={() => void plans.refetch()}>
        {selected === undefined ? null : (
          <>
            <div className="card">
              <PlanChooser id="approval-plan" plans={list} value={selected.id} onChange={choose} />
            </div>
            <PlanHeader plan={selected} />
            <p className="callout" role="status" data-testid="state" data-status={selected.status}>
              {stateNotice(t, selected.status)}
            </p>
            {selected.status === 'SUPERSEDED' ? (
              <p className="callout warning" data-testid="superseded">
                {t('cap.approval.superseded.label')}
              </p>
            ) : null}
            {selected.status === 'DRAFT' && selected.decisionReason !== null ? (
              <p className="callout warning" data-testid="returned">
                {t('cap.approval.returned.notice', { reason: selected.decisionReason })}
              </p>
            ) : null}
            {problem === undefined ? null : (
              <div className="callout warning" role="alert" data-testid="problem">
                <p>{approvalProblemMessage(t, problem)}</p>
                {problem.lines.length === 0 ? null : (
                  <ul data-testid="below-lines">
                    {problem.lines.map((line) => (
                      <li key={line.lineId}>{belowCommittedText(t, line, projectOf, locale)}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            <ImpactCard plan={selected} base={base} impact={impact} />
            <Actions
              plan={selected}
              permissions={permissions}
              mode={mode}
              belowCount={impact?.belowCount ?? 0}
              hasLines={(lines.data?.lines.length ?? 0) > 0}
              onSubmit={() => submit.mutate({ planId: selected.id, version: selected.version })}
              submitting={submit.isPending}
              submitted={submit.isSuccess}
              onDecide={(decision, reason) => decide.mutate({ planId: selected.id, version: selected.version, decision, reason })}
              deciding={decide.isPending}
              decided={decide.isSuccess ? decide.variables?.decision : undefined}
              onPublish={(form) => publish.mutate({ planId: selected.id, version: selected.version, body: publishBody(form) })}
              publishing={publish.isPending}
              published={publish.isSuccess}
            />
            <p>
              <Link to={`${ALLOCATION_GRID_PATH}?plan=${selected.id}`}>{t('cap.approval.lines.link')}</Link>
            </p>
          </>
        )}
      </StateBoundary>
      <p className="prototype-note">{t('cap.approval.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

interface ImpactProps {
  plan: PlanSummary;
  base: PlanSummary | undefined;
  impact: ReturnType<typeof computeImpact> | undefined;
}

function ImpactCard({ plan, base, impact }: ImpactProps) {
  const { t } = useTranslation();
  if (impact === undefined) return null;
  return (
    <div className="card" data-testid="impact">
      <h2>{t('cap.approval.impact.title')}</h2>
      <p>{base === undefined ? t('cap.approval.impact.noBase.notice') : t('cap.approval.impact.base.label', { code: base.planCode, revision: base.revision })}</p>
      {impact.belowCount > 0 ? (
        <p className="callout warning" role="alert" data-testid="below-count">
          {t('cap.approval.impact.below.error', { count: impact.belowCount })}
        </p>
      ) : null}
      <div className="cap-scroll">
        <table className="table cap-table" aria-label={t('cap.approval.impact.table.aria', { code: plan.planCode })}>
          <caption className="sr-only">{t('cap.approval.impact.table.caption')}</caption>
          <thead>
            <tr>
              <th scope="col">{t('cap.approval.impact.column.project')}</th>
              <th scope="col">{t('cap.approval.impact.column.fund')}</th>
              <th scope="col" className="cap-number">
                {t('cap.approval.impact.column.previous')}
              </th>
              <th scope="col" className="cap-number">
                {t('cap.approval.impact.column.next')}
              </th>
              <th scope="col" className="cap-number">
                {t('cap.approval.impact.column.delta')}
              </th>
              <th scope="col" className="cap-number">
                {t('cap.approval.impact.column.floor')}
              </th>
              <th scope="col">{t('cap.approval.impact.column.kind')}</th>
            </tr>
          </thead>
          <tbody>
            {impact.rows.map((row) => (
              <tr key={row.key} data-kind={row.kind} data-below={row.belowFloor ? 'true' : 'false'}>
                <th scope="row">
                  {row.projectCode} <small className="sub">{row.projectName}</small>
                </th>
                <td>{row.fundLabel}</td>
                <td className="cap-number">
                  <Money vnd={row.previousVnd} />
                </td>
                <td className="cap-number">
                  <Money vnd={row.nextVnd} />
                </td>
                <td className="cap-number" data-testid="delta">
                  <SignedMoney vnd={row.deltaVnd} />
                </td>
                <td className="cap-number">
                  <Money vnd={row.floorVnd} />
                </td>
                <td>
                  {impactKindLabel(t, row.kind)}
                  {row.belowFloor ? <span className="cap-negative"> {t('cap.approval.impact.belowFloor.label')}</span> : null}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row" colSpan={2}>
                {t('cap.approval.impact.total.label', { projects: impact.projectCount })}
              </th>
              <td className="cap-number" data-testid="total-previous">
                <Money vnd={impact.previousVnd} />
              </td>
              <td className="cap-number" data-testid="total-next">
                <Money vnd={impact.nextVnd} />
              </td>
              <td className="cap-number" data-testid="total-delta">
                <SignedMoney vnd={impact.deltaVnd} />
              </td>
              <td colSpan={2} />
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

interface ActionsProps {
  plan: PlanSummary;
  permissions: readonly string[] | undefined;
  mode: string | undefined;
  belowCount: number;
  hasLines: boolean;
  onSubmit: () => void;
  submitting: boolean;
  submitted: boolean;
  onDecide: (decision: 'approve' | 'reject' | 'return', reason: string) => void;
  deciding: boolean;
  decided: 'approve' | 'reject' | 'return' | undefined;
  onPublish: (form: PublishForm) => void;
  publishing: boolean;
  published: boolean;
}

function Actions(props: ActionsProps) {
  const { t } = useTranslation();
  const { plan, permissions, mode } = props;
  const maySubmit = mayAct(permissions, mode, SUBMIT_PERMISSION);
  const mayDecide = mayAct(permissions, mode, DECIDE_PERMISSION);
  const mayPublish = mayAct(permissions, mode, PUBLISH_PERMISSION);
  if (plan.status === 'DRAFT') {
    return (
      <div className="card" data-testid="actions">
        {props.submitted ? <p className="callout" role="status">{t('cap.approval.done.submit.notice')}</p> : null}
        {maySubmit ? (
          <button type="button" className="button primary" disabled={props.submitting || !props.hasLines} onClick={props.onSubmit}>
            {props.submitting ? t('cap.approval.submit.pending') : t('cap.approval.submit.action')}
          </button>
        ) : (
          <p className="callout" role="status">{mode === 'READ_ONLY' ? t('cap.readOnly.frozen.notice') : t('cap.approval.denied.notice')}</p>
        )}
      </div>
    );
  }
  if (plan.status === 'IN_REVIEW') {
    return mayDecide ? <DecideForm {...props} /> : <ReadOnly mode={mode} />;
  }
  if (plan.status === 'APPROVED') {
    return mayPublish ? <PublishFormCard {...props} /> : <ReadOnly mode={mode} />;
  }
  return null;
}

function ReadOnly({ mode }: { mode: string | undefined }) {
  const { t } = useTranslation();
  return (
    <div className="card" data-testid="actions">
      <p className="callout" role="status">
        {mode === 'READ_ONLY' ? t('cap.readOnly.frozen.notice') : t('cap.approval.denied.notice')}
      </p>
    </div>
  );
}

function DecideForm({ onDecide, deciding, decided }: ActionsProps) {
  const { t } = useTranslation();
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<ReasonProblem | undefined>(undefined);
  const act = (decision: 'approve' | 'reject' | 'return'): void => {
    if (deciding) return;
    const found = validateReason(reason);
    setProblem(found);
    if (found === undefined) onDecide(decision, reason.trim());
  };
  return (
    <form className="card cap-decision" data-testid="actions" aria-label={t('cap.approval.decide.title')} onSubmit={(event: FormEvent) => event.preventDefault()} noValidate>
      <h2>{t('cap.approval.decide.title')}</h2>
      {decided === undefined ? null : <p className="callout" role="status">{decisionDoneNotice(t, decided)}</p>}
      <Field id="approval-reason" label={t('cap.approval.reason.label')} error={problem === undefined ? undefined : reasonProblemMessage(t, problem)} hint={t('cap.approval.reason.hint', { min: REASON_MIN })}>
        <textarea id="approval-reason" value={reason} maxLength={REASON_MAX} aria-invalid={problem !== undefined} onChange={(event) => setReason(event.target.value)} />
      </Field>
      <div className="formfooter">
        <button type="button" className="button primary" disabled={deciding} onClick={() => act('approve')}>
          {t('cap.approval.approve.action')}
        </button>
        <button type="button" disabled={deciding} onClick={() => act('return')}>
          {t('cap.approval.return.action')}
        </button>
        <button type="button" disabled={deciding} onClick={() => act('reject')}>
          {t('cap.approval.reject.action')}
        </button>
      </div>
    </form>
  );
}

function PublishFormCard({ onPublish, publishing, published, belowCount }: ActionsProps) {
  const { t } = useTranslation();
  const [form, setForm] = useState<PublishForm>(EMPTY_PUBLISH_FORM);
  const [errors, setErrors] = useState<Partial<Record<PublishField, PublishProblem>>>({});
  const setField = (field: PublishField, value: string): void => {
    setForm((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
  };
  const send = (event: FormEvent): void => {
    event.preventDefault();
    if (publishing) return;
    const found = validatePublishForm(form);
    setErrors(found);
    if (Object.keys(found).length === 0) onPublish(form);
  };
  const message = (field: PublishField): string | undefined => {
    const found = errors[field];
    return found === undefined ? undefined : publishProblemMessage(t, found);
  };
  return (
    <form className="card cap-form" data-testid="actions" aria-label={t('cap.approval.publish.title')} onSubmit={send} noValidate>
      <h2>{t('cap.approval.publish.title')}</h2>
      {published ? <p className="callout" role="status">{t('cap.approval.done.publish.notice')}</p> : null}
      {belowCount > 0 ? <p className="callout warning">{t('cap.approval.publish.below.warning', { count: belowCount })}</p> : null}
      <fieldset className="formgrid">
        <Field id="approval-document" label={t('cap.approval.document.label')} error={message('documentId')} hint={t('cap.approval.document.hint')}>
          <input id="approval-document" value={form.documentId} aria-invalid={message('documentId') !== undefined} onChange={(event) => setField('documentId', event.target.value)} />
        </Field>
        <Field id="approval-effective" label={t('cap.approval.effective.label')} error={message('effectiveAt')} hint={t('cap.approval.effective.hint')}>
          <input id="approval-effective" type="datetime-local" value={form.effectiveAt} aria-invalid={message('effectiveAt') !== undefined} onChange={(event) => setField('effectiveAt', event.target.value)} />
        </Field>
      </fieldset>
      <div className="formfooter">
        <button type="submit" className="button primary" disabled={publishing}>
          {publishing ? t('cap.approval.publish.pending') : t('cap.approval.publish.action')}
        </button>
      </div>
    </form>
  );
}
