import { useTranslation } from '../../../i18n';
import { CommandDialog, reasonField } from '../shared/vnd-form';
import type { FieldSpec } from '../shared/vnd-form';
import { useVendorCommand } from '../shared/vnd-hooks';
import { FORFEIT_REASONS, SECURITY_KINDS, money } from './security-model';
import type { ForfeitReason, SecurityKind, SecurityRow } from './security-model';
import { camel } from '../shared/vnd-model';

interface DialogProps {
  onClose: () => void;
  onDone: () => void;
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const optional = (name: string, value: unknown): Record<string, string> => (text(value) === '' ? {} : { [name]: text(value) });
const kindOf = (value: unknown): SecurityKind => SECURITY_KINDS.find((code) => code === value) ?? 'BANK_GUARANTEE';
const reasonOf = (value: unknown): ForfeitReason => FORFEIT_REASONS.find((code) => code === value) ?? 'OTHER_BY_BIDDING_DOCUMENT';

function useRowContext(row: SecurityRow): Array<{ label: string; value: string }> {
  const { t } = useTranslation();
  return [
    { label: t('vnd.security.column.contractor'), value: row.contractor_name },
    { label: t('vnd.security.column.package'), value: row.package_code },
    { label: t('vnd.security.column.amount'), value: money(row.amount) },
  ];
}

/** Receives a bid security: the letter of a bank, an insurance bond or a deposit. The amount asked and the factor of the contractor are set by the server on the day it is received; a person other than the receiver confirms it with the issuer. */
export function ReceiveDialog({ initialPackage, initialContractor, onClose, onDone }: DialogProps & { initialPackage: string; initialContractor: string }) {
  const { t } = useTranslation();
  const command = useVendorCommand('receiveVendorBidSecurity');
  const fields: FieldSpec[] = [
    { name: 'package_id', label: t('vnd.security.field.package.label'), kind: 'uuid', required: true, initial: initialPackage, hint: t('vnd.security.field.id.hint') },
    { name: 'contractor_id', label: t('vnd.security.field.contractor.label'), kind: 'uuid', required: true, initial: initialContractor, hint: t('vnd.security.field.id.hint') },
    { name: 'kind', label: t('vnd.security.field.kind.label'), kind: 'select', required: true, options: SECURITY_KINDS.map((code) => ({ value: code, label: t(`vnd.security.kind.${camel(code)}.name`) })) },
    { name: 'issuer', label: t('vnd.security.field.issuer.label'), kind: 'text', required: true, min: 2, max: 300 },
    { name: 'security_no', label: t('vnd.security.field.number.label'), kind: 'text', required: true, min: 1, max: 100 },
    { name: 'amount', label: t('vnd.security.field.amount.label'), kind: 'number', required: true, min: 1, hint: t('vnd.security.field.amount.hint') },
    { name: 'issued_on', label: t('vnd.security.field.issuedOn.label'), kind: 'date', required: true },
    { name: 'valid_until', label: t('vnd.security.field.validUntil.label'), kind: 'date', required: true },
    { name: 'document_id', label: t('vnd.security.field.document.label'), kind: 'uuid', hint: t('vnd.security.field.id.hint') },
  ];
  return (
    <CommandDialog
      title={t('vnd.security.receive.title')}
      context={[]}
      note={<p className="vnd-note">{t('vnd.security.receive.note')}</p>}
      confirmLabel={t('vnd.security.receive.confirm')}
      fields={fields}
      run={(values) =>
        command.mutateAsync({
          body: {
            package_id: text(values.package_id),
            contractor_id: text(values.contractor_id),
            kind: kindOf(values.kind),
            issuer: text(values.issuer),
            security_no: text(values.security_no),
            amount: Number(text(values.amount)),
            issued_on: text(values.issued_on),
            valid_until: text(values.valid_until),
            ...optional('document_id', values.document_id),
          },
        })
      }
      onClose={onClose}
      onDone={onDone}
    />
  );
}

/** Confirms the security with the issuer and keeps the reference the issuer gave. A person other than the receiver does it; the server refuses the same person (403 SELF_APPROVAL_DENIED). */
export function ConfirmDialog({ row, onClose, onDone }: DialogProps & { row: SecurityRow }) {
  const { t } = useTranslation();
  const command = useVendorCommand('confirmVendorBidSecurity');
  const context = useRowContext(row);
  return (
    <CommandDialog
      title={t('vnd.security.confirm.title')}
      context={context}
      note={<p className="vnd-note">{t('vnd.security.confirm.note')}</p>}
      confirmLabel={t('vnd.security.confirm.confirm')}
      fields={[{ name: 'issuer_reference', label: t('vnd.security.field.reference.label'), kind: 'text', required: true, min: 3, max: 200, hint: t('vnd.security.field.reference.hint') }]}
      run={(values) => command.mutateAsync({ path: { id: row.id }, ifMatchVersion: row.version, body: { issuer_reference: text(values.issuer_reference) } })}
      onClose={onClose}
      onDone={onDone}
    />
  );
}

export function RejectDialog({ row, onClose, onDone }: DialogProps & { row: SecurityRow }) {
  const { t } = useTranslation();
  const command = useVendorCommand('rejectVendorBidSecurity');
  const context = useRowContext(row);
  return (
    <CommandDialog
      title={t('vnd.security.reject.title')}
      context={context}
      note={<p className="vnd-note">{t('vnd.security.reject.note')}</p>}
      confirmLabel={t('vnd.security.reject.confirm')}
      danger
      fields={[reasonField(t, 20)]}
      run={(values) => command.mutateAsync({ path: { id: row.id }, ifMatchVersion: row.version, body: { reason: text(values.reason) } })}
      onClose={onClose}
      onDone={onDone}
    />
  );
}

/** Proposes the forfeiture of a confirmed security for one of the reasons of the law. The decision is another person's, on a decision paper. */
export function ProposeForfeitDialog({ row, onClose, onDone }: DialogProps & { row: SecurityRow }) {
  const { t } = useTranslation();
  const command = useVendorCommand('proposeVendorBidSecurityForfeiture');
  const context = useRowContext(row);
  return (
    <CommandDialog
      title={t('vnd.security.propose.title')}
      context={context}
      note={<p className="vnd-note">{t('vnd.security.propose.note')}</p>}
      confirmLabel={t('vnd.security.propose.confirm')}
      danger
      fields={[
        { name: 'reason_code', label: t('vnd.security.field.reasonCode.label'), kind: 'select', required: true, options: FORFEIT_REASONS.map((code) => ({ value: code, label: t(`vnd.security.reason.${camel(code)}.name`) })) },
        reasonField(t, 20),
      ]}
      run={(values) => command.mutateAsync({ path: { id: row.id }, ifMatchVersion: row.version, body: { reason_code: reasonOf(values.reason_code), reason: text(values.reason) } })}
      onClose={onClose}
      onDone={onDone}
    />
  );
}

export function WithdrawForfeitDialog({ row, onClose, onDone }: DialogProps & { row: SecurityRow }) {
  const { t } = useTranslation();
  const command = useVendorCommand('withdrawVendorBidSecurityForfeiture');
  const context = useRowContext(row);
  return (
    <CommandDialog
      title={t('vnd.security.withdraw.title')}
      context={context}
      note={<p className="vnd-note">{t('vnd.security.withdraw.note')}</p>}
      confirmLabel={t('vnd.security.withdraw.confirm')}
      fields={[]}
      run={() => command.mutateAsync({ path: { id: row.id }, ifMatchVersion: row.version })}
      onClose={onClose}
      onDone={onDone}
    />
  );
}

/** Decides a proposed forfeiture: forfeit it on a decision paper, or refuse and leave the security confirmed. Another person than the proposer decides. */
export function DecideForfeitDialog({ row, onClose, onDone }: DialogProps & { row: SecurityRow }) {
  const { t } = useTranslation();
  const command = useVendorCommand('decideVendorBidSecurityForfeiture');
  const context = [...useRowContext(row), { label: t('vnd.security.field.reasonCode.label'), value: row.forfeit_reason_code === null ? '–' : t(`vnd.security.reason.${camel(row.forfeit_reason_code)}.name`) }];
  return (
    <CommandDialog
      title={t('vnd.security.decide.title')}
      context={context}
      note={<p className="vnd-note">{t('vnd.security.decide.note')}</p>}
      confirmLabel={t('vnd.security.decide.confirm')}
      danger
      fields={[
        {
          name: 'decision',
          label: t('vnd.security.field.decision.label'),
          kind: 'select',
          required: true,
          options: [
            { value: 'FORFEIT', label: t('vnd.security.decision.forfeit.name') },
            { value: 'REFUSE', label: t('vnd.security.decision.refuse.name') },
          ],
        },
        reasonField(t, 20),
        { name: 'decision_document_id', label: t('vnd.security.field.decisionDocument.label'), kind: 'uuid', required: true, hint: t('vnd.security.field.id.hint'), visible: (values) => values.decision === 'FORFEIT' },
      ]}
      run={(values) =>
        command.mutateAsync({
          path: { id: row.id },
          ifMatchVersion: row.version,
          body: { decision: values.decision === 'REFUSE' ? 'REFUSE' : 'FORFEIT', reason: text(values.reason), ...(values.decision === 'FORFEIT' ? optional('decision_document_id', values.decision_document_id) : {}) },
        })
      }
      onClose={onClose}
      onDone={onDone}
    />
  );
}

/** Releases the security (the bid lost, or the contract was signed) or records that its last day passed; either is final. */
export function ReleaseDialog({ row, onClose, onDone }: DialogProps & { row: SecurityRow }) {
  const { t } = useTranslation();
  const command = useVendorCommand('releaseVendorBidSecurity');
  const context = useRowContext(row);
  return (
    <CommandDialog
      title={t('vnd.security.release.title')}
      context={context}
      note={<p className="vnd-note">{t('vnd.security.release.note')}</p>}
      confirmLabel={t('vnd.security.release.confirm')}
      fields={[reasonField(t, 5), { name: 'expired', label: t('vnd.security.field.expired.label'), kind: 'checkbox' }]}
      run={(values) => command.mutateAsync({ path: { id: row.id }, ifMatchVersion: row.version, body: { reason: text(values.reason), expired: values.expired === true } })}
      onClose={onClose}
      onDone={onDone}
    />
  );
}
