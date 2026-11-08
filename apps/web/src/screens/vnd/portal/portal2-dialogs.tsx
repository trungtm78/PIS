import { useTranslation } from '../../../i18n';
import { CommandDialog, reasonField } from '../shared/vnd-form';
import type { FieldSpec } from '../shared/vnd-form';
import { contactBasisLabel } from './portal2-labels';
import { usePortal2Command } from './portal2-hooks';
import { CONTACT_BASES, basisNeedsReference, isEmail } from './portal2-model';
import type { ContactBasis, InvitationLine } from './portal2-model';
import { contractorField } from './portal-dialogs';
import { portalErrorText } from './portal-labels';

interface DialogProps {
  onClose: () => void;
  onDone: () => void;
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const basisOf = (value: unknown): ContactBasis => CONTACT_BASES.find((basis) => basis === value) ?? 'OTHER_EVIDENCE';

/**
 * A staff member proposes that a contact of a verified contractor may enter the portal, with the proof that the contact is the contractor's. The proposal does nothing until a different person approves it: the person who proposes
 * is never the person who approves.
 */
export function ProposeInvitationDialog({ contractorId, onClose, onDone }: DialogProps & { contractorId?: string | undefined }) {
  const { t } = useTranslation();
  const command = usePortal2Command('proposeVendorPortalInvitation');
  const fields: FieldSpec[] = [
    contractorField(t, contractorId ?? ''),
    { name: 'contact_name', label: t('po2.propose.field.name.label'), kind: 'text', required: true, min: 2, max: 200 },
    { name: 'contact_email', label: t('po2.propose.field.email.label'), kind: 'email', required: true, min: 5, max: 254, autoComplete: 'off', pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/ },
    { name: 'contact_basis', label: t('po2.propose.field.basis.label'), kind: 'select', required: true, hint: t('po2.propose.field.basis.hint'), options: CONTACT_BASES.map((basis) => ({ value: basis, label: contactBasisLabel(t, basis) })) },
    { name: 'basis_reference', label: t('po2.propose.field.reference.label'), kind: 'text', required: true, min: 6, max: 300, hint: t('po2.propose.field.reference.hint'), visible: (values) => basisNeedsReference(text(values.contact_basis)) },
  ];
  return (
    <CommandDialog
      title={t('po2.propose.title.text')}
      context={[]}
      note={<p className="vnd-note">{t('po2.propose.note.text')}</p>}
      confirmLabel={t('po2.propose.confirm.action')}
      fields={fields}
      blocked={(values) => !isEmail(text(values.contact_email))}
      describeError={portalErrorText}
      run={(values) => {
        const basis = basisOf(values.contact_basis);
        return command.mutateAsync({
          body: {
            contractor_id: text(values.contractor_id),
            contact_name: text(values.contact_name),
            contact_email: text(values.contact_email),
            contact_basis: basis,
            ...(basisNeedsReference(basis) ? { basis_reference: text(values.basis_reference) } : {}),
          },
        });
      }}
      onClose={onClose}
      onDone={onDone}
    />
  );
}

type Subject = Pick<InvitationLine, 'id' | 'contractor_name' | 'contact_name' | 'version'> & { proposed_by_name?: string | null | undefined };

/** The second person approves: the guest account of the contact is created, bound to the contractor, and the invitation is sent. */
export function ApproveInvitationDialog({ invitation, onClose, onDone }: DialogProps & { invitation: Subject & Pick<InvitationLine, 'contact_basis' | 'basis_reference' | 'tax_identifier'> }) {
  const { t } = useTranslation();
  const command = usePortal2Command('approveVendorPortalInvitation');
  const fields: FieldSpec[] = [{ name: 'note', label: t('po2.approve.field.note.label'), kind: 'textarea', min: 5, max: 1000 }];
  return (
    <CommandDialog
      title={t('po2.approve.title.text')}
      context={[
        { label: t('po2.context.contractor'), value: `${invitation.contractor_name} (${invitation.tax_identifier})` },
        { label: t('po2.context.contact'), value: invitation.contact_name },
        { label: t('po2.context.basis'), value: invitation.basis_reference === null || invitation.basis_reference === undefined ? contactBasisLabel(t, invitation.contact_basis) : `${contactBasisLabel(t, invitation.contact_basis)}: ${invitation.basis_reference}` },
        { label: t('po2.context.proposer'), value: invitation.proposed_by_name ?? '–' },
      ]}
      note={<p className="vnd-note">{t('po2.approve.note.text')}</p>}
      confirmLabel={t('po2.approve.confirm.action')}
      fields={fields}
      describeError={portalErrorText}
      run={(values) => command.mutateAsync({ path: { id: invitation.id }, ifMatchVersion: invitation.version, body: text(values.note) === '' ? {} : { note: text(values.note) } })}
      onClose={onClose}
      onDone={onDone}
    />
  );
}

/** Rejects a proposal, or revokes a proposal or an access at once: both need a reason that stays in the audit. */
export function ReasonInvitationDialog({ invitation, mode, onClose, onDone }: DialogProps & { invitation: Subject; mode: 'reject' | 'revoke' }) {
  const { t } = useTranslation();
  const reject = usePortal2Command('rejectVendorPortalInvitation');
  const revoke = usePortal2Command('revokeVendorPortalInvitation');
  const rejecting = mode === 'reject';
  return (
    <CommandDialog
      title={rejecting ? t('po2.reject.title.text') : t('po2.revoke.title.text')}
      context={[
        { label: t('po2.context.contractor'), value: invitation.contractor_name },
        { label: t('po2.context.contact'), value: invitation.contact_name },
      ]}
      note={<p className="vnd-note">{rejecting ? t('po2.reject.note.text') : t('po2.revoke.note.text')}</p>}
      confirmLabel={rejecting ? t('po2.reject.confirm.action') : t('po2.revoke.confirm.action')}
      danger
      fields={[reasonField(t, 5, 1000)]}
      describeError={portalErrorText}
      run={(values) => (rejecting ? reject : revoke).mutateAsync({ path: { id: invitation.id }, ifMatchVersion: invitation.version, body: { reason: text(values.reason) } })}
      onClose={onClose}
      onDone={onDone}
    />
  );
}
