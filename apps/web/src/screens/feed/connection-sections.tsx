import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { Translator } from '../../i18n';
import { ConfirmDialog, DataTable, KpiStrip, KpiTile, ReadonlyStat, SectionCard, SeverityBadge, StatusPill } from '../../ui';
import type { Tone } from '../../ui';
import { useSetState } from './feed-hooks';
import {
  adapterStatusLabel,
  adapterTone,
  alertLabel,
  channelLabel,
  channelNote,
  channelReasonLabel,
  columnKindLabel,
  cursorLabel,
  findingLabel,
  healthExplain,
  healthLabel,
  historyActionLabel,
  kindLabel,
  pendingWords,
  problemText,
  severityLabel,
  unitStatusLabel,
} from './feed-labels';
import {
  INDICATOR_CODES,
  MIN_REASON,
  PATHS,
  KINDS,
  dayText,
  describeProblem,
  healthIcon,
  healthTone,
  indicatorOf,
  indicatorTone,
  isFirstUse,
  isUnverified,
  numberText,
  percentText,
  recordRows,
  severityOf,
  total,
  vietnamStamp,
} from './feed-model';
import type { Connection, Finding, HistoryEntry, IndicatorCode, Layout, PendingItem, Position, UnitReport } from './feed-model';
import { AcceptanceBadge, ChannelTag, DASH, Figure } from './feed-parts';
import { RunsTable } from './run-components';
import './feed.css';

type T = Translator['t'];

function Row({ label, testId, children }: { label: string; testId: string; children: ReactNode }) {
  return (
    <div className="feed-fact" data-testid={testId}>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

const MAPPING_ORDER = ['PROPOSED', 'ACTIVE', 'REJECTED', 'RETIRED'] as const;

function mappingWord(t: T, status: (typeof MAPPING_ORDER)[number]): string {
  switch (status) {
    case 'PROPOSED':
      return t('feed.mapping.status.proposed');
    case 'ACTIVE':
      return t('feed.mapping.status.active');
    case 'REJECTED':
      return t('feed.mapping.status.rejected');
    case 'RETIRED':
      return t('feed.mapping.status.retired');
  }
}

// ---- what needs action ------------------------------------------------------------------------------------------------------------------------------------------------

/** What needs doing now, before any number: a stale feed, a connection that is off, units that are late, large differences that are open, a tenant that has not begun. A first use is a hint, not an alarm. */
export function ActionSection({ connection }: { connection: Connection }) {
  const { t, locale } = useTranslation();
  const health = connection.health;
  const severity = severityOf(health.alert?.severity);
  const items: Array<{ key: string; tone: Tone; icon: string; pill: string; body: ReactNode }> = [];
  if (health.status === 'STALE') {
    items.push({
      key: 'stale',
      tone: 'warning',
      icon: '⚠',
      pill: healthLabel(t, 'STALE'),
      body: (
        <>
          <span>{health.ageHours === null ? t('feed.connection.action.staleNever.text') : t('feed.connection.action.stale.text', { hours: numberText(health.ageHours, locale), max: numberText(health.rule.maxAgeHours, locale) })}</span>
          {severity !== null && <SeverityBadge severity={severity} label={severityLabel(t, severity)} />}
        </>
      ),
    });
  }
  if (connection.registered && !connection.enabled) {
    items.push({ key: 'disabled', tone: 'warning', icon: '⏸', pill: t('feed.connection.status.state.disabled'), body: <span>{t('feed.connection.action.disabled.text')}</span> });
  }
  if (connection.quality.lateUnits.length > 0) {
    items.push({ key: 'late', tone: 'warning', icon: '◷', pill: t('feed.connection.action.late.pill'), body: <span>{t('feed.connection.action.late.text', { count: connection.quality.lateUnits.length })}</span> });
  }
  if (connection.differenceCounts.openLarge > 0) {
    items.push({ key: 'large', tone: 'warning', icon: '≠', pill: t('feed.connection.action.large.pill'), body: <span>{t('feed.connection.action.large.text', { count: connection.differenceCounts.openLarge })}</span> });
  }
  if (isFirstUse(connection)) {
    items.push({
      key: 'first-use',
      tone: 'info',
      icon: 'i',
      pill: healthLabel(t, 'NEVER_RECEIVED'),
      body: (
        <span>
          <strong>{t('feed.connection.firstUse.title')}</strong> {t('feed.connection.firstUse.text')}
        </span>
      ),
    });
  }
  const toRuns = health.status === 'STALE' || isFirstUse(connection);
  return (
    <SectionCard title={t('feed.connection.section.action.title')}>
      {items.length === 0 ? (
        <p className="feed-none" data-testid="action-none">
          {t('feed.connection.action.none.text')}
        </p>
      ) : (
        <ul className="feed-list" data-testid="action-list">
          {items.map((item) => (
            <li key={item.key} data-testid={`action-${item.key}`} className="feed-item">
              <StatusPill tone={item.tone} icon={item.icon}>
                {item.pill}
              </StatusPill>
              {item.body}
            </li>
          ))}
        </ul>
      )}
      {toRuns && (
        <p className="feed-link">
          <Link to={PATHS.runs}>{t('feed.connection.action.import.link')}</Link>
        </p>
      )}
      {connection.differenceCounts.openLarge > 0 && (
        <p className="feed-link">
          <Link to={PATHS.differences}>{t('feed.connection.action.differences.link')}</Link>
        </p>
      )}
    </SectionCard>
  );
}

// ---- the status card --------------------------------------------------------------------------------------------------------------------------------------------------

export function StatusCard({ connection }: { connection: Connection }) {
  const { t } = useTranslation();
  const pending = connection.acceptance === 'PENDING_EXTERNAL';
  const unused = isFirstUse(connection);
  return (
    <SectionCard title={t('feed.connection.section.status.title')} status={<AcceptanceBadge acceptance={connection.acceptance} />}>
      <dl className="feed-facts" data-testid="status-card">
        <Row label={t('feed.connection.status.code.label')} testId="status-code">
          <code>{connection.connectorCode}</code>
        </Row>
        <Row label={t('feed.connection.status.state.label')} testId="status-state">
          {unused ? (
            <StatusPill tone="neutral" icon="○">
              {t('feed.connection.status.state.unused')}
            </StatusPill>
          ) : connection.enabled ? (
            <StatusPill tone="success" icon="✓">
              {t('feed.connection.status.state.enabled')}
            </StatusPill>
          ) : (
            <StatusPill tone="warning" icon="⏸">
              {t('feed.connection.status.state.disabled')}
            </StatusPill>
          )}
        </Row>
        {!unused && (
          <Row label={t('feed.connection.status.reason.label')} testId="status-reason">
            {connection.stateReason ?? t('feed.connection.status.reason.none')}
          </Row>
        )}
        {!unused && (
          <Row label={t('feed.connection.status.changed.label')} testId="status-changed">
            {connection.stateChangedAt === null
              ? t('feed.connection.status.changed.none')
              : t('feed.connection.status.changed.text', { name: connection.stateChangedByName ?? t('feed.connection.status.changed.noName'), time: vietnamStamp(connection.stateChangedAt) })}
          </Row>
        )}
        <Row label={t('feed.connection.status.layout.label')} testId="status-layout">
          <code>{connection.layoutVersion}</code>{' '}
          {pending ? (
            <StatusPill tone="warning" icon="⚠">
              {t('feed.connection.status.layout.pending')}
            </StatusPill>
          ) : (
            <StatusPill tone="success" icon="✓">
              {t('feed.connection.status.layout.accepted')}
            </StatusPill>
          )}
        </Row>
        <Row label={t('feed.connection.status.egress.label')} testId="status-egress">
          {t('feed.connection.status.egress.text')}
        </Row>
      </dl>
    </SectionCard>
  );
}

// ---- the channels -----------------------------------------------------------------------------------------------------------------------------------------------------

export function ChannelsSection({ connection }: { connection: Connection }) {
  const { t } = useTranslation();
  return (
    <SectionCard title={t('feed.connection.section.channels.title')}>
      <DataTable
        caption={t('feed.connection.channels.caption')}
        rows={connection.channels}
        rowKey={(row) => row.channel}
        rowAttrs={(row) => ({ 'data-channel': row.channel })}
        columns={[
          {
            key: 'channel',
            header: t('feed.connection.channels.column.channel'),
            pinned: true,
            render: (row) => (
              <span className="feed-cell">
                <strong>{channelLabel(t, row.channel)}</strong>
                <small>{channelNote(t, row.channel)}</small>
              </span>
            ),
          },
          {
            key: 'adapter',
            header: t('feed.connection.channels.column.adapter'),
            render: (row) => (
              <span className="feed-stack">
                <StatusPill tone={adapterTone(row.adapterStatus)}>{adapterStatusLabel(t, row.adapterStatus)}</StatusPill>
                {row.reason !== null && <small>{channelReasonLabel(t, row.reason)}</small>}
              </span>
            ),
          },
          { key: 'network', header: t('feed.connection.channels.column.network'), render: (row) => (row.opensNetwork ? t('feed.connection.channels.network.yes') : t('feed.connection.channels.network.no')) },
          {
            key: 'last',
            header: t('feed.connection.channels.column.last'),
            render: (row) => {
              const last = connection.lastRuns.find((run) => run.channel === row.channel);
              return last === undefined ? t('feed.connection.channels.last.none') : vietnamStamp(last.createdAt);
            },
          },
        ]}
      />
    </SectionCard>
  );
}

// ---- health -----------------------------------------------------------------------------------------------------------------------------------------------------------

export function HealthSection({ connection }: { connection: Connection }) {
  const { t, locale } = useTranslation();
  const health = connection.health;
  const rule = health.rule;
  const policy = health.policy;
  const severity = severityOf(health.alert?.severity);
  const never = health.status === 'NEVER_RECEIVED';
  const asOf = vietnamStamp(connection.asOf);
  const legal = (unverified: boolean, status: string | null): string => (unverified ? t('feed.connection.figure.legal.unverified') : (status ?? t('feed.connection.figure.legal.none')));
  const policyVersion = t('feed.connection.figure.policy.version', { version: policy.version, source: policy.source === 'RULE' ? t('feed.connection.figure.rule.tenant') : t('feed.connection.figure.rule.default'), legal: legal(isUnverified(policy), policy.legalStatus) });
  const policyFigure = (name: string) => (
    <Figure name={name} formula={policy.formula ?? t('feed.connection.figure.policy.formula')} source={policy.sourceText ?? t('feed.connection.figure.policy.source')} asOf={policy.asOf === null ? asOf : dayText(policy.asOf)} version={policyVersion} unverified={isUnverified(policy)} />
  );
  const days = (value: number | null): string => (value === null ? DASH : numberText(value, locale));
  return (
    <SectionCard title={t('feed.connection.section.health.title')} status={isUnverified(rule) ? <StatusPill tone="neutral">{t('feed.connection.health.unverified.badge')}</StatusPill> : undefined}>
      <p className="feed-explain" data-testid="health-explain" data-status={health.status}>
        {healthExplain(t, health.status)}
      </p>
      <dl className="feed-facts" data-testid="health-card">
        <Row label={t('feed.connection.health.status.label')} testId="health-status">
          <StatusPill tone={healthTone(health.status)} icon={healthIcon(health.status)}>
            {healthLabel(t, health.status)}
          </StatusPill>
        </Row>
        <Row label={t('feed.connection.health.age.label')} testId="health-age">
          {health.ageHours === null ? t('feed.connection.health.age.none') : t('feed.connection.health.age.value', { hours: numberText(health.ageHours, locale) })}{' '}
          <Figure
            name={t('feed.connection.figure.age.name')}
            formula={rule.formula ?? t('feed.connection.figure.age.formula')}
            source={rule.sourceText ?? t('feed.connection.figure.age.source')}
            asOf={rule.asOf === null ? asOf : dayText(rule.asOf)}
            version={t('feed.connection.figure.age.version', { version: rule.version, source: rule.source === 'RULE' ? t('feed.connection.figure.rule.tenant') : t('feed.connection.figure.rule.default'), legal: legal(isUnverified(rule), rule.legalStatus) })}
            unverified={isUnverified(rule)}
          />
        </Row>
        <Row label={t('feed.connection.health.last.label')} testId="health-last">
          {never || health.lastRunAt === null ? (
            t('feed.connection.health.last.none')
          ) : (
            <>
              {t('feed.connection.health.last.value', { time: vietnamStamp(health.lastRunAt) })} {health.lastRunChannel !== null && <ChannelTag channel={health.lastRunChannel} />}
            </>
          )}
        </Row>
        <Row label={t('feed.connection.health.thresholds.label')} testId="health-thresholds">
          {t('feed.connection.health.thresholds.value', { warn: numberText(rule.warnAfterHours, locale), max: numberText(rule.maxAgeHours, locale) })}
        </Row>
        <Row label={t('feed.connection.health.alert.label')} testId="health-alert">
          {health.alert === null ? (
            t('feed.connection.health.alert.none')
          ) : (
            <>
              <span>{t('feed.connection.health.alert.value', { code: health.alert.code })}</span> {severity === null ? <StatusPill tone="warning">{health.alert.severity}</StatusPill> : <SeverityBadge severity={severity} label={severityLabel(t, severity)} />}
            </>
          )}
        </Row>
        <Row label={t('feed.connection.health.figures.label')} testId="health-figures">
          {health.figuresBlocked ? t('feed.connection.health.figures.blocked') : t('feed.connection.health.figures.open')}
        </Row>
        <Row label={t('feed.connection.policy.tolerance.label')} testId="policy-tolerance">
          {policy.tolerancePct === null ? DASH : t('feed.connection.policy.percent.value', { value: numberText(policy.tolerancePct, locale) })} {policyFigure(t('feed.connection.policy.tolerance.label'))}
        </Row>
        <Row label={t('feed.connection.policy.large.label')} testId="policy-large">
          {policy.largeDiscrepancyPct === null ? DASH : t('feed.connection.policy.percent.value', { value: numberText(policy.largeDiscrepancyPct, locale) })} {policyFigure(t('feed.connection.policy.large.label'))}
        </Row>
        <Row label={t('feed.connection.policy.reportDue.label')} testId="policy-report-due">
          {t('feed.connection.policy.days.value', { count: days(policy.reportDueDays) })} {policyFigure(t('feed.connection.policy.reportDue.label'))}
        </Row>
        <Row label={t('feed.connection.policy.differenceDue.label')} testId="policy-difference-due">
          {t('feed.connection.policy.days.value', { count: days(policy.differenceDueDays) })} {policyFigure(t('feed.connection.policy.differenceDue.label'))}
        </Row>
      </dl>
      {(isUnverified(rule) || isUnverified(policy)) && (
        <p className="callout" data-testid="health-unverified">
          {t('feed.connection.health.unverified.text')}
        </p>
      )}
    </SectionCard>
  );
}

// ---- data quality -----------------------------------------------------------------------------------------------------------------------------------------------------

function indicatorWords(t: T, code: IndicatorCode): { label: string; unit: string; name: string; formula: string; source: string } {
  switch (code) {
    case 'FEED_COMPLETENESS':
      return { label: t('feed.connection.quality.completeness.label'), unit: t('feed.connection.quality.units.unit'), name: t('feed.connection.quality.completeness.name'), formula: t('feed.connection.quality.completeness.formula'), source: t('feed.connection.quality.completeness.source') };
    case 'FEED_TIMELINESS':
      return { label: t('feed.connection.quality.timeliness.label'), unit: t('feed.connection.quality.units.unit'), name: t('feed.connection.quality.timeliness.name'), formula: t('feed.connection.quality.timeliness.formula'), source: t('feed.connection.quality.timeliness.source') };
    case 'FEED_DISCREPANCY_RATE':
      return { label: t('feed.connection.quality.discrepancy.label'), unit: t('feed.connection.quality.figures.unit'), name: t('feed.connection.quality.discrepancy.name'), formula: t('feed.connection.quality.discrepancy.formula'), source: t('feed.connection.quality.discrepancy.source') };
  }
}

/** The three indicators of the data quality of the month: each with the percent, the two numbers it is made of, the day it is as of and its "i". A figure that cannot be computed says so, it is never drawn as zero. */
export function QualitySection({ connection }: { connection: Connection }) {
  const { t, locale } = useTranslation();
  const quality = connection.quality;
  const empty = INDICATOR_CODES.every((code) => (indicatorOf(quality, code)?.denominator ?? 0) === 0);
  return (
    <SectionCard title={t('feed.connection.section.quality.title')}>
      <p className="feed-note" data-testid="quality-period">
        {t('feed.connection.quality.period.text', { month: quality.month, year: quality.fiscalYear, due: dayText(quality.dueOn) })}
      </p>
      {empty && (
        <p className="callout" role="status" data-testid="quality-partial">
          {t('feed.connection.quality.partial.text')}
        </p>
      )}
      <KpiStrip label={t('feed.connection.quality.group.label')}>
        {INDICATOR_CODES.map((code) => {
          const indicator = indicatorOf(quality, code);
          const words = indicatorWords(t, code);
          const asOf = indicator?.asOf === null || indicator?.asOf === undefined ? vietnamStamp(connection.asOf) : dayText(indicator.asOf);
          const pct = indicator?.pct ?? null;
          return (
            <div key={code} data-testid={`indicator-${code}`} data-code={code}>
              <KpiTile
                label={words.label}
                value={pct === null ? t('feed.connection.quality.notComputable.text') : percentText(pct, locale)}
                tone={indicatorTone(code, indicator)}
                sub={
                  <>
                    <span data-testid={`indicator-${code}-ratio`}>{indicator === undefined ? DASH : t('feed.connection.quality.ratio.text', { numerator: numberText(indicator.numerator, locale), denominator: numberText(indicator.denominator, locale), unit: words.unit })}</span>{' '}
                    <Figure
                      name={words.name}
                      formula={words.formula}
                      source={words.source}
                      asOf={asOf}
                      numerator={indicator === undefined ? undefined : numberText(indicator.numerator, locale)}
                      denominator={indicator === undefined ? undefined : numberText(indicator.denominator, locale)}
                      version={t('feed.connection.figure.quality.version', { code })}
                      unverified={isUnverified(connection.health.policy)}
                    />
                  </>
                }
              />
            </div>
          );
        })}
      </KpiStrip>
    </SectionCard>
  );
}

export function LateUnitsSection({ connection }: { connection: Connection }) {
  const { t, locale } = useTranslation();
  const units = connection.quality.lateUnits;
  return (
    <SectionCard title={t('feed.connection.section.late.title')}>
      {units.length === 0 ? (
        <p className="feed-none" data-testid="late-empty">
          {t('feed.connection.late.empty.text')}
        </p>
      ) : (
        <DataTable<UnitReport>
          caption={t('feed.connection.late.caption')}
          rows={units}
          rowKey={(row) => row.investorCode}
          rowAttrs={(row) => ({ 'data-investor': row.investorCode })}
          columns={[
            { key: 'unit', header: t('feed.connection.late.column.unit'), pinned: true, render: (row) => (row.investorName === null ? row.investorCode : `${row.investorCode} · ${row.investorName}`) },
            { key: 'status', header: t('feed.connection.late.column.status'), render: (row) => <StatusPill tone="warning">{unitStatusLabel(t, row.status)}</StatusPill> },
            { key: 'due', header: t('feed.connection.late.column.due'), render: (row) => dayText(row.dueOn) },
            { key: 'projects', header: t('feed.connection.late.column.projects'), align: 'right', render: (row) => numberText(row.projects, locale) },
          ]}
        />
      )}
    </SectionCard>
  );
}

export function AlertsSection({ connection }: { connection: Connection }) {
  const { t, locale } = useTranslation();
  const findings = connection.quality.findings;
  const shown = findings.slice(0, 10);
  return (
    <SectionCard title={t('feed.connection.section.alerts.title')}>
      {connection.alerts.length === 0 ? (
        <p className="feed-none" data-testid="alerts-empty">
          {t('feed.connection.alerts.empty.text')}
        </p>
      ) : (
        <ul className="feed-list" data-testid="alerts-list">
          {connection.alerts.map((alert) => {
            const severity = severityOf(alert.severity);
            return (
              <li key={`${alert.code}:${alert.subject}`} className="feed-item" data-code={alert.code}>
                {severity === null ? <StatusPill tone="warning">{alert.severity}</StatusPill> : <SeverityBadge severity={severity} label={severityLabel(t, severity)} />}
                <span>{alertLabel(t, alert.code, alert.subject)}</span>
              </li>
            );
          })}
        </ul>
      )}
      <h3 className="feed-note" data-testid="findings-count">
        {t('feed.connection.findings.count.text', { count: numberText(connection.quality.findingsTotal, locale) })}{' '}
        <Figure
          name={t('feed.connection.findings.name')}
          formula={t('feed.connection.findings.formula')}
          source={t('feed.connection.findings.source')}
          asOf={vietnamStamp(connection.quality.asOf ?? connection.asOf)}
        />
      </h3>
      {shown.length > 0 && (
        <DataTable<Finding>
          caption={t('feed.connection.findings.caption')}
          rows={shown}
          rowKey={(row) => `${row.code}:${row.feedProjectCode}:${row.fundCode ?? ''}:${row.month ?? ''}:${row.channel ?? ''}`}
          rowAttrs={(row) => ({ 'data-code': row.code })}
          columns={[
            { key: 'code', header: t('feed.connection.findings.column.code'), pinned: true, render: (row) => findingLabel(t, row.code) },
            { key: 'project', header: t('feed.connection.findings.column.project'), render: (row) => <code>{row.feedProjectCode}</code> },
            { key: 'fund', header: t('feed.connection.findings.column.fund'), render: (row) => row.fundCode ?? DASH },
            { key: 'month', header: t('feed.connection.findings.column.month'), align: 'right', render: (row) => (row.month === null ? DASH : row.month) },
            { key: 'values', header: t('feed.connection.findings.column.values'), render: (row) => (row.expected === null && row.actual === null ? DASH : t('feed.connection.findings.values.text', { expected: row.expected ?? DASH, actual: row.actual ?? DASH })) },
          ]}
        />
      )}
      {connection.quality.findingsTotal > shown.length && (
        <p className="sub" role="status" data-testid="findings-truncated">
          {t('feed.connection.findings.truncated.text', { shown: shown.length, total: connection.quality.findingsTotal })}
        </p>
      )}
    </SectionCard>
  );
}

// ---- the numbers ------------------------------------------------------------------------------------------------------------------------------------------------------

export function CountsSection({ connection }: { connection: Connection }) {
  const { t, locale } = useTranslation();
  const mapping = connection.mappingCounts;
  const rows = recordRows(connection.recordCounts);
  const asOf = vietnamStamp(connection.asOf);
  return (
    <SectionCard title={t('feed.connection.section.counts.title')}>
      <KpiStrip label={t('feed.connection.counts.group.label')}>
        <KpiTile
          label={t('feed.connection.counts.total.label')}
          value={numberText(total(connection.recordCounts), locale)}
          unit={t('feed.connection.counts.records.unit')}
          sub={<Figure name={t('feed.connection.figure.records.name')} formula={t('feed.connection.figure.records.formula')} source={t('feed.connection.figure.records.source')} asOf={asOf} />}
        />
        <KpiTile
          label={t('feed.connection.counts.differences.label')}
          value={numberText(connection.differenceCounts.open, locale)}
          tone={connection.differenceCounts.open > 0 ? 'warning' : 'default'}
          sub={
            <>
              <Figure name={t('feed.connection.figure.differences.name')} formula={t('feed.connection.figure.differences.formula')} source={t('feed.connection.figure.differences.source')} asOf={asOf} /> <Link to={PATHS.differences}>{t('feed.connection.counts.differences.link')}</Link>
            </>
          }
        />
        <KpiTile
          label={t('feed.connection.counts.mappings.label')}
          value={numberText(mapping.ACTIVE ?? 0, locale)}
          sub={
            <>
              <span data-testid="mapping-counts">{MAPPING_ORDER.map((status) => `${mappingWord(t, status)}: ${numberText(mapping[status] ?? 0, locale)}`).join(' · ')}</span>{' '}
              <Figure name={t('feed.connection.figure.mappings.name')} formula={t('feed.connection.figure.mappings.formula')} source={t('feed.connection.figure.mappings.source')} asOf={asOf} /> <Link to={PATHS.mapping}>{t('feed.connection.counts.mappings.link')}</Link>
            </>
          }
        />
      </KpiStrip>
      <ul className="feed-stats" aria-label={t('feed.connection.counts.records.label')} data-testid="record-counts">
        {rows.map((row) => (
          <li key={row.kind} data-kind={row.kind}>
            <ReadonlyStat label={kindLabel(t, row.kind)} value={numberText(row.count, locale)} sub={t('feed.connection.counts.records.unit')} />
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}

// ---- positions, layouts, runs -----------------------------------------------------------------------------------------------------------------------------------------

export function PositionsSection({ connection }: { connection: Connection }) {
  const { t } = useTranslation();
  const order = (kind: string): number => {
    const found = (KINDS as readonly string[]).indexOf(kind);
    return found === -1 ? KINDS.length : found;
  };
  const rows = [...connection.positions].sort((a, b) => order(a.kind) - order(b.kind));
  return (
    <SectionCard title={t('feed.connection.section.positions.title')}>
      <DataTable<Position>
        caption={t('feed.connection.positions.caption')}
        rows={rows}
        rowKey={(row) => row.connectorCode}
        rowAttrs={(row) => ({ 'data-kind': row.kind })}
        columns={[
          { key: 'kind', header: t('feed.connection.positions.column.kind'), pinned: true, render: (row) => kindLabel(t, row.kind) },
          { key: 'code', header: t('feed.connection.positions.column.code'), render: (row) => <code>{row.connectorCode}</code> },
          { key: 'cursor', header: t('feed.connection.positions.column.cursor'), render: (row) => cursorLabel(t, row.cursorStatus) },
          { key: 'success', header: t('feed.connection.positions.column.success'), render: (row) => (row.lastSuccessAt === null ? t('feed.connection.positions.success.none') : vietnamStamp(row.lastSuccessAt)) },
          { key: 'error', header: t('feed.connection.positions.column.error'), render: (row) => (row.lastErrorCode === null ? t('feed.connection.positions.error.none') : <code>{row.lastErrorCode}</code>) },
        ]}
      />
    </SectionCard>
  );
}

/** The columns each layout expects, one collapsible group per kind of file: these are the working assumption, and the section says so. */
export function LayoutsSection({ connection }: { connection: Connection }) {
  const { t } = useTranslation();
  return (
    <SectionCard title={t('feed.connection.section.layouts.title')} status={<AcceptanceBadge acceptance={connection.acceptance} />}>
      <p className="feed-note" data-testid="layouts-version">
        {t('feed.connection.layouts.version.text', { version: connection.layoutVersion })}
      </p>
      {connection.layouts.map((layout: Layout) => {
        const name = kindLabel(t, layout.kind);
        return (
          <details key={layout.kind} className="feed-layout" data-testid="layout" data-kind={layout.kind}>
            <summary>{t('feed.connection.layouts.summary.text', { kind: name, count: layout.columns.length })}</summary>
            <DataTable<Layout['columns'][number]>
              caption={t('feed.connection.layouts.caption', { kind: name })}
              rows={layout.columns}
              rowKey={(row) => row.name}
              columns={[
                { key: 'name', header: t('feed.connection.layouts.column.name'), pinned: true, render: (row) => <code>{row.name}</code> },
                { key: 'kind', header: t('feed.connection.layouts.column.kind'), render: (row) => columnKindLabel(t, row.kind) },
                { key: 'required', header: t('feed.connection.layouts.column.required'), render: (row) => (row.required ? t('feed.runs.columns.required') : t('feed.runs.columns.optional')) },
                { key: 'values', header: t('feed.connection.layouts.column.values'), render: (row) => (row.values.length === 0 ? t('feed.connection.layouts.values.none') : row.values.join(', ')) },
              ]}
            />
          </details>
        );
      })}
    </SectionCard>
  );
}

export function RunsSection({ connection }: { connection: Connection }) {
  const { t } = useTranslation();
  return (
    <SectionCard title={t('feed.connection.section.runs.title')} actions={<Link to={PATHS.runs}>{t('feed.connection.runs.link')}</Link>}>
      {connection.lastRuns.length === 0 ? (
        <p className="feed-none" data-testid="runs-empty">
          {t('feed.connection.runs.empty.text')}
        </p>
      ) : (
        <RunsTable runs={connection.lastRuns} caption={t('feed.connection.runs.caption')} />
      )}
    </SectionCard>
  );
}

// ---- pending external, history ------------------------------------------------------------------------------------------------------------------------------------------

export function PendingSection({ connection }: { connection: Connection }) {
  const { t } = useTranslation();
  return (
    <SectionCard title={t('feed.connection.section.pending.title')}>
      <p className="feed-note">{t('feed.connection.pending.intro.text')}</p>
      {connection.pendingExternal.length === 0 ? (
        <p className="feed-none">{t('feed.connection.pending.empty.text')}</p>
      ) : (
        <DataTable<PendingItem>
          caption={t('feed.connection.pending.caption')}
          rows={connection.pendingExternal}
          rowKey={(row) => row.code}
          rowAttrs={(row) => ({ 'data-code': row.code })}
          columns={[
            { key: 'what', header: t('feed.connection.pending.column.what'), pinned: true, render: (row) => pendingWords(t, row, connection.layoutVersion).what },
            { key: 'owner', header: t('feed.connection.pending.column.owner'), render: (row) => pendingWords(t, row, connection.layoutVersion).owner },
            { key: 'assumption', header: t('feed.connection.pending.column.assumption'), render: (row) => pendingWords(t, row, connection.layoutVersion).assumption },
            { key: 'switches', header: t('feed.connection.pending.column.switches'), render: (row) => pendingWords(t, row, connection.layoutVersion).switches },
          ]}
        />
      )}
    </SectionCard>
  );
}

export function HistorySection({ connection }: { connection: Connection }) {
  const { t } = useTranslation();
  return (
    <SectionCard title={t('feed.connection.section.history.title')}>
      {connection.history.length === 0 ? (
        <p className="feed-none" data-testid="history-empty">
          {t('feed.connection.history.empty.text')}
        </p>
      ) : (
        <DataTable<HistoryEntry>
          caption={t('feed.connection.history.caption')}
          rows={connection.history}
          rowKey={(row) => row.id}
          columns={[
            { key: 'at', header: t('feed.connection.history.column.at'), pinned: true, render: (row) => vietnamStamp(row.occurredAt) },
            { key: 'action', header: t('feed.connection.history.column.action'), render: (row) => historyActionLabel(t, row.action) },
            { key: 'who', header: t('feed.connection.history.column.who'), render: (row) => row.actorName ?? t('feed.connection.history.who.none') },
            { key: 'reason', header: t('feed.connection.history.column.reason'), render: (row) => row.reason ?? t('feed.connection.history.reason.none') },
          ]}
        />
      )}
    </SectionCard>
  );
}

// ---- the one command of the screen ------------------------------------------------------------------------------------------------------------------------------------

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
  const change = useSetState();
  const [failure, setFailure] = useState<unknown>(undefined);
  const sending = useRef(false);
  const target = !connection.enabled;
  const problem = failure === undefined ? undefined : describeProblem(failure);
  return (
    <ConfirmDialog
      open
      title={target ? t('feed.connection.dialog.enable.title') : t('feed.connection.dialog.disable.title')}
      context={[
        { label: t('feed.connection.dialog.context.connector'), value: connection.connectorCode },
        { label: t('feed.connection.dialog.context.current'), value: connection.enabled ? t('feed.connection.status.state.enabled') : t('feed.connection.status.state.disabled') },
        { label: t('feed.connection.dialog.context.after'), value: target ? t('feed.connection.status.state.enabled') : t('feed.connection.status.state.disabled') },
      ]}
      confirmLabel={target ? t('feed.connection.dialog.enable.confirm') : t('feed.connection.dialog.disable.confirm')}
      cancelLabel={t('feed.common.dialog.cancel.action')}
      pending={change.isPending}
      reason={{ label: t('feed.common.dialog.reason.label'), required: true, minLength: MIN_REASON, hint: t('feed.common.dialog.reason.hint', { count: MIN_REASON }) }}
      {...(problem === undefined ? {} : { error: problemText(t, problem) })}
      onCancel={() => {
        sending.current = false;
        onClose();
      }}
      onConfirm={(reason) => {
        if (sending.current) return;
        sending.current = true;
        setFailure(undefined);
        change.mutate(
          { enabled: target, reason: (reason ?? '').trim(), version: connection.version },
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
      <p className="feed-note">{target ? t('feed.connection.dialog.enable.note') : t('feed.connection.dialog.disable.note')}</p>
      {problem?.kind === 'versionConflict' && (
        <button
          type="button"
          className="ui-button ui-button--outline ui-button--small"
          onClick={() => {
            onReload();
            onClose();
          }}
        >
          {t('feed.common.problem.reload.action')}
        </button>
      )}
    </ConfirmDialog>
  );
}
