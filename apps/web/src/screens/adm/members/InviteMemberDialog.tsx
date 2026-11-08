import { useId, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../../i18n';
import { NavigationDialog } from '../../../shell/NavigationDialog';
import { scopeLabel } from '../roles/labels';
import { useAttemptedCommand } from '../roles/hooks';
import type { CommandExecutor } from '../roles/hooks';
import type { ScopeKind } from '../roles/types';
import { errorMessage, offendingField } from './errors';
import { useGrantableRoles, useRefreshMembers, useUnits } from './hooks';
import { fieldProblemMessage } from './labels';
import { emailProblem, isoOf, nameProblem, staffValidUntilProblem } from './rules';
import type { FieldProblem } from './rules';
import { MAX_NAME_LENGTH } from './types';

/** The multiplication sign on the close button of the dialog. */
const CLOSE_GLYPH = '\u00d7';
const INITIAL_SCOPES: readonly ScopeKind[] = ['UNIT_ONLY', 'UNIT_SUBTREE'];

export interface InviteMemberDialogProps {
  onClose(): void;
  /** The invitation is stored; `email` is the address it was sent to. */
  onInvited(email: string): void;
}

interface InviteBody {
  email: string;
  display_name?: string;
  organization_unit_id: string;
  initial_grants?: Array<{ role_id: string; scope_kind: ScopeKind; scope_ref_ids: string[] }>;
  valid_until?: string;
}

const invite: CommandExecutor<InviteBody> = (client, body, attempt) => client.command('inviteMember', { body, attempt });

type Field = 'email' | 'display_name' | 'organization_unit_id' | 'role_id' | 'valid_until';

/**
 * The invitation of a member of staff (inviteMember). The unit comes from the units the caller may read, the initial
 * role from the roles the caller may hand out; without a role the person receives the default one. Everything else
 * the server still decides and answers with a coded problem that the dialog shows without closing.
 */
export function InviteMemberDialog({ onClose, onInvited }: InviteMemberDialogProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const refresh = useRefreshMembers();
  const units = useUnits(true);
  const roles = useGrantableRoles(true);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [unitId, setUnitId] = useState('');
  const [roleId, setRoleId] = useState('');
  const [scopeKind, setScopeKind] = useState<ScopeKind>('UNIT_ONLY');
  const [until, setUntil] = useState('');
  const [problems, setProblems] = useState<Partial<Record<Field, FieldProblem>>>({});
  // The address that was sent: the field may have been edited while the request was on its way.
  const sentTo = useRef('');
  const command = useAttemptedCommand<InviteBody>(invite, async () => {
    await refresh();
    onInvited(sentTo.current);
  });
  const offered = useMemo(() => (roles.data ?? []).filter((role) => role.status === 'Active'), [roles.data]);
  const invalidField = offendingField(command.error);
  const isInvalid = (field: Field): boolean => problems[field] !== undefined || invalidField === field;
  const edit = <V,>(set: (value: V) => void) => (value: V): void => {
    set(value);
    command.resetAttempt();
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const found: Partial<Record<Field, FieldProblem>> = {};
    const emailIssue = emailProblem(email);
    if (emailIssue !== undefined) found.email = emailIssue;
    const nameIssue = nameProblem(name);
    if (nameIssue !== undefined) found.display_name = nameIssue;
    if (unitId === '') found.organization_unit_id = 'required';
    const untilIssue = staffValidUntilProblem(until, new Date());
    if (untilIssue !== undefined) found.valid_until = untilIssue;
    setProblems(found);
    if (Object.keys(found).length > 0) return;
    const body: InviteBody = { email: email.trim(), organization_unit_id: unitId };
    if (name.trim() !== '') body.display_name = name.trim();
    if (roleId !== '') body.initial_grants = [{ role_id: roleId, scope_kind: scopeKind, scope_ref_ids: [unitId] }];
    const validUntil = isoOf(until);
    if (validUntil !== undefined) body.valid_until = validUntil;
    sentTo.current = body.email;
    void command.run(body);
  };

  const problemOf = (field: Field): JSX.Element | null => {
    const problem = problems[field];
    return problem === undefined ? null : (
      <small role="alert" className="members-error">
        {fieldProblemMessage(t, problem)}
      </small>
    );
  };

  return (
    <NavigationDialog className="catalog command-mode" onClose={onClose}>
      <section className="command-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="command-titlebar">
          <strong id={titleId}>{t('adm.members.invite.dialog.title')}</strong>
          <button type="button" className="icon-button" aria-label={t('adm.members.dialog.close.label')} onClick={onClose}>
            {CLOSE_GLYPH}
          </button>
        </div>
        <form className="members-dialog-body" onSubmit={submit} noValidate>
          <div className="formgrid">
            <div className="field">
              <label htmlFor="invite-email">{t('adm.members.invite.email.label')}</label>
              <input id="invite-email" name="email" type="email" autoComplete="off" value={email} aria-invalid={isInvalid('email')} onChange={(event) => edit(setEmail)(event.target.value)} />
              {problemOf('email')}
            </div>
            <div className="field">
              <label htmlFor="invite-name">{t('adm.members.invite.name.label')}</label>
              <input id="invite-name" name="display_name" maxLength={MAX_NAME_LENGTH} value={name} aria-invalid={isInvalid('display_name')} onChange={(event) => edit(setName)(event.target.value)} />
              {problemOf('display_name')}
            </div>
            <div className="field">
              <label htmlFor="invite-unit">{t('adm.members.invite.unit.label')}</label>
              <select id="invite-unit" name="organization_unit_id" value={unitId} disabled={units.isLoading || units.isError} aria-invalid={isInvalid('organization_unit_id')} onChange={(event) => edit(setUnitId)(event.target.value)}>
                <option value="">{t('adm.members.invite.unit.placeholder')}</option>
                {(units.data ?? []).map((unit) => (
                  <option key={unit.id} value={unit.id}>
                    {unit.name === '' ? unit.code : `${unit.code} · ${unit.name}`}
                  </option>
                ))}
              </select>
              {problemOf('organization_unit_id')}
              {units.isError ? (
                <div className="callout warning" role="alert">
                  {errorMessage(t, units.error)}{' '}
                  <button type="button" onClick={() => void units.refetch()}>
                    {t('adm.members.error.retry.action')}
                  </button>
                </div>
              ) : null}
            </div>
            <div className="field">
              <label htmlFor="invite-until">{t('adm.members.invite.until.label')}</label>
              <input id="invite-until" name="valid_until" type="datetime-local" value={until} aria-invalid={isInvalid('valid_until')} onChange={(event) => edit(setUntil)(event.target.value)} />
              <small>{t('adm.members.invite.until.help')}</small>
              {problemOf('valid_until')}
            </div>
          </div>
          <div className="formgrid">
            <div className="field">
              <label htmlFor="invite-role">{t('adm.members.invite.role.label')}</label>
              <select id="invite-role" name="role_id" value={roleId} disabled={roles.isLoading || roles.isError} onChange={(event) => edit(setRoleId)(event.target.value)}>
                <option value="">{t('adm.members.invite.role.default')}</option>
                {offered.map((role) => (
                  <option key={role.id} value={role.id}>
                    {role.code}
                  </option>
                ))}
              </select>
              {roles.isError ? <small role="status">{t('adm.members.invite.role.unavailable')}</small> : null}
            </div>
            {roleId === '' ? null : (
              <div className="field">
                <label htmlFor="invite-scope">{t('adm.members.invite.scope.label')}</label>
                <select id="invite-scope" name="scope_kind" value={scopeKind} onChange={(event) => edit(setScopeKind)(event.target.value as ScopeKind)}>
                  {INITIAL_SCOPES.map((kind) => (
                    <option key={kind} value={kind}>
                      {scopeLabel(t, kind)}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
          {command.error === undefined ? null : (
            <div className="callout warning" role="alert">
              {errorMessage(t, command.error)}
            </div>
          )}
          <div className="formfooter">
            <button type="button" onClick={onClose}>
              {t('adm.members.dialog.cancel.action')}
            </button>
            <button type="submit" className="primary" disabled={command.pending}>
              {t('adm.members.invite.submit.action')}
            </button>
          </div>
        </form>
      </section>
    </NavigationDialog>
  );
}
