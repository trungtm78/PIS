import { useTranslation } from '../../../i18n';
import { CommandDialog, reasonField } from '../shared/vnd-form';
import type { FieldSpec } from '../shared/vnd-form';
import { useVendorCommand } from '../shared/vnd-hooks';
import { isUuid, money, shareText } from '../security/security-model';
import type { Subcontract } from '../security/security-model';

interface DialogProps {
  onClose: () => void;
  onDone: () => void;
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const optional = (name: string, value: unknown): Record<string, string> => (text(value) === '' ? {} : { [name]: text(value) });
const SHARE = /^\d{1,3}(\.\d{1,4})?$/;

/** What the bid of the prime declared about subcontracting: the share of the contract and the subcontractors it named. A new declaration replaces the one before; the old one stays as what the bid said. */
export function DeclareDialog({ initialPackage, initialContractor, onClose, onDone }: DialogProps & { initialPackage: string; initialContractor: string }) {
  const { t } = useTranslation();
  const command = useVendorCommand('declareVendorBidSubcontracting');
  const fields: FieldSpec[] = [
    { name: 'package_id', label: t('vnd.subcontract.field.package.label'), kind: 'uuid', required: true, initial: initialPackage, hint: t('vnd.subcontract.field.id.hint') },
    { name: 'contractor_id', label: t('vnd.subcontract.field.prime.label'), kind: 'uuid', required: true, initial: initialContractor, hint: t('vnd.subcontract.field.id.hint') },
    { name: 'declared_share_pct', label: t('vnd.subcontract.field.declaredShare.label'), kind: 'text', required: true, pattern: SHARE, hint: t('vnd.subcontract.field.share.hint') },
    { name: 'subcontractor_ids', label: t('vnd.subcontract.field.subcontractors.label'), kind: 'text', hint: t('vnd.subcontract.field.subcontractors.hint') },
    { name: 'document_id', label: t('vnd.subcontract.field.document.label'), kind: 'uuid', hint: t('vnd.subcontract.field.id.hint') },
  ];
  return (
    <CommandDialog
      title={t('vnd.subcontract.declare.title')}
      context={[]}
      note={<p className="vnd-note">{t('vnd.subcontract.declare.note')}</p>}
      confirmLabel={t('vnd.subcontract.declare.confirm')}
      fields={fields}
      blocked={(values) => text(values.subcontractor_ids) !== '' && !text(values.subcontractor_ids).split(/[\s,;]+/).filter((item) => item !== '').every(isUuid)}
      run={(values) =>
        command.mutateAsync({
          body: {
            package_id: text(values.package_id),
            contractor_id: text(values.contractor_id),
            declared_share_pct: text(values.declared_share_pct),
            subcontractor_ids: text(values.subcontractor_ids)
              .split(/[\s,;]+/)
              .filter((item) => item !== ''),
            ...optional('document_id', values.document_id),
          },
        })
      }
      onClose={onClose}
      onDone={onDone}
    />
  );
}

/** Proposes a subcontractor for the contract: what it does, its value and its share of the contract value. The approval is another person's and runs the assessment against the declaration of the bid again. */
export function ProposeDialog({ contractId, contractValue, onClose, onDone }: DialogProps & { contractId: string; contractValue: number }) {
  const { t } = useTranslation();
  const command = useVendorCommand('proposeVendorSubcontract');
  const fields: FieldSpec[] = [
    { name: 'subcontractor_id', label: t('vnd.subcontract.field.subcontractor.label'), kind: 'uuid', required: true, hint: t('vnd.subcontract.field.id.hint') },
    { name: 'scope', label: t('vnd.subcontract.field.scope.label'), kind: 'textarea', required: true, min: 5, max: 2000 },
    { name: 'value', label: t('vnd.subcontract.field.value.label'), kind: 'number', required: true, min: 1, hint: t('vnd.subcontract.field.value.hint', { value: money(contractValue) }) },
    { name: 'share_pct', label: t('vnd.subcontract.field.share.label'), kind: 'text', required: true, pattern: SHARE, hint: t('vnd.subcontract.field.share.hint') },
  ];
  return (
    <CommandDialog
      title={t('vnd.subcontract.propose.title')}
      context={[{ label: t('vnd.subcontract.summary.value.label'), value: money(contractValue) }]}
      note={<p className="vnd-note">{t('vnd.subcontract.propose.note')}</p>}
      confirmLabel={t('vnd.subcontract.propose.confirm')}
      fields={fields}
      run={(values) => command.mutateAsync({ body: { contract_id: contractId, subcontractor_id: text(values.subcontractor_id), scope: text(values.scope), value: Number(text(values.value)), share_pct: text(values.share_pct) } })}
      onClose={onClose}
      onDone={onDone}
    />
  );
}

function context(row: Subcontract, t: ReturnType<typeof useTranslation>['t']): Array<{ label: string; value: string }> {
  return [
    { label: t('vnd.subcontract.column.subcontractor'), value: row.subcontractor_name },
    { label: t('vnd.subcontract.column.value'), value: `${money(row.value)} (${shareText(row.share_pct)})` },
  ];
}

/** Approves a proposal. When the share passes the one the bid declared, or the subcontractor was not named, the rule lets the approver approve with a reason of 20 characters, or blocks it. The server runs the gate of subcontracts of VND-1 too. */
export function ApproveDialog({ row, onClose, onDone }: DialogProps & { row: Subcontract }) {
  const { t } = useTranslation();
  const command = useVendorCommand('approveVendorSubcontract');
  const needsException = row.declared_in_bid === false || row.findings.length > 0;
  return (
    <CommandDialog
      title={t('vnd.subcontract.approve.title')}
      context={context(row, t)}
      note={<p className="vnd-note">{needsException ? t('vnd.subcontract.approve.exception.note') : t('vnd.subcontract.approve.note')}</p>}
      confirmLabel={t('vnd.subcontract.approve.confirm')}
      fields={[{ name: 'exception_reason', label: t('vnd.subcontract.field.exception.label'), kind: 'textarea', min: 20, max: 2000, hint: t('vnd.field.reason.hint', { count: 20 }) }]}
      run={(values) => command.mutateAsync({ path: { id: row.id }, ifMatchVersion: row.version, body: text(values.exception_reason) === '' ? {} : { exception_reason: text(values.exception_reason) } })}
      onClose={onClose}
      onDone={onDone}
    />
  );
}

export function RejectDialog({ row, onClose, onDone }: DialogProps & { row: Subcontract }) {
  const { t } = useTranslation();
  const command = useVendorCommand('rejectVendorSubcontract');
  return (
    <CommandDialog
      title={t('vnd.subcontract.reject.title')}
      context={context(row, t)}
      note={<p className="vnd-note">{t('vnd.subcontract.reject.note')}</p>}
      confirmLabel={t('vnd.subcontract.reject.confirm')}
      danger
      fields={[reasonField(t, 5)]}
      run={(values) => command.mutateAsync({ path: { id: row.id }, ifMatchVersion: row.version, body: { reason: text(values.reason) } })}
      onClose={onClose}
      onDone={onDone}
    />
  );
}

export function TerminateDialog({ row, onClose, onDone }: DialogProps & { row: Subcontract }) {
  const { t } = useTranslation();
  const command = useVendorCommand('terminateVendorSubcontract');
  return (
    <CommandDialog
      title={t('vnd.subcontract.terminate.title')}
      context={context(row, t)}
      note={<p className="vnd-note">{t('vnd.subcontract.terminate.note')}</p>}
      confirmLabel={t('vnd.subcontract.terminate.confirm')}
      danger
      fields={[reasonField(t, 5)]}
      run={(values) => command.mutateAsync({ path: { id: row.id }, ifMatchVersion: row.version, body: { reason: text(values.reason) } })}
      onClose={onClose}
      onDone={onDone}
    />
  );
}

/** Records what the prime paid the subcontractor after a payment request: the amount, the day and the reference of the transfer. The subcontractor confirms it later through the supplier portal. */
export function PaymentDialog({ row, initialRequest, onClose, onDone }: DialogProps & { row: Subcontract; initialRequest: string }) {
  const { t } = useTranslation();
  const command = useVendorCommand('recordVendorSubcontractPayment');
  return (
    <CommandDialog
      title={t('vnd.subcontract.payment.title')}
      context={context(row, t)}
      note={<p className="vnd-note">{t('vnd.subcontract.payment.note')}</p>}
      confirmLabel={t('vnd.subcontract.payment.confirm')}
      fields={[
        { name: 'payment_request_id', label: t('vnd.subcontract.field.request.label'), kind: 'uuid', initial: initialRequest, hint: t('vnd.subcontract.field.request.hint') },
        { name: 'paid_amount', label: t('vnd.subcontract.field.paid.label'), kind: 'number', required: true, min: 1 },
        { name: 'paid_on', label: t('vnd.subcontract.field.paidOn.label'), kind: 'date', required: true },
        { name: 'reference', label: t('vnd.subcontract.field.reference.label'), kind: 'text', required: true, min: 3, max: 100 },
      ]}
      run={(values) => command.mutateAsync({ path: { id: row.id }, body: { ...optional('payment_request_id', values.payment_request_id), paid_amount: Number(text(values.paid_amount)), paid_on: text(values.paid_on), reference: text(values.reference) } })}
      onClose={onClose}
      onDone={onDone}
    />
  );
}
