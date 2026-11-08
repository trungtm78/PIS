import { useState } from 'react';
import { useTranslation } from '../../../i18n';
import { ConfirmDialog } from '../../../ui';
import { FileStep } from './FileStep';
import { useCreateDocument, useLinkOptions } from './hooks';
import { classLabel, problemText, securityLabel } from './labels';
import { resourceIdOf } from './model';
import type { UploadedFile } from './model';

export const CLASSES = ['LEGAL_BASIS', 'INVESTMENT_DECISION', 'FEASIBILITY', 'DESIGN', 'COST_ESTIMATE', 'PROCUREMENT', 'CONTRACT', 'ACCEPTANCE', 'PAYMENT', 'SETTLEMENT', 'REPORT', 'CORRESPONDENCE', 'OTHER'] as const;
export const SECURITY = ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'PERSONAL'] as const;

interface CreateDialogProps {
  defaultProject: string | undefined;
  onClose: () => void;
  onDone: (documentId: string | undefined) => void;
}

interface Form {
  projectId: string;
  docClass: (typeof CLASSES)[number];
  title: string;
  reference: string;
  security: (typeof SECURITY)[number];
  from: string;
  to: string;
  contractId: string;
  packageId: string;
  note: string;
}

/**
 * A new document of a project (DOC-24): the file first (uploaded and checked as soon as it is chosen), then what describes it: the project, the class, the title, the reference, the effective period and the contract and package
 * it belongs to. The server judges every link again; a refusal is said inside the dialog and the form keeps what was typed.
 */
export function CreateDialog({ defaultProject, onClose, onDone }: CreateDialogProps) {
  const { t } = useTranslation();
  const create = useCreateDocument();
  const projects = useLinkOptions('project', true);
  const contracts = useLinkOptions('contract', true);
  const packages = useLinkOptions('package', true);
  const [staged, setStaged] = useState<UploadedFile | undefined>(undefined);
  const [form, setForm] = useState<Form>({ projectId: defaultProject ?? '', docClass: 'OTHER', title: '', reference: '', security: 'INTERNAL', from: '', to: '', contractId: '', packageId: '', note: '' });
  const [missing, setMissing] = useState<string | undefined>(undefined);
  const set = <K extends keyof Form>(key: K, value: Form[K]): void => setForm((current) => ({ ...current, [key]: value }));
  const inProject = <O extends { projectId: string | null }>(options: O[] | undefined): O[] => (options ?? []).filter((option) => option.projectId === null || option.projectId === form.projectId);

  const submit = (): void => {
    if (staged === undefined) return setMissing(t('doc.repo.create.missingFile'));
    if (form.projectId === '') return setMissing(t('doc.repo.create.missingProject'));
    if (form.title.trim().length < 3) return setMissing(t('doc.repo.create.missingTitle'));
    if (form.from !== '' && form.to !== '' && form.to < form.from) return setMissing(t('doc.repo.create.missingPeriod'));
    setMissing(undefined);
    create.mutate(
      {
        project_id: form.projectId,
        doc_class: form.docClass,
        title: form.title.trim(),
        security_class: form.security,
        file_object_key: staged.file_object_key,
        file_sha256: staged.file_sha256,
        ...(form.reference.trim() === '' ? {} : { reference: form.reference.trim() }),
        ...(form.from === '' ? {} : { effective_from: form.from }),
        ...(form.to === '' ? {} : { effective_to: form.to }),
        ...(form.contractId === '' ? {} : { contract_id: form.contractId }),
        ...(form.packageId === '' ? {} : { package_id: form.packageId }),
        ...(form.note.trim() === '' ? {} : { note: form.note.trim() }),
      },
      { onSuccess: (result) => onDone(resourceIdOf(result)) },
    );
  };

  return (
    <ConfirmDialog
      open
      title={t('doc.repo.create.title')}
      context={[{ label: t('doc.repo.create.contextFile'), value: staged === undefined ? t('doc.repo.create.contextNone') : staged.file_sha256.slice(0, 12) }]}
      confirmLabel={t('doc.repo.create.confirm')}
      cancelLabel={t('doc.repo.dialog.cancel')}
      pending={create.isPending}
      error={missing ?? (create.isError ? problemText(t, create.error) : undefined)}
      onCancel={onClose}
      onConfirm={submit}
    >
      <FileStep staged={staged} onStaged={setStaged} />
      <div className="field">
        <label htmlFor="repo-project">{t('doc.repo.field.project')}</label>
        <select id="repo-project" value={form.projectId} onChange={(event) => setForm((current) => ({ ...current, projectId: event.target.value, contractId: '', packageId: '' }))}>
          <option value="">{t('doc.repo.field.choose')}</option>
          {(projects.data ?? []).map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="repo-class">{t('doc.repo.field.class')}</label>
        <select id="repo-class" value={form.docClass} onChange={(event) => set('docClass', event.target.value as Form['docClass'])}>
          {CLASSES.map((value) => (
            <option key={value} value={value}>
              {classLabel(t, value)}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="repo-title">{t('doc.repo.field.title')}</label>
        <input id="repo-title" type="text" value={form.title} maxLength={300} onChange={(event) => set('title', event.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="repo-reference">{t('doc.repo.field.reference')}</label>
        <input id="repo-reference" type="text" value={form.reference} maxLength={120} onChange={(event) => set('reference', event.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="repo-security">{t('doc.repo.field.security')}</label>
        <select id="repo-security" value={form.security} onChange={(event) => set('security', event.target.value as Form['security'])}>
          {SECURITY.map((value) => (
            <option key={value} value={value}>
              {securityLabel(t, value)}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="repo-from">{t('doc.repo.field.from')}</label>
        <input id="repo-from" type="date" value={form.from} onChange={(event) => set('from', event.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="repo-to">{t('doc.repo.field.to')}</label>
        <input id="repo-to" type="date" value={form.to} onChange={(event) => set('to', event.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="repo-contract">{t('doc.repo.field.contract')}</label>
        <select id="repo-contract" value={form.contractId} onChange={(event) => set('contractId', event.target.value)}>
          <option value="">{t('doc.repo.field.none')}</option>
          {inProject(contracts.data).map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="repo-package">{t('doc.repo.field.package')}</label>
        <select id="repo-package" value={form.packageId} onChange={(event) => set('packageId', event.target.value)}>
          <option value="">{t('doc.repo.field.none')}</option>
          {inProject(packages.data).map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="repo-note">{t('doc.repo.field.note')}</label>
        <textarea id="repo-note" value={form.note} maxLength={2000} rows={2} onChange={(event) => set('note', event.target.value)} />
      </div>
    </ConfirmDialog>
  );
}
