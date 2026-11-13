import { useState } from 'react';
import type { FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { Translator } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { Field } from '../../ctr/components';
import { useProjectOptions } from '../../lnd/read-hooks';
import '../../qms/qms.css';
import { useAcceptedHandovers, useAcknowledge, useSchedule, useTriggers } from './hooks';
import { EMPTY_FORM, KINDS, canManage, describeRefusal, earliestDue, isEvaluationId, isPostHandover, scheduleBody, validateSchedule } from './model';
import type { AcceptedHandover, FormField, FormProblem, Kind, Refusal, ScheduleForm, Status, TriggerLine } from './model';

type T = Translator['t'];
const NONE = '—';

function kindText(t: T, kind: Kind): string {
  switch (kind) {
    case 'POST_HANDOVER_12M':
      return t('ast.evaluation.kind.twelve');
    case 'POST_HANDOVER_24M':
      return t('ast.evaluation.kind.twentyFour');
    case 'SETTLEMENT_CLOSED':
      return t('ast.evaluation.kind.settlement');
    case 'MANUAL':
      return t('ast.evaluation.kind.manual');
  }
}

function statusText(t: T, status: Status): string {
  switch (status) {
    case 'SCHEDULED':
      return t('ast.evaluation.status.scheduled');
    case 'FIRED':
      return t('ast.evaluation.status.fired');
    case 'ACKNOWLEDGED':
      return t('ast.evaluation.status.acknowledged');
    case 'CANCELLED':
      return t('ast.evaluation.status.cancelled');
  }
}

function refusalText(t: T, refusal: Refusal): string {
  switch (refusal.problem) {
    case 'duplicate':
      return t('ast.evaluation.problem.duplicate');
    case 'stage':
      return t('ast.evaluation.problem.stage');
    case 'notAccepted':
      return t('ast.evaluation.problem.notAccepted');
    case 'early':
      return refusal.earliest === undefined ? t('ast.evaluation.problem.earlyUnknown') : t('ast.evaluation.problem.early', { day: refusal.earliest });
    case 'past':
      return t('ast.evaluation.problem.past');
    case 'otherProject':
      return t('ast.evaluation.problem.otherProject');
    case 'state':
      return t('ast.evaluation.problem.state');
    case 'evaluationMissing':
      return t('ast.evaluation.problem.evaluationMissing');
    case 'evaluationOther':
      return t('ast.evaluation.problem.evaluationOther');
    case 'scopeDenied':
      return t('ast.evaluation.problem.scopeDenied');
    case 'notFound':
      return t('ast.evaluation.problem.notFound');
    case 'validation':
      return t('ast.evaluation.problem.validation');
    case 'general':
      return t('ast.evaluation.problem.general');
  }
}

function fieldText(t: T, problem: FormProblem | undefined, earliest?: string): string | undefined {
  switch (problem) {
    case undefined:
      return undefined;
    case 'required':
      return t('ast.evaluation.field.required.error');
    case 'invalid':
      return t('ast.evaluation.field.invalid.error');
    case 'early':
      return t('ast.evaluation.field.early.error', { day: earliest ?? NONE });
  }
}

/**
 * AST-07: the trigger of the evaluation after the investment (ST-AST-006, AST 3.4, UC-AST-04, UAT-AC394). The screen only sets the day on which MNE is told to evaluate a project and records the evaluation MNE did; it evaluates nothing. A trigger after a
 * handover follows an accepted handover and falls due 12 or 24 months after the day it was accepted; the server fires it on its day, once, and judges every request again.
 */
export default function EvaluationScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The list and the forms belong to one membership: a switch of tenant or person starts the screen over.
  return <EvaluationContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function EvaluationContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const [params, setParams] = useSearchParams();
  const projectId = params.get('project') ?? undefined;
  const allowed = permissions === undefined || permissions.includes('evaluation.trigger.manage');
  const projects = useProjectOptions();
  const list = useTriggers(projectId, allowed);
  const may = canManage(permissions, mode);
  const handovers = useAcceptedHandovers(projectId, may);
  const state = useScreenState({ isLoading: list.isLoading, error: list.error, data: list.data, isEmpty: () => false });
  const items = list.data ?? [];
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('ast.evaluation.page.title')}</h1>
          <p>{t('ast.evaluation.page.subtitle')}</p>
        </div>
      </div>
      <p className="callout" data-testid="scope-note">
        {t('ast.evaluation.scope.note')}
      </p>
      <div className="card">
        <div className="field">
          <label htmlFor="evaluation-project">{t('ast.evaluation.project.label')}</label>
          <select id="evaluation-project" value={projectId ?? ''} onChange={(event) => setParams(event.target.value === '' ? {} : { project: event.target.value })}>
            <option value="">{t('ast.evaluation.project.choose')}</option>
            {(projects.data ?? []).map((project) => (
              <option key={project.id} value={project.id}>
                {`${project.code} · ${project.name}`}
              </option>
            ))}
          </select>
        </div>
      </div>
      {!allowed ? (
        <p className="callout warning" role="status" data-testid="no-right">
          {t('ast.evaluation.noRight.notice')}
        </p>
      ) : projectId === undefined ? (
        <>
          <p className="callout" role="status" data-testid="choose-project">
            {t('ast.evaluation.project.notice')}
          </p>
          {/* The columns of the triggers stand before a project is chosen: what the screen will list is said by them. */}
          <TriggerTable items={[]} />
        </>
      ) : (
        <>
          {may ? <SchedulePanel key={projectId} projectId={projectId} handovers={handovers.data ?? []} loading={handovers.isLoading} failed={handovers.isError} onRetry={() => void handovers.refetch()} /> : null}
          {may && items.some((item) => item.status === 'FIRED') ? <AcknowledgePanel key={projectId} fired={items.filter((item) => item.status === 'FIRED')} /> : null}
          <StateBoundary state={state} onRetry={() => void list.refetch()}>
            {items.length === 0 ? (
              <p className="callout" role="status" data-testid="empty">
                {t('ast.evaluation.empty.notice')}
              </p>
            ) : null}
            <TriggerTable items={items} />
          </StateBoundary>
        </>
      )}
      <p className="prototype-note">{t('ast.evaluation.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function TriggerTable({ items }: { items: readonly TriggerLine[] }) {
  const { t } = useTranslation();
  return (
    <div className="tablewrap">
      <table className="table" aria-label={t('ast.evaluation.list.aria')} data-testid="triggers">
        <thead>
          <tr>
            <th scope="col">{t('ast.evaluation.col.kind')}</th>
            <th scope="col">{t('ast.evaluation.col.handover')}</th>
            <th scope="col">{t('ast.evaluation.col.due')}</th>
            <th scope="col">{t('ast.evaluation.col.status')}</th>
            <th scope="col">{t('ast.evaluation.col.evaluation')}</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id} data-trigger={item.id} data-status={item.status}>
              <td>{kindText(t, item.kind)}</td>
              <td>{item.handover === null ? NONE : <code>{item.handover.handoverNo ?? item.handover.id}</code>}</td>
              <td>{item.dueOn}</td>
              <td>
                <span className={`pill ${item.status === 'ACKNOWLEDGED' ? 'green' : item.status === 'FIRED' ? 'warn' : 'gray'}`}>{statusText(t, item.status)}</span>
              </td>
              <td>{item.evaluation === null ? NONE : <code>{item.evaluation.id}</code>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SchedulePanel({ projectId, handovers, loading, failed, onRetry }: { projectId: string; handovers: readonly AcceptedHandover[]; loading: boolean; failed: boolean; onRetry(): void }) {
  const { t } = useTranslation();
  const send = useSchedule();
  const [form, setForm] = useState<ScheduleForm>(EMPTY_FORM);
  const [problems, setProblems] = useState<Partial<Record<FormField, FormProblem>>>({});
  const [saved, setSaved] = useState(false);
  const refusal = send.isError ? describeRefusal(send.error) : undefined;
  const chosen = handovers.find((handover) => handover.id === form.handoverId);
  const earliest = chosen === undefined ? undefined : earliestDue(form.kind, chosen.acceptedOn);
  const set = (patch: Partial<ScheduleForm>): void => {
    const next = { ...form, ...patch };
    const nextHandover = handovers.find((handover) => handover.id === next.handoverId);
    const offered = nextHandover === undefined ? undefined : earliestDue(next.kind, nextHandover.acceptedOn);
    // The day is offered as soon as the kind and the handover say what it is: the earliest one, which the person can then move later.
    const follows = patch.dueOn === undefined && offered !== undefined && (form.dueOn === '' || form.dueOn === earliest);
    setForm(follows ? { ...next, dueOn: offered } : next);
    setSaved(false);
  };
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const found = validateSchedule(form, handovers);
    setProblems(found);
    if (Object.keys(found).length > 0 || send.isPending) return;
    send.mutate(
      { projectId, body: scheduleBody(form) },
      {
        onSuccess: () => {
          setForm(EMPTY_FORM);
          setSaved(true);
        },
      },
    );
  };
  return (
    <form className="card" onSubmit={submit} noValidate aria-label={t('ast.evaluation.form.title')} data-testid="schedule-form">
      <h2>{t('ast.evaluation.form.title')}</h2>
      {refusal === undefined ? null : (
        <p className="callout warning" role="alert" data-testid="schedule-refusal">
          {refusalText(t, refusal)}
        </p>
      )}
      {saved ? (
        <p className="callout" role="status" data-testid="schedule-saved">
          {t('ast.evaluation.form.saved')}
        </p>
      ) : null}
      {failed ? (
        <p className="callout warning" role="alert" data-testid="handovers-failed">
          {t('ast.evaluation.handovers.failed')}{' '}
          <button type="button" onClick={onRetry}>
            {t('ast.evaluation.handovers.retry.action')}
          </button>
        </p>
      ) : null}
      <fieldset disabled={send.isPending} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
        <Field id="evaluation-kind" label={t('ast.evaluation.field.kind.label')} error={fieldText(t, problems.kind)}>
          <select id="evaluation-kind" value={form.kind} onChange={(event) => set({ kind: event.target.value })}>
            <option value="">{NONE}</option>
            {KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {kindText(t, kind)}
              </option>
            ))}
          </select>
        </Field>
        <Field
          id="evaluation-handover"
          label={t('ast.evaluation.field.handover.label')}
          error={fieldText(t, problems.handover)}
          hint={loading ? t('ast.evaluation.field.handover.loading') : failed ? undefined : handovers.length === 0 ? t('ast.evaluation.field.handover.none') : isPostHandover(form.kind) ? t('ast.evaluation.field.handover.required') : t('ast.evaluation.field.handover.optional')}
        >
          <select id="evaluation-handover" value={form.handoverId} onChange={(event) => set({ handoverId: event.target.value })}>
            <option value="">{NONE}</option>
            {handovers.map((handover) => (
              <option key={handover.id} value={handover.id}>
                {`${handover.handoverNo} · ${handover.acceptedOn}`}
              </option>
            ))}
          </select>
        </Field>
        <Field
          id="evaluation-due"
          label={t('ast.evaluation.field.due.label')}
          error={fieldText(t, problems.dueOn, earliest)}
          hint={earliest === undefined ? t('ast.evaluation.field.due.hint') : t('ast.evaluation.field.due.earliest', { day: earliest })}
        >
          <input id="evaluation-due" type="text" inputMode="numeric" value={form.dueOn} onChange={(event) => set({ dueOn: event.target.value })} />
        </Field>
      </fieldset>
      <div className="formfooter">
        <button type="submit" className="primary" disabled={send.isPending}>
          {t('ast.evaluation.form.submit.action')}
        </button>
      </div>
    </form>
  );
}

function AcknowledgePanel({ fired }: { fired: readonly TriggerLine[] }) {
  const { t } = useTranslation();
  const send = useAcknowledge();
  const [triggerId, setTriggerId] = useState('');
  const [evaluationId, setEvaluationId] = useState('');
  const [problems, setProblems] = useState<{ trigger?: FormProblem; evaluation?: FormProblem }>({});
  const [saved, setSaved] = useState(false);
  const refusal = send.isError ? describeRefusal(send.error) : undefined;
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const found: { trigger?: FormProblem; evaluation?: FormProblem } = {};
    if (triggerId === '') found.trigger = 'required';
    else if (!fired.some((item) => item.id === triggerId)) found.trigger = 'invalid';
    if (evaluationId.trim() === '') found.evaluation = 'required';
    else if (!isEvaluationId(evaluationId)) found.evaluation = 'invalid';
    setProblems(found);
    if (Object.keys(found).length > 0 || send.isPending) return;
    send.mutate(
      { triggerId, evaluationId: evaluationId.trim() },
      {
        onSuccess: () => {
          setTriggerId('');
          setEvaluationId('');
          setSaved(true);
        },
      },
    );
  };
  return (
    <form className="card" onSubmit={submit} noValidate aria-label={t('ast.evaluation.ack.title')} data-testid="acknowledge-form">
      <h2>{t('ast.evaluation.ack.title')}</h2>
      <p>{t('ast.evaluation.ack.subtitle')}</p>
      {refusal === undefined ? null : (
        <p className="callout warning" role="alert" data-testid="acknowledge-refusal">
          {refusalText(t, refusal)}
        </p>
      )}
      {saved ? (
        <p className="callout" role="status" data-testid="acknowledge-saved">
          {t('ast.evaluation.ack.saved')}
        </p>
      ) : null}
      <fieldset disabled={send.isPending} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
        <Field id="evaluation-ack-trigger" label={t('ast.evaluation.ack.trigger.label')} error={fieldText(t, problems.trigger)}>
          <select
            id="evaluation-ack-trigger"
            value={triggerId}
            onChange={(event) => {
              setTriggerId(event.target.value);
              setSaved(false);
            }}
          >
            <option value="">{NONE}</option>
            {fired.map((item) => (
              <option key={item.id} value={item.id}>
                {`${kindText(t, item.kind)} · ${item.dueOn}`}
              </option>
            ))}
          </select>
        </Field>
        <Field id="evaluation-ack-evaluation" label={t('ast.evaluation.ack.evaluation.label')} error={fieldText(t, problems.evaluation)} hint={t('ast.evaluation.ack.evaluation.hint')}>
          <input
            id="evaluation-ack-evaluation"
            type="text"
            value={evaluationId}
            onChange={(event) => {
              setEvaluationId(event.target.value);
              setSaved(false);
            }}
          />
        </Field>
      </fieldset>
      <div className="formfooter">
        <button type="submit" className="primary" disabled={send.isPending}>
          {t('ast.evaluation.ack.submit.action')}
        </button>
      </div>
    </form>
  );
}
