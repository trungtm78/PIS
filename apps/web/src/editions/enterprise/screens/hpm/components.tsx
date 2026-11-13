import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from '../../../../i18n';
import { ConfirmDialog, DataTable, ReadonlyStat, SectionCard, SeverityBadge, StatusPill } from '../../../../ui';
import type { DataTableColumn, Tone } from '../../../../ui';
import { healthIcon, healthTone, numberText, severityOf, vietnamStamp } from '../shared/format';
import { AcceptanceBadge, Fact, Field, RuleFigure, severityLabel } from '../shared/parts';
import { useRecordHpmReceipt, useRetryHpmPush, useSubmitHpmPush } from './hooks';
import { alertLabel, healthExplain, healthLabel, hpmErrorText, lastErrorLabel, outcomeText, pushStatusLabel } from './labels';
import {
  EMPTY_PUSH_FORM,
  EMPTY_RECEIPT_FORM,
  MIN_NOTE,
  PUSH_STATUSES,
  isDemo,
  needsAttention,
  pushBody,
  pushIcon,
  pushProblems,
  pushTone,
  receiptProblems,
  statusFilterOf,
} from './model';
import type { Connection, Push, PushForm, PushResult, PushStatus, ReceiptForm } from './model';

const NONE = '–';

// ---- the connection ---------------------------------------------------------------------------------------------------------------------------------------------------

/** What needs doing now, before any number: a failed push, a stale delivery, a connection that is off, a tenant that has not begun. A first use is a hint, not an alarm. */
export function ActionSection({ connection }: { connection: Connection }) {
  const { t, locale } = useTranslation();
  const health = connection.health;
  const severity = severityOf(health.alert?.severity);
  const items: Array<{ key: string; tone: Tone; icon: string; body: ReactNode }> = [];
  if (health.alert !== null) {
    items.push({
      key: 'alert',
      tone: 'warning',
      icon: '⚠',
      body: (
        <>
          <span>
            {alertLabel(t, health.alert.code)}:{' '}
            {health.failed_pushes > 0
              ? t('hpm.action.failed.text', { count: health.failed_pushes })
              : t('hpm.action.stale.text', { hours: numberText(health.age_hours ?? 0, locale), max: numberText(health.rule.max_age_hours, locale) })}
          </span>
          {severity !== null && <SeverityBadge severity={severity} label={severityLabel(t, severity)} />}
        </>
      ),
    });
  }
  if (health.awaiting_receipt > 0) {
    items.push({ key: 'waiting', tone: 'info', icon: '▤', body: <span>{t('hpm.action.waiting.text', { count: health.awaiting_receipt })}</span> });
  }
  if (connection.registered && !connection.enabled) {
    items.push({ key: 'disabled', tone: 'warning', icon: '⏸', body: <span>{t('hpm.action.disabled.text')}</span> });
  }
  if (!connection.registered) {
    items.push({
      key: 'first-use',
      tone: 'info',
      icon: 'i',
      body: (
        <span>
          <strong>{t('hpm.firstUse.title')}</strong> {t('hpm.firstUse.text')}
        </span>
      ),
    });
  }
  return (
    <SectionCard title={t('hpm.action.section.title')}>
      {items.length === 0 ? (
        <p className="ent2-none" data-testid="action-none">
          {t('hpm.action.none.text')}
        </p>
      ) : (
        <ul className="ent2-actions" data-testid="action-list">
          {items.map((item) => (
            <li key={item.key} className="ent2-action" data-testid={`action-${item.key}`}>
              <StatusPill tone={item.tone} icon={item.icon}>
                {item.key === 'first-use' ? t('hpm.action.firstUse.name') : item.key === 'disabled' ? t('hpm.action.disabled.name') : item.key === 'waiting' ? t('hpm.action.waiting.name') : t('hpm.action.alert.name')}
              </StatusPill>
              {item.body}
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

/** What the connection is: a file writer that stands for HPM, PENDING-EXTERNAL, registered as a proposal; nothing is sent anywhere. */
export function StatusCard({ connection }: { connection: Connection }) {
  const { t } = useTranslation();
  return (
    <SectionCard title={t('hpm.status.section.title')} status={<AcceptanceBadge acceptance={connection.acceptance} />}>
      <dl className="ent2-facts" data-testid="status-card">
        <Fact label={t('hpm.status.code.label')} testId="status-code">
          {connection.connector_code}
        </Fact>
        <Fact label={t('hpm.status.adapter.label')} testId="status-adapter">
          {connection.adapter_status} · {t('hpm.status.adapter.fileWriter')}
        </Fact>
        <Fact label={t('hpm.status.mode.label')} testId="status-mode">
          {t('hpm.status.mode.fileExport')}
        </Fact>
        <Fact label={connection.acceptance === 'PENDING_EXTERNAL' ? t('scr2.hpm.status.format.assumed') : t('hpm.status.format.label')} testId="status-format">
          {connection.package_format} · {connection.acceptance === 'PENDING_EXTERNAL' ? t('hpm.status.format.pending') : t('hpm.status.format.accepted')}
        </Fact>
        <Fact label={t('hpm.status.registry.label')} testId="status-registry">
          {connection.registry_status === 'Draft' ? t('hpm.status.registry.draft') : connection.registry_status}
        </Fact>
        <Fact label={t('hpm.status.api.label')} testId="status-api">
          {t('hpm.status.api.missing')} · {connection.api_adapter.reason}
        </Fact>
        <Fact label={t('hpm.status.state.label')} testId="status-state">
          {connection.enabled ? t('hpm.status.state.enabled') : t('hpm.status.state.disabled')}
        </Fact>
        {connection.state_reason !== null && (
          <Fact label={t('hpm.status.reason.label')} testId="status-reason">
            {connection.state_reason}
          </Fact>
        )}
        {connection.state_changed_at !== null && (
          <Fact label={t('hpm.status.changed.label')} testId="status-changed">
            {t('hpm.status.changed.text', { name: connection.state_changed_by_name ?? NONE, time: vietnamStamp(connection.state_changed_at) })}
          </Fact>
        )}
      </dl>
    </SectionCard>
  );
}

/** How fresh the last delivery is, by the rule HPM_PUSH_POLICY, and how many pushes stand in each state. */
export function FreshnessCard({ connection }: { connection: Connection }) {
  const { t, locale } = useTranslation();
  const health = connection.health;
  const rule = health.rule;
  return (
    <SectionCard title={t('hpm.health.section.title')} status={<StatusPill tone={healthTone(health.status)} icon={healthIcon(health.status)}>{healthLabel(t, health.status)}</StatusPill>}>
      <p className="ent2-explain" data-status={health.status} data-testid="health-explain">
        {healthExplain(t, health.status)}
      </p>
      <dl className="ent2-facts">
        <Fact label={t('scr2.hpm.health.freshness.label')} testId="health-freshness">
          {healthLabel(t, health.status)}
        </Fact>
        <Fact label={t('hpm.health.age.label')} testId="health-age">
          {health.age_hours === null ? NONE : t('hpm.health.age.value', { hours: numberText(health.age_hours, locale) })}{' '}
          <RuleFigure
            name={t('hpm.health.age.name')}
            rule={rule}
            asOf={vietnamStamp(connection.as_of)}
            fallbackFormula={t('hpm.health.age.formula')}
            fallbackSource={t('hpm.health.age.source')}
          />
        </Fact>
        <Fact label={t('hpm.health.last.label')} testId="health-last">
          {health.last_delivery_at === null ? t('hpm.health.last.never') : vietnamStamp(health.last_delivery_at)}
        </Fact>
        <Fact label={t('hpm.health.rule.label')} testId="health-rule">
          {t('hpm.health.rule.text', { warn: numberText(rule.warn_after_hours, locale), max: numberText(rule.max_age_hours, locale), attempts: rule.max_attempts })}
          {rule.unverified && <> · {t('hpm.health.rule.unverified')}</>}
        </Fact>
      </dl>
      <ul className="ent2-stats" data-testid="counts">
        <li>
          <ReadonlyStat label={t('hpm.counts.pushes.label')} value={numberText(connection.counts.pushes, locale)} />
        </li>
        <li>
          <ReadonlyStat label={t('hpm.counts.written.label')} value={numberText(connection.counts.written, locale)} tone="info" />
        </li>
        <li>
          <ReadonlyStat label={t('hpm.counts.accepted.label')} value={numberText(connection.counts.accepted, locale)} tone="success" />
        </li>
        <li>
          <ReadonlyStat label={t('hpm.counts.failed.label')} value={numberText(connection.counts.failed, locale)} tone={connection.counts.failed > 0 ? 'danger' : 'neutral'} />
        </li>
        <li>
          <ReadonlyStat label={t('hpm.counts.rejected.label')} value={numberText(connection.counts.rejected, locale)} />
        </li>
      </ul>
    </SectionCard>
  );
}

/** The newest accepted revision of each report and period: what HPM is known to hold. */
export function AcceptedSection({ connection }: { connection: Connection }) {
  const { t } = useTranslation();
  const columns: DataTableColumn<Connection['accepted_series'][number]>[] = [
    { key: 'layout', header: t('hpm.accepted.column.layout'), render: (row) => row.layout_code },
    { key: 'period', header: t('hpm.accepted.column.period'), render: (row) => row.period },
    { key: 'revision', header: t('hpm.accepted.column.revision'), align: 'right', render: (row) => row.revision },
    { key: 'time', header: t('hpm.accepted.column.time'), render: (row) => vietnamStamp(row.accepted_at) || NONE },
  ];
  return (
    <SectionCard title={t('hpm.accepted.section.title')}>
      {connection.accepted_series.length === 0 ? (
        <p className="ent2-none" data-testid="accepted-empty">
          {t('hpm.accepted.empty.text')}
        </p>
      ) : (
        <DataTable caption={t('hpm.accepted.section.title')} columns={columns} rows={connection.accepted_series} rowKey={(row) => `${row.layout_code}|${row.period}`} />
      )}
    </SectionCard>
  );
}

// ---- the push log -----------------------------------------------------------------------------------------------------------------------------------------------------

export interface LogProps {
  rows: readonly Push[];
  state: 'ready' | 'loading' | 'error';
  filter: PushStatus | undefined;
  onFilter: (status: PushStatus | undefined) => void;
  hasMore: boolean;
  loadingMore: boolean;
  onMore: () => void;
  onRetryLoad: () => void;
  /** Whether the caller holds the permission of a retry and of a receipt: the server says of each row whether it may be tried or received, the session says whether the caller may at all. */
  mayRetry: boolean;
  mayReceipt: boolean;
  onRetry: (push: Push) => void;
  onReceipt: (push: Push) => void;
}

/** The push log: the key, the period and revision, the state, the tries, the last error and the receipt; retry and receipt only where the server says the caller may. */
export function PushLog({ rows, state, filter, onFilter, hasMore, loadingMore, onMore, onRetryLoad, mayRetry, mayReceipt, onRetry, onReceipt }: LogProps) {
  const { t } = useTranslation();
  const filterId = useId();
  const attention = needsAttention(rows);
  const columns: DataTableColumn<Push>[] = [
    { key: 'key', header: t('hpm.log.column.key'), pinned: true, render: (row) => <code className="ent2-key">{row.key}</code> },
    { key: 'period', header: t('hpm.log.column.period'), render: (row) => `${row.layout_code} · ${row.period}` },
    { key: 'revision', header: t('hpm.log.column.revision'), align: 'right', render: (row) => row.revision },
    {
      key: 'status',
      header: t('hpm.log.column.status'),
      render: (row) => (
        <span className="ent2-stack">
          <StatusPill tone={pushTone(row.status)} icon={pushIcon(row.status)}>
            {pushStatusLabel(t, row.status)}
          </StatusPill>
          {row.overwrites && <span className="ent2-note">{t('hpm.log.overwrites.badge')}</span>}
          {isDemo(row) && <span className="ent2-note">{t('hpm.log.demo.badge')}</span>}
        </span>
      ),
    },
    { key: 'attempts', header: t('hpm.log.column.attempts'), align: 'right', render: (row) => row.attempts },
    { key: 'error', header: t('hpm.log.column.error'), render: (row) => lastErrorLabel(t, row.last_error_code) },
    {
      key: 'receipt',
      header: t('hpm.log.column.receipt'),
      render: (row) => (row.receipt === null ? NONE : `${row.receipt.reference} · ${row.receipt.by_name ?? NONE} · ${vietnamStamp(row.receipt.at)}`),
    },
    {
      key: 'actions',
      header: t('hpm.log.column.actions'),
      render: (row) => (
        <span className="ent2-row-actions">
          {mayRetry && row.actions.may_retry && (
            <button type="button" className="ui-button ui-button--outline ui-button--small" data-testid={`retry-${row.id}`} onClick={() => onRetry(row)}>
              {t('hpm.log.retry.action')}
            </button>
          )}
          {mayReceipt && row.actions.may_record_receipt && (
            <button type="button" className="ui-button ui-button--outline ui-button--small" data-testid={`receipt-${row.id}`} onClick={() => onReceipt(row)}>
              {t('hpm.log.receipt.action')}
            </button>
          )}
        </span>
      ),
    },
  ];
  return (
    <SectionCard title={t('hpm.log.section.title')} status={attention.failed + attention.waiting > 0 ? <StatusPill tone="warning">{t('hpm.log.attention.text', { failed: attention.failed, waiting: attention.waiting })}</StatusPill> : undefined}>
      <p className="ent2-note" data-testid="log-note">
        {t('scr2.hpm.log.note')}
      </p>
      <div className="ent2-filter">
        <label htmlFor={filterId}>{t('hpm.log.filter.label')}</label>
        <select id={filterId} value={filter ?? ''} onChange={(event) => onFilter(statusFilterOf(event.target.value))} data-testid="log-filter">
          <option value="">{t('hpm.log.filter.all')}</option>
          {PUSH_STATUSES.map((status) => (
            <option key={status} value={status}>
              {pushStatusLabel(t, status)}
            </option>
          ))}
        </select>
      </div>
      {state === 'ready' && rows.length === 0 ? (
        <p className="ent2-none" role="status" data-testid="log-empty">
          {filter === undefined ? t('hpm.log.empty.none') : t('hpm.log.empty.filtered')}
        </p>
      ) : (
        <DataTable caption={t('hpm.log.section.title')} columns={columns} rows={[...rows]} rowKey={(row) => row.id} state={state} onRetry={onRetryLoad} rowAttrs={(row) => ({ 'data-push-id': row.id, 'data-status': row.status })} />
      )}
      {hasMore && (
        <p className="ent2-more">
          <button type="button" className="ui-button ui-button--outline" disabled={loadingMore} data-testid="log-more" onClick={onMore}>
            {t('hpm.log.more.action')}
          </button>
        </p>
      )}
    </SectionCard>
  );
}

// ---- the dialogs ------------------------------------------------------------------------------------------------------------------------------------------------------

/** The report to push: named by its layout, period and revision, and found in the object store by its key and its hash. The key of the push (organisation, layout, period, revision) is made by the server. */
export function PushDialog({ onClose, onDone }: { onClose: () => void; onDone: (result: PushResult) => void }) {
  const { t } = useTranslation();
  const id = useId();
  const mutation = useSubmitHpmPush();
  const [form, setForm] = useState<PushForm>(EMPTY_PUSH_FORM);
  const [problems, setProblems] = useState<ReturnType<typeof pushProblems>>({});
  const [error, setError] = useState<string | undefined>(undefined);
  const set = (field: keyof PushForm) => (event: { target: { value: string } }) => setForm((current) => ({ ...current, [field]: event.target.value }));
  return (
    <ConfirmDialog
      open
      title={t('hpm.push.dialog.title')}
      context={[
        { label: t('hpm.push.context.target.label'), value: t('hpm.push.context.target.value') },
        { label: t('hpm.push.context.key.label'), value: t('hpm.push.context.key.value') },
      ]}
      confirmLabel={t('hpm.push.dialog.confirm')}
      cancelLabel={t('hpm.dialog.cancel.action')}
      pending={mutation.isPending}
      {...(error === undefined ? {} : { error })}
      onCancel={onClose}
      onConfirm={() => {
        const found = pushProblems(form);
        setProblems(found);
        if (Object.keys(found).length > 0) {
          setError(t('ent.error.validation.text'));
          return;
        }
        setError(undefined);
        mutation.mutateAsync(pushBody(form)).then(onDone, (failure: unknown) => setError(hpmErrorText(t, failure)));
      }}
    >
      <Field id={`${id}-layout`} label={t('hpm.push.field.layout.label')} problem={problems.layoutCode}>
        <input id={`${id}-layout`} value={form.layoutCode} onChange={set('layoutCode')} aria-invalid={problems.layoutCode !== undefined} data-testid="push-layout" />
      </Field>
      <Field id={`${id}-period`} label={t('hpm.push.field.period.label')} problem={problems.period} hint={t('hpm.push.field.period.hint')}>
        <input id={`${id}-period`} value={form.period} onChange={set('period')} aria-invalid={problems.period !== undefined} data-testid="push-period" />
      </Field>
      <Field id={`${id}-revision`} label={t('hpm.push.field.revision.label')} problem={problems.revision}>
        <input id={`${id}-revision`} inputMode="numeric" value={form.revision} onChange={set('revision')} aria-invalid={problems.revision !== undefined} data-testid="push-revision" />
      </Field>
      <Field id={`${id}-sha`} label={t('hpm.push.field.sha.label')} problem={problems.sha256}>
        <input id={`${id}-sha`} value={form.sha256} onChange={set('sha256')} aria-invalid={problems.sha256 !== undefined} data-testid="push-sha" />
      </Field>
      <Field id={`${id}-issue`} label={t('hpm.push.field.issue.label')} problem={problems.issueId} hint={t('hpm.push.field.issue.hint')}>
        <input id={`${id}-issue`} value={form.issueId} onChange={set('issueId')} aria-invalid={problems.issueId !== undefined} data-testid="push-issue" />
      </Field>
      <Field id={`${id}-file`} label={t('hpm.push.field.file.label')} problem={problems.fileObjectKey}>
        <input id={`${id}-file`} value={form.fileObjectKey} onChange={set('fileObjectKey')} aria-invalid={problems.fileObjectKey !== undefined} data-testid="push-file" />
      </Field>
      <Field id={`${id}-correction`} label={t('hpm.push.field.correction.label')} problem={problems.correctionId} hint={t('hpm.push.field.correction.hint')}>
        <input id={`${id}-correction`} value={form.correctionId} onChange={set('correctionId')} aria-invalid={problems.correctionId !== undefined} data-testid="push-correction" />
      </Field>
    </ConfirmDialog>
  );
}

/** Retries a push under the same key: the key and the number of the next try are named before the button. */
export function RetryDialog({ push, onClose, onDone }: { push: Push; onClose: () => void; onDone: (result: PushResult) => void }) {
  const { t } = useTranslation();
  const mutation = useRetryHpmPush();
  const [error, setError] = useState<string | undefined>(undefined);
  return (
    <ConfirmDialog
      open
      title={t('hpm.retry.dialog.title')}
      context={[
        { label: t('hpm.retry.context.key.label'), value: push.key },
        { label: t('hpm.retry.context.attempt.label'), value: t('hpm.retry.context.attempt.value', { attempt: push.attempts + 1 }) },
        { label: t('hpm.retry.context.error.label'), value: lastErrorLabel(t, push.last_error_code) },
      ]}
      confirmLabel={t('hpm.retry.dialog.confirm')}
      cancelLabel={t('hpm.dialog.cancel.action')}
      pending={mutation.isPending}
      {...(error === undefined ? {} : { error })}
      onCancel={onClose}
      onConfirm={() => {
        setError(undefined);
        mutation.mutateAsync({ id: push.id, version: push.version }).then(onDone, (failure: unknown) => setError(hpmErrorText(t, failure)));
      }}
    />
  );
}

/** The answer of the receiver, recorded by somebody other than the pusher: accepted or rejected, with its reference; a copy of a DEMO form can only be rejected. */
export function ReceiptDialog({ push, onClose, onDone }: { push: Push; onClose: () => void; onDone: (outcome: 'ACCEPTED' | 'REJECTED') => void }) {
  const { t } = useTranslation();
  const id = useId();
  const mutation = useRecordHpmReceipt();
  const demo = isDemo(push);
  const [form, setForm] = useState<ReceiptForm>(demo ? { ...EMPTY_RECEIPT_FORM, outcome: 'REJECTED' } : EMPTY_RECEIPT_FORM);
  const [problems, setProblems] = useState<ReturnType<typeof receiptProblems>>({});
  const [error, setError] = useState<string | undefined>(undefined);
  return (
    <ConfirmDialog
      open
      title={t('hpm.receipt.dialog.title')}
      context={[
        { label: t('hpm.receipt.context.key.label'), value: push.key },
        { label: t('hpm.receipt.context.package.label'), value: push.response?.package_name ?? NONE },
        { label: t('hpm.receipt.context.pusher.label'), value: push.pushed_by_name ?? NONE },
      ]}
      confirmLabel={t('hpm.receipt.dialog.confirm')}
      cancelLabel={t('hpm.dialog.cancel.action')}
      pending={mutation.isPending}
      {...(error === undefined ? {} : { error })}
      onCancel={onClose}
      onConfirm={() => {
        const found = receiptProblems(form, demo);
        setProblems(found);
        if (Object.keys(found).length > 0) {
          setError(found.outcome === undefined ? t('ent.error.validation.text') : t('hpm.error.demoForm.text'));
          return;
        }
        setError(undefined);
        mutation.mutateAsync({ id: push.id, version: push.version, outcome: form.outcome, reference: form.reference.trim(), note: form.note }).then(
          () => onDone(form.outcome),
          (failure: unknown) => setError(hpmErrorText(t, failure)),
        );
      }}
    >
      {demo && <p className="ent2-note">{t('hpm.receipt.demo.text')}</p>}
      <fieldset className="ent2-choice">
        <legend>{t('hpm.receipt.field.outcome.label')}</legend>
        <label>
          <input type="radio" name={`${id}-outcome`} checked={form.outcome === 'ACCEPTED'} disabled={demo} onChange={() => setForm((current) => ({ ...current, outcome: 'ACCEPTED' }))} data-testid="receipt-accepted" />
          {t('hpm.receipt.field.outcome.accepted')}
        </label>
        <label>
          <input type="radio" name={`${id}-outcome`} checked={form.outcome === 'REJECTED'} onChange={() => setForm((current) => ({ ...current, outcome: 'REJECTED' }))} data-testid="receipt-rejected" />
          {t('hpm.receipt.field.outcome.rejected')}
        </label>
      </fieldset>
      <Field id={`${id}-reference`} label={t('hpm.receipt.field.reference.label')} problem={problems.reference}>
        <input id={`${id}-reference`} value={form.reference} onChange={(event) => setForm((current) => ({ ...current, reference: event.target.value }))} aria-invalid={problems.reference !== undefined} data-testid="receipt-reference" />
      </Field>
      <Field id={`${id}-note`} label={t('hpm.receipt.field.note.label')} problem={problems.note} hint={form.outcome === 'REJECTED' ? t('hpm.receipt.field.note.hint', { min: MIN_NOTE }) : undefined}>
        <textarea id={`${id}-note`} rows={3} value={form.note} onChange={(event) => setForm((current) => ({ ...current, note: event.target.value }))} aria-invalid={problems.note !== undefined} data-testid="receipt-note" />
      </Field>
    </ConfirmDialog>
  );
}

/** The result of a push or a retry that the server answered, in words: written, repeated, or failed (and may be retried). */
export function ResultNote({ result }: { result: PushResult }) {
  const { t } = useTranslation();
  return (
    <p className={result.status === 'FAILED' ? 'callout' : 'callout ent2-receipt'} role="status" data-testid="push-result" data-outcome={result.status}>
      {outcomeText(t, result.status)} {t('hpm.push.result.detail', { key: result.push.key, attempts: result.push.attempts })}
    </p>
  );
}
