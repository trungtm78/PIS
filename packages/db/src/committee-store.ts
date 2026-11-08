import { DomainError, directiveClock, versionConflict } from '@machvon/kernel';
import type { AssuranceLevel, CommitteeAlert, CommitteeAlertType, CommitteeRole, CommitteeScreen, DirectivePolicy, DirectiveUnitFigure } from '@machvon/kernel';
import type { TenantTx } from './tenant-database.ts';

/**
 * The stores of the committee workspace (lane BAN-1, docs/committee-workspace.md): the roster of the steering committee, the audit of every view of a sensitive screen, the decisions on the attention list, the alerts and
 * the reading of the directives per unit. Every method takes the transaction of the command or the read it belongs to, so that the audit row of a view is written with the read and an alert is raised with its event.
 * Nothing here judges a figure (the kernel does) and nothing here writes a financial table.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ISO = (column: string): string => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const NAME_OF = (alias: string, membership: string): string => `(select u.display_name from machvon.tenant_user_directory u where u.tenant_id = ${alias}.tenant_id and u.membership_id = ${membership})`;
const UNIQUE_VIOLATION = '23505';

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);
const idOf = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !UUID.test(value)) throw invalid(field);
  return value.toLowerCase();
};
const textOf = (value: unknown, field: string, min: number, max: number): string => {
  if (typeof value !== 'string') throw invalid(field);
  const trimmed = value.trim().normalize('NFC');
  if (trimmed.length < min || trimmed.length > max) throw invalid(field);
  return trimmed;
};
const optionalText = (value: unknown, field: string, max: number): string | null => (value === undefined || value === null ? null : textOf(value, field, 1, max));
const dayOf = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !DAY.test(value) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) throw invalid(field);
  return value;
};
const stateInvalid = (detail: string): DomainError => new DomainError('COMMITTEE_STATE_INVALID', 409, detail);
const isUnique = (error: unknown): boolean => typeof error === 'object' && error !== null && (error as { code?: string }).code === UNIQUE_VIOLATION;

// -- the roster ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface CommitteeRow {
  id: string;
  code: string;
  name: string;
  legalBasis: string | null;
  status: 'ACTIVE' | 'ENDED';
  version: number;
}

export interface CommitteeMemberRow {
  id: string;
  committeeId: string;
  membershipId: string;
  displayName: string | null;
  committeeRole: CommitteeRole;
  agencyCode: string | null;
  agencyName: string | null;
  decisionRef: string | null;
  validFrom: string;
  validUntil: string | null;
  mfaRequired: boolean;
  status: 'ACTIVE' | 'ENDED';
  appointedBy: string;
  appointedAt: string;
  endedAt: string | null;
  endReason: string | null;
  /** Whether the person holds an active grant of the system role that goes with the place (COMMITTEE_HEAD, COMMITTEE_MEMBER, COMMITTEE_SECRETARIAT): an appointment without the grant has no power, and the roster says so. */
  roleGranted: boolean;
  version: number;
}

interface CommitteeSql {
  id: string;
  code: string;
  name: string;
  legal_basis: string | null;
  status: 'ACTIVE' | 'ENDED';
  version: string;
}

interface MemberSql {
  id: string;
  committee_id: string;
  membership_id: string;
  display_name: string | null;
  committee_role: CommitteeRole;
  agency_code: string | null;
  agency_name: string | null;
  decision_ref: string | null;
  valid_from: string;
  valid_until: string | null;
  mfa_required: boolean;
  status: 'ACTIVE' | 'ENDED';
  appointed_by: string;
  appointed_at: string;
  ended_at: string | null;
  end_reason: string | null;
  role_granted: boolean;
  version: string;
}

const committeeOf = (row: CommitteeSql): CommitteeRow => ({ id: row.id, code: row.code, name: row.name, legalBasis: row.legal_basis, status: row.status, version: Number(row.version) });
const COMMITTEE_COLUMNS = 'c.id, c.code, c.name, c.legal_basis, c.status, c.version::text as version';

const MEMBER_COLUMNS = `m.id, m.committee_id, m.membership_id, ${NAME_OF('m', 'm.membership_id')} as display_name, m.committee_role, m.agency_code, m.agency_name, m.decision_ref, m.valid_from::text as valid_from,
  m.valid_until::text as valid_until, m.mfa_required, m.status, m.appointed_by, ${ISO('m.appointed_at')} as appointed_at, ${ISO('m.ended_at')} as ended_at, m.end_reason,
  exists (select 1 from machvon.role_grant g join machvon.role_definition r on r.tenant_id = g.tenant_id and r.id = g.role_id
           where g.tenant_id = m.tenant_id and g.membership_id = m.membership_id and g.status = 'Active' and (g.effective_until is null or g.effective_until > now())
             and r.code = case m.committee_role when 'HEAD' then 'COMMITTEE_HEAD' when 'SECRETARIAT' then 'COMMITTEE_SECRETARIAT' else 'COMMITTEE_MEMBER' end) as role_granted,
  m.version::text as version`;

const memberOf = (row: MemberSql): CommitteeMemberRow => ({
  id: row.id,
  committeeId: row.committee_id,
  membershipId: row.membership_id,
  displayName: row.display_name,
  committeeRole: row.committee_role,
  agencyCode: row.agency_code,
  agencyName: row.agency_name,
  decisionRef: row.decision_ref,
  validFrom: row.valid_from,
  validUntil: row.valid_until,
  mfaRequired: row.mfa_required,
  status: row.status,
  appointedBy: row.appointed_by,
  appointedAt: row.appointed_at,
  endedAt: row.ended_at,
  endReason: row.end_reason,
  roleGranted: row.role_granted,
  version: Number(row.version),
});

export interface AppointInput {
  committeeId: unknown;
  membershipId: unknown;
  committeeRole: unknown;
  agencyCode?: unknown;
  agencyName?: unknown;
  decisionRef?: unknown;
  validFrom: unknown;
  validUntil?: unknown;
  mfaRequired?: unknown;
}

export class CommitteeRosterStore {
  async register(tx: TenantTx, input: { code: unknown; name: unknown; legalBasis?: unknown }, actor: string): Promise<CommitteeRow> {
    const code = textOf(input.code, 'code', 2, 40);
    if (!/^[A-Z][A-Z0-9_]{1,39}$/.test(code)) throw invalid('code');
    const name = textOf(input.name, 'name', 1, 300);
    const legalBasis = optionalText(input.legalBasis, 'legal_basis', 500);
    try {
      const rows = await tx.query<CommitteeSql>(
        `insert into machvon.committee (tenant_id, code, name, legal_basis, created_by) values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1, $2, $3, $4)
         returning id, code, name, legal_basis, status, version::text as version`,
        [code, name, legalBasis, actor],
      );
      return committeeOf(rows[0] as CommitteeSql);
    } catch (error) {
      if (isUnique(error)) throw stateInvalid('code_exists');
      throw error;
    }
  }

  async committees(tx: TenantTx): Promise<CommitteeRow[]> {
    const rows = await tx.query<CommitteeSql>(`select ${COMMITTEE_COLUMNS} from machvon.committee c order by c.code`);
    return rows.map(committeeOf);
  }

  async members(tx: TenantTx, committeeId?: string): Promise<CommitteeMemberRow[]> {
    const rows = await tx.query<MemberSql>(
      `select ${MEMBER_COLUMNS} from machvon.committee_member m where ($1::uuid is null or m.committee_id = $1::uuid)
        order by (m.status = 'ACTIVE') desc, case m.committee_role when 'HEAD' then 0 when 'DEPUTY' then 1 when 'SECRETARIAT' then 2 else 3 end, m.appointed_at, m.id`,
      [committeeId === undefined ? null : idOf(committeeId, 'committee_id')],
    );
    return rows.map(memberOf);
  }

  async appoint(tx: TenantTx, input: AppointInput, actor: string): Promise<CommitteeMemberRow> {
    const committeeId = idOf(input.committeeId, 'committee_id');
    const membershipId = idOf(input.membershipId, 'membership_id');
    if (membershipId === actor.toLowerCase()) throw new DomainError('VALIDATION_FAILED', 422, 'membership_id', { extensions: { reason: 'self_appointment' } });
    const role = (['HEAD', 'DEPUTY', 'MEMBER', 'SECRETARIAT'] as const).find((one) => one === input.committeeRole);
    if (role === undefined) throw invalid('committee_role');
    const agencyCode = optionalText(input.agencyCode, 'agency_code', 40);
    if (agencyCode !== null && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/.test(agencyCode)) throw invalid('agency_code');
    const validFrom = dayOf(input.validFrom, 'valid_from');
    const validUntil = input.validUntil === undefined || input.validUntil === null ? null : dayOf(input.validUntil, 'valid_until');
    if (validUntil !== null && validUntil < validFrom) throw invalid('valid_until');
    if (input.mfaRequired !== undefined && typeof input.mfaRequired !== 'boolean') throw invalid('mfa_required');
    const committee = await tx.query<{ status: string }>('select status from machvon.committee where id = $1 for share', [committeeId]);
    if (committee[0] === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'committee_id');
    if (committee[0].status !== 'ACTIVE') throw stateInvalid('committee_ended');
    const person = await tx.query<{ status: string }>('select status from machvon.membership where id = $1', [membershipId]);
    if (person[0] === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'membership_id');
    if (person[0].status !== 'Active') throw new DomainError('VALIDATION_FAILED', 422, 'membership_id', { extensions: { reason: 'membership_not_active' } });
    try {
      const rows = await tx.query<{ id: string }>(
        `insert into machvon.committee_member (tenant_id, committee_id, membership_id, committee_role, agency_code, agency_name, decision_ref, valid_from, valid_until, mfa_required, appointed_by)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
        [committeeId, membershipId, role, agencyCode, optionalText(input.agencyName, 'agency_name', 300), optionalText(input.decisionRef, 'decision_ref', 300), validFrom, validUntil, input.mfaRequired === true, actor],
      );
      const stored = await tx.query<MemberSql>(`select ${MEMBER_COLUMNS} from machvon.committee_member m where m.id = $1`, [(rows[0] as { id: string }).id]);
      return memberOf(stored[0] as MemberSql);
    } catch (error) {
      if (isUnique(error)) throw new DomainError('COMMITTEE_ROLE_TAKEN', 409, role === 'HEAD' ? 'head' : 'place');
      throw error;
    }
  }

  async end(tx: TenantTx, id: string, expectedVersion: number, reason: unknown, actor: string): Promise<CommitteeMemberRow> {
    const text = textOf(reason, 'reason', 5, 500);
    const rows = await tx.query<{ status: string; version: string }>('select status, version::text as version from machvon.committee_member where id = $1 for update', [idOf(id, 'id')]);
    const row = rows[0];
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (Number(row.version) !== expectedVersion) throw versionConflict(Number(row.version));
    if (row.status !== 'ACTIVE') throw stateInvalid('already_ended');
    await tx.query(`update machvon.committee_member set status = 'ENDED', ended_by = $2, ended_at = now(), end_reason = $3, version = version + 1 where id = $1`, [id, actor, text]);
    const stored = await tx.query<MemberSql>(`select ${MEMBER_COLUMNS} from machvon.committee_member m where m.id = $1`, [id]);
    return memberOf(stored[0] as MemberSql);
  }

  /** The place the person holds today (the head before the others when they hold more than one), or undefined. */
  async placeOf(tx: TenantTx, membershipId: string, today: string): Promise<{ role: CommitteeRole; mfaRequired: boolean } | undefined> {
    const rows = await tx.query<{ committee_role: CommitteeRole; mfa_required: boolean }>(
      `select committee_role, mfa_required from machvon.committee_member
        where membership_id = $1 and status = 'ACTIVE' and valid_from <= $2::date and (valid_until is null or valid_until >= $2::date)
        order by case committee_role when 'HEAD' then 0 when 'DEPUTY' then 1 when 'SECRETARIAT' then 2 else 3 end limit 1`,
      [membershipId, today],
    );
    return rows[0] === undefined ? undefined : { role: rows[0].committee_role, mfaRequired: rows[0].mfa_required };
  }
}

// -- the audit of views ------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface ViewRecord {
  membershipId: string;
  screen: CommitteeScreen;
  filters: Record<string, string | number | boolean | null>;
  asOf: string | null;
  recordCount: number | null;
  feedBasis: 'DIS_SNAPSHOT' | 'CORE_LIVE' | null;
  feedReference: string | null;
  classification: 'CONFIDENTIAL' | 'PERSONAL';
  assurance: AssuranceLevel;
  requestId: string | null;
  today: string;
}

export interface ViewAuditRow {
  id: string;
  membershipId: string;
  displayName: string | null;
  committeeRole: CommitteeRole | null;
  screen: CommitteeScreen;
  filters: Record<string, unknown>;
  asOf: string | null;
  recordCount: number | null;
  feedBasis: string | null;
  assuranceLevel: AssuranceLevel;
  mfaRequired: boolean;
  viewedAt: string;
}

interface ViewSql {
  id: string;
  membership_id: string;
  display_name: string | null;
  committee_role: CommitteeRole | null;
  screen: CommitteeScreen;
  filters: Record<string, unknown>;
  as_of: string | null;
  record_count: number | null;
  feed_basis: string | null;
  assurance_level: AssuranceLevel;
  mfa_required: boolean;
  viewed_at: string;
}

export class CommitteeViewAuditStore {
  private readonly roster = new CommitteeRosterStore();

  /** Writes the row of a view in the transaction of the read: a view that cannot be recorded is not answered. Returns the id of the row. */
  async record(tx: TenantTx, view: ViewRecord): Promise<string> {
    const place = await this.roster.placeOf(tx, view.membershipId, view.today);
    const rows = await tx.query<{ id: string }>(
      `insert into machvon.committee_view_audit (tenant_id, membership_id, committee_role, screen, filters, as_of, record_count, feed_basis, feed_reference, classification, assurance_level, mfa_required, request_id)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11, $12) returning id`,
      [view.membershipId, place?.role ?? null, view.screen, JSON.stringify(view.filters), view.asOf, view.recordCount, view.feedBasis, view.feedReference, view.classification, view.assurance, place?.mfaRequired ?? false, view.requestId],
    );
    return (rows[0] as { id: string }).id;
  }

  async list(tx: TenantTx, query: { screen?: CommitteeScreen | undefined; membershipId?: string | undefined; from?: string | undefined; to?: string | undefined; before?: string | undefined; limit: number }): Promise<{ rows: ViewAuditRow[]; next: string | null }> {
    const limit = Math.min(Math.max(query.limit, 1), 200);
    const rows = await tx.query<ViewSql>(
      `select a.id, a.membership_id, ${NAME_OF('a', 'a.membership_id')} as display_name, a.committee_role, a.screen, a.filters, a.as_of::text as as_of, a.record_count, a.feed_basis, a.assurance_level, a.mfa_required, ${ISO('a.viewed_at')} as viewed_at
         from machvon.committee_view_audit a
        where ($1::text is null or a.screen = $1) and ($2::uuid is null or a.membership_id = $2::uuid)
          and ($3::date is null or a.viewed_at >= $3::date) and ($4::date is null or a.viewed_at < $4::date + 1)
          and ($5::timestamptz is null or (a.viewed_at, a.id) < ($5::timestamptz, $6::uuid))
        order by a.viewed_at desc, a.id desc limit ${limit + 1}`,
      [query.screen ?? null, query.membershipId === undefined ? null : idOf(query.membershipId, 'membership_id'), query.from ?? null, query.to ?? null, query.before === undefined ? null : query.before.split('|')[0] ?? null, query.before === undefined ? null : query.before.split('|')[1] ?? null],
    );
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      rows: page.map((row) => ({ id: row.id, membershipId: row.membership_id, displayName: row.display_name, committeeRole: row.committee_role, screen: row.screen, filters: row.filters, asOf: row.as_of, recordCount: row.record_count, feedBasis: row.feed_basis, assuranceLevel: row.assurance_level, mfaRequired: row.mfa_required, viewedAt: row.viewed_at })),
      next: rows.length > limit && last !== undefined ? `${last.viewed_at}|${last.id}` : null,
    };
  }
}

// -- decisions on the attention list --------------------------------------------------------------------------------------------------------------------------------------------------------

export type AttentionDecisionKind = 'ACKNOWLEDGED' | 'DEFERRED' | 'DIRECTED' | 'REOPENED';
export const ATTENTION_DECISIONS: readonly AttentionDecisionKind[] = ['ACKNOWLEDGED', 'DEFERRED', 'DIRECTED', 'REOPENED'];

export interface AttentionDecisionRow {
  id: string;
  projectId: string;
  decision: AttentionDecisionKind;
  reasons: string[];
  score: string | null;
  asOf: string;
  note: string | null;
  deferUntil: string | null;
  directiveId: string | null;
  decidedBy: string;
  decidedByName: string | null;
  decidedAt: string;
}

interface DecisionSql {
  id: string;
  project_id: string;
  decision: AttentionDecisionKind;
  reasons: string[];
  score: string | null;
  as_of: string;
  note: string | null;
  defer_until: string | null;
  directive_id: string | null;
  decided_by: string;
  decided_by_name: string | null;
  decided_at: string;
}

const DECISION_COLUMNS = `d.id, d.project_id, d.decision, d.reasons, d.score::text as score, d.as_of::text as as_of, d.note, d.defer_until::text as defer_until, d.directive_id, d.decided_by, ${NAME_OF('d', 'd.decided_by')} as decided_by_name, ${ISO('d.decided_at')} as decided_at`;
const decisionOf = (row: DecisionSql): AttentionDecisionRow => ({ id: row.id, projectId: row.project_id, decision: row.decision, reasons: row.reasons, score: row.score, asOf: row.as_of, note: row.note, deferUntil: row.defer_until, directiveId: row.directive_id, decidedBy: row.decided_by, decidedByName: row.decided_by_name, decidedAt: row.decided_at });

export interface AttentionDecisionInput {
  projectId: unknown;
  decision: unknown;
  note?: unknown;
  deferUntil?: unknown;
  directiveId?: unknown;
  reasons: readonly string[];
  score: string | null;
  asOf: string;
  policyVersion: number | null;
}

export class CommitteeDecisionStore {
  async record(tx: TenantTx, input: AttentionDecisionInput, actor: string, today: string): Promise<AttentionDecisionRow> {
    const projectId = idOf(input.projectId, 'project_id');
    const decision = ATTENTION_DECISIONS.find((one) => one === input.decision);
    if (decision === undefined) throw invalid('decision');
    const note = optionalText(input.note, 'note', 2000);
    if (decision !== 'DIRECTED' && note === null) throw invalid('note');
    const deferUntil = decision === 'DEFERRED' ? dayOf(input.deferUntil, 'defer_until') : null;
    if (decision !== 'DEFERRED' && input.deferUntil !== undefined && input.deferUntil !== null) throw invalid('defer_until');
    if (deferUntil !== null && deferUntil <= today) throw invalid('defer_until');
    const directiveId = decision === 'DIRECTED' ? idOf(input.directiveId, 'directive_id') : null;
    if (decision !== 'DIRECTED' && input.directiveId !== undefined && input.directiveId !== null) throw invalid('directive_id');
    const project = await tx.query<{ id: string }>('select id from machvon.project where id = $1', [projectId]);
    if (project[0] === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'project_id');
    if (directiveId !== null) {
      const directive = await tx.query<{ project_id: string | null }>('select project_id from machvon.directive where id = $1', [directiveId]);
      if (directive[0] === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'directive_id');
      if (directive[0].project_id !== projectId) throw invalid('directive_id');
    }
    const rows = await tx.query<{ id: string }>(
      `insert into machvon.committee_attention_decision (tenant_id, project_id, decision, reasons, score, as_of, note, defer_until, directive_id, policy_version, decided_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1, $2, $3::text[], $4::numeric, $5::date, $6, $7::date, $8, $9, $10) returning id`,
      [projectId, decision, [...input.reasons], input.score, input.asOf, note, deferUntil, directiveId, input.policyVersion, actor],
    );
    const stored = await tx.query<DecisionSql>(`select ${DECISION_COLUMNS} from machvon.committee_attention_decision d where d.id = $1`, [(rows[0] as { id: string }).id]);
    return decisionOf(stored[0] as DecisionSql);
  }

  /** The latest decision of each of the projects, by project id. */
  async latest(tx: TenantTx, projectIds: readonly string[]): Promise<Map<string, AttentionDecisionRow>> {
    if (projectIds.length === 0) return new Map();
    const rows = await tx.query<DecisionSql>(
      `select distinct on (d.project_id) ${DECISION_COLUMNS} from machvon.committee_attention_decision d where d.project_id = any($1::uuid[]) order by d.project_id, d.decided_at desc, d.id desc`,
      [[...projectIds]],
    );
    return new Map(rows.map((row) => [row.project_id, decisionOf(row)]));
  }

  async history(tx: TenantTx, projectId: string, limit = 50): Promise<AttentionDecisionRow[]> {
    const rows = await tx.query<DecisionSql>(`select ${DECISION_COLUMNS} from machvon.committee_attention_decision d where d.project_id = $1 order by d.decided_at desc, d.id desc limit ${Math.min(limit, 200)}`, [idOf(projectId, 'project_id')]);
    return rows.map(decisionOf);
  }
}

// -- alerts ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface CommitteeAlertRow {
  id: string;
  alertType: CommitteeAlertType;
  dedupeKey: string;
  subjectKind: 'PROVINCE' | 'SECTOR' | 'UNIT';
  subjectKey: string;
  subjectLabel: string | null;
  severity: 'URGENT' | 'ACTION' | 'WATCH';
  value: string | null;
  threshold: string | null;
  detail: Record<string, unknown>;
  fiscalYear: number;
  status: 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED';
  openedOn: string;
  lastSeenOn: string;
  resolvedOn: string | null;
  acknowledgedBy: string | null;
  acknowledgedByName: string | null;
  acknowledgedAt: string | null;
  acknowledgedNote: string | null;
  policyVersion: number | null;
  version: number;
}

interface AlertSql {
  id: string;
  alert_type: CommitteeAlertType;
  dedupe_key: string;
  subject_kind: 'PROVINCE' | 'SECTOR' | 'UNIT';
  subject_key: string;
  subject_label: string | null;
  severity: 'URGENT' | 'ACTION' | 'WATCH';
  value: string | null;
  threshold: string | null;
  detail: Record<string, unknown>;
  fiscal_year: number;
  status: 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED';
  opened_on: string;
  last_seen_on: string;
  resolved_on: string | null;
  acknowledged_by: string | null;
  acknowledged_by_name: string | null;
  acknowledged_at: string | null;
  acknowledged_note: string | null;
  policy_version: number | null;
  version: string;
}

const ALERT_COLUMNS = `a.id, a.alert_type, a.dedupe_key, a.subject_kind, a.subject_key, a.subject_label, a.severity, a.value, a.threshold, a.detail, a.fiscal_year, a.status, a.opened_on::text as opened_on, a.last_seen_on::text as last_seen_on,
  a.resolved_on::text as resolved_on, a.acknowledged_by, ${NAME_OF('a', 'a.acknowledged_by')} as acknowledged_by_name, ${ISO('a.acknowledged_at')} as acknowledged_at, a.acknowledged_note, a.policy_version, a.version::text as version`;
const alertOf = (row: AlertSql): CommitteeAlertRow => ({
  id: row.id,
  alertType: row.alert_type,
  dedupeKey: row.dedupe_key,
  subjectKind: row.subject_kind,
  subjectKey: row.subject_key,
  subjectLabel: row.subject_label,
  severity: row.severity,
  value: row.value,
  threshold: row.threshold,
  detail: row.detail,
  fiscalYear: row.fiscal_year,
  status: row.status,
  openedOn: row.opened_on,
  lastSeenOn: row.last_seen_on,
  resolvedOn: row.resolved_on,
  acknowledgedBy: row.acknowledged_by,
  acknowledgedByName: row.acknowledged_by_name,
  acknowledgedAt: row.acknowledged_at,
  acknowledgedNote: row.acknowledged_note,
  policyVersion: row.policy_version,
  version: Number(row.version),
});

export interface AlertReconciliation {
  opened: CommitteeAlertRow[];
  kept: number;
  resolved: CommitteeAlertRow[];
}

export class CommitteeAlertStore {
  /**
   * Makes the stored alerts of the year agree with the alerts the rules give today: a condition that still holds keeps its row open (and refreshes its figures and day last seen), a new condition opens a row, a condition that no longer holds
   * resolves its row. An alert somebody acknowledged stays acknowledged while the condition holds. Runs in one transaction under an advisory lock, so two evaluations at once cannot open the same alert twice.
   */
  async reconcile(tx: TenantTx, alerts: readonly CommitteeAlert[], fiscalYear: number, today: string, policyVersion: number | null): Promise<AlertReconciliation> {
    await tx.query(`select pg_advisory_xact_lock(hashtextextended(current_setting('app.tenant_id', true) || '|committee-alerts|' || $1::text, 0))`, [fiscalYear]);
    const existing = await tx.query<{ id: string; dedupe_key: string }>(`select id, dedupe_key from machvon.committee_alert where status <> 'RESOLVED' and fiscal_year = $1`, [fiscalYear]);
    const byKey = new Map(existing.map((row) => [row.dedupe_key, row.id]));
    const opened: string[] = [];
    let kept = 0;
    for (const alert of alerts) {
      const id = byKey.get(alert.dedupeKey);
      if (id === undefined) {
        const rows = await tx.query<{ id: string }>(
          `insert into machvon.committee_alert (tenant_id, alert_type, dedupe_key, subject_kind, subject_key, subject_label, severity, value, threshold, detail, fiscal_year, opened_on, last_seen_on, policy_version)
           values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11::date, $11::date, $12) returning id`,
          [alert.alertType, alert.dedupeKey, alert.subjectKind, alert.subjectKey, alert.subjectLabel === '' ? null : alert.subjectLabel, alert.severity, alert.value, alert.threshold, JSON.stringify(alert.detail), fiscalYear, today, policyVersion],
        );
        opened.push((rows[0] as { id: string }).id);
      } else {
        await tx.query(`update machvon.committee_alert set severity = $2, value = $3, threshold = $4, detail = $5::jsonb, last_seen_on = $6::date, policy_version = $7, version = version + 1 where id = $1`, [id, alert.severity, alert.value, alert.threshold, JSON.stringify(alert.detail), today, policyVersion]);
        kept += 1;
      }
    }
    const live = new Set(alerts.map((alert) => alert.dedupeKey));
    const gone = existing.filter((row) => !live.has(row.dedupe_key)).map((row) => row.id);
    if (gone.length > 0) await tx.query(`update machvon.committee_alert set status = 'RESOLVED', resolved_on = $2::date, version = version + 1 where id = any($1::uuid[])`, [gone, today]);
    const read = async (ids: string[]): Promise<CommitteeAlertRow[]> => (ids.length === 0 ? [] : (await tx.query<AlertSql>(`select ${ALERT_COLUMNS} from machvon.committee_alert a where a.id = any($1::uuid[]) order by a.dedupe_key`, [ids])).map(alertOf));
    return { opened: await read(opened), kept, resolved: await read(gone) };
  }

  async list(tx: TenantTx, status?: 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED' | 'LIVE'): Promise<CommitteeAlertRow[]> {
    const rows = await tx.query<AlertSql>(
      `select ${ALERT_COLUMNS} from machvon.committee_alert a
        where ($1::text is null or ($1 = 'LIVE' and a.status <> 'RESOLVED') or a.status = $1)
        order by case a.severity when 'URGENT' then 0 when 'ACTION' then 1 else 2 end, a.opened_on desc, a.id limit 500`,
      [status ?? null],
    );
    return rows.map(alertOf);
  }

  async acknowledge(tx: TenantTx, id: string, expectedVersion: number, note: unknown, actor: string): Promise<CommitteeAlertRow> {
    const text = textOf(note, 'note', 1, 2000);
    const rows = await tx.query<{ status: string; version: string }>('select status, version::text as version from machvon.committee_alert where id = $1 for update', [idOf(id, 'id')]);
    const row = rows[0];
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (Number(row.version) !== expectedVersion) throw versionConflict(Number(row.version));
    if (row.status !== 'OPEN') throw stateInvalid(row.status === 'RESOLVED' ? 'alert_resolved' : 'already_acknowledged');
    await tx.query(`update machvon.committee_alert set status = 'ACKNOWLEDGED', acknowledged_by = $2, acknowledged_at = now(), acknowledged_note = $3, version = version + 1 where id = $1`, [id, actor, text]);
    const stored = await tx.query<AlertSql>(`select ${ALERT_COLUMNS} from machvon.committee_alert a where a.id = $1`, [id]);
    return alertOf(stored[0] as AlertSql);
  }
}

// -- the directives per unit -------------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface TrackedDirective {
  id: string;
  code: string;
  text: string;
  projectId: string | null;
  projectCode: string | null;
  assigneeUnitId: string;
  assigneeUnitName: string;
  dueOn: string;
  overdueDays: number;
  phase: 'OVERDUE' | 'ESCALATED';
  status: string;
  extensionCount: number;
}

export interface DirectiveUnitRow extends DirectiveUnitFigure {
  open: number;
  oldestOverdueDays: number | null;
}

export interface DirectiveTracker {
  units: DirectiveUnitRow[];
  directives: TrackedDirective[];
  totals: { open: number; overdue: number; escalated: number };
  truncated: boolean;
}

interface DirectiveSql {
  id: string;
  code: string;
  text: string;
  project_id: string | null;
  project_code: string | null;
  unit_id: string;
  unit_name: string;
  due_on: string;
  status: string;
  extension_count: number;
}

const TRACKER_LIMIT = 2000;

export class CommitteeDirectiveReader {
  /** The directives that are still to be done, counted per unit that must do them with the clock of the day (the policy of the directives decides when one is overdue and when escalated); the overdue ones listed, the worst first. */
  async tracker(tx: TenantTx, today: string, policy: DirectivePolicy, listLimit = 200): Promise<DirectiveTracker> {
    const rows = await tx.query<DirectiveSql>(
      `select d.id, d.code, d.directive_text as text, d.project_id, p.code as project_code, d.assignee_unit_id as unit_id, u.name as unit_name, d.due_on::text as due_on, d.status, d.extension_count
         from machvon.directive d
         join machvon.organization_unit u on u.tenant_id = d.tenant_id and u.id = d.assignee_unit_id
         left join machvon.project p on p.tenant_id = d.tenant_id and p.id = d.project_id
        where d.status in ('OPEN', 'IN_PROGRESS')
        order by d.due_on, d.id limit ${TRACKER_LIMIT + 1}`,
    );
    const truncated = rows.length > TRACKER_LIMIT;
    const units = new Map<string, DirectiveUnitRow>();
    const overdue: TrackedDirective[] = [];
    for (const row of rows.slice(0, TRACKER_LIMIT)) {
      const unit = units.get(row.unit_id) ?? { unitId: row.unit_id, unitName: row.unit_name, open: 0, overdue: 0, escalated: 0, oldestOverdueDays: null };
      unit.open += 1;
      const clock = directiveClock(row.status as 'OPEN' | 'IN_PROGRESS', row.due_on, today, policy);
      if (clock.phase === 'OVERDUE' || clock.phase === 'ESCALATED') {
        unit.overdue += 1;
        if (clock.phase === 'ESCALATED') unit.escalated += 1;
        const days = clock.overdueDays ?? 0;
        unit.oldestOverdueDays = unit.oldestOverdueDays === null ? days : Math.max(unit.oldestOverdueDays, days);
        overdue.push({ id: row.id, code: row.code, text: row.text.length > 160 ? `${row.text.slice(0, 159).trimEnd()}...` : row.text, projectId: row.project_id, projectCode: row.project_code, assigneeUnitId: row.unit_id, assigneeUnitName: row.unit_name, dueOn: row.due_on, overdueDays: days, phase: clock.phase, status: row.status, extensionCount: row.extension_count });
      }
      units.set(row.unit_id, unit);
    }
    overdue.sort((a, b) => b.overdueDays - a.overdueDays || a.code.localeCompare(b.code, 'en'));
    const list = [...units.values()].sort((a, b) => b.escalated - a.escalated || b.overdue - a.overdue || b.open - a.open || a.unitName.localeCompare(b.unitName, 'vi'));
    return {
      units: list,
      directives: overdue.slice(0, listLimit),
      totals: { open: list.reduce((sum, unit) => sum + unit.open, 0), overdue: list.reduce((sum, unit) => sum + unit.overdue, 0), escalated: list.reduce((sum, unit) => sum + unit.escalated, 0) },
      truncated,
    };
  }
}
