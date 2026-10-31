import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { Field } from '../components';
import { useProjects } from '../hooks';
import '../prj.css';
import { NONE, ProjectChooser, useMoney, useProjectParam } from '../revision/shared';
import { useAddComponent, useComponents } from './hooks';
import { EMPTY_COMPONENT, FROZEN_STAGES, UPDATE_PERMISSION, componentBody, describePlan, holds, validateComponent } from './model';
import type { ComponentField, ComponentForm, FormProblem, PlanProblem } from './model';
import { fieldMessage, problemMessage } from './shared';


/**
 * PRJ-05: the work breakdown of a project (ST-PRJ-009, PRJ 3.1 BR-PRJ-08). The components are listed as a tree, each with its parent and its planned value; the value of the first level is set against the investment
 * total of the project, and more than the total is a warning that says both figures and does not stop anyone. A component is added under a parent of the same project.
 */
export default function ComponentsScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  const { projectId } = useProjectParam();
  return <ComponentsContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}:${projectId ?? ''}`} route={route} />;
}

function ComponentsContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const { projectId, choose } = useProjectParam();
  const projects = useProjects();
  const project = (projects.data ?? []).find((candidate) => candidate.id === projectId);
  const list = useComponents(projectId);
  const money = useMoney();
  const items = list.data?.items ?? [];
  const state = useScreenState({ isLoading: list.isLoading, error: list.error, data: projectId === undefined || list.data === undefined ? undefined : items, isEmpty: () => false });
  const parents = new Map(items.map((item) => [item.id, item.code]));
  const mayWrite = holds(permissions, UPDATE_PERMISSION, mode) && project !== undefined && !FROZEN_STAGES.includes(project.status);
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('prj.wbs.title')}</h1>
          <p>{t('prj.wbs.subtitle')}</p>
        </div>
      </div>
      <ProjectChooser id="components-project" projectId={projectId} choose={choose} />
      {projectId === undefined ? (
        <p className="callout" role="status" data-testid="no-project">
          {t('prj.revision.noProject.notice')}
        </p>
      ) : (
        <StateBoundary state={state} onRetry={() => void list.refetch()}>
          {list.data === undefined ? null : (
            <>
              <p data-testid="wbs-total">
                <strong>{t('prj.wbs.total.label')}</strong> {t('prj.wbs.total.value', { wbs: money(list.data.wbsTotalVnd), total: money(list.data.projectTotalVnd) })}
              </p>
              {list.data.exceedsTotal ? (
                <p className="callout warning" role="status" data-testid="exceeds-warning">
                  {t('prj.wbs.exceeds.warning', { wbs: money(list.data.wbsTotalVnd), total: money(list.data.projectTotalVnd) })}
                </p>
              ) : null}
              {mayWrite ? <AddComponentPanel projectId={projectId} parents={items.map((item) => ({ id: item.id, code: item.code, name: item.name }))} /> : null}
              <div className="tablewrap">
                <table className="table" aria-label={t('prj.wbs.list.aria')} data-testid="components">
                  <thead>
                    <tr>
                      <th scope="col">{t('prj.wbs.col.code')}</th>
                      <th scope="col">{t('prj.wbs.col.parent')}</th>
                      <th scope="col">{t('prj.wbs.col.value')}</th>
                      <th scope="col">{t('prj.wbs.col.from')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item) => (
                      <tr key={item.id} data-component={item.id} data-depth={item.depth}>
                        <td style={{ paddingLeft: `${(item.depth - 1) * 20 + 8}px` }}>
                          <code>{item.code}</code> {item.name}
                          <span className="prj-code">{t('prj.wbs.level', { level: item.depth })}</span>
                        </td>
                        <td>{item.parentId === null ? NONE : (parents.get(item.parentId) ?? NONE)}</td>
                        <td>{money(item.plannedValueVnd)}</td>
                        <td>{item.validFrom}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </StateBoundary>
      )}
      <p className="prototype-note">{t('prj.revision.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function AddComponentPanel({ projectId, parents }: { projectId: string; parents: Array<{ id: string; code: string; name: string }> }) {
  const { t } = useTranslation();
  const send = useAddComponent();
  const [form, setForm] = useState<ComponentForm>(EMPTY_COMPONENT);
  const [problems, setProblems] = useState<Partial<Record<ComponentField, FormProblem>>>({});
  const [saved, setSaved] = useState(false);
  const refusal: PlanProblem | undefined = send.isError ? describePlan(send.error) : undefined;
  const set = (patch: Partial<ComponentForm>): void => {
    setSaved(false);
    setForm((value) => ({ ...value, ...patch }));
  };
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const found = validateComponent(form);
    setProblems(found);
    if (Object.keys(found).length > 0 || send.isPending) return;
    send.mutate(
      { projectId, body: componentBody(form) },
      {
        onSuccess: () => {
          setForm(EMPTY_COMPONENT);
          setSaved(true);
        },
      },
    );
  };
  const error = (field: ComponentField): string | undefined => fieldMessage(t, problems[field]);
  return (
    <form className="card" onSubmit={submit} noValidate aria-label={t('prj.wbs.form.title')}>
      <h2>{t('prj.wbs.form.title')}</h2>
      {refusal === undefined ? null : (
        <p className="callout warning" role="alert" data-testid="component-refusal">
          {problemMessage(t, refusal)}
        </p>
      )}
      {saved ? (
        <p className="callout" role="status" data-testid="component-saved">
          {t('prj.wbs.form.saved')}
        </p>
      ) : null}
      <Field id="component-code" label={t('prj.wbs.field.code.label')} error={error('code')} hint={t('prj.plan.field.code.hint')}>
        <input id="component-code" type="text" value={form.code} onChange={(event) => set({ code: event.target.value })} />
      </Field>
      <Field id="component-name" label={t('prj.wbs.field.name.label')} error={error('name')}>
        <input id="component-name" type="text" value={form.name} onChange={(event) => set({ name: event.target.value })} />
      </Field>
      <Field id="component-parent" label={t('prj.wbs.field.parent.label')} error={error('parent')}>
        <select id="component-parent" value={form.parent} onChange={(event) => set({ parent: event.target.value })}>
          <option value="">{NONE}</option>
          {parents.map((parent) => (
            <option key={parent.id} value={parent.id}>
              {parent.code} {parent.name}
            </option>
          ))}
        </select>
      </Field>
      <Field id="component-value" label={t('prj.wbs.field.value.label')} error={error('value')} hint={t('prj.wbs.field.value.hint')}>
        <input id="component-value" type="text" inputMode="numeric" value={form.value} onChange={(event) => set({ value: event.target.value })} />
      </Field>
      <Field id="component-from" label={t('prj.wbs.field.from.label')} error={error('validFrom')}>
        <input id="component-from" type="date" value={form.validFrom} onChange={(event) => set({ validFrom: event.target.value })} />
      </Field>
      <Field id="component-sort" label={t('prj.wbs.field.sort.label')} error={error('sortOrder')} hint={t('prj.wbs.field.sort.hint')}>
        <input id="component-sort" type="text" inputMode="numeric" value={form.sortOrder} onChange={(event) => set({ sortOrder: event.target.value })} />
      </Field>
      <div className="formfooter">
        <button type="submit" className="primary" disabled={send.isPending}>
          {t('prj.wbs.form.submit.action')}
        </button>
      </div>
    </form>
  );
}

