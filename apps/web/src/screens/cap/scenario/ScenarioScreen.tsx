import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../../i18n';
import type { Translator } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { useFrozenSnapshots } from '../../dis/rates/hooks';
import { Field } from '../components';
import { usePlanLines, usePlans, useProjects } from '../plan-hooks';
import '../cap.css';
import { useCreateScenario, usePromoteScenario, useRunScenario, useScenarios } from './hooks';
import { EMPTY_FORM, EMPTY_MOVE, PROMOTE_PERMISSION, READ_PERMISSION, RUN_PERMISSION, STATUSES, changeOf, describeScenario, hasProblems, holds, scenarioBody, validateForm, violationsOf } from './model';
import type { FormProblem, FormProblems, MoveForm, ScenarioForm, ScenarioProblem, ScenarioView, Status } from './model';

type T = Translator['t'];
const NONE = '—';

function problemMessage(t: T, problem: ScenarioProblem): string {
  switch (problem) {
    case 'infeasible':
      return t('cap.scenario.problem.infeasible');
    case 'notRun':
      return t('cap.scenario.problem.notRun');
    case 'snapshotNotFrozen':
      return t('cap.scenario.problem.snapshotNotFrozen');
    case 'belowCommitted':
      return t('cap.scenario.problem.belowCommitted');
    case 'planNotPublished':
      return t('cap.scenario.problem.planNotPublished');
    case 'versionConflict':
      return t('cap.scenario.problem.versionConflict');
    case 'stageDenied':
      return t('cap.scenario.problem.stageDenied');
    case 'duplicate':
      return t('cap.scenario.problem.duplicate');
    case 'scopeDenied':
      return t('cap.scenario.problem.scopeDenied');
    case 'validation':
      return t('cap.scenario.problem.validation');
    case 'notFound':
      return t('cap.scenario.problem.notFound');
    case 'general':
      return t('cap.scenario.problem.general');
  }
}

function violationLabel(t: T, kind: string): string {
  switch (kind) {
    case 'BELOW_MINIMUM':
      return t('cap.scenario.violation.belowMinimum');
    case 'MOVE_ABOVE_LIMIT':
      return t('cap.scenario.violation.moveAboveLimit');
    case 'TOTAL_ABOVE_LIMIT':
      return t('cap.scenario.violation.totalAboveLimit');
    case 'NO_RECIPIENT_LINE':
      return t('cap.scenario.violation.noRecipientLine');
    default:
      return kind;
  }
}

function statusLabel(t: T, status: Status): string {
  switch (status) {
    case 'DRAFT':
      return t('cap.scenario.status.draft');
    case 'RUN':
      return t('cap.scenario.status.run');
    case 'PROMOTED':
      return t('cap.scenario.status.promoted');
    case 'ARCHIVED':
      return t('cap.scenario.status.archived');
  }
}

function fieldMessage(t: T, problem: FormProblem | undefined): string | undefined {
  switch (problem) {
    case undefined:
      return undefined;
    case 'required':
      return t('cap.scenario.field.required.error');
    case 'same':
      return t('cap.scenario.field.same.error');
    case 'duplicate':
      return t('cap.scenario.field.duplicate.error');
    case 'invalid':
      return t('cap.scenario.field.invalid.error');
  }
}

/** Whole dong with the thousands told apart by the locale. */
const dong = (value: string): string => (/^-?[0-9]+$/.test(value) ? BigInt(value).toLocaleString('vi-VN') : value);
const signed = (value: bigint): string => `${value > 0n ? '+' : ''}${value.toLocaleString('vi-VN')}`;

/**
 * CAP-09: the simulation of an allocation (ST-CAP-013, CAP 3.1 F8, UAT-AC233, UAT-PLAN-65). A planner states moves of capital between the projects of a published plan and the limits they must keep, runs the scenario and
 * reads each project before and after; nothing is written to the ledger or to a line of the plan. A scenario that has been run is promoted to a DRAFT reallocation proposal, which has its own approval.
 */
export default function ScenarioScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <ScenarioContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function ScenarioContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const [status, setStatus] = useState('');
  const [viewing, setViewing] = useState<string | undefined>(undefined);
  const mayRead = holds(permissions, READ_PERMISSION, 'FULL');
  const mayRun = holds(permissions, RUN_PERMISSION, mode);
  const mayPromote = holds(permissions, PROMOTE_PERMISSION, mode);
  const list = useScenarios(status, mayRead);
  const run = useRunScenario();
  const promote = usePromoteScenario();
  const projects = useProjects(mayRead);
  const items = (list.data?.pages ?? []).flatMap((page) => page.items);
  const state = useScreenState({ isLoading: list.isLoading, error: list.error, data: list.data === undefined ? undefined : items, isEmpty: () => items.length === 0 && status === '' && !mayRun });
  const shown = items.find((item) => item.id === viewing);
  const step = run.isError ? run : promote.isError ? promote : undefined;
  const refusal = step === undefined ? undefined : describeScenario(step.error);
  const broken = step === undefined ? [] : violationsOf(step.error);
  const projectLabel = (id: string): string => {
    const known = (projects.data ?? []).find((project) => project.id === id);
    return known === undefined ? id.slice(0, 8) : `${known.code} ${known.name}`.trim();
  };
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('cap.scenario.page.title')}</h1>
          <p>{t('cap.scenario.page.subtitle')}</p>
        </div>
      </div>
      {mayRun ? <CreatePanel /> : null}
      {refusal === undefined ? null : (
        <div className="callout warning" role="alert" data-testid="step-refusal">
          <p>{problemMessage(t, refusal)}</p>
          {broken.length === 0 ? null : (
            <ul data-testid="violations">
              {broken.map((kind, index) => (
                <li key={index}>{violationLabel(t, kind)}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div className="cap-filters">
        <label htmlFor="scenario-status">{t('cap.scenario.filter.status.label')}</label>
        <select id="scenario-status" value={status} onChange={(event) => setStatus(event.target.value)}>
          <option value="">{t('cap.scenario.filter.status.all')}</option>
          {STATUSES.map((value) => (
            <option key={value} value={value}>
              {statusLabel(t, value)}
            </option>
          ))}
        </select>
      </div>
      <StateBoundary state={state} onRetry={() => void list.refetch()}>
        <div className="tablewrap">
          <table className="table" aria-label={t('cap.scenario.list.aria')} data-testid="scenarios">
            <thead>
              <tr>
                <th scope="col">{t('cap.scenario.col.code')}</th>
                <th scope="col">{t('cap.scenario.col.plan')}</th>
                <th scope="col">{t('cap.scenario.col.moves')}</th>
                <th scope="col">{t('cap.scenario.col.total')}</th>
                <th scope="col">{t('cap.scenario.col.status')}</th>
                <th scope="col">
                  <span className="sr-only">{t('cap.scenario.col.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id} data-scenario={item.id} data-status={item.status}>
                  <td>
                    {item.code}
                    <span className="cap-code">{item.scopeUnitName}</span>
                  </td>
                  <td>{t('cap.scenario.plan.value', { code: item.planCode, year: item.planYear })}</td>
                  <td>{item.moves.length}</td>
                  <td>{item.result === null ? NONE : t('cap.scenario.money', { amount: dong(item.result.totalMovedVnd) })}</td>
                  <td>
                    <span className={`pill ${item.status === 'PROMOTED' ? 'green' : item.status === 'RUN' ? 'blue' : 'gray'}`} data-status={item.status}>
                      {statusLabel(t, item.status)}
                    </span>
                  </td>
                  <td>
                    {item.result === null ? null : (
                      <button type="button" onClick={() => setViewing(viewing === item.id ? undefined : item.id)}>
                        {t('cap.scenario.view.action')}
                      </button>
                    )}{' '}
                    {mayRun && item.mayRun ? (
                      <button type="button" disabled={run.isPending} onClick={() => run.mutate({ id: item.id, version: item.version })}>
                        {item.status === 'RUN' ? t('cap.scenario.rerun.action') : t('cap.scenario.run.action')}
                      </button>
                    ) : null}{' '}
                    {mayPromote && item.mayPromote ? (
                      <button type="button" disabled={promote.isPending} onClick={() => promote.mutate({ id: item.id, version: item.version })}>
                        {t('cap.scenario.promote.action')}
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
              {t('cap.scenario.more.action')}
            </button>
          </p>
        ) : null}
        {shown === undefined ? null : <Result scenario={shown} label={projectLabel} onClose={() => setViewing(undefined)} />}
      </StateBoundary>
      <p className="prototype-note">{t('cap.scenario.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

/** Each project before and after the moves, with what it gains or loses, and the line that keeps the most: nothing here has been written to the plan. */
function Result({ scenario, label, onClose }: { scenario: ScenarioView; label(projectId: string): string; onClose(): void }) {
  const { t } = useTranslation();
  const result = scenario.result;
  if (result === null) return null;
  return (
    <section className="card" aria-labelledby="scenario-result-title" data-testid="scenario-result">
      <div className="heading">
        <h2 id="scenario-result-title">{t('cap.scenario.result.title', { code: scenario.code })}</h2>
        <button type="button" onClick={onClose}>
          {t('cap.scenario.result.close.action')}
        </button>
      </div>
      <p className="sub" data-testid="result-note">
        {scenario.promotedProposalId === null ? t('cap.scenario.result.note') : t('cap.scenario.result.promoted')}
      </p>
      <div className="tablewrap">
        <table className="table" aria-label={t('cap.scenario.result.aria')}>
          <thead>
            <tr>
              <th scope="col">{t('cap.scenario.result.project')}</th>
              <th scope="col">{t('cap.scenario.result.before')}</th>
              <th scope="col">{t('cap.scenario.result.after')}</th>
              <th scope="col">{t('cap.scenario.result.change')}</th>
            </tr>
          </thead>
          <tbody>
            {result.projects.map((project) => (
              <tr key={project.projectId} data-project={project.projectId}>
                <td>{label(project.projectId)}</td>
                <td>{dong(project.beforeVnd)}</td>
                <td>{dong(project.afterVnd)}</td>
                <td data-testid="project-change">{signed(changeOf(project))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="cap-balance" data-testid="result-total">
        {t('cap.scenario.result.total', { amount: dong(result.totalMovedVnd) })}
      </p>
    </section>
  );
}

function CreatePanel() {
  const { t } = useTranslation();
  const send = useCreateScenario();
  const plans = usePlans();
  const frozen = useFrozenSnapshots();
  const projects = useProjects();
  const [form, setForm] = useState<ScenarioForm>(EMPTY_FORM);
  const [problems, setProblems] = useState<FormProblems>({ moves: [] });
  const [saved, setSaved] = useState(false);
  const published = (plans.data ?? []).filter((plan) => plan.status === 'PUBLISHED' && plan.planYear !== null);
  const plan = published.find((candidate) => candidate.id === form.planId);
  const lines = usePlanLines(form.planId === '' ? undefined : form.planId);
  const donors = lines.data?.lines ?? [];
  const refusal = send.isError ? describeScenario(send.error) : undefined;
  const set = (patch: Partial<ScenarioForm>): void => {
    setSaved(false);
    setForm((value) => ({ ...value, ...patch }));
  };
  const setMove = (index: number, patch: Partial<MoveForm>): void => set({ moves: form.moves.map((move, at) => (at === index ? { ...move, ...patch } : move)) });
  const projectOfLine = (lineId: string): string | undefined => donors.find((line) => line.id === lineId)?.project.id;
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const found = validateForm(form, projectOfLine);
    setProblems(found);
    if (hasProblems(found) || plan === undefined || send.isPending) return;
    send.mutate(scenarioBody(form, { id: plan.id, planYear: plan.planYear as number }), {
      onSuccess: () => {
        setForm(EMPTY_FORM);
        setSaved(true);
      },
    });
  };
  return (
    <form className="card" onSubmit={submit} noValidate aria-label={t('cap.scenario.form.title')}>
      <h2>{t('cap.scenario.form.title')}</h2>
      <p className="sub">{t('cap.scenario.form.help')}</p>
      {refusal === undefined ? null : (
        <p className="callout warning" role="alert" data-testid="create-refusal">
          {problemMessage(t, refusal)}
        </p>
      )}
      {saved ? (
        <p className="callout" role="status" data-testid="create-saved">
          {t('cap.scenario.form.saved')}
        </p>
      ) : null}
      <Field id="scenario-code" label={t('cap.scenario.field.code.label')} error={fieldMessage(t, problems.code)}>
        <input id="scenario-code" type="text" value={form.code} onChange={(event) => set({ code: event.target.value })} />
      </Field>
      <Field id="scenario-plan" label={t('cap.scenario.field.plan.label')} error={fieldMessage(t, problems.planId)}>
        <select id="scenario-plan" value={form.planId} onChange={(event) => set({ planId: event.target.value, moves: [{ ...EMPTY_MOVE }] })}>
          <option value="">{NONE}</option>
          {published.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {t('cap.scenario.field.plan.option', { code: candidate.planCode, revision: candidate.revision, year: candidate.planYear ?? '' })}
            </option>
          ))}
        </select>
      </Field>
      <Field id="scenario-snapshot" label={t('cap.scenario.field.snapshot.label')} error={undefined} hint={t('cap.scenario.field.snapshot.hint')}>
        <select id="scenario-snapshot" value={form.snapshotId} onChange={(event) => set({ snapshotId: event.target.value })}>
          <option value="">{NONE}</option>
          {(frozen.data ?? []).map((snapshot) => (
            <option key={snapshot.id} value={snapshot.id}>
              {t('cap.scenario.field.snapshot.option', { cutoff: snapshot.cutoffDate })}
            </option>
          ))}
        </select>
      </Field>
      <fieldset>
        <legend>{t('cap.scenario.constraints.title')}</legend>
        <Field id="scenario-min" label={t('cap.scenario.field.min.label')} error={fieldMessage(t, problems.minRemaining)} hint={t('cap.scenario.field.min.hint')}>
          <input id="scenario-min" type="text" inputMode="numeric" value={form.minRemaining} onChange={(event) => set({ minRemaining: event.target.value })} />
        </Field>
        <Field id="scenario-max-move" label={t('cap.scenario.field.maxMove.label')} error={fieldMessage(t, problems.maxMove)}>
          <input id="scenario-max-move" type="text" inputMode="numeric" value={form.maxMove} onChange={(event) => set({ maxMove: event.target.value })} />
        </Field>
        <Field id="scenario-max-total" label={t('cap.scenario.field.maxTotal.label')} error={fieldMessage(t, problems.maxTotal)}>
          <input id="scenario-max-total" type="text" inputMode="numeric" value={form.maxTotal} onChange={(event) => set({ maxTotal: event.target.value })} />
        </Field>
      </fieldset>
      <fieldset>
        <legend>{t('cap.scenario.moves.title')}</legend>
        {form.moves.map((move, index) => {
          const own = problems.moves[index] ?? {};
          return (
            <div key={index} className="cap-line" data-testid="scenario-move">
              <Field id={`scenario-from-${index}`} label={t('cap.scenario.field.from.label')} error={fieldMessage(t, own.fromLineId)}>
                <select id={`scenario-from-${index}`} value={move.fromLineId} onChange={(event) => setMove(index, { fromLineId: event.target.value })}>
                  <option value="">{NONE}</option>
                  {donors.map((donor) => (
                    <option key={donor.id} value={donor.id}>
                      {t('cap.scenario.field.from.option', { project: donor.project.code, source: donor.fundSource.label, amount: dong(donor.amountVnd) })}
                    </option>
                  ))}
                </select>
              </Field>
              <Field id={`scenario-to-${index}`} label={t('cap.scenario.field.to.label')} error={fieldMessage(t, own.toProjectId)}>
                <select id={`scenario-to-${index}`} value={move.toProjectId} onChange={(event) => setMove(index, { toProjectId: event.target.value })}>
                  <option value="">{NONE}</option>
                  {(projects.data ?? []).map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.code} {project.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field id={`scenario-amount-${index}`} label={t('cap.scenario.field.amount.label')} error={fieldMessage(t, own.amount)} hint={t('cap.scenario.field.amount.hint')}>
                <input id={`scenario-amount-${index}`} type="text" inputMode="numeric" value={move.amount} onChange={(event) => setMove(index, { amount: event.target.value })} />
              </Field>
              <Field id={`scenario-note-${index}`} label={t('cap.scenario.field.note.label')} error={undefined}>
                <input id={`scenario-note-${index}`} type="text" value={move.note} onChange={(event) => setMove(index, { note: event.target.value })} />
              </Field>
              {form.moves.length > 1 ? (
                <button type="button" onClick={() => set({ moves: form.moves.filter((_, at) => at !== index) })}>
                  {t('cap.scenario.moves.remove.action')}
                </button>
              ) : null}
            </div>
          );
        })}
        <button type="button" onClick={() => set({ moves: [...form.moves, { ...EMPTY_MOVE }] })}>
          {t('cap.scenario.moves.add.action')}
        </button>
      </fieldset>
      <div className="formfooter">
        <button type="submit" className="primary" disabled={send.isPending}>
          {t('cap.scenario.form.submit.action')}
        </button>
      </div>
    </form>
  );
}
