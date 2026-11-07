import { useMemo, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { CommandFrame } from '../../qms/CommandFrame';
import { Field } from '../components';
import { root, useMembers } from '../hooks';
import { useAssignIncident, useDecideException, useExceptions, useIncident, useIncidents, useTransitionIncident, useVerifyIncident } from './hooks';
import { advanceLabel, eventLabel, exceptionStatusLabel, formProblemMessage, problemMessage, severityLabel, statusLabel } from './labels';
import { INCIDENT_STATUSES, MEMBERS_PERMISSION, NO_FILTER, SEVERITIES, assignBody, decisionBody, describeProblem, emptyAssign, emptyDecision, emptyResolve, emptyVerify, referenceLines, validateAssign, validateDecision, validateResolve, validateVerify } from './model';
import type { AssignForm, DecisionForm, ExceptionView, IncidentFilter, IncidentView, ResolveForm, VerifyForm } from './model';
import '../dgv.css';
import '../dgv-kit.css';

const INCIDENT_PARAM = 'incident';

type Dialog = { kind: 'assign' } | { kind: 'resolve' } | { kind: 'verify' } | { kind: 'decide'; exception: ExceptionView };

/**
 * DGV-08: the incidents of data quality and the exceptions behind them (ST-DGV-003, DGV 3.3 F4). A failed rule opens an incident with a due time by its severity; a steward gives it to an engineer, who acknowledges it, works it and
 * resolves it with the cause and the measure; another person closes it after a run that passes, or sends it back. A record that failed may be resolved or waived for at most 180 days by someone who does not own it. What each
 * person may do comes from the server (`actions`); the server judges every command again and says why it refuses.
 */
export default function IncidentWorkspaceScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The list, the chosen incident and the open forms belong to one membership: a switch of tenant or of membership starts the screen over.
  return <WorkspaceContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function WorkspaceContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { mode, tenant } = useSession();
  const queryClient = useQueryClient();
  const [search, setSearch] = useSearchParams();
  const chosen = search.get(INCIDENT_PARAM) ?? undefined;
  const [filter, setFilter] = useState<IncidentFilter>(NO_FILTER);
  const list = useIncidents(filter);
  const detail = useIncident(chosen);
  const [dialog, setDialog] = useState<Dialog | undefined>(undefined);
  const [changed, setChanged] = useState(false);
  const transition = useTransitionIncident();
  const rows = useMemo(() => (list.data?.pages ?? []).flatMap((entry) => entry.items), [list.data]);
  const state = useScreenState({ isLoading: list.isLoading, error: list.error, data: list.data, isEmpty: () => false });
  const acting = mode !== 'READ_ONLY';
  const moment = (iso: string): string => (iso === '' ? t('dgv.incident.none') : new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date(iso)));
  const change = (patch: Partial<IncidentFilter>): void => setFilter({ ...filter, ...patch });
  const open = (id: string | undefined): void => {
    setChanged(false);
    setDialog(undefined);
    const next = new URLSearchParams(search);
    if (id === undefined) next.delete(INCIDENT_PARAM);
    else next.set(INCIDENT_PARAM, id);
    setSearch(next, { replace: true });
  };
  const show = (next: Dialog): void => {
    setChanged(false);
    setDialog(next);
  };
  const conflict = (): void => {
    setDialog(undefined);
    setChanged(true);
    // The incident changed meanwhile (another person, the sweep): read it again, so that the next try is made under the version that is there.
    void queryClient.invalidateQueries({ queryKey: root(tenant?.id) });
  };
  const incident = detail.data ?? undefined;
  const advanceRefusal = changed ? problemMessage(t, 'versionConflict') : transition.isError ? problemMessage(t, describeProblem(transition.error)) : undefined;

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('dgv.incident.title')}</h1>
          <p>{t('dgv.incident.subtitle')}</p>
        </div>
      </div>
      <div className="card">
        <div className="field">
          <label htmlFor="incident-filter-status">{t('dgv.incident.column.status')}</label>
          <select id="incident-filter-status" value={filter.status} onChange={(event) => change({ status: event.target.value })}>
            <option value="">{t('dgv.incident.filter.all')}</option>
            {INCIDENT_STATUSES.map((status) => (
              <option key={status} value={status}>
                {statusLabel(t, status)}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="incident-filter-severity">{t('dgv.incident.column.severity')}</label>
          <select id="incident-filter-severity" value={filter.severity} onChange={(event) => change({ severity: event.target.value })}>
            <option value="">{t('dgv.incident.filter.all')}</option>
            {SEVERITIES.map((severity) => (
              <option key={severity} value={severity}>
                {severityLabel(t, severity)}
              </option>
            ))}
          </select>
        </div>
        <label htmlFor="incident-filter-overdue">
          <input id="incident-filter-overdue" type="checkbox" checked={filter.overdue} onChange={(event) => change({ overdue: event.target.checked })} /> {t('dgv.incident.filter.overdue')}
        </label>{' '}
        <label htmlFor="incident-filter-mine">
          <input id="incident-filter-mine" type="checkbox" checked={filter.mine} onChange={(event) => change({ mine: event.target.checked })} /> {t('dgv.incident.filter.mine')}
        </label>
      </div>
      <StateBoundary state={state} onRetry={() => void list.refetch()}>
        <div className="card">
          {rows.length === 0 ? (
            <p className="callout" role="status" data-testid="no-incidents">
              {t('dgv.incident.none.notice')}
            </p>
          ) : (
            <table className="table" data-testid="incidents">
              <thead>
                <tr>
                  <th scope="col">{t('dgv.incident.column.title')}</th>
                  <th scope="col">{t('dgv.incident.column.severity')}</th>
                  <th scope="col">{t('dgv.incident.column.status')}</th>
                  <th scope="col">{t('dgv.incident.column.assignee')}</th>
                  <th scope="col">{t('dgv.incident.column.due')}</th>
                  <th scope="col">
                    <span className="sr-only">{t('dgv.incident.column.actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} data-incident={row.id} data-selected={row.id === chosen ? 'yes' : 'no'} data-overdue={row.isOverdue ? 'yes' : 'no'}>
                    <td>
                      <strong>{row.title}</strong>
                      <small className="sub">{row.datasetCode}</small>
                    </td>
                    <td data-testid="severity">{severityLabel(t, row.severity)}</td>
                    <td data-testid="status">{statusLabel(t, row.status)}</td>
                    <td>{row.assigneeName ?? t('dgv.incident.none')}</td>
                    <td>
                      {moment(row.dueAt)}
                      {row.isOverdue ? (
                        <span className="pill danger" data-testid="overdue">
                          {t('dgv.incident.overdue')}
                        </span>
                      ) : null}
                    </td>
                    <td>
                      <button type="button" onClick={() => open(row.id)}>
                        {t('dgv.incident.open.action')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {list.hasNextPage ? (
            <button type="button" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
              {t('dgv.incident.more.action')}
            </button>
          ) : null}
        </div>
      </StateBoundary>
      {chosen === undefined ? null : detail.isError ? (
        <div className="callout warning" role="alert" data-testid="detail-failed">
          {t('dgv.incident.error.general')}{' '}
          <button type="button" onClick={() => void detail.refetch()}>
            {t('dgv.incident.retry')}
          </button>
        </div>
      ) : incident === undefined ? (
        detail.isLoading ? (
          <p className="callout" role="status">
            {t('dgv.incident.loading')}
          </p>
        ) : (
          <p className="callout warning" role="alert" data-testid="detail-missing">
            {t('dgv.incident.error.notFound')}
          </p>
        )
      ) : (
        <div className="card" data-testid="detail">
          <div className="heading">
            <strong data-testid="detail-title">{incident.title}</strong>
            <button type="button" onClick={() => open(undefined)}>
              {t('dgv.incident.close.action')}
            </button>
          </div>
          {advanceRefusal === undefined ? null : (
            <p className="callout warning" role="alert" data-testid="refusal">
              {advanceRefusal}
            </p>
          )}
          <Facts incident={incident} moment={moment} />
          {acting ? (
            <div className="actions">
              {incident.actions.assign ? (
                <button type="button" className="ui-button ui-button--primary" data-action="assign" onClick={() => show({ kind: 'assign' })}>
                  {incident.assigneeId === null ? t('dgv.incident.assign.action') : t('dgv.incident.reassign.action')}
                </button>
              ) : null}
              {incident.actions.advance === null ? null : incident.actions.advance === 'RESOLVED_PENDING_VERIFICATION' ? (
                <button type="button" className="ui-button ui-button--primary" data-action="resolve" onClick={() => show({ kind: 'resolve' })}>
                  {advanceLabel(t, incident.actions.advance)}
                </button>
              ) : (
                <button
                  type="button"
                  className="ui-button ui-button--primary"
                  data-action="advance"
                  disabled={transition.isPending}
                  onClick={() => {
                    setChanged(false);
                    const step = incident.actions.advance;
                    if (step !== null) transition.mutate({ id: incident.id, version: incident.version, body: { to_status: step } }, { onError: (error) => (describeProblem(error) === 'versionConflict' ? conflict() : undefined) });
                  }}
                >
                  {advanceLabel(t, incident.actions.advance)}
                </button>
              )}
              {incident.actions.verify ? (
                <button type="button" className="ui-button ui-button--primary" data-action="verify" onClick={() => show({ kind: 'verify' })}>
                  {t('dgv.incident.verify.action')}
                </button>
              ) : null}
            </div>
          ) : null}
          <History incident={incident} moment={moment} />
          <Exceptions incidentId={incident.id} acting={acting} onDecide={(exception) => setDialog({ kind: 'decide', exception })} moment={moment} />
        </div>
      )}
      <div className="card">
        <Exceptions incidentId={undefined} acting={acting} onDecide={(exception) => show({ kind: 'decide', exception })} moment={moment} />
      </div>
      {dialog?.kind === 'assign' && incident !== undefined ? <AssignDialog incident={incident} onClose={() => setDialog(undefined)} onConflict={conflict} /> : null}
      {dialog?.kind === 'resolve' && incident !== undefined ? <ResolveDialog incident={incident} onClose={() => setDialog(undefined)} onConflict={conflict} /> : null}
      {dialog?.kind === 'verify' && incident !== undefined ? <VerifyDialog incident={incident} onClose={() => setDialog(undefined)} onConflict={conflict} /> : null}
      {dialog?.kind === 'decide' ? <DecideDialog exception={dialog.exception} onClose={() => setDialog(undefined)} onConflict={conflict} /> : null}
      <p className="prototype-note">{t('dgv.incident.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function Facts({ incident, moment }: { incident: IncidentView; moment: (iso: string) => string }) {
  const { t } = useTranslation();
  const row = (label: string, value: ReactNode, testId: string) => (
    <div className="row" data-testid={testId}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
  return (
    <dl className="facts">
      {row(t('dgv.incident.column.severity'), severityLabel(t, incident.severity), 'fact-severity')}
      {row(t('dgv.incident.column.status'), statusLabel(t, incident.status), 'fact-status')}
      {row(t('dgv.incident.fact.dataset'), `${incident.datasetCode} · ${incident.ruleCode}`, 'fact-dataset')}
      {row(t('dgv.incident.fact.owner'), incident.ownerName ?? t('dgv.incident.none'), 'fact-owner')}
      {row(t('dgv.incident.column.assignee'), incident.assigneeName ?? t('dgv.incident.none'), 'fact-assignee')}
      {row(t('dgv.incident.column.due'), `${moment(incident.dueAt)}${incident.slaHours === null ? '' : ` · ${t('dgv.incident.fact.sla', { hours: incident.slaHours })}`}`, 'fact-due')}
      {incident.rootCause === null ? null : row(t('dgv.incident.fact.rootCause'), incident.rootCause, 'fact-root-cause')}
      {incident.remediation === null ? null : row(t('dgv.incident.fact.remediation'), incident.remediation, 'fact-remediation')}
      {incident.verifiedAt === null ? null : row(t('dgv.incident.fact.verifiedAt'), moment(incident.verifiedAt), 'fact-verified')}
      {incident.reopenedCount === 0 ? null : row(t('dgv.incident.fact.reopened'), String(incident.reopenedCount), 'fact-reopened')}
    </dl>
  );
}

function History({ incident, moment }: { incident: IncidentView; moment: (iso: string) => string }) {
  const { t } = useTranslation();
  return (
    <section aria-label={t('dgv.incident.history.title')}>
      <h2>{t('dgv.incident.history.title')}</h2>
      <ol data-testid="history">
        {incident.events.map((entry) => (
          <li key={entry.id} data-event={entry.kind}>
            <strong>{eventLabel(t, entry.kind)}</strong> {entry.toStatus === null ? '' : `→ ${entry.toStatus}`} · {entry.actorName ?? t('dgv.incident.system')} · {moment(entry.occurredAt)}
            {entry.note === null ? null : <small className="sub"> {entry.note}</small>}
          </li>
        ))}
      </ol>
    </section>
  );
}

/** The exceptions, a page at a time: under an incident (its records) or on their own, for a reviewer who may not read the incident. */
function Exceptions({ incidentId, acting, onDecide, moment }: { incidentId: string | undefined; acting: boolean; onDecide: (exception: ExceptionView) => void; moment: (iso: string) => string }) {
  const { t } = useTranslation();
  const [status, setStatus] = useState(incidentId === undefined ? 'OPEN' : '');
  const exceptions = useExceptions({ incidentId, status });
  const items = (exceptions.data?.pages ?? []).flatMap((entry) => entry.items);
  return (
    <section aria-label={t('dgv.incident.exceptions.title')} data-testid={incidentId === undefined ? 'exception-queue' : 'incident-exceptions'}>
      <h2>{t('dgv.incident.exceptions.title')}</h2>
      {incidentId === undefined ? (
        <div className="field">
          <label htmlFor="exception-filter-status">{t('dgv.incident.column.status')}</label>
          <select id="exception-filter-status" value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="">{t('dgv.incident.filter.all')}</option>
            {(['OPEN', 'RESOLVED', 'WAIVED'] as const).map((value) => (
              <option key={value} value={value}>
                {exceptionStatusLabel(t, value)}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      {exceptions.isError ? (
        <p className="callout warning" role="alert" data-testid="exceptions-failed">
          {t('dgv.incident.error.general')}
        </p>
      ) : items.length === 0 ? (
        <p className="sub" data-testid="no-exceptions">
          {t('dgv.incident.exceptions.none')}
        </p>
      ) : (
        <ul data-testid="exceptions">
          {items.map((item) => (
            <li key={item.id} data-exception={item.id} data-status={item.status}>
              <strong>{exceptionStatusLabel(t, item.status)}</strong> · {item.reason}
              {item.masked ? (
                <span className="pill" data-testid="masked">
                  {t('dgv.incident.exceptions.masked')}
                </span>
              ) : null}
              <small className="sub" data-testid="reference">
                {item.datasetCode} · {referenceLines(item.recordReference).join(' · ')}
              </small>
              {item.waiverExpiresAt === null ? null : <small className="sub">{t('dgv.incident.exceptions.waivedUntil', { time: moment(item.waiverExpiresAt) })}</small>}
              {item.reopenedFromId === null ? null : <small className="sub">{t('dgv.incident.exceptions.reopenedFrom')}</small>}
              {acting && item.canDecide ? (
                <button type="button" data-action="decide" onClick={() => onDecide(item)}>
                  {t('dgv.incident.exceptions.decide')}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {exceptions.hasNextPage ? (
        <button type="button" disabled={exceptions.isFetchingNextPage} onClick={() => void exceptions.fetchNextPage()}>
          {t('dgv.incident.more.action')}
        </button>
      ) : null}
    </section>
  );
}

interface DialogProps {
  incident: IncidentView;
  onClose(): void;
  /** The incident changed since the person read it: the dialog is closed, the incident is read again. */
  onConflict(): void;
}

/** The frame the commands are asked in: the title, the refusal of the server in words, the fields (held while the command is on its way) and the two buttons. */
function Frame({ title, error, hasError, pending, submitLabel, onSubmit, onClose, children }: { title: string; error: unknown; hasError: boolean; pending: boolean; submitLabel: string; onSubmit(event: FormEvent): void; onClose(): void; children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <CommandFrame
      title={title}
      refusal={hasError ? problemMessage(t, describeProblem(error)) : undefined}
      pending={pending}
      submitLabel={submitLabel}
      words={{ close: t('dgv.incident.dialog.close'), cancel: t('dgv.incident.dialog.cancel'), pending: t('dgv.incident.dialog.pending') }}
      onSubmit={onSubmit}
      onClose={onClose}
    >
      <fieldset className="incident-fields" disabled={pending}>
        {children}
      </fieldset>
    </CommandFrame>
  );
}

const settle = (onClose: () => void, onConflict: () => void) => ({ onSuccess: onClose, onError: (error: unknown) => (describeProblem(error) === 'versionConflict' ? onConflict() : undefined) });

function AssignDialog({ incident, onClose, onConflict }: DialogProps) {
  const { t } = useTranslation();
  const { permissions } = useSession();
  const assign = useAssignIncident();
  const canList = permissions === undefined || permissions.includes(MEMBERS_PERMISSION);
  const members = useMembers(canList);
  const [opened] = useState(() => ({ id: incident.id, version: incident.version }));
  const [form, setForm] = useState<AssignForm>(() => ({ ...emptyAssign(), assigneeId: incident.assigneeId ?? '' }));
  const [submitted, setSubmitted] = useState(false);
  const problems = validateAssign(form, new Date());
  // The people who can be chosen are listed where the caller may list members; otherwise the id of the member is typed and the server judges it.
  const typed = !canList || members.isError || (members.isSuccess && (members.data ?? []).length === 0);
  const shown = (field: keyof AssignForm): string | undefined => {
    const problem = problems[field];
    return submitted && problem !== undefined ? formProblemMessage(t, problem) : undefined;
  };
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (assign.isPending || Object.keys(problems).length > 0) return;
    assign.mutate({ id: opened.id, version: opened.version, body: assignBody(form) }, settle(onClose, onConflict));
  };
  return (
    <Frame title={t('dgv.incident.assign.title')} error={assign.error} hasError={assign.isError} pending={assign.isPending} submitLabel={t('dgv.incident.assign.submit')} onSubmit={send} onClose={onClose}>
      <Field id="assign-assignee" label={t('dgv.incident.column.assignee')} error={shown('assigneeId')} hint={typed ? t('dgv.incident.assign.typed') : undefined}>
        {typed ? (
          <input id="assign-assignee" autoComplete="off" value={form.assigneeId} onChange={(event) => setForm({ ...form, assigneeId: event.target.value.trim() })} />
        ) : (
          <select id="assign-assignee" value={form.assigneeId} onChange={(event) => setForm({ ...form, assigneeId: event.target.value })}>
            <option value="">{t('dgv.incident.assign.choose')}</option>
            {(members.data ?? []).map((member) => (
              <option key={member.id} value={member.id}>
                {member.name}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field id="assign-due" label={t('dgv.incident.column.due')} error={shown('dueAt')}>
        <input id="assign-due" type="datetime-local" value={form.dueAt} onChange={(event) => setForm({ ...form, dueAt: event.target.value })} />
      </Field>
      <Field id="assign-note" label={t('dgv.incident.field.note')} error={undefined}>
        <textarea id="assign-note" rows={2} value={form.note} onChange={(event) => setForm({ ...form, note: event.target.value })} />
      </Field>
    </Frame>
  );
}

function ResolveDialog({ incident, onClose, onConflict }: DialogProps) {
  const { t } = useTranslation();
  const transition = useTransitionIncident();
  const [opened] = useState(() => ({ id: incident.id, version: incident.version }));
  const [form, setForm] = useState<ResolveForm>(emptyResolve);
  const [submitted, setSubmitted] = useState(false);
  const problems = validateResolve(form);
  const shown = (field: keyof ResolveForm): string | undefined => {
    const problem = problems[field];
    return submitted && problem !== undefined ? formProblemMessage(t, problem) : undefined;
  };
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (transition.isPending || Object.keys(problems).length > 0) return;
    transition.mutate({ id: opened.id, version: opened.version, body: { to_status: 'RESOLVED_PENDING_VERIFICATION', root_cause: form.rootCause.trim(), remediation: form.remediation.trim() } }, settle(onClose, onConflict));
  };
  return (
    <Frame title={t('dgv.incident.resolve.title')} error={transition.error} hasError={transition.isError} pending={transition.isPending} submitLabel={t('dgv.incident.resolve.submit')} onSubmit={send} onClose={onClose}>
      <Field id="resolve-root-cause" label={t('dgv.incident.fact.rootCause')} error={shown('rootCause')}>
        <textarea id="resolve-root-cause" rows={3} value={form.rootCause} onChange={(event) => setForm({ ...form, rootCause: event.target.value })} />
      </Field>
      <Field id="resolve-remediation" label={t('dgv.incident.fact.remediation')} error={shown('remediation')} hint={t('dgv.incident.resolve.upstream')}>
        <textarea id="resolve-remediation" rows={3} value={form.remediation} onChange={(event) => setForm({ ...form, remediation: event.target.value })} />
      </Field>
    </Frame>
  );
}

function VerifyDialog({ incident, onClose, onConflict }: DialogProps) {
  const { t } = useTranslation();
  const verify = useVerifyIncident();
  const [opened] = useState(() => ({ id: incident.id, version: incident.version }));
  const [form, setForm] = useState<VerifyForm>(emptyVerify);
  const [submitted, setSubmitted] = useState(false);
  const problems = validateVerify(form);
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (verify.isPending || Object.keys(problems).length > 0) return;
    verify.mutate({ id: opened.id, version: opened.version, body: { decision: form.decision, note: form.note.trim() } }, settle(onClose, onConflict));
  };
  return (
    <Frame title={t('dgv.incident.verify.title')} error={verify.error} hasError={verify.isError} pending={verify.isPending} submitLabel={t('dgv.incident.verify.submit')} onSubmit={send} onClose={onClose}>
      <Field id="verify-decision" label={t('dgv.incident.verify.decision')} error={undefined} hint={t('dgv.incident.verify.rerun')}>
        <select id="verify-decision" value={form.decision} onChange={(event) => setForm({ ...form, decision: event.target.value === 'REOPEN' ? 'REOPEN' : 'CLOSE' })}>
          <option value="CLOSE">{t('dgv.incident.verify.close')}</option>
          <option value="REOPEN">{t('dgv.incident.verify.reopen')}</option>
        </select>
      </Field>
      <Field id="verify-note" label={t('dgv.incident.field.note')} error={submitted && problems.note !== undefined ? formProblemMessage(t, problems.note) : undefined}>
        <textarea id="verify-note" rows={3} value={form.note} onChange={(event) => setForm({ ...form, note: event.target.value })} />
      </Field>
    </Frame>
  );
}

function DecideDialog({ exception, onClose, onConflict }: { exception: ExceptionView; onClose(): void; onConflict(): void }) {
  const { t } = useTranslation();
  const decide = useDecideException();
  const [opened] = useState(() => ({ id: exception.id, version: exception.version }));
  const [form, setForm] = useState<DecisionForm>(emptyDecision);
  const [submitted, setSubmitted] = useState(false);
  const problems = validateDecision(form, new Date());
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (decide.isPending || Object.keys(problems).length > 0) return;
    decide.mutate({ id: opened.id, version: opened.version, body: decisionBody(form) }, settle(onClose, onConflict));
  };
  return (
    <Frame title={t('dgv.incident.decide.title')} error={decide.error} hasError={decide.isError} pending={decide.isPending} submitLabel={t('dgv.incident.decide.submit')} onSubmit={send} onClose={onClose}>
      <Field id="decide-decision" label={t('dgv.incident.decide.decision')} error={undefined}>
        <select id="decide-decision" value={form.decision} onChange={(event) => setForm({ ...form, decision: event.target.value === 'WAIVED' ? 'WAIVED' : 'RESOLVED' })}>
          <option value="RESOLVED">{t('dgv.incident.decide.resolved')}</option>
          <option value="WAIVED">{t('dgv.incident.decide.waived')}</option>
        </select>
      </Field>
      {form.decision === 'WAIVED' ? (
        <Field id="decide-until" label={t('dgv.incident.decide.until')} error={submitted && problems.waiverUntil !== undefined ? formProblemMessage(t, problems.waiverUntil) : undefined} hint={t('dgv.incident.decide.untilHint')}>
          <input id="decide-until" type="date" value={form.waiverUntil} onChange={(event) => setForm({ ...form, waiverUntil: event.target.value })} />
        </Field>
      ) : null}
      <Field id="decide-reason" label={t('dgv.incident.decide.reason')} error={submitted && problems.reason !== undefined ? formProblemMessage(t, problems.reason) : undefined}>
        <textarea id="decide-reason" rows={3} value={form.reason} onChange={(event) => setForm({ ...form, reason: event.target.value })} />
      </Field>
    </Frame>
  );
}
