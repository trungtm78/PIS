import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { Field } from './components';
import { useDecideExtension, useExtensions, useLineAvailability, useRequestExtension } from './extension/hooks';
import { decisionProblemMessage, fieldProblemMessage, problemMessage, reasonCodeLabel, statusLabel } from './extension/labels';
import {
  APPROVE_PERMISSION,
  EMPTY_DECISION,
  EMPTY_FORM,
  MAX_DECISION_REASON,
  MAX_JUSTIFICATION,
  READ_PERMISSION,
  REASON_CODES,
  REQUEST_PERMISSION,
  describeProblem,
  formatVnd,
  mayDecide,
  openRequestsOf,
  requestBody,
  undisbursedOf,
  validateDecision,
  validateForm,
  windowOf,
} from './extension/model';
import type { Decision, DecisionField, DecisionForm, ExtensionEntry, ExtensionForm, FormField, ReasonCode } from './extension/model';
import { usePlanLines, usePlans, useProjects } from './plan-hooks';
import './cap.css';

type Context = 'request' | 'decide';
type Notice = 'requested' | 'applied' | 'rejected';

interface Deciding {
  entry: ExtensionEntry;
  decision: Decision;
}

/**
 * CAP-20: the extension of the disbursement of capital to the next year. A planner picks a line of a published annual plan, sees what is left on it (allocated less committed, disbursed and
 * what other open requests already ask for), and asks to carry some of it over with a reason and the last day it may be disbursed. An approver who is not that planner approves it with
 * the document that allows it, or rejects it with a reason: an approval creates the line of the next year (bucket carry-over, with its source year and last day) and takes the capital off
 * the line of the plan year, which is not increased.
 */
export default function ExtensionScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The form, the decision and the notices belong to one membership: a switch starts the screen over.
  return <ExtensionContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function ExtensionContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { tenant, permissions, mode } = useSession();
  const frozen = mode === 'READ_ONLY';
  const holds = (permission: string): boolean => permissions === undefined || permissions.includes(permission);
  const canRequest = holds(REQUEST_PERMISSION) && !frozen;
  const canDecide = holds(APPROVE_PERMISSION) && !frozen;
  const plans = usePlans(canRequest);
  const projects = useProjects(holds('project.read'));
  const extensions = useExtensions(holds(READ_PERMISSION));
  const request = useRequestExtension();
  const decide = useDecideExtension();
  const [form, setForm] = useState<ExtensionForm>(EMPTY_FORM);
  const [attempted, setAttempted] = useState(false);
  const [deciding, setDeciding] = useState<Deciding | undefined>(undefined);
  const [decision, setDecision] = useState<DecisionForm>(EMPTY_DECISION);
  const [decisionAttempted, setDecisionAttempted] = useState(false);
  const [notice, setNotice] = useState<Notice | undefined>(undefined);
  const [context, setContext] = useState<Context>('request');

  const rows = extensions.data ?? [];
  const eligiblePlans = (plans.data ?? []).filter((plan) => plan.status === 'PUBLISHED' && plan.planKind === 'ANNUAL' && plan.planYear !== null);
  const plan = eligiblePlans.find((candidate) => candidate.id === form.planId);
  const planLines = usePlanLines(canRequest && plan !== undefined ? plan.id : undefined);
  // A line that is already capital carried over has no plan year of its own to carry over from.
  const lines = (planLines.data?.lines ?? []).filter((line) => line.bucket !== 'CARRYOVER' && !line.isExtended);
  const line = lines.find((candidate) => candidate.id === form.lineId);
  const availability = useLineAvailability(line?.id, canRequest);
  const undisbursed = availability.data === undefined ? undefined : undisbursedOf(availability.data, openRequestsOf(rows, form.lineId));
  const year = plan?.planYear ?? undefined;
  const problems = validateForm(form, { year, undisbursedVnd: undisbursed });
  const shown = attempted ? problems : {};
  const decisionProblems = deciding === undefined ? {} : validateDecision(deciding.decision, decision);
  const decisionShown = decisionAttempted ? decisionProblems : {};
  const failure = context === 'request' ? request : decide;
  const problem = failure.isError ? describeProblem(failure.error) : undefined;
  // An empty list is told inline: the form to ask for an extension stays on the screen whatever the list holds.
  const state = useScreenState({ isLoading: extensions.isLoading, error: extensions.error, data: extensions.isLoading ? undefined : rows, isEmpty: () => false });
  const projectNames = useMemo(() => new Map((projects.data ?? []).map((project) => [project.id, `${project.code} · ${project.name}`])), [projects.data]);
  const date = (value: string): string => new Date(`${value}T00:00:00Z`).toLocaleDateString(locale, { timeZone: 'UTC' });
  const person = (id: string): string =>
    tenant?.membershipId !== undefined && id.toLowerCase() === tenant.membershipId.toLowerCase() ? t('cap.extension.people.you') : id.slice(0, 8);
  const windowText = year === undefined ? undefined : windowOf(year);

  const change = <K extends keyof ExtensionForm>(field: K, value: ExtensionForm[K]): void => {
    setForm((current) => ({ ...current, [field]: value }));
    setNotice(undefined);
  };
  const pickPlan = (planId: string): void => setForm({ ...EMPTY_FORM, planId });
  const pickLine = (lineId: string): void => setForm((current) => ({ ...current, lineId, amountVnd: '', extendedTo: '' }));

  const errorOf = (field: FormField): string | undefined => {
    const found = shown[field];
    return found === undefined
      ? undefined
      : fieldProblemMessage(t, found, {
          undisbursed: formatVnd(undisbursed ?? '0', locale),
          from: windowText === undefined ? '' : date(windowText.from),
          to: windowText === undefined ? '' : date(windowText.to),
        });
  };
  const decisionErrorOf = (field: DecisionField): string | undefined => {
    const found = decisionShown[field];
    return found === undefined ? undefined : decisionProblemMessage(t, found);
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (request.isPending || !canRequest) return;
    if (Object.keys(problems).length > 0) {
      setAttempted(true);
      return;
    }
    setContext('request');
    decide.reset();
    request.mutate(
      { lineId: form.lineId, body: requestBody(form) },
      {
        onSuccess: () => {
          setNotice('requested');
          setForm({ ...EMPTY_FORM, planId: form.planId });
          setAttempted(false);
        },
      },
    );
  };

  const choose = (entry: ExtensionEntry, chosen: Decision): void => {
    setDeciding({ entry, decision: chosen });
    setDecision(EMPTY_DECISION);
    setDecisionAttempted(false);
    setNotice(undefined);
    request.reset();
    decide.reset();
  };

  const confirm = (event: FormEvent): void => {
    event.preventDefault();
    if (deciding === undefined || decide.isPending || !canDecide) return;
    if (Object.keys(decisionProblems).length > 0) {
      setDecisionAttempted(true);
      return;
    }
    setContext('decide');
    request.reset();
    decide.mutate(
      {
        id: deciding.entry.id,
        version: deciding.entry.version,
        decision: deciding.decision,
        reason: decision.reason.trim(),
        documentId: deciding.decision === 'approve' ? decision.documentId.trim().toLowerCase() : undefined,
      },
      {
        onSuccess: () => {
          setNotice(deciding.decision === 'approve' ? 'applied' : 'rejected');
          setDeciding(undefined);
        },
        // A refused decision is not tried again on the same form: the list is read again and the person looks at what is there now.
        onError: () => setDeciding(undefined),
      },
    );
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title" className="cap-extension">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('cap.extension.page.title')}</h1>
          <p>{t('cap.extension.page.subtitle')}</p>
        </div>
      </div>

      {canRequest ? (
        <form className="card cap-form" onSubmit={submit} noValidate aria-label={t('cap.extension.form.aria')}>
          <h2>{t('cap.extension.form.title')}</h2>
          <div className="formgrid">
            <Field id="cap-ext-plan" label={t('cap.extension.field.plan')} error={undefined}>
              <select id="cap-ext-plan" value={form.planId} onChange={(event) => pickPlan(event.target.value)}>
                <option value="">{t('cap.extension.plan.choose')}</option>
                {eligiblePlans.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {t('cap.extension.plan.option', { code: candidate.planCode, year: candidate.planYear ?? '', revision: candidate.revision })}
                  </option>
                ))}
              </select>
            </Field>
            <Field id="cap-ext-line" label={t('cap.extension.field.line')} error={errorOf('lineId')}>
              <select
                id="cap-ext-line"
                value={form.lineId}
                disabled={plan === undefined}
                aria-invalid={errorOf('lineId') !== undefined}
                onChange={(event) => pickLine(event.target.value)}
              >
                <option value="">{t('cap.extension.line.choose')}</option>
                {lines.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {t('cap.extension.line.option', { project: candidate.project.code, fund: candidate.fundSource.label, amount: formatVnd(candidate.amountVnd, locale) })}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          {line === undefined || year === undefined ? null : (
            <dl className="cap-extension-figures" data-testid="figures" data-undisbursed={undisbursed ?? ''}>
              <div>
                <dt>{t('cap.extension.figure.year')}</dt>
                <dd>{year}</dd>
              </div>
              <div>
                <dt>{t('cap.extension.figure.allocated')}</dt>
                <dd>{availability.data === undefined ? '…' : formatVnd(availability.data.allocatedVnd, locale)}</dd>
              </div>
              <div>
                <dt>{t('cap.extension.figure.committed')}</dt>
                <dd>{availability.data === undefined ? '…' : formatVnd(availability.data.committedVnd, locale)}</dd>
              </div>
              <div>
                <dt>{t('cap.extension.figure.disbursed')}</dt>
                <dd>{availability.data === undefined ? '…' : formatVnd(availability.data.disbursedVnd, locale)}</dd>
              </div>
              <div>
                <dt>{t('cap.extension.figure.undisbursed')}</dt>
                <dd>
                  <b>{undisbursed === undefined ? '…' : formatVnd(undisbursed, locale)}</b>
                </dd>
              </div>
            </dl>
          )}
          <div className="formgrid">
            <Field
              id="cap-ext-amount"
              label={t('cap.extension.field.amount')}
              error={errorOf('amountVnd')}
              hint={undisbursed === undefined ? undefined : t('cap.extension.amount.hint', { undisbursed: formatVnd(undisbursed, locale) })}
            >
              <input
                id="cap-ext-amount"
                inputMode="numeric"
                value={form.amountVnd}
                aria-invalid={errorOf('amountVnd') !== undefined}
                onChange={(event) => change('amountVnd', event.target.value)}
              />
            </Field>
            <Field
              id="cap-ext-until"
              label={t('cap.extension.field.until')}
              error={errorOf('extendedTo')}
              hint={windowText === undefined ? undefined : t('cap.extension.until.hint', { from: date(windowText.from), to: date(windowText.to) })}
            >
              <input
                id="cap-ext-until"
                type="date"
                value={form.extendedTo}
                aria-invalid={errorOf('extendedTo') !== undefined}
                onChange={(event) => change('extendedTo', event.target.value)}
              />
            </Field>
            <Field id="cap-ext-reason" label={t('cap.extension.field.reason')} error={errorOf('reasonCode')}>
              <select
                id="cap-ext-reason"
                value={form.reasonCode}
                aria-invalid={errorOf('reasonCode') !== undefined}
                onChange={(event) => change('reasonCode', event.target.value as ReasonCode | '')}
              >
                <option value="">{t('cap.extension.reason.choose')}</option>
                {REASON_CODES.map((code) => (
                  <option key={code} value={code}>
                    {reasonCodeLabel(t, code)}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Field id="cap-ext-justification" label={t('cap.extension.field.justification')} error={errorOf('justification')}>
            <textarea
              id="cap-ext-justification"
              rows={2}
              maxLength={MAX_JUSTIFICATION}
              value={form.justification}
              aria-invalid={errorOf('justification') !== undefined}
              onChange={(event) => change('justification', event.target.value)}
            />
          </Field>
          {line === undefined || year === undefined || shown.amountVnd !== undefined || form.amountVnd.trim() === '' || problems.amountVnd !== undefined ? null : (
            <p className="callout" data-testid="preview">
              {t('cap.extension.preview.text', { amount: formatVnd(form.amountVnd.trim(), locale), year, next: year + 1, fund: line.fundSource.label })}
            </p>
          )}
          <button type="submit" className="primary" disabled={request.isPending}>
            {t('cap.extension.request.action')}
          </button>
        </form>
      ) : (
        <p className="callout warning" role="status">
          {t('cap.extension.form.denied')}
        </p>
      )}

      {notice === undefined ? null : (
        <p className="callout" role="status">
          {notice === 'requested' ? t('cap.extension.done.requested') : notice === 'applied' ? t('cap.extension.done.applied') : t('cap.extension.done.rejected')}
        </p>
      )}
      {problem === undefined ? null : (
        <div className="callout warning" role="alert">
          <p>{problemMessage(t, problem, { undisbursed: formatVnd(problem.undisbursedVnd ?? '0', locale) })}</p>
        </div>
      )}

      <div className="card">
        <h2>{t('cap.extension.list.title')}</h2>
        <StateBoundary state={state} onRetry={() => void extensions.refetch()}>
          {rows.length === 0 ? (
            <p className="sub" role="status" data-extensions-empty>
              {t('cap.extension.list.empty')}
            </p>
          ) : (
            <div className="tablewrap cap-scroll">
              <table className="cap-table" aria-label={t('cap.extension.list.title')}>
                <thead>
                  <tr>
                    <th>{t('cap.extension.col.project')}</th>
                    <th>{t('cap.extension.col.years')}</th>
                    <th>{t('cap.extension.col.amount')}</th>
                    <th>{t('cap.extension.col.until')}</th>
                    <th>{t('cap.extension.col.reason')}</th>
                    <th>{t('cap.extension.col.status')}</th>
                    <th>{t('cap.extension.col.people')}</th>
                    {canDecide ? <th>{t('cap.extension.col.actions')}</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((entry) => (
                    <tr key={entry.id} data-extension-id={entry.id} data-status={entry.status} data-version={entry.version}>
                      <td>{projectNames.get(entry.projectId) ?? entry.projectId.slice(0, 8)}</td>
                      <td>{t('cap.extension.years.text', { from: entry.fromPlanYear, to: entry.fromPlanYear + 1 })}</td>
                      <td className="cap-number">{formatVnd(entry.amountVnd, locale)}</td>
                      <td>{date(entry.extendedTo)}</td>
                      <td>
                        {reasonCodeLabel(t, entry.reasonCode)}
                        {entry.justification === undefined ? null : <div className="sub">{entry.justification}</div>}
                      </td>
                      <td>
                        <span className={entry.status === 'APPLIED' ? 'cap-badge' : 'cap-badge warning'} data-status={entry.status}>
                          {statusLabel(t, entry.status)}
                        </span>
                      </td>
                      <td>
                        <div>{t('cap.extension.people.requested', { person: person(entry.requestedBy) })}</div>
                        {entry.decidedBy === undefined ? null : <div>{t('cap.extension.people.decided', { person: person(entry.decidedBy) })}</div>}
                        {entry.decisionReason === undefined ? null : <div className="sub">{entry.decisionReason}</div>}
                      </td>
                      {canDecide ? (
                        <td className="cap-actions">
                          {mayDecide(entry, tenant?.membershipId) ? (
                            <div className="row gap">
                              <button type="button" onClick={() => choose(entry, 'approve')}>
                                {t('cap.extension.approve.action')}
                              </button>
                              <button type="button" onClick={() => choose(entry, 'reject')}>
                                {t('cap.extension.reject.action')}
                              </button>
                            </div>
                          ) : entry.status === 'REQUESTED' ? (
                            <small className="sub" data-self-request>
                              {t('cap.extension.self.notice')}
                            </small>
                          ) : null}
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </StateBoundary>

        {deciding === undefined ? null : (
          <form className="cap-form" onSubmit={confirm} noValidate aria-label={t('cap.extension.decision.aria')} data-testid="decision">
            <h3>
              {deciding.decision === 'approve'
                ? t('cap.extension.decision.title.approve', { amount: formatVnd(deciding.entry.amountVnd, locale) })
                : t('cap.extension.decision.title.reject', { amount: formatVnd(deciding.entry.amountVnd, locale) })}
            </h3>
            {deciding.decision === 'approve' ? (
              <Field id="cap-ext-document" label={t('cap.extension.field.document')} error={decisionErrorOf('documentId')} hint={t('cap.extension.document.hint')}>
                <input
                  id="cap-ext-document"
                  value={decision.documentId}
                  aria-invalid={decisionErrorOf('documentId') !== undefined}
                  onChange={(event) => setDecision((current) => ({ ...current, documentId: event.target.value }))}
                />
              </Field>
            ) : null}
            <Field id="cap-ext-decision-reason" label={t('cap.extension.field.decisionReason')} error={decisionErrorOf('reason')}>
              <textarea
                id="cap-ext-decision-reason"
                rows={2}
                maxLength={MAX_DECISION_REASON}
                value={decision.reason}
                aria-invalid={decisionErrorOf('reason') !== undefined}
                onChange={(event) => setDecision((current) => ({ ...current, reason: event.target.value }))}
              />
            </Field>
            <div className="row gap">
              <button type="submit" className="primary" disabled={decide.isPending}>
                {deciding.decision === 'approve' ? t('cap.extension.decision.confirm.approve') : t('cap.extension.decision.confirm.reject')}
              </button>
              <button type="button" onClick={() => setDeciding(undefined)}>
                {t('cap.extension.decision.cancel.action')}
              </button>
            </div>
          </form>
        )}
      </div>
      <p className="prototype-note">{t('cap.extension.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
