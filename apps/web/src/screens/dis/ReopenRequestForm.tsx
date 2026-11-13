import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../i18n';
import { SectionCard, StickyActions } from '../../ui';
import { Field } from './components';
import { useReopenProjects, useRequestReopen } from './hooks';
import { reopenFieldMessage, reopenProblemMessage, reopenScopeLabel } from './labels';
import { EMPTY_REOPEN_FORM, MAX_WINDOW_HOURS, describeProblem, lockedPeriods, matchingProjects, validateReopenForm } from './model';
import type { PeriodView, ReopenField, ReopenFieldProblem, ReopenForm, ReopenScope } from './model';

const SCOPES: readonly ReopenScope[] = ['PROJECTS', 'PERIOD'];

export interface ReopenRequestFormProps {
  periods: readonly PeriodView[];
}

/**
 * The request to reopen a locked period (DIS-22, ST-DIS-002): which period, for the whole period or for named projects, why (at least 20
 * characters, kept in the audit trail) and for how many hours (at most 168). A different person decides; the form says so rather than
 * letting the requester find out. The server judges the reach of the requester over each project.
 */
export function ReopenRequestForm({ periods }: ReopenRequestFormProps) {
  const { t } = useTranslation();
  const send = useRequestReopen();
  const choices = useMemo(() => lockedPeriods(periods), [periods]);
  const [form, setForm] = useState<ReopenForm>(EMPTY_REOPEN_FORM);
  const [problems, setProblems] = useState<Partial<Record<ReopenField, ReopenFieldProblem>>>({});
  const [filter, setFilter] = useState('');
  const [done, setDone] = useState(false);
  const forProjects = form.scope === 'PROJECTS';
  const projects = useReopenProjects(forProjects);
  const shown = useMemo(() => matchingProjects(projects.data ?? [], filter), [projects.data, filter]);
  const refused = send.isError ? describeProblem(send.error) : undefined;

  const change = (patch: Partial<ReopenForm>, field?: ReopenField): void => {
    setForm((current) => ({ ...current, ...patch }));
    setDone(false);
    if (field !== undefined) setProblems((current) => ({ ...current, [field]: undefined }));
  };
  const toggle = (id: string, on: boolean): void => change({ projectIds: on ? [...form.projectIds, id] : form.projectIds.filter((chosen) => chosen !== id) }, 'projects');
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (send.isPending) return;
    const found = validateReopenForm(form);
    setProblems(found);
    setDone(false);
    if (Object.keys(found).length > 0) return;
    send.mutate(
      { periodId: form.periodId, form },
      {
        onSuccess: () => {
          setForm({ ...EMPTY_REOPEN_FORM, scope: form.scope });
          setFilter('');
          setDone(true);
        },
      },
    );
  };
  const problemText = (field: ReopenField): string | undefined => {
    const problem = problems[field];
    return problem === undefined ? undefined : reopenFieldMessage(t, problem, field);
  };

  return (
    <form onSubmit={submit} noValidate aria-label={t('dis.reopen.form.title')} data-testid="reopen-form">
      <SectionCard title={t('dis.reopen.form.title')}>
        <p className="dis-w2-note">{t('dis.reopen.form.approver.hint')}</p>
        {refused === undefined ? null : (
          <p className="dis-w2-banner" role="alert" data-testid="reopen-problem">
            {reopenProblemMessage(t, refused)}
          </p>
        )}
        {done ? (
          <p className="dis-w2-banner dis-w2-banner--info" role="status" data-testid="reopen-done">
            {t('dis.reopen.form.done.notice')}
          </p>
        ) : null}
        <div className="dis-reopen-grid">
          <Field id="reopen-period" label={t('dis.reopen.form.period.label')} error={problemText('periodId')}>
            <select id="reopen-period" value={form.periodId} aria-invalid={problems.periodId !== undefined} onChange={(event) => change({ periodId: event.target.value }, 'periodId')}>
              <option value="">{t('dis.reopen.form.period.placeholder')}</option>
              {choices.map((period) => (
                <option key={period.id} value={period.id}>
                  {t('dis.reopen.form.period.option', { code: period.code, start: period.startDate, end: period.endDate })}
                </option>
              ))}
            </select>
          </Field>
          <Field id="reopen-hours" label={t('dis.reopen.form.hours.label')} error={problemText('windowHours')} hint={t('dis.reopen.form.hours.help', { max: MAX_WINDOW_HOURS })}>
            <input id="reopen-hours" inputMode="numeric" value={form.windowHours} aria-invalid={problems.windowHours !== undefined} onChange={(event) => change({ windowHours: event.target.value }, 'windowHours')} />
          </Field>
        </div>
        <fieldset className="dis-scope">
          <legend>{t('dis.reopen.form.projectScope.label')}</legend>
          {SCOPES.map((scope) => (
            <label key={scope} className="dis-radio">
              <input type="radio" name="reopen-scope" value={scope} checked={form.scope === scope} onChange={() => change({ scope, projectIds: [] }, 'projects')} />
              {reopenScopeLabel(t, scope)}
            </label>
          ))}
          <small className="sub">{forProjects ? t('dis.reopen.form.projectsScope.help') : t('dis.reopen.form.periodScope.help')}</small>
        </fieldset>
        {forProjects ? (
          <fieldset className="dis-projects" aria-invalid={problems.projects !== undefined}>
            <legend>{t('dis.reopen.form.projects.label')}</legend>
            <Field id="reopen-project-filter" label={t('dis.reopen.projects.filter.label')} error={undefined}>
              <input id="reopen-project-filter" type="search" value={filter} onChange={(event) => setFilter(event.target.value)} />
            </Field>
            {projects.isLoading ? <p className="muted">{t('dis.reopen.projects.loading.text')}</p> : null}
            {projects.isError ? (
              <p className="dis-w2-banner" role="alert">
                {t('dis.reopen.projects.error.text')}{' '}
                <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => void projects.refetch()}>
                  {t('dis.reopen.projects.retry.action')}
                </button>
              </p>
            ) : null}
            {projects.isSuccess && shown.length === 0 ? <p className="muted">{t('dis.reopen.projects.empty.text')}</p> : null}
            <ul className="dis-project-list">
              {shown.map((project) => (
                <li key={project.id}>
                  <label className="dis-radio">
                    <input type="checkbox" value={project.id} checked={form.projectIds.includes(project.id)} onChange={(event) => toggle(project.id, event.target.checked)} />
                    <span>{project.code}</span> <small className="sub">{project.name}</small>
                  </label>
                </li>
              ))}
            </ul>
            {problems.projects === undefined ? null : (
              <small role="alert" className="field-error">
                {problemText('projects')}
              </small>
            )}
          </fieldset>
        ) : null}
        <Field id="reopen-reason" label={t('dis.reopen.form.reason.label')} error={problemText('reason')} hint={t('dis.reopen.form.reason.help')}>
          <textarea id="reopen-reason" rows={3} value={form.reason} aria-invalid={problems.reason !== undefined} onChange={(event) => change({ reason: event.target.value }, 'reason')} />
        </Field>
        <StickyActions
          primary={
            <button type="submit" className="ui-button ui-button--primary" disabled={send.isPending}>
              {t('dis.reopen.form.submit.action')}
            </button>
          }
        />
      </SectionCard>
    </form>
  );
}
