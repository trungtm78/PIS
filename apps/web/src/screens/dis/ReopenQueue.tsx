import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../i18n';
import { Field } from './components';
import { useDecideReopen } from './hooks';
import { reopenFieldMessage, reopenProblemMessage, reopenScopeLabel, reopenStatusLabel } from './labels';
import { DEFAULT_WINDOW_HOURS, decisionOffer, describeProblem, effectiveStatus, isWindowOpen, validateDecision, vietnamMoment } from './model';
import type { DecisionForm, ReopenRequestView, ReopenStatus } from './model';

const NONE = '–';

type Tone = 'green' | 'warn' | 'gray';

/** The colour of a status of a request; it only supports the word. */
function toneOf(status: ReopenStatus): Tone {
  switch (status) {
    case 'APPROVED':
      return 'green';
    case 'REQUESTED':
      return 'warn';
    case 'REJECTED':
    case 'EXPIRED':
    case 'CLOSED':
      return 'gray';
  }
}

export interface ReopenQueueProps {
  requests: readonly ReopenRequestView[];
  now: number;
  /** The caller holds period.reopen.approve and the screen is not frozen. */
  approve: boolean;
  /** The membership of the caller: the requests it made are shown with the decision disabled. */
  me: string | undefined;
}

interface Acting {
  id: string;
  decision: 'approve' | 'reject';
}

/**
 * The requests to reopen the periods, those that wait first (DIS-22): what each asks for, why, for how long, and the window that was
 * granted. An approver decides a request of somebody else; a request the approver made is shown with the decision disabled and the
 * separation rule as its tooltip. While a window is open, every project it names carries "open until hh:mm".
 */
export function ReopenQueue({ requests, now, approve, me }: ReopenQueueProps) {
  const { t } = useTranslation();
  const decide = useDecideReopen();
  const [acting, setActing] = useState<Acting | undefined>(undefined);
  const [form, setForm] = useState<DecisionForm>({ decision: 'approve', reason: '', windowHours: String(DEFAULT_WINDOW_HOURS) });
  const [problems, setProblems] = useState<Partial<Record<'reason' | 'windowHours', Parameters<typeof reopenFieldMessage>[1]>>>({});
  const refused = decide.isError ? describeProblem(decide.error) : undefined;

  const start = (request: ReopenRequestView, decision: 'approve' | 'reject'): void => {
    decide.reset();
    setProblems({});
    setForm({ decision, reason: '', windowHours: String(request.reopen.detail?.requestedWindowHours ?? DEFAULT_WINDOW_HOURS) });
    setActing({ id: request.reopen.id, decision });
  };
  const send = (event: FormEvent, request: ReopenRequestView): void => {
    event.preventDefault();
    const detail = request.reopen.detail;
    if (decide.isPending || acting === undefined || detail === null) return;
    const found = validateDecision(form);
    setProblems(found);
    if (Object.keys(found).length > 0) return;
    decide.mutate({ id: request.reopen.id, version: detail.version, form }, { onSuccess: () => setActing(undefined) });
  };

  if (requests.length === 0) {
    return (
      <p className="muted" data-testid="empty-requests">
        {t('dis.reopen.queue.empty.text')}
      </p>
    );
  }
  return (
    <>
      {refused === undefined ? null : (
        <p className="callout warning" role="alert" data-testid="decision-problem">
          {reopenProblemMessage(t, refused)}
        </p>
      )}
      <table className="table" aria-label={t('dis.reopen.queue.aria')} data-testid="reopen-queue">
        <thead>
          <tr>
            <th scope="col">{t('dis.reopen.queue.period.column')}</th>
            <th scope="col">{t('dis.reopen.queue.scope.column')}</th>
            <th scope="col">{t('dis.reopen.queue.reason.column')}</th>
            <th scope="col">{t('dis.reopen.queue.requester.column')}</th>
            <th scope="col">{t('dis.reopen.queue.window.column')}</th>
            <th scope="col">{t('dis.reopen.queue.status.column')}</th>
            <th scope="col">
              <span className="sr-only">{t('dis.reopen.queue.actions.column')}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {requests.map((request) => {
            const { reopen, period } = request;
            const status = effectiveStatus(reopen, now);
            const open = isWindowOpen(reopen, now);
            const offer = decisionOffer(request, { approve, me });
            const chip = reopen.windowUntil === null ? null : t('dis.reopen.window.active.chip', { when: vietnamMoment(reopen.windowUntil) });
            const decision = acting?.id === reopen.id ? acting : undefined;
            return (
              <FragmentRow key={reopen.id}>
                <tr data-reopen-id={reopen.id} data-period-code={period.code} data-status={status}>
                  <th scope="row">
                    {period.code}
                    <span className="dis-code">
                      {period.startDate} – {period.endDate}
                    </span>
                  </th>
                  <td>
                    <span>{reopenScopeLabel(t, reopen.scopeKind)}</span>
                    {reopen.scopeKind === 'PERIOD' ? (
                      <ul className="dis-chip-list">
                        <li>
                          <span>{t('dis.reopen.queue.allProjects.text')}</span>
                          {open && chip !== null ? (
                            <span className="pill green" data-testid="window-chip">
                              {chip}
                            </span>
                          ) : null}
                        </li>
                      </ul>
                    ) : (
                      <ul className="dis-chip-list">
                        {(reopen.detail?.projects ?? []).map((project) => (
                          <li key={project.id} data-project-id={project.id}>
                            <span>{project.code}</span>
                            {open && chip !== null ? (
                              <span className="pill green" data-testid="window-chip">
                                {chip}
                              </span>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                  <td>{reopen.detail === null ? NONE : <span className="dis-reason">{reopen.detail.reason}</span>}</td>
                  <td>{reopen.detail === null ? NONE : reopen.detail.requestedBy === me ? t('dis.reopen.queue.requester.mine') : t('dis.reopen.queue.requester.other')}</td>
                  <td>
                    {reopen.detail === null ? null : <span>{t('dis.reopen.queue.window.asked', { hours: reopen.detail.requestedWindowHours })}</span>}
                    {reopen.windowUntil === null ? null : (
                      <span className="dis-code">
                        {t('dis.reopen.queue.window.until', { when: vietnamMoment(reopen.windowUntil) })}
                      </span>
                    )}
                  </td>
                  <td>
                    <span className={`pill ${toneOf(status)}`} data-status={status}>
                      {reopenStatusLabel(t, status)}
                    </span>
                    {reopen.detail?.decisionReason == null ? null : <span className="dis-code">{reopen.detail.decisionReason}</span>}
                  </td>
                  <td className="row-actions">
                    {offer.kind === 'none' ? null : (
                      <>
                        <button
                          type="button"
                          className="primary"
                          data-decision="approve"
                          disabled={offer.kind === 'own'}
                          title={offer.kind === 'own' ? t('dis.reopen.decision.own.tooltip') : undefined}
                          aria-describedby={offer.kind === 'own' ? `own-${reopen.id}` : undefined}
                          onClick={() => start(request, 'approve')}
                        >
                          {t('dis.reopen.decision.approve.action')}
                        </button>
                        <button
                          type="button"
                          data-decision="reject"
                          disabled={offer.kind === 'own'}
                          title={offer.kind === 'own' ? t('dis.reopen.decision.own.tooltip') : undefined}
                          aria-describedby={offer.kind === 'own' ? `own-${reopen.id}` : undefined}
                          onClick={() => start(request, 'reject')}
                        >
                          {t('dis.reopen.decision.reject.action')}
                        </button>
                        {offer.kind === 'own' ? (
                          <small className="sub" id={`own-${reopen.id}`} data-testid="own-request">
                            {t('dis.reopen.decision.own.tooltip')}
                          </small>
                        ) : null}
                      </>
                    )}
                  </td>
                </tr>
                {decision === undefined ? null : (
                  <tr data-testid="decision-row">
                    <td colSpan={7}>
                      <form className="dis-decision" onSubmit={(event) => send(event, request)} noValidate aria-label={decision.decision === 'approve' ? t('dis.reopen.decision.approve.title', { code: period.code }) : t('dis.reopen.decision.reject.title', { code: period.code })}>
                        <Field
                          id={`decision-reason-${reopen.id}`}
                          label={t('dis.reopen.decision.reason.label')}
                          error={problems.reason === undefined ? undefined : reopenFieldMessage(t, problems.reason, 'decisionReason')}
                          hint={t('dis.reopen.decision.reason.help')}
                        >
                          <textarea
                            id={`decision-reason-${reopen.id}`}
                            rows={2}
                            value={form.reason}
                            aria-invalid={problems.reason !== undefined}
                            onChange={(event) => {
                              setForm({ ...form, reason: event.target.value });
                              setProblems({ ...problems, reason: undefined });
                            }}
                          />
                        </Field>
                        {decision.decision === 'approve' ? (
                          <Field
                            id={`decision-hours-${reopen.id}`}
                            label={t('dis.reopen.decision.hours.label')}
                            error={problems.windowHours === undefined ? undefined : reopenFieldMessage(t, problems.windowHours, 'windowHours')}
                            hint={t('dis.reopen.decision.hours.help')}
                          >
                            <input
                              id={`decision-hours-${reopen.id}`}
                              inputMode="numeric"
                              value={form.windowHours}
                              aria-invalid={problems.windowHours !== undefined}
                              onChange={(event) => {
                                setForm({ ...form, windowHours: event.target.value });
                                setProblems({ ...problems, windowHours: undefined });
                              }}
                            />
                          </Field>
                        ) : null}
                        <div className="formfooter">
                          <button type="button" onClick={() => setActing(undefined)}>
                            {t('dis.reopen.decision.cancel.action')}
                          </button>
                          <button type="submit" className={decision.decision === 'approve' ? 'primary' : 'danger'} disabled={decide.isPending}>
                            {decision.decision === 'approve' ? t('dis.reopen.decision.approve.confirm') : t('dis.reopen.decision.reject.confirm')}
                          </button>
                        </div>
                      </form>
                    </td>
                  </tr>
                )}
              </FragmentRow>
            );
          })}
        </tbody>
      </table>
    </>
  );
}

/** A request is a row and, while it is being decided, a second row with the form of the decision. */
function FragmentRow({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
