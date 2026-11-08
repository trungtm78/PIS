import { useTranslation } from '../../../i18n';
import { CommandDialog, reasonField } from '../shared/vnd-form';
import type { FieldSpec } from '../shared/vnd-form';
import { useVendorCommand } from '../shared/vnd-hooks';
import { callbackOutcomeLabel, changeStepLabel } from '../shared/vnd-labels';
import { maskedAccount } from '../shared/vnd-model';
import type { Account, PayeeChange } from '../shared/vnd-model';

interface DialogProps {
  onClose: () => void;
  onDone: () => void;
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/**
 * The request to change the account a contractor is paid on. The number is asked here and nowhere else: a text field that the browser does not remember (no autocomplete), cleared when the dialog closes, never put in a
 * query, a log or the page. The holder must be the legal name of the contractor (the server checks it and refuses a mismatch), and the contractor's own letter is the evidence.
 */
export function RequestChangeDialog({ contractorId, contractorName, onClose, onDone }: DialogProps & { contractorId: string; contractorName: string }) {
  const { t } = useTranslation();
  const command = useVendorCommand('requestVendorPayeeChange');
  const fields: FieldSpec[] = [
    { name: 'bank_name', label: t('vnd.payee.field.bank.label'), kind: 'text', required: true, min: 2, max: 200 },
    { name: 'account_holder', label: t('vnd.payee.field.holder.label'), kind: 'text', required: true, min: 2, max: 300, hint: t('vnd.payee.field.holder.hint') },
    { name: 'account_number', label: t('vnd.payee.field.number.label'), kind: 'text', required: true, min: 6, max: 40, autoComplete: 'off', hint: t('vnd.payee.field.number.hint') },
    { name: 'reason', label: t('vnd.payee.field.reason.label'), kind: 'textarea', required: true, min: 10, max: 500, hint: t('vnd.field.reason.hint', { count: 10 }) },
    { name: 'evidence_document_id', label: t('vnd.payee.field.evidence.label'), kind: 'uuid', required: true, hint: t('vnd.payee.field.evidence.hint') },
  ];
  return (
    <CommandDialog
      title={t('vnd.payee.request.title')}
      context={[{ label: t('vnd.payee.request.context.contractor'), value: contractorName }]}
      note={<p className="vnd-note">{t('vnd.payee.request.note')}</p>}
      confirmLabel={t('vnd.payee.request.confirm')}
      fields={fields}
      run={(values) =>
        command.mutateAsync({
          path: { id: contractorId },
          body: {
            bank_name: text(values.bank_name),
            account_holder: text(values.account_holder),
            account_number: text(values.account_number),
            reason: text(values.reason),
            evidence_document_id: text(values.evidence_document_id),
          },
        })
      }
      onClose={onClose}
      onDone={onDone}
    />
  );
}

/** One of the two matching steps. The person who requested the change cannot approve it, and the two steps are two people: the server refuses the same person twice (403 SELF_APPROVAL_DENIED). */
export function ApproveDialog({ change, role, onClose, onDone }: DialogProps & { change: PayeeChange; role: 'CONTRACT_MATCH' | 'ACCOUNT_MATCH' }) {
  const { t } = useTranslation();
  const command = useVendorCommand('approveVendorPayeeChange');
  return (
    <CommandDialog
      title={role === 'CONTRACT_MATCH' ? t('vnd.payee.approve.contract.title') : t('vnd.payee.approve.account.title')}
      context={[
        { label: t('vnd.payee.request.context.contractor'), value: change.contractor_name },
        { label: t('vnd.payee.change.bank.label'), value: change.bank_name },
        { label: t('vnd.payee.change.number.label'), value: maskedAccount(change.account_no_masked) },
      ]}
      note={<p className="vnd-note">{role === 'CONTRACT_MATCH' ? t('vnd.payee.approve.contract.note') : t('vnd.payee.approve.account.note')}</p>}
      confirmLabel={changeStepLabel(t, role)}
      fields={[{ name: 'note', label: t('vnd.payee.field.note.label'), kind: 'textarea', max: 500 }]}
      run={(values) => command.mutateAsync({ path: { id: change.id }, ifMatchVersion: change.version, body: { role, ...(text(values.note) === '' ? {} : { note: text(values.note) }) } })}
      onClose={onClose}
      onDone={onDone}
    />
  );
}

/** The call-back: a call to the number that is in the original file of the contractor, never to a number in the request. The person says which number they called and that it was the one on file. */
export function CallbackDialog({ change, onClose, onDone }: DialogProps & { change: PayeeChange }) {
  const { t } = useTranslation();
  const command = useVendorCommand('recordVendorPayeeCallback');
  const fields: FieldSpec[] = [
    {
      name: 'outcome',
      label: t('vnd.payee.field.outcome.label'),
      kind: 'select',
      required: true,
      options: [
        { value: 'CONFIRMED', label: callbackOutcomeLabel(t, 'CONFIRMED') },
        { value: 'NOT_CONFIRMED', label: callbackOutcomeLabel(t, 'NOT_CONFIRMED') },
      ],
    },
    { name: 'called_number', label: t('vnd.payee.field.called.label'), kind: 'tel', required: true, min: 9, max: 20, autoComplete: 'off', hint: t('vnd.payee.field.called.hint') },
    { name: 'used_number_on_file', label: t('vnd.payee.field.onFile.label'), kind: 'checkbox' },
    { name: 'note', label: t('vnd.payee.field.note.label'), kind: 'textarea', max: 500 },
  ];
  return (
    <CommandDialog
      title={t('vnd.payee.callback.title')}
      context={[
        { label: t('vnd.payee.request.context.contractor'), value: change.contractor_name },
        { label: t('vnd.payee.change.number.label'), value: maskedAccount(change.account_no_masked) },
      ]}
      note={<p className="vnd-note">{t('vnd.payee.callback.note')}</p>}
      confirmLabel={t('vnd.payee.callback.confirm')}
      fields={fields}
      run={(values) =>
        command.mutateAsync({
          path: { id: change.id },
          ifMatchVersion: change.version,
          body: {
            outcome: values.outcome === 'NOT_CONFIRMED' ? 'NOT_CONFIRMED' : 'CONFIRMED',
            called_number: text(values.called_number),
            used_number_on_file: values.used_number_on_file === true,
            ...(text(values.note) === '' ? {} : { note: text(values.note) }),
          },
        })
      }
      onClose={onClose}
      onDone={onDone}
    />
  );
}

/** Withdrawing a request (the requester) or rejecting it (an approver): one reason, kept in the chain. */
export function EndChangeDialog({ change, kind, onClose, onDone }: DialogProps & { change: PayeeChange; kind: 'cancel' | 'reject' }) {
  const { t } = useTranslation();
  const cancel = useVendorCommand('cancelVendorPayeeChange');
  const reject = useVendorCommand('rejectVendorPayeeChange');
  return (
    <CommandDialog
      title={kind === 'cancel' ? t('vnd.payee.cancel.title') : t('vnd.payee.reject.title')}
      context={[
        { label: t('vnd.payee.request.context.contractor'), value: change.contractor_name },
        { label: t('vnd.payee.change.number.label'), value: maskedAccount(change.account_no_masked) },
      ]}
      note={<p className="vnd-note">{kind === 'cancel' ? t('vnd.payee.cancel.note') : t('vnd.payee.reject.note')}</p>}
      confirmLabel={kind === 'cancel' ? t('vnd.payee.cancel.confirm') : t('vnd.payee.reject.confirm')}
      danger
      fields={[reasonField(t, 5)]}
      run={(values) => {
        const input = { path: { id: change.id }, ifMatchVersion: change.version, body: { reason: text(values.reason) } };
        return kind === 'cancel' ? cancel.mutateAsync(input) : reject.mutateAsync(input);
      }}
      onClose={onClose}
      onDone={onDone}
    />
  );
}

/** Closing the account in force: payments to the contractor are blocked until a new account has gone through the change. */
export function CloseAccountDialog({ account, onClose, onDone }: DialogProps & { account: Account }) {
  const { t } = useTranslation();
  const command = useVendorCommand('closeVendorPayeeAccount');
  return (
    <CommandDialog
      title={t('vnd.payee.close.title')}
      context={[
        { label: t('vnd.payee.change.bank.label'), value: account.bank_name },
        { label: t('vnd.payee.change.number.label'), value: maskedAccount(account.account_no_masked) },
      ]}
      note={<p className="vnd-note">{t('vnd.payee.close.note')}</p>}
      confirmLabel={t('vnd.payee.close.confirm')}
      danger
      fields={[reasonField(t, 5)]}
      run={(values) => command.mutateAsync({ path: { id: account.id }, ifMatchVersion: account.version, body: { reason: text(values.reason) } })}
      onClose={onClose}
      onDone={onDone}
    />
  );
}
