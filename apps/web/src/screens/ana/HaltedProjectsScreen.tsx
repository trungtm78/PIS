import { ApiError } from '@machvon/api-client';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { Translator } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { ConfirmDialog, ContextBar, SectionCard, StatusPill } from '../../ui';
import type { Tone } from '../../ui';
import { useHaltCommands, useHaltedProject, useHaltedProjects } from './bottleneck-hooks';
import { APPROVE_PERMISSION, BOTTLENECK_PATH, CLOSE_PERMISSION, HALT_STATUSES, PLAN_PERMISSION, RECORD_PERMISSION } from './bottleneck-model';
import type { Dossier, HaltStatus, HaltedList, PlanState } from './bottleneck-model';
import { causeLabel } from './BottleneckScreen';
import { dayText } from './common';
import { UnverifiedNote } from './components';

type T = Translator['t'];
const STATUS_TONE: Record<HaltStatus, Tone> = { HALTED: 'danger', RESTART_PLANNED: 'warning', RESTARTED: 'success', CANCELLED: 'neutral' };
const PLAN_TONE: Record<PlanState, Tone> = { NO_PLAN: 'danger', AWAITING_APPROVAL: 'warning', ON_TRACK: 'success', OVERDUE: 'danger', DONE: 'neutral' };

function statusLabel(t: T, status: HaltStatus): string {
  switch (status) {
    case 'HALTED':
      return t('ana.halt.status.halted');
    case 'RESTART_PLANNED':
      return t('ana.halt.status.planned');
    case 'RESTARTED':
      return t('ana.halt.status.restarted');
    case 'CANCELLED':
      return t('ana.halt.status.cancelled');
  }
}

export function planLabel(t: T, state: PlanState): string {
  switch (state) {
    case 'NO_PLAN':
      return t('ana.halt.plan.noPlan');
    case 'AWAITING_APPROVAL':
      return t('ana.halt.plan.awaiting');
    case 'ON_TRACK':
      return t('ana.halt.plan.onTrack');
    case 'OVERDUE':
      return t('ana.halt.plan.overdue');
    case 'DONE':
      return t('ana.halt.plan.done');
  }
}

function problemText(t: T, error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) return error.code === 'SELF_APPROVAL_DENIED' ? t('ana.halt.problem.self') : t('ana.halt.problem.denied');
    if (error.code === 'PROJECT_HALT_STEPS_OPEN') return t('ana.halt.problem.stepsOpen');
    if (error.code === 'PROJECT_HALT_OPEN_EXISTS') return t('ana.halt.problem.exists');
    if (error.status === 409) return t('ana.halt.problem.state');
    if (error.code === 'PROJECT_STAGE_INVALID') return t('ana.halt.problem.stage');
    if (error.status === 422) return t('ana.halt.problem.invalid');
    if (error.status === 404) return t('ana.halt.problem.gone');
  }
  return t('ana.halt.problem.failed');
}

type Pending =
  | { kind: 'halt'; projectId: string; projectLabel: string }
  | { kind: 'decide'; dossier: Dossier; decision: 'APPROVE' | 'RETURN' }
  | { kind: 'step'; dossier: Dossier; stepId: string; status: 'DONE' | 'DROPPED' }
  | { kind: 'close'; dossier: Dossier; outcome: 'RESTARTED' | 'CANCELLED' };

interface Row {
  title: string;
  dueOn: string;
}

/**
 * BI-28: the halted projects (G3-9). Each halt has a dossier: a standard cause, the reason in words, since when, and a restart plan with steps, owners and days that a person other than its author approves. A suspended project
 * that has no dossier is listed as the gap. A restart is recorded only when every step is done or dropped; every move needs words and has an audit row.
 */
export default function HaltedProjectsScreen({ route }: ScreenProps) {
  const tenant = useSession().tenant;
  return <HaltedContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function HaltedContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const { permissions, mode, tenant } = useSession();
  const holds = (permission: string): boolean => mode !== 'READ_ONLY' && (permissions === undefined || permissions.includes(permission));
  const [status, setStatus] = useState('');
  const [selected, setSelected] = useState(params.get('id') ?? '');
  const list = useHaltedProjects(status);
  const data: HaltedList | undefined = list.data;
  const commands = useHaltCommands();
  const [pending, setPending] = useState<Pending | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const state = useScreenState({ isLoading: list.isLoading, error: data === undefined ? list.error : undefined, data, isEmpty: (value) => (value as HaltedList).items.length === 0 && (value as HaltedList).undocumented.length === 0 && status === '' });
  const me = tenant?.membershipId ?? '';
  const contextItems = [
    { label: t('ana.halt.context.asOf'), value: dayText(data?.asOf ?? null) },
    { label: t('ana.halt.context.open'), value: data === undefined ? '—' : String(data.items.filter((one) => one.status === 'HALTED' || one.status === 'RESTART_PLANNED').length) },
    { label: t('ana.halt.context.undocumented'), value: data === undefined ? '—' : String(data.undocumented.length) },
  ];
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('ana.halt.page.title')}</h1>
          <p>{t('ana.halt.page.subtitle')}</p>
        </div>
      </div>
      <ContextBar items={contextItems} unit={t('ana.halt.context.unit')} />
      {notice === undefined ? null : (
        <p role="status" className="ana-na" data-testid="halt-notice">
          {notice}
        </p>
      )}
      <StateBoundary state={state} onRetry={() => void list.refetch()}>
        {data === undefined ? null : (
          <div className="ana-stack">
            <UnverifiedNote unverified={data.unverified} />
            <div className="ana-controls">
              <label>
                {t('ana.halt.filter.status')}
                <select value={status} onChange={(event) => setStatus(event.target.value)} data-testid="halt-filter">
                  <option value="">{t('ana.halt.filter.all')}</option>
                  {HALT_STATUSES.map((one) => (
                    <option key={one} value={one}>
                      {statusLabel(t, one)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {data.undocumented.length === 0 ? null : (
              <SectionCard title={t('ana.halt.gap.title')}>
                <p className="ana-caveat">{t('ana.halt.gap.body')}</p>
                <ul data-testid="halt-gap">
                  {data.undocumented.map((one) => (
                    <li key={one.project.id}>
                      {one.project.code} {one.project.name} <span className="ana-caveat">{one.unit.name ?? ''}</span>{' '}
                      {holds(RECORD_PERMISSION) ? (
                        <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => setPending({ kind: 'halt', projectId: one.project.id, projectLabel: `${one.project.code} ${one.project.name}` })} data-testid={`halt-record-${one.project.id}`}>
                          {t('ana.halt.record.open')}
                        </button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </SectionCard>
            )}
            <SectionCard title={t('ana.halt.list.title')}>
              {data.items.length === 0 ? (
                <p role="status" data-testid="halt-none">
                  {t('ana.halt.list.none')}
                </p>
              ) : (
                <div className="tablewrap">
                  <table className="ana-table" aria-label={t('ana.halt.list.aria')} data-testid="halt-table">
                    <caption className="sr-only">{t('ana.halt.list.caption')}</caption>
                    <thead>
                      <tr>
                        <th scope="col">{t('ana.halt.col.project')}</th>
                        <th scope="col">{t('ana.halt.col.cause')}</th>
                        <th scope="col" className="num">
                          {t('ana.halt.col.age')}
                        </th>
                        <th scope="col">{t('ana.halt.col.status')}</th>
                        <th scope="col">{t('ana.halt.col.plan')}</th>
                        <th scope="col">
                          <span className="sr-only">{t('ana.halt.col.open')}</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.items.map((one) => (
                        <tr key={one.id} data-testid="halt-row" data-id={one.id} aria-selected={selected === one.id}>
                          <th scope="row">
                            {one.project.code} <span className="muted">{one.project.name}</span>
                          </th>
                          <td>{causeLabel(t, one.reasonCode)}</td>
                          <td className="num">{t('ana.bn.age.days', { days: one.ageDays })}</td>
                          <td>
                            <StatusPill tone={STATUS_TONE[one.status]}>{statusLabel(t, one.status)}</StatusPill>
                          </td>
                          <td>
                            <StatusPill tone={PLAN_TONE[one.plan.state]}>{planLabel(t, one.plan.state)}</StatusPill>
                            {one.plan.stepsOverdue > 0 ? <span className="ana-caveat"> {t('ana.halt.plan.overdueSteps', { count: one.plan.stepsOverdue })}</span> : null}
                          </td>
                          <td>
                            <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => setSelected(one.id)} data-testid={`halt-open-${one.id}`}>
                              {t('ana.halt.open')}
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </SectionCard>
            {selected === '' ? null : <DossierPanel id={selected} me={me} holds={holds} commands={commands} planMinSteps={data.planMinSteps} onPending={setPending} onNotice={setNotice} onClose={() => setSelected('')} />}
            <p className="ana-links">
              <Link to={BOTTLENECK_PATH}>{t('ana.halt.link.bottlenecks')}</Link>
            </p>
          </div>
        )}
      </StateBoundary>
      <ActionDialog pending={pending} causes={data?.causes ?? []} commands={commands} onClose={() => setPending(undefined)} onDone={(text) => { setPending(undefined); setNotice(text); }} />
    </section>
  );
}

function DossierPanel({ id, me, holds, commands, planMinSteps, onPending, onNotice, onClose }: { id: string; me: string; holds: (permission: string) => boolean; commands: ReturnType<typeof useHaltCommands>; planMinSteps: number; onPending: (pending: Pending) => void; onNotice: (text: string | undefined) => void; onClose: () => void }) {
  const { t } = useTranslation();
  const query = useHaltedProject(id);
  const dossier = query.data;
  const [rows, setRows] = useState<Row[]>([{ title: '', dueOn: '' }]);
  const [expected, setExpected] = useState('');
  const current = dossier?.steps.filter((step) => step.planVersion === dossier.plan.version) ?? [];
  const canPlan = dossier !== undefined && dossier.status === 'HALTED' && holds(PLAN_PERMISSION);
  const ready = rows.length >= planMinSteps && rows.every((row) => row.title.trim().length >= 5 && /^\d{4}-\d{2}-\d{2}$/.test(row.dueOn));
  const save = (): void => {
    if (dossier === undefined || !ready || commands.plan.isPending || dossier.unit.id === null) return;
    commands.plan.mutate({ id: dossier.id, steps: rows.map((row) => ({ title: row.title, ownerUnitId: dossier.unit.id as string, dueOn: row.dueOn })), expectedRestartOn: expected }, { onSuccess: () => onNotice(t('ana.halt.plan.saved')) });
  };
  return (
    <SectionCard title={t('ana.halt.detail.title')} actions={<button type="button" className="ui-button ui-button--outline ui-button--small" onClick={onClose}>{t('ana.halt.detail.close')}</button>}>
      {query.isLoading ? <p role="status">{t('ana.halt.detail.loading')}</p> : null}
      {query.isError ? (
        <p role="alert" data-testid="halt-detail-error">
          {t('ana.halt.detail.error')}
        </p>
      ) : null}
      {dossier === undefined ? null : (
        <div className="ana-stack" data-testid="halt-detail">
          <p>
            <strong>
              {dossier.project.code} {dossier.project.name}
            </strong>{' '}
            <StatusPill tone={STATUS_TONE[dossier.status]}>{statusLabel(t, dossier.status)}</StatusPill>
          </p>
          <p data-testid="halt-reason">
            {causeLabel(t, dossier.reasonCode)}: {dossier.reasonText}
          </p>
          <p className="ana-caveat">
            {t('ana.halt.detail.since', { day: dayText(dossier.haltedOn), days: dossier.ageDays })}
            {dossier.orderRef === null ? '' : ` ${t('ana.halt.detail.order', { ref: dossier.orderRef })}`}
            {dossier.expectedRestartOn === null ? '' : ` ${t('ana.halt.detail.expected', { day: dayText(dossier.expectedRestartOn) })}`}
          </p>
          <h3>{t('ana.halt.steps.title', { version: dossier.plan.version })}</h3>
          {current.length === 0 ? (
            <p className="muted" data-testid="halt-no-plan">
              {t('ana.halt.steps.none')}
            </p>
          ) : (
            <ol data-testid="halt-steps">
              {current.map((step) => (
                <li key={step.id} data-testid="halt-step" data-status={step.status}>
                  {step.title} <span className="ana-caveat">{t('ana.halt.steps.due', { day: dayText(step.dueOn) })}</span>{' '}
                  <StatusPill tone={step.status === 'DONE' ? 'success' : step.status === 'DROPPED' ? 'neutral' : 'warning'}>{step.status === 'DONE' ? t('ana.halt.steps.done') : step.status === 'DROPPED' ? t('ana.halt.steps.dropped') : t('ana.halt.steps.open')}</StatusPill>
                  {step.closeNote === null ? null : <span className="ana-caveat"> {step.closeNote}</span>}
                  {dossier.status === 'RESTART_PLANNED' && step.status === 'OPEN' && holds(PLAN_PERMISSION) ? (
                    <>
                      {' '}
                      <button type="button" className="ui-button ui-button--small" onClick={() => onPending({ kind: 'step', dossier, stepId: step.id, status: 'DONE' })} data-testid={`halt-step-done-${step.id}`}>
                        {t('ana.halt.steps.markDone')}
                      </button>{' '}
                      <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => onPending({ kind: 'step', dossier, stepId: step.id, status: 'DROPPED' })} data-testid={`halt-step-drop-${step.id}`}>
                        {t('ana.halt.steps.markDropped')}
                      </button>
                    </>
                  ) : null}
                </li>
              ))}
            </ol>
          )}
          {dossier.plan.decisionNote === null ? null : (
            <p className="ana-caveat" data-testid="halt-decision">
              {dossier.plan.decision === 'RETURNED' ? t('ana.halt.plan.returned', { note: dossier.plan.decisionNote }) : t('ana.halt.plan.approved', { note: dossier.plan.decisionNote })}
            </p>
          )}
          {dossier.status === 'HALTED' && dossier.plan.version > 0 && dossier.plan.decision === null && holds(APPROVE_PERMISSION) ? (
            dossier.plan.savedBy?.id === me ? (
              <p className="ana-caveat">{t('ana.halt.plan.maker')}</p>
            ) : (
              <p>
                <button type="button" className="ui-button" onClick={() => onPending({ kind: 'decide', dossier, decision: 'APPROVE' })} data-testid="halt-approve">
                  {t('ana.halt.plan.approve')}
                </button>{' '}
                <button type="button" className="ui-button ui-button--outline" onClick={() => onPending({ kind: 'decide', dossier, decision: 'RETURN' })} data-testid="halt-return">
                  {t('ana.halt.plan.return')}
                </button>
              </p>
            )
          ) : null}
          {canPlan ? (
            <fieldset className="ana-field" data-testid="halt-plan-form">
              <legend>{t('ana.halt.plan.edit', { min: planMinSteps })}</legend>
              {rows.map((row, index) => (
                <div key={index} className="ana-controls">
                  <label>
                    {t('ana.halt.plan.stepTitle', { n: index + 1 })}
                    <input type="text" value={row.title} onChange={(event) => setRows(rows.map((one, at) => (at === index ? { ...one, title: event.target.value } : one)))} data-testid={`halt-plan-title-${index}`} />
                  </label>
                  <label>
                    {t('ana.halt.plan.stepDue')}
                    <input type="date" value={row.dueOn} onChange={(event) => setRows(rows.map((one, at) => (at === index ? { ...one, dueOn: event.target.value } : one)))} data-testid={`halt-plan-due-${index}`} />
                  </label>
                  {rows.length > 1 ? (
                    <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => setRows(rows.filter((_, at) => at !== index))}>
                      {t('ana.halt.plan.removeStep')}
                    </button>
                  ) : null}
                </div>
              ))}
              <p className="ana-controls">
                <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => setRows([...rows, { title: '', dueOn: '' }])} data-testid="halt-plan-add">
                  {t('ana.halt.plan.addStep')}
                </button>
                <label>
                  {t('ana.halt.plan.expected')}
                  <input type="date" value={expected} onChange={(event) => setExpected(event.target.value)} data-testid="halt-plan-expected" />
                </label>
                <button type="button" className="ui-button" disabled={!ready || commands.plan.isPending} onClick={save} data-testid="halt-plan-save">
                  {t('ana.halt.plan.save')}
                </button>
              </p>
              <p className="ana-caveat">{t('ana.halt.plan.ownerNote')}</p>
              {commands.plan.isError ? (
                <p role="alert" data-testid="halt-plan-error">
                  {problemText(t, commands.plan.error)}
                </p>
              ) : null}
            </fieldset>
          ) : null}
          {holds(CLOSE_PERMISSION) && (dossier.status === 'HALTED' || dossier.status === 'RESTART_PLANNED') ? (
            <p>
              {dossier.status === 'RESTART_PLANNED' ? (
                <button type="button" className="ui-button" onClick={() => onPending({ kind: 'close', dossier, outcome: 'RESTARTED' })} data-testid="halt-restarted">
                  {t('ana.halt.close.restarted')}
                </button>
              ) : null}{' '}
              <button type="button" className="ui-button ui-button--outline" onClick={() => onPending({ kind: 'close', dossier, outcome: 'CANCELLED' })} data-testid="halt-cancelled">
                {t('ana.halt.close.cancelled')}
              </button>
            </p>
          ) : null}
          {dossier.closeNote === null ? null : (
            <p className="ana-caveat" data-testid="halt-close-note">
              {dossier.restartedOn === null ? t('ana.halt.close.noteCancelled', { note: dossier.closeNote }) : t('ana.halt.close.noteRestarted', { day: dayText(dossier.restartedOn), note: dossier.closeNote })}
            </p>
          )}
        </div>
      )}
    </SectionCard>
  );
}

function ActionDialog({ pending, causes, commands, onClose, onDone }: { pending: Pending | undefined; causes: HaltedList['causes']; commands: ReturnType<typeof useHaltCommands>; onClose: () => void; onDone: (text: string) => void }) {
  const { t } = useTranslation();
  const [cause, setCause] = useState('');
  const [haltedOn, setHaltedOn] = useState('');
  const [order, setOrder] = useState('');
  const [expected, setExpected] = useState('');
  const [restartedOn, setRestartedOn] = useState('');
  useEffect(() => {
    setCause(causes[0]?.code ?? '');
    setHaltedOn('');
    setOrder('');
    setExpected('');
    setRestartedOn('');
  }, [pending, causes]);
  if (pending === undefined) return null;
  const mutation = pending.kind === 'halt' ? commands.record : pending.kind === 'decide' ? commands.decide : pending.kind === 'step' ? commands.step : commands.close;
  const title =
    pending.kind === 'halt'
      ? t('ana.halt.record.title')
      : pending.kind === 'decide'
        ? pending.decision === 'APPROVE'
          ? t('ana.halt.plan.approve')
          : t('ana.halt.plan.return')
        : pending.kind === 'step'
          ? pending.status === 'DONE'
            ? t('ana.halt.steps.markDone')
            : t('ana.halt.steps.markDropped')
          : pending.outcome === 'RESTARTED'
            ? t('ana.halt.close.restarted')
            : t('ana.halt.close.cancelled');
  const subject = pending.kind === 'halt' ? pending.projectLabel : `${pending.dossier.project.code} ${pending.dossier.project.name}`;
  const confirm = (reason?: string): void => {
    if (mutation.isPending) return;
    const words = (reason ?? '').trim();
    const done = (text: string) => ({ onSuccess: () => onDone(text) });
    if (pending.kind === 'halt') commands.record.mutate({ projectId: pending.projectId, reasonCode: cause, reasonText: words, haltedOn, orderRef: order, expectedRestartOn: expected }, done(t('ana.halt.record.done')));
    else if (pending.kind === 'decide') commands.decide.mutate({ id: pending.dossier.id, decision: pending.decision, note: words }, done(t('ana.halt.done')));
    else if (pending.kind === 'step') commands.step.mutate({ id: pending.dossier.id, stepId: pending.stepId, status: pending.status, note: words }, done(t('ana.halt.done')));
    else commands.close.mutate({ id: pending.dossier.id, outcome: pending.outcome, note: words, restartedOn }, done(t('ana.halt.done')));
  };
  return (
    <ConfirmDialog
      open
      title={title}
      context={[{ label: t('ana.halt.col.project'), value: subject }]}
      confirmLabel={t('ana.halt.dialog.confirm')}
      cancelLabel={t('ana.halt.dialog.cancel')}
      reason={{ label: pending.kind === 'halt' ? t('ana.halt.record.reason') : t('ana.halt.dialog.words'), required: true, minLength: pending.kind === 'halt' ? 10 : 5 }}
      pending={mutation.isPending}
      {...(mutation.isError ? { error: problemText(t, mutation.error) } : {})}
      onConfirm={confirm}
      onCancel={() => {
        if (mutation.isPending) return;
        mutation.reset();
        onClose();
      }}
    >
      {pending.kind === 'halt' ? (
        <>
          <label className="ana-field">
            {t('ana.halt.record.cause')}
            <select value={cause} onChange={(event) => setCause(event.target.value)} data-testid="halt-cause">
              {causes.map((one) => (
                <option key={one.code} value={one.code}>
                  {causeLabel(t, one.code)}
                </option>
              ))}
            </select>
          </label>
          <label className="ana-field">
            {t('ana.halt.record.haltedOn')}
            <input type="date" value={haltedOn} onChange={(event) => setHaltedOn(event.target.value)} data-testid="halt-date" />
          </label>
          <label className="ana-field">
            {t('ana.halt.record.order')}
            <input type="text" value={order} onChange={(event) => setOrder(event.target.value)} data-testid="halt-order" />
          </label>
          <label className="ana-field">
            {t('ana.halt.record.expected')}
            <input type="date" value={expected} onChange={(event) => setExpected(event.target.value)} data-testid="halt-expected" />
          </label>
        </>
      ) : null}
      {pending.kind === 'close' && pending.outcome === 'RESTARTED' ? (
        <label className="ana-field">
          {t('ana.halt.close.restartedOn')}
          <input type="date" value={restartedOn} onChange={(event) => setRestartedOn(event.target.value)} data-testid="halt-restarted-on" />
        </label>
      ) : null}
    </ConfirmDialog>
  );
}
