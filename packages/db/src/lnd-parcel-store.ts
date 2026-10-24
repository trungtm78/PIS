import { randomUUID } from 'node:crypto';
import { DomainError, activeGrants, compareDecimal, noticeTimerOf, permissionMatches, versionConflict } from '@machvon/kernel';
import type { EffectiveAccess, LandTimerCode, LandUseGroup } from '@machvon/kernel';
import { LndLandSource } from './lnd-land-source.ts';
import { LndTimerRules } from './lnd-timer-rules.ts';
import { AREA_INTEGER_DIGITS, MAX_ADDRESS, boundaryOf, dateOf, fixedTwo, lowerId, textOf } from './lnd-values.ts';
import { scopePredicate } from './scope-version.ts';
import type { ScopeBuilder, ScopePredicate } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';
import { withUniqueClaim } from './unique-claim.ts';

const CODE_CONSTRAINT = 'land_parcel_code_uq';
const RUNNING_CONSTRAINT = 'land_deadline_running_uq';
const PARCEL_CODE = /^[A-Z0-9][A-Z0-9/._-]{0,49}$/;
const MIN_NOTICE_DATE = '1990-01-01';

export const PARCEL_STATUSES = ['SURVEYED', 'INVENTORIED', 'PLAN_DRAFTED', 'PLAN_POSTED', 'PLAN_APPROVED', 'PAID', 'HANDED_OVER', 'DISPUTED', 'ENFORCEMENT'] as const;
export type ParcelStatus = (typeof PARCEL_STATUSES)[number];
export type DeadlineStatus = 'RUNNING' | 'SATISFIED' | 'BREACHED' | 'CANCELLED';

/** The stages of a parcel in which a notice of recovery can still be given: before the money is paid, the land handed over or the force used. */
const NOTICE_STAGES: ReadonlySet<ParcelStatus> = new Set(['SURVEYED', 'INVENTORIED', 'PLAN_DRAFTED', 'PLAN_POSTED', 'PLAN_APPROVED', 'DISPUTED']);

export interface NewLandParcel {
  projectId: string;
  sectionId?: string | undefined;
  ownerUnitId: string;
  parcelCode: string;
  addressText?: string | undefined;
  wardMasterVersionId?: string | undefined;
  landUseGroup: LandUseGroup;
  areaTotalM2: string;
  areaAffectedM2: string;
  boundaryGeojson?: unknown;
}

/** A parcel as the commands and the audit trail see it: the values as they were stored. The address and the outline are not in it. */
export interface CreatedLandParcel {
  id: string;
  projectId: string;
  sectionId: string | null;
  ownerUnitId: string;
  parcelCode: string;
  landUseGroup: LandUseGroup;
  areaTotalM2: string;
  areaAffectedM2: string;
  version: number;
  status: ParcelStatus;
}

/** Where a parcel lies for the permission test: its project and the unit that answers for it. */
export interface ParcelPlace {
  id: string;
  projectId: string;
  ownerUnit: { id: string; path: string };
  status: ParcelStatus;
  version: number;
}

/** What recording a notice produced: the parcel after the command and the timer it started, with the rule it was counted by. */
export interface RecordedNotice {
  parcelId: string;
  projectId: string;
  version: number;
  status: ParcelStatus;
  deadlineId: string;
  timerCode: LandTimerCode;
  daysApplied: number;
  noticeOn: string;
  dueOn: string;
  ruleVersionId: string;
  ruleRevision: number;
  noticeDocumentVersionId: string;
}

/** What recording the decision produced. */
export interface RecordedDecision {
  parcelId: string;
  projectId: string;
  version: number;
  decisionOn: string;
  deadlineId: string;
}

export interface ParcelDeadlineView {
  id: string;
  timerCode: LandTimerCode;
  daysApplied: number;
  startedOn: string;
  dueOn: string;
  satisfiedOn: string | null;
  status: DeadlineStatus;
  legalBasis: string | null;
  awaitingConfirmation: boolean;
  cxn: string | null;
}

/** One line of the parcels of a project (LND-02). A parcel has no owner and no user: this is the whole of what is kept. */
export interface ParcelRow {
  id: string;
  projectId: string;
  sectionId: string | null;
  sectionCode: string | null;
  ownerUnitId: string;
  ownerUnitName: string;
  parcelCode: string;
  addressText: string | null;
  landUseGroup: LandUseGroup;
  areaTotalM2: string;
  areaAffectedM2: string;
  hasBoundary: boolean;
  status: ParcelStatus;
  recoveryNoticeOn: string | null;
  noticeDaysApplied: number | null;
  recoveryDecisionOn: string | null;
  deadline: ParcelDeadlineView | null;
  version: number;
}

export interface ParcelFilter {
  projectId: string;
  sectionId?: string | undefined;
  status?: ParcelStatus | undefined;
}

interface ParcelSql {
  id: string;
  project_id: string;
  section_id: string | null;
  section_code: string | null;
  owner_unit_id: string;
  owner_unit_name: string;
  parcel_code: string;
  address_text: string | null;
  land_use_group: LandUseGroup;
  area_total_m2: string;
  area_affected_m2: string;
  has_boundary: boolean;
  status: ParcelStatus;
  recovery_notice_on: string | null;
  notice_days_applied: number | null;
  recovery_decision_on: string | null;
  version: string;
  d_id: string | null;
  d_timer_code: LandTimerCode | null;
  d_days_applied: number | null;
  d_started_on: string | null;
  d_due_on: string | null;
  d_satisfied_on: string | null;
  d_status: DeadlineStatus | null;
  d_legal_basis: string | null;
  d_awaiting: boolean | null;
  d_cxn: string | null;
}

/** The parcel with its unit, its section and the timer that counts its notice: `pc` the parcel, `ou` the unit that answers for it, `d` the timer. */
const FROM = `machvon.land_parcel pc
  join machvon.organization_unit ou on ou.tenant_id = pc.tenant_id and ou.id = pc.owner_unit_id
  left join machvon.land_handover_section sc on sc.tenant_id = pc.tenant_id and sc.id = pc.section_id
  left join lateral (
    select dl.* from machvon.land_deadline dl where dl.tenant_id = pc.tenant_id and dl.subject_kind = 'PARCEL' and dl.subject_id = pc.id order by dl.created_at desc, dl.id desc limit 1
  ) d on true
  left join machvon.master_record_version rv on rv.tenant_id = d.tenant_id and rv.id = d.rule_version_id`;

const COLUMNS = `pc.id, pc.project_id, pc.section_id, sc.code as section_code, pc.owner_unit_id, ou.name as owner_unit_name, pc.parcel_code, pc.address_text, pc.land_use_group,
  pc.area_total_m2::text as area_total_m2, pc.area_affected_m2::text as area_affected_m2, (pc.boundary_geojson is not null) as has_boundary, pc.status,
  pc.recovery_notice_on::text as recovery_notice_on, pc.notice_days_applied, pc.recovery_decision_on::text as recovery_decision_on, pc.version::text as version,
  d.id as d_id, d.timer_code as d_timer_code, d.days_applied as d_days_applied, d.started_on::text as d_started_on, d.due_on::text as d_due_on,
  d.satisfied_on::text as d_satisfied_on, d.status as d_status, rv.legal_basis as d_legal_basis, coalesce((rv.attributes ->> 'awaiting_confirmation')::boolean, false) as d_awaiting,
  rv.attributes ->> 'cxn' as d_cxn`;

const toRow = (row: ParcelSql): ParcelRow => ({
  id: row.id,
  projectId: row.project_id,
  sectionId: row.section_id,
  sectionCode: row.section_code,
  ownerUnitId: row.owner_unit_id,
  ownerUnitName: row.owner_unit_name,
  parcelCode: row.parcel_code,
  addressText: row.address_text,
  landUseGroup: row.land_use_group,
  areaTotalM2: row.area_total_m2,
  areaAffectedM2: row.area_affected_m2,
  hasBoundary: row.has_boundary,
  status: row.status,
  recoveryNoticeOn: row.recovery_notice_on,
  noticeDaysApplied: row.notice_days_applied,
  recoveryDecisionOn: row.recovery_decision_on,
  deadline:
    row.d_id === null || row.d_timer_code === null || row.d_days_applied === null || row.d_started_on === null || row.d_due_on === null || row.d_status === null
      ? null
      : {
          id: row.d_id,
          timerCode: row.d_timer_code,
          daysApplied: row.d_days_applied,
          startedOn: row.d_started_on,
          dueOn: row.d_due_on,
          satisfiedOn: row.d_satisfied_on,
          status: row.d_status,
          legalBasis: row.d_legal_basis,
          awaitingConfirmation: row.d_awaiting === true,
          cxn: row.d_cxn,
        },
  version: Number(row.version),
});

/** The parcel code as the registers write it: capitals and no space (`tb-12/345` is `TB-12/345`, `tb 12` is not a code). */
export function parcelCodeOf(value: string, field: string): string {
  const code = value.trim().toUpperCase();
  if (!PARCEL_CODE.test(code)) throw new DomainError('VALIDATION_FAILED', 422, field);
  return code;
}

/**
 * A scope builder for a permission over the parcels: a parcel is in scope when the unit that answers for it lies in a scope of a grant that
 * carries the permission, or the grant names the project it lies in. Compiled over the aliases `pc` and `ou` of the queries above.
 */
export function parcelScope(access: EffectiveAccess, permission: string, now: Date): ScopeBuilder {
  return (first: number): ScopePredicate => {
    const owner = scopePredicate(access, permission, now, { unitPath: 'ou.path', unitId: 'ou.id' }, first);
    if (owner.sql === 'true') return owner;
    const projectIds = new Set<string>();
    for (const grant of activeGrants(access, now)) {
      if (grant.scope.kind === 'PROJECT' && grant.permissions.some((held) => permissionMatches(held, permission))) for (const id of grant.scope.refIds) projectIds.add(id);
    }
    if (projectIds.size === 0) return owner;
    const params = [...owner.params, [...projectIds].sort()];
    const projects = `pc.project_id = any($${first + owner.params.length}::uuid[])`;
    return { sql: owner.sql === 'false' ? projects : `(${owner.sql} or ${projects})`, params };
  };
}

/**
 * The parcels of a project (ST-LND-001, LND 3.1 step 1) and the notice of recovery that starts their timer (step 2). A parcel is a piece of land
 * and nothing more: it has a code, an address, an area, a land use, an outline and the unit that answers for it, and no owner, no user and no
 * household (the people are another record, under other rules). The days of a notice come from the rule data in force on the day of the notice
 * and the deadline keeps the version of the rule it was counted by; a decision to recover cannot come before that deadline.
 */
export class LndParcelStore {
  private readonly source: LndLandSource;
  private readonly timers: LndTimerRules;

  constructor(source: LndLandSource = new LndLandSource(), timers: LndTimerRules = new LndTimerRules()) {
    this.source = source;
    this.timers = timers;
  }

  /** Declares a parcel in SURVEYED at version 1. The project, the section, the unit and the ward must be what they say; the same code twice in a project is refused. */
  async create(tx: TenantTx, input: NewLandParcel, actor: string, today: string): Promise<CreatedLandParcel> {
    const parcelCode = parcelCodeOf(input.parcelCode, 'parcel_code');
    const addressText = input.addressText === undefined ? undefined : textOf(input.addressText, 'address_text', 1, MAX_ADDRESS);
    const total = fixedTwo(input.areaTotalM2, AREA_INTEGER_DIGITS, 'area_total_m2');
    const affected = fixedTwo(input.areaAffectedM2, AREA_INTEGER_DIGITS, 'area_affected_m2');
    // An area that is shaped right but cannot be the area of a parcel is a refusal of its own (AREA_INVALID), apart from a figure that does not read.
    if (compareDecimal(total, '0') <= 0 || compareDecimal(affected, total) > 0) throw new DomainError('AREA_INVALID', 422, compareDecimal(total, '0') <= 0 ? 'area_total_m2' : 'area_affected_m2');
    const boundary = input.boundaryGeojson === undefined ? undefined : boundaryOf(input.boundaryGeojson, 'boundary_geojson');
    const projectId = lowerId(input.projectId);
    const ownerUnitId = lowerId(input.ownerUnitId);
    const sectionId = input.sectionId === undefined ? undefined : lowerId(input.sectionId);
    const wardId = input.wardMasterVersionId === undefined ? undefined : lowerId(input.wardMasterVersionId);
    if ((await this.source.projectRef(tx, projectId)) === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if ((await this.source.unitRef(tx, ownerUnitId)) === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'owner_unit_id');
    if (sectionId !== undefined && (await this.source.sectionOfProject(tx, projectId, sectionId)) === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'section_id');
    if (wardId !== undefined) await this.source.assertWardInForce(tx, wardId, today, 'ward_master_version_id');
    const id = randomUUID();
    await withUniqueClaim(tx, { constraint: CODE_CONSTRAINT, code: 'PARCEL_CODE_DUPLICATE' }, () =>
      tx.query(
        `insert into machvon.land_parcel
           (tenant_id, id, project_id, section_id, owner_unit_id, parcel_code, address_text, ward_master_version_id, land_use_group, area_total_m2, area_affected_m2,
            boundary_geojson, status, version, created_by, updated_by)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7::uuid, $8, $9::numeric, $10::numeric,
                 $11::jsonb, 'SURVEYED', 1, $12::uuid, $12::uuid)`,
        [id, projectId, sectionId ?? null, ownerUnitId, parcelCode, addressText ?? null, wardId ?? null, input.landUseGroup, total, affected, boundary === undefined ? null : JSON.stringify(boundary), actor],
      ),
    );
    return { id, projectId, sectionId: sectionId ?? null, ownerUnitId, parcelCode, landUseGroup: input.landUseGroup, areaTotalM2: total, areaAffectedM2: affected, version: 1, status: 'SURVEYED' };
  }

  /** Where a parcel lies, without locking it; undefined when it does not exist in the tenant. */
  async place(tx: TenantTx, id: string): Promise<ParcelPlace | undefined> {
    const rows = await tx.query<{ id: string; project_id: string; owner_id: string; owner_path: string; status: ParcelStatus; version: string }>(
      `select pc.id, pc.project_id, ou.id as owner_id, ou.path as owner_path, pc.status, pc.version::text as version
         from machvon.land_parcel pc join machvon.organization_unit ou on ou.tenant_id = pc.tenant_id and ou.id = pc.owner_unit_id
        where pc.id = $1::uuid`,
      [id],
    );
    const row = rows[0];
    return row === undefined ? undefined : { id: row.id, projectId: row.project_id, ownerUnit: { id: row.owner_id, path: row.owner_path }, status: row.status, version: Number(row.version) };
  }

  /**
   * Gives the notice of recovery of a parcel and starts its timer (BR-LND-01): the timer is 90 days for agricultural land and 180 for every other
   * land use, the days are those of the rule in force on the day of the notice and the deadline is the notice date plus them. A notice is given once,
   * before the money is paid or the land handed over, on a date that has come, with the notice itself as evidence.
   */
  async recordNotice(tx: TenantTx, input: { parcelId: string; expectedVersion: number; noticeOn: string; noticeDocumentVersionId: string }, actor: string, today: string): Promise<RecordedNotice> {
    const noticeOn = dateOf(input.noticeOn, 'notice_on');
    if (noticeOn > today || noticeOn < MIN_NOTICE_DATE) throw new DomainError('VALIDATION_FAILED', 422, 'notice_on');
    const documentId = lowerId(input.noticeDocumentVersionId);
    const parcel = await this.lock(tx, input.parcelId);
    if (parcel.version !== input.expectedVersion) throw versionConflict(parcel.version);
    if (!NOTICE_STAGES.has(parcel.status) || parcel.recoveryNoticeOn !== null) throw new DomainError('PARCEL_STATE_INVALID', 409);
    await this.source.assertCleanDocumentVersion(tx, documentId, 'notice_document_version_id');
    const timerCode = noticeTimerOf(parcel.landUseGroup);
    const timer = await this.timers.resolve(tx, timerCode, noticeOn);
    const dueOn = await this.timers.dueOn(tx, timer.rule, noticeOn);
    const deadlineId = randomUUID();
    await withUniqueClaim(tx, { constraint: RUNNING_CONSTRAINT, code: 'PARCEL_STATE_INVALID' }, () =>
      tx.query(
        `insert into machvon.land_deadline
           (tenant_id, id, project_id, subject_kind, subject_id, timer_code, days_applied, started_on, due_on, status, rule_version_id, version, created_by, updated_by)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, 'PARCEL', $3::uuid, $4, $5, $6::date, $7::date, 'RUNNING', $8::uuid, 1, $9::uuid, $9::uuid)`,
        [deadlineId, parcel.projectId, parcel.id, timerCode, timer.rule.days, noticeOn, dueOn, timer.reading.versionId, actor],
      ),
    );
    const version = parcel.version + 1;
    await tx.query(
      `update machvon.land_parcel
          set recovery_notice_on = $2::date, notice_days_applied = $3, notice_document_version_id = $4::uuid, updated_at = now(), updated_by = $5::uuid, version = $6
        where id = $1::uuid`,
      [parcel.id, noticeOn, timer.rule.days, documentId, actor, version],
    );
    return {
      parcelId: parcel.id,
      projectId: parcel.projectId,
      version,
      status: parcel.status,
      deadlineId,
      timerCode,
      daysApplied: timer.rule.days,
      noticeOn,
      dueOn,
      ruleVersionId: timer.reading.versionId,
      ruleRevision: timer.reading.revision,
      noticeDocumentVersionId: documentId,
    };
  }

  /**
   * Records the decision to recover the land of a parcel (LND 3.1 step 2): not before the end of the notice (422 NOTICE_PERIOD_NOT_ELAPSED; the
   * database refuses the same row with `land_parcel_notice_chk`), and it satisfies the timer of the notice on the day of the decision.
   */
  async recordRecoveryDecision(tx: TenantTx, input: { parcelId: string; expectedVersion: number; decisionOn: string }, actor: string, today: string): Promise<RecordedDecision> {
    const decisionOn = dateOf(input.decisionOn, 'recovery_decision_on');
    if (decisionOn > today) throw new DomainError('VALIDATION_FAILED', 422, 'recovery_decision_on');
    const parcel = await this.lock(tx, input.parcelId);
    if (parcel.version !== input.expectedVersion) throw versionConflict(parcel.version);
    if (parcel.recoveryNoticeOn === null || parcel.recoveryDecisionOn !== null || !NOTICE_STAGES.has(parcel.status)) throw new DomainError('PARCEL_STATE_INVALID', 409);
    const deadlines = await tx.query<{ id: string; due_on: string }>(
      "select id, due_on::text as due_on from machvon.land_deadline where subject_kind = 'PARCEL' and subject_id = $1::uuid and status = 'RUNNING' for update",
      [parcel.id],
    );
    const running = deadlines[0];
    if (running === undefined) throw new DomainError('PARCEL_STATE_INVALID', 409);
    if (decisionOn < running.due_on) throw new DomainError('NOTICE_PERIOD_NOT_ELAPSED', 422, 'recovery_decision_on');
    const version = parcel.version + 1;
    await tx.query('update machvon.land_parcel set recovery_decision_on = $2::date, updated_at = now(), updated_by = $3::uuid, version = $4 where id = $1::uuid', [parcel.id, decisionOn, actor, version]);
    await tx.query("update machvon.land_deadline set status = 'SATISFIED', satisfied_on = $2::date, updated_at = now(), updated_by = $3::uuid, version = version + 1 where id = $1::uuid", [running.id, decisionOn, actor]);
    return { parcelId: parcel.id, projectId: parcel.projectId, version, decisionOn, deadlineId: running.id };
  }

  /** The parcels of a project in the scope of the caller, by code; the cursor is the code and the id of the last line. */
  async list(tx: TenantTx, scope: ScopeBuilder, filter: ParcelFilter, request: { limit: number; after: { code: string; id: string } | undefined }): Promise<ParcelRow[]> {
    const predicate = scope(7);
    const rows = await tx.query<ParcelSql>(
      `select ${COLUMNS} from ${FROM}
        where pc.project_id = $1::uuid and ($2::uuid is null or pc.section_id = $2::uuid) and ($3::text is null or pc.status = $3)
          and ($4::text is null or (pc.parcel_code, pc.id) > ($4::text, $5::uuid)) and ${predicate.sql}
        order by pc.parcel_code, pc.id limit $6`,
      [filter.projectId, filter.sectionId ?? null, filter.status ?? null, request.after?.code ?? null, request.after?.id ?? null, request.limit, ...predicate.params],
    );
    return rows.map(toRow);
  }

  /** One parcel in the scope of the caller; undefined when it does not exist or lies outside the scope. */
  async find(tx: TenantTx, id: string, scope: ScopeBuilder): Promise<ParcelRow | undefined> {
    const predicate = scope(2);
    const rows = await tx.query<ParcelSql>(`select ${COLUMNS} from ${FROM} where pc.id = $1::uuid and ${predicate.sql}`, [id, ...predicate.params]);
    return rows[0] === undefined ? undefined : toRow(rows[0]);
  }

  private async lock(tx: TenantTx, id: string): Promise<{ id: string; projectId: string; status: ParcelStatus; version: number; landUseGroup: LandUseGroup; recoveryNoticeOn: string | null; recoveryDecisionOn: string | null }> {
    const rows = await tx.query<{ id: string; project_id: string; status: ParcelStatus; version: string; land_use_group: LandUseGroup; recovery_notice_on: string | null; recovery_decision_on: string | null }>(
      `select id, project_id, status, version::text as version, land_use_group, recovery_notice_on::text as recovery_notice_on, recovery_decision_on::text as recovery_decision_on
         from machvon.land_parcel where id = $1::uuid for update`,
      [id],
    );
    const row = rows[0];
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return { id: row.id, projectId: row.project_id, status: row.status, version: Number(row.version), landUseGroup: row.land_use_group, recoveryNoticeOn: row.recovery_notice_on, recoveryDecisionOn: row.recovery_decision_on };
  }
}
