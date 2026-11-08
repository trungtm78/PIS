import { useEffect, useRef, useState } from 'react';
import { useTranslation } from '../../../i18n';
import { useScreenState } from '../../../states/useScreenState';
import { ContextBar, DataTable, SectionCard, StatusPill } from '../../../ui';
import type { DataTableColumn } from '../../../ui';
import { AcceptanceBadge, DASH, HashCell, RowErrorsTable } from './import-components';
import { useEgpImportDetail, useEgpImportHistory } from './import-hooks';
import { failureText, kindLabel, runStatusLabel, runTone } from './import-labels';
import { KINDS, kindOf, vietnamDateTime } from './import-model';
import type { Kind, Run } from './import-model';
import './import.css';

function RunDetailPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const { t } = useTranslation();
  const detail = useEgpImportDetail(id);
  const heading = useRef<HTMLDivElement>(null);
  const state = useScreenState({ isLoading: detail.isLoading, error: detail.data === undefined ? detail.error : undefined, data: detail.data ?? null, isEmpty: () => false });
  const data = detail.data;
  useEffect(() => {
    heading.current?.focus();
  }, [id]);
  const title =
    data === undefined
      ? t('egp.import.detail.titlePlain')
      : t('egp.import.detail.title', { kind: kindLabel(t, data.run.kind), when: vietnamDateTime(data.run.completedAt ?? data.run.createdAt) });
  return (
    <SectionCard
      title={title}
      actions={
        <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={onClose}>
          {t('egp.import.detail.close')}
        </button>
      }
    >
      <div data-testid="import-detail" role="group" aria-label={title} aria-live="polite" tabIndex={-1} ref={heading}>
        {state === 'loading' ? (
          <p className="callout" role="status" aria-busy="true" data-testid="detail-loading">
            {t('egp.import.detail.loading')}
          </p>
        ) : null}
        {state === 'denied' || state === 'signedOut' ? (
          <p className="callout warning" role="alert" data-testid="detail-denied">
            {t('egp.import.detail.denied')}
          </p>
        ) : null}
        {state === 'error' || state === 'offline' || (state === 'default' && data === undefined) ? (
          <div className="callout warning" role="alert" data-testid="detail-error">
            <p>{t('egp.import.detail.error')}</p>
            <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => void detail.refetch()}>
              {t('states.retry.action')}
            </button>
          </div>
        ) : null}
        {state === 'default' && data !== undefined ? (
          <>
            <p className="egpi-facts">
              <span>{t('egp.import.history.summary', { valid: data.run.counts.applied, errors: data.run.counts.quarantined, duplicate: data.run.counts.duplicate, conflict: data.run.counts.conflict, differences: data.run.openDifferences })}</span>
              <span>{t('egp.import.detail.asOf', { time: vietnamDateTime(data.asOf) })}</span>
            </p>
            {data.run.status === 'FAILED' ? (
              <p className="callout warning" role="status" data-testid="detail-failed">
                {failureText(t, data.run.errorCode)}
              </p>
            ) : null}
            {data.errors.length === 0 ? (
              <p className="callout" role="status" data-testid="detail-empty">
                {t('egp.import.detail.empty')}
              </p>
            ) : (
              <RowErrorsTable errors={data.errors} caption={t('egp.import.detail.caption')} truncated={data.errorsTruncated} testId="detail-errors" />
            )}
          </>
        ) : null}
      </div>
    </SectionCard>
  );
}

/**
 * The history of the import runs (BID-24, part B): kind, layout version, file hash with copy, status, the counts of rows, the open differences, who and when; filtered by kind, a page at a time, and a run opens the rows it refused.
 * Only applies are kept: a dry run writes nothing, so it has no row here.
 */
export function ImportHistory() {
  const { t, locale } = useTranslation();
  const [kind, setKind] = useState<Kind | ''>('');
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const history = useEgpImportHistory(kind === '' ? undefined : kind);
  const state = useScreenState({ isLoading: history.isLoading, error: history.data === undefined ? history.error : undefined, data: history.data ?? null, isEmpty: () => false });
  const runs = history.data?.pages.flatMap((page) => page.items) ?? [];
  const asOf = vietnamDateTime(history.data?.pages[0]?.asOf);

  const num = (value: number): string => value.toLocaleString(locale);
  const columns: Array<DataTableColumn<Run>> = [
    { key: 'kind', header: t('egp.import.column.kind'), pinned: true, render: (run) => kindLabel(t, run.kind) },
    {
      key: 'layout',
      header: t('egp.import.column.layout'),
      render: (run) => (
        <span className="egpi-layout">
          <span>{run.layoutVersion}</span>
          <AcceptanceBadge acceptance={run.acceptance} />
        </span>
      ),
    },
    { key: 'hash', header: t('egp.import.column.hash'), render: (run) => <HashCell hash={run.fileSha256} /> },
    {
      key: 'status',
      header: t('egp.import.column.status'),
      render: (run) => (
        <span className="egpi-status" data-testid="run-status">
          <StatusPill tone={runTone(run.status)} icon={run.status === 'APPLIED' ? '✓' : run.status === 'FAILED' ? '✕' : '…'}>
            {runStatusLabel(t, run.status)}
          </StatusPill>
          {run.status === 'FAILED' ? (
            <small className="sub" data-testid="run-failure">
              {failureText(t, run.errorCode)}
            </small>
          ) : null}
        </span>
      ),
    },
    { key: 'valid', header: t('egp.import.column.valid'), align: 'right', render: (run) => num(run.counts.applied) },
    { key: 'refused', header: t('egp.import.column.refused'), align: 'right', render: (run) => num(run.counts.quarantined) },
    { key: 'duplicate', header: t('egp.import.column.duplicate'), align: 'right', render: (run) => num(run.counts.duplicate) },
    { key: 'conflict', header: t('egp.import.column.conflict'), align: 'right', render: (run) => num(run.counts.conflict) },
    { key: 'differences', header: t('egp.import.column.differences'), align: 'right', render: (run) => num(run.openDifferences) },
    { key: 'who', header: t('egp.import.column.who'), render: (run) => run.importedBy ?? DASH },
    { key: 'when', header: t('egp.import.column.when'), render: (run) => vietnamDateTime(run.completedAt ?? run.createdAt) },
    {
      key: 'detail',
      header: t('egp.import.column.detail'),
      render: (run) => (
        <button
          type="button"
          className="ui-button ui-button--outline ui-button--small"
          aria-pressed={selected === run.id}
          aria-label={t('egp.import.history.select.label', { kind: kindLabel(t, run.kind), when: vietnamDateTime(run.completedAt ?? run.createdAt) })}
          onClick={() => setSelected(selected === run.id ? undefined : run.id)}
        >
          {t('egp.import.history.select.action')}
        </button>
      ),
    },
  ];

  const body = (() => {
    if (state === 'denied' || state === 'signedOut') {
      return (
        <p className="callout warning" role="alert" data-testid="history-denied">
          {t('egp.import.history.denied')}
        </p>
      );
    }
    if (state === 'loading') return <DataTable caption={t('egp.import.history.caption')} columns={columns} rows={[]} rowKey={(run) => run.id} state="loading" />;
    if (state === 'error' || state === 'offline') {
      return <DataTable caption={t('egp.import.history.caption')} columns={columns} rows={[]} rowKey={(run) => run.id} state="error" onRetry={() => void history.refetch()} />;
    }
    if (runs.length === 0) {
      return (
        <p className="callout" role="status" data-testid="history-empty">
          {kind === '' ? t('egp.import.history.empty') : t('egp.import.history.emptyFiltered')}
        </p>
      );
    }
    return (
      <>
        <div data-testid="history-table">
          <DataTable caption={t('egp.import.history.caption')} columns={columns} rows={runs} rowKey={(run) => run.id} rowAttrs={(run) => ({ 'data-run-id': run.id, 'data-run-status': run.status, 'data-selected': selected === run.id ? 'true' : undefined })} />
        </div>
        {history.isFetchNextPageError ? (
          <p className="callout warning" role="alert" data-testid="history-more-error">
            {t('egp.import.history.moreError')}
          </p>
        ) : null}
        {history.hasNextPage ? (
          <div className="egpi-actions">
            <button type="button" className="ui-button ui-button--outline" disabled={history.isFetchingNextPage} onClick={() => void history.fetchNextPage()}>
              {history.isFetchingNextPage ? t('egp.import.history.more.pending') : t('egp.import.history.more.action')}
            </button>
          </div>
        ) : null}
      </>
    );
  })();

  return (
    <>
      <SectionCard title={t('egp.import.history.title')}>
        <p className="sub">{t('egp.import.history.note')}</p>
        <ContextBar items={[{ label: t('egp.import.field.mode'), value: t('egp.import.mode.apply') }]} {...(asOf === '' ? {} : { asOf })} stale={history.isError && history.data !== undefined} />
        <div className="field egpi-filter">
          <label htmlFor="egp-history-kind">{t('egp.import.filter.kind.label')}</label>
          <select
            id="egp-history-kind"
            value={kind}
            onChange={(event) => {
              setKind(event.target.value === '' ? '' : (kindOf(event.target.value) ?? ''));
              setSelected(undefined);
            }}
          >
            <option value="">{t('egp.import.filter.kindAll')}</option>
            {KINDS.map((value) => (
              <option key={value} value={value}>
                {kindLabel(t, value)}
              </option>
            ))}
          </select>
        </div>
        {body}
      </SectionCard>
      {selected === undefined ? null : <RunDetailPanel key={selected} id={selected} onClose={() => setSelected(undefined)} />}
    </>
  );
}
