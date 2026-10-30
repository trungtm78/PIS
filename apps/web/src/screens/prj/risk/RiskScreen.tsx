import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { Translator } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { NavigationDialog } from '../../../shell/NavigationDialog';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { Field } from '../components';
import { useMasterOptions, useProjects } from '../hooks';
import '../prj.css';
import { useCloseRisk, useRegisterRisk, useRisks, useUpdateRisk } from './hooks';
import {
  CATEGORY_TYPES,
  EMPTY_CLOSURE,
  EMPTY_FORM,
  ENDING_STATUSES,
  MANAGE_PERMISSION,
  SCALE,
  STATUSES,
  cellOf,
  closureBody,
  describeRisk,
  entryBody,
  formOfRisk,
  holds,
  isLive,
  movesFrom,
  previewScore,
  validateClosure,
  validateForm,
} from './model';
import type { Cell, ClosureForm, EndingStatus, FormProblem, Level, RiskField, RiskForm, RiskProblem, RiskView, Status } from './model';

type T = Translator['t'];
const NONE = '—';
const CLOSE_GLYPH = '×';

function problemMessage(t: T, problem: RiskProblem): string {
  switch (problem) {
    case 'codeDuplicate':
      return t('prj.risk.problem.codeDuplicate');
    case 'stateInvalid':
      return t('prj.risk.problem.stateInvalid');
    case 'versionConflict':
      return t('prj.risk.problem.versionConflict');
    case 'scopeDenied':
      return t('prj.risk.problem.scopeDenied');
    case 'validation':
      return t('prj.risk.problem.validation');
    case 'notFound':
      return t('prj.risk.problem.notFound');
    case 'general':
      return t('prj.risk.problem.general');
  }
}

function statusLabel(t: T, status: Status): string {
  switch (status) {
    case 'OPEN':
      return t('prj.risk.status.open');
    case 'MITIGATING':
      return t('prj.risk.status.mitigating');
    case 'ESCALATED':
      return t('prj.risk.status.escalated');
    case 'ACCEPTED':
      return t('prj.risk.status.accepted');
    case 'CLOSED':
      return t('prj.risk.status.closed');
  }
}

function levelLabel(t: T, level: Level): string {
  switch (level) {
    case 'LOW':
      return t('prj.risk.level.low');
    case 'MEDIUM':
      return t('prj.risk.level.medium');
    case 'CRITICAL':
      return t('prj.risk.level.critical');
  }
}

const levelTone = (level: Level): 'green' | 'warn' | 'red' => (level === 'CRITICAL' ? 'red' : level === 'MEDIUM' ? 'warn' : 'green');
const statusTone = (status: Status): 'blue' | 'warn' | 'red' | 'gray' => (status === 'ESCALATED' ? 'red' : status === 'MITIGATING' ? 'warn' : status === 'OPEN' ? 'blue' : 'gray');

function fieldMessage(t: T, problem: FormProblem | undefined): string | undefined {
  if (problem === undefined) return undefined;
  return problem === 'required' ? t('prj.risk.field.required.error') : t('prj.risk.field.invalid.error');
}

/**
 * PRJ-16: the risk register of a project (ST-PRJ-010, PRJ 3.1 F8, BR-PRJ-07). The register lists the risks of the project, the highest score first, with a 5 by 5 matrix of the live ones in which every cell says its score and its
 * band in words, so that no state rests on colour alone. A risk is written with a likelihood and an impact, the server scores it, and it ends closed or accepted with a reason.
 */
export default function RiskScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  const [params] = useSearchParams();
  // The address decides the project: a move to another one (a choice, or the browser going back) starts the screen over, so no form or filter of one project reaches another.
  return <RiskContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}:${params.get('id') ?? ''}`} route={route} />;
}

function RiskContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const [params, setParams] = useSearchParams();
  const projectId = params.get('id') ?? undefined;
  const [status, setStatus] = useState('');
  const [editing, setEditing] = useState<RiskView | undefined>(undefined);
  const [closing, setClosing] = useState<RiskView | undefined>(undefined);
  const projects = useProjects();
  const list = useRisks(projectId, status);
  const items = (list.data?.pages ?? []).flatMap((page) => page.items);
  const head = list.data?.pages[0];
  const manage = holds(permissions, MANAGE_PERMISSION, mode);
  const state = useScreenState({ isLoading: list.isLoading, error: list.error, data: projectId === undefined || list.data === undefined ? undefined : items, isEmpty: () => items.length === 0 && status === '' && !manage });
  const choose = (id: string): void => setParams(id === '' ? {} : { id });
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('prj.risk.page.title')}</h1>
          <p>{t('prj.risk.page.subtitle')}</p>
        </div>
      </div>
      <div className="prj-filters">
        <label htmlFor="risk-project">{t('prj.risk.filter.project.label')}</label>
        <select id="risk-project" value={projectId ?? ''} onChange={(event) => choose(event.target.value)}>
          <option value="">{NONE}</option>
          {(projects.data ?? []).map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.code} {candidate.name}
            </option>
          ))}
        </select>
        <label htmlFor="risk-status">{t('prj.risk.filter.status.label')}</label>
        <select id="risk-status" value={status} onChange={(event) => setStatus(event.target.value)} disabled={projectId === undefined}>
          <option value="">{t('prj.risk.filter.status.all')}</option>
          {STATUSES.map((value) => (
            <option key={value} value={value}>
              {statusLabel(t, value)}
            </option>
          ))}
        </select>
      </div>
      {projectId === undefined ? (
        <p className="callout" role="status" data-testid="no-project">
          {t('prj.risk.noProject.notice')}
        </p>
      ) : (
        <StateBoundary state={state} onRetry={() => void list.refetch()}>
          {head === undefined ? null : (
            <>
              <p className="sub" data-testid="summary">
                {t('prj.risk.summary.counts', { live: head.liveCount, critical: head.criticalCount, overdue: head.overdueCount })}
              </p>
              <RiskMatrix matrix={head.matrix} />
              {manage ? <RiskFormPanel key={editing === undefined ? 'new' : `${editing.id}:${editing.version}`} projectId={projectId} risk={editing} matrix={head.matrix} onDone={() => setEditing(undefined)} /> : null}
              <div className="tablewrap">
                <table className="table" aria-label={t('prj.risk.list.aria')} data-testid="risks">
                  <thead>
                    <tr>
                      <th scope="col">{t('prj.risk.col.code')}</th>
                      <th scope="col">{t('prj.risk.col.title')}</th>
                      <th scope="col">{t('prj.risk.col.category')}</th>
                      <th scope="col">{t('prj.risk.col.owner')}</th>
                      <th scope="col">{t('prj.risk.col.score')}</th>
                      <th scope="col">{t('prj.risk.col.due')}</th>
                      <th scope="col">{t('prj.risk.col.status')}</th>
                      <th scope="col">
                        <span className="sr-only">{t('prj.risk.col.actions')}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item) => (
                      <tr key={item.id} data-risk={item.id} data-status={item.status} data-level={item.level}>
                        <td>
                          <code>{item.code}</code>
                        </td>
                        <td>
                          {item.title}
                          <span className="prj-code">{item.mitigation}</span>
                          {item.closedReason === null ? null : <span className="prj-code">{t('prj.risk.closed.note', { reason: item.closedReason })}</span>}
                        </td>
                        <td>{item.categoryLabel ?? NONE}</td>
                        <td>{item.ownerName ?? item.ownerId}</td>
                        <td>
                          <span className={`pill ${levelTone(item.level)}`} data-level={item.level}>
                            {t('prj.risk.score.pill', { score: item.score, level: levelLabel(t, item.level) })}
                          </span>
                          <span className="prj-code">{t('prj.risk.score.factors', { likelihood: item.likelihood, impact: item.impact })}</span>
                        </td>
                        <td>
                          {item.dueDate}
                          {item.overdue ? <span className="pill red">{t('prj.risk.overdue.pill')}</span> : null}
                        </td>
                        <td>
                          <span className={`pill ${statusTone(item.status)}`} data-status={item.status}>
                            {statusLabel(t, item.status)}
                          </span>
                        </td>
                        <td>
                          {manage && isLive(item.status) ? (
                            <>
                              <button type="button" onClick={() => setEditing(item)}>
                                {t('prj.risk.edit.action')}
                              </button>{' '}
                              <button type="button" onClick={() => setClosing(item)}>
                                {t('prj.risk.close.action')}
                              </button>
                            </>
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
                    {t('prj.risk.more.action')}
                  </button>
                </p>
              ) : null}
            </>
          )}
        </StateBoundary>
      )}
      {closing === undefined ? null : <ClosureDialog risk={closing} onClose={() => setClosing(undefined)} />}
      <p className="prototype-note">{t('prj.risk.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

/** The live risks by likelihood (rows, highest first) and impact (columns). Every cell says its score and its band in words, and how many risks it holds. */
function RiskMatrix({ matrix }: { matrix: readonly Cell[] }) {
  const { t } = useTranslation();
  const descending = [...SCALE].reverse();
  return (
    <div className="tablewrap">
      <table className="table prj-matrix" aria-label={t('prj.risk.matrix.aria')} data-testid="matrix">
        <caption className="sub">{t('prj.risk.matrix.caption')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('prj.risk.matrix.corner')}</th>
            {SCALE.map((impact) => (
              <th key={impact} scope="col">
                {t('prj.risk.matrix.impact', { value: impact })}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {descending.map((likelihood) => (
            <tr key={likelihood}>
              <th scope="row">{t('prj.risk.matrix.likelihood', { value: likelihood })}</th>
              {SCALE.map((impact) => {
                const cell = cellOf(matrix, likelihood, impact);
                return cell === undefined ? (
                  <td key={impact}>{NONE}</td>
                ) : (
                  <td key={impact} data-cell={`${likelihood}:${impact}`} data-level={cell.level} data-count={cell.count} aria-label={t('prj.risk.matrix.cell.aria', { likelihood, impact, score: cell.score, level: levelLabel(t, cell.level), count: cell.count })}>
                    <strong>{cell.score}</strong> <span className={`pill ${levelTone(cell.level)}`}>{levelLabel(t, cell.level)}</span>
                    <span className="prj-code">{t('prj.risk.matrix.cell.count', { count: cell.count })}</span>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RiskFormPanel({ projectId, risk, matrix, onDone }: { projectId: string; risk: RiskView | undefined; matrix: readonly Cell[]; onDone(): void }) {
  const { t } = useTranslation();
  const register = useRegisterRisk();
  const update = useUpdateRisk();
  const categories = useMasterOptions(CATEGORY_TYPES);
  const send = risk === undefined ? register : update;
  const [form, setForm] = useState<RiskForm>(risk === undefined ? EMPTY_FORM : formOfRisk(risk));
  const [problems, setProblems] = useState<Partial<Record<RiskField, FormProblem>>>({});
  const [saved, setSaved] = useState(false);
  const refusal = send.isError ? describeRisk(send.error) : undefined;
  const options = categories.data ?? [];
  const score = previewScore(form);
  const preview = score === undefined ? undefined : cellOf(matrix, Number(form.likelihood), Number(form.impact));
  const set = (patch: Partial<RiskForm>): void => {
    setSaved(false);
    setForm((value) => ({ ...value, ...patch }));
  };
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const found = validateForm(form);
    setProblems(found);
    if (Object.keys(found).length > 0 || send.isPending) return;
    const done = {
      onSuccess: () => {
        setForm(EMPTY_FORM);
        setSaved(true);
        onDone();
      },
    };
    if (risk === undefined) register.mutate({ projectId, body: entryBody(form, false) }, done);
    else update.mutate({ id: risk.id, version: risk.version, body: entryBody(form, true) }, done);
  };
  const error = (field: RiskField): string | undefined => fieldMessage(t, problems[field]);
  const title = risk === undefined ? t('prj.risk.form.new.title') : t('prj.risk.form.edit.title', { code: risk.code });
  return (
    <form className="card" onSubmit={submit} noValidate aria-label={title}>
      <h2>{title}</h2>
      <p className="sub">{t('prj.risk.form.help')}</p>
      {refusal === undefined ? null : (
        <p className="callout warning" role="alert" data-testid="form-refusal">
          {problemMessage(t, refusal)}
        </p>
      )}
      {saved ? (
        <p className="callout" role="status" data-testid="form-saved">
          {t('prj.risk.form.saved')}
        </p>
      ) : null}
      <Field id="risk-code" label={t('prj.risk.field.code.label')} error={error('code')} hint={t('prj.risk.field.code.hint')}>
        <input id="risk-code" type="text" value={form.code} onChange={(event) => set({ code: event.target.value })} />
      </Field>
      {options.length > 0 || categories.isLoading ? (
        <Field id="risk-category" label={t('prj.risk.field.categoryId.label')} error={error('categoryId')}>
          <select id="risk-category" value={form.categoryId} onChange={(event) => set({ categoryId: event.target.value })}>
            <option value="">{NONE}</option>
            {options.map((option) => (
              <option key={option.versionId} value={option.versionId}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>
      ) : (
        <Field id="risk-category" label={t('prj.risk.field.categoryId.label')} error={error('categoryId')} hint={t('prj.risk.field.categoryId.hint')}>
          <input id="risk-category" type="text" value={form.categoryId} onChange={(event) => set({ categoryId: event.target.value })} />
        </Field>
      )}
      <Field id="risk-title" label={t('prj.risk.field.title.label')} error={error('title')}>
        <input id="risk-title" type="text" value={form.title} onChange={(event) => set({ title: event.target.value })} />
      </Field>
      <Field id="risk-description" label={t('prj.risk.field.description.label')} error={error('description')}>
        <textarea id="risk-description" rows={3} value={form.description} onChange={(event) => set({ description: event.target.value })} />
      </Field>
      <Field id="risk-likelihood" label={t('prj.risk.field.likelihood.label')} error={error('likelihood')}>
        <select id="risk-likelihood" value={form.likelihood} onChange={(event) => set({ likelihood: event.target.value })}>
          <option value="">{NONE}</option>
          {SCALE.map((step) => (
            <option key={step} value={String(step)}>
              {step}
            </option>
          ))}
        </select>
      </Field>
      <Field id="risk-impact" label={t('prj.risk.field.impact.label')} error={error('impact')}>
        <select id="risk-impact" value={form.impact} onChange={(event) => set({ impact: event.target.value })}>
          <option value="">{NONE}</option>
          {SCALE.map((step) => (
            <option key={step} value={String(step)}>
              {step}
            </option>
          ))}
        </select>
      </Field>
      <p data-testid="score-preview" className="sub">
        {score === undefined ? t('prj.risk.preview.choose') : t('prj.risk.preview.score', { score, level: preview === undefined ? NONE : levelLabel(t, preview.level) })}
      </p>
      <Field id="risk-owner" label={t('prj.risk.field.ownerId.label')} error={error('ownerId')} hint={t('prj.risk.field.ownerId.hint')}>
        <input id="risk-owner" type="text" value={form.ownerId} onChange={(event) => set({ ownerId: event.target.value })} />
      </Field>
      <Field id="risk-mitigation" label={t('prj.risk.field.mitigation.label')} error={error('mitigation')}>
        <textarea id="risk-mitigation" rows={3} value={form.mitigation} onChange={(event) => set({ mitigation: event.target.value })} />
      </Field>
      <Field id="risk-due" label={t('prj.risk.field.dueDate.label')} error={error('dueDate')}>
        <input id="risk-due" type="date" value={form.dueDate} onChange={(event) => set({ dueDate: event.target.value })} />
      </Field>
      <Field id="risk-issue" label={t('prj.risk.field.linkedIssueId.label')} error={error('linkedIssueId')} hint={t('prj.risk.field.linkedIssueId.hint')}>
        <input id="risk-issue" type="text" value={form.linkedIssueId} onChange={(event) => set({ linkedIssueId: event.target.value })} />
      </Field>
      {risk !== undefined && isLive(risk.status) ? (
        <Field id="risk-status-next" label={t('prj.risk.field.status.label')} error={undefined} hint={t('prj.risk.field.status.hint')}>
          <select id="risk-status-next" value={form.status} onChange={(event) => set({ status: event.target.value as RiskForm['status'] })}>
            {movesFrom(risk.status).map((value) => (
              <option key={value} value={value}>
                {statusLabel(t, value)}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
      <div className="formfooter">
        {risk === undefined ? null : (
          <button type="button" onClick={onDone}>
            {t('prj.risk.form.cancel.action')}
          </button>
        )}
        <button type="submit" className="primary" disabled={send.isPending}>
          {risk === undefined ? t('prj.risk.form.register.action') : t('prj.risk.form.update.action')}
        </button>
      </div>
    </form>
  );
}

function ClosureDialog({ risk, onClose }: { risk: RiskView; onClose(): void }) {
  const { t } = useTranslation();
  const titleId = useId();
  const send = useCloseRisk();
  const [form, setForm] = useState<ClosureForm>(EMPTY_CLOSURE);
  const [problem, setProblem] = useState<FormProblem | undefined>(undefined);
  const refusal = send.isError ? describeRisk(send.error) : undefined;
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const found = validateClosure(form);
    setProblem(found);
    if (found !== undefined || send.isPending) return;
    send.mutate({ id: risk.id, version: risk.version, body: closureBody(form) }, { onSuccess: onClose });
  };
  return (
    <NavigationDialog className="catalog command-mode" onClose={onClose}>
      <section className="command-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="command-titlebar">
          <strong id={titleId}>{t('prj.risk.closure.title', { code: risk.code })}</strong>
          <button type="button" className="icon-button" aria-label={t('prj.risk.closure.dismiss.label')} onClick={onClose}>
            {CLOSE_GLYPH}
          </button>
        </div>
        <form className="dis-dialog-body" onSubmit={submit} noValidate>
          <p data-testid="closure-summary">{t('prj.risk.closure.summary', { title: risk.title, score: risk.score })}</p>
          {refusal === undefined ? null : (
            <p className="callout warning" role="alert" data-testid="closure-refusal">
              {problemMessage(t, refusal)}
            </p>
          )}
          <fieldset>
            <legend>{t('prj.risk.closure.status.label')}</legend>
            {ENDING_STATUSES.map((value: EndingStatus) => (
              <label key={value}>
                <input type="radio" name="risk-closure-status" value={value} checked={form.status === value} onChange={() => setForm((current) => ({ ...current, status: value }))} /> {statusLabel(t, value)}
              </label>
            ))}
          </fieldset>
          <Field id="risk-closure-reason" label={t('prj.risk.closure.reason.label')} error={fieldMessage(t, problem)} hint={t('prj.risk.closure.reason.hint')}>
            <textarea
              id="risk-closure-reason"
              rows={3}
              value={form.reason}
              onChange={(event) => {
                setProblem(undefined);
                setForm((current) => ({ ...current, reason: event.target.value }));
              }}
            />
          </Field>
          <div className="formfooter">
            <button type="button" onClick={onClose}>
              {t('prj.risk.closure.cancel.action')}
            </button>
            <button type="submit" className="primary" disabled={send.isPending}>
              {t('prj.risk.closure.submit.action')}
            </button>
          </div>
        </form>
      </section>
    </NavigationDialog>
  );
}

