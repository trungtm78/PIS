import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../i18n';
import { DataTable, ReadonlyStat, SectionCard, StatusPill } from '../../ui';
import type { DataTableColumn, Tone } from '../../ui';
import { Field } from './components';
import { useDecideReopen } from './hooks';
import { reopenFieldMessage, reopenProblemMessage, reopenScopeLabel, reopenStatusLabel } from './labels';
import { DEFAULT_WINDOW_HOURS, decisionOffer, describeProblem, effectiveStatus, isWindowOpen, validateDecision, vietnamMoment } from './model';
import type { DecisionForm, ReopenRequestView, ReopenStatus } from './model';

const NONE = '–';

/** The colour of a status of a request; it only supports the word. */
function toneOf(status: ReopenStatus): Tone {
  switch (status) {
    case 'APPROVED':
      return 'success';
    case 'REQUESTED':
      return 'warning';
    case 'REJECTED':
    case 'EXPIRED':
    case 'CLOSED':
      return 'neutral';
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
 * separation rule as its tooltip. While a window is open, every project it names carries "open until hh:mm". The decision is taken on a
 * panel under the table that names the request first (period, scope, status), then asks for the reason and the hours.
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
      <p className="dis-w2-empty" data-testid="empty-requests">
        {t('dis.reopen.queue.empty.text')}
      </p>
    );
  }

  const windowChip = (request: ReopenRequestView): JSX.Element | null => {
    const { reopen } = request;
    if (!isWindowOpen(reopen, now) || reopen.windowUntil === null) return null;
    return (
      <span data-testid="window-chip">
        <StatusPill tone="success">{t('dis.reopen.window.active.chip', { when: vietnamMoment(reopen.windowUntil) })}</StatusPill>
      </span>
    );
  };
  const columns: DataTableColumn<ReopenRequestView>[] = [
    {
      key: 'period',
      header: t('dis.reopen.queue.period.column'),
      pinned: true,
      render: ({ period }) => (
        <>
          <strong>{period.code}</strong>
          <span className="dis-code">
            {period.startDate} – {period.endDate}
          </span>
        </>
      ),
    },
    {
      key: 'scope',
      header: t('dis.reopen.queue.scope.column'),
      render: (request) => {
        const { reopen } = request;
        return (
          <>
            <span>{reopenScopeLabel(t, reopen.scopeKind)}</span>
            {reopen.scopeKind === 'PERIOD' ? (
              <ul className="dis-chip-list">
                <li>
                  <span>{t('dis.reopen.queue.allProjects.text')}</span>
                  {windowChip(request)}
                </li>
              </ul>
            ) : (
              <ul className="dis-chip-list">
                {(reopen.detail?.projects ?? []).map((project) => (
                  <li key={project.id} data-project-id={project.id}>
                    <span>{project.code}</span>
                    {windowChip(request)}
                  </li>
                ))}
              </ul>
            )}
          </>
        );
      },
    },
    { key: 'reason', header: t('dis.reopen.queue.reason.column'), render: ({ reopen }) => (reopen.detail === null ? NONE : <span className="dis-reason">{reopen.detail.reason}</span>) },
    {
      key: 'requester',
      header: t('dis.reopen.queue.requester.column'),
      render: ({ reopen }) => (reopen.detail === null ? NONE : reopen.detail.requestedBy === me ? t('dis.reopen.queue.requester.mine') : t('dis.reopen.queue.requester.other')),
    },
    {
      key: 'window',
      header: t('dis.reopen.queue.window.column'),
      render: ({ reopen }) => (
        <>
          {reopen.detail === null ? null : <span>{t('dis.reopen.queue.window.asked', { hours: reopen.detail.requestedWindowHours })}</span>}
          {reopen.windowUntil === null ? null : <span className="dis-code">{t('dis.reopen.queue.window.until', { when: vietnamMoment(reopen.windowUntil) })}</span>}
        </>
      ),
    },
    {
      key: 'status',
      header: t('dis.reopen.queue.status.column'),
      render: ({ reopen }) => {
        const status = effectiveStatus(reopen, now);
        return (
          <>
            <StatusPill tone={toneOf(status)}>{reopenStatusLabel(t, status)}</StatusPill>
            {reopen.detail?.decisionReason == null ? null : <span className="dis-code">{reopen.detail.decisionReason}</span>}
          </>
        );
      },
    },
    {
      key: 'actions',
      header: t('dis.reopen.queue.actions.column'),
      render: (request) => {
        const { reopen } = request;
        const offer = decisionOffer(request, { approve, me });
        if (offer.kind === 'none') return null;
        return (
          <span className="dis-w2-actions">
            <button
              type="button"
              className="ui-button ui-button--primary ui-button--small"
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
              className="ui-button ui-button--outline ui-button--small"
              data-decision="reject"
              disabled={offer.kind === 'own'}
              title={offer.kind === 'own' ? t('dis.reopen.decision.own.tooltip') : undefined}
              aria-describedby={offer.kind === 'own' ? `own-${reopen.id}` : undefined}
              onClick={() => start(request, 'reject')}
            >
              {t('dis.reopen.decision.reject.action')}
            </button>
            {offer.kind === 'own' ? (
              <small className="dis-w2-note" id={`own-${reopen.id}`} data-testid="own-request">
                {t('dis.reopen.decision.own.tooltip')}
              </small>
            ) : null}
          </span>
        );
      },
    },
  ];
  const deciding = acting === undefined ? undefined : requests.find((request) => request.reopen.id === acting.id);
  return (
    <>
      {refused === undefined ? null : (
        <p className="dis-w2-banner" role="alert" data-testid="decision-problem">
          {reopenProblemMessage(t, refused)}
        </p>
      )}
      <div data-testid="reopen-queue">
        <DataTable
          caption={t('dis.reopen.queue.aria')}
          columns={columns}
          rows={[...requests]}
          rowKey={(request) => request.reopen.id}
          rowAttrs={(request) => ({ 'data-reopen-id': request.reopen.id, 'data-period-code': request.period.code, 'data-status': effectiveStatus(request.reopen, now) })}
        />
      </div>
      {acting === undefined || deciding === undefined ? null : (
        <div data-testid="decision-row" className="dis-w2-decision">
          <SectionCard title={acting.decision === 'approve' ? t('dis.reopen.decision.approve.title', { code: deciding.period.code }) : t('dis.reopen.decision.reject.title', { code: deciding.period.code })}>
            <form className="dis-decision" onSubmit={(event) => send(event, deciding)} noValidate aria-label={acting.decision === 'approve' ? t('dis.reopen.decision.approve.title', { code: deciding.period.code }) : t('dis.reopen.decision.reject.title', { code: deciding.period.code })}>
              <div className="dis-w2-grid">
                <ReadonlyStat label={t('dis.reopen.queue.period.column')} value={deciding.period.code} />
                <ReadonlyStat label={t('dis.reopen.queue.scope.column')} value={reopenScopeLabel(t, deciding.reopen.scopeKind)} />
                <ReadonlyStat label={t('dis.reopen.queue.status.column')} value={reopenStatusLabel(t, effectiveStatus(deciding.reopen, now))} />
              </div>
              <Field
                id={`decision-reason-${deciding.reopen.id}`}
                label={t('dis.reopen.decision.reason.label')}
                error={problems.reason === undefined ? undefined : reopenFieldMessage(t, problems.reason, 'decisionReason')}
                hint={t('dis.reopen.decision.reason.help')}
              >
                <textarea
                  id={`decision-reason-${deciding.reopen.id}`}
                  rows={2}
                  value={form.reason}
                  aria-invalid={problems.reason !== undefined}
                  onChange={(event) => {
                    setForm({ ...form, reason: event.target.value });
                    setProblems({ ...problems, reason: undefined });
                  }}
                />
              </Field>
              {acting.decision === 'approve' ? (
                <Field
                  id={`decision-hours-${deciding.reopen.id}`}
                  label={t('dis.reopen.decision.hours.label')}
                  error={problems.windowHours === undefined ? undefined : reopenFieldMessage(t, problems.windowHours, 'windowHours')}
                  hint={t('dis.reopen.decision.hours.help')}
                >
                  <input
                    id={`decision-hours-${deciding.reopen.id}`}
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
                <button type="button" className="ui-button ui-button--outline" onClick={() => setActing(undefined)}>
                  {t('dis.reopen.decision.cancel.action')}
                </button>
                <button type="submit" className="ui-button ui-button--primary" disabled={decide.isPending}>
                  {acting.decision === 'approve' ? t('dis.reopen.decision.approve.confirm') : t('dis.reopen.decision.reject.confirm')}
                </button>
              </div>
            </form>
          </SectionCard>
        </div>
      )}
    </>
  );
}
