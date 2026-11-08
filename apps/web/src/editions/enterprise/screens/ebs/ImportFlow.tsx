import { useId, useState } from 'react';
import type { ChangeEvent } from 'react';
import { useTranslation } from '../../../../i18n';
import { DataTable, ReadonlyStat, SectionCard, StatusPill } from '../../../../ui';
import type { DataTableColumn } from '../../../../ui';
import { numberText } from '../shared/format';
import { AcceptanceBadge } from '../shared/parts';
import { useApplyEbsFile, usePreviewEbsFile, useUploadEbsFile } from './hooks';
import { columnWord, ebsErrorText, rowCodeLabel, rowOutcomeLabel, rowStatusLabel } from './labels';
import { PREVIEW_ROWS_SHOWN, applyBlockReason, previewOrder, stepOf } from './model';
import type { Applied, Connection, Preview, PreviewRow, Upload } from './model';

/**
 * The import of a file of Oracle EBS, step by step (EBS-01): pick the file, put it into the shared upload door (judged by its bytes and scanned), read it as a dry run that writes nothing, apply it once. Every
 * refusal is said in words with the line of each fault; a layout that is a working assumption says PENDING-EXTERNAL beside every result.
 */
export function ImportFlow({ connection, canPreview, canApply }: { connection: Connection; canPreview: boolean; canApply: boolean }) {
  const { t, locale } = useTranslation();
  const inputId = useId();
  const upload = useUploadEbsFile();
  const dryRun = usePreviewEbsFile();
  const apply = useApplyEbsFile();
  const [stored, setStored] = useState<Upload | undefined>(undefined);
  const [preview, setPreview] = useState<Preview | undefined>(undefined);
  const [applied, setApplied] = useState<Applied | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const step = stepOf(stored, preview, applied);

  const reset = (): void => {
    setStored(undefined);
    setPreview(undefined);
    setApplied(undefined);
    setError(undefined);
  };

  const pick = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0];
    if (file === undefined) return;
    reset();
    upload.mutateAsync(file).then(setStored, (failure: unknown) => setError(ebsErrorText(t, failure)));
  };

  const read = (): void => {
    if (stored === undefined) return;
    setError(undefined);
    dryRun.mutateAsync({ fileObjectKey: stored.file_object_key, fileSha256: stored.file_sha256 }).then(setPreview, (failure: unknown) => setError(ebsErrorText(t, failure)));
  };

  const write = (): void => {
    if (stored === undefined) return;
    setError(undefined);
    apply.mutateAsync({ fileObjectKey: stored.file_object_key, fileSha256: stored.file_sha256 }).then(
      setApplied,
      (failure: unknown) => setError(ebsErrorText(t, failure)),
    );
  };

  const block = preview === undefined ? null : applyBlockReason(connection, preview);
  const columns: DataTableColumn<PreviewRow>[] = [
    { key: 'line', header: t('ebs.preview.column.line'), align: 'right', pinned: true, render: (row) => row.line },
    { key: 'key', header: t('ebs.preview.column.key'), render: (row) => row.business_key ?? '–' },
    { key: 'status', header: t('ebs.preview.column.status'), render: (row) => <StatusPill tone={row.status === 'VALID' ? 'success' : 'danger'}>{rowStatusLabel(t, row.status)}</StatusPill> },
    { key: 'code', header: t('ebs.preview.column.code'), render: (row) => (row.status === 'VALID' ? rowOutcomeLabel(t, row.outcome ?? null) : `${rowCodeLabel(t, row.code ?? null)}${row.field === null || row.field === undefined ? '' : ` (${columnWord(t, row.field)})`}`) },
  ];
  const shown = preview === undefined ? [] : previewOrder(preview.rows).slice(0, PREVIEW_ROWS_SHOWN);

  return (
    <SectionCard title={t('ebs.import.section.title')} status={<AcceptanceBadge acceptance={connection.acceptance} />}>
      {!canPreview && (
        <p className="ent2-none" data-testid="import-denied">
          {t('ebs.import.denied.text')}
        </p>
      )}
      {canPreview && (
        <div className="ent2-flow" data-testid="import-flow" data-step={step}>
          <div className="ent2-field">
            <label htmlFor={inputId}>{t('ebs.import.pick.label')}</label>
            <input id={inputId} type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" disabled={upload.isPending} onChange={pick} data-testid="import-file" />
            <span className="ent2-field__hint">{t('ebs.import.pick.hint')}</span>
          </div>
          {error !== undefined && (
            <p className="ui-dialog__error" role="alert" data-testid="import-error">
              {error}
            </p>
          )}
          {stored !== undefined && (
            <div data-testid="upload-result">
              <p>{t('ebs.import.uploaded.text', { rows: numberText(stored.row_count, locale), format: stored.format })}</p>
              {stored.matches_layout ? (
                <p className="ent2-receipt callout" role="status">
                  {t('ebs.import.layout.fits.text')}
                </p>
              ) : (
                <p className="callout" role="alert" data-testid="upload-missing">
                  {t('ebs.import.layout.missing.text', { columns: stored.missing_columns.map((column) => columnWord(t, column)).join(', ') })}
                </p>
              )}
              {preview === undefined && applied === undefined && (
                <button type="button" className="ui-button ui-button--primary" data-testid="dry-run-button" disabled={dryRun.isPending || !stored.matches_layout} onClick={read}>
                  {t('ebs.import.dryRun.action')}
                </button>
              )}
            </div>
          )}
          {preview !== undefined && (
            <div data-testid="preview-result">
              <p className="ent2-note">{preview.already_applied ? t('ebs.import.preview.already.text') : t('ebs.import.preview.note.text')}</p>
              <ul className="ent2-stats" data-testid="preview-counts">
                <li>
                  <ReadonlyStat label={t('ebs.import.counts.total.label')} value={numberText(preview.counts.total, locale)} />
                </li>
                <li>
                  <ReadonlyStat label={t('ebs.import.counts.valid.label')} value={numberText(preview.counts.valid, locale)} tone="success" />
                </li>
                <li>
                  <ReadonlyStat label={t('ebs.import.counts.errors.label')} value={numberText(preview.counts.errors, locale)} tone={preview.counts.errors > 0 ? 'danger' : 'neutral'} />
                </li>
              </ul>
              <DataTable caption={t('ebs.import.preview.caption')} columns={columns} rows={shown} rowKey={(row) => String(row.line)} rowAttrs={(row) => ({ 'data-line': String(row.line), 'data-status': row.status })} />
              {(preview.rows_truncated || preview.rows.length > PREVIEW_ROWS_SHOWN) && <p className="ent2-note">{t('ebs.import.preview.cut.text', { shown: PREVIEW_ROWS_SHOWN })}</p>}
              {applied === undefined && canApply && (
                <div className="ent2-more">
                  <button type="button" className="ui-button ui-button--primary" data-testid="apply-button" disabled={apply.isPending || block !== null} onClick={write}>
                    {t('ebs.import.apply.action')}
                  </button>
                  {block !== null && (
                    <span className="ent2-note" data-testid="apply-blocked">
                      {block === 'DISABLED' ? t('ebs.import.blocked.disabled') : block === 'ALREADY_APPLIED' ? t('ebs.import.blocked.already') : t('ebs.import.blocked.nothing')}
                    </span>
                  )}
                </div>
              )}
              {applied === undefined && !canApply && (
                <p className="ent2-note" data-testid="apply-right">
                  {t('ebs.import.apply.right.text')}
                </p>
              )}
            </div>
          )}
          {applied !== undefined && (
            <div className="callout ent2-receipt" role="status" data-testid="apply-result">
              <p>{t('ebs.import.applied.text', { applied: numberText(applied.counts.applied, locale), quarantined: numberText(applied.counts.quarantined, locale), unknown: numberText(applied.unknown_projects, locale) })}</p>
              <button type="button" className="ui-button ui-button--outline ui-button--small" data-testid="import-again" onClick={reset}>
                {t('ebs.import.again.action')}
              </button>
            </div>
          )}
        </div>
      )}
    </SectionCard>
  );
}
