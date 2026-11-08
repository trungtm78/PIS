import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { Translator } from '../../../i18n';
import { ConfirmDialog, DataTable, InfoFormula, KpiStrip, KpiTile, ReadonlyStat, SectionCard, SeverityBadge, StatusPill } from '../../../ui';
import type { InfoFormulaLabels, Tone } from '../../../ui';
import { useSetEgpConnectionState } from './connection-hooks';
import { cursorLabel, columnKindLabel, errorText, healthExplain, healthLabel, historyActionLabel, kindLabel, mappingLabel, pendingWords, runStatusLabel, severityLabel } from './connection-labels';
import {
  MIN_REASON,
  PATHS,
  dayText,
  failureCode,
  healthIcon,
  healthTone,
  isFirstUse,
  isUnverified,
  numberText,
  orderedPositions,
  recordRows,
  recordTotal,
  severityOf,
  vietnamStamp,
} from './connection-model';
import type { Connection, HistoryEntry, ImportRun, Layout, PendingItem, Position } from './connection-model';

type T = Translator['t'];

const NONE = '–';

function infoLabels(t: T, name: string): InfoFormulaLabels {
  return {
    open: t('egp.connection.info.open.label', { name }),
    close: t('egp.connection.info.close.label'),
    formula: t('egp.connection.info.formula.label'),
    numerator: t('egp.connection.info.numerator.label'),
    denominator: t('egp.connection.info.denominator.label'),
    exclusions: t('egp.connection.info.exclusions.label'),
    source: t('egp.connection.info.source.label'),
    asOf: t('egp.connection.info.asOf.label'),
    owner: t('egp.connection.info.owner.label'),
    version: t('egp.connection.info.version.label'),
    unverified: t('egp.connection.info.unverified.text'),
  };
}

type FigureKind = 'age' | 'records' | 'mappings' | 'differences';

/** The "i" of a computed number: formula, source, the moment it is as of, the owner and the version of its definition. The age takes them from the freshness rule the server applied; the counts are plain counts of the register. */
export function Figure({ kind, connection }: { kind: FigureKind; connection: Connection }) {
  const { t } = useTranslation();
  const asOf = vietnamStamp(connection.as_of);
  if (kind === 'age') {
    const rule = connection.health.rule;
    const name = t('egp.connection.figure.age.name');
    const legal = isUnverified(connection) ? t('egp.connection.figure.legal.unverified') : (rule.legal_status ?? t('egp.connection.figure.legal.none'));
    return (
      <InfoFormula
        name={name}
        formula={rule.formula ?? t('egp.connection.figure.age.formula')}
        source={rule.source_text ?? t('egp.connection.figure.age.source')}
        asOf={rule.as_of === null ? asOf : dayText(rule.as_of)}
        owner={t('egp.connection.figure.owner.text')}
        version={t('egp.connection.figure.age.version', { version: rule.version, source: rule.source === 'RULE' ? t('egp.connection.figure.rule.tenant') : t('egp.connection.figure.rule.default'), legal })}
        unverified={isUnverified(connection)}
        labels={infoLabels(t, name)}
      />
    );
  }
  const words =
    kind === 'records'
      ? { name: t('egp.connection.figure.records.name'), formula: t('egp.connection.figure.records.formula'), source: t('egp.connection.figure.records.source') }
      : kind === 'mappings'
        ? { name: t('egp.connection.figure.mappings.name'), formula: t('egp.connection.figure.mappings.formula'), source: t('egp.connection.figure.mappings.source') }
        : { name: t('egp.connection.figure.differences.name'), formula: t('egp.connection.figure.differences.formula'), source: t('egp.connection.figure.differences.source') };
  return <InfoFormula name={words.name} formula={words.formula} source={words.source} asOf={asOf} owner={t('egp.connection.figure.owner.text')} version={t('egp.connection.figure.noVersion.text')} labels={infoLabels(t, words.name)} />;
}

function Row({ label, testId, children }: { label: string; testId: string; children: ReactNode }) {
  return (
    <div className="egp1-fact" data-testid={testId}>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

// ---- what needs action ----------------------------------------------------------------------------------------------------------------------------------------------

/** What needs doing now, before any number: a stale connection, a connection that is off, a tenant that has not begun. A first use is a hint, not an alarm. */
export function ActionSection({ connection }: { connection: Connection }) {
  const { t, locale } = useTranslation();
  const health = connection.health;
  const severity = severityOf(health.alert?.severity);
  const items: Array<{ key: string; tone: Tone; icon: string; body: ReactNode }> = [];
  if (health.status === 'STALE') {
    items.push({
      key: 'stale',
      tone: 'warning',
      icon: '⚠',
      body: (
        <>
          <span>{health.age_hours === null ? t('egp.connection.action.staleNever.text') : t('egp.connection.action.stale.text', { hours: numberText(health.age_hours, locale), max: numberText(health.rule.max_age_hours, locale) })}</span>
          {severity !== null && <SeverityBadge severity={severity} label={severityLabel(t, severity)} />}
        </>
      ),
    });
  }
  if (connection.registered && !connection.enabled) {
    items.push({ key: 'disabled', tone: 'warning', icon: '⏸', body: <span>{t('egp.connection.action.disabled.text')}</span> });
  }
  if (isFirstUse(connection)) {
    items.push({
      key: 'first-use',
      tone: 'info',
      icon: 'i',
      body: (
        <span>
          <strong>{t('egp.connection.firstUse.title')}</strong> {t('egp.connection.firstUse.text')}
        </span>
      ),
    });
  }
  const link = items.length > 0 && (health.status === 'STALE' || isFirstUse(connection));
  return (
    <SectionCard title={t('egp.connection.section.action.title')}>
      {items.length === 0 ? (
        <p className="egp1-none" data-testid="action-none">
          {t('egp.connection.action.none.text')}
        </p>
      ) : (
        <ul className="egp1-actions" data-testid="action-list">
          {items.map((item) => (
            <li key={item.key} data-testid={`action-${item.key}`} className="egp1-action">
              <StatusPill tone={item.tone} icon={item.icon}>
                {item.key === 'stale' ? healthLabel(t, 'STALE') : item.key === 'disabled' ? t('egp.connection.status.state.disabled') : t('egp.connection.freshness.state.never')}
              </StatusPill>
              {item.body}
            </li>
          ))}
        </ul>
      )}
      {link && (
        <p className="egp1-link">
          <Link to={PATHS.imports}>{t('egp.connection.action.import.link')}</Link>
        </p>
      )}
    </SectionCard>
  );
}

// ---- the status card ---------------------------------------------------------------------------------------------------------------------------------------------

export function StatusCard({ connection }: { connection: Connection }) {
  const { t } = useTranslation();
  const pending = connection.acceptance === 'PENDING_EXTERNAL';
  const api = connection.api_adapter;
  const unused = isFirstUse(connection);
  return (
    <SectionCard title={t('egp.connection.section.status.title')} status={pending ? <StatusPill tone="warning" icon="⚠">{t('egp.connection.acceptance.pending.badge')}</StatusPill> : undefined}>
      <dl className="egp1-facts" data-testid="status-card">
        <Row label={t('egp.connection.status.code.label')} testId="status-code">
          <code>{connection.connector_code}</code>
        </Row>
        <Row label={t('egp.connection.status.adapter.label')} testId="status-adapter">
          <StatusPill tone="info">{connection.adapter_status}</StatusPill> <span>{t('egp.connection.status.adapter.fileOnly')}</span>
        </Row>
        <Row label={t('egp.connection.status.mode.label')} testId="status-mode">
          {connection.mode === 'FILE_IMPORT' ? t('egp.connection.status.mode.fileImport') : connection.mode}
        </Row>
        <Row label={t('egp.connection.status.layout.label')} testId="status-layout">
          <code>{connection.layout_version}</code>{' '}
          {pending ? (
            <StatusPill tone="warning" icon="⚠">
              {t('egp.connection.status.layout.pending')}
            </StatusPill>
          ) : (
            <StatusPill tone="success" icon="✓">
              {t('egp.connection.status.layout.accepted')}
            </StatusPill>
          )}
        </Row>
        <Row label={t('egp.connection.status.registry.label')} testId="status-registry">
          {connection.registry_status === 'Draft' ? t('egp.connection.status.registry.draft') : t('egp.connection.status.registry.other', { status: connection.registry_status })}
        </Row>
        <Row label={t('egp.connection.status.api.label')} testId="status-api">
          {api.status === 'MISSING' ? t('egp.connection.status.api.missing') : t('egp.connection.status.api.other', { status: api.status, reason: api.reason })}
        </Row>
        <Row label={t('egp.connection.status.state.label')} testId="status-state">
          {unused ? (
            <StatusPill tone="neutral" icon="○">
              {t('egp.connection.status.state.unused')}
            </StatusPill>
          ) : connection.enabled ? (
            <StatusPill tone="success" icon="✓">
              {t('egp.connection.status.state.enabled')}
            </StatusPill>
          ) : (
            <StatusPill tone="warning" icon="⏸">
              {t('egp.connection.status.state.disabled')}
            </StatusPill>
          )}
        </Row>
        {!unused && (
          <Row label={t('egp.connection.status.reason.label')} testId="status-reason">
            {connection.state_reason ?? t('egp.connection.status.reason.none')}
          </Row>
        )}
        {!unused && (
          <Row label={t('egp.connection.status.changed.label')} testId="status-changed">
            {connection.state_changed_at === null
              ? t('egp.connection.status.changed.none')
              : t('egp.connection.status.changed.text', { name: connection.state_changed_by_name ?? t('egp.connection.status.changed.noName'), time: vietnamStamp(connection.state_changed_at) })}
          </Row>
        )}
      </dl>
    </SectionCard>
  );
}

// ---- freshness -----------------------------------------------------------------------------------------------------------------------------------------------------

export function FreshnessCard({ connection }: { connection: Connection }) {
  const { t, locale } = useTranslation();
  const health = connection.health;
  const rule = health.rule;
  const severity = severityOf(health.alert?.severity);
  const never = health.status === 'NEVER_IMPORTED';
  return (
    <SectionCard title={t('egp.connection.section.freshness.title')} status={isUnverified(connection) ? <StatusPill tone="neutral">{t('egp.connection.freshness.unverified.badge')}</StatusPill> : undefined}>
      <p className="egp1-explain" data-testid="freshness-explain" data-status={health.status}>
        {healthExplain(t, health.status)}
      </p>
      <dl className="egp1-facts" data-testid="freshness-card">
        <Row label={t('egp.connection.freshness.status.label')} testId="freshness-status">
          <StatusPill tone={healthTone(health.status)} icon={healthIcon(health.status)}>
            {healthLabel(t, health.status)}
          </StatusPill>
        </Row>
        <Row label={t('egp.connection.freshness.age.label')} testId="freshness-age">
          {health.age_hours === null ? t('egp.connection.freshness.age.none') : t('egp.connection.freshness.age.value', { hours: numberText(health.age_hours, locale) })} <Figure kind="age" connection={connection} />
        </Row>
        <Row label={t('egp.connection.freshness.last.label')} testId="freshness-last">
          {never || health.last_import_at === null
            ? t('egp.connection.freshness.last.none')
            : t('egp.connection.freshness.last.value', { time: vietnamStamp(health.last_import_at), kind: health.last_import_kind === null ? NONE : kindLabel(t, health.last_import_kind) })}
        </Row>
        <Row label={t('egp.connection.freshness.thresholds.label')} testId="freshness-thresholds">
          {t('egp.connection.freshness.thresholds.value', { warn: numberText(rule.warn_after_hours, locale), max: numberText(rule.max_age_hours, locale) })}
        </Row>
        <Row label={t('egp.connection.freshness.alert.label')} testId="freshness-alert">
          {health.alert === null ? (
            t('egp.connection.freshness.alert.none')
          ) : (
            <>
              <span>{t('egp.connection.freshness.alert.value', { code: health.alert.code })}</span> {severity === null ? <StatusPill tone="warning">{health.alert.severity}</StatusPill> : <SeverityBadge severity={severity} label={severityLabel(t, severity)} />}
            </>
          )}
        </Row>
        <Row label={t('egp.connection.freshness.figures.label')} testId="freshness-figures">
          {health.figures_blocked ? t('egp.connection.freshness.figures.blocked') : t('egp.connection.freshness.figures.open')}
        </Row>
      </dl>
      {isUnverified(connection) && (
        <p className="callout" data-testid="freshness-unverified">
          {t('egp.connection.freshness.unverified.text')}
        </p>
      )}
      {health.apply_blocked && (
        <p className="callout" role="status" data-testid="freshness-apply-blocked">
          {t('egp.connection.freshness.apply.blocked')}
        </p>
      )}
    </SectionCard>
  );
}

// ---- the numbers -----------------------------------------------------------------------------------------------------------------------------------------------------

export function CountsSection({ connection }: { connection: Connection }) {
  const { t, locale } = useTranslation();
  const mapping = connection.mapping_counts;
  const rows = recordRows(connection.record_counts);
  return (
    <SectionCard title={t('egp.connection.section.counts.title')}>
      <KpiStrip label={t('egp.connection.counts.group.label')}>
        <KpiTile label={t('egp.connection.counts.total.label')} value={numberText(recordTotal(connection.record_counts), locale)} unit={t('egp.connection.counts.records.unit')} sub={<Figure kind="records" connection={connection} />} />
        <KpiTile
          label={t('egp.connection.counts.differences.label')}
          value={numberText(connection.open_differences, locale)}
          tone={connection.open_differences > 0 ? 'warning' : 'default'}
          sub={
            <>
              <Figure kind="differences" connection={connection} /> <Link to={PATHS.imports}>{t('egp.connection.counts.differences.link')}</Link>
            </>
          }
        />
        <KpiTile
          label={t('egp.connection.counts.mappings.label')}
          value={numberText(mapping.ACTIVE, locale)}
          sub={
            <>
              <span data-testid="mapping-counts">{(['PROPOSED', 'ACTIVE', 'REJECTED', 'RETIRED'] as const).map((status) => `${mappingLabel(t, status)}: ${numberText(mapping[status], locale)}`).join(' · ')}</span>{' '}
              <Figure kind="mappings" connection={connection} /> <Link to={PATHS.mapping}>{t('egp.connection.counts.mappings.link')}</Link>
            </>
          }
        />
      </KpiStrip>
      <ul className="egp1-stats" aria-label={t('egp.connection.counts.records.label')} data-testid="record-counts">
        {rows.map((row) => (
          <li key={row.kind} data-kind={row.kind}>
            <ReadonlyStat label={kindLabel(t, row.kind)} value={numberText(row.count, locale)} sub={t('egp.connection.counts.records.unit')} />
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}

// ---- positions, layouts, runs -----------------------------------------------------------------------------------------------------------------------------------

export function PositionsSection({ connection }: { connection: Connection }) {
  const { t } = useTranslation();
  return (
    <SectionCard title={t('egp.connection.section.positions.title')}>
      <DataTable<Position>
        caption={t('egp.connection.positions.caption')}
        rows={orderedPositions(connection.positions)}
        rowKey={(row) => row.connector_code}
        rowAttrs={(row) => ({ 'data-kind': row.kind })}
        columns={[
          { key: 'kind', header: t('egp.connection.positions.column.kind'), pinned: true, render: (row) => kindLabel(t, row.kind) },
          { key: 'code', header: t('egp.connection.positions.column.code'), render: (row) => <code>{row.connector_code}</code> },
          { key: 'cursor', header: t('egp.connection.positions.column.cursor'), render: (row) => cursorLabel(t, row.cursor_status) },
          { key: 'success', header: t('egp.connection.positions.column.success'), render: (row) => (row.last_success_at === null ? t('egp.connection.positions.success.none') : vietnamStamp(row.last_success_at)) },
          { key: 'error', header: t('egp.connection.positions.column.error'), render: (row) => (row.last_error_code === null ? t('egp.connection.positions.error.none') : <code>{row.last_error_code}</code>) },
        ]}
      />
    </SectionCard>
  );
}

function requirement(t: T, column: Layout['columns'][number]): string {
  if (column.required) return t('egp.connection.layouts.required.row');
  return column.header_required ? t('egp.connection.layouts.required.header') : t('egp.connection.layouts.required.optional');
}

/** The columns each layout expects, one collapsible group per kind of file: these are the working assumption, and the section says so. */
export function LayoutsSection({ connection }: { connection: Connection }) {
  const { t } = useTranslation();
  return (
    <SectionCard title={t('egp.connection.section.layouts.title')}>
      <p className="egp1-note" data-testid="layouts-version">
        {t('egp.connection.layouts.version.text', { version: connection.layout_version })}
      </p>
      {connection.layouts.map((layout) => {
        const name = kindLabel(t, layout.kind);
        return (
          <details key={layout.kind} className="egp1-layout" data-testid="layout" data-kind={layout.kind}>
            <summary>{t('egp.connection.layouts.summary.text', { kind: name, count: layout.columns.length })}</summary>
            <DataTable<Layout['columns'][number]>
              caption={t('egp.connection.layouts.caption', { kind: name })}
              rows={layout.columns}
              rowKey={(row) => row.name}
              columns={[
                { key: 'name', header: t('egp.connection.layouts.column.name'), pinned: true, render: (row) => <code>{row.name}</code> },
                { key: 'kind', header: t('egp.connection.layouts.column.kind'), render: (row) => columnKindLabel(t, row.kind) },
                { key: 'required', header: t('egp.connection.layouts.column.required'), render: (row) => requirement(t, row) },
                { key: 'values', header: t('egp.connection.layouts.column.values'), render: (row) => (row.values === undefined || row.values.length === 0 ? t('egp.connection.layouts.values.none') : row.values.join(', ')) },
              ]}
            />
          </details>
        );
      })}
    </SectionCard>
  );
}

function runStatusTone(status: ImportRun['status']): Tone {
  return status === 'APPLIED' ? 'success' : status === 'FAILED' ? 'danger' : 'info';
}

export function RunsSection({ connection }: { connection: Connection }) {
  const { t, locale } = useTranslation();
  return (
    <SectionCard title={t('egp.connection.section.runs.title')} actions={<Link to={PATHS.imports}>{t('egp.connection.runs.link')}</Link>}>
      {connection.last_runs.length === 0 ? (
        <p className="egp1-none" data-testid="runs-empty">
          {t('egp.connection.runs.empty.text')}
        </p>
      ) : (
        <DataTable<ImportRun>
          caption={t('egp.connection.runs.caption')}
          rows={connection.last_runs}
          rowKey={(row) => row.id}
          rowAttrs={(row) => ({ 'data-run-id': row.id })}
          columns={[
          { key: 'kind', header: t('egp.connection.runs.column.kind'), pinned: true, render: (row) => kindLabel(t, row.kind) },
          {
            key: 'layout',
            header: t('egp.connection.runs.column.layout'),
            render: (row) => (
              <span className="egp1-stack">
                <code>{row.layout_version}</code>
                {row.acceptance === 'PENDING_EXTERNAL' ? <StatusPill tone="warning">{t('egp.connection.acceptance.pending.badge')}</StatusPill> : <StatusPill tone="success">{t('egp.connection.acceptance.accepted.badge')}</StatusPill>}
              </span>
            ),
          },
          {
            key: 'status',
            header: t('egp.connection.runs.column.status'),
            render: (row) => (
              <span className="egp1-stack">
                <StatusPill tone={runStatusTone(row.status)}>{runStatusLabel(t, row.status)}</StatusPill>
                {row.error_code !== null && <code>{row.error_code}</code>}
              </span>
            ),
          },
          {
            key: 'counts',
            header: t('egp.connection.runs.column.counts'),
            render: (row) =>
              t('egp.connection.runs.counts.text', {
                total: numberText(row.counts.total, locale),
                applied: numberText(row.counts.applied, locale),
                duplicate: numberText(row.counts.duplicate, locale),
                conflict: numberText(row.counts.conflict, locale),
                quarantined: numberText(row.counts.quarantined, locale),
              }),
          },
          { key: 'differences', header: t('egp.connection.runs.column.differences'), align: 'right', render: (row) => numberText(row.open_differences, locale) },
          { key: 'by', header: t('egp.connection.runs.column.by'), render: (row) => row.imported_by_name ?? t('egp.connection.runs.by.none') },
          { key: 'at', header: t('egp.connection.runs.column.at'), render: (row) => vietnamStamp(row.completed_at ?? row.created_at) },
          ]}
        />
      )}
    </SectionCard>
  );
}

// ---- pending external, history ----------------------------------------------------------------------------------------------------------------------------------

export function PendingSection({ connection }: { connection: Connection }) {
  const { t } = useTranslation();
  return (
    <SectionCard title={t('egp.connection.section.pending.title')}>
      <p className="egp1-note">{t('egp.connection.pending.intro.text')}</p>
      {connection.pending_external.length === 0 ? (
        <p className="egp1-none">{t('egp.connection.pending.empty.text')}</p>
      ) : (
        <DataTable<PendingItem>
          caption={t('egp.connection.pending.caption')}
          rows={connection.pending_external}
          rowKey={(row) => row.code}
          rowAttrs={(row) => ({ 'data-code': row.code })}
          columns={[
            { key: 'what', header: t('egp.connection.pending.column.what'), pinned: true, render: (row) => pendingWords(t, row, connection.layout_version).what },
            { key: 'owner', header: t('egp.connection.pending.column.owner'), render: (row) => pendingWords(t, row, connection.layout_version).owner },
            { key: 'assumption', header: t('egp.connection.pending.column.assumption'), render: (row) => pendingWords(t, row, connection.layout_version).assumption },
            { key: 'switches', header: t('egp.connection.pending.column.switches'), render: (row) => pendingWords(t, row, connection.layout_version).switches },
          ]}
        />
      )}
    </SectionCard>
  );
}

export function HistorySection({ connection }: { connection: Connection }) {
  const { t } = useTranslation();
  return (
    <SectionCard title={t('egp.connection.section.history.title')}>
      {connection.history.length === 0 ? (
        <p className="egp1-none" data-testid="history-empty">
          {t('egp.connection.history.empty.text')}
        </p>
      ) : (
        <DataTable<HistoryEntry>
          caption={t('egp.connection.history.caption')}
          rows={connection.history}
          rowKey={(row) => row.id}
          columns={[
            { key: 'at', header: t('egp.connection.history.column.at'), pinned: true, render: (row) => vietnamStamp(row.occurred_at) },
            { key: 'action', header: t('egp.connection.history.column.action'), render: (row) => historyActionLabel(t, row.action) },
            { key: 'who', header: t('egp.connection.history.column.who'), render: (row) => row.actor_name ?? t('egp.connection.history.who.none') },
            { key: 'reason', header: t('egp.connection.history.column.reason'), render: (row) => row.reason ?? t('egp.connection.history.reason.none') },
          ]}
        />
      )}
    </SectionCard>
  );
}

// ---- the one command --------------------------------------------------------------------------------------------------------------------------------------------------

export interface SwitchDialogProps {
  connection: Connection;
  onClose: () => void;
  /** The switch was made: `enabled` is the state the connection now has. */
  onDone: (enabled: boolean) => void;
  /** The version moved under the caller: read the connection again. */
  onReload: () => void;
}

/** Turns the connection on or off under the version the caller saw. The reason (at least 10 characters) is required before the button is live; a refusal is said inside the dialog; one press sends once. */
export function SwitchDialog({ connection, onClose, onDone, onReload }: SwitchDialogProps) {
  const { t } = useTranslation();
  const change = useSetEgpConnectionState();
  const [failure, setFailure] = useState<unknown>(undefined);
  const sending = useRef(false);
  const target = !connection.enabled;
  const current = connection.enabled ? t('egp.connection.status.state.enabled') : t('egp.connection.status.state.disabled');
  const after = target ? t('egp.connection.status.state.enabled') : t('egp.connection.status.state.disabled');
  return (
    <ConfirmDialog
      open
      title={target ? t('egp.connection.dialog.enable.title') : t('egp.connection.dialog.disable.title')}
      context={[
        { label: t('egp.connection.dialog.context.connector'), value: connection.connector_code },
        { label: t('egp.connection.dialog.context.current'), value: current },
        { label: t('egp.connection.dialog.context.after'), value: after },
      ]}
      confirmLabel={target ? t('egp.connection.dialog.enable.confirm') : t('egp.connection.dialog.disable.confirm')}
      cancelLabel={t('egp.connection.dialog.cancel.action')}
      pending={change.isPending}
      reason={{ label: t('egp.connection.dialog.reason.label'), required: true, minLength: MIN_REASON, hint: t('egp.connection.dialog.reason.hint', { count: MIN_REASON }) }}
      error={failure === undefined ? undefined : errorText(t, failure)}
      onCancel={() => {
        sending.current = false;
        onClose();
      }}
      onConfirm={(reason) => {
        if (sending.current) return;
        sending.current = true;
        setFailure(undefined);
        change.mutate(
          { enabled: target, reason: reason ?? '', version: connection.version },
          {
            onSuccess: () => {
              sending.current = false;
              onDone(target);
            },
            onError: (error) => {
              sending.current = false;
              setFailure(error);
            },
          },
        );
      }}
    >
      <p className="egp1-note">{target ? t('egp.connection.dialog.enable.note') : t('egp.connection.dialog.disable.note')}</p>
      {failureCode(failure) === 'VERSION_CONFLICT' && (
        <button
          type="button"
          className="ui-button ui-button--outline ui-button--small"
          onClick={() => {
            onReload();
            onClose();
          }}
        >
          {t('egp.connection.dialog.reload.action')}
        </button>
      )}
    </ConfirmDialog>
  );
}
