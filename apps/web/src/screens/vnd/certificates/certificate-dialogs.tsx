import { useTranslation } from '../../../i18n';
import { CommandDialog, RowsEditor, reasonField, rowsOf } from '../shared/vnd-form';
import type { FieldSpec, Row } from '../shared/vnd-form';
import { useVendorCommand } from '../shared/vnd-hooks';
import { gradeLabel, kindLabel, staffRoleLabel } from '../shared/vnd-labels';
import { CERTIFICATE_KINDS, GRADES, STAFF_ROLES } from '../shared/vnd-model';
import type { CertificateKind, Grade, KeyStaff, ProfileView, Qualification, Requirement, StaffRole } from '../shared/vnd-model';

interface DialogProps {
  onClose: () => void;
  onDone: () => void;
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const optional = (name: string, value: unknown): Record<string, string> => (text(value) === '' ? {} : { [name]: text(value) });
const kindOf = (value: unknown): CertificateKind => CERTIFICATE_KINDS.find((kind) => kind === value) ?? 'OTHER';
const gradeOf = (value: unknown): Grade | undefined => GRADES.find((grade) => grade === value);
const roleOf = (value: unknown): StaffRole => STAFF_ROLES.find((role) => role === value) ?? 'OTHER';

export type CertificateSubject = { subject: 'qualification'; item: Qualification } | { subject: 'key-staff'; item: KeyStaff };

const subjectName = (target: CertificateSubject): string => (target.subject === 'qualification' ? target.item.certificate_no : target.item.person_name);

export function AddQualificationDialog({ view, onClose, onDone }: DialogProps & { view: ProfileView }) {
  const { t } = useTranslation();
  const command = useVendorCommand('addVendorQualification');
  const fields: FieldSpec[] = [
    { name: 'kind', label: t('vnd.certs.field.kind.label'), kind: 'select', required: true, options: CERTIFICATE_KINDS.map((kind) => ({ value: kind, label: kindLabel(t, kind) })) },
    { name: 'certificate_no', label: t('vnd.certs.field.number.label'), kind: 'text', required: true, min: 1, max: 100 },
    { name: 'grade', label: t('vnd.certs.field.grade.label'), kind: 'select', options: GRADES.map((grade) => ({ value: grade, label: gradeLabel(t, grade) })) },
    { name: 'scope', label: t('vnd.certs.field.scope.label'), kind: 'textarea', max: 500 },
    { name: 'issuer', label: t('vnd.certs.field.issuer.label'), kind: 'text', required: true, min: 2, max: 300 },
    { name: 'issued_on', label: t('vnd.certs.field.issued.label'), kind: 'date', required: true },
    { name: 'expires_on', label: t('vnd.certs.field.expires.label'), kind: 'date', hint: t('vnd.certs.field.expires.hint') },
    { name: 'document_id', label: t('vnd.certs.field.document.label'), kind: 'uuid', hint: t('vnd.certs.field.document.hint') },
  ];
  return (
    <CommandDialog
      title={t('vnd.certs.add.title')}
      context={[{ label: t('vnd.certs.context.contractor'), value: view.profile.legal_name }]}
      note={<p className="vnd-note">{t('vnd.certs.add.note')}</p>}
      confirmLabel={t('vnd.certs.add.confirm')}
      fields={fields}
      run={(values) => {
        const grade = gradeOf(values.grade);
        return command.mutateAsync({
          path: { id: view.profile.contractor_id },
          body: {
            kind: kindOf(values.kind),
            certificate_no: text(values.certificate_no),
            ...(grade === undefined ? {} : { grade }),
            ...optional('scope', values.scope),
            issuer: text(values.issuer),
            issued_on: text(values.issued_on),
            ...optional('expires_on', values.expires_on),
            ...optional('document_id', values.document_id),
          },
        });
      }}
      onClose={onClose}
      onDone={onDone}
    />
  );
}

export function AddKeyStaffDialog({ view, onClose, onDone }: DialogProps & { view: ProfileView }) {
  const { t } = useTranslation();
  const command = useVendorCommand('addVendorKeyStaff');
  const fields: FieldSpec[] = [
    { name: 'staff_role', label: t('vnd.certs.field.role.label'), kind: 'select', required: true, options: STAFF_ROLES.map((role) => ({ value: role, label: staffRoleLabel(t, role) })) },
    { name: 'person_name', label: t('vnd.certs.field.person.label'), kind: 'text', required: true, min: 2, max: 300 },
    { name: 'qualification_title', label: t('vnd.certs.field.title.label'), kind: 'text', required: true, min: 2, max: 300 },
    { name: 'certificate_no', label: t('vnd.certs.field.number.label'), kind: 'text', max: 100 },
    { name: 'issued_on', label: t('vnd.certs.field.issued.label'), kind: 'date', required: true },
    { name: 'expires_on', label: t('vnd.certs.field.expires.label'), kind: 'date', hint: t('vnd.certs.field.expires.hint') },
    { name: 'document_id', label: t('vnd.certs.field.document.label'), kind: 'uuid', hint: t('vnd.certs.field.document.hint') },
  ];
  return (
    <CommandDialog
      title={t('vnd.certs.staff.add.title')}
      context={[{ label: t('vnd.certs.context.contractor'), value: view.profile.legal_name }]}
      note={<p className="vnd-note">{t('vnd.certs.add.note')}</p>}
      confirmLabel={t('vnd.certs.staff.add.confirm')}
      fields={fields}
      run={(values) =>
        command.mutateAsync({
          path: { id: view.profile.contractor_id },
          body: {
            staff_role: roleOf(values.staff_role),
            person_name: text(values.person_name),
            qualification_title: text(values.qualification_title),
            ...optional('certificate_no', values.certificate_no),
            issued_on: text(values.issued_on),
            ...optional('expires_on', values.expires_on),
            ...optional('document_id', values.document_id),
          },
        })
      }
      onClose={onClose}
      onDone={onDone}
    />
  );
}

/** The check of a certificate or a person against the original. Another person than the one who entered it does this; the server refuses the same person (403 SELF_APPROVAL_DENIED), and an unchecked certificate does not meet a requirement. */
export function VerifyDialog({ target, onClose, onDone }: DialogProps & { target: CertificateSubject }) {
  const { t } = useTranslation();
  const verifyQualification = useVendorCommand('verifyVendorQualification');
  const verifyKeyStaff = useVendorCommand('verifyVendorKeyStaff');
  return (
    <CommandDialog
      title={t('vnd.certs.verify.title')}
      context={[
        { label: t('vnd.certs.verify.context.subject'), value: target.subject === 'qualification' ? kindLabel(t, target.item.kind) : staffRoleLabel(t, target.item.staff_role) },
        { label: t('vnd.certs.verify.context.name'), value: subjectName(target) },
      ]}
      note={<p className="vnd-note">{t('vnd.certs.verify.note')}</p>}
      confirmLabel={t('vnd.certs.verify.confirm')}
      fields={[]}
      run={() => (target.subject === 'qualification' ? verifyQualification : verifyKeyStaff).mutateAsync({ path: { id: target.item.id }, ifMatchVersion: target.item.version })}
      onClose={onClose}
      onDone={onDone}
    />
  );
}

export function RevokeDialog({ target, onClose, onDone }: DialogProps & { target: CertificateSubject }) {
  const { t } = useTranslation();
  const revokeQualification = useVendorCommand('revokeVendorQualification');
  const revokeKeyStaff = useVendorCommand('revokeVendorKeyStaff');
  return (
    <CommandDialog
      title={t('vnd.certs.revoke.title')}
      context={[
        { label: t('vnd.certs.verify.context.subject'), value: target.subject === 'qualification' ? kindLabel(t, target.item.kind) : staffRoleLabel(t, target.item.staff_role) },
        { label: t('vnd.certs.verify.context.name'), value: subjectName(target) },
      ]}
      note={<p className="vnd-note">{t('vnd.certs.revoke.note')}</p>}
      confirmLabel={t('vnd.certs.revoke.confirm')}
      danger
      fields={[reasonField(t, 5)]}
      run={(values) => (target.subject === 'qualification' ? revokeQualification : revokeKeyStaff).mutateAsync({ path: { id: target.item.id }, ifMatchVersion: target.item.version, body: { reason: text(values.reason) } })}
      onClose={onClose}
      onDone={onDone}
    />
  );
}

/** The requirements of a package: the kind of certificate, the lowest grade and a word its scope must name. The list is set as a whole (it replaces what was there), so the dialog starts from the current list. */
export function RequirementsDialog({ packageId, current, onClose, onDone }: DialogProps & { packageId: string; current: readonly Requirement[] }) {
  const { t } = useTranslation();
  const command = useVendorCommand('setVendorPackageRequirements');
  const initial: Row[] = current.map((item) => ({ kind: item.kind, min_grade: item.min_grade ?? '', scope_keyword: item.scope_keyword ?? '' }));
  const fields: FieldSpec[] = [
    {
      name: 'requirements',
      label: t('vnd.certs.requirements.field.label'),
      kind: 'custom',
      initial: initial,
      valid: (value) => rowsOf(value).every((row) => CERTIFICATE_KINDS.some((kind) => kind === row.kind)),
      render: (value, set) => (
        <RowsEditor
          rows={rowsOf(value)}
          onChange={set}
          blank={() => ({ kind: '', min_grade: '', scope_keyword: '' })}
          addLabel={t('vnd.certs.requirements.add.action')}
          removeLabel={(index) => t('vnd.certs.requirements.remove.label', { row: index + 1 })}
          columns={[
            { name: 'kind', label: t('vnd.certs.requirements.column.kind'), kind: 'select', options: CERTIFICATE_KINDS.map((kind) => ({ value: kind, label: kindLabel(t, kind) })) },
            { name: 'min_grade', label: t('vnd.certs.requirements.column.grade'), kind: 'select', options: GRADES.map((grade) => ({ value: grade, label: gradeLabel(t, grade) })) },
            { name: 'scope_keyword', label: t('vnd.certs.requirements.column.keyword'), kind: 'text' },
          ]}
        />
      ),
    },
  ];
  return (
    <CommandDialog
      title={t('vnd.certs.requirements.title')}
      context={[{ label: t('vnd.certs.requirements.context.package'), value: packageId }]}
      note={<p className="vnd-note">{t('vnd.certs.requirements.note')}</p>}
      confirmLabel={t('vnd.certs.requirements.confirm')}
      fields={fields}
      wide
      run={(values) =>
        command.mutateAsync({
          path: { id: packageId },
          body: {
            requirements: rowsOf(values.requirements).map((row) => {
              const grade = gradeOf(row.min_grade);
              return { kind: kindOf(row.kind), min_grade: grade ?? null, scope_keyword: text(row.scope_keyword) === '' ? null : text(row.scope_keyword) };
            }),
          },
        })
      }
      onClose={onClose}
      onDone={onDone}
    />
  );
}
