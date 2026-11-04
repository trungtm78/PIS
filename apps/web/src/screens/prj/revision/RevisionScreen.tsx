import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../../i18n';
import type { Translator } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { NavigationDialog } from '../../../shell/NavigationDialog';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { Field } from '../components';
import { useProjects } from '../hooks';
import '../prj.css';
import { useDecideRevision, useProposeRevision, useRevisions } from './hooks';
import {
  APPROVE_PERMISSION,
  DECISIONS,
  EMPTY_DECISION,
  EMPTY_PROPOSAL,
  KINDS,
  PROPOSE_PERMISSION,
  REVISABLE_STAGES,
  canDecide,
  changesOf,
  decisionBody,
  describeRevision,
  holds,
  pendingOf,
  proposalBody,
  validateDecision,
  validateProposal,
  vietnamToday,
} from './model';
import type { Change, DecisionField, DecisionForm, FormProblem, Kind, ProposalField, ProposalForm, RevisionProblem, RevisionView } from './model';
import { NONE, ProjectChooser, documentText, statusLabel, statusTone, useMoney, useProjectParam } from './shared';

type T = Translator['t'];
// U+00D7, the multiplication sign.
const CLOSE_GLYPH = '\u00d7';

function problemMessage(t: T, problem: RevisionProblem): string {
  switch (problem) {
    case 'pendingExists':
      return t('prj.revision.problem.pendingExists');
    case 'selfApproval':
      return t('prj.revision.problem.selfApproval');
    case 'versionConflict':
      return t('prj.revision.problem.versionConflict');
    case 'stageDenied':
      return t('prj.revision.problem.stageDenied');
    case 'scopeDenied':
      return t('prj.revision.problem.scopeDenied');
    case 'documentRequired':
      return t('prj.revision.problem.documentRequired');
    case 'validation':
      return t('prj.revision.problem.validation');
    case 'notFound':
      return t('prj.revision.problem.notFound');
    case 'general':
      return t('prj.revision.problem.general');
  }
}

function kindLabel(t: T, kind: Kind | 'INITIAL'): string {
  switch (kind) {
    case 'INITIAL':
      return t('prj.revision.kind.initial');
    case 'ADJUST_INVESTMENT':
      return t('prj.revision.kind.investment');
    case 'ADJUST_SCHEDULE':
      return t('prj.revision.kind.schedule');
    case 'ADJUST_SCOPE':
      return t('prj.revision.kind.scope');
    case 'ADJUST_INVESTOR':
      return t('prj.revision.kind.investor');
  }
}

function fieldLabel(t: T, field: string): string {
  switch (field) {
    case 'total_investment_vnd':
      return t('prj.revision.field.total.name');
    case 'start_year':
      return t('prj.revision.field.startYear.name');
    case 'end_year':
      return t('prj.revision.field.endYear.name');
    case 'investor_unit_id':
      return t('prj.revision.field.investor.name');
    case 'scope_summary':
      return t('prj.revision.field.scope.name');
    default:
      return field;
  }
}

function fieldMessage(t: T, problem: FormProblem | undefined): string | undefined {
  switch (problem) {
    case undefined:
      return undefined;
    case 'required':
      return t('prj.revision.field.required.error');
    case 'same':
      return t('prj.revision.field.same.error');
    case 'past':
      return t('prj.revision.field.future.error');
    case 'invalid':
      return t('prj.revision.field.invalid.error');
  }
}

/**
 * PRJ-06: the adjustment of a project (ST-PRJ-008, PRJ 3.1 F6). Each revision is shown as the old content next to the new, the document that grounds it and the day it takes effect. The investor proposes a change of the
 * investment total, the schedule, the scope or the investor unit; someone else approves it with the decision document and the day, or rejects it; the figures of the project follow the revision approved last.
 */
export default function RevisionScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  const { projectId } = useProjectParam();
  // The address decides the project: a move to another one starts the screen over, so no form or dialog of one project reaches another.
  return <RevisionContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}:${projectId ?? ''}`} route={route} />;
}

function RevisionContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode, tenant } = useSession();
  const { projectId, choose } = useProjectParam();
  const [deciding, setDeciding] = useState<RevisionView | undefined>(undefined);
  const projects = useProjects();
  const project = (projects.data ?? []).find((candidate) => candidate.id === projectId);
  const list = useRevisions(projectId);
  const money = useMoney();
  const items = list.data?.items ?? [];
  const pending = pendingOf(items);
  const state = useScreenState({ isLoading: list.isLoading, error: list.error, data: projectId === undefined || list.data === undefined ? undefined : items, isEmpty: () => false });
  const approve = holds(permissions, APPROVE_PERMISSION, mode);
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('prj.revision.page.title')}</h1>
          <p>{t('prj.revision.page.subtitle')}</p>
        </div>
      </div>
      <ProjectChooser id="revision-project" projectId={projectId} choose={choose} />
      {projectId === undefined ? (
        <p className="callout" role="status" data-testid="no-project">
          {t('prj.revision.noProject.notice')}
        </p>
      ) : (
        <StateBoundary state={state} onRetry={() => void list.refetch()}>
          {list.data === undefined ? null : (
            <>
              <p data-testid="current-total">
                <strong>{t('prj.revision.current.total')}</strong> {money(list.data.currentTotalVnd)}
              </p>
              {pending === undefined ? null : (
                <p className="callout" role="status" data-testid="pending-notice">
                  {t('prj.revision.pending.notice', { revision: pending.revision })}
                </p>
              )}
              {holds(permissions, PROPOSE_PERMISSION, mode) && project !== undefined ? (
                pending !== undefined ? null : REVISABLE_STAGES.includes(project.status) ? (
                  <ProposalPanel projectId={project.id} version={project.version} totalVnd={list.data.currentTotalVnd} />
                ) : (
                  <p className="callout warning" role="status" data-testid="stage-notice">
                    {t('prj.revision.stage.notice')}
                  </p>
                )
              ) : null}
              <div className="tablewrap">
                <table className="table" aria-label={t('prj.revision.list.aria')} data-testid="revisions">
                  <thead>
                    <tr>
                      <th scope="col">{t('prj.revision.col.revision')}</th>
                      <th scope="col">{t('prj.revision.col.before')}</th>
                      <th scope="col">{t('prj.revision.col.after')}</th>
                      <th scope="col">{t('prj.revision.col.basis')}</th>
                      <th scope="col">{t('prj.revision.col.effective')}</th>
                      <th scope="col">{t('prj.revision.col.status')}</th>
                      <th scope="col">
                        <span className="sr-only">{t('prj.revision.col.actions')}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item) => (
                      <tr key={item.id} data-revision={item.id} data-status={item.status}>
                        <td>
                          {t('prj.revision.row.number', { revision: item.revision })}
                          <span className="prj-code">{kindLabel(t, item.kind)}</span>
                        </td>
                        <td>
                          <Contents revision={item} side="before" />
                        </td>
                        <td>
                          <Contents revision={item} side="after" />
                        </td>
                        <td>
                          {item.document === null ? NONE : documentText(t, item.document)}
                          <span className="prj-code">{item.reason}</span>
                          {item.decisionReason === null ? null : <span className="prj-code">{t('prj.revision.decision.note', { note: item.decisionReason })}</span>}
                        </td>
                        <td>{item.effectiveFrom ?? NONE}</td>
                        <td>
                          <span className={`pill ${statusTone(item.status)}`} data-status={item.status}>
                            {statusLabel(t, item.status)}
                          </span>
                        </td>
                        <td>
                          {approve && canDecide(item, tenant?.membershipId) ? (
                            <button type="button" onClick={() => setDeciding(item)}>
                              {t('prj.revision.decide.action')}
                            </button>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </StateBoundary>
      )}
      {deciding === undefined ? null : <DecisionDialog revision={deciding} onClose={() => setDeciding(undefined)} />}
      <p className="prototype-note">{t('prj.revision.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

/** One side of a revision: the fields it changes, each with its name and content. */
function Contents({ revision, side }: { revision: RevisionView; side: 'before' | 'after' }) {
  const { t } = useTranslation();
  const money = useMoney();
  const changes: Change[] = changesOf(revision);
  if (changes.length === 0) return <>{NONE}</>;
  const show = (field: string, value: unknown): string => {
    if (value === null || value === undefined) return NONE;
    if (field === 'total_investment_vnd' && typeof value === 'string') return money(value);
    return String(value);
  };
  return (
    <ul className="plain" data-side={side}>
      {changes.map((change) => (
        <li key={change.field} data-field={change.field}>
          <strong>{fieldLabel(t, change.field)}</strong>: {show(change.field, side === 'before' ? change.before : change.after)}
        </li>
      ))}
    </ul>
  );
}

function ProposalPanel({ projectId, version, totalVnd }: { projectId: string; version: number; totalVnd: string }) {
  const { t } = useTranslation();
  const send = useProposeRevision();
  const [form, setForm] = useState<ProposalForm>(EMPTY_PROPOSAL);
  const [problems, setProblems] = useState<Partial<Record<ProposalField, FormProblem>>>({});
  const [saved, setSaved] = useState(false);
  const refusal = send.isError ? describeRevision(send.error) : undefined;
  const set = (patch: Partial<ProposalForm>): void => {
    setSaved(false);
    setForm((value) => ({ ...value, ...patch }));
  };
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const found = validateProposal(form, { totalVnd });
    setProblems(found);
    if (Object.keys(found).length > 0 || send.isPending) return;
    send.mutate(
      { projectId, version, body: proposalBody(form) },
      {
        onSuccess: () => {
          setForm(EMPTY_PROPOSAL);
          setSaved(true);
        },
      },
    );
  };
  const error = (field: ProposalField): string | undefined => fieldMessage(t, problems[field]);
  return (
    <form className="card" onSubmit={submit} noValidate aria-label={t('prj.revision.form.title')}>
      <h2>{t('prj.revision.form.title')}</h2>
      <p className="sub">{t('prj.revision.form.help')}</p>
      {refusal === undefined ? null : (
        <p className="callout warning" role="alert" data-testid="propose-refusal">
          {problemMessage(t, refusal)}
        </p>
      )}
      {saved ? (
        <p className="callout" role="status" data-testid="propose-saved">
          {t('prj.revision.form.saved')}
        </p>
      ) : null}
      <Field id="revision-kind" label={t('prj.revision.field.kind.label')} error={undefined}>
        <select id="revision-kind" value={form.kind} onChange={(event) => set({ kind: event.target.value as Kind })}>
          {KINDS.map((value) => (
            <option key={value} value={value}>
              {kindLabel(t, value)}
            </option>
          ))}
        </select>
      </Field>
      {form.kind === 'ADJUST_INVESTMENT' ? (
        <Field id="revision-total" label={t('prj.revision.field.total.label')} error={error('total')} hint={t('prj.revision.field.total.hint')}>
          <input id="revision-total" type="text" inputMode="numeric" value={form.total} onChange={(event) => set({ total: event.target.value })} />
        </Field>
      ) : null}
      {form.kind === 'ADJUST_SCHEDULE' ? (
        <>
          <Field id="revision-start" label={t('prj.revision.field.startYear.label')} error={error('startYear')} hint={t('prj.revision.field.years.hint')}>
            <input id="revision-start" type="text" inputMode="numeric" value={form.startYear} onChange={(event) => set({ startYear: event.target.value })} />
          </Field>
          <Field id="revision-end" label={t('prj.revision.field.endYear.label')} error={error('endYear')}>
            <input id="revision-end" type="text" inputMode="numeric" value={form.endYear} onChange={(event) => set({ endYear: event.target.value })} />
          </Field>
        </>
      ) : null}
      {form.kind === 'ADJUST_SCOPE' ? (
        <Field id="revision-scope" label={t('prj.revision.field.scope.label')} error={error('scope')} hint={t('prj.revision.field.scope.hint')}>
          <textarea id="revision-scope" rows={3} value={form.scope} onChange={(event) => set({ scope: event.target.value })} />
        </Field>
      ) : null}
      {form.kind === 'ADJUST_INVESTOR' ? (
        <Field id="revision-investor" label={t('prj.revision.field.investor.label')} error={error('investorUnit')} hint={t('prj.revision.field.investor.hint')}>
          <input id="revision-investor" type="text" value={form.investorUnit} onChange={(event) => set({ investorUnit: event.target.value })} />
        </Field>
      ) : null}
      <Field id="revision-reason" label={t('prj.revision.field.reason.label')} error={error('reason')} hint={t('prj.revision.field.reason.hint')}>
        <textarea id="revision-reason" rows={3} value={form.reason} onChange={(event) => set({ reason: event.target.value })} />
      </Field>
      <div className="formfooter">
        <button type="submit" className="primary" disabled={send.isPending}>
          {t('prj.revision.form.submit.action')}
        </button>
      </div>
    </form>
  );
}

function DecisionDialog({ revision, onClose }: { revision: RevisionView; onClose(): void }) {
  const { t } = useTranslation();
  const titleId = useId();
  const send = useDecideRevision();
  const [form, setForm] = useState<DecisionForm>(EMPTY_DECISION);
  const [problems, setProblems] = useState<Partial<Record<DecisionField, FormProblem>>>({});
  const refusal = send.isError ? describeRevision(send.error) : undefined;
  const set = (patch: Partial<DecisionForm>): void => {
    setProblems({});
    setForm((value) => ({ ...value, ...patch }));
  };
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const found = validateDecision(form, vietnamToday());
    setProblems(found);
    if (Object.keys(found).length > 0 || send.isPending) return;
    send.mutate({ id: revision.id, version: revision.version, body: decisionBody(form) }, { onSuccess: onClose });
  };
  return (
    <NavigationDialog className="catalog command-mode" onClose={onClose}>
      <section className="command-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="command-titlebar">
          <strong id={titleId}>{t('prj.revision.decide.title', { revision: revision.revision })}</strong>
          <button type="button" className="icon-button" aria-label={t('prj.revision.dialog.close.label')} onClick={onClose}>
            {CLOSE_GLYPH}
          </button>
        </div>
        <form className="dis-dialog-body" onSubmit={submit} noValidate>
          <p data-testid="decide-summary">{kindLabel(t, revision.kind)}: {revision.reason}</p>
          {refusal === undefined ? null : (
            <p className="callout warning" role="alert" data-testid="decide-refusal">
              {problemMessage(t, refusal)}
            </p>
          )}
          <fieldset>
            <legend>{t('prj.revision.decide.decision.label')}</legend>
            {DECISIONS.map((value) => (
              <label key={value}>
                <input type="radio" name="revision-decision" value={value} checked={form.decision === value} onChange={() => set({ decision: value })} /> {value === 'approve' ? t('prj.revision.decide.approve') : t('prj.revision.decide.reject')}
              </label>
            ))}
          </fieldset>
          <Field id="revision-decision-reason" label={t('prj.revision.decide.reason.label')} error={fieldMessage(t, problems.reason)} hint={t('prj.revision.decide.reason.hint')}>
            <textarea id="revision-decision-reason" rows={3} value={form.reason} onChange={(event) => set({ reason: event.target.value })} />
          </Field>
          <Field id="revision-decision-document" label={t('prj.revision.decide.document.label')} error={fieldMessage(t, problems.documentId)} hint={t('prj.revision.decide.document.hint')}>
            <input id="revision-decision-document" type="text" value={form.documentId} onChange={(event) => set({ documentId: event.target.value })} />
          </Field>
          {form.decision === 'approve' ? (
            <Field id="revision-decision-effective" label={t('prj.revision.decide.effective.label')} error={fieldMessage(t, problems.effectiveFrom)} hint={t('prj.revision.decide.effective.hint')}>
              <input id="revision-decision-effective" type="date" value={form.effectiveFrom} onChange={(event) => set({ effectiveFrom: event.target.value })} />
            </Field>
          ) : null}
          <div className="formfooter">
            <button type="button" onClick={onClose}>
              {t('prj.revision.dialog.cancel.action')}
            </button>
            <button type="submit" className="primary" disabled={send.isPending}>
              {t('prj.revision.decide.submit.action')}
            </button>
          </div>
        </form>
      </section>
    </NavigationDialog>
  );
}
