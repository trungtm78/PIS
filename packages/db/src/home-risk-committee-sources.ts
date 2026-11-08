import { message } from '@machvon/kernel';
import type { WorkKind } from '@machvon/kernel';
import { CommitteeAlertStore } from './committee-store.ts';
import type { CommitteeAlertRow } from './committee-store.ts';
import { forAudience } from './home-integrity-sources.ts';
import { CONSEQUENCES, severityOf } from './home-work-rules.ts';
import { PROJECT_JOINS, Params, SOURCE_LIMIT, base, reach, startOfDay } from './home-work-sources.ts';
import type { SourceContext, SourceRow } from './home-work-sources.ts';

/** The permission that reads the committee workspace and its alerts (`listCommitteeAlerts`, the roles COMMITTEE_HEAD, COMMITTEE_MEMBER and COMMITTEE_SECRETARIAT): the audience of the alerts of the committee, on the whole tenant. */
export const COMMITTEE_AUDIENCE_PERMISSION = 'committee.read';

interface RiskAlertSql {
  id: string;
  project_id: string;
  project_code: string;
  alert_type: 'RISK_SCORE_CRITICAL' | 'RISK_SCORE_JUMP';
  signal_kind: string | null;
  score: number;
  prior_score: number;
  threshold: number;
  status: 'OPEN' | 'ACKNOWLEDGED';
  raised_on: string;
}

const COMMITTEE_KINDS: Readonly<Record<CommitteeAlertRow['alertType'], WorkKind>> = {
  COMMITTEE_PROVINCE_BEHIND: 'COMMITTEE_PROVINCE_BEHIND',
  COMMITTEE_SECTOR_BEHIND: 'COMMITTEE_SECTOR_BEHIND',
  COMMITTEE_UNIT_NOT_REPORTING: 'COMMITTEE_UNIT_NOT_REPORTING',
  COMMITTEE_DIRECTIVE_OVERDUE: 'COMMITTEE_DIRECTIVE_OVERDUE',
};

const label = (...parts: Array<string | null | undefined>): string | null => {
  const text = parts.filter((part): part is string => part !== null && part !== undefined && part !== '').join(' · ');
  return text === '' ? null : text;
};

/**
 * The alerts of two earlier lanes as sources of the alert centre (lane HUBADAPT, `docs/plans/hubadapt.md` step 4). Each reads the table its module keeps and nothing else, and only the rows that are still to be looked at (OPEN, or
 * ACKNOWLEDGED while the condition holds): a RESOLVED row is over.
 *  - `PROJECT_RISK` (MR-1, `project_risk_alert`, alert types RISK_SCORE_CRITICAL and RISK_SCORE_JUMP, owner PROJECT_OWNER): in the scope of the projects of the reader; in the view `mine` the alerts of the projects the reader answers for and the ones
 *    somebody handed to the reader. The target is the risk board of the project.
 *  - `COMMITTEE` (BAN-1, `committee_alert`, alert types COMMITTEE_PROVINCE_BEHIND, COMMITTEE_SECTOR_BEHIND, COMMITTEE_UNIT_NOT_REPORTING, COMMITTEE_DIRECTIVE_OVERDUE, owners COMMITTEE_HEAD and COMMITTEE_SECRETARIAT): the alerts are about the
 *    province, a sector or a unit, never about one project, so the audience is the committee (the permission `committee.read` on the whole tenant); anybody else sees one only when somebody handed it over. The target is the alerts screen of the committee.
 * An alert somebody acknowledged is taken up (lifecycle CLAIMED) and has no day to meet; one that nobody saw is due today, so that it stands in the column of what is near. The row carries its own severity (committee) or the one of its type (risk).
 */
export class HomeRiskCommitteeSources {
  private readonly committeeAlerts = new CommitteeAlertStore();

  async projectRisk(context: SourceContext): Promise<SourceRow[]> {
    const params = new Params();
    const visible = reach(params, context, { source: 'PROJECT_RISK', id: 'a.id', tenant: 'a', responsible: [], unit: false });
    const rows = await context.tx.query<RiskAlertSql>(
      `select a.id, a.project_id, p.code as project_code, a.alert_type, a.signal_kind, a.score::int as score, a.prior_score::int as prior_score, a.threshold, a.status, a.raised_on::text as raised_on
         from machvon.project_risk_alert a
         ${PROJECT_JOINS('a', 'a.project_id')}
        where a.status in ('OPEN', 'ACKNOWLEDGED') and ${visible}
        order by a.raised_at desc, a.id limit ${SOURCE_LIMIT}`,
      params.values,
    );
    return rows.map((row): SourceRow => {
      const critical = row.alert_type === 'RISK_SCORE_CRITICAL';
      const open = row.status === 'OPEN';
      const subject = row.signal_kind === null ? message('home.source.risk.subject.register') : message('home.source.risk.subject.signal', { kind: message(`home.source.risk.signal.${row.signal_kind.toLowerCase()}`) });
      return {
        ...base(row.alert_type),
        id: row.id,
        dueOn: open ? context.today : null,
        originalDueOn: open ? row.raised_on : null,
        title: critical ? message('home.source.risk.critical.title', { project: row.project_code, score: row.score }) : message('home.source.risk.jump.title', { project: row.project_code, points: row.score - row.prior_score }),
        subtitle: label(row.project_code, message('home.source.risk.detail', { subject, prior: row.prior_score, score: row.score, threshold: row.threshold })),
        status: row.status,
        severity: severityOf('PROJECT_RISK', critical ? 'CRITICAL' : 'JUMP', context.rules),
        lifecycle: open ? 'NEW' : 'CLAIMED',
        consequence: (critical ? CONSEQUENCES.RISK_SCORE_CRITICAL : CONSEQUENCES.RISK_SCORE_JUMP) ?? null,
        causeKey: `risk-alert:${row.id}`,
        startedAt: startOfDay(row.raised_on),
        target: { screen: 'PRJ-28', id: row.project_id },
      };
    });
  }

  async committee(context: SourceContext): Promise<SourceRow[]> {
    const live = await this.committeeAlerts.list(context.tx, 'LIVE');
    const rows = live.map((row): SourceRow => {
      const open = row.status === 'OPEN';
      const kind = COMMITTEE_KINDS[row.alertType];
      const name = row.subjectLabel ?? row.subjectKey;
      const value = row.value ?? '-';
      const threshold = row.threshold ?? '-';
      const shown =
        kind === 'COMMITTEE_PROVINCE_BEHIND'
          ? { title: message('home.source.committee.province_behind.title'), detail: message('home.source.committee.province_behind.detail', { value, threshold }) }
          : kind === 'COMMITTEE_SECTOR_BEHIND'
            ? { title: message('home.source.committee.sector_behind.title', { label: name }), detail: message('home.source.committee.sector_behind.detail', { value, threshold }) }
            : kind === 'COMMITTEE_UNIT_NOT_REPORTING'
              ? { title: message('home.source.committee.unit_not_reporting.title', { label: name }), detail: row.value === null ? message('home.source.committee.unit_not_reporting.never', { threshold }) : message('home.source.committee.unit_not_reporting.detail', { value, threshold }) }
              : { title: message('home.source.committee.directive_overdue.title', { label: name, value }), detail: message('home.source.committee.directive_overdue.detail', { threshold }) };
      return {
        ...base(kind),
        id: row.id,
        dueOn: open ? context.today : null,
        originalDueOn: open ? row.openedOn : null,
        title: shown.title,
        subtitle: shown.detail,
        status: row.status,
        severity: severityOf('COMMITTEE', row.severity, context.rules),
        lifecycle: open ? 'NEW' : 'CLAIMED',
        consequence: CONSEQUENCES[kind] ?? null,
        causeKey: `committee-alert:${row.dedupeKey}`,
        startedAt: startOfDay(row.openedOn),
        target: { screen: 'BAN-05', id: row.id },
      };
    });
    return forAudience(context, 'COMMITTEE', COMMITTEE_AUDIENCE_PERMISSION, rows, true);
  }
}
