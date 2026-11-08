import { useTranslation } from '../../../i18n';
import { CommandDialog, reasonField } from '../shared/vnd-form';
import type { FieldSpec } from '../shared/vnd-form';
import { useVendorCommand } from '../shared/vnd-hooks';
import { basisLabel, ownerKindLabel } from '../shared/vnd-labels';
import { CONTROL_BASES, SHARE_PATTERN, profileUpdateBody } from '../shared/vnd-model';
import type { Duplicate, Owner, ProfileView } from '../shared/vnd-model';

interface DialogProps {
  onClose: () => void;
  onDone: () => void;
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** The profile of the contractor, edited under the version the person saw (If-Match): only the fields that changed go in the body. */
export function EditProfileDialog({ view, onClose, onDone }: DialogProps & { view: ProfileView }) {
  const { t } = useTranslation();
  const command = useVendorCommand('updateVendorProfile');
  const profile = view.profile;
  const fields: FieldSpec[] = [
    { name: 'legal_rep_name', label: t('vnd.profile.field.legalRep.label'), kind: 'text', min: 2, max: 300, initial: profile.legal_rep_name ?? '', autoComplete: 'off' },
    { name: 'legal_rep_position', label: t('vnd.profile.field.position.label'), kind: 'text', min: 2, max: 200, initial: profile.legal_rep_position ?? '' },
    { name: 'registered_address', label: t('vnd.profile.field.address.label'), kind: 'textarea', min: 8, max: 500, initial: profile.registered_address ?? '' },
    { name: 'phone', label: t('vnd.profile.field.phone.label'), kind: 'tel', max: 20, initial: profile.phone ?? '', hint: t('vnd.profile.field.phone.hint') },
    { name: 'email', label: t('vnd.profile.field.email.label'), kind: 'email', max: 254, initial: profile.email ?? '' },
    { name: 'business_registration_no', label: t('vnd.profile.field.registration.label'), kind: 'text', min: 3, max: 40, initial: profile.business_registration_no ?? '' },
  ];
  return (
    <CommandDialog
      title={t('vnd.profile.edit.title')}
      context={[
        { label: t('vnd.profile.fact.name.label'), value: profile.legal_name },
        { label: t('vnd.profile.fact.tax.label'), value: profile.tax_identifier },
      ]}
      note={<p className="vnd-note">{t('vnd.profile.edit.note')}</p>}
      confirmLabel={t('vnd.profile.edit.confirm')}
      fields={fields}
      blocked={(values) => Object.keys(profileUpdateBody(profile, values)).length === 0}
      run={(values) => command.mutateAsync({ path: { id: profile.contractor_id }, ifMatchVersion: profile.version, body: profileUpdateBody(profile, values) })}
      onClose={onClose}
      onDone={onDone}
    />
  );
}

export function AddOwnerDialog({ view, onClose, onDone }: DialogProps & { view: ProfileView }) {
  const { t } = useTranslation();
  const command = useVendorCommand('addVendorOwner');
  const fields: FieldSpec[] = [
    {
      name: 'owner_kind',
      label: t('vnd.owners.field.kind.label'),
      kind: 'select',
      required: true,
      initial: 'PERSON',
      options: [
        { value: 'PERSON', label: ownerKindLabel(t, 'PERSON') },
        { value: 'ORGANISATION', label: ownerKindLabel(t, 'ORGANISATION') },
      ],
    },
    { name: 'owner_name', label: t('vnd.owners.field.name.label'), kind: 'text', required: true, min: 1, max: 300 },
    { name: 'identity_number', label: t('vnd.owners.field.identity.label'), kind: 'text', min: 5, max: 40, hint: t('vnd.owners.field.identity.hint'), autoComplete: 'off' },
    { name: 'share_pct', label: t('vnd.owners.field.share.label'), kind: 'text', pattern: SHARE_PATTERN, max: 6, hint: t('vnd.owners.field.share.hint') },
    { name: 'beneficial_owner', label: t('vnd.owners.field.beneficial.label'), kind: 'checkbox' },
    { name: 'control_basis', label: t('vnd.owners.field.basis.label'), kind: 'select', options: CONTROL_BASES.map((basis) => ({ value: basis, label: basisLabel(t, basis) })) },
    { name: 'source_document_id', label: t('vnd.owners.field.document.label'), kind: 'uuid', hint: t('vnd.owners.field.document.hint') },
  ];
  return (
    <CommandDialog
      title={t('vnd.owners.add.title')}
      context={[{ label: t('vnd.profile.fact.name.label'), value: view.profile.legal_name }]}
      confirmLabel={t('vnd.owners.add.confirm')}
      fields={fields}
      run={(values) =>
        command.mutateAsync({
          path: { id: view.profile.contractor_id },
          body: {
            owner_kind: values.owner_kind === 'ORGANISATION' ? 'ORGANISATION' : 'PERSON',
            owner_name: text(values.owner_name),
            beneficial_owner: values.beneficial_owner === true,
            ...(text(values.identity_number) === '' ? {} : { identity_number: text(values.identity_number) }),
            ...(text(values.share_pct) === '' ? {} : { share_pct: text(values.share_pct) }),
            ...(text(values.control_basis) === '' ? {} : { control_basis: CONTROL_BASES.find((basis) => basis === values.control_basis) ?? 'OTHER_CONTROL' }),
            ...(text(values.source_document_id) === '' ? {} : { source_document_id: text(values.source_document_id) }),
          },
        })
      }
      onClose={onClose}
      onDone={onDone}
    />
  );
}

export function EndOwnerDialog({ view, owner, onClose, onDone }: DialogProps & { view: ProfileView; owner: Owner }) {
  const { t } = useTranslation();
  const command = useVendorCommand('endVendorOwner');
  return (
    <CommandDialog
      title={t('vnd.owners.end.title')}
      context={[
        { label: t('vnd.profile.fact.name.label'), value: view.profile.legal_name },
        { label: t('vnd.owners.column.name'), value: owner.owner_name },
      ]}
      note={<p className="vnd-note">{t('vnd.owners.end.note')}</p>}
      confirmLabel={t('vnd.owners.end.confirm')}
      danger
      fields={[reasonField(t, 5)]}
      run={(values) => command.mutateAsync({ path: { id: owner.id }, body: { reason: text(values.reason) } })}
      onClose={onClose}
      onDone={onDone}
    />
  );
}

export function DeclareNoOwnerDialog({ view, onClose, onDone }: DialogProps & { view: ProfileView }) {
  const { t } = useTranslation();
  const command = useVendorCommand('declareVendorNoOwnerAboveThreshold');
  return (
    <CommandDialog
      title={t('vnd.owners.declare.title')}
      context={[{ label: t('vnd.profile.fact.name.label'), value: view.profile.legal_name }]}
      note={<p className="vnd-note">{t('vnd.owners.declare.note')}</p>}
      confirmLabel={t('vnd.owners.declare.confirm')}
      fields={[{ name: 'note', label: t('vnd.owners.declare.noteField.label'), kind: 'textarea', max: 500 }]}
      run={(values) => command.mutateAsync({ path: { id: view.profile.contractor_id }, ifMatchVersion: view.profile.version, body: text(values.note) === '' ? {} : { note: text(values.note) } })}
      onClose={onClose}
      onDone={onDone}
    />
  );
}

/** A suggestion of duplicates is dismissed, or sent to the merge of master data; either way a reason is kept. Nothing is merged here. */
export function DuplicateDecisionDialog({ duplicate, decision, onClose, onDone }: DialogProps & { duplicate: Duplicate; decision: 'DISMISSED' | 'MERGE_REQUESTED' }) {
  const { t } = useTranslation();
  const command = useVendorCommand('decideVendorDuplicate');
  return (
    <CommandDialog
      title={decision === 'DISMISSED' ? t('vnd.duplicates.dismiss.title') : t('vnd.duplicates.merge.title')}
      context={[
        { label: t('vnd.duplicates.column.a'), value: duplicate.contractor_a_name },
        { label: t('vnd.duplicates.column.b'), value: duplicate.contractor_b_name },
      ]}
      note={<p className="vnd-note">{decision === 'DISMISSED' ? t('vnd.duplicates.dismiss.note') : t('vnd.duplicates.merge.note')}</p>}
      confirmLabel={decision === 'DISMISSED' ? t('vnd.duplicates.dismiss.confirm') : t('vnd.duplicates.merge.confirm')}
      fields={[reasonField(t, 5, 500)]}
      run={(values) => command.mutateAsync({ path: { id: duplicate.id }, ifMatchVersion: duplicate.version, body: { decision, reason: text(values.reason) } })}
      onClose={onClose}
      onDone={onDone}
    />
  );
}
