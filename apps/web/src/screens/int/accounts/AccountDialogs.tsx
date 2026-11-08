import { useState } from 'react';
import { useTranslation } from '../../../i18n';
import type { Translator } from '../../../i18n';
import { CommandDialog } from '../int-common';
import { useCreateAccount, useDecideAccount, useRotateAccount, useUpdateAccount } from '../int-hooks';
import type { MachineAccount, MachineAccountPage } from '../int-model';
import type { Problem } from '../int-model';
import { dayText } from '../int-model';
import { scopeLabel } from './account-labels';

type T = Translator['t'];

export type AccountDialog =
  | { kind: 'create' }
  | { kind: 'update'; account: MachineAccount }
  | { kind: 'decide'; account: MachineAccount; decision: 'SUSPEND' | 'REACTIVATE' | 'REVOKE' }
  | { kind: 'rotate'; account: MachineAccount };

/** What a command of this screen gives back to the screen: a receipt in words, or the secret the server showed once. */
export type AccountOutcome = { kind: 'receipt'; text: string } | { kind: 'secret'; title: 'created' | 'rotated'; accountName: string; clientId: string; clientSecret: string; tokenUrl: string };

export interface AccountDialogsProps {
  dialog: AccountDialog | undefined;
  page: MachineAccountPage | undefined;
  onClose: () => void;
  onDone: (outcome: AccountOutcome) => void;
}

const contextOf = (t: T, account: MachineAccount): { label: string; value: string }[] => [
  { label: t('int.accounts.column.name'), value: account.name },
  { label: t('int.accounts.column.status'), value: account.status },
  { label: t('int.accounts.column.scopes'), value: account.scopes.join(', ') },
  { label: t('int.accounts.column.expires'), value: account.expires_on === null ? t('int.accounts.cell.unlimited') : dayText(account.expires_on) },
];

/** The dialogs of the commands of INT-01: each names the account and the effect, asks the reason (but for opening one), locks while it sends and says in place why it was refused. */
export function AccountDialogs({ dialog, page, onClose, onDone }: AccountDialogsProps) {
  if (dialog === undefined) return null;
  if (dialog.kind === 'create') return <CreateDialog page={page} onClose={onClose} onDone={onDone} />;
  if (dialog.kind === 'update') return <UpdateDialog key={dialog.account.id} account={dialog.account} page={page} onClose={onClose} onDone={onDone} />;
  if (dialog.kind === 'rotate') return <RotateDialog key={dialog.account.id} account={dialog.account} onClose={onClose} onDone={onDone} />;
  return <DecideDialog key={`${dialog.account.id}:${dialog.decision}`} account={dialog.account} decision={dialog.decision} onClose={onClose} onDone={onDone} />;
}

interface FormState {
  name: string;
  description: string;
  scopes: string[];
  rate: string;
  expires: string;
}

type Errors = Partial<Record<'name' | 'scopes' | 'rate' | 'expires', true>>;

function judge(form: FormState, page: MachineAccountPage | undefined): Errors {
  const errors: Errors = {};
  const min = page?.rate_limit.min ?? 1;
  const max = page?.rate_limit.max ?? 6000;
  if (form.name.trim() === '' || form.name.trim().length > 120) errors.name = true;
  if (form.scopes.length === 0) errors.scopes = true;
  if (form.rate.trim() !== '' && (!/^\d+$/.test(form.rate.trim()) || Number(form.rate) < min || Number(form.rate) > max)) errors.rate = true;
  if (form.expires.trim() !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(form.expires.trim())) errors.expires = true;
  return errors;
}

function ScopeChoice({ page, chosen, onChange, error }: { page: MachineAccountPage | undefined; chosen: string[]; onChange: (next: string[]) => void; error: boolean }) {
  const { t } = useTranslation();
  return (
    <fieldset className="int-scope-list">
      <legend>{t('int.accounts.field.scopes.label')}</legend>
      {(page?.scopes ?? []).map((scope) => (
        <label key={scope.code} className="int-scope-option">
          <input type="checkbox" checked={chosen.includes(scope.code)} onChange={(event) => onChange(event.target.checked ? [...chosen, scope.code].sort() : chosen.filter((code) => code !== scope.code))} />
          <span>
            {scopeLabel(t, scope.code)} <small className="sub">{scope.code}</small>
          </span>
        </label>
      ))}
      {error && (
        <span className="int-error" role="alert">
          {t('int.accounts.error.scopes')}
        </span>
      )}
    </fieldset>
  );
}

function Fields({ form, errors, page, onChange, withName }: { form: FormState; errors: Errors; page: MachineAccountPage | undefined; onChange: (next: FormState) => void; withName: boolean }) {
  const { t } = useTranslation();
  const set = (patch: Partial<FormState>): void => onChange({ ...form, ...patch });
  return (
    <div className="int-form">
      {withName && (
        <div className="field">
          <label htmlFor="int-account-name">{t('int.accounts.field.name.label')}</label>
          <input id="int-account-name" value={form.name} maxLength={120} aria-invalid={errors.name === true} onChange={(event) => set({ name: event.target.value })} />
          {errors.name === true && (
            <span className="int-error" role="alert">
              {t('int.accounts.error.name')}
            </span>
          )}
        </div>
      )}
      <div className="field">
        <label htmlFor="int-account-description">{t('int.accounts.field.description.label')}</label>
        <input id="int-account-description" value={form.description} maxLength={1000} onChange={(event) => set({ description: event.target.value })} />
      </div>
      <ScopeChoice page={page} chosen={form.scopes} onChange={(scopes) => set({ scopes })} error={errors.scopes === true} />
      <div className="field">
        <label htmlFor="int-account-rate">{t('int.accounts.field.rate.label', { min: page?.rate_limit.min ?? 1, max: page?.rate_limit.max ?? 6000 })}</label>
        <input id="int-account-rate" inputMode="numeric" value={form.rate} aria-invalid={errors.rate === true} onChange={(event) => set({ rate: event.target.value })} />
        {errors.rate === true && (
          <span className="int-error" role="alert">
            {t('int.accounts.error.rate', { min: page?.rate_limit.min ?? 1, max: page?.rate_limit.max ?? 6000 })}
          </span>
        )}
      </div>
      <div className="field">
        <label htmlFor="int-account-expires">{t('int.accounts.field.expires.label')}</label>
        <input id="int-account-expires" type="date" value={form.expires} aria-invalid={errors.expires === true} onChange={(event) => set({ expires: event.target.value })} />
        {errors.expires === true && (
          <span className="int-error" role="alert">
            {t('int.accounts.error.expires')}
          </span>
        )}
      </div>
    </div>
  );
}

function CreateDialog({ page, onClose, onDone }: { page: MachineAccountPage | undefined; onClose: () => void; onDone: (outcome: AccountOutcome) => void }) {
  const { t } = useTranslation();
  const create = useCreateAccount();
  const [form, setForm] = useState<FormState>({ name: '', description: '', scopes: [], rate: '', expires: '' });
  const [errors, setErrors] = useState<Errors>({});
  const onProblem = (problem: Problem): void => {
    if (problem.kind === 'nameTaken') setErrors({ name: true });
    else if (problem.kind === 'validation' && (problem.field === 'name' || problem.field === 'scopes' || problem.field === 'expires_on' || problem.field === 'rate_limit_per_minute')) {
      setErrors({ ...(problem.field === 'name' ? { name: true } : {}), ...(problem.field === 'scopes' ? { scopes: true } : {}), ...(problem.field === 'expires_on' ? { expires: true } : {}), ...(problem.field === 'rate_limit_per_minute' ? { rate: true } : {}) });
    }
  };
  return (
    <CommandDialog
      title={t('int.accounts.create.title')}
      context={[]}
      confirmLabel={t('int.accounts.create.confirm.action')}
      effect={t('int.accounts.create.effect')}
      reason={false}
      valid={() => {
        const found = judge(form, page);
        setErrors(found);
        return Object.keys(found).length === 0;
      }}
      run={() =>
        create.mutateAsync({
          name: form.name.trim(),
          ...(form.description.trim() === '' ? {} : { description: form.description.trim() }),
          scopes: form.scopes,
          ...(form.rate.trim() === '' ? {} : { rate_limit_per_minute: Number(form.rate) }),
          ...(form.expires === '' ? {} : { expires_on: form.expires }),
        })
      }
      onProblem={onProblem}
      onDone={(answer) => onDone({ kind: 'secret', title: 'created', accountName: form.name.trim(), clientId: answer.client_id, clientSecret: answer.client_secret, tokenUrl: answer.token_url })}
      onClose={onClose}
    >
      <Fields form={form} errors={errors} page={page} onChange={setForm} withName />
    </CommandDialog>
  );
}

function UpdateDialog({ account, page, onClose, onDone }: { account: MachineAccount; page: MachineAccountPage | undefined; onClose: () => void; onDone: (outcome: AccountOutcome) => void }) {
  const { t } = useTranslation();
  const update = useUpdateAccount();
  const [form, setForm] = useState<FormState>({ name: account.name, description: account.description ?? '', scopes: [...account.scopes], rate: String(account.rate_limit_per_minute), expires: account.expires_on ?? '' });
  const [errors, setErrors] = useState<Errors>({});
  return (
    <CommandDialog
      title={t('int.accounts.update.title')}
      context={contextOf(t, account)}
      confirmLabel={t('int.accounts.update.confirm.action')}
      effect={t('int.accounts.update.effect')}
      valid={() => {
        const found = judge(form, page);
        setErrors(found);
        return Object.keys(found).length === 0;
      }}
      run={(reason) =>
        update.mutateAsync({
          id: account.id,
          version: account.version,
          body: {
            description: form.description.trim() === '' ? null : form.description.trim(),
            scopes: form.scopes,
            rate_limit_per_minute: Number(form.rate),
            expires_on: form.expires === '' ? null : form.expires,
            reason,
          },
        })
      }
      onDone={() => onDone({ kind: 'receipt', text: t('int.accounts.success.updated', { name: account.name }) })}
      onClose={onClose}
    >
      <Fields form={form} errors={errors} page={page} onChange={setForm} withName={false} />
    </CommandDialog>
  );
}

function DecideDialog({ account, decision, onClose, onDone }: { account: MachineAccount; decision: 'SUSPEND' | 'REACTIVATE' | 'REVOKE'; onClose: () => void; onDone: (outcome: AccountOutcome) => void }) {
  const { t } = useTranslation();
  const decide = useDecideAccount();
  const text = {
    SUSPEND: { title: t('int.accounts.suspend.title'), confirm: t('int.accounts.suspend.confirm.action'), effect: t('int.accounts.suspend.effect'), done: t('int.accounts.success.suspended', { name: account.name }) },
    REACTIVATE: { title: t('int.accounts.reactivate.title'), confirm: t('int.accounts.reactivate.confirm.action'), effect: t('int.accounts.reactivate.effect'), done: t('int.accounts.success.reactivated', { name: account.name }) },
    REVOKE: { title: t('int.accounts.revoke.title'), confirm: t('int.accounts.revoke.confirm.action'), effect: t('int.accounts.revoke.effect'), done: t('int.accounts.success.revoked', { name: account.name }) },
  }[decision];
  return (
    <CommandDialog
      title={text.title}
      context={contextOf(t, account)}
      confirmLabel={text.confirm}
      effect={text.effect}
      run={(reason) => decide.mutateAsync({ id: account.id, version: account.version, decision, reason })}
      onDone={() => onDone({ kind: 'receipt', text: text.done })}
      onClose={onClose}
    />
  );
}

function RotateDialog({ account, onClose, onDone }: { account: MachineAccount; onClose: () => void; onDone: (outcome: AccountOutcome) => void }) {
  const { t } = useTranslation();
  const rotate = useRotateAccount();
  const [grace, setGrace] = useState('24');
  const [invalid, setInvalid] = useState(false);
  return (
    <CommandDialog
      title={t('int.accounts.rotate.title')}
      context={contextOf(t, account)}
      confirmLabel={t('int.accounts.rotate.confirm.action')}
      effect={t('int.accounts.rotate.effect')}
      valid={() => {
        const bad = !/^\d+$/.test(grace.trim()) || Number(grace) > 72;
        setInvalid(bad);
        return !bad;
      }}
      run={(reason) => rotate.mutateAsync({ id: account.id, version: account.version, reason, graceHours: Number(grace) })}
      onDone={(answer) => onDone({ kind: 'secret', title: 'rotated', accountName: account.name, clientId: answer.client_id, clientSecret: answer.client_secret, tokenUrl: answer.token_url })}
      onClose={onClose}
    >
      <div className="field">
        <label htmlFor="int-rotate-grace">{t('int.accounts.field.grace.label')}</label>
        <input id="int-rotate-grace" inputMode="numeric" value={grace} aria-invalid={invalid} onChange={(event) => setGrace(event.target.value)} />
        {invalid && (
          <span className="int-error" role="alert">
            {t('int.accounts.error.grace')}
          </span>
        )}
      </div>
    </CommandDialog>
  );
}
