import { useId, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../../i18n';
import { NavigationDialog } from '../../../shell/NavigationDialog';
import { useAttemptedCommand } from '../roles/hooks';
import type { CommandExecutor } from '../roles/hooks';
import { errorMessage, offendingField } from './errors';
import { useContracts, useGrantableRoles, useRefreshMembers } from './hooks';
import { fieldProblemMessage } from './labels';
import { contractsProblem, emailProblem, guestMaxUntil, guestValidUntilProblem, isoOf, localInputOf } from './rules';
import type { FieldProblem } from './rules';
import { GUEST_CONTRACT_STATUSES } from './types';
import type { ContractOption } from './types';

/** The multiplication sign on the close button of the dialog. */
const CLOSE_GLYPH = '\u00d7';

export interface InviteGuestDialogProps {
  onClose(): void;
  /** The invitation is stored; `email` is the address it was sent to. */
  onInvited(email: string): void;
}

interface GuestBody {
  email: string;
  contractor_id: string;
  contract_ids: string[];
  role_id: string;
  valid_until: string;
}

const inviteGuest: CommandExecutor<GuestBody> = (client, body, attempt) => client.command('inviteGuestContractor', { body, attempt });

type Field = 'email' | 'contractor_id' | 'contract_ids' | 'role_id' | 'valid_until';

/** The contractors that have a contract a guest may be given, each once, in the order of their names. */
function contractorsOf(contracts: readonly ContractOption[]): Array<{ id: string; name: string }> {
  const seen = new Map<string, string>();
  for (const contract of contracts) seen.set(contract.contractorId, contract.contractorName);
  return [...seen].map(([id, name]) => ({ id, name })).sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * The invitation of a guest of a contractor (inviteGuestContractor, ST-ADM-007): the contracts offered are those the
 * caller reaches that are in force, of one contractor; the role is one that guests may hold; the access ends at a
 * date that is required and bounded by the contracts (BR-IAM-08). The server decides everything again and answers with
 * a coded problem that the dialog shows without closing.
 */
export function InviteGuestDialog({ onClose, onInvited }: InviteGuestDialogProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const refresh = useRefreshMembers();
  const contracts = useContracts(true);
  const roles = useGrantableRoles(true);
  const [email, setEmail] = useState('');
  const [contractorId, setContractorId] = useState('');
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [roleId, setRoleId] = useState('');
  const [until, setUntil] = useState('');
  const [problems, setProblems] = useState<Partial<Record<Field, FieldProblem>>>({});
  // The address that was sent: the field may have been edited while the request was on its way.
  const sentTo = useRef('');
  const command = useAttemptedCommand<GuestBody>(inviteGuest, async () => {
    await refresh();
    onInvited(sentTo.current);
  });

  const eligible = useMemo(() => (contracts.data ?? []).filter((contract) => GUEST_CONTRACT_STATUSES.includes(contract.status)), [contracts.data]);
  const contractors = useMemo(() => contractorsOf(eligible), [eligible]);
  const ofContractor = useMemo(() => eligible.filter((contract) => contract.contractorId === contractorId), [eligible, contractorId]);
  const chosen = useMemo(() => ofContractor.filter((contract) => selected.includes(contract.id)), [ofContractor, selected]);
  const guestRoles = useMemo(() => (roles.data ?? []).filter((role) => role.status === 'Active' && role.guest_allowed), [roles.data]);
  const maxUntil = localInputOf(guestMaxUntil(chosen, new Date()));
  const invalidField = offendingField(command.error);
  const isInvalid = (field: Field): boolean => problems[field] !== undefined || invalidField === field;
  const edit = <V,>(set: (value: V) => void) => (value: V): void => {
    set(value);
    command.resetAttempt();
  };

  const changeContractor = (next: string): void => {
    setContractorId(next);
    // Contracts of the previous contractor must never ride along with the new one.
    setSelected([]);
    command.resetAttempt();
  };

  const toggle = (contractId: string): void => {
    setSelected((current) => (current.includes(contractId) ? current.filter((candidate) => candidate !== contractId) : [...current, contractId]));
    command.resetAttempt();
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const found: Partial<Record<Field, FieldProblem>> = {};
    const emailIssue = emailProblem(email);
    if (emailIssue !== undefined) found.email = emailIssue;
    if (contractorId === '') found.contractor_id = 'required';
    const contractsIssue = contractsProblem(chosen.map((contract) => contract.id));
    if (contractsIssue !== undefined) found.contract_ids = contractsIssue;
    if (!guestRoles.some((role) => role.id === roleId)) found.role_id = 'required';
    const untilIssue = guestValidUntilProblem(until, chosen, new Date());
    if (untilIssue !== undefined) found.valid_until = untilIssue;
    setProblems(found);
    if (Object.keys(found).length > 0) return;
    sentTo.current = email.trim();
    void command.run({
      email: email.trim(),
      contractor_id: contractorId,
      contract_ids: chosen.map((contract) => contract.id),
      role_id: roleId,
      valid_until: isoOf(until) ?? '',
    });
  };

  const problemOf = (field: Field): JSX.Element | null => {
    const problem = problems[field];
    return problem === undefined ? null : (
      <small role="alert" className="members-error">
        {fieldProblemMessage(t, problem, maxUntil.replace('T', ' '))}
      </small>
    );
  };

  return (
    <NavigationDialog className="catalog command-mode" onClose={onClose}>
      <section className="command-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="command-titlebar">
          <strong id={titleId}>{t('adm.guests.invite.dialog.title')}</strong>
          <button type="button" className="icon-button" aria-label={t('adm.members.dialog.close.label')} onClick={onClose}>
            {CLOSE_GLYPH}
          </button>
        </div>
        <form className="members-dialog-body" onSubmit={submit} noValidate>
          <div className="formgrid">
            <div className="field">
              <label htmlFor="guest-email">{t('adm.members.invite.email.label')}</label>
              <input id="guest-email" name="email" type="email" autoComplete="off" value={email} aria-invalid={isInvalid('email')} onChange={(event) => edit(setEmail)(event.target.value)} />
              {problemOf('email')}
            </div>
            <div className="field">
              <label htmlFor="guest-contractor">{t('adm.guests.invite.contractor.label')}</label>
              <select
                id="guest-contractor"
                name="contractor_id"
                value={contractorId}
                disabled={contracts.isLoading || contracts.isError}
                aria-invalid={isInvalid('contractor_id')}
                onChange={(event) => changeContractor(event.target.value)}
              >
                <option value="">{t('adm.guests.invite.contractor.placeholder')}</option>
                {contractors.map((contractor) => (
                  <option key={contractor.id} value={contractor.id}>
                    {contractor.name}
                  </option>
                ))}
              </select>
              {problemOf('contractor_id')}
              {contracts.isError ? (
                <div className="callout warning" role="alert">
                  {errorMessage(t, contracts.error)}{' '}
                  <button type="button" onClick={() => void contracts.refetch()}>
                    {t('adm.members.error.retry.action')}
                  </button>
                </div>
              ) : null}
              {!contracts.isLoading && !contracts.isError && contractors.length === 0 ? <small role="status">{t('adm.guests.invite.contracts.none')}</small> : null}
            </div>
          </div>
          <fieldset className="members-contracts" aria-invalid={isInvalid('contract_ids')}>
            <legend>{t('adm.guests.invite.contracts.label')}</legend>
            {contractorId === '' ? <small>{t('adm.guests.invite.contracts.pick')}</small> : null}
            {ofContractor.map((contract) => (
              <label key={contract.id} className="check">
                <input type="checkbox" checked={selected.includes(contract.id)} onChange={() => toggle(contract.id)} />
                {contract.code}
                <small>{contract.completionDue === null ? t('adm.guests.invite.contract.open') : t('adm.guests.invite.contract.ends', { date: contract.completionDue })}</small>
              </label>
            ))}
          </fieldset>
          {problemOf('contract_ids')}
          <div className="formgrid">
            <div className="field">
              <label htmlFor="guest-role">{t('adm.guests.invite.role.label')}</label>
              <select id="guest-role" name="role_id" value={roleId} disabled={roles.isLoading || roles.isError} aria-invalid={isInvalid('role_id')} onChange={(event) => edit(setRoleId)(event.target.value)}>
                <option value="">{t('adm.guests.invite.role.placeholder')}</option>
                {guestRoles.map((role) => (
                  <option key={role.id} value={role.id}>
                    {role.code}
                  </option>
                ))}
              </select>
              {problemOf('role_id')}
              {roles.isError ? (
                <div className="callout warning" role="alert">
                  {errorMessage(t, roles.error)}{' '}
                  <button type="button" onClick={() => void roles.refetch()}>
                    {t('adm.members.error.retry.action')}
                  </button>
                </div>
              ) : null}
            </div>
            <div className="field">
              <label htmlFor="guest-until">{t('adm.guests.invite.until.label')}</label>
              <input id="guest-until" name="valid_until" type="datetime-local" max={maxUntil} value={until} aria-invalid={isInvalid('valid_until')} onChange={(event) => edit(setUntil)(event.target.value)} />
              <small>{t('adm.guests.invite.until.help', { max: maxUntil.replace('T', ' ') })}</small>
              {problemOf('valid_until')}
            </div>
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
              {t('adm.guests.invite.submit.action')}
            </button>
          </div>
        </form>
      </section>
    </NavigationDialog>
  );
}
