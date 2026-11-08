import { ApiError } from '@machvon/api-client';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { Translator } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { ConfirmDialog, ContextBar, SectionCard, StatusPill } from '../../ui';
import type { Tone } from '../../ui';
import { dayText } from './common';
import { annotationReasonLabel, metricLabel } from './MultiRankingScreen';
import { useAnnotations, useComplaints, useRankingCommands } from './ranking-hooks';
import type { DecideInput, ResolveInput } from './ranking-hooks';
import { ANNOTATION_STATUSES, COMPLAINT_STATUSES, DECIDE_PERMISSION, MULTI_PATH, RESOLVE_PERMISSION } from './ranking-model';
import type { Annotation, AnnotationStatus, Complaint, ComplaintStatus } from './ranking-model';

type T = Translator['t'];
const ANNOTATION_TONE: Record<AnnotationStatus, Tone> = { PROPOSED: 'warning', APPROVED: 'success', REJECTED: 'danger', WITHDRAWN: 'neutral' };
const COMPLAINT_TONE: Record<ComplaintStatus, Tone> = { FILED: 'warning', UNDER_REVIEW: 'warning', UPHELD: 'success', REJECTED: 'danger', CORRECTED: 'success' };

function annotationStatus(t: T, status: AnnotationStatus): string {
  switch (status) {
    case 'PROPOSED':
      return t('ana.notes.annotation.status.proposed');
    case 'APPROVED':
      return t('ana.notes.annotation.status.approved');
    case 'REJECTED':
      return t('ana.notes.annotation.status.rejected');
    case 'WITHDRAWN':
      return t('ana.notes.annotation.status.withdrawn');
  }
}

function complaintStatus(t: T, status: ComplaintStatus): string {
  switch (status) {
    case 'FILED':
      return t('ana.notes.complaint.status.filed');
    case 'UNDER_REVIEW':
      return t('ana.notes.complaint.status.underReview');
    case 'UPHELD':
      return t('ana.notes.complaint.status.upheld');
    case 'REJECTED':
      return t('ana.notes.complaint.status.rejected');
    case 'CORRECTED':
      return t('ana.notes.complaint.status.corrected');
  }
}

function problemText(t: T, error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) return error.code === 'SELF_APPROVAL_DENIED' ? t('ana.notes.problem.self') : t('ana.notes.problem.denied');
    if (error.status === 409) return t('ana.notes.problem.state');
    if (error.status === 422) return t('ana.notes.problem.invalid');
    if (error.status === 404) return t('ana.notes.problem.gone');
  }
  return t('ana.notes.problem.failed');
}

type Pending = { kind: 'annotation'; row: Annotation; decision: DecideInput['decision'] } | { kind: 'complaint'; row: Complaint; action: ResolveInput['action'] };

/**
 * BI-26: the notes and the complaints of the ranking (G3-8). A note "this unit is held back by something outside its control" waits for a person other than the one who proposed it; a complaint about a figure is answered
 * (kept, rejected or corrected) in words by a person other than the one who filed it, and the figure stays marked as disputed on the ranking until then. Every decision needs words; the screen names who did what.
 */
export default function RankingNotesScreen({ route }: ScreenProps) {
  const tenant = useSession().tenant;
  return <NotesContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function NotesContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode, tenant } = useSession();
  const holds = (permission: string): boolean => mode !== 'READ_ONLY' && (permissions === undefined || permissions.includes(permission));
  const [annotationFilter, setAnnotationFilter] = useState('');
  const [complaintFilter, setComplaintFilter] = useState('');
  const annotations = useAnnotations(annotationFilter);
  const complaints = useComplaints(complaintFilter);
  const commands = useRankingCommands();
  const [pending, setPending] = useState<Pending | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const loading = annotations.isLoading || complaints.isLoading;
  const failed = annotations.data === undefined && annotations.error !== null ? annotations.error : complaints.data === undefined && complaints.error !== null ? complaints.error : undefined;
  const state = useScreenState({ isLoading: loading, error: failed ?? undefined, data: annotations.data ?? complaints.data, isEmpty: () => (annotations.data?.length ?? 0) === 0 && (complaints.data?.length ?? 0) === 0 && annotationFilter === '' && complaintFilter === '' });
  const me = tenant?.membershipId ?? '';
  const busy = commands.decide.isPending || commands.resolve.isPending;
  const error = pending?.kind === 'annotation' ? commands.decide.error : commands.resolve.error;
  const failedCommand = pending?.kind === 'annotation' ? commands.decide.isError : commands.resolve.isError;
  const close = (): void => {
    if (busy) return;
    setPending(undefined);
    commands.decide.reset();
    commands.resolve.reset();
  };
  const confirm = (reason?: string): void => {
    if (pending === undefined || busy) return;
    const text = (reason ?? '').trim();
    const done = (): void => {
      setPending(undefined);
      setNotice(t('ana.notes.done'));
    };
    if (pending.kind === 'annotation') commands.decide.mutate({ id: pending.row.id, decision: pending.decision, note: text }, { onSuccess: done });
    else commands.resolve.mutate({ id: pending.row.id, action: pending.action, resolution: text }, { onSuccess: done });
  };
  const contextItems = [
    { label: t('ana.notes.context.annotations'), value: String(annotations.data?.length ?? 0) },
    { label: t('ana.notes.context.complaints'), value: String(complaints.data?.length ?? 0) },
  ];
  const dialogTitle =
    pending === undefined
      ? ''
      : pending.kind === 'annotation'
        ? pending.decision === 'APPROVE'
          ? t('ana.notes.dialog.approve')
          : pending.decision === 'REJECT'
            ? t('ana.notes.dialog.reject')
            : t('ana.notes.dialog.withdraw')
        : pending.action === 'START_REVIEW'
          ? t('ana.notes.dialog.startReview')
          : pending.action === 'UPHOLD'
            ? t('ana.notes.dialog.uphold')
            : pending.action === 'REJECT'
              ? t('ana.notes.dialog.rejectComplaint')
              : t('ana.notes.dialog.correct');
  const optionalWords = pending?.kind === 'complaint' && pending.action === 'START_REVIEW';
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('ana.notes.page.title')}</h1>
          <p>{t('ana.notes.page.subtitle')}</p>
        </div>
      </div>
      <ContextBar items={contextItems} unit={t('ana.notes.context.unit')} />
      {notice === undefined ? null : (
        <p role="status" className="ana-na" data-testid="notes-notice">
          {notice}
        </p>
      )}
      <StateBoundary state={state} onRetry={() => void Promise.all([annotations.refetch(), complaints.refetch()])}>
        <div className="ana-stack">
          <SectionCard title={t('ana.notes.annotation.title')}>
            <div className="ana-controls">
              <label>
                {t('ana.notes.filter.status')}
                <select value={annotationFilter} onChange={(event) => setAnnotationFilter(event.target.value)} data-testid="annotation-filter">
                  <option value="">{t('ana.notes.filter.all')}</option>
                  {ANNOTATION_STATUSES.map((status) => (
                    <option key={status} value={status}>
                      {annotationStatus(t, status)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {(annotations.data ?? []).length === 0 ? (
              <p role="status" data-testid="annotations-none">
                {t('ana.notes.annotation.none')}
              </p>
            ) : (
              <div className="tablewrap">
                <table className="ana-table" aria-label={t('ana.notes.annotation.aria')} data-testid="annotation-table">
                  <caption className="sr-only">{t('ana.notes.annotation.caption')}</caption>
                  <thead>
                    <tr>
                      <th scope="col">{t('ana.notes.col.unit')}</th>
                      <th scope="col">{t('ana.notes.col.reason')}</th>
                      <th scope="col">{t('ana.notes.col.metrics')}</th>
                      <th scope="col">{t('ana.notes.col.period')}</th>
                      <th scope="col">{t('ana.notes.col.status')}</th>
                      <th scope="col">{t('ana.notes.col.people')}</th>
                      <th scope="col">
                        <span className="sr-only">{t('ana.notes.col.actions')}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {(annotations.data ?? []).map((row) => (
                      <tr key={row.id} data-testid="annotation-row" data-id={row.id}>
                        <th scope="row">{row.unit.code === null ? row.unit.name : `${row.unit.code} ${row.unit.name ?? ''}`.trim()}</th>
                        <td>
                          {annotationReasonLabel(t, row.reasonCode)}
                          <span className="ana-caveat"> {row.evidence}</span>
                        </td>
                        <td>{row.metricCodes.map((code) => metricLabel(t, code)).join(', ')}</td>
                        <td>{t('ana.notes.period', { from: dayText(row.validFrom), to: dayText(row.validTo) })}</td>
                        <td>
                          <StatusPill tone={ANNOTATION_TONE[row.status]}>{annotationStatus(t, row.status)}</StatusPill>
                          {row.decisionNote === null ? null : <span className="ana-caveat"> {row.decisionNote}</span>}
                        </td>
                        <td>
                          {t('ana.notes.proposedBy', { name: row.proposedBy.name === '' ? row.proposedBy.id : row.proposedBy.name })}
                          {row.decidedBy === null ? null : <span className="ana-caveat"> {t('ana.notes.decidedBy', { name: row.decidedBy.name === '' ? row.decidedBy.id : row.decidedBy.name })}</span>}
                        </td>
                        <td>
                          {holds(DECIDE_PERMISSION) && row.status === 'PROPOSED' && row.proposedBy.id !== me ? (
                            <>
                              <button type="button" className="ui-button ui-button--small" onClick={() => setPending({ kind: 'annotation', row, decision: 'APPROVE' })} data-testid={`annotation-approve-${row.id}`}>
                                {t('ana.notes.action.approve')}
                              </button>{' '}
                              <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => setPending({ kind: 'annotation', row, decision: 'REJECT' })} data-testid={`annotation-reject-${row.id}`}>
                                {t('ana.notes.action.reject')}
                              </button>
                            </>
                          ) : null}
                          {holds(DECIDE_PERMISSION) && (row.status === 'APPROVED' || (row.status === 'PROPOSED' && row.proposedBy.id === me)) ? (
                            <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => setPending({ kind: 'annotation', row, decision: 'WITHDRAW' })} data-testid={`annotation-withdraw-${row.id}`}>
                              {t('ana.notes.action.withdraw')}
                            </button>
                          ) : null}
                          {row.status === 'PROPOSED' && row.proposedBy.id === me ? <span className="ana-caveat"> {t('ana.notes.maker')}</span> : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </SectionCard>
          <SectionCard title={t('ana.notes.complaint.title')}>
            <div className="ana-controls">
              <label>
                {t('ana.notes.filter.status')}
                <select value={complaintFilter} onChange={(event) => setComplaintFilter(event.target.value)} data-testid="complaint-filter">
                  <option value="">{t('ana.notes.filter.all')}</option>
                  {COMPLAINT_STATUSES.map((status) => (
                    <option key={status} value={status}>
                      {complaintStatus(t, status)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {(complaints.data ?? []).length === 0 ? (
              <p role="status" data-testid="complaints-none">
                {t('ana.notes.complaint.none')}
              </p>
            ) : (
              <div className="tablewrap">
                <table className="ana-table" aria-label={t('ana.notes.complaint.aria')} data-testid="complaint-table">
                  <caption className="sr-only">{t('ana.notes.complaint.caption')}</caption>
                  <thead>
                    <tr>
                      <th scope="col">{t('ana.notes.col.unit')}</th>
                      <th scope="col">{t('ana.notes.col.figure')}</th>
                      <th scope="col">{t('ana.notes.col.claim')}</th>
                      <th scope="col">{t('ana.notes.col.status')}</th>
                      <th scope="col">{t('ana.notes.col.due')}</th>
                      <th scope="col">
                        <span className="sr-only">{t('ana.notes.col.actions')}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {(complaints.data ?? []).map((row) => (
                      <tr key={row.id} data-testid="complaint-row" data-id={row.id}>
                        <th scope="row">{row.unit.code === null ? row.unit.name : `${row.unit.code} ${row.unit.name ?? ''}`.trim()}</th>
                        <td>
                          {metricLabel(t, row.metricCode)} <span className="ana-caveat">{dayText(row.asOfDate)}</span>
                        </td>
                        <td>
                          {row.claim}
                          {row.claimedValue === null ? null : <span className="ana-caveat"> {t('ana.notes.claimed', { value: row.claimedValue })}</span>}
                        </td>
                        <td>
                          <StatusPill tone={COMPLAINT_TONE[row.status]}>{complaintStatus(t, row.status)}</StatusPill>
                          {row.resolution === null ? null : <span className="ana-caveat"> {row.resolution}</span>}
                        </td>
                        <td>
                          {dayText(row.dueOn)}
                          {row.overdue ? (
                            <>
                              {' '}
                              <StatusPill tone="danger">{t('ana.notes.overdue')}</StatusPill>
                            </>
                          ) : null}
                        </td>
                        <td>
                          {holds(RESOLVE_PERMISSION) && row.filedBy.id !== me && (row.status === 'FILED' || row.status === 'UNDER_REVIEW') ? (
                            <>
                              {row.status === 'FILED' ? (
                                <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => setPending({ kind: 'complaint', row, action: 'START_REVIEW' })} data-testid={`complaint-review-${row.id}`}>
                                  {t('ana.notes.action.startReview')}
                                </button>
                              ) : null}{' '}
                              <button type="button" className="ui-button ui-button--small" onClick={() => setPending({ kind: 'complaint', row, action: 'UPHOLD' })} data-testid={`complaint-uphold-${row.id}`}>
                                {t('ana.notes.action.uphold')}
                              </button>{' '}
                              <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => setPending({ kind: 'complaint', row, action: 'REJECT' })} data-testid={`complaint-reject-${row.id}`}>
                                {t('ana.notes.action.rejectComplaint')}
                              </button>{' '}
                              <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => setPending({ kind: 'complaint', row, action: 'CORRECT' })} data-testid={`complaint-correct-${row.id}`}>
                                {t('ana.notes.action.correct')}
                              </button>
                            </>
                          ) : null}
                          {row.filedBy.id === me && (row.status === 'FILED' || row.status === 'UNDER_REVIEW') ? <span className="ana-caveat">{t('ana.notes.filer')}</span> : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </SectionCard>
          <p className="ana-links">
            <Link to={MULTI_PATH}>{t('ana.notes.link.ranking')}</Link>
          </p>
        </div>
      </StateBoundary>
      <ConfirmDialog
        open={pending !== undefined}
        title={dialogTitle}
        context={pending === undefined ? [] : [{ label: t('ana.notes.col.unit'), value: pending.row.unit.code ?? pending.row.unit.name ?? '' }]}
        confirmLabel={t('ana.notes.dialog.confirm')}
        cancelLabel={t('ana.notes.dialog.cancel')}
        reason={{ label: t('ana.notes.dialog.words'), required: !optionalWords, minLength: optionalWords ? 0 : 5 }}
        pending={busy}
        {...(failedCommand ? { error: problemText(t, error) } : {})}
        onConfirm={confirm}
        onCancel={close}
      />
    </section>
  );
}
