import { useId, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { useTranslation } from '../../../i18n';
import type { Translator } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { NavigationDialog } from '../../../shell/NavigationDialog';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { Field } from '../components';
import { useProjects, useUnits } from '../hooks';
import '../prj.css';
import { useDecideTransfer, useImpact, useRequestTransfer, useTransfers } from './hooks';
import {
  APPROVE_PERMISSION,
  EMPTY_REQUEST,
  REQUEST_PERMISSION,
  SCOPES,
  UNIT_LIST_PERMISSION,
  STATUSES,
  canDecide,
  currentUnitId,
  describeTransfer,
  holds,
  requestBody,
  targetUnitId,
  validateDecision,
  validateRequest,
  vietnamToday,
} from './model';
import type { Decision, FormProblem, RequestField, RequestForm, Scope, Status, TransferProblem, TransferView } from './model';

type T = Translator['t'];
const NONE = '—';
const CLOSE_GLYPH = '×';

function problemMessage(t: T, problem: TransferProblem): string {
  switch (problem) {
    case 'pendingExists':
      return t('prj.transfer.problem.pendingExists');
    case 'selfApproval':
      return t('prj.transfer.problem.selfApproval');
    case 'versionConflict':
      return t('prj.transfer.problem.versionConflict');
    case 'stageDenied':
      return t('prj.transfer.problem.stageDenied');
    case 'scopeDenied':
      return t('prj.transfer.problem.scopeDenied');
    case 'projectClosed':
      return t('prj.transfer.problem.projectClosed');
    case 'documentInvalid':
      return t('prj.transfer.problem.documentInvalid');
    case 'validation':
      return t('prj.transfer.problem.validation');
    case 'notFound':
      return t('prj.transfer.problem.notFound');
    case 'general':
      return t('prj.transfer.problem.general');
  }
}

function statusLabel(t: T, status: Status): string {
  switch (status) {
    case 'REQUESTED':
      return t('prj.transfer.status.requested');
    case 'APPROVED':
      return t('prj.transfer.status.approved');
    case 'APPLIED':
      return t('prj.transfer.status.applied');
    case 'REJECTED':
      return t('prj.transfer.status.rejected');
    case 'CANCELLED':
      return t('prj.transfer.status.cancelled');
  }
}

const scopeLabel = (t: T, scope: Scope): string => (scope === 'OWNER_UNIT' ? t('prj.transfer.scope.owner') : t('prj.transfer.scope.investor'));
const statusTone = (status: Status): 'green' | 'warn' | 'gray' | 'blue' => (status === 'APPLIED' ? 'green' : status === 'REJECTED' || status === 'CANCELLED' ? 'gray' : status === 'APPROVED' ? 'blue' : 'warn');

function fieldMessage(t: T, problem: FormProblem | undefined): string | undefined {
  switch (problem) {
    case undefined:
      return undefined;
    case 'required':
      return t('prj.transfer.field.required.error');
    case 'past':
      return t('prj.transfer.field.past.error');
    case 'same':
      return t('prj.transfer.field.same.error');
    case 'invalid':
      return t('prj.transfer.field.invalid.error');
  }
}

/**
 * PRJ-20: the transfer of a project between units (ST-PRJ-007, PRJ 3.1 F10). The investor asks that another unit of the tenant become the owner unit or the investor unit of a project from a day, after seeing what it
 * would change (the reports and the snapshots before the day stay under the old unit; the plan lines follow the project; who gains or loses sight of it); someone else decides, and the change is made on the day.
 */
export default function TransferScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <TransferContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function TransferContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode, tenant } = useSession();
  const [status, setStatus] = useState('');
  const [deciding, setDeciding] = useState<TransferView | undefined>(undefined);
  const list = useTransfers(status);
  const items = (list.data?.pages ?? []).flatMap((page) => page.items);
  const state = useScreenState({ isLoading: list.isLoading, error: list.error, data: list.data === undefined ? undefined : items, isEmpty: () => items.length === 0 && status === '' && !holds(permissions, REQUEST_PERMISSION, mode) });
  const approve = holds(permissions, APPROVE_PERMISSION, mode);
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('prj.transfer.page.title')}</h1>
          <p>{t('prj.transfer.page.subtitle')}</p>
        </div>
      </div>
      {holds(permissions, REQUEST_PERMISSION, mode) ? <RequestPanel /> : null}
      <div className="prj-filters">
        <label htmlFor="transfer-status">{t('prj.transfer.filter.status.label')}</label>
        <select id="transfer-status" value={status} onChange={(event) => setStatus(event.target.value)}>
          <option value="">{t('prj.transfer.filter.status.all')}</option>
          {STATUSES.map((value) => (
            <option key={value} value={value}>
              {statusLabel(t, value)}
            </option>
          ))}
        </select>
      </div>
      <StateBoundary state={state} onRetry={() => void list.refetch()}>
        <div className="tablewrap">
          <table className="table" aria-label={t('prj.transfer.list.aria')} data-testid="transfers">
            <thead>
              <tr>
                <th scope="col">{t('prj.transfer.col.project')}</th>
                <th scope="col">{t('prj.transfer.col.current')}</th>
                <th scope="col">{t('prj.transfer.col.target')}</th>
                <th scope="col">{t('prj.transfer.col.scope')}</th>
                <th scope="col">{t('prj.transfer.col.effective')}</th>
                <th scope="col">{t('prj.transfer.col.basis')}</th>
                <th scope="col">{t('prj.transfer.col.status')}</th>
                <th scope="col">
                  <span className="sr-only">{t('prj.transfer.col.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id} data-transfer={item.id} data-status={item.status}>
                  <td>
                    {item.projectCode} {item.projectName}
                  </td>
                  <td>{item.fromUnitName}</td>
                  <td>{item.toUnitName}</td>
                  <td>{scopeLabel(t, item.scope)}</td>
                  <td>{item.effectiveDate}</td>
                  <td>
                    {item.reason}
                    {item.decisionReason === null ? null : <span className="prj-code">{t('prj.transfer.decision.note', { note: item.decisionReason })}</span>}
                  </td>
                  <td>
                    <span className={`pill ${statusTone(item.status)}`} data-status={item.status}>
                      {statusLabel(t, item.status)}
                    </span>
                  </td>
                  <td>
                    {approve && canDecide(item, tenant?.membershipId) ? (
                      <button type="button" onClick={() => setDeciding(item)}>
                        {t('prj.transfer.decide.action')}
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {list.hasNextPage ? (
          <p>
            <button type="button" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
              {t('prj.transfer.more.action')}
            </button>
          </p>
        ) : null}
      </StateBoundary>
      {deciding === undefined ? null : <DecisionDialog item={deciding} onClose={() => setDeciding(undefined)} />}
      <p className="prototype-note">{t('prj.transfer.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function RequestPanel() {
  const { t } = useTranslation();
  const send = useRequestTransfer();
  const projects = useProjects();
  const { permissions } = useSession();
  const mayList = holds(permissions, UNIT_LIST_PERMISSION, undefined);
  const units = useUnits(mayList);
  const [form, setForm] = useState<RequestForm>(EMPTY_REQUEST);
  const [problems, setProblems] = useState<Partial<Record<RequestField, FormProblem>>>({});
  const [saved, setSaved] = useState(false);
  const project = (projects.data ?? []).find((candidate) => candidate.id === form.projectId);
  const current = project === undefined ? null : currentUnitId(project, form.scope);
  const currentName = project === undefined ? undefined : form.scope === 'OWNER_UNIT' ? project.ownerUnitName : project.investorUnitName;
  const target = targetUnitId(form);
  const usableTarget = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(target) && target !== current;
  const impact = useImpact(form.projectId, usableTarget ? target : '', form.scope);
  const refusal = send.isError ? describeTransfer(send.error) : undefined;
  const set = (patch: Partial<RequestForm>): void => {
    setSaved(false);
    setForm((value) => ({ ...value, ...patch }));
  };
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const found = validateRequest(form, vietnamToday(), current);
    setProblems(found);
    if (Object.keys(found).length > 0 || send.isPending) return;
    send.mutate(
      { projectId: form.projectId, version: project?.version ?? 0, body: requestBody(form) },
      {
        onSuccess: () => {
          setForm(EMPTY_REQUEST);
          setSaved(true);
        },
      },
    );
  };
  const error = (field: RequestField): string | undefined => fieldMessage(t, problems[field]);
  return (
    <form className="card" onSubmit={submit} noValidate aria-label={t('prj.transfer.form.title')}>
      <h2>{t('prj.transfer.form.title')}</h2>
      <p className="sub">{t('prj.transfer.form.help')}</p>
      {refusal === undefined ? null : (
        <p className="callout warning" role="alert" data-testid="request-refusal">
          {problemMessage(t, refusal)}
        </p>
      )}
      {saved ? (
        <p className="callout" role="status" data-testid="request-saved">
          {t('prj.transfer.form.saved')}
        </p>
      ) : null}
      <Field id="transfer-project" label={t('prj.transfer.field.project.label')} error={error('projectId')}>
        <select id="transfer-project" value={form.projectId} onChange={(event) => set({ projectId: event.target.value })}>
          <option value="">{NONE}</option>
          {(projects.data ?? []).map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.code} {candidate.name}
            </option>
          ))}
        </select>
      </Field>
      <Field id="transfer-scope" label={t('prj.transfer.field.scope.label')} error={undefined}>
        <select id="transfer-scope" value={form.scope} onChange={(event) => set({ scope: event.target.value as Scope })}>
          {SCOPES.map((value) => (
            <option key={value} value={value}>
              {scopeLabel(t, value)}
            </option>
          ))}
        </select>
      </Field>
      <p data-testid="transfer-current">
        <strong>{t('prj.transfer.field.current.label')}</strong> {project === undefined ? NONE : (currentName ?? t('prj.transfer.field.current.none'))}
      </p>
      {units.isError ? (
        <p className="callout warning" role="alert" data-testid="units-failed">
          {t('prj.transfer.field.target.failed')}
        </p>
      ) : null}
      {mayList && !units.isError ? (
        <Field id="transfer-target" label={t('prj.transfer.field.target.label')} error={error('toUnitId')}>
          <select id="transfer-target" value={form.toUnitId} onChange={(event) => set({ toUnitId: event.target.value })}>
            <option value="">{NONE}</option>
            {(units.data ?? []).map((unit) => (
              <option key={unit.id} value={unit.id}>
                {unit.code} {unit.name}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
      <Field id="transfer-target-id" label={t('prj.transfer.field.targetId.label')} error={mayList && !units.isError ? undefined : error('toUnitId')} hint={t('prj.transfer.field.targetId.hint')}>
        <input id="transfer-target-id" type="text" value={form.toUnitInput} onChange={(event) => set({ toUnitInput: event.target.value })} />
      </Field>
      <Field id="transfer-effective" label={t('prj.transfer.field.effective.label')} error={error('effectiveDate')} hint={t('prj.transfer.field.effective.hint')}>
        <input id="transfer-effective" type="date" value={form.effectiveDate} onChange={(event) => set({ effectiveDate: event.target.value })} />
      </Field>
      <Field id="transfer-reason" label={t('prj.transfer.field.reason.label')} error={error('reason')} hint={t('prj.transfer.field.reason.hint')}>
        <textarea id="transfer-reason" rows={3} value={form.reason} onChange={(event) => set({ reason: event.target.value })} />
      </Field>
      <Field id="transfer-document" label={t('prj.transfer.field.document.label')} error={error('documentId')} hint={t('prj.transfer.field.document.hint')}>
        <input id="transfer-document" type="text" value={form.documentId} onChange={(event) => set({ documentId: event.target.value })} />
      </Field>
      <ImpactPanel impact={impact.data} loading={impact.isFetching} failed={impact.isError} selected={form.projectId !== '' && usableTarget} />
      <div className="formfooter">
        <button type="submit" className="primary" disabled={send.isPending}>
          {t('prj.transfer.form.submit.action')}
        </button>
      </div>
    </form>
  );
}

function ImpactPanel({ impact, loading, failed, selected }: { impact: ReturnType<typeof useImpact>['data']; loading: boolean; failed: boolean; selected: boolean }): ReactNode {
  const { t } = useTranslation();
  if (!selected) return <p className="muted">{t('prj.transfer.impact.choose')}</p>;
  if (failed) {
    return (
      <p className="callout warning" role="alert" data-testid="impact-failed">
        {t('prj.transfer.impact.failed')}
      </p>
    );
  }
  if (impact === undefined) return loading ? <p className="muted">{t('prj.transfer.impact.loading')}</p> : null;
  return (
    <section aria-labelledby="impact-title" data-testid="impact">
      <h3 id="impact-title">{t('prj.transfer.impact.title')}</h3>
      <ul>
        <li data-testid="impact-reports">{t('prj.transfer.impact.reports', { reports: impact.reports, snapshots: impact.snapshotLines, unit: impact.fromUnitName })}</li>
        <li data-testid="impact-plan">{t('prj.transfer.impact.plan', { lines: impact.planLines, unit: impact.toUnitName })}</li>
        <li data-testid="impact-users">{t('prj.transfer.impact.users', { gaining: impact.usersGaining, losing: impact.usersLosing })}</li>
      </ul>
      {impact.partial ? <p className="sub">{t('prj.transfer.impact.partial')}</p> : null}
    </section>
  );
}

function DecisionDialog({ item, onClose }: { item: TransferView; onClose(): void }) {
  const { t } = useTranslation();
  const titleId = useId();
  const send = useDecideTransfer();
  const [decision, setDecision] = useState<Decision>('approve');
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<FormProblem | undefined>(undefined);
  const refusal = send.isError ? describeTransfer(send.error) : undefined;
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const found = validateDecision(reason);
    setProblem(found);
    if (found !== undefined || send.isPending) return;
    send.mutate({ id: item.id, version: item.version, decision, reason }, { onSuccess: onClose });
  };
  return (
    <NavigationDialog className="catalog command-mode" onClose={onClose}>
      <section className="command-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="command-titlebar">
          <strong id={titleId}>{t('prj.transfer.decide.title', { project: item.projectCode })}</strong>
          <button type="button" className="icon-button" aria-label={t('prj.transfer.dialog.close.label')} onClick={onClose}>
            {CLOSE_GLYPH}
          </button>
        </div>
        <form className="dis-dialog-body" onSubmit={submit} noValidate>
          <p data-testid="decide-summary">{t('prj.transfer.decide.summary', { from: item.fromUnitName, to: item.toUnitName, date: item.effectiveDate })}</p>
          {refusal === undefined ? null : (
            <p className="callout warning" role="alert" data-testid="decide-refusal">
              {problemMessage(t, refusal)}
            </p>
          )}
          <fieldset>
            <legend>{t('prj.transfer.decide.decision.label')}</legend>
            {(['approve', 'reject', 'return'] as const).map((value) => (
              <label key={value}>
                <input type="radio" name="transfer-decision" value={value} checked={decision === value} onChange={() => setDecision(value)} />{' '}
                {value === 'approve' ? t('prj.transfer.decide.approve') : value === 'reject' ? t('prj.transfer.decide.reject') : t('prj.transfer.decide.return')}
              </label>
            ))}
          </fieldset>
          <Field id="transfer-decision-reason" label={t('prj.transfer.decide.reason.label')} error={fieldMessage(t, problem)} hint={t('prj.transfer.decide.reason.hint')}>
            <textarea id="transfer-decision-reason" rows={3} value={reason} onChange={(event) => (setReason(event.target.value), setProblem(undefined))} />
          </Field>
          <div className="formfooter">
            <button type="button" onClick={onClose}>
              {t('prj.transfer.dialog.cancel.action')}
            </button>
            <button type="submit" className="primary" disabled={send.isPending}>
              {t('prj.transfer.decide.submit.action')}
            </button>
          </div>
        </form>
      </section>
    </NavigationDialog>
  );
}
