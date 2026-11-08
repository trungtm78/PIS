import { useRef, useState } from 'react';
import { useTranslation } from '../../../i18n';
import type { FieldSpec } from '../shared/vnd-form';
import { useWriter } from '../shared/vnd-ui';
import { usePortalAttachments, useUploadPortalAttachment } from './portal2-hooks';
import { sizeText, titleOfFile, uploadProblem, PORTAL2_PERMISSION } from './portal2-model';
import type { AttachmentLine, UploadProblem, UploadPurpose } from './portal2-model';
import { uploadPurposeLabel } from './portal2-labels';
import { portalErrorText } from './portal-labels';

const problemText = (t: ReturnType<typeof useTranslation>['t'], problem: UploadProblem, limits: { max_bytes: number }): string => {
  switch (problem) {
    case 'EMPTY':
      return t('po2.upload.problem.empty');
    case 'TOO_LARGE':
      return t('po2.upload.problem.tooLarge', { max: sizeText(limits.max_bytes) });
    case 'TYPE':
      return t('po2.upload.problem.type');
  }
};

/**
 * The control that sends one file to the portal: a file, a title and the purpose given by the place it is used. The type and the size are checked here against the limits the server published (the rule of the tenant), the
 * server judges the bytes again and scans them (a refusal comes back as its own words). Offered only to a caller who holds the right to upload.
 */
export function UploadControl({ purpose, onUploaded, limits }: { purpose: UploadPurpose; onUploaded: (attachment: AttachmentLine) => void; limits: { max_bytes: number; mimes: readonly string[] } }) {
  const { t } = useTranslation();
  const writer = useWriter();
  const upload = useUploadPortalAttachment();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | undefined>(undefined);
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  if (!writer.can(PORTAL2_PERMISSION.upload)) return null;
  const choose = (chosen: File | undefined): void => {
    setError(undefined);
    setFile(chosen);
    setTitle(chosen === undefined ? '' : titleOfFile(chosen.name));
    if (chosen === undefined) return;
    const problem = uploadProblem(chosen, limits);
    if (problem !== null) setError(problemText(t, problem, limits));
  };
  const send = (): void => {
    if (file === undefined || title.trim() === '') return;
    const problem = uploadProblem(file, limits);
    if (problem !== null) {
      setError(problemText(t, problem, limits));
      return;
    }
    setError(undefined);
    upload.mutate(
      { file, purpose, title: title.trim() },
      {
        onSuccess: (attachment) => {
          setFile(undefined);
          setTitle('');
          if (input.current !== null) input.current.value = '';
          onUploaded(attachment);
        },
        onError: (failure) => setError(portalErrorText(t, failure)),
      },
    );
  };
  const blocked = file === undefined || title.trim() === '' || error !== undefined || upload.isPending;
  return (
    <div className="portal-upload" data-testid="upload-control">
      <label>
        {t('po2.upload.file.label')}
        <input ref={input} type="file" accept={limits.mimes.join(',')} data-testid="upload-file" onChange={(event) => choose(event.target.files?.[0])} />
      </label>
      <label>
        {t('po2.upload.title.label')}
        <input type="text" value={title} maxLength={200} data-testid="upload-title" onChange={(event) => setTitle(event.target.value)} />
      </label>
      <p className="vnd-days">{t('po2.upload.limits.text', { max: sizeText(limits.max_bytes), purpose: uploadPurposeLabel(t, purpose) })}</p>
      <button type="button" className="ui-button ui-button--outline ui-button--small" data-testid="upload-send" disabled={blocked} onClick={send}>
        {upload.isPending ? t('po2.upload.sending.text') : t('po2.upload.send.action')}
      </button>
      {error !== undefined && (
        <p role="alert" className="vnd-error" data-testid="upload-error">
          {error}
        </p>
      )}
    </div>
  );
}

/** Chooses one of the own files of the contractor (or sends a new one) for a `document_id` field of a portal command. */
export function AttachmentPicker({ value, set, id, purpose }: { value: string; set: (value: string) => void; id: string; purpose: UploadPurpose }) {
  const { t } = useTranslation();
  const files = usePortalAttachments();
  const items = files.data?.items ?? [];
  const limits = files.data?.limits ?? { max_bytes: 0, mimes: [] as string[] };
  return (
    <div className="vnd-stack" data-testid="attachment-picker">
      <select id={id} aria-labelledby={`${id}-label`} value={value} onChange={(event) => set(event.target.value)}>
        <option value="">{t('po2.picker.none.text')}</option>
        {items.map((item) => (
          <option key={item.id} value={item.document_id}>
            {`${item.title} (${uploadPurposeLabel(t, item.purpose)}, ${sizeText(item.size_bytes)})`}
          </option>
        ))}
      </select>
      {files.isError && <span className="vnd-days">{t('po2.picker.failed.text')}</span>}
      {files.data !== undefined && (
        <UploadControl
          purpose={purpose}
          limits={limits}
          onUploaded={(attachment) => {
            set(attachment.document_id);
          }}
        />
      )}
    </div>
  );
}

/** A field of a portal command that takes the document of an attachment of the contractor: the picker replaces the raw identifier. */
export const attachmentField = (t: ReturnType<typeof useTranslation>['t'], name: string, label: string, purpose: UploadPurpose): FieldSpec => ({
  name,
  label,
  kind: 'custom',
  initial: '',
  hint: t('po2.picker.hint.text'),
  valid: () => true,
  render: (value, set, id) => <AttachmentPicker value={typeof value === 'string' ? value : ''} set={set} id={id} purpose={purpose} />,
});
