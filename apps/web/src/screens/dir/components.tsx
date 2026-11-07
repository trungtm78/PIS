import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import { DataTable, InfoFormula, KpiTile, StatusPill } from '../../ui';
import type { DataTableColumn, Tone, UiState } from '../../ui';
import { errorIdOf, hintIdOf, wireControl } from '../field-wiring';
import { clockText, infoLabels, policyVersionText, statusLabel } from './labels';
import { asOfText, dayText, directivePath, phaseTone, statusTone } from './model';
import type { DirectiveLine, DirectiveStatus, LookupOption, Policy } from './model';
import './dir.css';

export interface FieldProps {
  id: string;
  label: string;
  error?: string | undefined;
  hint?: string | undefined;
  children: ReactNode;
}

/** A labelled control with its hint and error wired to it (aria-describedby, aria-invalid). */
export function Field({ id, label, error, hint, children }: FieldProps) {
  return (
    <div className="field" data-field={id}>
      <label htmlFor={id}>{label}</label>
      {wireControl(children, id, { hint: hint !== undefined, error: error !== undefined })}
      {hint === undefined ? null : (
        <small className="sub" id={hintIdOf(id)}>
          {hint}
        </small>
      )}
      {error === undefined ? null : (
        <small className="field-error" id={errorIdOf(id)} role="alert">
          {error}
        </small>
      )}
    </div>
  );
}

export interface SelectProps {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly LookupOption[];
  /** The text of the entry that means "no choice" (the filter's "all", the form's "choose"); without it the control has none. */
  emptyLabel?: string;
  error?: string | undefined;
  disabled?: boolean;
}

export function Select({ id, label, value, onChange, options, emptyLabel, error, disabled = false }: SelectProps) {
  return (
    <Field id={id} label={label} error={error}>
      <select id={id} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
        {emptyLabel === undefined ? null : <option value="">{emptyLabel}</option>}
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

/** The status a reader sees, as text on a tinted pill. */
export function StatusChip({ status }: { status: DirectiveStatus }) {
  const { t } = useTranslation();
  return <StatusPill tone={statusTone(status)}>{statusLabel(t, status)}</StatusPill>;
}

/** Where the directive stands on its clock; nothing for an ended one. */
export function ClockChip({ line }: { line: Pick<DirectiveLine, 'phase' | 'daysToDue' | 'overdueDays'> }) {
  const { t } = useTranslation();
  const text = clockText(t, line);
  return text === '' ? null : <StatusPill tone={phaseTone(line.phase)}>{text}</StatusPill>;
}

/** A line of feedback of a command or a read: a status (it worked) or an alert (it was refused). */
export function Notice({ tone, children, testId }: { tone: 'ok' | 'error' | 'info'; children: ReactNode; testId?: string }) {
  return (
    <p className={tone === 'error' ? 'callout dir-error' : 'callout'} role={tone === 'error' ? 'alert' : 'status'} data-testid={testId}>
      {children}
    </p>
  );
}

/** The note that the numbers follow a policy: where it came from, and that a built-in default is a starting value nobody confirmed. */
export function PolicyNote({ policy }: { policy: Policy }) {
  const { t } = useTranslation();
  return (
    <p className="muted" data-testid="policy-note">
      {t('dir.policy.line.text', {
        reminders: policy.reminderDaysBefore.join(', '),
        escalate: policy.escalateAfterOverdueDays,
        extensions: policy.maxExtensions,
        days: policy.maxExtensionDays,
        source: policyVersionText(t, policy),
      })}
      {policy.unverified ? ` ${t('dir.policy.unverified.text')}` : ''}
    </p>
  );
}

export interface FormulaTileProps {
  label: string;
  value: string;
  tone?: Tone;
  /** What the figure says in one line under it. */
  sub?: string;
  /** The definition the server gave the figure: its formula, and where and when it was counted. */
  formula: string | undefined;
  asOf: string;
  policy: Policy;
  /** The version of the definition when it is not the policy of the clock (the figures of a period). */
  version?: string;
  state?: UiState;
  onRetry?: () => void;
}

/** A figure with its "i": the formula the server gave, the source, the time it is as of, the owner and the version of the policy it was counted with (G0-4). */
export function FormulaTile({ label, value, tone, sub, formula, asOf, policy, version, state = 'ready', onRetry }: FormulaTileProps) {
  const { t } = useTranslation();
  return (
    <KpiTile
      label={label}
      value={value}
      {...(tone === undefined ? {} : { tone })}
      state={state}
      {...(onRetry === undefined ? {} : { onRetry })}
      sub={
        <span className="dir-tile-sub">
          {sub === undefined ? null : <span>{sub}</span>}
          {formula === undefined || state !== 'ready' ? null : (
            <InfoFormula name={label} formula={formula} source={t('dir.info.source.text')} asOf={asOfText(asOf)} owner={t('dir.info.owner.text')} version={version ?? policyVersionText(t, policy)} unverified={policy.unverified} labels={infoLabels(t, label)} />
          )}
        </span>
      }
    />
  );
}

/** The directives of a meeting or of a project, one row each; the code opens the directive. */
export function DirectiveTable({ rows, caption, state = 'ready' }: { rows: DirectiveLine[]; caption: string; state?: UiState }) {
  const { t } = useTranslation();
  const columns: DataTableColumn<DirectiveLine>[] = [
    { key: 'code', header: t('dir.table.code.header'), pinned: true, render: (row) => <Link to={directivePath(row.id)}>{row.code}</Link> },
    { key: 'text', header: t('dir.table.text.header'), render: (row) => row.text },
    { key: 'about', header: t('dir.table.about.header'), render: (row) => (row.project === null ? t('dir.table.about.unit', { unit: row.scopeUnit.code }) : row.project.code) },
    { key: 'unit', header: t('dir.table.unit.header'), render: (row) => (row.assignee === null ? row.assigneeUnit.code : `${row.assigneeUnit.code} · ${row.assignee.displayName}`) },
    { key: 'due', header: t('dir.table.due.header'), render: (row) => dayText(row.dueOn) },
    { key: 'clock', header: t('dir.table.clock.header'), render: (row) => <ClockChip line={row} /> },
    { key: 'status', header: t('dir.table.status.header'), render: (row) => <StatusChip status={row.status} /> },
  ];
  return <DataTable caption={caption} columns={columns} rows={rows} rowKey={(row) => row.id} state={state} severity={(row) => (row.phase === 'ESCALATED' ? 'URGENT' : row.status === 'OVERDUE' ? 'ACTION' : null)} />;
}
