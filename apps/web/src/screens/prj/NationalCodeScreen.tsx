import { useId, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { NavigationDialog } from '../../shell/NavigationDialog';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { Field, NationalCode } from './components';
import { useProjects } from './hooks';
import { stageLabel } from './labels';
import { EMPTY_FILTER, filterProjects, workspaceLink } from './model';
import type { ListFilter, ProjectLine } from './model';
import { useAssignNationalCode } from './national-code-hooks';
import { NationalCodeImportPanel } from './NationalCodeImportPanel';
import { assignProblemMessage, reconcileProblemMessage, reconcileStateLabel } from './national-code-labels';
import { EMPTY_ASSIGN, MANAGE_PERMISSION, assignBody, canAssign, describeReconcileProblem, missingCount, needsEvidence, reconcileState, validateAssign } from './national-code-model';
import type { AssignForm } from './national-code-model';
import './prj.css';

/** The multiplication sign on the close button of the dialog. */
const CLOSE_GLYPH = '×';

/**
 * PRJ-21: the national project codes of the register. It shows which projects hold a code and which do not (a project without one is flagged, and
 * blocked from implementation and from the capital plan by the rule of the day), and lets the planning officer assign or change a code by hand.
 * The adapter of the national system is a proposal: nothing here calls a system of the State, the codes are the ones a person types or, from the file
 * they downloaded, the reconciliation the server reads.
 */
export default function NationalCodeScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The list and the dialog belong to one membership: a switch of tenant or of membership starts the screen over.
  return <NationalCodeContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function NationalCodeContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const projects = useProjects();
  const [filter, setFilter] = useState<ListFilter>({ ...EMPTY_FILTER, missingNationalCode: true });
  const [editing, setEditing] = useState<ProjectLine | undefined>(undefined);
  const state = useScreenState({ isLoading: projects.isLoading, error: projects.error, data: projects.data });
  const shown = useMemo(() => filterProjects(projects.data ?? [], filter), [projects.data, filter]);
  const missing = missingCount(projects.data ?? []);

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('prj.reconcile.page.title')}</h1>
          <p>{t('prj.reconcile.page.subtitle')}</p>
        </div>
      </div>
      <article className="card" aria-label={t('prj.reconcile.source.title')}>
        <h2>{t('prj.reconcile.source.title')}</h2>
        <p>
          <span className="prj-badge warning" data-testid="adapter-badge">
            {t('prj.reconcile.adapter.badge')}
          </span>
        </p>
        <p className="sub" data-testid="adapter-note">
          {t('prj.reconcile.adapter.note')}
        </p>
      </article>
      <NationalCodeImportPanel canImport={(permissions === undefined || permissions.includes(MANAGE_PERMISSION)) && mode !== 'READ_ONLY'} />
      <StateBoundary state={state} onRetry={() => void projects.refetch()}>
        <div className="card">
          <p data-testid="missing-count" role="status">
            {t('prj.reconcile.missing.count', { count: missing })}
          </p>
          <form className="prj-filters" role="search" aria-label={t('prj.reconcile.filters.title')} onSubmit={(event) => event.preventDefault()}>
            <div className="field">
              <label htmlFor="reconcile-query">{t('prj.reconcile.query.label')}</label>
              <input id="reconcile-query" value={filter.query} onChange={(event) => setFilter({ ...filter, query: event.target.value })} />
            </div>
            <label className="check">
              <input type="checkbox" checked={filter.missingNationalCode} onChange={(event) => setFilter({ ...filter, missingNationalCode: event.target.checked })} />
              {t('prj.reconcile.missingOnly.label')}
            </label>
          </form>
          {shown.length === 0 ? (
            <p className="callout" role="status" data-testid="no-match">
              {t('prj.reconcile.noMatch.notice')}
            </p>
          ) : (
            <table className="table" data-testid="projects">
              <thead>
                <tr>
                  <th scope="col">{t('prj.reconcile.column.code')}</th>
                  <th scope="col">{t('prj.reconcile.column.name')}</th>
                  <th scope="col">{t('prj.reconcile.column.stage')}</th>
                  <th scope="col">{t('prj.reconcile.column.nationalCode')}</th>
                  <th scope="col">{t('prj.reconcile.column.state')}</th>
                  <th scope="col">{t('prj.reconcile.column.action')}</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((project) => (
                  <tr key={project.id} data-project-id={project.id}>
                    <th scope="row">
                      <Link to={workspaceLink(project.id)}>{project.code}</Link>
                    </th>
                    <td>{project.name}</td>
                    <td>
                      <span className="prj-badge" data-testid="stage">
                        {stageLabel(t, project.status)}
                      </span>
                    </td>
                    <td>
                      <NationalCode code={project.nationalProjectCode} />
                    </td>
                    <td data-testid="state">{reconcileStateLabel(t, reconcileState(project))}</td>
                    <td>
                      {canAssign(project, permissions, mode) ? (
                        <button type="button" className="button" aria-label={t('prj.reconcile.assign.aria', { code: project.code })} onClick={() => setEditing(project)}>
                          {project.nationalProjectCode === null ? t('prj.reconcile.assign.action') : t('prj.reconcile.change.action')}
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </StateBoundary>
      {editing === undefined ? null : <AssignDialog project={editing} onClose={() => setEditing(undefined)} />}
      <p className="prototype-note">{t('prj.reconcile.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function AssignDialog({ project, onClose }: { project: ProjectLine; onClose(): void }) {
  const { t } = useTranslation();
  const titleId = useId();
  const assign = useAssignNationalCode();
  const [form, setForm] = useState<AssignForm>(EMPTY_ASSIGN);
  const [submitted, setSubmitted] = useState(false);
  const problems = validateAssign(project, form);
  const refused = assign.isError ? describeReconcileProblem(assign.error) : undefined;

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (assign.isPending || Object.keys(problems).length > 0) return;
    assign.mutate({ id: project.id, version: project.version, body: assignBody(form) }, { onSuccess: onClose });
  };

  const error = (field: keyof AssignForm): string | undefined => {
    const problem = problems[field];
    return submitted && problem !== undefined ? assignProblemMessage(t, problem) : undefined;
  };

  return (
    <NavigationDialog className="catalog command-mode" onClose={onClose}>
      <section className="command-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="command-titlebar">
          <strong id={titleId}>{t('prj.reconcile.dialog.title', { code: project.code })}</strong>
          <button type="button" className="icon-button" aria-label={t('prj.reconcile.dialog.close.label')} onClick={onClose}>
            {CLOSE_GLYPH}
          </button>
        </div>
        <div className="prj-dialog-body">
          <form onSubmit={submit} noValidate>
            <p data-testid="current-code">{project.nationalProjectCode === null ? t('prj.reconcile.dialog.current.none') : t('prj.reconcile.dialog.current.text', { code: project.nationalProjectCode })}</p>
            {refused === undefined ? null : (
              <p className="callout warning" role="alert" data-testid="refusal">
                {reconcileProblemMessage(t, refused)}
              </p>
            )}
            <div className="formgrid">
              <Field id="reconcile-code" label={t('prj.reconcile.dialog.code.label')} error={error('code')} hint={t('prj.reconcile.dialog.code.help')}>
                <input id="reconcile-code" value={form.code} aria-invalid={error('code') !== undefined} onChange={(event) => setForm({ ...form, code: event.target.value })} />
              </Field>
              <Field
                id="reconcile-evidence"
                label={t('prj.reconcile.dialog.evidence.label')}
                error={error('evidenceId')}
                hint={needsEvidence(project) ? t('prj.reconcile.dialog.evidence.required') : t('prj.reconcile.dialog.evidence.help')}
              >
                <input id="reconcile-evidence" value={form.evidenceId} aria-invalid={error('evidenceId') !== undefined} onChange={(event) => setForm({ ...form, evidenceId: event.target.value })} />
              </Field>
            </div>
            <div className="formfooter">
              <button type="button" onClick={onClose}>
                {t('prj.reconcile.dialog.cancel.action')}
              </button>
              <button type="submit" className="primary" disabled={assign.isPending}>
                {assign.isPending ? t('prj.reconcile.dialog.submit.pending') : t('prj.reconcile.dialog.submit.action')}
              </button>
            </div>
          </form>
        </div>
      </section>
    </NavigationDialog>
  );
}
