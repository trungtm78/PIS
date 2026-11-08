import { useState } from 'react';
import { useTranslation } from '../../../i18n';
import { CommandDialog } from './CommandDialog';
import { FileStep } from './FileStep';
import { useAddVersion, useLinkOptions, useSubmitReview, useUpdateDocument } from './hooks';
import { classLabel, securityLabel } from './labels';
import type { components } from '@machvon/contracts';
import { resourceIdOf } from './model';
import type { DocumentSummary, UploadedFile } from './model';
import { CLASSES, SECURITY } from './RepositoryDialogs';

type Update = components['schemas']['ProjectDocumentUpdate'];

interface EditDialogProps {
  document: DocumentSummary;
  onClose: () => void;
  onDone: () => void;
  onReload: () => void;
}

/** The description of a document (DOC-25): only what changed is sent, under the version of the record the person read; the project never changes and the server judges the links again. */
export function EditDialog({ document, onClose, onDone, onReload }: EditDialogProps) {
  const { t } = useTranslation();
  const update = useUpdateDocument();
  const contracts = useLinkOptions('contract', true);
  const packages = useLinkOptions('package', true);
  const [form, setForm] = useState({
    docClass: document.doc_class,
    title: document.title,
    reference: document.reference ?? '',
    security: document.security_class,
    from: document.effective_from ?? '',
    to: document.effective_to ?? '',
    contractId: document.contract?.id ?? '',
    packageId: document.package?.id ?? '',
    note: document.note ?? '',
  });
  const [hint, setHint] = useState<string | undefined>(undefined);
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]): void => setForm((current) => ({ ...current, [key]: value }));
  const mine = <O extends { projectId: string | null }>(options: O[] | undefined): O[] => (options ?? []).filter((option) => option.projectId === null || option.projectId === document.project.id);

  const submit = (): void => {
    const body: Update = {};
    if (form.docClass !== document.doc_class) body.doc_class = form.docClass;
    if (form.title.trim() !== document.title) body.title = form.title.trim();
    if (form.reference.trim() !== (document.reference ?? '')) body.reference = form.reference.trim() === '' ? null : form.reference.trim();
    if (form.security !== document.security_class) body.security_class = form.security;
    if (form.from !== (document.effective_from ?? '')) body.effective_from = form.from === '' ? null : form.from;
    if (form.to !== (document.effective_to ?? '')) body.effective_to = form.to === '' ? null : form.to;
    if (form.contractId !== (document.contract?.id ?? '')) body.contract_id = form.contractId === '' ? null : form.contractId;
    if (form.packageId !== (document.package?.id ?? '')) body.package_id = form.packageId === '' ? null : form.packageId;
    if (form.note.trim() !== (document.note ?? '')) body.note = form.note.trim() === '' ? null : form.note.trim();
    if (Object.keys(body).length === 0) return setHint(t('doc.repo.edit.nothing'));
    if (form.title.trim().length < 3) return setHint(t('doc.repo.create.missingTitle'));
    if (form.from !== '' && form.to !== '' && form.to < form.from) return setHint(t('doc.repo.create.missingPeriod'));
    setHint(undefined);
    update.mutate({ id: document.id, version: document.version, body }, { onSuccess: onDone });
  };

  return (
    <CommandDialog
      title={t('doc.repo.edit.title')}
      context={[{ label: t('doc.repo.field.title'), value: document.title }]}
      confirmLabel={t('doc.repo.edit.confirm')}
      pending={update.isPending}
      error={update.error ?? undefined}
      hint={hint}
      onCancel={onClose}
      onConfirm={submit}
      onReload={() => {
        onReload();
        onClose();
      }}
    >
      <div className="field">
        <label htmlFor="edit-class">{t('doc.repo.field.class')}</label>
        <select id="edit-class" value={form.docClass} onChange={(event) => set('docClass', event.target.value as typeof form.docClass)}>
          {CLASSES.map((value) => (
            <option key={value} value={value}>
              {classLabel(t, value)}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="edit-title">{t('doc.repo.field.title')}</label>
        <input id="edit-title" type="text" value={form.title} maxLength={300} onChange={(event) => set('title', event.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="edit-reference">{t('doc.repo.field.reference')}</label>
        <input id="edit-reference" type="text" value={form.reference} maxLength={120} onChange={(event) => set('reference', event.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="edit-security">{t('doc.repo.field.security')}</label>
        <select id="edit-security" value={form.security} onChange={(event) => set('security', event.target.value as typeof form.security)}>
          {SECURITY.map((value) => (
            <option key={value} value={value}>
              {securityLabel(t, value)}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="edit-from">{t('doc.repo.field.from')}</label>
        <input id="edit-from" type="date" value={form.from} onChange={(event) => set('from', event.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="edit-to">{t('doc.repo.field.to')}</label>
        <input id="edit-to" type="date" value={form.to} onChange={(event) => set('to', event.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="edit-contract">{t('doc.repo.field.contract')}</label>
        <select id="edit-contract" value={form.contractId} onChange={(event) => set('contractId', event.target.value)}>
          <option value="">{t('doc.repo.field.none')}</option>
          {mine(contracts.data).map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="edit-package">{t('doc.repo.field.package')}</label>
        <select id="edit-package" value={form.packageId} onChange={(event) => set('packageId', event.target.value)}>
          <option value="">{t('doc.repo.field.none')}</option>
          {mine(packages.data).map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="edit-note">{t('doc.repo.field.note')}</label>
        <textarea id="edit-note" value={form.note} maxLength={2000} rows={2} onChange={(event) => set('note', event.target.value)} />
      </div>
    </CommandDialog>
  );
}

interface AddVersionDialogProps {
  document: DocumentSummary;
  onClose: () => void;
  onDone: () => void;
}

/** A new version of a document (DOC-25): the file first, then what changed in it. The new version is a draft; an approved version is never changed, the next change is this. */
export function AddVersionDialog({ document, onClose, onDone }: AddVersionDialogProps) {
  const { t } = useTranslation();
  const add = useAddVersion();
  const [staged, setStaged] = useState<UploadedFile | undefined>(undefined);
  const [note, setNote] = useState('');
  const [hint, setHint] = useState<string | undefined>(undefined);
  return (
    <CommandDialog
      title={t('doc.repo.addVersion.title')}
      context={[{ label: t('doc.repo.field.title'), value: document.title }]}
      confirmLabel={t('doc.repo.addVersion.confirm')}
      pending={add.isPending}
      error={add.error ?? undefined}
      hint={hint}
      onCancel={onClose}
      onConfirm={() => {
        if (staged === undefined) return setHint(t('doc.repo.create.missingFile'));
        setHint(undefined);
        add.mutate({ id: document.id, body: { file_object_key: staged.file_object_key, file_sha256: staged.file_sha256, ...(note.trim() === '' ? {} : { change_note: note.trim() }) } }, { onSuccess: onDone });
      }}
    >
      <FileStep staged={staged} onStaged={setStaged} />
      <div className="field">
        <label htmlFor="version-note">{t('doc.repo.addVersion.note')}</label>
        <textarea id="version-note" value={note} maxLength={2000} rows={2} onChange={(event) => setNote(event.target.value)} />
      </div>
    </CommandDialog>
  );
}

interface SubmitDialogProps {
  document: DocumentSummary;
  versionId: string;
  versionNo: number;
  round: number;
  onClose: () => void;
  onDone: (reviewId: string | undefined) => void;
}

/** A draft version sent to review (DOC-25, PD.01): the stages and the reviewers are the ones of the published workflow, so the dialog only says which version goes and as which round; a missing workflow is said in place. */
export function SubmitDialog({ document, versionId, versionNo, round, onClose, onDone }: SubmitDialogProps) {
  const { t } = useTranslation();
  const submit = useSubmitReview();
  const [note, setNote] = useState('');
  return (
    <CommandDialog
      title={t('doc.repo.submit.title')}
      context={[
        { label: t('doc.repo.field.title'), value: document.title },
        { label: t('doc.repo.submit.version'), value: t('doc.repo.version.number', { no: versionNo }) },
        { label: t('doc.repo.submit.round'), value: String(round) },
      ]}
      confirmLabel={t('doc.repo.submit.confirm')}
      pending={submit.isPending}
      error={submit.error ?? undefined}
      onCancel={onClose}
      onConfirm={() => submit.mutate({ documentId: document.id, versionId, note: note.trim() }, { onSuccess: (result) => onDone(resourceIdOf(result)) })}
    >
      <p className="muted">{t('doc.repo.submit.note')}</p>
      <div className="field">
        <label htmlFor="submit-note">{t('doc.repo.submit.noteLabel')}</label>
        <textarea id="submit-note" value={note} maxLength={2000} rows={2} onChange={(event) => setNote(event.target.value)} />
      </div>
    </CommandDialog>
  );
}
