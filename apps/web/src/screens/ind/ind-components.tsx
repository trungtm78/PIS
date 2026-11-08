import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenState } from '../../states/StateBoundary';
import { DataTable, StatusPill } from '../../ui';
import type { DataTableColumn } from '../../ui';
import { checkLabel, originLabel, problemMessage, rowCodeLabel, severityLabel, severityTone, versionStatusLabel } from './ind-labels';
import { DASH, PATH_GOVERNANCE, vietnamDateTime } from './ind-model';
import type { Origin, Problem, RowError, Version, Violation } from './ind-model';
import './ind.css';

export interface StateTexts {
  loading: string;
  denied: string;
  error: string;
}

/**
 * The words of the states of a read that has not (yet) given data: loading, denied (403) and error with a retry. A state that has data returns nothing, so the screen draws its own content.
 * Each is a statement in words with its own role: a status that waits, an alert that stops.
 */
export function StateNote({ state, texts, onRetry, name }: { state: ScreenState; texts: StateTexts; onRetry: () => void; name: string }) {
  const { t } = useTranslation();
  if (state === 'loading') {
    return (
      <p className="callout" role="status" aria-busy="true" data-testid={`${name}-loading`}>
        {texts.loading}
      </p>
    );
  }
  if (state === 'denied' || state === 'signedOut') {
    return (
      <p className="callout warning" role="alert" data-testid={`${name}-denied`}>
        {texts.denied}
      </p>
    );
  }
  if (state === 'error' || state === 'offline') {
    return (
      <div className="callout warning" role="alert" data-testid={`${name}-error`}>
        <p>{texts.error}</p>
        <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={onRetry}>
          {t('states.retry.action')}
        </button>
      </div>
    );
  }
  return null;
}

/** The word that a definition is the platform's starting value nobody confirmed (a state in words, not in colour), or a version the tenant approved. */
export function OriginBadge({ origin, unverified }: { origin: Origin; unverified: boolean }) {
  const { t } = useTranslation();
  return (
    <span data-testid="origin-badge" data-origin={origin} data-unverified={unverified ? 'true' : 'false'}>
      <StatusPill tone={origin === 'RULE' ? 'success' : unverified ? 'warning' : 'neutral'} icon={origin === 'RULE' ? '✓' : '⚠'}>
        {originLabel(t, origin, unverified)}
      </StatusPill>
    </span>
  );
}

/** Where a definition, a rule or a mapping is drafted, submitted and approved: the governance rules of the tenant (a maker is not the checker). */
export function GovernanceLink() {
  const { t } = useTranslation();
  return (
    <p className="sub" data-testid="governance-note">
      {t('ind.common.governance.note')} <Link to={PATH_GOVERNANCE}>{t('ind.common.governance.link')}</Link>
    </p>
  );
}

/** The versions of a definition, a rule or a mapping with the person who made, submitted and approved each, and the days it was in force. */
export function VersionTable({ versions, caption }: { versions: Version[]; caption: string }) {
  const { t } = useTranslation();
  const columns: Array<DataTableColumn<Version>> = [
    { key: 'version', header: t('ind.versions.column.version'), pinned: true, render: (row) => `v${row.version}` },
    { key: 'status', header: t('ind.versions.column.status'), render: (row) => versionStatusLabel(t, row.status) },
    { key: 'from', header: t('ind.versions.column.from'), render: (row) => row.effectiveFrom || DASH },
    { key: 'to', header: t('ind.versions.column.to'), render: (row) => row.effectiveTo ?? DASH },
    { key: 'maker', header: t('ind.versions.column.maker'), render: (row) => row.createdByName ?? DASH },
    { key: 'submitter', header: t('ind.versions.column.submitter'), render: (row) => row.submittedByName ?? DASH },
    { key: 'approver', header: t('ind.versions.column.approver'), render: (row) => row.approvedByName ?? DASH },
    { key: 'approvedAt', header: t('ind.versions.column.approvedAt'), render: (row) => vietnamDateTime(row.approvedAt) || DASH },
    { key: 'reason', header: t('ind.versions.column.reason'), render: (row) => row.reason },
  ];
  if (versions.length === 0) {
    return (
      <p className="callout" role="status" data-testid="versions-empty">
        {t('ind.versions.empty.note')}
      </p>
    );
  }
  return (
    <div data-testid="versions-table">
      <DataTable caption={caption} columns={columns} rows={versions} rowKey={(row) => row.id} rowAttrs={(row) => ({ 'data-version': String(row.version), 'data-status': row.status })} />
    </div>
  );
}

/** The rows an import refused, with the line, the reason in words and the field, and what the row said (nothing is kept of a row that the format does not mask). */
export function RowErrorsTable({ errors, caption, truncated, testId }: { errors: RowError[]; caption: string; truncated: boolean; testId: string }) {
  const { t } = useTranslation();
  const columns: Array<DataTableColumn<RowError>> = [
    { key: 'line', header: t('ind.errors.column.line'), align: 'right', pinned: true, render: (row) => String(row.line) },
    { key: 'key', header: t('ind.errors.column.key'), render: (row) => row.businessKey ?? DASH },
    { key: 'reason', header: t('ind.errors.column.reason'), render: (row) => rowCodeLabel(t, row.code) },
    { key: 'field', header: t('ind.errors.column.field'), render: (row) => row.field || DASH },
    { key: 'row', header: t('ind.errors.column.row'), render: (row) => (row.preview.length === 0 ? DASH : row.preview.map(([key, value]) => `${key}: ${value}`).join(' · ')) },
  ];
  return (
    <div data-testid={testId}>
      <DataTable caption={caption} columns={columns} rows={errors} rowKey={(row) => `${row.line}:${row.code}:${row.field}`} rowAttrs={(row) => ({ 'data-line': String(row.line), 'data-code': row.code })} />
      {truncated ? (
        <p className="callout" role="status" data-testid={`${testId}-truncated`}>
          {t('ind.errors.truncated.note')}
        </p>
      ) : null}
    </div>
  );
}

/** The rules that held an entry: the check, the words the rule's maker wrote, the fields it is about and the severity (block or warning). */
export function ViolationList({ violations, testId }: { violations: Violation[]; testId: string }) {
  const { t } = useTranslation();
  return (
    <ul className="ind-violations" data-testid={testId}>
      {violations.map((one) => (
        <li key={`${one.ruleCode}:${one.fields.join(',')}`} data-rule={one.ruleCode} data-severity={one.severity}>
          <StatusPill tone={severityTone(one.severity)} icon={one.severity === 'BLOCK' ? '✕' : '⚠'}>
            {severityLabel(t, one.severity)}
          </StatusPill>{' '}
          <strong>{one.ruleCode}</strong> ({checkLabel(t, one.check)}) {one.message}
          <small className="sub ind-detail">{t('ind.violation.detail.note', { fields: one.fields.join(', '), detail: one.detail })}</small>
        </li>
      ))}
    </ul>
  );
}

/** What went wrong with a send, in words the person can act on, with the rules that blocked it and the columns or rows a file lacks. */
export function ProblemNote({ problem }: { problem: Problem }) {
  const { t } = useTranslation();
  const information = problem.kind === 'alreadyApplied';
  return (
    <div className={information ? 'callout' : 'callout warning'} role={information ? 'status' : 'alert'} data-testid="problem-note" data-problem={problem.kind}>
      <p>{problemMessage(t, problem)}</p>
      {problem.missing.length > 0 ? <p data-testid="problem-missing">{t('ind.problem.missing.note', { names: problem.missing.join(', ') })}</p> : null}
      {problem.violations.length > 0 ? <ViolationList violations={problem.violations} testId="problem-violations" /> : null}
    </div>
  );
}

export function Field({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children}
    </div>
  );
}
