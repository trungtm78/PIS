import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { Translator } from '../../i18n';
import { DataTable, KpiStrip, KpiTile, SectionCard, StatusPill } from '../../ui';
import type { DataTableColumn, Tone } from '../../ui';
import { useFeedRun } from './feed-hooks';
import { kindLabel, needLabel, outcomeLabel, previewCodeLabel, rowCodeLabel, rowStatusLabel, rowStatusTone, runActionLabel } from './feed-labels';
import { PATHS, PREVIEW_ROW_LIMIT, ROW_STATUSES, filterRows, isForbidden, numberText, previewPairs, shortHash, vietnamStamp } from './feed-model';
import type { Applied, Layout, Preview, PreviewRow, Run, RowError, RowStatus, StatusFilter } from './feed-model';
import { AcceptanceBadge, ChannelTag, DASH, Figure, HashCell, ListState } from './feed-parts';
import './feed.css';

/** What a run was: the kind of the file, or the move of the data generator. */
function runWhat(t: Translator['t'], run: Run): string {
  return run.kind === null ? runActionLabel(t, run.action) : kindLabel(t, run.kind);
}

export interface RunsTableProps {
  runs: readonly Run[];
  caption: string;
  selectedId?: string | undefined;
  /** When given, each row has a button that opens its detail. */
  onOpen?: ((run: Run) => void) | undefined;
}

/** The runs of the feed, a file or a move of the generator alike: the channel is a small provenance column, the layout carries its acceptance word, the counts carry their "i". */
export function RunsTable({ runs, caption, selectedId, onOpen }: RunsTableProps) {
  const { t, locale } = useTranslation();
  const columns: Array<DataTableColumn<Run>> = [
    { key: 'at', header: t('feed.runs.column.at'), pinned: true, render: (row) => vietnamStamp(row.createdAt) },
    { key: 'what', header: t('feed.runs.column.what'), render: (row) => runWhat(t, row) },
    { key: 'channel', header: t('feed.runs.column.channel'), render: (row) => <ChannelTag channel={row.channel} /> },
    {
      key: 'layout',
      header: t('feed.runs.column.layout'),
      render: (row) => (
        <span className="feed-stack">
          <code>{row.layoutVersion}</code>
          <AcceptanceBadge acceptance={row.acceptance} />
        </span>
      ),
    },
    {
      key: 'source',
      header: t('feed.runs.column.source'),
      render: (row) =>
        row.fileSha256 !== null ? (
          <HashCell hash={row.fileSha256} />
        ) : row.seed !== null ? (
          <span data-testid="seed">{t('feed.runs.source.seed', { seed: row.seed, epoch: row.epoch ?? 0 })}</span>
        ) : (
          DASH
        ),
    },
    {
      key: 'counts',
      header: t('feed.runs.column.counts'),
      render: (row) => (
        <span className="feed-num" data-testid="run-counts">
          {t('feed.runs.counts.text', { total: numberText(row.counts.total, locale), written: numberText(row.counts.written, locale), skipped: numberText(row.counts.skipped, locale), rejected: numberText(row.counts.rejected, locale) })}{' '}
          <Figure
            name={t('feed.runs.figure.counts.name')}
            formula={t('feed.runs.figure.counts.formula')}
            source={t('feed.runs.figure.counts.source', { layout: row.layoutVersion })}
            asOf={vietnamStamp(row.createdAt)}
            unverified={row.acceptance === 'PENDING_EXTERNAL'}
          />
        </span>
      ),
    },
    { key: 'by', header: t('feed.runs.column.by'), render: (row) => row.importedByName ?? t('feed.runs.by.none') },
  ];
  if (onOpen !== undefined) {
    columns.push({
      key: 'open',
      header: t('feed.runs.column.open'),
      render: (row) => (
        <button type="button" className="ui-button ui-button--outline ui-button--small" aria-pressed={selectedId === row.id} aria-label={t('feed.runs.open.label', { time: vietnamStamp(row.createdAt) })} onClick={() => onOpen(row)}>
          {t('feed.runs.open.action')}
        </button>
      ),
    });
  }
  return <DataTable caption={caption} columns={columns} rows={[...runs]} rowKey={(row) => row.id} rowAttrs={(row) => ({ 'data-run-id': row.id, 'data-channel': row.channel })} />;
}

/** The pieces of a refused row: the line, the key, the reason in words, the field and the masked cells. */
export function RowErrorsTable({ errors, caption }: { errors: readonly RowError[]; caption: string }) {
  const { t } = useTranslation();
  return (
    <DataTable<RowError>
      caption={caption}
      rows={[...errors]}
      rowKey={(row) => `${row.line}:${row.code}:${row.businessKey ?? ''}`}
      rowAttrs={(row) => ({ 'data-line': String(row.line) })}
      columns={[
        { key: 'line', header: t('feed.runs.column.line'), align: 'right', pinned: true, render: (row) => row.line },
        { key: 'key', header: t('feed.runs.column.key'), render: (row) => row.businessKey ?? DASH },
        { key: 'code', header: t('feed.runs.column.code'), render: (row) => rowCodeLabel(t, row.code === '' ? null : row.code) },
        { key: 'field', header: t('feed.runs.column.field'), render: (row) => (row.field === null || row.field === '' ? DASH : <code>{row.field}</code>) },
        {
          key: 'preview',
          header: t('feed.runs.column.preview'),
          render: (row) =>
            row.preview === null ? (
              DASH
            ) : (
              <ul className="feed-pairs">
                {previewPairs(row.preview).map((pair) => (
                  <li key={pair.key}>
                    <code>{pair.key}</code>: {pair.value}
                  </li>
                ))}
              </ul>
            ),
        },
      ]}
    />
  );
}

/** The detail of one run: what it was, the counts, and the rows that were refused (masked). A list of refused rows that was cut says so. */
export function RunDetailPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const { t, locale } = useTranslation();
  const query = useFeedRun(id);
  const detail = query.data;
  const state = detail !== undefined ? 'default' : query.isLoading ? 'loading' : isForbidden(query.error) ? 'denied' : 'error';
  const run = detail?.run;
  return (
    <SectionCard
      title={t('feed.runs.detail.title')}
      actions={
        <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={onClose}>
          {t('feed.runs.detail.close.action')}
        </button>
      }
    >
      <div data-testid="run-detail">
        <ListState state={state} onRetry={() => void query.refetch()} />
        {run !== undefined && detail !== undefined && (
          <>
            <dl className="feed-counts" data-testid="detail-counts">
              <div>
                <dt>{t('feed.runs.detail.total.label')}</dt>
                <dd>{numberText(run.counts.total, locale)}</dd>
              </div>
              <div>
                <dt>{t('feed.runs.detail.written.label')}</dt>
                <dd>{numberText(run.counts.written, locale)}</dd>
              </div>
              <div>
                <dt>{t('feed.runs.detail.skipped.label')}</dt>
                <dd>{numberText(run.counts.skipped, locale)}</dd>
              </div>
              <div>
                <dt>{t('feed.runs.detail.rejected.label')}</dt>
                <dd>{numberText(run.counts.rejected, locale)}</dd>
              </div>
            </dl>
            <p className="feed-note" data-testid="detail-facts">
              {t('feed.runs.detail.facts.text', { what: runWhat(t, run), time: vietnamStamp(run.createdAt), layout: run.layoutVersion })} <ChannelTag channel={run.channel} /> <AcceptanceBadge acceptance={run.acceptance} />{' '}
              <Figure name={t('feed.runs.figure.counts.name')} formula={t('feed.runs.figure.counts.formula')} source={t('feed.runs.figure.counts.source', { layout: run.layoutVersion })} asOf={vietnamStamp(detail.asOf ?? run.createdAt)} unverified={run.acceptance === 'PENDING_EXTERNAL'} />
            </p>
            {detail.errors.length === 0 ? (
              <p className="feed-none" data-testid="detail-no-errors">
                {t('feed.runs.detail.errors.none')}
              </p>
            ) : (
              <>
                <RowErrorsTable errors={detail.errors} caption={t('feed.runs.detail.errors.caption')} />
                {detail.errorsTruncated && (
                  <p className="sub" role="status" data-testid="detail-truncated">
                    {t('feed.runs.detail.errors.truncated', { shown: detail.errors.length })}
                  </p>
                )}
              </>
            )}
          </>
        )}
      </div>
    </SectionCard>
  );
}

/** The columns a layout expects: required, optional; a collapsible group so that the form stays short. */
export function ExpectedColumns({ layout, title }: { layout: Layout | undefined; title: string }) {
  const { t } = useTranslation();
  if (layout === undefined) return null;
  return (
    <details className="feed-columns" data-testid="expected-columns">
      <summary>{title}</summary>
      <ul>
        {layout.columns.map((column) => (
          <li key={column.name}>
            <code>{column.name}</code> · {needLabel(t, column.required)}
            {column.values.length > 0 && <small> ({column.values.join(', ')})</small>}
          </li>
        ))}
      </ul>
    </details>
  );
}

type TileKey = RowStatus | 'TOTAL';

/** One figure of the dry run with its "i": the formula is the count of rows by verdict, the source is the file and the layout version, the moment is the time of the dry run. */
function Tile({ tile, preview, locale }: { tile: TileKey; preview: Preview; locale: string }) {
  const { t } = useTranslation();
  const counts = preview.counts;
  const value = tile === 'TOTAL' ? counts.total : tile === 'VALID' ? counts.valid : tile === 'ERROR' ? counts.errors : tile === 'DUPLICATE' ? counts.duplicate : counts.conflict;
  const label =
    tile === 'TOTAL'
      ? t('feed.runs.tile.total.label')
      : tile === 'VALID'
        ? t('feed.runs.tile.valid.label')
        : tile === 'ERROR'
          ? t('feed.runs.tile.errors.label')
          : tile === 'DUPLICATE'
            ? t('feed.runs.tile.duplicate.label')
            : t('feed.runs.tile.conflict.label');
  const tone: Tone = tile === 'VALID' && value > 0 ? 'success' : tile === 'ERROR' && value > 0 ? 'danger' : tile === 'CONFLICT' && value > 0 ? 'warning' : 'default';
  return (
    <KpiTile
      label={label}
      value={numberText(value, locale)}
      unit={t('feed.runs.tile.unit')}
      tone={tone}
      sub={
        <Figure
          name={label}
          formula={tile === 'TOTAL' ? t('feed.runs.tileInfo.total') : t('feed.runs.tileInfo.verdict', { verdict: rowStatusLabel(t, tile) })}
          source={t('feed.runs.tileInfo.source', { hash: shortHash(preview.fileSha256), layout: preview.layoutVersion })}
          asOf={vietnamStamp(preview.ranAt)}
          version={t('feed.runs.tileInfo.version', { layout: preview.layoutVersion })}
          unverified={preview.acceptance === 'PENDING_EXTERNAL'}
        />
      }
    />
  );
}

/**
 * The result of a dry run (nothing was written): the layout and its acceptance word, the five figures, the verdict of every row with its reason, the field and what the apply would do with it. A dry run with error rows is shown whole
 * (partial state), never hidden; a file that was loaded before, or a connection that is off, is said at the top.
 */
export function PreviewPanel({ preview }: { preview: Preview }) {
  const { t, locale } = useTranslation();
  const [status, setStatus] = useState<StatusFilter>('');
  const shown = useMemo(() => filterRows(preview.rows, status), [preview.rows, status]);
  const columns: Array<DataTableColumn<PreviewRow>> = [
    { key: 'line', header: t('feed.runs.column.line'), align: 'right', pinned: true, render: (row) => row.line },
    { key: 'key', header: t('feed.runs.column.key'), render: (row) => row.businessKey ?? DASH },
    {
      key: 'status',
      header: t('feed.runs.column.result'),
      render: (row) => (
        <StatusPill tone={rowStatusTone(row.status)} icon={row.status === 'VALID' ? '✓' : row.status === 'ERROR' ? '✕' : '≈'}>
          {rowStatusLabel(t, row.status)}
        </StatusPill>
      ),
    },
    { key: 'code', header: t('feed.runs.column.code'), render: (row) => previewCodeLabel(t, row) ?? DASH },
    { key: 'field', header: t('feed.runs.column.field'), render: (row) => (row.field === null || row.field === '' ? DASH : <code>{row.field}</code>) },
    { key: 'outcome', header: t('feed.runs.column.outcome'), render: (row) => outcomeLabel(t, row.outcome) },
  ];
  return (
    <div data-testid="import-preview" data-kind={preview.kind}>
      <p className="feed-note" data-testid="preview-facts">
        <span>{t('feed.runs.preview.mode', { mode: t('feed.runs.mode.dryRun') })}</span> · <span>{t('feed.runs.preview.kind', { kind: kindLabel(t, preview.kind) })}</span> ·{' '}
        <span data-testid="preview-layout">{t('feed.runs.preview.layout', { version: preview.layoutVersion })}</span> <AcceptanceBadge acceptance={preview.acceptance} />
      </p>
      {preview.alreadyApplied && (
        <p className="callout warning" role="status" data-testid="import-already">
          {t('feed.runs.preview.already')}
        </p>
      )}
      {!preview.connectionEnabled && (
        <p className="callout warning" role="status" data-testid="import-disabled">
          {t('feed.runs.preview.disabled')} <Link to={PATHS.connection}>{t('feed.common.link.connection')}</Link>
        </p>
      )}
      {preview.counts.errors > 0 && (
        <p className="callout" role="status" data-testid="import-partial">
          {t('feed.runs.preview.partial', { errors: preview.counts.errors })}
        </p>
      )}
      <KpiStrip label={t('feed.runs.tile.group.label')}>
        <Tile tile="VALID" preview={preview} locale={locale} />
        <Tile tile="ERROR" preview={preview} locale={locale} />
        <Tile tile="DUPLICATE" preview={preview} locale={locale} />
        <Tile tile="CONFLICT" preview={preview} locale={locale} />
        <Tile tile="TOTAL" preview={preview} locale={locale} />
      </KpiStrip>
      <div className="field feed-filter">
        <label htmlFor="feed-import-status">{t('feed.runs.filter.status.label')}</label>
        <select id="feed-import-status" value={status} onChange={(event) => setStatus(event.target.value as StatusFilter)}>
          <option value="">{t('feed.runs.filter.all')}</option>
          {ROW_STATUSES.map((value) => (
            <option key={value} value={value}>
              {rowStatusLabel(t, value)}
            </option>
          ))}
        </select>
      </div>
      <div data-testid="preview-rows">
        <DataTable
          caption={t('feed.runs.preview.caption')}
          columns={columns}
          rows={shown}
          rowKey={(row) => `${row.line}:${row.status}:${row.businessKey ?? ''}`}
          rowAttrs={(row) => ({ 'data-line': String(row.line), 'data-status': row.status })}
          emptyKind={status === '' ? 'none' : 'filtered'}
          onClearFilters={() => setStatus('')}
        />
      </div>
      {preview.rowsTruncated && (
        <p className="sub" role="status" data-testid="preview-truncated">
          {t('feed.runs.preview.truncated', { shown: PREVIEW_ROW_LIMIT, total: preview.counts.total })}
        </p>
      )}
    </div>
  );
}

/** What an apply did (or why it took nothing): the counts, the mappings proposed from the file, and the rows that were refused. */
export function ResultPanel({ applied }: { applied: Applied }) {
  const { t, locale } = useTranslation();
  const counts = applied.counts;
  const cells: Array<{ key: string; label: string; value: number }> = [
    { key: 'total', label: t('feed.runs.result.total.label'), value: counts.total },
    { key: 'applied', label: t('feed.runs.result.applied.label'), value: counts.applied },
    { key: 'duplicate', label: t('feed.runs.result.duplicate.label'), value: counts.duplicate },
    { key: 'conflict', label: t('feed.runs.result.conflict.label'), value: counts.conflict },
    { key: 'quarantined', label: t('feed.runs.result.quarantined.label'), value: counts.quarantined },
    { key: 'differences', label: t('feed.runs.result.differences.label'), value: counts.differencesOpened },
  ];
  return (
    <div data-testid="import-result" data-refused={applied.refused ? 'true' : 'false'}>
      <p className={applied.refused ? 'callout warning' : 'callout feed-receipt'} role={applied.refused ? 'alert' : 'status'} data-testid="result-summary">
        {applied.refused ? t('feed.runs.result.refused.text') : t('feed.runs.result.applied.text', { applied: numberText(counts.applied, locale), total: numberText(counts.total, locale) })}
      </p>
      <dl className="feed-counts" data-testid="result-counts">
        {cells.map((cell) => (
          <div key={cell.key} data-key={cell.key}>
            <dt>{cell.label}</dt>
            <dd>{numberText(cell.value, locale)}</dd>
          </div>
        ))}
      </dl>
      <p className="feed-note" data-testid="result-facts">
        {t('feed.runs.result.mappings.text', { count: applied.mappingsProposed })}{' '}
        <Figure
          name={t('feed.runs.figure.counts.name')}
          formula={t('feed.runs.figure.counts.formula')}
          source={t('feed.runs.figure.counts.source', { layout: applied.layoutVersion })}
          asOf={vietnamStamp(new Date().toISOString())}
          unverified={applied.acceptance === 'PENDING_EXTERNAL'}
        />
      </p>
      {applied.errors.length > 0 && (
        <>
          <RowErrorsTable errors={applied.errors} caption={t('feed.runs.result.errors.caption')} />
          {applied.errorsTruncated && (
            <p className="sub" role="status" data-testid="result-truncated">
              {t('feed.runs.detail.errors.truncated', { shown: applied.errors.length })}
            </p>
          )}
        </>
      )}
    </div>
  );
}
