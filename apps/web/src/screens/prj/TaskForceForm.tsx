import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../i18n';
import { useCreateTaskForce } from './accountability-commands';
import { formProblemMessage, problemMessage } from './accountability-labels';
import { EMPTY_TASK_FORCE, describeProblem, taskForceBody, validateTaskForce, vietnamToday } from './accountability-model';
import type { Option, TaskForceForm as TaskForceFormValue } from './accountability-model';
import { Field } from './components';
import './prj.css';

export interface TaskForceFormProps {
  members: readonly Option[];
  units: readonly Option[];
}

/**
 * The foundation of a task force that presses the disbursement of the projects of an area (PRJ-18, ST-PRJ-005): a code, a purpose, a lead and the unit
 * whose subtree is its scope. The lead must have a grant that reaches into that scope; the server judges it and says so when it does not.
 */
export function TaskForceForm({ members, units }: TaskForceFormProps) {
  const { t } = useTranslation();
  const create = useCreateTaskForce();
  const [form, setForm] = useState<TaskForceFormValue>(EMPTY_TASK_FORCE);
  const [submitted, setSubmitted] = useState(false);
  const [saved, setSaved] = useState(false);
  const problems = validateTaskForce(form, vietnamToday());
  const refused = create.isError ? describeProblem(create.error) : undefined;

  const change = (patch: Partial<TaskForceFormValue>): void => {
    setSaved(false);
    setForm({ ...form, ...patch });
  };
  const error = (field: keyof TaskForceFormValue): string | undefined => {
    const problem = problems[field];
    return submitted && problem !== undefined ? formProblemMessage(t, problem) : undefined;
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (create.isPending || Object.keys(problems).length > 0) return;
    create.mutate(taskForceBody(form), {
      onSuccess: () => {
        setForm(EMPTY_TASK_FORCE);
        setSubmitted(false);
        setSaved(true);
      },
    });
  };

  return (
    <form className="card" onSubmit={submit} noValidate aria-label={t('prj.taskforce.create.title')}>
      <h2>{t('prj.taskforce.create.title')}</h2>
      <p className="sub">{t('prj.taskforce.create.help')}</p>
      {refused === undefined ? null : (
        <p className="callout warning" role="alert" data-testid="create-refusal">
          {problemMessage(t, refused)}
        </p>
      )}
      {saved ? (
        <p className="callout" role="status" data-testid="create-saved">
          {t('prj.taskforce.create.saved.notice')}
        </p>
      ) : null}
      <div className="formgrid">
        <Field id="force-code" label={t('prj.taskforce.create.code.label')} error={error('code')}>
          <input id="force-code" value={form.code} onChange={(event) => change({ code: event.target.value })} />
        </Field>
        <Field id="force-name" label={t('prj.taskforce.create.name.label')} error={error('name')}>
          <input id="force-name" value={form.name} onChange={(event) => change({ name: event.target.value })} />
        </Field>
        <Field id="force-purpose" label={t('prj.taskforce.create.purpose.label')} error={error('purpose')}>
          <textarea id="force-purpose" rows={3} value={form.purpose} onChange={(event) => change({ purpose: event.target.value })} />
        </Field>
        <Field id="force-lead" label={t('prj.taskforce.create.lead.label')} error={error('leadId')}>
          <select id="force-lead" value={form.leadId} onChange={(event) => change({ leadId: event.target.value })}>
            <option value="">{t('prj.taskforce.create.choose.option')}</option>
            {members.map((member) => (
              <option key={member.id} value={member.id}>
                {member.label}
              </option>
            ))}
          </select>
        </Field>
        <Field id="force-scope" label={t('prj.taskforce.create.scope.label')} error={error('scopeUnitId')} hint={t('prj.taskforce.create.scope.help')}>
          <select id="force-scope" value={form.scopeUnitId} onChange={(event) => change({ scopeUnitId: event.target.value })}>
            <option value="">{t('prj.taskforce.create.choose.option')}</option>
            {units.map((unit) => (
              <option key={unit.id} value={unit.id}>
                {unit.label}
              </option>
            ))}
          </select>
        </Field>
        <Field id="force-from" label={t('prj.taskforce.create.from.label')} error={error('validFrom')}>
          <input id="force-from" type="date" value={form.validFrom} onChange={(event) => change({ validFrom: event.target.value })} />
        </Field>
        <Field id="force-document" label={t('prj.taskforce.create.document.label')} error={error('documentId')} hint={t('prj.taskforce.create.document.help')}>
          <input id="force-document" value={form.documentId} onChange={(event) => change({ documentId: event.target.value })} />
        </Field>
      </div>
      <div className="formfooter">
        <button type="submit" className="primary" disabled={create.isPending}>
          {create.isPending ? t('prj.taskforce.create.submit.pending') : t('prj.taskforce.create.submit.action')}
        </button>
      </div>
    </form>
  );
}
