import { useState } from 'react';
import { useTranslation } from '../../../i18n';
import type { UploadedFile } from '../../prj/national-code-import-model';
import { useImportProcurementFile, useUploadProcurementFile } from './hooks';
import { IMPORT_ACCEPT, describeImportProblem, resultOfProblem } from './import-model';
import type { ImportResult } from './import-model';
import { importProblemMessage, importRowMessage, milestoneLabel } from './labels';
import { MILESTONE_KINDS } from './model';
import type { MilestoneKind } from './model';
import '../bid.css';

export interface ImportPanelProps {
  /** The caller holds the permission and the session is not read-only. */
  canImport: boolean;
  /** The caller holds the permission on the whole tenant, which applying the file needs; undefined while that is being read. */
  wholeTenant: boolean | undefined;
}

const kindOf = (value: string | null): MilestoneKind | undefined => MILESTONE_KINDS.find((kind) => kind === value);

/**
 * The file of the national bidding system on BID-19 (ST-BID-005, F8): the planner chooses the file downloaded from the national system, the server reads it without writing
 * anything (the dry run: row by row, what would be taken and what refused and why), and only then is it applied, once. The adapter is a proposal and nothing here calls the
 * national system.
 */
export function ProcurementImportPanel({ canImport, wholeTenant }: ImportPanelProps) {
  const { t } = useTranslation();
  const upload = useUploadProcurementFile();
  const run = useImportProcurementFile();
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
        run.mutate({ fileObjectKey: uploaded.fileObjectKey, fileSha256: uploaded.fileSha256, mode: 'DRY_RUN' }, { onSuccess: (result) => setPreview(result) });
      },
    });
  };

  const apply = (): void => {
    if (stored === undefined || run.isPending) return;
    run.mutate(
      { fileObjectKey: stored.fileObjectKey, fileSha256: stored.fileSha256, mode: 'APPLY' },
      {
        onSuccess: (result) => setApplied(result),
        onError: (error) => setRefused(resultOfProblem(error)),
      },
    );
  };

  const shown = applied ?? refused ?? preview;
  const done = applied !== undefined || refused !== undefined;
  const canApply = stored !== undefined && preview !== undefined && !preview.alreadyApplied && preview.counts.valid > 0 && applied === undefined && !run.isPending;

  return (
    <article className="card" aria-label={t('bid.import.title')} data-testid="import-panel">
      <h2>{t('bid.import.title')}</h2>
      <p className="callout" role="status" data-testid="adapter-note">
        {t('bid.import.adapter.note')}
      </p>
      <p className="sub">{t('bid.import.layout.note')}</p>
      {!canImport ? (
        <p className="callout" role="status" data-testid="import-denied">
          {t('bid.import.denied.notice')}
        </p>
      ) : (
        <div className="formgrid">
          <div className="field">
            <label htmlFor="procurement-file">{t('bid.import.file.label')}</label>
            <input id="procurement-file" type="file" accept={IMPORT_ACCEPT} onChange={(event) => reset(event.target.files?.[0])} />
          </div>
          <div className="formfooter">
            <button type="button" className="button primary" disabled={file === undefined || upload.isPending || run.isPending} onClick={check}>
              {upload.isPending || (run.isPending && !done && preview === undefined) ? t('bid.import.check.pending') : t('bid.import.check.action')}
            </button>
          </div>
        </div>
      )}
      {canImport && wholeTenant === false ? (
        <p className="callout" role="status" data-testid="import-scope-notice">
          {t('bid.import.wholeTenant.notice')}
        </p>
      ) : null}
      {failure === undefined ? null : (
        <p className="callout warning" role="alert" data-testid="import-problem">
          {importProblemMessage(t, failure)}
        </p>
      )}
      {stored === undefined ? null : <p data-testid="import-file">{t('bid.import.file.text', { rows: stored.rowCount, format: stored.format.toUpperCase() })}</p>}
      {shown === undefined ? null : (
        <div data-testid="import-result">
          <p role="status" data-testid="import-counts">
            {!done
              ? t('bid.import.preview.counts', { total: shown.counts.total, valid: shown.counts.valid, repeats: shown.counts.duplicate + shown.counts.conflict, errors: shown.counts.errors })
              : t('bid.import.applied.counts', { written: shown.written, errors: shown.counts.errors, differences: shown.differences })}
          </p>
          {shown.alreadyApplied ? (
            <p className="callout warning" role="status" data-testid="import-already">
              {t('bid.import.already.notice')}
            </p>
          ) : null}
          {shown.rows.length === 0 ? null : (
            <table className="table" data-testid="import-rows">
              <caption>{!done ? t('bid.import.rows.preview.caption') : t('bid.import.rows.errors.caption')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('bid.import.rows.line')}</th>
                  <th scope="col">{t('bid.import.rows.package')}</th>
                  <th scope="col">{t('bid.import.rows.milestone')}</th>
                  <th scope="col">{t('bid.import.rows.result')}</th>
                </tr>
              </thead>
              <tbody>
                {shown.rows.map((row) => {
                  const kind = kindOf(row.milestoneKind);
                  return (
                    <tr key={`${row.line}-${row.status}`} data-line={row.line} data-status={row.status}>
                      <th scope="row">{row.line}</th>
                      <td>{row.packageCode ?? t('bid.import.rows.none')}</td>
                      <td>{kind === undefined ? (row.milestoneKind ?? t('bid.import.rows.none')) : milestoneLabel(t, kind)}</td>
                      <td>{importRowMessage(t, row)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {shown.truncated ? <p className="sub">{t('bid.import.rows.truncated')}</p> : null}
          {canImport && wholeTenant === true && stored !== undefined && !done ? (
            <div className="formfooter">
              <button type="button" className="button primary" disabled={!canApply} onClick={apply}>
                {run.isPending ? t('bid.import.apply.pending') : t('bid.import.apply.action')}
              </button>
            </div>
          ) : null}
          {applied === undefined ? null : (
            <p role="status" data-testid="import-applied">
              {t('bid.import.applied.notice')}
            </p>
          )}
        </div>
      )}
    </article>
  );
}
