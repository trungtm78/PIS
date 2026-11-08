import { useId } from 'react';
import { useTranslation } from '../../../i18n';
import { formatLabel, problemText } from './labels';
import { sizeText } from './model';
import type { UploadedFile } from './model';
import { useUploadFile } from './hooks';

const ACCEPT = '.pdf,.docx,.xlsx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

interface FileStepProps {
  staged: UploadedFile | undefined;
  onStaged: (file: UploadedFile | undefined) => void;
}

/**
 * The first step of a new document or a new version: the file goes into the shared upload pipeline (judged by its bytes, scanned, stored under the tenant) as soon as it is chosen; what comes back (format, size, pages, hash)
 * is shown so the person sees what the next command will keep. A refused file is said in place with its reason, and a new choice replaces it.
 */
export function FileStep({ staged, onStaged }: FileStepProps) {
  const { t } = useTranslation();
  const upload = useUploadFile();
  const id = useId();
  const size = staged === undefined ? undefined : sizeText(staged.size_bytes);
  return (
    <div className="field" data-testid="file-step">
      <label htmlFor={id}>{t('doc.repo.file.label')}</label>
      <input
        id={id}
        type="file"
        accept={ACCEPT}
        disabled={upload.isPending}
        data-testid="file-input"
        onChange={(event) => {
          const file = event.target.files?.[0];
          onStaged(undefined);
          if (file === undefined) return;
          upload.mutate(file, { onSuccess: (done) => onStaged(done) });
        }}
      />
      <p className="muted">{t('doc.repo.file.hint')}</p>
      {upload.isPending && (
        <p role="status" data-testid="file-uploading">
          {t('doc.repo.file.uploading')}
        </p>
      )}
      {upload.isError && (
        <p role="alert" className="callout warning" data-testid="file-error">
          {problemText(t, upload.error)}
        </p>
      )}
      {staged !== undefined && size !== undefined && (
        <p className="callout" role="status" data-testid="file-staged">
          {t('doc.repo.file.staged', {
            format: formatLabel(t, staged.format),
            size: size.value,
            unit: size.unit,
            pages: staged.page_count === null ? t('doc.repo.file.noPages') : t('doc.repo.file.pages', { count: staged.page_count }),
          })}
        </p>
      )}
    </div>
  );
}
