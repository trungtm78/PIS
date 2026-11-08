import { useEffect, useRef, useState } from 'react';
import { useTranslation } from '../../i18n';
import { useScreenState } from '../../states/useScreenState';
import { ContextBar, DataTable, SectionCard, StatusPill } from '../../ui';
import type { DataTableColumn } from '../../ui';
import { RowErrorsTable, StateNote } from './ind-components';
import { useImportHistory, useRunRows } from './ind-hooks';
import { differenceLabel, failureText } from './ind-labels';
import { DASH, shortHash, vietnamDateTime } from './ind-model';
import type { Difference, Run } from './ind-model';
import './ind.css';

function RunDetailPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const { t } = useTranslation();
  const detail = useRunRows(id);
  const heading = useRef<HTMLDivElement>(null);
  const state = useScreenState({ isLoading: detail.isLoading, error: detail.data === undefined ? detail.error : undefined, data: detail.data ?? null, isEmpty: () => false });
  const data = detail.data;
  useEffect(() => {
    heading.current?.focus();
  }, [id]);
  const columns: Array<DataTableColumn<Difference>> = [
    { key: 'line', header: t('ind.errors.column.line'), align: 'right', pinned: true, render: (row) => String(row.line) },
    { key: 'key', header: t('ind.errors.column.key'), render: (row) => row.businessKey },
    { key: 'code', header: t('ind.hist.diff.column.code'), render: (row) => differenceLabel(t, row.code) },
    { key: 'expected', header: t('ind.hist.diff.column.expected'), align: 'right', render: (row) => row.expected ?? DASH },
    { key: 'actual', header: t('ind.hist.diff.column.actual'), align: 'right', render: (row) => row.actual ?? DASH },
    { key: 'status', header: t('ind.hist.diff.column.status'), render: (row) => (row.status === 'OPEN' ? t('ind.hist.diff.open') : t('ind.hist.diff.resolved')) },
    { key: 'owner', header: t('ind.hist.diff.column.owner'), render: (row) => row.ownerName ?? DASH },
    { key: 'due', header: t('ind.hist.diff.column.due'), render: (row) => vietnamDateTime(row.dueAt) },
  ];
  return (
    <SectionCard
      title={t('ind.hist.detail.title')}
      actions={
        <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={onClose}>
          {t('ind.hist.detail.close')}
        </button>
      }
    >
      <div data-testid="import-detail" role="group" aria-label={t('ind.hist.detail.title')} aria-live="polite" tabIndex={-1} ref={heading}>
        <StateNote
          state={state === 'default' && data === undefined ? 'error' : state}
          name="run-detail"
          texts={{ loading: t('ind.hist.detail.loading'), denied: t('ind.hist.detail.denied'), error: t('ind.hist.detail.error') }}
          onRetry={() => void detail.refetch()}
        />
        {state === 'default' && data !== undefined ? (
          <>
            {data.errors.length === 0 ? (
              <p className="callout" role="status" data-testid="detail-no-errors">
                {t('ind.hist.detail.noErrors')}
              </p>
            ) : (
              <RowErrorsTable errors={data.errors} caption={t('ind.hist.detail.errorsCaption')} truncated={data.errorsTruncated} testId="detail-errors" />
            )}
            {data.differences.length === 0 ? (
              <p className="callout" role="status" data-testid="detail-no-differences">
                {t('ind.hist.detail.noDifferences')}
              </p>
            ) : (
              <div data-testid="detail-differences">
                <p className="sub">{t('ind.hist.detail.differencesNote')}</p>
                <DataTable caption={t('ind.hist.detail.differencesCaption')} columns={columns} rows={data.differences} rowKey={(row) => row.id} rowAttrs={(row) => ({ 'data-line': String(row.line), 'data-status': row.status })} />
              </div>
            )}
          </>
        ) : null}
      </div>
    </SectionCard>
  );
}

/** The history of the imports (IND-03, part B): the mapping and version that read each file, its hash, status, counts, the differences still open, who and when; a page at a time, and a run opens the rows it refused and the differences it left. */
export function ImportHistory() {
  const { t, locale } = useTranslation();
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const history = useImportHistory();
  const state = useScreenState({ isLoading: history.isLoading, error: history.data === undefined ? history.error : undefined, data: history.data ?? null, isEmpty: () => false });
  const runs = history.data?.pages.flatMap((page) => page.items) ?? [];
  const asOf = vietnamDateTime(history.data?.pages[0]?.asOf);
  const num = (value: number): string => value.toLocaleString(locale);
  const columns: Array<DataTableColumn<Run>> = [
    { key: 'format', header: t('ind.hist.column.mapping'), pinned: true, render: (run) => run.formatVersion },
    { key: 'hash', header: t('ind.hist.column.hash'), render: (run) => shortHash(run.fileSha256) },
    {
      key: 'status',
      header: t('ind.hist.column.status'),
      render: (run) => (
        <span data-testid="run-status">
          <StatusPill tone={run.status === 'APPLIED' ? 'success' : run.status === 'FAILED' ? 'danger' : 'neutral'} icon={run.status === 'APPLIED' ? '✓' : run.status === 'FAILED' ? '✕' : '…'}>
            {run.status === 'APPLIED' ? t('ind.hist.status.applied') : run.status === 'FAILED' ? t('ind.hist.status.failed') : t('ind.hist.status.importing')}
          </StatusPill>
          {run.status === 'FAILED' ? <small className="sub">{failureText(t, run.errorCode)}</small> : null}
        </span>
      ),
    },
    { key: 'applied', header: t('ind.hist.column.applied'), align: 'right', render: (run) => num(run.counts.applied) },
    { key: 'refused', header: t('ind.hist.column.refused'), align: 'right', render: (run) => num(run.counts.quarantined) },
    { key: 'duplicate', header: t('ind.hist.column.duplicate'), align: 'right', render: (run) => num(run.counts.duplicate) },
    { key: 'conflict', header: t('ind.hist.column.conflict'), align: 'right', render: (run) => num(run.counts.conflict) },
    { key: 'differences', header: t('ind.hist.column.differences'), align: 'right', render: (run) => num(run.openDifferences) },
    { key: 'who', header: t('ind.hist.column.who'), render: (run) => run.importedBy ?? DASH },
    { key: 'when', header: t('ind.hist.column.when'), render: (run) => vietnamDateTime(run.completedAt ?? run.createdAt) },
    {
      key: 'detail',
      header: t('ind.hist.column.detail'),
      render: (run) => (
        <button type="button" className="ui-button ui-button--outline ui-button--small" aria-pressed={selected === run.id} aria-label={t('ind.hist.select.label', { mapping: run.formatVersion, when: vietnamDateTime(run.completedAt ?? run.createdAt) })} onClick={() => setSelected(selected === run.id ? undefined : run.id)}>
          {t('ind.hist.select.action')}
        </button>
      ),
    },
  ];

  const body = (() => {
    if (state === 'denied' || state === 'signedOut') {
      return <StateNote state={state} name="history" texts={{ loading: t('ind.hist.state.loading'), denied: t('ind.hist.state.denied'), error: t('ind.hist.state.error') }} onRetry={() => void history.refetch()} />;
    }
    if (state === 'loading') return <DataTable caption={t('ind.hist.caption')} columns={columns} rows={[]} rowKey={(run) => run.id} state="loading" />;
    if (state === 'error' || state === 'offline') return <DataTable caption={t('ind.hist.caption')} columns={columns} rows={[]} rowKey={(run) => run.id} state="error" onRetry={() => void history.refetch()} />;
    if (runs.length === 0) {
      return (
        <p className="callout" role="status" data-testid="history-empty">
          {t('ind.hist.state.empty')}
        </p>
      );
    }
    return (
      <>
        <div data-testid="history-table">
          <DataTable caption={t('ind.hist.caption')} columns={columns} rows={runs} rowKey={(run) => run.id} rowAttrs={(run) => ({ 'data-run-id': run.id, 'data-run-status': run.status, 'data-selected': selected === run.id ? 'true' : undefined })} />
        </div>
        {history.isFetchNextPageError ? (
          <p className="callout warning" role="alert" data-testid="history-more-error">
            {t('ind.hist.state.moreError')}
          </p>
        ) : null}
        {history.hasNextPage ? (
          <div className="ind-actions">
            <button type="button" className="ui-button ui-button--outline" disabled={history.isFetchingNextPage} onClick={() => void history.fetchNextPage()}>
              {history.isFetchingNextPage ? t('ind.hist.more.pending') : t('ind.hist.more.action')}
            </button>
          </div>
        ) : null}
      </>
    );
  })();

  return (
    <>
      <SectionCard title={t('ind.hist.title')}>
        <p className="sub">{t('ind.hist.note')}</p>
        <ContextBar items={[{ label: t('ind.hist.context.mode'), value: t('ind.hist.context.apply') }]} {...(asOf === '' ? {} : { asOf })} stale={history.isError && history.data !== undefined} />
        {body}
      </SectionCard>
      {selected === undefined ? null : <RunDetailPanel key={selected} id={selected} onClose={() => setSelected(undefined)} />}
    </>
  );
}
