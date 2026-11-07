import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../../i18n';
import type { Translator } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { NavigationDialog } from '../../../shell/NavigationDialog';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { DataTable, FilterPanel, SectionCard, StatusPill } from '../../../ui';
import type { DataTableColumn, Tone } from '../../../ui';
import { useMemberOptions } from '../accountability-reads';
import { Field } from '../components';
import { useProjects, useUnits } from '../hooks';
import '../prj.css';
import { useExplanations, useRequestExplanation, useReviewExplanation, useSubmitExplanation } from './hooks';
import {
  EMPTY_REQUEST,
  EMPTY_REVIEW,
  READ_PERMISSION,
  MEMBER_LIST_PERMISSION,
  REQUEST_PERMISSION,
  RESPOND_PERMISSION,
  REVIEW_PERMISSION,
  STATUSES,
  canAnswer,
  canConclude,
  describeExplanation,
  holds,
  isPastDue,
  requestBody,
  reviewBody,
  validateAnswer,
  validateRequest,
  validateReview,
  vietnamToday,
} from './model';
import type { Decision, ExplanationProblem, ExplanationView, FormProblem, RequestField, RequestForm, ReviewField, ReviewForm, Status, Subject } from './model';

type T = Translator['t'];
const NONE = '—';
// U+00D7, the multiplication sign.
const CLOSE_GLYPH = '\u00d7';

function problemMessage(t: T, problem: ExplanationProblem): string {
  switch (problem) {
    case 'alreadyOpen':
      return t('prj.explanation.problem.alreadyOpen');
    case 'alreadySubmitted':
      return t('prj.explanation.problem.alreadySubmitted');
    case 'selfApproval':
      return t('prj.explanation.problem.selfApproval');
    case 'versionConflict':
      return t('prj.explanation.problem.versionConflict');
    case 'stageDenied':
      return t('prj.explanation.problem.stageDenied');
    case 'scopeDenied':
      return t('prj.explanation.problem.scopeDenied');
    case 'warningState':
      return t('prj.explanation.problem.warningState');
    case 'validation':
      return t('prj.explanation.problem.validation');
    case 'notFound':
      return t('prj.explanation.problem.notFound');
    case 'general':
      return t('prj.explanation.problem.general');
  }
}

function statusLabel(t: T, status: Status): string {
  switch (status) {
    case 'REQUESTED':
      return t('prj.explanation.status.requested');
    case 'RESPONDED':
      return t('prj.explanation.status.responded');
    case 'ACCEPTED':
      return t('prj.explanation.status.accepted');
    case 'RETURNED':
      return t('prj.explanation.status.returned');
    case 'OVERDUE':
      return t('prj.explanation.status.overdue');
    case 'CANCELLED':
      return t('prj.explanation.status.cancelled');
  }
}

const statusTone = (status: Status): Tone => (status === 'ACCEPTED' ? 'success' : status === 'OVERDUE' || status === 'RETURNED' ? 'warning' : status === 'CANCELLED' ? 'neutral' : 'info');
const fieldMessage = (t: T, problem: FormProblem | undefined): string | undefined =>
  problem === undefined ? undefined : problem === 'required' ? t('prj.explanation.field.required.error') : problem === 'past' ? t('prj.explanation.field.past.error') : t('prj.explanation.field.invalid.error');

/** The day of an instant in Vietnam, as `YYYY-MM-DD`. */
const dayOf = (instant: string): string => (Number.isNaN(new Date(instant).getTime()) ? NONE : vietnamToday(new Date(instant)));

/**
 * PRJ-19: the requests for an explanation and their answers (ST-PRJ-006, PRJ 3.1 F10, BR-PRJ-08). A leader asks the person who answers for a project or a unit; the person asked answers, in time or late (a late
 * answer is taken and told late against the date it was first asked for), and someone else concludes: accepts it, or returns it with a note and a new date. What a person may do is shown to them, and the
 * server judges it again.
 */
export default function ExplanationScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // A new key for each tenant and member: what was opened for the one (a record, a dialog, a command) is not kept for the other.
  return <ExplanationContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function ExplanationContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode, tenant } = useSession();
  const [status, setStatus] = useState('');
  const [asking, setAsking] = useState(false);
  const [viewing, setViewing] = useState<string | undefined>(undefined);
  const [answering, setAnswering] = useState<ExplanationView | undefined>(undefined);
  const [concluding, setConcluding] = useState<ExplanationView | undefined>(undefined);
  const list = useExplanations(status);
  const items = (list.data?.pages ?? []).flatMap((page) => page.items);
  const state = useScreenState({
    isLoading: list.isLoading,
    error: list.error,
    data: list.data === undefined ? undefined : items,
    isEmpty: () => items.length === 0 && status === '',
  });
  const me = tenant?.membershipId;
  const request = holds(permissions, REQUEST_PERMISSION, mode);
  const respond = holds(permissions, RESPOND_PERMISSION, mode);
  const review = holds(permissions, REVIEW_PERMISSION, mode);
  const now = new Date();
  const shown = items.find((item) => item.id === viewing);
  const columns: DataTableColumn<ExplanationView>[] = [
    {
      key: 'subject',
      header: t('prj.explanation.col.subject'),
      pinned: true,
      render: (item) => subjectText(t, item),
    },
    {
      key: 'basis',
      header: t('prj.explanation.col.basis'),
      render: (item) => (item.warningId === null ? (item.triggerCode === 'MANUAL' ? t('prj.explanation.basis.manual') : item.triggerCode) : t('prj.explanation.basis.warning', { rule: item.triggerCode })),
    },
    {
      key: 'question',
      header: t('prj.explanation.col.question'),
      render: (item) => item.question,
    },
    {
      key: 'due',
      header: t('prj.explanation.col.due'),
      render: (item) => {
        const past = isPastDue(item, now);
        return (
          <span data-overdue={past ? 'true' : 'false'}>
            {t('prj.explanation.due.text', { date: dayOf(item.dueAt) })}
            {past ? <StatusPill tone="warning">{t('prj.explanation.due.overdue')}</StatusPill> : null}
            {item.dueAt !== item.originalDueAt ? (
              <span className="prj-code">
                {t('prj.explanation.due.original', {
                  date: dayOf(item.originalDueAt),
                })}
              </span>
            ) : null}
          </span>
        );
      },
    },
    {
      key: 'status',
      header: t('prj.explanation.col.status'),
      render: (item) => (
        <span className="prj-pills" data-status={item.status}>
          <StatusPill tone={statusTone(item.status)}>{statusLabel(t, item.status)}</StatusPill>
          {item.isLate ? <StatusPill tone="warning">{t('prj.explanation.late.label')}</StatusPill> : null}
        </span>
      ),
    },
    {
      key: 'actions',
      header: t('prj.explanation.col.actions'),
      render: (item) => (
        <span className="prj-row-actions">
          <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => setViewing(viewing === item.id ? undefined : item.id)}>
            {t('prj.explanation.view.action')}
          </button>
          {respond && canAnswer(item, me) ? (
            <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => setAnswering(item)}>
              {t('prj.explanation.answer.action')}
            </button>
          ) : null}
          {review && canConclude(item, me) ? (
            <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => setConcluding(item)}>
              {t('prj.explanation.review.action')}
            </button>
          ) : null}
        </span>
      ),
    },
  ];
  const readable = holds(permissions, READ_PERMISSION, undefined);
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('prj.explanation.page.title')}</h1>
          <p>{t('prj.explanation.page.subtitle')}</p>
        </div>
        {request ? (
          <button type="button" className="ui-button ui-button--primary" onClick={() => setAsking(true)}>
            {t('prj.explanation.request.open.action')}
          </button>
        ) : null}
      </div>
      <FilterPanel applied={status === '' ? 0 : 1}>
        <div className="prj-filters">
          <label htmlFor="explanation-status">{t('prj.explanation.filter.status.label')}</label>
          <select id="explanation-status" value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="">{t('prj.explanation.filter.status.all')}</option>
            {STATUSES.map((value) => (
              <option key={value} value={value}>
                {statusLabel(t, value)}
              </option>
            ))}
          </select>
        </div>
      </FilterPanel>
      <StateBoundary state={state} onRetry={() => void list.refetch()}>
        {readable || items.length > 0 ? (
          <div data-testid="explanations">
            <DataTable caption={t('prj.explanation.list.aria')} columns={columns} rows={items} rowKey={(item) => item.id} emptyKind={status === '' ? 'none' : 'filtered'} onClearFilters={() => setStatus('')} />
          </div>
        ) : null}
        {list.hasNextPage ? (
          <p>
            <button type="button" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
              {t('prj.explanation.more.action')}
            </button>
          </p>
        ) : null}
        {shown === undefined ? null : <Detail item={shown} onClose={() => setViewing(undefined)} />}
      </StateBoundary>
      {asking ? <RequestDialog onClose={() => setAsking(false)} /> : null}
      {answering === undefined ? null : <AnswerDialog item={answering} onClose={() => setAnswering(undefined)} />}
      {concluding === undefined ? null : <ReviewDialog item={concluding} onClose={() => setConcluding(undefined)} />}
      <p className="prototype-note">
        {t('prj.explanation.footer.reference', {
          id: route.id,
          req: route.req ?? '',
        })}
      </p>
    </section>
  );
}

function subjectText(t: T, item: ExplanationView): string {
  return item.subject === 'PROJECT' ? `${item.subjectCode ?? ''} ${item.subjectName}`.trim() : `${t('prj.explanation.subject.unit')} ${item.subjectName}`.trim();
}

/** The question beside the answer, and the conclusion under them. */
function Detail({ item, onClose }: { item: ExplanationView; onClose(): void }) {
  const { t } = useTranslation();
  return (
    <div data-testid="explanation-detail">
      <SectionCard
        title={t('prj.explanation.detail.title', {
          subject: subjectText(t, item),
        })}
        actions={
          <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={onClose}>
            {t('prj.explanation.detail.close.action')}
          </button>
        }
      >
        <div className="prj-compare">
          <div>
            <h3>{t('prj.explanation.detail.question.title')}</h3>
            <p data-testid="detail-question">{item.question}</p>
          </div>
          <div>
            <h3>{t('prj.explanation.detail.response.title')}</h3>
            {item.responseText === null ? (
              <p className="muted" data-testid="detail-response">
                {t('prj.explanation.detail.response.none')}
              </p>
            ) : (
              <>
                <p data-testid="detail-response">{item.responseText}</p>
                <p className="sub">
                  {t('prj.explanation.detail.responded', {
                    at: item.respondedAt === null ? NONE : dayOf(item.respondedAt),
                  })}
                  {item.isLate ? ` · ${t('prj.explanation.late.label')}` : ''}
                </p>
              </>
            )}
          </div>
        </div>
        <h3>{t('prj.explanation.detail.conclusion.title')}</h3>
        {item.reviewNote === null ? (
          <p className="muted" data-testid="detail-conclusion">
            {t('prj.explanation.detail.conclusion.none')}
          </p>
        ) : (
          <p data-testid="detail-conclusion">
            {statusLabel(t, item.status)}: {item.reviewNote}
          </p>
        )}
      </SectionCard>
    </div>
  );
}

function Dialog({ title, onClose, children }: { title: string; onClose(): void; children: React.ReactNode }) {
  const { t } = useTranslation();
  const titleId = useId();
  return (
    <NavigationDialog className="catalog command-mode" onClose={onClose}>
      <section className="command-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="command-titlebar">
          <strong id={titleId}>{title}</strong>
          <button type="button" className="icon-button" aria-label={t('prj.explanation.dialog.close.label')} onClick={onClose}>
            {CLOSE_GLYPH}
          </button>
        </div>
        {children}
      </section>
    </NavigationDialog>
  );
}

function Refusal({ problem, testId }: { problem: ExplanationProblem | undefined; testId: string }) {
  const { t } = useTranslation();
  return problem === undefined ? null : (
    <p className="callout warning" role="alert" data-testid={testId}>
      {problemMessage(t, problem)}
    </p>
  );
}

function RequestDialog({ onClose }: { onClose(): void }) {
  const { t } = useTranslation();
  const { permissions } = useSession();
  const send = useRequestExplanation();
  const projects = useProjects();
  const units = useUnits(true);
  const mayList = holds(permissions, MEMBER_LIST_PERMISSION, undefined);
  const members = useMemberOptions(holds(permissions, REQUEST_PERMISSION, undefined) && mayList);
  const [form, setForm] = useState<RequestForm>(EMPTY_REQUEST);
  const [problems, setProblems] = useState<Partial<Record<RequestField, FormProblem>>>({});
  const refusal = send.isError ? describeExplanation(send.error) : undefined;
  const set = (patch: Partial<RequestForm>): void => setForm((current) => ({ ...current, ...patch }));
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const found = validateRequest(form, vietnamToday());
    setProblems(found);
    if (Object.keys(found).length > 0 || send.isPending) return;
    send.mutate(requestBody(form), { onSuccess: onClose });
  };
  const error = (field: RequestField): string | undefined => fieldMessage(t, problems[field]);
  return (
    <Dialog title={t('prj.explanation.request.title')} onClose={onClose}>
      <form className="dis-dialog-body" onSubmit={submit} noValidate>
        <Refusal problem={refusal} testId="request-refusal" />
        <Field id="request-subject" label={t('prj.explanation.request.subject.label')} error={undefined}>
          <select id="request-subject" value={form.subject} onChange={(event) => set({ subject: event.target.value as Subject })}>
            <option value="PROJECT">{t('prj.explanation.subject.project')}</option>
            <option value="UNIT">{t('prj.explanation.subject.unit')}</option>
          </select>
        </Field>
        {form.subject === 'PROJECT' ? (
          <Field id="request-project" label={t('prj.explanation.request.project.label')} error={error('projectId')}>
            <select id="request-project" value={form.projectId} onChange={(event) => set({ projectId: event.target.value })}>
              <option value="">{NONE}</option>
              {(projects.data ?? []).map((project) => (
                <option key={project.id} value={project.id}>
                  {project.code} {project.name}
                </option>
              ))}
            </select>
          </Field>
        ) : (
          <Field id="request-unit" label={t('prj.explanation.request.unit.label')} error={error('unitId')}>
            <select id="request-unit" value={form.unitId} onChange={(event) => set({ unitId: event.target.value })}>
              <option value="">{NONE}</option>
              {(units.data ?? []).map((unit) => (
                <option key={unit.id} value={unit.id}>
                  {unit.code} {unit.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field id="request-trigger" label={t('prj.explanation.request.trigger.label')} error={error('triggerCode')} hint={t('prj.explanation.request.trigger.hint')}>
          <input id="request-trigger" type="text" value={form.triggerCode} onChange={(event) => set({ triggerCode: event.target.value })} />
        </Field>
        <Field id="request-question" label={t('prj.explanation.request.question.label')} error={error('question')} hint={t('prj.explanation.request.question.hint')}>
          <textarea id="request-question" rows={4} value={form.question} onChange={(event) => set({ question: event.target.value })} />
        </Field>
        {members.isError ? (
          <p className="callout warning" role="alert" data-testid="members-failed">
            {t('prj.explanation.request.assignee.failed')}
          </p>
        ) : null}
        {mayList && !members.isError ? (
          <Field id="request-assignee" label={t('prj.explanation.request.assignee.label')} error={error('requestedFrom')}>
            <select id="request-assignee" value={form.requestedFrom} onChange={(event) => set({ requestedFrom: event.target.value })}>
              <option value="">{NONE}</option>
              {(members.data ?? []).map((member) => (
                <option key={member.id} value={member.id}>
                  {member.label}
                </option>
              ))}
            </select>
          </Field>
        ) : (
          <Field id="request-assignee" label={t('prj.explanation.request.assignee.label')} error={error('requestedFrom')} hint={t('prj.explanation.request.assignee.idHint')}>
            <input id="request-assignee" type="text" value={form.requestedFrom} onChange={(event) => set({ requestedFrom: event.target.value.trim() })} />
          </Field>
        )}
        <Field id="request-due" label={t('prj.explanation.request.due.label')} error={error('dueDate')}>
          <input id="request-due" type="date" value={form.dueDate} onChange={(event) => set({ dueDate: event.target.value })} />
        </Field>
        <div className="formfooter">
          <button type="button" onClick={onClose}>
            {t('prj.explanation.dialog.cancel.action')}
          </button>
          <button type="submit" className="primary" disabled={send.isPending}>
            {t('prj.explanation.request.submit.action')}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function AnswerDialog({ item, onClose }: { item: ExplanationView; onClose(): void }) {
  const { t } = useTranslation();
  const send = useSubmitExplanation();
  const [text, setText] = useState(item.responseText ?? '');
  const [problem, setProblem] = useState<FormProblem | undefined>(undefined);
  const refusal = send.isError ? describeExplanation(send.error) : undefined;
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const found = validateAnswer(text);
    setProblem(found);
    if (found !== undefined || send.isPending) return;
    send.mutate({ id: item.id, version: item.version, text }, { onSuccess: onClose });
  };
  return (
    <Dialog
      title={t('prj.explanation.answer.title', {
        subject: subjectText(t, item),
      })}
      onClose={onClose}
    >
      <form className="dis-dialog-body" onSubmit={submit} noValidate>
        <p data-testid="answer-question">{item.question}</p>
        <Refusal problem={refusal} testId="answer-refusal" />
        <Field id="answer-text" label={t('prj.explanation.answer.text.label')} error={fieldMessage(t, problem)} hint={t('prj.explanation.answer.text.hint')}>
          <textarea id="answer-text" rows={6} value={text} onChange={(event) => (setText(event.target.value), setProblem(undefined))} />
        </Field>
        <div className="formfooter">
          <button type="button" onClick={onClose}>
            {t('prj.explanation.dialog.cancel.action')}
          </button>
          <button type="submit" className="primary" disabled={send.isPending}>
            {t('prj.explanation.answer.submit.action')}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function ReviewDialog({ item, onClose }: { item: ExplanationView; onClose(): void }) {
  const { t } = useTranslation();
  const send = useReviewExplanation();
  const [form, setForm] = useState<ReviewForm>(EMPTY_REVIEW);
  const [problems, setProblems] = useState<Partial<Record<ReviewField, FormProblem>>>({});
  const refusal = send.isError ? describeExplanation(send.error) : undefined;
  const set = (patch: Partial<ReviewForm>): void => setForm((current) => ({ ...current, ...patch }));
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const found = validateReview(form, vietnamToday());
    setProblems(found);
    if (Object.keys(found).length > 0 || send.isPending) return;
    send.mutate({ id: item.id, version: item.version, body: reviewBody(form) }, { onSuccess: onClose });
  };
  return (
    <Dialog
      title={t('prj.explanation.review.title', {
        subject: subjectText(t, item),
      })}
      onClose={onClose}
    >
      <form className="dis-dialog-body" onSubmit={submit} noValidate>
        <p data-testid="review-question">{item.question}</p>
        <p data-testid="review-response">{item.responseText}</p>
        <Refusal problem={refusal} testId="review-refusal" />
        <fieldset>
          <legend>{t('prj.explanation.review.decision.label')}</legend>
          {(['ACCEPTED', 'RETURNED'] as const satisfies readonly Decision[]).map((value) => (
            <label key={value}>
              <input type="radio" name="review-decision" value={value} checked={form.decision === value} onChange={() => set({ decision: value })} />{' '}
              {value === 'ACCEPTED' ? t('prj.explanation.review.decision.accepted') : t('prj.explanation.review.decision.returned')}
            </label>
          ))}
        </fieldset>
        <Field id="review-note" label={t('prj.explanation.review.note.label')} error={fieldMessage(t, problems.note)} hint={t('prj.explanation.review.note.hint')}>
          <textarea id="review-note" rows={3} value={form.note} onChange={(event) => set({ note: event.target.value })} />
        </Field>
        {form.decision === 'RETURNED' ? (
          <Field id="review-due" label={t('prj.explanation.review.newDue.label')} error={fieldMessage(t, problems.newDueDate)} hint={t('prj.explanation.review.newDue.hint')}>
            <input id="review-due" type="date" value={form.newDueDate} onChange={(event) => set({ newDueDate: event.target.value })} />
          </Field>
        ) : null}
        <div className="formfooter">
          <button type="button" onClick={onClose}>
            {t('prj.explanation.dialog.cancel.action')}
          </button>
          <button type="submit" className="primary" disabled={send.isPending}>
            {t('prj.explanation.review.submit.action')}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
