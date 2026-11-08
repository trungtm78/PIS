import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../../../i18n';
import { DataTable, ReadonlyStat, SectionCard, SeverityBadge, StatusPill } from '../../../../ui';
import type { DataTableColumn, Tone } from '../../../../ui';
import { healthIcon, healthTone, numberText, severityOf, vietnamStamp } from '../shared/format';
import { AcceptanceBadge, Fact, RuleFigure, severityLabel } from '../shared/parts';
import { columnWord, healthExplain, healthLabel, runStatusLabel } from './labels';
import type { Connection, Run } from './model';

const NONE = '–';
export const DIFFERENCES_PATH = '/ebs/ebs-02';

/** What needs doing now, before any number: a stale file, a connection that is off, open differences, a tenant that has not begun. A first use is a hint, not an alarm. */
export function ActionSection({ connection }: { connection: Connection }) {
  const { t, locale } = useTranslation();
  const health = connection.health;
  const severity = severityOf(health.alert?.severity);
  const items: Array<{ key: string; name: string; tone: Tone; icon: string; body: ReactNode }> = [];
  if (health.status === 'STALE') {
    items.push({
      key: 'stale',
      name: t('ebs.action.stale.name'),
      tone: 'warning',
      icon: '⚠',
      body: (
        <>
          <span>{health.age_hours === null ? t('ebs.action.staleNever.text') : t('ebs.action.stale.text', { hours: numberText(health.age_hours, locale), max: numberText(health.rule.max_age_hours, locale) })}</span>
          {severity !== null && <SeverityBadge severity={severity} label={severityLabel(t, severity)} />}
        </>
      ),
    });
  }
  if (connection.item_counts.overdue > 0) {
    items.push({ key: 'overdue', name: t('ebs.action.overdue.name'), tone: 'danger', icon: '!', body: <span>{t('ebs.action.overdue.text', { count: connection.item_counts.overdue })}</span> });
  }
  if (connection.item_counts.open > 0) {
    items.push({
      key: 'open',
      name: t('ebs.action.open.name'),
      tone: 'info',
      icon: '≠',
      body: (
        <span>
          {t('ebs.action.open.text', { count: connection.item_counts.open })}{' '}
          <Link to={DIFFERENCES_PATH}>{t('ebs.action.open.link')}</Link>
        </span>
      ),
    });
  }
  if (connection.registered && !connection.enabled) {
    items.push({ key: 'disabled', name: t('ebs.action.disabled.name'), tone: 'warning', icon: '⏸', body: <span>{t('ebs.action.disabled.text')}</span> });
  }
  if (!connection.registered) {
    items.push({
      key: 'first-use',
      name: t('ebs.action.firstUse.name'),
      tone: 'info',
      icon: 'i',
      body: (
        <span>
          <strong>{t('ebs.firstUse.title')}</strong> {t('ebs.firstUse.text')}
        </span>
      ),
    });
  }
  return (
    <SectionCard title={t('ebs.action.section.title')}>
      {items.length === 0 ? (
        <p className="ent2-none" data-testid="action-none">
          {t('ebs.action.none.text')}
        </p>
      ) : (
        <ul className="ent2-actions" data-testid="action-list">
          {items.map((item) => (
            <li key={item.key} className="ent2-action" data-testid={`action-${item.key}`}>
              <StatusPill tone={item.tone} icon={item.icon}>
                {item.name}
              </StatusPill>
              {item.body}
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

/** What the connection is: a reader of files a person hands over, a layout that is an assumption (PENDING-EXTERNAL), registered as a proposal; nothing is requested from Oracle EBS. */
export function StatusCard({ connection }: { connection: Connection }) {
  const { t } = useTranslation();
  return (
    <SectionCard title={t('ebs.status.section.title')} status={<AcceptanceBadge acceptance={connection.acceptance} />}>
      <dl className="ent2-facts" data-testid="status-card">
        <Fact label={t('ebs.status.code.label')} testId="status-code">
          {connection.connector_code}
        </Fact>
        <Fact label={t('ebs.status.adapter.label')} testId="status-adapter">
          {connection.adapter_status} · {t('ebs.status.adapter.fileReader')}
        </Fact>
        <Fact label={t('ebs.status.mode.label')} testId="status-mode">
          {t('ebs.status.mode.fileImport')}
        </Fact>
        <Fact label={t('ebs.status.layout.label')} testId="status-layout">
          {connection.layout_version} · {connection.acceptance === 'PENDING_EXTERNAL' ? t('ebs.status.layout.pending') : t('ebs.status.layout.accepted')}
        </Fact>
        <Fact label={t('ebs.status.registry.label')} testId="status-registry">
          {connection.registry_status === 'Draft' ? t('ebs.status.registry.draft') : connection.registry_status}
        </Fact>
        <Fact label={t('ebs.status.api.label')} testId="status-api">
          {t('ebs.status.api.missing')} · {connection.api_adapter.reason}
        </Fact>
        <Fact label={t('ebs.status.state.label')} testId="status-state">
          {connection.enabled ? t('ebs.status.state.enabled') : t('ebs.status.state.disabled')}
        </Fact>
        {connection.state_reason !== null && (
          <Fact label={t('ebs.status.reason.label')} testId="status-reason">
            {connection.state_reason}
          </Fact>
        )}
        {connection.state_changed_at !== null && (
          <Fact label={t('ebs.status.changed.label')} testId="status-changed">
            {t('ebs.status.changed.text', { name: connection.state_changed_by_name ?? NONE, time: vietnamStamp(connection.state_changed_at) })}
          </Fact>
        )}
      </dl>
    </SectionCard>
  );
}

/** How fresh the data from the file is, by the rule CONNECTOR_FRESHNESS (code EBS_FILE), and what the register holds of it. */
export function FreshnessCard({ connection }: { connection: Connection }) {
  const { t, locale } = useTranslation();
  const health = connection.health;
  const rule = health.rule;
  const due = connection.due_rule;
  return (
    <SectionCard title={t('ebs.health.section.title')} status={<StatusPill tone={healthTone(health.status)} icon={healthIcon(health.status)}>{healthLabel(t, health.status)}</StatusPill>}>
      <p className="ent2-explain" data-status={health.status} data-testid="health-explain">
        {healthExplain(t, health.status)}
      </p>
      <dl className="ent2-facts">
        <Fact label={t('ebs.health.age.label')} testId="health-age">
          {health.age_hours === null ? NONE : t('ebs.health.age.value', { hours: numberText(health.age_hours, locale) })}{' '}
          <RuleFigure name={t('ebs.health.age.name')} rule={rule} asOf={vietnamStamp(connection.as_of)} fallbackFormula={t('ebs.health.age.formula')} fallbackSource={t('ebs.health.age.source')} />
        </Fact>
        <Fact label={t('ebs.health.last.label')} testId="health-last">
          {health.last_import_at === null ? t('ebs.health.last.never') : vietnamStamp(health.last_import_at)}
        </Fact>
        <Fact label={t('ebs.health.rule.label')} testId="health-rule">
          {t('ebs.health.rule.text', { warn: numberText(rule.warn_after_hours, locale), max: numberText(rule.max_age_hours, locale) })}
          {rule.unverified && <> · {t('ebs.health.rule.unverified')}</>}
        </Fact>
        <Fact label={t('ebs.health.due.label')} testId="health-due">
          {t('ebs.health.due.value', { days: due.due_in_working_days })}{' '}
          <RuleFigure name={t('ebs.health.due.name')} rule={due} asOf={vietnamStamp(connection.as_of)} fallbackFormula={t('ebs.health.due.formula')} fallbackSource={t('ebs.health.due.source')} />
        </Fact>
      </dl>
      <ul className="ent2-stats" data-testid="counts">
        <li>
          <ReadonlyStat label={t('ebs.counts.records.label')} value={numberText(connection.record_counts.records, locale)} />
        </li>
        <li>
          <ReadonlyStat label={t('ebs.counts.projects.label')} value={numberText(connection.record_counts.projects, locale)} />
        </li>
        <li>
          <ReadonlyStat label={t('ebs.counts.open.label')} value={numberText(connection.item_counts.open, locale)} tone={connection.item_counts.open > 0 ? 'warning' : 'neutral'} />
        </li>
        <li>
          <ReadonlyStat label={t('ebs.counts.overdue.label')} value={numberText(connection.item_counts.overdue, locale)} tone={connection.item_counts.overdue > 0 ? 'danger' : 'neutral'} />
        </li>
        <li>
          <ReadonlyStat label={t('ebs.counts.resolved.label')} value={numberText(connection.item_counts.resolved, locale)} tone="success" />
        </li>
      </ul>
    </SectionCard>
  );
}

/** The columns of the layout the file must carry: the names the person looks for in their export. */
export function LayoutSection({ connection }: { connection: Connection }) {
  const { t } = useTranslation();
  return (
    <SectionCard title={t('ebs.layout.section.title')} status={<AcceptanceBadge acceptance={connection.acceptance} />}>
      <p className="ent2-note">{t('ebs.layout.note.text', { version: connection.layout_version })}</p>
      <ul className="ent2-columns" data-testid="layout-columns">
        {connection.columns.map((column) => (
          <li key={column}>
            <code>{column}</code> · {columnWord(t, column)}
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}

/** The newest tries of the import, each with its counts. */
export function RunsSection({ connection }: { connection: Connection }) {
  const { t, locale } = useTranslation();
  const columns: DataTableColumn<Run>[] = [
    { key: 'time', header: t('ebs.runs.column.time'), pinned: true, render: (row) => vietnamStamp(row.created_at) },
    { key: 'status', header: t('ebs.runs.column.status'), render: (row) => <StatusPill tone={row.status === 'APPLIED' ? 'success' : row.status === 'FAILED' ? 'danger' : 'info'}>{runStatusLabel(t, row.status)}</StatusPill> },
    { key: 'layout', header: t('ebs.runs.column.layout'), render: (row) => row.layout_version },
    { key: 'applied', header: t('ebs.runs.column.applied'), align: 'right', render: (row) => numberText(row.counts.applied, locale) },
    { key: 'quarantined', header: t('ebs.runs.column.quarantined'), align: 'right', render: (row) => numberText(row.counts.quarantined, locale) },
    { key: 'by', header: t('ebs.runs.column.by'), render: (row) => row.imported_by_name ?? NONE },
    { key: 'hash', header: t('ebs.runs.column.hash'), render: (row) => <code className="ent2-key">{row.file_sha256.slice(0, 12)}</code> },
  ];
  return (
    <SectionCard title={t('ebs.runs.section.title')}>
      {connection.last_runs.length === 0 ? (
        <p className="ent2-none" data-testid="runs-empty">
          {t('ebs.runs.empty.text')}
        </p>
      ) : (
        <DataTable caption={t('ebs.runs.section.title')} columns={columns} rows={connection.last_runs} rowKey={(row) => row.id} />
      )}
    </SectionCard>
  );
}
