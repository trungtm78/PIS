import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { Field } from '../../dgv/components';
import { CommandFrame } from '../../qms/CommandFrame';
import { useAssignees, useCancelInstance, useOpenTasks, useReassign } from './hooks';
import { BUSINESS_TYPES, businessTypeLabel, problemMessage } from './labels';
import { NO_FILTER, READ_PERMISSION, REASON_MIN, applyFilters, byUrgency, describeProblem } from './model';
import type { Filters, MonitorTask } from './model';
import './approvals.css';

type Acting = { kind: 'reassign'; task: MonitorTask } | { kind: 'cancel'; task: MonitorTask };

/**
 * ADM-18: the monitor of the approvals that run (ST-ADM-013, ADM 3.7). Every open task of the tenant with the record, the figure, the step, who holds it, its deadline and the version of the workflow it runs by; the late ones
 * are red and come first. An operator reassigns a task to a person who can decide it, or cancels the whole approval; both need a reason, and the server judges who may be given the task.
 */
export default function ApprovalMonitorScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <MonitorContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function MonitorContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { permissions, mode } = useSession();
  const [filters, setFilters] = useState<Filters>(NO_FILTER);
  const [acting, setActing] = useState<Acting | undefined>(undefined);
  const mayRead = permissions === undefined || permissions.includes(READ_PERMISSION);
  const writable = mode !== 'READ_ONLY';
  const tasks = useOpenTasks(mayRead);
  const queryState = useScreenState({ isLoading: tasks.isLoading, error: tasks.error, data: tasks.data });
  const state = mayRead ? queryState : 'denied';
  const all = tasks.data ?? [];
  const shown = byUrgency(applyFilters(all, filters));
  const late = all.filter((task) => task.overdue).length;
  const moment = (iso: string): string => new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date(iso));
  const money = (value: string | null): string => (value === null ? t('adm.monitor.none') : new Intl.NumberFormat(locale).format(Number(value)));

  return (
    <section className="adm-approvals" data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('adm.monitor.title')}</h1>
          <p>{t('adm.monitor.subtitle')}</p>
        </div>
      </div>
      <StateBoundary state={state} onRetry={() => void tasks.refetch()}>
        <div className="card">
          <div className="field">
            <label htmlFor="monitor-type">{t('adm.monitor.filter.type')}</label>
            <select id="monitor-type" value={filters.businessType} onChange={(event) => setFilters({ ...filters, businessType: event.target.value })}>
              <option value="">{t('adm.monitor.filter.all')}</option>
              {BUSINESS_TYPES.map((type) => (
                <option key={type.code} value={type.code}>
                  {businessTypeLabel(t, type.code)}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="monitor-late">
              <input type="checkbox" id="monitor-late" checked={filters.onlyOverdue} onChange={(event) => setFilters({ ...filters, onlyOverdue: event.target.checked })} /> {t('adm.monitor.filter.late')}
            </label>
          </div>
          <p className="sub" data-testid="counts">
            {t('adm.monitor.counts', { open: all.length, late })}
          </p>
          {shown.length === 0 ? (
            <p className="sub" data-testid="none-shown">
              {t('adm.monitor.noneShown')}
            </p>
          ) : (
            <table className="table" data-testid="tasks">
              <thead>
                <tr>
                  <th scope="col">{t('adm.monitor.column.record')}</th>
                  <th scope="col">{t('adm.monitor.column.type')}</th>
                  <th scope="col">{t('adm.monitor.column.amount')}</th>
                  <th scope="col">{t('adm.monitor.column.step')}</th>
                  <th scope="col">{t('adm.monitor.column.assignee')}</th>
                  <th scope="col">{t('adm.monitor.column.due')}</th>
                  <th scope="col">{t('adm.monitor.column.revision')}</th>
                  <th scope="col">{t('adm.monitor.column.status')}</th>
                  <th scope="col">
                    <span className="sr-only">{t('adm.monitor.column.actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {shown.map((task) => (
                  <tr key={task.id} data-task={task.id} data-overdue={task.overdue ? 'yes' : 'no'} className={task.overdue ? 'late' : undefined}>
                    <td>
                      {task.resourceType} <code>{task.resourceId.slice(0, 8)}</code>
                    </td>
                    <td>{businessTypeLabel(t, task.businessType)}</td>
                    <td>{money(task.amountVnd)}</td>
                    <td>{task.stepName}</td>
                    <td>{task.assigneeName === '' ? t('adm.monitor.none') : task.assigneeName}</td>
                    <td>{moment(task.dueAt)}</td>
                    <td>{task.workflowRevision}</td>
                    <td>
                      <span className={`pill ${task.overdue ? 'red' : 'gray'}`} data-testid="status">
                        {task.overdue ? t('adm.monitor.status.late') : t('adm.monitor.status.pending')}
                      </span>
                      {task.escalated ? (
                        <>
                          {' '}
                          <span className="pill warn" data-testid="escalated">
                            {t('adm.monitor.status.escalated')}
                          </span>
                        </>
                      ) : null}
                    </td>
                    <td>
                      {task.mayReassign && writable ? (
                        <button type="button" data-action="reassign" onClick={() => setActing({ kind: 'reassign', task })}>
                          {t('adm.monitor.action.reassign')}
                        </button>
                      ) : null}{' '}
                      {task.mayCancel && writable ? (
                        <button type="button" data-action="cancel" onClick={() => setActing({ kind: 'cancel', task })}>
                          {t('adm.monitor.action.cancel')}
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </StateBoundary>
      {acting?.kind === 'reassign' ? <ReassignDialog task={acting.task} onClose={() => setActing(undefined)} /> : null}
      {acting?.kind === 'cancel' ? <CancelDialog task={acting.task} onClose={() => setActing(undefined)} /> : null}
    </section>
  );
}

function ReassignDialog({ task, onClose }: { task: MonitorTask; onClose: () => void }) {
  const { t } = useTranslation();
  const reassign = useReassign();
  const members = useAssignees(true);
  const [to, setTo] = useState('');
  const [reason, setReason] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const noTarget = to === '';
  const tooShort = reason.trim().length < REASON_MIN;
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (reassign.isPending || noTarget || tooShort) return;
    reassign.mutate({ taskId: task.id, version: task.version, to, reason: reason.trim() }, { onSuccess: onClose });
  };
  return (
    <CommandFrame
      title={t('adm.monitor.reassign.title')}
      refusal={reassign.isError ? problemMessage(t, describeProblem(reassign.error)) : undefined}
      pending={reassign.isPending}
      submitLabel={t('adm.monitor.reassign.submit')}
      words={{ close: t('adm.monitor.dialog.close'), cancel: t('adm.monitor.dialog.cancel'), pending: t('adm.monitor.dialog.pending') }}
      onSubmit={send}
      onClose={onClose}
    >
      <fieldset disabled={reassign.isPending}>
        <p>{t('adm.monitor.reassign.text', { assignee: task.assigneeName === '' ? t('adm.monitor.none') : task.assigneeName })}</p>
        <Field id="reassign-to" label={t('adm.monitor.reassign.assignee')} error={submitted && noTarget ? t('adm.monitor.problem.assigneeRequired') : undefined}>
          <select id="reassign-to" value={to} onChange={(event) => setTo(event.target.value)}>
            <option value="">{t('adm.monitor.reassign.choose')}</option>
            {(members.data ?? [])
              .filter((member) => member.id !== task.assigneeId)
              .map((member) => (
                <option key={member.id} value={member.id}>
                  {member.name}
                </option>
              ))}
          </select>
        </Field>
        <Field id="reassign-reason" label={t('adm.monitor.reassign.reason')} error={submitted && tooShort ? t('adm.monitor.problem.reasonShort') : undefined}>
          <textarea id="reassign-reason" value={reason} maxLength={2000} onChange={(event) => setReason(event.target.value)} />
        </Field>
      </fieldset>
    </CommandFrame>
  );
}

function CancelDialog({ task, onClose }: { task: MonitorTask; onClose: () => void }) {
  const { t } = useTranslation();
  const cancel = useCancelInstance();
  const [reason, setReason] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const tooShort = reason.trim().length < REASON_MIN;
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (cancel.isPending || tooShort) return;
    cancel.mutate({ instanceId: task.instanceId, version: task.instanceVersion, reason: reason.trim() }, { onSuccess: onClose });
  };
  return (
    <CommandFrame
      title={t('adm.monitor.cancel.title')}
      refusal={cancel.isError ? problemMessage(t, describeProblem(cancel.error)) : undefined}
      pending={cancel.isPending}
      submitLabel={t('adm.monitor.cancel.submit')}
      words={{ close: t('adm.monitor.dialog.close'), cancel: t('adm.monitor.dialog.cancel'), pending: t('adm.monitor.dialog.pending') }}
      onSubmit={send}
      onClose={onClose}
    >
      <fieldset disabled={cancel.isPending}>
        <p>{t('adm.monitor.cancel.text', { record: `${task.resourceType} ${task.resourceId.slice(0, 8)}` })}</p>
        <Field id="cancel-reason" label={t('adm.monitor.cancel.reason')} error={submitted && tooShort ? t('adm.monitor.problem.reasonShort') : undefined}>
          <textarea id="cancel-reason" value={reason} maxLength={2000} onChange={(event) => setReason(event.target.value)} />
        </Field>
      </fieldset>
    </CommandFrame>
  );
}
