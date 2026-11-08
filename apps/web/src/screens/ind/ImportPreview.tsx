import { useState } from 'react';
import { useTranslation } from '../../i18n';
import { DataTable, StatusPill } from '../../ui';
import type { DataTableColumn } from '../../ui';
import { outcomeLabel, rowCodeLabel, rowStatusLabel, rowStatusTone } from './ind-labels';
import { DASH, PREVIEW_ROW_LIMIT, ROW_STATUSES, shortHash, vietnamDateTime } from './ind-model';
import type { Preview, PreviewRow, RowStatus } from './ind-model';
import './ind.css';

/**
 * The dry run of a file (IND-03): the counts of what the apply would take, repeat, set against an earlier row or refuse, and every row with its line, its verdict in words, what the apply would do with it (create
 * the figures, create and open a difference, only open a difference, change nothing) and the reason and field of a refusal. It writes nothing; the verdict can be narrowed to one kind of row.
 */
export function ImportPreview({ preview }: { preview: Preview }) {
  const { t, locale } = useTranslation();
  const [only, setOnly] = useState<RowStatus | ''>('');
  const rows = only === '' ? preview.rows : preview.rows.filter((row) => row.status === only);
  const num = (value: number): string => value.toLocaleString(locale);
  const columns: Array<DataTableColumn<PreviewRow>> = [
    { key: 'line', header: t('ind.imp.column.line'), align: 'right', pinned: true, render: (row) => String(row.line) },
    { key: 'key', header: t('ind.imp.column.key'), render: (row) => row.businessKey ?? DASH },
    {
      key: 'status',
      header: t('ind.imp.column.status'),
      render: (row) => (
        <StatusPill tone={rowStatusTone(row.status)} icon={row.status === 'VALID' ? '✓' : row.status === 'ERROR' ? '✕' : '≠'}>
          {rowStatusLabel(t, row.status)}
        </StatusPill>
      ),
    },
    { key: 'outcome', header: t('ind.imp.column.outcome'), render: (row) => (row.outcome === null ? DASH : outcomeLabel(t, row.outcome)) },
    { key: 'reason', header: t('ind.imp.column.reason'), render: (row) => (row.code === null ? DASH : rowCodeLabel(t, row.code)) },
    { key: 'field', header: t('ind.imp.column.field'), render: (row) => row.field ?? DASH },
    { key: 'row', header: t('ind.imp.column.row'), render: (row) => (row.preview.length === 0 ? DASH : row.preview.map(([key, value]) => `${key}: ${value}`).join(' · ')) },
  ];
  return (
    <div className="ind-preview" data-testid="import-preview">
      <p className="ind-facts-line">
        <span data-testid="preview-mapping">{t('ind.imp.preview.mapping', { code: preview.mappingCode, version: preview.mappingVersion })}</span>
        <span>{t('ind.imp.preview.hash', { hash: shortHash(preview.fileSha256) })}</span>
        <span>{t('ind.imp.preview.checked', { time: vietnamDateTime(preview.checkedAt) })}</span>
      </p>
      {preview.alreadyApplied ? (
        <p className="callout warning" role="status" data-testid="preview-already">
          {t('ind.imp.preview.already')}
        </p>
      ) : null}
      <dl className="ind-counts" data-testid="preview-counts">
        <div>
          <dt>{t('ind.imp.count.total')}</dt>
          <dd>{num(preview.counts.total)}</dd>
        </div>
        <div>
          <dt>{t('ind.imp.count.valid')}</dt>
          <dd>{num(preview.counts.valid)}</dd>
        </div>
        <div>
          <dt>{t('ind.imp.count.errors')}</dt>
          <dd>{num(preview.counts.errors)}</dd>
        </div>
        <div>
          <dt>{t('ind.imp.count.duplicate')}</dt>
          <dd>{num(preview.counts.duplicate)}</dd>
        </div>
        <div>
          <dt>{t('ind.imp.count.conflict')}</dt>
          <dd>{num(preview.counts.conflict)}</dd>
        </div>
      </dl>
      <div className="field ind-narrow">
        <label htmlFor="ind-preview-filter">{t('ind.imp.filter.status')}</label>
        <select id="ind-preview-filter" value={only} onChange={(event) => setOnly(ROW_STATUSES.find((one) => one === event.target.value) ?? '')}>
          <option value="">{t('ind.imp.filter.all')}</option>
          {ROW_STATUSES.map((one) => (
            <option key={one} value={one}>
              {rowStatusLabel(t, one)}
            </option>
          ))}
        </select>
      </div>
      {rows.length === 0 ? (
        <p className="callout" role="status" data-testid="preview-empty">
          {t('ind.imp.preview.empty')}
        </p>
      ) : (
        <div data-testid="preview-rows">
          <DataTable caption={t('ind.imp.preview.caption')} columns={columns} rows={rows} rowKey={(row) => `${row.line}:${row.businessKey ?? ''}`} rowAttrs={(row) => ({ 'data-line': String(row.line), 'data-status': row.status, 'data-outcome': row.outcome ?? undefined })} />
        </div>
      )}
      {preview.rowsTruncated ? (
        <p className="callout" role="status" data-testid="preview-truncated">
          {t('ind.imp.preview.truncated', { n: PREVIEW_ROW_LIMIT })}
        </p>
      ) : null}
    </div>
  );
}
