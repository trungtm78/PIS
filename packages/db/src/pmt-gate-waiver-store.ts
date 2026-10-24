import { randomUUID } from 'node:crypto';
import { DomainError, asUuid, isIsoDate, shiftDays, vietnamDateOf } from '@machvon/kernel';
import { GATE_CODES } from './pmt-gate-store.ts';
import type { GateCode } from './pmt-gate-store.ts';
import { timestampKey } from './keyset.ts';
import { SCOPE_FROM } from './prj-project-store.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

/**
 * The longest a waiver of a gate may last, in days from the day it is granted, last day included (BR-PMT-05). It is a working assumption that the
 * business owner of the tenant confirms (R-PMT-03, TODOS.md ST-PMT-005): 90 days.
 */
export const MAX_WAIVER_DAYS = 90;
export const WAIVER_STATUSES = ['ACTIVE', 'EXPIRED', 'REVOKED'] as const;
export type WaiverStatus = (typeof WAIVER_STATUSES)[number];
const MAX_TEXT = 2000;

export interface WaiverInput {
  projectId: string;
  gateCode: string;
  permitTypeId: string;
  reason: string;
  decisionDocumentVersionId: string;
  validUntil: string;
}

export interface GrantedWaiver {
  id: string;
  projectId: string;
  gateCode: GateCode;
  permitTypeCode: string;
  validUntil: string;
  version: 1;
  status: 'ACTIVE';
  decisionDocumentVersionId: string;
  /** The day the waiver was granted (Vietnam) and the days it lasts from then, last day included. */
  grantedOn: string;
  days: number;
}

export interface RevokedWaiver {
  id: string;
  projectId: string;
  gateCode: GateCode;
  permitTypeCode: string;
  validUntil: string;
  version: number;
  status: 'REVOKED';
}

export interface WaiverRow {
  id: string;
  project: { id: string; code: string; name: string };
  gateCode: GateCode;
  permitTypeId: string;
  permitTypeCode: string;
  permitTypeName: string;
  reason: string;
  decisionDocumentVersionId: string;
  validUntil: string;
  grantedOn: string;
  status: WaiverStatus;
  revokedOn: string | null;
  revokedReason: string | null;
  version: number;
  createdAtKey: string;
}

interface WaiverSql {
  id: string;
  project_id: string;
  project_code: string;
  project_name: string;
  gate_code: GateCode;
  permit_type_id: string;
  permit_type_code: string;
  permit_type_name: string;
  reason: string;
  decision_document_version_id: string;
  valid_until: string;
  granted_on: string;
  status: WaiverStatus;
  revoked_on: string | null;
  revoked_reason: string | null;
  version: string;
  created_at_key: string;
}

const SELECT = `select w.id, p.id as project_id, p.code as project_code, p.name as project_name, w.gate_code, w.permit_type_id, w.permit_type_code, t.name as permit_type_name,
  w.reason, w.decision_document_version_id, w.valid_until::text as valid_until, (w.approved_at at time zone 'Asia/Ho_Chi_Minh')::date::text as granted_on, w.status,
  (w.revoked_at at time zone 'Asia/Ho_Chi_Minh')::date::text as revoked_on, w.revoked_reason, w.version::text as version, ${timestampKey('w.created_at')} as created_at_key
  from ${SCOPE_FROM}
  join machvon.permit_gate_waiver w on w.tenant_id = p.tenant_id and w.project_id = p.id
  join machvon.permit_type t on t.tenant_id = w.tenant_id and t.id = w.permit_type_id`;

const toRow = (row: WaiverSql): WaiverRow => ({
  id: row.id,
  project: { id: row.project_id, code: row.project_code, name: row.project_name },
  gateCode: row.gate_code,
  permitTypeId: row.permit_type_id,
  permitTypeCode: row.permit_type_code,
  permitTypeName: row.permit_type_name,
  reason: row.reason,
  decisionDocumentVersionId: row.decision_document_version_id,
  validUntil: row.valid_until,
  grantedOn: row.granted_on,
  status: row.status,
  revokedOn: row.revoked_on,
  revokedReason: row.revoked_reason,
  version: Number(row.version),
  createdAtKey: row.created_at_key,
});

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

const TAB = 9;
const LINE_FEED = 10;
const CARRIAGE_RETURN = 13;
const SPACE = 32;
const DELETE = 127;

/** Whether the text holds a control character; tabs and line breaks are allowed (a reason may span lines). */
function hasControl(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === TAB || code === LINE_FEED || code === CARRIAGE_RETURN) continue;
    if (code < SPACE || code === DELETE) return true;
  }
  return false;
}

function reasonOf(value: unknown, field: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length < 1 || text.length > MAX_TEXT || hasControl(text)) throw invalid(field);
  return text;
}

function uuidOf(value: unknown, field: string): string {
  const id = asUuid(value);
  if (id === undefined) throw invalid(field);
  return id;
}

/** The days a waiver granted `today` lasts until `lastDay`, last day included. */
const daysBetween = (today: string, lastDay: string): number => Math.round((Date.parse(`${lastDay}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000) + 1;

/**
 * The time-limited waivers of the gates (ST-PMT-005, PMT 3.2 step 4, BR-PMT-05): the leader in charge of a project lets a gate pass without a permit
 * of one type until a last day that is within the longest a waiver may last, on a decision document and for a reason, and not when they are one of the
 * people who asked for it. A waiver is never extended or edited; it ends on the day after its last day (the job `gate-waiver-expiry`) or when it is
 * revoked, and a new waiver is a new decision. The evaluation of the gates (`PmtGateStore.evaluate`) reads the waivers in force.
 */
export class PmtGateWaiverStore {
  private readonly today: () => string;

  constructor(options: { today?: () => string } = {}) {
    this.today = options.today ?? (() => vietnamDateOf(new Date()));
  }

  /**
   * Grants a waiver. Refusals in order: the shape (422 VALIDATION_FAILED), the project (404 outside the scope of the caller), the permit type (422), the
   * length (422 WAIVER_TOO_LONG, naming the longest), the decision document (422 DECISION_DOCUMENT_REQUIRED), the people who asked for it (403
   * SELF_APPROVAL_DENIED) and a waiver already in force for the same project, gate and permit type (409 WAIVER_STATE_INVALID).
   */
  async grant(tx: TenantTx, input: WaiverInput, approver: string, scope: ScopeBuilder): Promise<GrantedWaiver> {
    const projectId = uuidOf(input.projectId, 'project_id');
    const gateCode = GATE_CODES.find((code) => code === input.gateCode);
    if (gateCode === undefined) throw invalid('gate_code');
    const permitTypeId = uuidOf(input.permitTypeId, 'permit_type_id');
    const documentVersionId = uuidOf(input.decisionDocumentVersionId, 'decision_document_version_id');
    const reason = reasonOf(input.reason, 'reason');
    const validUntil = input.validUntil;
    if (typeof validUntil !== 'string' || !isIsoDate(validUntil)) throw invalid('valid_until');
    const today = this.today();
    if (validUntil < today) throw invalid('valid_until');
    const days = daysBetween(today, validUntil);
    if (days > MAX_WAIVER_DAYS) {
      throw new DomainError('WAIVER_TOO_LONG', 422, 'valid_until', { extensions: { max_days: MAX_WAIVER_DAYS, requested_days: days, latest_day: shiftDays(today, MAX_WAIVER_DAYS - 1) } });
    }

    await this.lockProject(tx, projectId, scope);
    const type = (await tx.query<{ code: string }>('select code from machvon.permit_type where id = $1::uuid', [permitTypeId]))[0];
    if (type === undefined) throw invalid('permit_type_id');
    const requesters = await this.requestersOf(tx, projectId, type.code, documentVersionId);
    if (requesters.maker === undefined) throw new DomainError('DECISION_DOCUMENT_REQUIRED', 422, 'decision_document_version_id');
    if (requesters.all.has(approver.toLowerCase())) throw new DomainError('SELF_APPROVAL_DENIED', 403);

    const active = (
      await tx.query<{ id: string }>("select id from machvon.permit_gate_waiver where project_id = $1::uuid and gate_code = $2 and permit_type_code = $3 and status = 'ACTIVE' for update", [projectId, gateCode, type.code])
    )[0];
    if (active !== undefined) throw new DomainError('WAIVER_STATE_INVALID', 409, 'status', { extensions: { active_waiver_id: active.id } });

    const id = randomUUID();
    await tx.query(
      `insert into machvon.permit_gate_waiver
         (tenant_id, id, project_id, gate_code, permit_type_id, reason, decision_document_version_id, valid_until, approved_by, status, created_by, updated_by, version)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3, $4::uuid, $5, $6::uuid, $7::date, $8::uuid, 'ACTIVE', $9::uuid, $8::uuid, 1)`,
      [id, projectId, gateCode, permitTypeId, reason, documentVersionId, validUntil, approver, requesters.maker],
    );
    return { id, projectId, gateCode, permitTypeCode: type.code, validUntil, version: 1, status: 'ACTIVE', decisionDocumentVersionId: documentVersionId, grantedOn: today, days };
  }

  /**
   * Revokes a waiver in force, with the words that explain it. Refusals in order: the shape of the reason (422), the waiver (404 outside the scope of
   * the caller) and its state (409 WAIVER_STATE_INVALID once it has ended, by its last day or by a revocation).
   */
  async revoke(tx: TenantTx, waiverId: string, reasonText: unknown, actor: string, scope: ScopeBuilder): Promise<RevokedWaiver> {
    const reason = reasonOf(reasonText, 'reason');
    const peek = (await tx.query<{ project_id: string }>('select project_id from machvon.permit_gate_waiver where id = $1::uuid', [waiverId]))[0];
    if (peek === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    await this.lockProject(tx, peek.project_id, scope);
    const rows = await tx.query<{ id: string; project_id: string; gate_code: GateCode; permit_type_code: string; valid_until: string; status: WaiverStatus; version: string }>(
      'select id, project_id, gate_code, permit_type_code, valid_until::text as valid_until, status, version::text as version from machvon.permit_gate_waiver where id = $1::uuid for update',
      [waiverId],
    );
    const waiver = rows[0];
    if (waiver === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (waiver.status !== 'ACTIVE') throw new DomainError('WAIVER_STATE_INVALID', 409, 'status', { extensions: { waiver_status: waiver.status } });
    const version = Number(waiver.version) + 1;
    await tx.query(
      "update machvon.permit_gate_waiver set status = 'REVOKED', revoked_at = now(), revoked_by = $2::uuid, revoked_reason = $3, updated_at = now(), updated_by = $2::uuid, version = $4::bigint where id = $1::uuid",
      [waiverId, actor, reason, version],
    );
    return { id: waiver.id, projectId: waiver.project_id, gateCode: waiver.gate_code, permitTypeCode: waiver.permit_type_code, validUntil: waiver.valid_until, version, status: 'REVOKED' };
  }

  /** The waivers in the scope of the caller, the newest first, by project, gate and status. */
  async list(
    tx: TenantTx,
    scope: ScopeBuilder,
    filter: { projectId?: string | undefined; gateCode?: GateCode | undefined; status?: WaiverStatus | undefined },
    request: { limit: number; after: { code: string; id: string } | undefined },
  ): Promise<WaiverRow[]> {
    const predicate = scope(1);
    const params: unknown[] = [...predicate.params];
    const where = [predicate.sql];
    const add = (value: unknown, cast: string): string => {
      params.push(value);
      return `$${params.length}::${cast}`;
    };
    if (filter.projectId !== undefined) where.push(`w.project_id = ${add(filter.projectId, 'uuid')}`);
    if (filter.gateCode !== undefined) where.push(`w.gate_code = ${add(filter.gateCode, 'text')}`);
    if (filter.status !== undefined) where.push(`w.status = ${add(filter.status, 'text')}`);
    if (request.after !== undefined) where.push(`(${timestampKey('w.created_at')}, w.id) < (${add(request.after.code, 'text')}, ${add(request.after.id, 'uuid')})`);
    const rows = await tx.query<WaiverSql>(`${SELECT} where ${where.join(' and ')} order by w.created_at desc, w.id desc limit ${add(request.limit, 'int')}`, params);
    return rows.map(toRow);
  }

  /** One waiver in the scope of the caller; undefined when it does not exist or lies outside the scope. */
  async find(tx: TenantTx, id: string, scope: ScopeBuilder): Promise<WaiverRow | undefined> {
    const predicate = scope(2);
    const rows = await tx.query<WaiverSql>(`${SELECT} where w.id = $1::uuid and ${predicate.sql}`, [id, ...predicate.params]);
    return rows[0] === undefined ? undefined : toRow(rows[0]);
  }

  /**
   * The people who asked for the waiver, as the data says and the approver cannot choose: whoever made the decision document the waiver rests on (the
   * maker recorded on the waiver), whoever is in charge of the dossiers of the project, and whoever made or last changed a permit of that type in them.
   * The approver is none of them. `maker` is undefined when the document version is not one the tenant holds (or is infected).
   */
  private async requestersOf(tx: TenantTx, projectId: string, permitTypeCode: string, documentVersionId: string): Promise<{ maker: string | undefined; all: Set<string> }> {
    const document = (
      await tx.query<{ created_by: string }>(
        `select d.created_by from machvon.document_version v join machvon.document d on d.tenant_id = v.tenant_id and d.id = v.document_id where v.id = $1::uuid and v.scan_status <> 'INFECTED'`,
        [documentVersionId],
      )
    )[0];
    const people = await tx.query<{ member: string | null }>(
      `select m.member from (
         select d.owner_membership_id as member from machvon.permit_dossier d where d.project_id = $1::uuid
         union select x.created_by from machvon.permit x join machvon.permit_dossier d on d.tenant_id = x.tenant_id and d.id = x.dossier_id where d.project_id = $1::uuid and x.permit_type_code = $2
         union select x.updated_by from machvon.permit x join machvon.permit_dossier d on d.tenant_id = x.tenant_id and d.id = x.dossier_id where d.project_id = $1::uuid and x.permit_type_code = $2
         union select x.responsible_membership_id from machvon.permit x join machvon.permit_dossier d on d.tenant_id = x.tenant_id and d.id = x.dossier_id where d.project_id = $1::uuid and x.permit_type_code = $2
       ) m where m.member is not null`,
      [projectId, permitTypeCode],
    );
    const all = new Set(people.flatMap((row) => (row.member === null ? [] : [row.member.toLowerCase()])));
    if (document !== undefined) all.add(document.created_by.toLowerCase());
    return { maker: document?.created_by, all };
  }

  /** Locks the project (in the scope of the caller); a project outside the scope, or of another tenant, does not exist for the caller. */
  private async lockProject(tx: TenantTx, projectId: string, scope: ScopeBuilder): Promise<void> {
    const predicate = scope(2);
    const rows = await tx.query(`select p.id from ${SCOPE_FROM} where p.id = $1::uuid and ${predicate.sql} for update of p`, [projectId, ...predicate.params]);
    if (rows[0] === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
  }
}

