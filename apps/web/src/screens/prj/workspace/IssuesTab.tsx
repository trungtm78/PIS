import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import { DataTable, KpiStrip, KpiTile, StatusPill } from '../../../ui';
import type { DataTableColumn, Tone } from '../../../ui';
import { clockText, statusLabel as directiveStatusLabel } from '../../dir/labels';
import { BOARD_PATH, NO_FILTER, dayText, directivePath } from '../../dir/model';
import type { DirectiveLine } from '../../dir/model';
import { PROFILE_PATH, WARNINGS_PATH } from '../../home/warning-model';
import type { Severity as WarningSeverity, WarningItem } from '../../home/warning-model';
import { DeadlineLine, DueBadge, SeverityBadge, StatusBadge } from '../../iss/issue-components';
import { workspaceLink } from '../../iss/issue-model';
import type { IssueLine } from '../../iss/issue-model';
import type { Level, RiskView, Status as RiskStatus } from '../risk/model';
import { QuerySection } from './common';
import type { TabProps } from './common';
import './ws-issues.css';
import { useDirectiveList, useIssues, useProjectWarnings, useRisks } from './iss-hooks';

const ISSUES_PATH = '/iss/iss-01';
const RISKS_PATH = '/prj/prj-16';
/** A table of the tab shows this many rows; the link of the section opens the whole list. */
const ROWS = 8;

type T = ReturnType<typeof useTranslation>['t'];

function riskLevelLabel(t: T, level: Level): string {
  switch (level) {
    case 'LOW':
      return t('prj.risk.level.low');
    case 'MEDIUM':
      return t('prj.risk.level.medium');
    case 'CRITICAL':
      return t('prj.risk.level.critical');
  }
}

function riskStatusLabel(t: T, status: RiskStatus): string {
  switch (status) {
    case 'OPEN':
      return t('prj.risk.status.open');
    case 'MITIGATING':
      return t('prj.risk.status.mitigating');
    case 'ESCALATED':
      return t('prj.risk.status.escalated');
    case 'ACCEPTED':
      return t('prj.risk.status.accepted');
    case 'CLOSED':
      return t('prj.risk.status.closed');
  }
}

const riskTone = (level: Level): Tone => (level === 'CRITICAL' ? 'danger' : level === 'MEDIUM' ? 'warning' : 'success');

function warningSeverityLabel(t: T, severity: WarningSeverity): string {
  switch (severity) {
    case 'INFO':
      return t('prj.wsTab.iss.warnings.info');
    case 'WARNING':
      return t('prj.wsTab.iss.warnings.warning');
    case 'CRITICAL':
      return t('prj.wsTab.iss.warnings.critical');
  }
}

const warningTone = (severity: WarningSeverity): Tone => (severity === 'CRITICAL' ? 'danger' : severity === 'WARNING' ? 'warning' : 'info');
const directiveTone = (line: DirectiveLine): Tone => (line.status === 'OVERDUE' ? 'danger' : line.status === 'DONE' ? 'success' : line.status === 'CANCELLED' ? 'neutral' : 'info');

/** The issues, risks, early warnings and directives of one project, each read from the module that owns it. */
export default function IssuesTab({ project }: TabProps) {
  return (
    <div className="ws-iss" data-testid="issues-tab" data-project={project.id}>
      <IssuesSection projectId={project.id} />
      <RisksSection projectId={project.id} />
      <WarningsSection projectId={project.id} />
      <DirectivesSection projectId={project.id} />
    </div>
  );
}

function IssuesSection({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const read = useIssues();
  const lines = useMemo(() => (read.data === undefined ? undefined : read.data.filter((line) => line.projectId === projectId)), [read.data, projectId]);
  const now = new Date();
  return (
    <QuerySection<IssueLine[]>
      title={t('prj.wsTab.iss.issues.title')}
      query={{ isLoading: read.isLoading, error: read.error, data: lines, refetch: read.refetch }}
      isEmpty={(data) => data.length === 0}
      emptyText={t('prj.wsTab.iss.issues.empty')}
      linkTo={ISSUES_PATH}
      linkLabel={t('prj.wsTab.iss.issues.link')}
      testId="ws-issues"
    >
      {(data) => {
        const open = data.filter((line) => line.status !== 'CLOSED');
        const overdue = open.filter((line) => line.overdueSince !== null);
        const columns: DataTableColumn<IssueLine>[] = [
          {
            key: 'issue',
            header: t('prj.wsTab.iss.issues.colIssue'),
            render: (line) => (
              <>
                <Link to={workspaceLink(line.id)}>{line.code}</Link>
                <span className="iss-sub">{line.title}</span>
              </>
            ),
          },
          { key: 'severity', header: t('prj.wsTab.iss.col.severity'), render: (line) => <SeverityBadge severity={line.severity} /> },
          { key: 'status', header: t('prj.wsTab.iss.col.status'), render: (line) => <StatusBadge status={line.status} /> },
          {
            key: 'sla',
            header: t('prj.wsTab.iss.issues.colSla'),
            render: (line) => (
              <>
                <DueBadge line={line} now={now} />
                <DeadlineLine line={line} now={now} />
              </>
            ),
          },
        ];
        return (
          <>
            <KpiStrip label={t('prj.wsTab.iss.issues.kpiLabel')}>
              <KpiTile label={t('prj.wsTab.iss.issues.kpiOpen')} value={String(open.length)} />
              <KpiTile label={t('prj.wsTab.iss.issues.kpiOverdue')} value={String(overdue.length)} tone={overdue.length > 0 ? 'danger' : 'default'} />
            </KpiStrip>
            <DataTable columns={columns} rows={data.slice(0, ROWS)} rowKey={(line) => line.id} caption={t('prj.wsTab.iss.issues.title')} />
            {data.length > ROWS ? <p className="muted">{t('prj.wsTab.iss.more.text', { shown: ROWS, total: data.length })}</p> : null}
          </>
        );
      }}
    </QuerySection>
  );
}

function RisksSection({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const read = useRisks(projectId, '');
  const items = useMemo(() => (read.data === undefined ? undefined : read.data.pages.flatMap((page) => page.items)), [read.data]);
  return (
    <QuerySection<RiskView[]>
      title={t('prj.wsTab.iss.risks.title')}
      query={{ isLoading: read.isLoading, error: read.error, data: items, refetch: read.refetch }}
      isEmpty={(data) => data.length === 0}
      emptyText={t('prj.wsTab.iss.risks.empty')}
      linkTo={`${RISKS_PATH}?${new URLSearchParams({ id: projectId }).toString()}`}
      linkLabel={t('prj.wsTab.iss.risks.link')}
      testId="ws-risks"
    >
      {(data) => {
        const columns: DataTableColumn<RiskView>[] = [
          {
            key: 'risk',
            header: t('prj.wsTab.iss.risks.colRisk'),
            render: (risk) => (
              <>
                <code>{risk.code}</code>
                <span className="iss-sub">{risk.title}</span>
              </>
            ),
          },
          { key: 'level', header: t('prj.wsTab.iss.risks.colLevel'), render: (risk) => <StatusPill tone={riskTone(risk.level)}>{`${riskLevelLabel(t, risk.level)} · ${risk.score}`}</StatusPill> },
          { key: 'status', header: t('prj.wsTab.iss.col.status'), render: (risk) => riskStatusLabel(t, risk.status) },
          {
            key: 'due',
            header: t('prj.wsTab.iss.risks.colDue'),
            render: (risk) => (
              <>
                {dayText(risk.dueDate)} {risk.overdue ? <StatusPill tone="danger">{t('prj.wsTab.iss.overdue.text')}</StatusPill> : null}
              </>
            ),
          },
        ];
        return <DataTable columns={columns} rows={data.slice(0, ROWS)} rowKey={(risk) => risk.id} caption={t('prj.wsTab.iss.risks.title')} />;
      }}
    </QuerySection>
  );
}

function WarningsSection({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const read = useProjectWarnings(projectId);
  return (
    <QuerySection<WarningItem[]>
      title={t('prj.wsTab.iss.warnings.title')}
      query={{ isLoading: read.isLoading, error: read.error, data: read.data, refetch: read.refetch }}
      isEmpty={(data) => data.length === 0}
      emptyText={t('prj.wsTab.iss.warnings.empty')}
      linkTo={WARNINGS_PATH}
      linkLabel={t('prj.wsTab.iss.warnings.link')}
      testId="ws-warnings"
    >
      {(data) => {
        const columns: DataTableColumn<WarningItem>[] = [
          {
            key: 'rule',
            header: t('prj.wsTab.iss.warnings.colRule'),
            render: (item) => <Link to={`${PROFILE_PATH}?${new URLSearchParams({ warning: item.id }).toString()}`}>{item.ruleName === '' ? item.ruleCode : item.ruleName}</Link>,
          },
          { key: 'severity', header: t('prj.wsTab.iss.col.severity'), render: (item) => <StatusPill tone={warningTone(item.severity)}>{warningSeverityLabel(t, item.severity)}</StatusPill> },
          { key: 'opened', header: t('prj.wsTab.iss.warnings.colOpened'), render: (item) => dayText(item.openedAt) },
          { key: 'leader', header: t('prj.wsTab.iss.warnings.colLeader'), render: (item) => item.leader?.displayName ?? t('prj.wsTab.iss.none.text') },
        ];
        return <DataTable columns={columns} rows={data.slice(0, ROWS)} rowKey={(item) => item.id} caption={t('prj.wsTab.iss.warnings.title')} />;
      }}
    </QuerySection>
  );
}

function DirectivesSection({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const filter = useMemo(() => ({ ...NO_FILTER, projectId }), [projectId]);
  const read = useDirectiveList(filter, ROWS * 2);
  const items = useMemo(() => (read.data === undefined ? undefined : read.data.pages.flatMap((page) => page.items)), [read.data]);
  return (
    <QuerySection<DirectiveLine[]>
      title={t('prj.wsTab.iss.directives.title')}
      query={{ isLoading: read.isLoading, error: read.error, data: items, refetch: read.refetch }}
      isEmpty={(data) => data.length === 0}
      emptyText={t('prj.wsTab.iss.directives.empty')}
      linkTo={BOARD_PATH}
      linkLabel={t('prj.wsTab.iss.directives.link')}
      testId="ws-directives"
    >
      {(data) => {
        const columns: DataTableColumn<DirectiveLine>[] = [
          {
            key: 'directive',
            header: t('prj.wsTab.iss.directives.colDirective'),
            render: (line) => (
              <>
                <Link to={directivePath(line.id)}>{line.code}</Link>
                <span className="iss-sub">{line.text}</span>
              </>
            ),
          },
          { key: 'unit', header: t('prj.wsTab.iss.directives.colUnit'), render: (line) => line.assigneeUnit.name },
          { key: 'due', header: t('prj.wsTab.iss.risks.colDue'), render: (line) => dayText(line.dueOn) },
          {
            key: 'status',
            header: t('prj.wsTab.iss.col.status'),
            render: (line) => (
              <>
                <StatusPill tone={directiveTone(line)}>{directiveStatusLabel(t, line.status)}</StatusPill>
                <span className="iss-sub">{clockText(t, line)}</span>
              </>
            ),
          },
        ];
        return <DataTable columns={columns} rows={data.slice(0, ROWS)} rowKey={(line) => line.id} caption={t('prj.wsTab.iss.directives.title')} />;
      }}
    </QuerySection>
  );
}
