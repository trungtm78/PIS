import { useState } from 'react';
import { useTranslation } from '../../i18n';
import { useImportNationalCodes, useUploadNationalCodeFile } from './national-code-import-hooks';
import { IMPORT_ACCEPT, describeImportProblem, resultOfProblem } from './national-code-import-model';
import type { ImportProblem, ImportResult, ImportRow, UploadedFile } from './national-code-import-model';
import './prj.css';

type Translate = ReturnType<typeof useTranslation>['t'];

function problemText(t: Translate, problem: ImportProblem): string {
  switch (problem) {
    case 'alreadyApplied':
      return t('prj.reconcile.importProblem.alreadyApplied.error');
    case 'hasErrors':
      return t('prj.reconcile.importProblem.hasErrors.error');
    case 'hashMismatch':
      return t('prj.reconcile.importProblem.hashMismatch.error');
    case 'schemaInvalid':
      return t('prj.reconcile.importProblem.schemaInvalid.error');
    case 'empty':
      return t('prj.reconcile.importProblem.empty.error');
    case 'fileRefused':
      return t('prj.reconcile.importProblem.fileRefused.error');
    case 'versionConflict':
      return t('prj.reconcile.importProblem.versionConflict.error');
    case 'notFound':
      return t('prj.reconcile.importProblem.notFound.error');
    case 'denied':
      return t('prj.reconcile.importProblem.denied.error');
    case 'general':
      return t('prj.reconcile.importProblem.general.error');
  }
}

function rowCode(t: Translate, row: ImportRow): string {
  if (row.code !== null) {
    switch (row.code) {
      case 'NATIONAL_CODE_DUPLICATE':
        return t('prj.reconcile.importRow.duplicate.text');
      case 'NATIONAL_CODE_FORMAT_INVALID':
        return t('prj.reconcile.importRow.format.text');
      case 'PROJECT_NOT_FOUND':
        return t('prj.reconcile.importRow.notFound.text');
      case 'PROJECT_STAGE_LOCKED':
        return t('prj.reconcile.importRow.locked.text');
      case 'INTERNAL_CODE_EMPTY':
      case 'NATIONAL_CODE_EMPTY':
        return t('prj.reconcile.importRow.empty.text');
      case 'CODE_INVALID':
        return t('prj.reconcile.importRow.invalid.text');
      default:
        return t('prj.reconcile.importRow.other.text', { code: row.code });
    }
  }
  switch (row.outcome) {
    case 'ASSIGN':
      return t('prj.reconcile.importRow.assign.text');
    case 'UNCHANGED':
      return t('prj.reconcile.importRow.unchanged.text');
    case 'MISMATCH':
      return t('prj.reconcile.importRow.mismatch.text');
    default:
      return row.status === 'DUPLICATE' ? t('prj.reconcile.importRow.repeat.text') : row.status === 'CONFLICT' ? t('prj.reconcile.importRow.conflict.text') : t('prj.reconcile.importRow.valid.text');
  }
}

export interface ImportPanelProps {
  /** The caller holds the permission and the session is not read-only. */
  canImport: boolean;
  /** The caller holds the permission on the whole tenant, which applying the file needs; undefined while that is being read. */
  wholeTenant: boolean | undefined;
}

/**
 * The reconciliation file of PRJ-21 (ST-PRJ-004, F7): the planning officer chooses the file downloaded from the national system, the server checks it
 * without writing anything (the dry run: row by row, what would be taken and what refused and why), and only then is it applied, once. The adapter
 * is a proposal and nothing here calls the national system.
 */
export function NationalCodeImportPanel({ canImport, wholeTenant }: ImportPanelProps) {
  const { t } = useTranslation();
  const upload = useUploadNationalCodeFile();
  const run = useImportNationalCodes();
  const [file, setFile] = useState<File | undefined>(undefined);
  const [stored, setStored] = useState<UploadedFile | undefined>(undefined);
  const [preview, setPreview] = useState<ImportResult | undefined>(undefined);
  const [applied, setApplied] = useState<ImportResult | undefined>(undefined);
  const [refused, setRefused] = useState<ImportResult | undefined>(undefined);
  const failure = upload.isError ? describeImportProblem(upload.error) : run.isError ? describeImportProblem(run.error) : undefined;

  const reset = (next: File | undefined): void => {
    setFile(next);
    setStored(undefined);
    setPreview(undefined);
    setApplied(undefined);
    setRefused(undefined);
    upload.reset();
    run.reset();
  };

  const check = (): void => {
    if (file === undefined || upload.isPending || run.isPending) return;
    upload.mutate(file, {
      onSuccess: (uploaded) => {
        if (uploaded === undefined) return;
        setStored(uploaded);
        run.mutate({ fileObjectKey: uploaded.fileObjectKey, fileSha256: uploaded.fileSha256, dryRun: true }, { onSuccess: (result) => setPreview(result) });
      },
    });
  };

  const apply = (): void => {
    if (stored === undefined || run.isPending) return;
    run.mutate(
      { fileObjectKey: stored.fileObjectKey, fileSha256: stored.fileSha256, dryRun: false },
      {
        onSuccess: (result) => setApplied(result),
        onError: (error) => setRefused(resultOfProblem(error)),
      },
    );
  };

  const shown = applied ?? refused ?? preview;
  const canApply = stored !== undefined && preview !== undefined && !preview.alreadyApplied && preview.counts.valid > 0 && applied === undefined && !run.isPending;

  return (
    <article className="card" aria-label={t('prj.reconcile.import.title')} data-testid="import-panel">
      <h2>{t('prj.reconcile.import.title')}</h2>
      <p className="sub">{t('prj.reconcile.import.layout.note')}</p>
      {!canImport ? (
        <p className="callout" role="status" data-testid="import-denied">
          {t('prj.reconcile.import.denied.notice')}
        </p>
      ) : (
        <div className="formgrid">
          <div className="field">
            <label htmlFor="national-code-file">{t('prj.reconcile.import.file.label')}</label>
            <input id="national-code-file" type="file" accept={IMPORT_ACCEPT} onChange={(event) => reset(event.target.files?.[0])} />
          </div>
          <div className="formfooter">
            <button type="button" className="button primary" disabled={file === undefined || upload.isPending || run.isPending} onClick={check}>
              {upload.isPending || (run.isPending && applied === undefined && preview === undefined) ? t('prj.reconcile.import.check.pending') : t('prj.reconcile.import.check.action')}
            </button>
          </div>
        </div>
      )}
      {canImport && wholeTenant === false ? (
        <p className="callout" role="status" data-testid="import-scope-notice">
          {t('prj.reconcile.import.wholeTenant.notice')}
        </p>
      ) : null}
      {failure === undefined ? null : (
        <p className="callout warning" role="alert" data-testid="import-problem">
          {problemText(t, failure)}
        </p>
      )}
      {stored === undefined ? null : (
        <p data-testid="import-file">{t('prj.reconcile.import.file.text', { rows: stored.rowCount, format: stored.format.toUpperCase() })}</p>
      )}
      {shown === undefined ? null : (
        <div data-testid="import-result">
          <p role="status" data-testid="import-counts">
            {applied === undefined && refused === undefined
              ? t('prj.reconcile.import.preview.counts', { total: shown.counts.total, valid: shown.counts.valid, repeats: shown.counts.duplicate + shown.counts.conflict, errors: shown.counts.errors })
              : t('prj.reconcile.import.applied.counts', { assigned: shown.assigned, errors: shown.counts.errors, differences: shown.differences })}
          </p>
          {shown.alreadyApplied ? (
            <p className="callout warning" role="status" data-testid="import-already">
              {t('prj.reconcile.import.already.notice')}
            </p>
          ) : null}
          {shown.rows.length === 0 ? null : (
            <table className="table" data-testid="import-rows">
              <caption>{applied === undefined && refused === undefined ? t('prj.reconcile.importRows.preview.caption') : t('prj.reconcile.importRows.errors.caption')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('prj.reconcile.importRows.line.header')}</th>
                  <th scope="col">{t('prj.reconcile.column.code')}</th>
                  <th scope="col">{t('prj.reconcile.column.nationalCode')}</th>
                  <th scope="col">{t('prj.reconcile.importRows.result.header')}</th>
                </tr>
              </thead>
              <tbody>
                {shown.rows.map((row) => (
                  <tr key={`${row.line}-${row.status}`} data-line={row.line} data-status={row.status}>
                    <th scope="row">{row.line}</th>
                    <td>{row.internalCode ?? t('prj.reconcile.importRows.none')}</td>
                    <td>{row.nationalCode ?? t('prj.reconcile.importRows.none')}</td>
                    <td>{rowCode(t, row)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {shown.truncated ? <p className="sub">{t('prj.reconcile.importRows.truncated.notice')}</p> : null}
          {canImport && wholeTenant === true && stored !== undefined && applied === undefined && refused === undefined ? (
            <div className="formfooter">
              <button type="button" className="button primary" disabled={!canApply} onClick={apply}>
                {run.isPending ? t('prj.reconcile.import.apply.pending') : t('prj.reconcile.import.apply.action')}
              </button>
            </div>
          ) : null}
          {applied === undefined ? null : (
            <p role="status" data-testid="import-applied">
              {t('prj.reconcile.import.applied.notice')}
            </p>
          )}
        </div>
      )}
    </article>
  );
}
