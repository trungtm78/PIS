import { useState } from 'react';
import { useTranslation } from '../../i18n';
import { useImportParcels, useUploadParcelFile } from './import-hooks';
import { IMPORT_ACCEPT, columnsOfProblem, describeImportProblem } from './import-model';
import type { ImportProblem, ImportResult, UploadedFile } from './import-model';
import './lnd.css';

type Translate = ReturnType<typeof useTranslation>['t'];

function problemText(t: Translate, problem: ImportProblem): string {
  switch (problem) {
    case 'hashMismatch':
      return t('lnd.import.problem.hashMismatch.error');
    case 'schemaInvalid':
      return t('lnd.import.problem.schemaInvalid.error');
    case 'empty':
      return t('lnd.import.problem.empty.error');
    case 'fileRefused':
      return t('lnd.import.problem.fileRefused.error');
    case 'notFound':
      return t('lnd.import.problem.notFound.error');
    case 'denied':
      return t('lnd.import.problem.denied.error');
    case 'general':
      return t('lnd.import.problem.general.error');
  }
}

function resultText(t: Translate, result: ImportResult): string {
  const counts = { total: result.total, created: result.created, duplicate: result.duplicate, conflict: result.conflict, refused: result.refused };
  switch (result.outcome) {
    case 'APPLIED':
      return t('lnd.import.result.applied.text', counts);
    case 'PARTIALLY_APPLIED':
      return t('lnd.import.result.partial.text', counts);
    case 'ALREADY_IMPORTED':
      return t('lnd.import.result.repeated.text', counts);
  }
}

export interface ImportPanelProps {
  projectId: string;
  /** The caller holds the permission and the session is not read-only. */
  canImport: boolean;
}

/**
 * The parcel list of LND-02 (ST-LND-001, AC-ST-LND-001-2): the officer chooses the file, the server scans it, checks its columns and stores it, and only
 * then is it imported, once. A file with a column for an owner or a user of the land is refused at the door and kept nowhere, so the panel names such a
 * column and offers no import. The same file twice creates nothing the second time.
 */
export function ImportPanel({ projectId, canImport }: ImportPanelProps) {
  const { t } = useTranslation();
  const upload = useUploadParcelFile();
  const run = useImportParcels();
  const [file, setFile] = useState<File | undefined>(undefined);
  const [stored, setStored] = useState<UploadedFile | undefined>(undefined);
  const [result, setResult] = useState<ImportResult | undefined>(undefined);
  const failure = upload.isError ? describeImportProblem(upload.error) : run.isError ? describeImportProblem(run.error) : undefined;
  const columns = upload.isError ? columnsOfProblem(upload.error) : { unknown: [], missing: [] };

  const choose = (next: File | undefined): void => {
    setFile(next);
    setStored(undefined);
    setResult(undefined);
    upload.reset();
    run.reset();
  };
  const check = (): void => {
    if (file === undefined || upload.isPending) return;
    upload.mutate(file, { onSuccess: (uploaded) => setStored(uploaded) });
  };
  const importNow = (): void => {
    if (stored === undefined || run.isPending) return;
    run.mutate({ projectId, fileObjectId: stored.fileObjectId, fileSha256: stored.fileSha256 }, { onSuccess: (done) => setResult(done) });
  };
  const ready = stored !== undefined && result === undefined;

  return (
    <article className="card" aria-label={t('lnd.import.title.text')} data-testid="import-panel">
      <h2>{t('lnd.import.title.text')}</h2>
      <p className="sub">{t('lnd.import.layout.note')}</p>
      <p className="sub" data-testid="import-privacy">
        {t('lnd.import.privacy.note')}
      </p>
      {!canImport ? (
        <p className="callout" role="status" data-testid="import-denied">
          {t('lnd.import.denied.notice')}
        </p>
      ) : (
        <>
          <div className="field">
            <label htmlFor="parcel-file">{t('lnd.import.file.label')}</label>
            <input id="parcel-file" type="file" accept={IMPORT_ACCEPT} onChange={(event) => choose(event.target.files?.[0])} />
          </div>
          <div className="formfooter">
            <button type="button" disabled={file === undefined || upload.isPending || run.isPending} onClick={check}>
              {upload.isPending ? t('lnd.import.check.pending') : t('lnd.import.check.action')}
            </button>
            <button type="button" className="primary" disabled={!ready || run.isPending} onClick={importNow}>
              {run.isPending ? t('lnd.import.run.pending') : t('lnd.import.run.action')}
            </button>
          </div>
        </>
      )}
      {failure === undefined ? null : (
        <p className="callout warning" role="alert" data-testid="import-refusal">
          {problemText(t, failure)}
        </p>
      )}
      {columns.unknown.length === 0 ? null : (
        <p className="callout warning" data-testid="import-unknown">
          {t('lnd.import.unknown.error', { columns: columns.unknown.join(', ') })}
        </p>
      )}
      {columns.missing.length === 0 ? null : (
        <p className="callout warning" data-testid="import-missing">
          {t('lnd.import.missing.error', { columns: columns.missing.join(', ') })}
        </p>
      )}
      {stored === undefined ? null : (
        <p data-testid="import-layout" role="status">
          {t('lnd.import.stored.text', { rows: stored.rowCount, format: stored.format })}
        </p>
      )}
      {result === undefined ? null : (
        <p role="status" data-testid="import-result" data-outcome={result.outcome}>
          {resultText(t, result)}
        </p>
      )}
    </article>
  );
}
