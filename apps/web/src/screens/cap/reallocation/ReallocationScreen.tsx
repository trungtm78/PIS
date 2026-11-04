import { useId, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { useTranslation } from '../../../i18n';
import type { Translator } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { NavigationDialog } from '../../../shell/NavigationDialog';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { useFrozenSnapshots } from '../../dis/rates/hooks';
import { Field } from '../components';
import { usePlanLines, usePlans, useProjects } from '../plan-hooks';
import '../cap.css';
import { useApplyProposal, useDecideProposal, useDraftProposal, useProposals, useSubmitProposal } from './hooks';
import {
  APPLY_PERMISSION,
  APPROVE_PERMISSION,
  EMPTY_DRAFT,
  EMPTY_LINE,
  PROPOSE_PERMISSION,
  STATUSES,
  finalAmounts,
  balanceOf,
  canApply,
  canDecide,
  canSubmit,
  describeReallocation,
  draftBody,
  hasProblems,
  holds,
  validateDecision,
  validateDocument,
  validateDraft,
} from './model';
import type { Decision, DraftForm, DraftLineForm, DraftProblems, FormProblem, ProposalView, ReallocationProblem, Status } from './model';

type T = Translator['t'];
const NONE = '—';
// U+00D7, the multiplication sign.
const CLOSE_GLYPH = '\u00d7';

function problemMessage(t: T, problem: ReallocationProblem): string {
  switch (problem) {
    case 'unbalanced':
      return t('cap.reallocation.problem.unbalanced');
    case 'belowCommitted':
      return t('cap.reallocation.problem.belowCommitted');
    case 'snapshotNotFrozen':
      return t('cap.reallocation.problem.snapshotNotFrozen');
    case 'planChanged':
      return t('cap.reallocation.problem.planChanged');
    case 'pendingRevision':
      return t('cap.reallocation.problem.pendingRevision');
    case 'selfApproval':
      return t('cap.reallocation.problem.selfApproval');
    case 'versionConflict':
      return t('cap.reallocation.problem.versionConflict');
    case 'stageDenied':
      return t('cap.reallocation.problem.stageDenied');
    case 'documentRequired':
      return t('cap.reallocation.problem.documentRequired');
    case 'duplicate':
      return t('cap.reallocation.problem.duplicate');
    case 'scopeDenied':
      return t('cap.reallocation.problem.scopeDenied');
    case 'validation':
      return t('cap.reallocation.problem.validation');
    case 'notFound':
      return t('cap.reallocation.problem.notFound');
    case 'general':
      return t('cap.reallocation.problem.general');
  }
}

function statusLabel(t: T, status: Status): string {
  switch (status) {
    case 'DRAFT':
      return t('cap.reallocation.status.draft');
    case 'SUBMITTED':
      return t('cap.reallocation.status.submitted');
    case 'APPROVED':
      return t('cap.reallocation.status.approved');
    case 'APPLIED':
      return t('cap.reallocation.status.applied');
    case 'REJECTED':
      return t('cap.reallocation.status.rejected');
    case 'WITHDRAWN':
      return t('cap.reallocation.status.withdrawn');
  }
}

const statusTone = (status: Status): 'green' | 'warn' | 'gray' | 'blue' => (status === 'APPLIED' ? 'green' : status === 'REJECTED' || status === 'WITHDRAWN' ? 'gray' : status === 'APPROVED' ? 'blue' : 'warn');

function fieldMessage(t: T, problem: FormProblem | undefined): string | undefined {
  switch (problem) {
    case undefined:
      return undefined;
    case 'required':
      return t('cap.reallocation.field.required.error');
    case 'same':
      return t('cap.reallocation.field.same.error');
    case 'duplicate':
      return t('cap.reallocation.field.duplicate.error');
    case 'invalid':
      return t('cap.reallocation.field.invalid.error');
  }
}

/** Whole dong with the thousands told apart by the locale. */
const dong = (value: string): string => (/^-?[0-9]+$/.test(value) ? BigInt(value).toLocaleString('vi-VN') : value);

/**
 * CAP-19: the reallocation of capital from slow to fast projects (ST-CAP-010, CAP 3.1 F5). A planner draws a proposal on a frozen snapshot of the disbursement: lines that take whole amounts from a line of the plan in
 * force and give them to another project of the same appropriation, so that the total never changes. It is submitted, decided by someone who is neither its author nor its submitter, and applied with a decision
 * document as a new published revision of the plan. The detail puts the donor on the left and the recipient on the right, each before and after, with the balance under them.
 */
export default function ReallocationScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <ReallocationContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function ReallocationContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode, tenant } = useSession();
  const [status, setStatus] = useState('');
  const [viewing, setViewing] = useState<string | undefined>(undefined);
  const [deciding, setDeciding] = useState<ProposalView | undefined>(undefined);
  const [applying, setApplying] = useState<ProposalView | undefined>(undefined);
  const list = useProposals(status);
  const submit = useSubmitProposal();
  const items = (list.data?.pages ?? []).flatMap((page) => page.items);
  const state = useScreenState({ isLoading: list.isLoading, error: list.error, data: list.data === undefined ? undefined : items, isEmpty: () => items.length === 0 && status === '' && !holds(permissions, PROPOSE_PERMISSION, mode) });
  const me = tenant?.membershipId;
  const propose = holds(permissions, PROPOSE_PERMISSION, mode);
  const approve = holds(permissions, APPROVE_PERMISSION, mode);
  const apply = holds(permissions, APPLY_PERMISSION, mode);
  const shown = items.find((item) => item.id === viewing);
  const refusal = submit.isError ? describeReallocation(submit.error) : undefined;
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('cap.reallocation.page.title')}</h1>
          <p>{t('cap.reallocation.page.subtitle')}</p>
        </div>
      </div>
      {propose ? <DraftPanel /> : null}
      {refusal === undefined ? null : (
        <p className="callout warning" role="alert" data-testid="submit-refusal">
          {problemMessage(t, refusal)}
        </p>
      )}
      <div className="cap-filters">
        <label htmlFor="reallocation-status">{t('cap.reallocation.filter.status.label')}</label>
        <select id="reallocation-status" value={status} onChange={(event) => setStatus(event.target.value)}>
          <option value="">{t('cap.reallocation.filter.status.all')}</option>
          {STATUSES.map((value) => (
            <option key={value} value={value}>
              {statusLabel(t, value)}
            </option>
          ))}
        </select>
      </div>
      <StateBoundary state={state} onRetry={() => void list.refetch()}>
        <div className="tablewrap">
          <table className="table" aria-label={t('cap.reallocation.list.aria')} data-testid="proposals">
            <thead>
              <tr>
                <th scope="col">{t('cap.reallocation.col.code')}</th>
                <th scope="col">{t('cap.reallocation.col.year')}</th>
                <th scope="col">{t('cap.reallocation.col.lines')}</th>
                <th scope="col">{t('cap.reallocation.col.total')}</th>
                <th scope="col">{t('cap.reallocation.col.status')}</th>
                <th scope="col">
                  <span className="sr-only">{t('cap.reallocation.col.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id} data-proposal={item.id} data-status={item.status}>
                  <td>
                    {item.code}
                    <span className="cap-code">{item.scopeUnitName}</span>
                  </td>
                  <td>{item.planYear}</td>
                  <td>{item.lines.length}</td>
                  <td>{t('cap.reallocation.money', { amount: dong(item.totalVnd) })}</td>
                  <td>
                    <span className={`pill ${statusTone(item.status)}`} data-status={item.status}>
                      {statusLabel(t, item.status)}
                    </span>
                    {item.decisionReason !== null && item.status !== 'SUBMITTED' ? <span className="cap-code">{t('cap.reallocation.decision.note', { note: item.decisionReason })}</span> : null}
                  </td>
                  <td>
                    <button type="button" onClick={() => setViewing(viewing === item.id ? undefined : item.id)}>
                      {t('cap.reallocation.view.action')}
                    </button>{' '}
                    {propose && canSubmit(item) ? (
                      <button type="button" disabled={submit.isPending} onClick={() => submit.mutate({ id: item.id, version: item.version })}>
                        {t('cap.reallocation.submit.action')}
                      </button>
                    ) : null}{' '}
                    {approve && canDecide(item, me) ? (
                      <button type="button" onClick={() => setDeciding(item)}>
                        {t('cap.reallocation.decide.action')}
                      </button>
                    ) : null}{' '}
                    {apply && canApply(item, me) ? (
                      <button type="button" onClick={() => setApplying(item)}>
                        {t('cap.reallocation.apply.action')}
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
              {t('cap.reallocation.more.action')}
            </button>
          </p>
        ) : null}
        {shown === undefined ? null : <Compare proposal={shown} onClose={() => setViewing(undefined)} />}
      </StateBoundary>
      {deciding === undefined ? null : <DecisionDialog item={deciding} onClose={() => setDeciding(undefined)} />}
      {applying === undefined ? null : <ApplyDialog item={applying} onClose={() => setApplying(undefined)} />}
      <p className="prototype-note">{t('cap.reallocation.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

/** The donor on the left and the recipient on the right, each line with what the project holds before and after, and the balance under them. */
function Compare({ proposal, onClose }: { proposal: ProposalView; onClose(): void }) {
  const { t } = useTranslation();
  const balance = balanceOf(proposal.lines);
  const final = finalAmounts(proposal.lines);
  return (
    <section className="card" aria-labelledby="reallocation-compare-title" data-testid="reallocation-compare">
      <div className="heading">
        <h2 id="reallocation-compare-title">{t('cap.reallocation.compare.title', { code: proposal.code })}</h2>
        <button type="button" onClick={onClose}>
          {t('cap.reallocation.compare.close.action')}
        </button>
      </div>
      <p data-testid="compare-reason">{proposal.reason}</p>
      <div className="cap-compare">
        <div>
          <h3>{t('cap.reallocation.compare.left.title')}</h3>
          <ul>
            {proposal.lines.map((line) => (
              <li key={line.id} data-testid="compare-left">
                {t('cap.reallocation.compare.side', { project: `${line.fromProject.code} ${line.fromProject.name}`.trim(), before: dong(line.fromAllocatedVnd), after: dong(final.fromAfter(line)) })}
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h3>{t('cap.reallocation.compare.right.title')}</h3>
          <ul>
            {proposal.lines.map((line) => (
              <li key={line.id} data-testid="compare-right">
                {t('cap.reallocation.compare.side', { project: `${line.toProject.code} ${line.toProject.name}`.trim(), before: dong(line.toAllocatedVnd), after: dong(final.toAfter(line)) })}
                {line.note === '' ? null : <span className="cap-code">{line.note}</span>}
              </li>
            ))}
          </ul>
        </div>
      </div>
      <p className="cap-balance" data-testid="compare-balance">
        {t('cap.reallocation.compare.balance', { reduced: dong(balance.reducedVnd), increased: dong(balance.increasedVnd) })}
      </p>
    </section>
  );
}

function DraftPanel(): ReactNode {
  const { t } = useTranslation();
  const send = useDraftProposal();
  const plans = usePlans();
  const frozen = useFrozenSnapshots();
  const projects = useProjects();
  const [form, setForm] = useState<DraftForm>(EMPTY_DRAFT);
  const [problems, setProblems] = useState<DraftProblems>({ lines: [] });
  const [saved, setSaved] = useState(false);
  const published = (plans.data ?? []).filter((plan) => plan.status === 'PUBLISHED' && plan.planYear !== null);
  const plan = published.find((candidate) => candidate.id === form.planId);
  const lines = usePlanLines(form.planId === '' ? undefined : form.planId);
  const donors = lines.data?.lines ?? [];
  const refusal = send.isError ? describeReallocation(send.error) : undefined;
  const set = (patch: Partial<DraftForm>): void => {
    setSaved(false);
    setForm((value) => ({ ...value, ...patch }));
  };
  const setLine = (index: number, patch: Partial<DraftLineForm>): void => set({ lines: form.lines.map((line, at) => (at === index ? { ...line, ...patch } : line)) });
  const projectOfLine = (lineId: string): string | undefined => donors.find((line) => line.id === lineId)?.project.id;
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const found = validateDraft(form, projectOfLine);
    setProblems(found);
    if (hasProblems(found) || plan === undefined || send.isPending) return;
    send.mutate(draftBody(form, { id: plan.id, planYear: plan.planYear as number, scopeUnitId: plan.scopeUnit.id }), {
      onSuccess: () => {
        setForm(EMPTY_DRAFT);
        setSaved(true);
      },
    });
  };
  return (
    <form className="card" onSubmit={submit} noValidate aria-label={t('cap.reallocation.form.title')}>
      <h2>{t('cap.reallocation.form.title')}</h2>
      <p className="sub">{t('cap.reallocation.form.help')}</p>
      {refusal === undefined ? null : (
        <p className="callout warning" role="alert" data-testid="draft-refusal">
          {problemMessage(t, refusal)}
        </p>
      )}
      {saved ? (
        <p className="callout" role="status" data-testid="draft-saved">
          {t('cap.reallocation.form.saved')}
        </p>
      ) : null}
      <Field id="reallocation-code" label={t('cap.reallocation.field.code.label')} error={fieldMessage(t, problems.code)}>
        <input id="reallocation-code" type="text" value={form.code} onChange={(event) => set({ code: event.target.value })} />
      </Field>
      <Field id="reallocation-plan" label={t('cap.reallocation.field.plan.label')} error={fieldMessage(t, problems.planId)}>
        <select id="reallocation-plan" value={form.planId} onChange={(event) => set({ planId: event.target.value, lines: [{ ...EMPTY_LINE }] })}>
          <option value="">{NONE}</option>
          {published.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {t('cap.reallocation.field.plan.option', { code: candidate.planCode, revision: candidate.revision, year: candidate.planYear ?? '' })}
            </option>
          ))}
        </select>
      </Field>
      <Field id="reallocation-snapshot" label={t('cap.reallocation.field.snapshot.label')} error={fieldMessage(t, problems.snapshotId)} hint={t('cap.reallocation.field.snapshot.hint')}>
        <select id="reallocation-snapshot" value={form.snapshotId} onChange={(event) => set({ snapshotId: event.target.value })}>
          <option value="">{NONE}</option>
          {(frozen.data ?? []).map((snapshot) => (
            <option key={snapshot.id} value={snapshot.id}>
              {t('cap.reallocation.field.snapshot.option', { cutoff: snapshot.cutoffDate })}
            </option>
          ))}
        </select>
      </Field>
      <Field id="reallocation-reason" label={t('cap.reallocation.field.reason.label')} error={fieldMessage(t, problems.reason)} hint={t('cap.reallocation.field.reason.hint')}>
        <textarea id="reallocation-reason" rows={3} value={form.reason} onChange={(event) => set({ reason: event.target.value })} />
      </Field>
      <fieldset>
        <legend>{t('cap.reallocation.lines.title')}</legend>
        {form.lines.map((line, index) => {
          const own = problems.lines[index] ?? {};
          return (
            <div key={index} className="cap-line" data-testid="draft-line">
              <Field id={`reallocation-from-${index}`} label={t('cap.reallocation.field.from.label')} error={fieldMessage(t, own.fromLineId)}>
                <select id={`reallocation-from-${index}`} value={line.fromLineId} onChange={(event) => setLine(index, { fromLineId: event.target.value })}>
                  <option value="">{NONE}</option>
                  {donors.map((donor) => (
                    <option key={donor.id} value={donor.id}>
                      {t('cap.reallocation.field.from.option', { project: donor.project.code, source: donor.fundSource.label, amount: dong(donor.amountVnd) })}
                    </option>
                  ))}
                </select>
              </Field>
              <Field id={`reallocation-to-${index}`} label={t('cap.reallocation.field.to.label')} error={fieldMessage(t, own.toProjectId)}>
                <select id={`reallocation-to-${index}`} value={line.toProjectId} onChange={(event) => setLine(index, { toProjectId: event.target.value })}>
                  <option value="">{NONE}</option>
                  {(projects.data ?? []).map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.code} {project.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field id={`reallocation-amount-${index}`} label={t('cap.reallocation.field.amount.label')} error={fieldMessage(t, own.amount)} hint={t('cap.reallocation.field.amount.hint')}>
                <input id={`reallocation-amount-${index}`} type="text" inputMode="numeric" value={line.amount} onChange={(event) => setLine(index, { amount: event.target.value })} />
              </Field>
              <Field id={`reallocation-note-${index}`} label={t('cap.reallocation.field.note.label')} error={undefined}>
                <input id={`reallocation-note-${index}`} type="text" value={line.note} onChange={(event) => setLine(index, { note: event.target.value })} />
              </Field>
              {form.lines.length > 1 ? (
                <button type="button" onClick={() => set({ lines: form.lines.filter((_, at) => at !== index) })}>
                  {t('cap.reallocation.lines.remove.action')}
                </button>
              ) : null}
            </div>
          );
        })}
        <button type="button" onClick={() => set({ lines: [...form.lines, { ...EMPTY_LINE }] })}>
          {t('cap.reallocation.lines.add.action')}
        </button>
      </fieldset>
      <div className="formfooter">
        <button type="submit" className="primary" disabled={send.isPending}>
          {t('cap.reallocation.form.submit.action')}
        </button>
      </div>
    </form>
  );
}

function Dialog({ title, onClose, children }: { title: string; onClose(): void; children: ReactNode }) {
  const { t } = useTranslation();
  const titleId = useId();
  return (
    <NavigationDialog className="catalog command-mode" onClose={onClose}>
      <section className="command-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="command-titlebar">
          <strong id={titleId}>{title}</strong>
          <button type="button" className="icon-button" aria-label={t('cap.reallocation.dialog.close.label')} onClick={onClose}>
            {CLOSE_GLYPH}
          </button>
        </div>
        {children}
      </section>
    </NavigationDialog>
  );
}

function DecisionDialog({ item, onClose }: { item: ProposalView; onClose(): void }) {
  const { t } = useTranslation();
  const send = useDecideProposal();
  const [decision, setDecision] = useState<Decision>('approve');
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<FormProblem | undefined>(undefined);
  const refusal = send.isError ? describeReallocation(send.error) : undefined;
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const found = validateDecision(reason);
    setProblem(found);
    if (found !== undefined || send.isPending) return;
    send.mutate({ id: item.id, version: item.version, decision, reason }, { onSuccess: onClose });
  };
  return (
    <Dialog title={t('cap.reallocation.decide.title', { code: item.code })} onClose={onClose}>
      <form className="dis-dialog-body" onSubmit={submit} noValidate>
        <p data-testid="decide-summary">{t('cap.reallocation.decide.summary', { total: dong(item.totalVnd), lines: item.lines.length })}</p>
        {refusal === undefined ? null : (
          <p className="callout warning" role="alert" data-testid="decide-refusal">
            {problemMessage(t, refusal)}
          </p>
        )}
        <fieldset>
          <legend>{t('cap.reallocation.decide.decision.label')}</legend>
          {(['approve', 'reject', 'return'] as const).map((value) => (
            <label key={value}>
              <input type="radio" name="reallocation-decision" value={value} checked={decision === value} onChange={() => setDecision(value)} />{' '}
              {value === 'approve' ? t('cap.reallocation.decide.approve') : value === 'reject' ? t('cap.reallocation.decide.reject') : t('cap.reallocation.decide.return')}
            </label>
          ))}
        </fieldset>
        <Field id="reallocation-decision-reason" label={t('cap.reallocation.decide.reason.label')} error={fieldMessage(t, problem)} hint={t('cap.reallocation.decide.reason.hint')}>
          <textarea id="reallocation-decision-reason" rows={3} value={reason} onChange={(event) => (setReason(event.target.value), setProblem(undefined))} />
        </Field>
        <div className="formfooter">
          <button type="button" onClick={onClose}>
            {t('cap.reallocation.dialog.cancel.action')}
          </button>
          <button type="submit" className="primary" disabled={send.isPending}>
            {t('cap.reallocation.decide.submit.action')}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function ApplyDialog({ item, onClose }: { item: ProposalView; onClose(): void }) {
  const { t } = useTranslation();
  const send = useApplyProposal();
  const [document, setDocument] = useState('');
  const [problem, setProblem] = useState<FormProblem | undefined>(undefined);
  const refusal = send.isError ? describeReallocation(send.error) : undefined;
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const found = validateDocument(document);
    setProblem(found);
    if (found !== undefined || send.isPending) return;
    send.mutate({ id: item.id, version: item.version, documentId: document }, { onSuccess: onClose });
  };
  return (
    <Dialog title={t('cap.reallocation.apply.title', { code: item.code })} onClose={onClose}>
      <form className="dis-dialog-body" onSubmit={submit} noValidate>
        <p data-testid="apply-summary">{t('cap.reallocation.apply.summary', { total: dong(item.totalVnd), lines: item.lines.length })}</p>
        {refusal === undefined ? null : (
          <p className="callout warning" role="alert" data-testid="apply-refusal">
            {problemMessage(t, refusal)}
          </p>
        )}
        <Field id="reallocation-document" label={t('cap.reallocation.apply.document.label')} error={fieldMessage(t, problem)} hint={t('cap.reallocation.apply.document.hint')}>
          <input id="reallocation-document" type="text" value={document} onChange={(event) => (setDocument(event.target.value), setProblem(undefined))} />
        </Field>
        <div className="formfooter">
          <button type="button" onClick={onClose}>
            {t('cap.reallocation.dialog.cancel.action')}
          </button>
          <button type="submit" className="primary" disabled={send.isPending}>
            {t('cap.reallocation.apply.submit.action')}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
