import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { NavigationDialog } from '../../../shell/NavigationDialog';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { DataTable, SectionCard, StatusPill, StickyActions } from '../../../ui';
import type { DataTableColumn } from '../../../ui';
import { Field } from '../components';
import { useProjects } from '../hooks';
import '../prj.css';
import { NONE, ProjectChooser, useProjectParam } from '../revision/shared';
import { useAddMilestone, useComponents, useMilestones, useRecordProgress, useSetDependency } from './hooks';
import {
  EMPTY_MILESTONE,
  EMPTY_PROGRESS,
  FROZEN_STAGES,
  OUTCOMES,
  UPDATE_PERMISSION,
  dependencyChoices,
  describePlan,
  holds,
  isOpen,
  milestoneBody,
  progressBody,
  validateMilestone,
  validateProgress,
  vietnamToday,
} from './model';
import type { FormProblem, MilestoneField, MilestoneForm, MilestoneView, Outcome, ProgressField, ProgressForm } from './model';
import { fieldMessage, milestoneStatusLabel, milestoneTone, problemMessage } from './shared';

// U+00D7, the multiplication sign.
const CLOSE_GLYPH = '\u00d7';

/**
 * PRJ-07: the schedule of a project (ST-PRJ-009, PRJ 3.1). Each milestone shows its baseline day (never changed), the day it is planned for, the day it was done and the milestone it waits for. A milestone late against its
 * baseline says so in words with the days (calendar days from the baseline), whether it is done or still open. A milestone is marked done on a day, delayed to a later day with a reason, or cancelled with a reason; the
 * milestone it waits for can be changed unless that would close a loop.
 */
export default function MilestonesScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  const { projectId } = useProjectParam();
  return <MilestonesContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}:${projectId ?? ''}`} route={route} />;
}

function MilestonesContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const { projectId, choose } = useProjectParam();
  const [progressing, setProgressing] = useState<MilestoneView | undefined>(undefined);
  const [linking, setLinking] = useState<MilestoneView | undefined>(undefined);
  const projects = useProjects();
  const project = (projects.data ?? []).find((candidate) => candidate.id === projectId);
  const list = useMilestones(projectId);
  const items = list.data ?? [];
  const state = useScreenState({
    isLoading: list.isLoading,
    error: list.error,
    data: projectId === undefined || list.data === undefined ? undefined : items,
    isEmpty: () => false,
  });
  const columns: DataTableColumn<MilestoneView>[] = [
    {
      key: 'milestone',
      header: t('prj.mile.col.milestone'),
      pinned: true,
      render: (item) => (
        <>
          <code>{item.code}</code> {item.name}
          {item.componentCode === null ? null : <span className="prj-code">{t('prj.mile.component', { component: item.componentCode })}</span>}
          {item.reason === null ? null : <span className="prj-code">{t('prj.mile.reason', { reason: item.reason })}</span>}
        </>
      ),
    },
    {
      key: 'baseline',
      header: t('prj.mile.col.baseline'),
      render: (item) => item.baselineDate,
    },
    {
      key: 'planned',
      header: t('prj.mile.col.planned'),
      render: (item) => item.plannedDate,
    },
    {
      key: 'actual',
      header: t('prj.mile.col.actual'),
      render: (item) => item.actualDate ?? NONE,
    },
    {
      key: 'depends',
      header: t('prj.mile.col.depends'),
      render: (item) => (item.dependsOn === null ? NONE : item.dependsOn.code),
    },
    {
      key: 'status',
      header: t('prj.mile.col.status'),
      render: (item) => (
        <span className="prj-pills" data-status={item.status} data-delayed={item.delayed}>
          <StatusPill tone={milestoneTone(item.status)}>{milestoneStatusLabel(t, item.status)}</StatusPill>
          {item.delayed ? (
            <span data-testid="delay">
              <StatusPill tone="danger">{t('prj.mile.delay.pill', { days: item.delayDays })}</StatusPill>
            </span>
          ) : null}
        </span>
      ),
    },
    {
      key: 'actions',
      header: t('prj.mile.col.actions'),
      render: (item) =>
        mayWrite && isOpen(item.status) ? (
          <span className="prj-row-actions">
            <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => setProgressing(item)}>
              {t('prj.mile.progress.action')}
            </button>
            <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => setLinking(item)}>
              {t('prj.mile.depends.action')}
            </button>
          </span>
        ) : null,
    },
  ];
  const mayWrite = holds(permissions, UPDATE_PERMISSION, mode) && project !== undefined && !FROZEN_STAGES.includes(project.status);
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('prj.mile.title')}</h1>
          <p>{t('prj.mile.subtitle')}</p>
        </div>
      </div>
      <ProjectChooser id="milestones-project" projectId={projectId} choose={choose} />
      {projectId === undefined ? (
        <p className="callout" role="status" data-testid="no-project">
          {t('prj.revision.noProject.notice')}
        </p>
      ) : (
        <StateBoundary state={state} onRetry={() => void list.refetch()}>
          {mayWrite ? <AddMilestonePanel projectId={projectId} /> : null}
          <div data-testid="milestones">
            <DataTable caption={t('prj.mile.list.aria')} columns={columns} rows={items} rowKey={(item) => item.id} />
          </div>
        </StateBoundary>
      )}
      {progressing === undefined ? null : <ProgressDialog milestone={progressing} onClose={() => setProgressing(undefined)} />}
      {linking === undefined ? null : <DependencyDialog milestone={linking} items={items} onClose={() => setLinking(undefined)} />}
      <p className="prototype-note">
        {t('prj.revision.footer.reference', {
          id: route.id,
          req: route.req ?? '',
        })}
      </p>
    </section>
  );
}

function AddMilestonePanel({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const send = useAddMilestone();
  const components = useComponents(projectId);
  const [form, setForm] = useState<MilestoneForm>(EMPTY_MILESTONE);
  const [problems, setProblems] = useState<Partial<Record<MilestoneField, FormProblem>>>({});
  const [saved, setSaved] = useState(false);
  const milestones = useMilestones(projectId);
  const refusal = send.isError ? describePlan(send.error) : undefined;
  const set = (patch: Partial<MilestoneForm>): void => {
    setSaved(false);
    setForm((value) => ({ ...value, ...patch }));
  };
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const found = validateMilestone(form);
    setProblems(found);
    if (Object.keys(found).length > 0 || send.isPending) return;
    send.mutate(
      { projectId, body: milestoneBody(form) },
      {
        onSuccess: () => {
          setForm(EMPTY_MILESTONE);
          setSaved(true);
        },
      },
    );
  };
  const error = (field: MilestoneField): string | undefined => fieldMessage(t, problems[field]);
  return (
    <form onSubmit={submit} noValidate aria-label={t('prj.mile.form.title')}>
      <SectionCard title={t('prj.mile.form.title')}>
        {refusal === undefined ? null : (
          <p className="callout warning" role="alert" data-testid="milestone-refusal">
            {problemMessage(t, refusal)}
          </p>
        )}
        {saved ? (
          <p className="callout" role="status" data-testid="milestone-saved">
            {t('prj.mile.form.saved')}
          </p>
        ) : null}
        <Field id="milestone-code" label={t('prj.mile.field.code.label')} error={error('code')} hint={t('prj.plan.field.code.hint')}>
          <input id="milestone-code" type="text" value={form.code} onChange={(event) => set({ code: event.target.value })} />
        </Field>
        <Field id="milestone-name" label={t('prj.mile.field.name.label')} error={error('name')}>
          <input id="milestone-name" type="text" value={form.name} onChange={(event) => set({ name: event.target.value })} />
        </Field>
        <Field id="milestone-component" label={t('prj.mile.field.component.label')} error={error('component')}>
          <select id="milestone-component" value={form.component} onChange={(event) => set({ component: event.target.value })}>
            <option value="">{NONE}</option>
            {(components.data?.items ?? []).map((component) => (
              <option key={component.id} value={component.id}>
                {component.code} {component.name}
              </option>
            ))}
          </select>
        </Field>
        <Field id="milestone-baseline" label={t('prj.mile.field.baseline.label')} error={error('baseline')} hint={t('prj.mile.field.baseline.hint')}>
          <input id="milestone-baseline" type="date" value={form.baseline} onChange={(event) => set({ baseline: event.target.value })} />
        </Field>
        <Field id="milestone-planned" label={t('prj.mile.field.planned.label')} error={error('planned')}>
          <input id="milestone-planned" type="date" value={form.planned} onChange={(event) => set({ planned: event.target.value })} />
        </Field>
        <Field id="milestone-depends" label={t('prj.mile.field.depends.label')} error={error('dependsOn')}>
          <select id="milestone-depends" value={form.dependsOn} onChange={(event) => set({ dependsOn: event.target.value })}>
            <option value="">{NONE}</option>
            {(milestones.data ?? []).map((milestone) => (
              <option key={milestone.id} value={milestone.id}>
                {milestone.code} {milestone.name}
              </option>
            ))}
          </select>
        </Field>
        <StickyActions
          primary={
            <button type="submit" className="ui-button ui-button--primary" disabled={send.isPending}>
              {t('prj.mile.form.submit.action')}
            </button>
          }
        />
      </SectionCard>
    </form>
  );
}

function outcomeLabel(t: ReturnType<typeof useTranslation>['t'], outcome: Outcome): string {
  switch (outcome) {
    case 'DONE':
      return t('prj.mile.progress.done');
    case 'DELAYED':
      return t('prj.mile.progress.delayed');
    case 'CANCELLED':
      return t('prj.mile.progress.cancelled');
  }
}

function ProgressDialog({ milestone, onClose }: { milestone: MilestoneView; onClose(): void }) {
  const { t } = useTranslation();
  const titleId = useId();
  const send = useRecordProgress();
  const [form, setForm] = useState<ProgressForm>(EMPTY_PROGRESS);
  const [problems, setProblems] = useState<Partial<Record<ProgressField, FormProblem>>>({});
  const refusal = send.isError ? describePlan(send.error) : undefined;
  const set = (patch: Partial<ProgressForm>): void => {
    setProblems({});
    setForm((value) => ({ ...value, ...patch }));
  };
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const found = validateProgress(form, milestone, vietnamToday());
    setProblems(found);
    if (Object.keys(found).length > 0 || send.isPending) return;
    send.mutate(
      {
        id: milestone.id,
        version: milestone.version,
        body: progressBody(form),
      },
      { onSuccess: onClose },
    );
  };
  return (
    <NavigationDialog className="catalog command-mode" onClose={onClose}>
      <section className="command-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="command-titlebar">
          <strong id={titleId}>{t('prj.mile.progress.title', { code: milestone.code })}</strong>
          <button type="button" className="icon-button" aria-label={t('prj.plan.dialog.close.label')} onClick={onClose}>
            {CLOSE_GLYPH}
          </button>
        </div>
        <form className="dis-dialog-body" onSubmit={submit} noValidate>
          <p data-testid="progress-summary">
            {t('prj.mile.progress.summary', {
              baseline: milestone.baselineDate,
              planned: milestone.plannedDate,
            })}
          </p>
          {refusal === undefined ? null : (
            <p className="callout warning" role="alert" data-testid="progress-refusal">
              {problemMessage(t, refusal)}
            </p>
          )}
          <fieldset>
            <legend>{t('prj.mile.progress.outcome.label')}</legend>
            {OUTCOMES.map((value) => (
              <label key={value}>
                <input type="radio" name="milestone-outcome" value={value} checked={form.outcome === value} onChange={() => set({ outcome: value })} /> {outcomeLabel(t, value)}
              </label>
            ))}
          </fieldset>
          {form.outcome === 'DONE' ? (
            <Field id="progress-actual" label={t('prj.mile.progress.actual.label')} error={fieldMessage(t, problems.actual)} hint={t('prj.mile.progress.actual.hint')}>
              <input id="progress-actual" type="date" value={form.actual} onChange={(event) => set({ actual: event.target.value })} />
            </Field>
          ) : null}
          {form.outcome === 'DELAYED' ? (
            <Field id="progress-planned" label={t('prj.mile.progress.planned.label')} error={fieldMessage(t, problems.planned)} hint={t('prj.mile.progress.planned.hint')}>
              <input id="progress-planned" type="date" value={form.planned} onChange={(event) => set({ planned: event.target.value })} />
            </Field>
          ) : null}
          <Field
            id="progress-reason"
            label={t('prj.mile.progress.reason.label')}
            error={fieldMessage(t, problems.reason)}
            hint={form.outcome === 'DONE' ? t('prj.mile.progress.reason.optional') : t('prj.mile.progress.reason.hint')}
          >
            <textarea id="progress-reason" rows={3} value={form.reason} onChange={(event) => set({ reason: event.target.value })} />
          </Field>
          <div className="formfooter">
            <button type="button" onClick={onClose}>
              {t('prj.plan.dialog.cancel.action')}
            </button>
            <button type="submit" className="primary" disabled={send.isPending}>
              {t('prj.mile.progress.submit.action')}
            </button>
          </div>
        </form>
      </section>
    </NavigationDialog>
  );
}

function DependencyDialog({ milestone, items, onClose }: { milestone: MilestoneView; items: readonly MilestoneView[]; onClose(): void }) {
  const { t } = useTranslation();
  const titleId = useId();
  const send = useSetDependency();
  const [target, setTarget] = useState(milestone.dependsOn?.id ?? '');
  const refusal = send.isError ? describePlan(send.error) : undefined;
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (send.isPending) return;
    send.mutate(
      {
        id: milestone.id,
        version: milestone.version,
        body: { depends_on_milestone_id: target === '' ? null : target },
      },
      { onSuccess: onClose },
    );
  };
  return (
    <NavigationDialog className="catalog command-mode" onClose={onClose}>
      <section className="command-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="command-titlebar">
          <strong id={titleId}>{t('prj.mile.depends.title', { code: milestone.code })}</strong>
          <button type="button" className="icon-button" aria-label={t('prj.plan.dialog.close.label')} onClick={onClose}>
            {CLOSE_GLYPH}
          </button>
        </div>
        <form className="dis-dialog-body" onSubmit={submit} noValidate>
          {refusal === undefined ? null : (
            <p className="callout warning" role="alert" data-testid="depends-refusal">
              {problemMessage(t, refusal)}
            </p>
          )}
          <Field id="depends-target" label={t('prj.mile.depends.target.label')} error={undefined} hint={t('prj.mile.depends.target.hint')}>
            <select id="depends-target" value={target} onChange={(event) => setTarget(event.target.value)}>
              <option value="">{NONE}</option>
              {dependencyChoices(items, milestone.id).map((choice) => (
                <option key={choice.id} value={choice.id}>
                  {choice.code} {choice.name}
                </option>
              ))}
            </select>
          </Field>
          <div className="formfooter">
            <button type="button" onClick={onClose}>
              {t('prj.plan.dialog.cancel.action')}
            </button>
            <button type="submit" className="primary" disabled={send.isPending}>
              {t('prj.mile.depends.submit.action')}
            </button>
          </div>
        </form>
      </section>
    </NavigationDialog>
  );
}
