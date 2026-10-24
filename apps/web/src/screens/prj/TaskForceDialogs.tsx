import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../i18n';
import { NavigationDialog } from '../../shell/NavigationDialog';
import { useAddTaskForceMember, useDissolveTaskForce } from './accountability-commands';
import { formProblemMessage, memberRoleLabel, problemMessage } from './accountability-labels';
import { EMPTY_DISSOLVE, EMPTY_MEMBER, MEMBER_ROLES, describeProblem, memberBody, openMembers, validateDissolve, validateMember, vietnamToday } from './accountability-model';
import type { DissolveForm, MemberForm, Option, TaskForceLine } from './accountability-model';
import { Field } from './components';
import './prj.css';

/** The multiplication sign on the close button of the dialog. */
const CLOSE_GLYPH = '×';

export interface AddMemberDialogProps {
  force: TaskForceLine;
  members: readonly Option[];
  projects: readonly Option[];
  onClose(): void;
}

/**
 * Seats a member in a task force, for a term from a day on, optionally to follow one project (PRJ-18). The member must have a grant that reaches into
 * the scope of the force and the project must lie in it; the server judges both and the dialog tells the refusal.
 */
export function AddMemberDialog({ force, members, projects, onClose }: AddMemberDialogProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const add = useAddTaskForceMember();
  const [form, setForm] = useState<MemberForm>(EMPTY_MEMBER);
  const [submitted, setSubmitted] = useState(false);
  const problems = validateMember(form, vietnamToday(), force.validFrom);
  const refused = add.isError ? describeProblem(add.error) : undefined;
  const error = (field: keyof MemberForm): string | undefined => {
    const problem = problems[field];
    return submitted && problem !== undefined ? formProblemMessage(t, problem) : undefined;
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (add.isPending || Object.keys(problems).length > 0) return;
    add.mutate({ id: force.id, body: memberBody(form) }, { onSuccess: onClose });
  };

  return (
    <NavigationDialog className="catalog command-mode" onClose={onClose}>
      <section className="command-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="command-titlebar">
          <strong id={titleId}>{t('prj.taskforce.member.title', { code: force.code })}</strong>
          <button type="button" className="icon-button" aria-label={t('prj.taskforce.member.close.label')} onClick={onClose}>
            {CLOSE_GLYPH}
          </button>
        </div>
        <div className="prj-dialog-body">
          <form onSubmit={submit} noValidate>
            <p>{t('prj.taskforce.member.scope.text', { unit: force.scopeUnitName })}</p>
            {refused === undefined ? null : (
              <p className="callout warning" role="alert" data-testid="member-refusal">
                {problemMessage(t, refused)}
              </p>
            )}
            <div className="formgrid">
              <Field id="member-person" label={t('prj.taskforce.member.person.label')} error={error('membershipId')}>
                <select id="member-person" value={form.membershipId} onChange={(event) => setForm({ ...form, membershipId: event.target.value })}>
                  <option value="">{t('prj.taskforce.member.choose.option')}</option>
                  {members.map((member) => (
                    <option key={member.id} value={member.id}>
                      {member.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field id="member-role" label={t('prj.taskforce.member.role.label')} error={error('role')}>
                <select id="member-role" value={form.role} onChange={(event) => setForm({ ...form, role: event.target.value })}>
                  {MEMBER_ROLES.map((role) => (
                    <option key={role} value={role}>
                      {memberRoleLabel(t, role)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field id="member-project" label={t('prj.taskforce.member.project.label')} error={error('projectId')} hint={t('prj.taskforce.member.project.help')}>
                <select id="member-project" value={form.projectId} onChange={(event) => setForm({ ...form, projectId: event.target.value })}>
                  <option value="">{t('prj.taskforce.member.project.none')}</option>
                  {projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field id="member-from" label={t('prj.taskforce.member.from.label')} error={error('validFrom')}>
                <input id="member-from" type="date" value={form.validFrom} onChange={(event) => setForm({ ...form, validFrom: event.target.value })} />
              </Field>
            </div>
            <div className="formfooter">
              <button type="button" onClick={onClose}>
                {t('prj.taskforce.member.cancel.action')}
              </button>
              <button type="submit" className="primary" disabled={add.isPending}>
                {add.isPending ? t('prj.taskforce.member.submit.pending') : t('prj.taskforce.member.submit.action')}
              </button>
            </div>
          </form>
        </div>
      </section>
    </NavigationDialog>
  );
}

export interface DissolveDialogProps {
  force: TaskForceLine;
  onClose(): void;
}

/** Dissolves a task force with a reason (PRJ-18): every open term ends with it, in one transaction; the dialog says how many. */
export function DissolveDialog({ force, onClose }: DissolveDialogProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const dissolve = useDissolveTaskForce();
  const [form, setForm] = useState<DissolveForm>(EMPTY_DISSOLVE);
  const [submitted, setSubmitted] = useState(false);
  const problems = validateDissolve(form);
  const refused = dissolve.isError ? describeProblem(dissolve.error) : undefined;
  const reasonProblem = submitted ? problems.reason : undefined;

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (dissolve.isPending || problems.reason !== undefined) return;
    dissolve.mutate({ id: force.id, version: force.version, reason: form.reason.trim() }, { onSuccess: onClose });
  };

  return (
    <NavigationDialog className="catalog command-mode" onClose={onClose}>
      <section className="command-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="command-titlebar">
          <strong id={titleId}>{t('prj.taskforce.dissolve.title', { code: force.code })}</strong>
          <button type="button" className="icon-button" aria-label={t('prj.taskforce.dissolve.close.label')} onClick={onClose}>
            {CLOSE_GLYPH}
          </button>
        </div>
        <div className="prj-dialog-body">
          <form onSubmit={submit} noValidate>
            <p className="callout" data-testid="dissolve-warning">
              {t('prj.taskforce.dissolve.warning.text', { count: openMembers(force).length })}
            </p>
            {refused === undefined ? null : (
              <p className="callout warning" role="alert" data-testid="dissolve-refusal">
                {problemMessage(t, refused)}
              </p>
            )}
            <div className="formgrid">
              <Field id="dissolve-reason" label={t('prj.taskforce.dissolve.reason.label')} error={reasonProblem === undefined ? undefined : formProblemMessage(t, reasonProblem)}>
                <textarea id="dissolve-reason" rows={3} value={form.reason} onChange={(event) => setForm({ reason: event.target.value })} />
              </Field>
            </div>
            <div className="formfooter">
              <button type="button" onClick={onClose}>
                {t('prj.taskforce.dissolve.cancel.action')}
              </button>
              <button type="submit" className="primary" disabled={dissolve.isPending}>
                {dissolve.isPending ? t('prj.taskforce.dissolve.submit.pending') : t('prj.taskforce.dissolve.submit.action')}
              </button>
            </div>
          </form>
        </div>
      </section>
    </NavigationDialog>
  );
}
