import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import { DataTable, InfoFormula, KpiStrip, KpiTile, StatusPill } from '../../../ui';
import type { DataTableColumn, Tone } from '../../../ui';
import { AcceptanceBadge, DASH } from './import-components';
import { infoLabels, kindLabel, outcomeLabel, previewRowCodeLabel, statusLabel, statusTone } from './import-labels';
import { PATH_CONNECTION, PREVIEW_ROW_LIMIT, ROW_STATUSES, filterRows, shortHash, vietnamDateTime } from './import-model';
import type { Preview, PreviewRow, RowStatus, StatusFilter } from './import-model';
import './import.css';

type TileKey = RowStatus | 'TOTAL';

/** One figure of the dry run with its "i": the formula is the count of rows by verdict, the source is the file and the layout version, the day is the time of the dry run. */
function Tile({ tile, preview, locale }: { tile: TileKey; preview: Preview; locale: string }) {
  const { t } = useTranslation();
  const counts = preview.counts;
  const value = tile === 'TOTAL' ? counts.total : tile === 'VALID' ? counts.valid : tile === 'ERROR' ? counts.errors : tile === 'DUPLICATE' ? counts.duplicate : counts.conflict;
  const label =
    tile === 'TOTAL'
      ? t('egp.import.tile.total.label')
      : tile === 'VALID'
        ? t('egp.import.tile.valid.label')
        : tile === 'ERROR'
          ? t('egp.import.tile.errors.label')
          : tile === 'DUPLICATE'
            ? t('egp.import.tile.duplicate.label')
            : t('egp.import.tile.conflict.label');
  const tone: Tone = tile === 'VALID' && value > 0 ? 'success' : tile === 'ERROR' && value > 0 ? 'danger' : tile === 'CONFLICT' && value > 0 ? 'warning' : 'default';
  const formula = tile === 'TOTAL' ? t('egp.import.tileInfo.total') : t('egp.import.tileInfo.verdict', { verdict: statusLabel(t, tile) });
  return (
    <KpiTile
      label={label}
      value={value.toLocaleString(locale)}
      unit={t('egp.import.tile.unit')}
      tone={tone}
      sub={
        <InfoFormula
          name={label}
          formula={formula}
          source={t('egp.import.tileInfo.source', { hash: shortHash(preview.fileSha256), layout: preview.layoutVersion })}
          asOf={vietnamDateTime(preview.ranAt)}
          owner={t('egp.import.tileInfo.owner')}
          version={t('egp.import.tileInfo.version', { layout: preview.layoutVersion })}
          unverified={preview.acceptance === 'PENDING_EXTERNAL'}
          labels={infoLabels(t, label)}
        />
      }
    />
  );
}

/**
 * The result of a dry run (BR-BID-13: nothing was written): the layout and its acceptance word, the five figures, the verdict of every row with its reason, the field and what the apply would do with it.
 * A dry run with error rows is shown whole (partial state), never hidden; a file that was loaded before, or a connection that is off, is said at the top.
 */
export function ImportPreview({ preview }: { preview: Preview }) {
  const { t, locale } = useTranslation();
  const [status, setStatus] = useState<StatusFilter>('');
  const shown = useMemo(() => filterRows(preview.rows, status), [preview.rows, status]);
  const columns: Array<DataTableColumn<PreviewRow>> = [
    { key: 'line', header: t('egp.import.column.line'), align: 'right', pinned: true, render: (row) => row.line },
    { key: 'key', header: t('egp.import.column.key'), render: (row) => row.businessKey ?? DASH },
    {
      key: 'status',
      header: t('egp.import.column.result'),
      render: (row) => (
        <StatusPill tone={statusTone(row.status)} icon={row.status === 'VALID' ? '✓' : row.status === 'ERROR' ? '✕' : '≈'}>
          {statusLabel(t, row.status)}
        </StatusPill>
      ),
    },
    { key: 'code', header: t('egp.import.column.code'), render: (row) => previewRowCodeLabel(t, row) ?? DASH },
    { key: 'field', header: t('egp.import.column.field'), render: (row) => (row.field === null || row.field === '' ? DASH : <code>{row.field}</code>) },
    { key: 'outcome', header: t('egp.import.column.outcome'), render: (row) => outcomeLabel(t, row) },
  ];
  return (
    <div data-testid="import-preview" data-kind={preview.kind}>
      <p className="egpi-facts" data-testid="preview-facts">
        <span>{t('egp.import.preview.mode', { mode: t('egp.import.mode.dryRun') })}</span>
        <span>{t('egp.import.preview.kind', { kind: kindLabel(t, preview.kind) })}</span>
        <span data-testid="preview-layout">{t('egp.import.preview.layout', { version: preview.layoutVersion })}</span>
        <AcceptanceBadge acceptance={preview.acceptance} />
      </p>
      {preview.alreadyApplied ? (
        <p className="callout warning" role="status" data-testid="import-already">
          {t('egp.import.preview.already')}
        </p>
      ) : null}
      {!preview.connectionEnabled ? (
        <p className="callout warning" role="status" data-testid="import-disabled">
          {t('egp.import.preview.disabled')} <Link to={PATH_CONNECTION}>{t('egp.import.link.connection')}</Link>
        </p>
      ) : null}
      {preview.counts.errors > 0 ? (
        <p className="callout" role="status" data-testid="import-partial">
          {t('egp.import.preview.partial', { errors: preview.counts.errors })}
        </p>
      ) : null}
      <KpiStrip label={t('egp.import.tile.group.label')}>
        <Tile tile="VALID" preview={preview} locale={locale} />
        <Tile tile="ERROR" preview={preview} locale={locale} />
        <Tile tile="DUPLICATE" preview={preview} locale={locale} />
        <Tile tile="CONFLICT" preview={preview} locale={locale} />
        <Tile tile="TOTAL" preview={preview} locale={locale} />
      </KpiStrip>
      <div className="field egpi-filter">
        <label htmlFor="egp-import-status">{t('egp.import.filter.status.label')}</label>
        <select id="egp-import-status" value={status} onChange={(event) => setStatus(event.target.value as StatusFilter)}>
          <option value="">{t('egp.import.filter.all')}</option>
          {ROW_STATUSES.map((value) => (
            <option key={value} value={value}>
              {statusLabel(t, value)}
            </option>
          ))}
        </select>
      </div>
      <div data-testid="preview-rows">
        <DataTable
          caption={t('egp.import.preview.caption')}
          columns={columns}
          rows={shown}
          rowKey={(row) => `${row.line}:${row.status}:${row.businessKey ?? ''}`}
          rowAttrs={(row) => ({ 'data-line': String(row.line), 'data-status': row.status })}
          emptyKind={status === '' ? 'none' : 'filtered'}
          onClearFilters={() => setStatus('')}
        />
      </div>
      {preview.rowsTruncated ? (
        <p className="sub" role="status" data-testid="preview-truncated">
          {t('egp.import.preview.truncated', { shown: PREVIEW_ROW_LIMIT, total: preview.counts.total })}
        </p>
      ) : null}
    </div>
  );
}
