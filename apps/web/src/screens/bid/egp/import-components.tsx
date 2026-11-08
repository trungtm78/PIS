import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import { DataTable, StatusPill } from '../../../ui';
import type { DataTableColumn } from '../../../ui';
import { PATH_CONNECTION, columnNeed, previewPairs, shortHash } from './import-model';
import type { Acceptance, Layout, LayoutColumn, Problem, RowError } from './import-model';
import { needLabel, problemMessage, rowCodeLabel } from './import-labels';
import './import.css';

export const DASH = '—';

/** The word that the layout of the file is a working assumption (PENDING-EXTERNAL) while the acceptance says so; a state in words, not in colour. */
export function AcceptanceBadge({ acceptance }: { acceptance: Acceptance }) {
  const { t } = useTranslation();
  return acceptance === 'PENDING_EXTERNAL' ? (
    <span data-testid="acceptance-badge" data-acceptance={acceptance}>
      <StatusPill tone="warning" icon="⚠">
        {t('egp.import.acceptance.pending')}
      </StatusPill>
    </span>
  ) : (
    <span data-testid="acceptance-badge" data-acceptance={acceptance}>
      <StatusPill tone="success" icon="✓">
        {t('egp.import.acceptance.acceptable')}
      </StatusPill>
    </span>
  );
}

/** The first characters of a file hash with a button that copies the whole hash; the answer of the copy is said in words. */
export function HashCell({ hash }: { hash: string }) {
  const { t } = useTranslation();
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');
  const run = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(hash);
      setCopy('copied');
    } catch {
      setCopy('failed');
    }
  };
  return (
    <span className="egpi-hash" data-testid="hash">
      <code title={hash}>{shortHash(hash)}</code>
      <button type="button" className="ui-button ui-button--outline ui-button--small" aria-label={t('egp.import.hash.copy', { hash: shortHash(hash) })} onClick={() => void run()}>
        {t('egp.import.hash.copyAction')}
      </button>
      {copy === 'idle' ? null : (
        <small className="sub" role="status">
          {copy === 'copied' ? t('egp.import.hash.copied') : t('egp.import.hash.copyFailed')}
        </small>
      )}
    </span>
  );
}

/** What went wrong (or what the server told), as a note: information for "already applied", an alert for the rest; the connection that is off links to its screen. */
export function ProblemNote({ problem }: { problem: Problem }) {
  const { t } = useTranslation();
  const information = problem.kind === 'alreadyApplied';
  return (
    <p className={information ? 'callout' : 'callout warning'} role={information ? 'status' : 'alert'} data-testid={information ? 'import-info' : 'import-problem'} data-problem={problem.kind}>
      {problemMessage(t, problem)}
      {problem.kind === 'connectionDisabled' ? (
        <>
          {' '}
          <Link to={PATH_CONNECTION}>{t('egp.import.link.connection')}</Link>
        </>
      ) : null}
    </p>
  );
}

/** The expected columns of one layout: name, kind, whether a row must fill it or only the header must have it, and the words it may hold. */
export function ExpectedColumns({ layout, title }: { layout: Layout | undefined; title: string }) {
  const { t } = useTranslation();
  const columns: Array<DataTableColumn<LayoutColumn>> = [
    { key: 'name', header: t('egp.import.columns.name'), pinned: true, render: (column) => <code>{column.name}</code> },
    { key: 'kind', header: t('egp.import.columns.kind'), render: (column) => column.kind },
    { key: 'need', header: t('egp.import.columns.need'), render: (column) => needLabel(t, columnNeed(column)) },
    { key: 'values', header: t('egp.import.columns.values'), render: (column) => (column.values.length === 0 ? DASH : column.values.join(', ')) },
  ];
  return (
    <details className="egpi-columns" data-testid="expected-columns">
      <summary>{title}</summary>
      {layout === undefined || layout.columns.length === 0 ? (
        <p className="callout" role="status">
          {t('egp.import.columns.none')}
        </p>
      ) : (
        <DataTable caption={t('egp.import.columns.caption')} columns={columns} rows={layout.columns} rowKey={(column) => column.name} />
      )}
    </details>
  );
}

/** The rows an import refused (or could not take), with the line, the reason in words, the field and the masked preview; the server leaves out names and addresses. */
export function RowErrorsTable({ errors, caption, truncated, testId }: { errors: readonly RowError[]; caption: string; truncated: boolean; testId: string }) {
  const { t } = useTranslation();
  const columns: Array<DataTableColumn<RowError>> = [
    { key: 'line', header: t('egp.import.column.line'), align: 'right', pinned: true, render: (error) => error.line },
    { key: 'key', header: t('egp.import.column.key'), render: (error) => error.businessKey ?? DASH },
    { key: 'code', header: t('egp.import.column.code'), render: (error) => rowCodeLabel(t, error.code === '' ? null : error.code) },
    { key: 'field', header: t('egp.import.column.field'), render: (error) => (error.field === null || error.field === '' ? DASH : <code>{error.field}</code>) },
    {
      key: 'preview',
      header: t('egp.import.column.preview'),
      render: (error) =>
        error.preview === null ? (
          DASH
        ) : (
          <span className="egpi-preview">
            {previewPairs(error.preview).map((pair) => (
              <span key={pair.key}>
                <code>{pair.key}</code>: {pair.value}
              </span>
            ))}
          </span>
        ),
    },
  ];
  return (
    <div data-testid={testId}>
      <DataTable caption={caption} columns={columns} rows={[...errors]} rowKey={(error) => `${error.line}:${error.code}:${error.businessKey ?? ''}`} rowAttrs={(error) => ({ 'data-line': String(error.line), 'data-code': error.code })} />
      {truncated ? (
        <p className="sub" role="status">
          {t('egp.import.errors.truncated')}
        </p>
      ) : null}
    </div>
  );
}
