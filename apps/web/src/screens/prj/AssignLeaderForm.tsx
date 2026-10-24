import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../i18n';
import { useAssignLeader } from './accountability-commands';
import { formProblemMessage, problemMessage, roleLabel } from './accountability-labels';
import { ACCOUNTABILITY_ROLES, EMPTY_ASSIGN, assignBody, describeProblem, validateAssign, vietnamToday } from './accountability-model';
import type { AssignForm, Option } from './accountability-model';
import { Field } from './components';
import './prj.css';

export interface AssignLeaderFormProps {
  projects: readonly Option[];
  members: readonly Option[];
}

/**
 * The assignment of a leader in charge, a deputy or a focal officer to a project (PRJ-17, ST-PRJ-005). The form checks what it can before anything is
 * sent; the server judges the rest (one leader in charge at a time, a person who can read the project) and its refusal is told in words.
 */
export function AssignLeaderForm({ projects, members }: AssignLeaderFormProps) {
  const { t } = useTranslation();
  const assign = useAssignLeader();
  const [form, setForm] = useState<AssignForm>(EMPTY_ASSIGN);
  const [submitted, setSubmitted] = useState(false);
  const [saved, setSaved] = useState(false);
  const problems = validateAssign(form, vietnamToday());
  const refused = assign.isError ? describeProblem(assign.error) : undefined;

  const change = (patch: Partial<AssignForm>): void => {
    setSaved(false);
    setForm({ ...form, ...patch });
  };
  const error = (field: keyof AssignForm): string | undefined => {
    const problem = problems[field];
    return submitted && problem !== undefined ? formProblemMessage(t, problem) : undefined;
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (assign.isPending || Object.keys(problems).length > 0) return;
    assign.mutate(
      { projectId: form.projectId, body: assignBody(form) },
      {
        onSuccess: () => {
          setForm(EMPTY_ASSIGN);
          setSubmitted(false);
          setSaved(true);
        },
      },
    );
  };

  return (
    <form className="card" onSubmit={submit} noValidate aria-label={t('prj.accountability.assign.title')}>
      <h2>{t('prj.accountability.assign.title')}</h2>
      <p className="sub">{t('prj.accountability.assign.help')}</p>
      {refused === undefined ? null : (
        <p className="callout warning" role="alert" data-testid="assign-refusal">
          {problemMessage(t, refused)}
        </p>
      )}
      {saved ? (
        <p className="callout" role="status" data-testid="assign-saved">
          {t('prj.accountability.assign.saved.notice')}
        </p>
      ) : null}
      <div className="formgrid">
        <Field id="assign-project" label={t('prj.accountability.assign.project.label')} error={error('projectId')}>
          <select id="assign-project" value={form.projectId} onChange={(event) => change({ projectId: event.target.value })}>
            <option value="">{t('prj.accountability.assign.choose.option')}</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.label}
              </option>
            ))}
          </select>
        </Field>
        <Field id="assign-leader" label={t('prj.accountability.assign.leader.label')} error={error('leaderId')}>
          <select id="assign-leader" value={form.leaderId} onChange={(event) => change({ leaderId: event.target.value })}>
            <option value="">{t('prj.accountability.assign.choose.option')}</option>
            {members.map((member) => (
              <option key={member.id} value={member.id}>
                {member.label}
              </option>
            ))}
          </select>
        </Field>
        <Field id="assign-role" label={t('prj.accountability.assign.role.label')} error={error('role')}>
          <select id="assign-role" value={form.role} onChange={(event) => change({ role: event.target.value })}>
            {ACCOUNTABILITY_ROLES.map((role) => (
              <option key={role} value={role}>
                {roleLabel(t, role)}
              </option>
            ))}
          </select>
        </Field>
        <Field id="assign-from" label={t('prj.accountability.assign.from.label')} error={error('validFrom')}>
          <input id="assign-from" type="date" value={form.validFrom} onChange={(event) => change({ validFrom: event.target.value })} />
        </Field>
        <Field id="assign-document" label={t('prj.accountability.assign.document.label')} error={error('documentId')} hint={t('prj.accountability.assign.document.help')}>
          <input id="assign-document" value={form.documentId} onChange={(event) => change({ documentId: event.target.value })} />
        </Field>
      </div>
      <div className="formfooter">
        <button type="submit" className="primary" disabled={assign.isPending}>
          {assign.isPending ? t('prj.accountability.assign.submit.pending') : t('prj.accountability.assign.submit.action')}
        </button>
      </div>
    </form>
  );
}
