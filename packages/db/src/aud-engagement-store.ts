import { DomainError, activeGrants, assertEngagementClosable, holdKindOf, nextEngagementStatus, permissionMatches, versionConflict } from '@machvon/kernel';
import type { EffectiveAccess, EngagementStatus, EngagementType, ResourceRef } from '@machvon/kernel';
import { LegalHoldStore } from './legal-hold-store.ts';
import type { HoldScope } from './legal-hold-store.ts';
import { scopePredicate } from './scope-version.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';
import { withUniqueClaim } from './unique-claim.ts';

export type ScopeKind = 'UNIT' | 'PROJECT' | 'CONTRACT';
export const SCOPE_KINDS: readonly ScopeKind[] = ['UNIT', 'PROJECT', 'CONTRACT'];

/** A place the engagement is about: a unit, a project or a contract of the tenant. */
export interface ScopeTarget {
  kind: ScopeKind;
  id: string;
}

/** A scope target as it stands in the tenant: its code and name for people, and the unit tree and project it lies in for the permission test. */
export interface ResolvedTarget extends ScopeTarget {
  code: string;
  name: string;
  ownerUnitId: string;
  ownerUnitPath: string;
  projectId: string | null;
  contractId: string | null;
}

export interface NewEngagement {
  engagementCode: string;
  engagementType: EngagementType;
  authorityKind: string;
  authorityName: string;
  decisionDocumentId: string;
  title: string;
  periodFrom: string;
  periodTo: string;
  coordinatorId: string;
  scope: readonly ScopeTarget[];
}

export interface EngagementLine {
  id: string;
  engagementCode: string;
  engagementType: EngagementType;
  authorityKind: string;
  authorityName: string;
  title: string;
  periodFrom: string;
  periodTo: string;
  status: EngagementStatus;
  coordinatorId: string;
  coordinatorName: string;
  legalHoldId: string | null;
  holdStatus: 'Active' | 'Released' | null;
  scopeCount: number;
  version: number;
}

export interface EngagementDetail extends EngagementLine {
  decision: { documentId: string; title: string; symbol: string | null; issuedOn: string | null; effectStatus: string };
  startedOn: string | null;
  fieldworkEndedOn: string | null;
  closedOn: string | null;
  cancelReason: string | null;
  classification: string;
  scope: Array<{ kind: ScopeKind; id: string; code: string; name: string }>;
  createdAt: string;
  createdBy: string;
}

/** The engagement as a command locks it. */
export interface EngagementRow {
  id: string;
  engagementCode: string;
  engagementType: EngagementType;
  title: string;
  status: EngagementStatus;
  decisionDocumentId: string;
  startedOn: string | null;
  legalHoldId: string | null;
  version: number;
}

interface LineSql {
  id: string;
  engagement_code: string;
  engagement_type: EngagementType;
  authority_kind: string;
  authority_name: string;
  title: string;
  period_from: string;
  period_to: string;
  status: EngagementStatus;
  coordinator_user_id: string;
  coordinator_name: string | null;
  legal_hold_id: string | null;
  hold_status: 'Active' | 'Released' | null;
  scope_count: string;
  version: string;
}

interface DetailSql extends LineSql {
  decision_document_id: string;
  decision_title: string | null;
  decision_symbol: string | null;
  decision_issued_on: string | null;
  decision_effect_status: string | null;
  started_on: string | null;
  fieldwork_ended_on: string | null;
  closed_on: string | null;
  cancel_reason: string | null;
  classification: string;
  created_at: string;
  created_by: string;
}

interface LockSql {
  id: string;
  engagement_code: string;
  engagement_type: EngagementType;
  title: string;
  status: EngagementStatus;
  decision_document_id: string;
  started_on: string | null;
  legal_hold_id: string | null;
  version: string;
}

const LINE_COLUMNS = `e.id, e.engagement_code, e.engagement_type, e.authority_kind, e.authority_name, e.title, e.period_from::text as period_from, e.period_to::text as period_to,
  e.status, e.coordinator_user_id, coalesce(d.display_name, '') as coordinator_name, e.legal_hold_id, h.status as hold_status,
  (select count(*) from machvon.audit_scope_item i where i.tenant_id = e.tenant_id and i.engagement_id = e.id)::text as scope_count, e.version::text as version`;
const DETAIL_COLUMNS = `${LINE_COLUMNS}, e.decision_document_id, doc.title as decision_title, doc.symbol as decision_symbol, doc.issued_on::text as decision_issued_on, doc.effect_status as decision_effect_status,
  e.started_on::text as started_on, e.fieldwork_ended_on::text as fieldwork_ended_on, e.closed_on::text as closed_on, e.cancel_reason, e.classification,
  e.created_at::text as created_at, e.created_by`;
const FROM = `machvon.audit_engagement e
  left join machvon.tenant_user_directory d on d.tenant_id = e.tenant_id and d.membership_id = e.coordinator_user_id
  left join machvon.legal_hold h on h.tenant_id = e.tenant_id and h.id = e.legal_hold_id`;
const DETAIL_FROM = `${FROM}
  left join machvon.document doc on doc.tenant_id = e.tenant_id and doc.id = e.decision_document_id`;
const LOCK_SQL = `select e.id, e.engagement_code, e.engagement_type, e.title, e.status, e.decision_document_id, e.started_on::text as started_on, e.legal_hold_id, e.version::text as version
  from machvon.audit_engagement e where e.id = $1::uuid`;

const RESOLVE_SQL = `select 'UNIT' as kind, u.id, u.code, u.name, u.id as owner_unit_id, u.path as owner_unit_path, null::uuid as project_id, null::uuid as contract_id
    from machvon.organization_unit u where u.id = any($1::uuid[])
  union all
  select 'PROJECT', p.id, p.code, p.name, ou.id, ou.path, p.id, null::uuid
    from machvon.project p join machvon.organization_unit ou on ou.id = p.owner_unit_id where p.id = any($2::uuid[])
  union all
  select 'CONTRACT', c.id, c.code, coalesce(c.title, c.code), ou.id, ou.path, c.project_id, c.id
    from machvon.contract c join machvon.project p on p.id = c.project_id join machvon.organization_unit ou on ou.id = p.owner_unit_id where c.id = any($3::uuid[])`;

const NOT_FOUND = (): DomainError => new DomainError('RESOURCE_NOT_FOUND', 404);

const toLine = (row: LineSql): EngagementLine => ({
  id: row.id,
  engagementCode: row.engagement_code,
  engagementType: row.engagement_type,
  authorityKind: row.authority_kind,
  authorityName: row.authority_name,
  title: row.title,
  periodFrom: row.period_from,
  periodTo: row.period_to,
  status: row.status,
  coordinatorId: row.coordinator_user_id,
  coordinatorName: row.coordinator_name ?? '',
  legalHoldId: row.legal_hold_id,
  holdStatus: row.hold_status,
  scopeCount: Number(row.scope_count),
  version: Number(row.version),
});

/** The place of a resolved target for the permission test: the unit tree it lies in, within its project and contract. */
export function targetRef(target: ResolvedTarget): ResourceRef {
  return {
    ownerUnitPath: target.ownerUnitPath,
    ownerUnitId: target.ownerUnitId,
    ...(target.projectId === null ? {} : { projectId: target.projectId }),
    ...(target.contractId === null ? {} : { contractId: target.contractId }),
  };
}

/**
 * The engagements a permission lets a caller see (AUD 2: the data are CONFIDENTIAL): the ones with a scope item that lies in a scope of a grant that carries the permission. A unit item
 * lies in a unit scope; a project item in the scope of its owner or investor unit or when the grant names the project; a contract item through its project or when the grant names the
 * contract. An engagement outside every grant is not found (404), whatever the tenant says. Compiled over the alias `e` of the engagement queries; the parameters start at `first`.
 */
export function engagementScope(access: EffectiveAccess, permission: string, now: Date): ScopeBuilder {
  return (first: number) => {
    const unit = scopePredicate(access, permission, now, { unitPath: 'su.path', unitId: 'su.id' }, first);
    if (unit.sql === 'true') return unit;
    const owner = scopePredicate(access, permission, now, { unitPath: 'ou.path', unitId: 'ou.id' }, first + unit.params.length);
    const investor = scopePredicate(access, permission, now, { unitPath: 'iu.path', unitId: 'iu.id' }, first + unit.params.length + owner.params.length);
    const params = [...unit.params, ...owner.params, ...investor.params];
    const alternatives = [unit.sql, owner.sql, investor.sql];
    const projectIds = new Set<string>();
    const contractIds = new Set<string>();
    for (const grant of activeGrants(access, now)) {
      if (!grant.permissions.some((held) => permissionMatches(held, permission))) continue;
      if (grant.scope.kind === 'PROJECT') for (const id of grant.scope.refIds) projectIds.add(id.toLowerCase());
      if (grant.scope.kind === 'CONTRACT') for (const id of grant.scope.refIds) contractIds.add(id.toLowerCase());
    }
    if (projectIds.size > 0) {
      params.push([...projectIds].sort());
      alternatives.push(`sp.id = any($${first + params.length - 1}::uuid[])`);
    }
    if (contractIds.size > 0) {
      params.push([...contractIds].sort());
      alternatives.push(`si.contract_id = any($${first + params.length - 1}::uuid[])`);
    }
    return {
      sql: `exists (select 1 from machvon.audit_scope_item si
        left join machvon.organization_unit su on su.tenant_id = si.tenant_id and su.id = si.organization_unit_id
        left join machvon.contract sc on sc.tenant_id = si.tenant_id and sc.id = si.contract_id
        left join machvon.project sp on sp.tenant_id = si.tenant_id and sp.id = coalesce(si.project_id, sc.project_id)
        left join machvon.organization_unit ou on ou.tenant_id = sp.tenant_id and ou.id = sp.owner_unit_id
        left join machvon.organization_unit iu on iu.tenant_id = sp.tenant_id and iu.id = sp.investor_unit_id
        where si.tenant_id = e.tenant_id and si.engagement_id = e.id and (${alternatives.join(' or ')}))`,
      params,
    };
  };
}

/**
 * Audit and inspection engagements (ST-AUD-001, AUD 3.1): registered against an effective decision with the units, projects and contracts they are about, started with a legal hold that
 * covers that scope (BR-AUD-10), and cancelled before any conclusion with the hold released. Every read goes through `engagementScope`; the hold is placed and released in the transaction of
 * the command, so an engagement never shows a hold it does not have.
 */
export class AudEngagementStore {
  private readonly holds = new LegalHoldStore();

  /** The targets of a scope as they stand in the tenant; one that is not there is 404, whether it never existed or belongs to another tenant (BR-IAM-01: the answer must not tell which). */
  async resolveTargets(tx: TenantTx, items: readonly ScopeTarget[]): Promise<ResolvedTarget[]> {
    const unique = new Map(items.map((item) => [`${item.kind}:${item.id.toLowerCase()}`, { kind: item.kind, id: item.id.toLowerCase() }]));
    const ids = (kind: ScopeKind): string[] => [...unique.values()].filter((item) => item.kind === kind).map((item) => item.id);
    const rows = await tx.query<{
      kind: ScopeKind;
      id: string;
      code: string;
      name: string;
      owner_unit_id: string;
      owner_unit_path: string;
      project_id: string | null;
      contract_id: string | null;
    }>(RESOLVE_SQL, [ids('UNIT'), ids('PROJECT'), ids('CONTRACT')]);
    const found = new Map(rows.map((row) => [`${row.kind}:${row.id}`, row]));
    return [...unique.entries()].map(([key, item]) => {
      const row = found.get(key);
      if (row === undefined) throw NOT_FOUND();
      return { kind: item.kind, id: item.id, code: row.code, name: row.name, ownerUnitId: row.owner_unit_id, ownerUnitPath: row.owner_unit_path, projectId: row.project_id, contractId: row.contract_id };
    });
  }

  /**
   * Registers an engagement in PLANNED with its scope. The decision must be a document that DOC holds as received or as a reference and that is in force (422
   * DECISION_DOCUMENT_NOT_EFFECTIVE, whatever the reason, so that the answer does not tell what exists); the coordinator must be an active member (422); a code is used once (409).
   */
  async create(tx: TenantTx, input: NewEngagement, targets: readonly ResolvedTarget[], actor: string): Promise<{ id: string; version: number }> {
    const [document] = await tx.query<{ doc_kind: string; effect_status: string }>('select doc_kind, effect_status from machvon.document where id = $1::uuid', [input.decisionDocumentId]);
    if (document === undefined || !['INCOMING', 'REFERENCE'].includes(document.doc_kind) || document.effect_status !== 'EFFECTIVE') {
      throw new DomainError('DECISION_DOCUMENT_NOT_EFFECTIVE', 422);
    }
    const [coordinator] = await tx.query<{ id: string }>("select id from machvon.membership where id = $1::uuid and status = 'Active'", [input.coordinatorId]);
    if (coordinator === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'coordinator_user_id');
    if (input.periodTo < input.periodFrom) throw new DomainError('VALIDATION_FAILED', 422, 'period_to');
    const created = await withUniqueClaim(tx, { constraint: 'audit_engagement_code_uq', code: 'ENGAGEMENT_CODE_DUPLICATE', status: 409 }, async () => {
      const [row] = await tx.query<{ id: string }>(
        `insert into machvon.audit_engagement
           (tenant_id, id, engagement_code, engagement_type, authority_kind, authority_name, decision_document_id, title, period_from, period_to, coordinator_user_id,
            status, classification, created_by, updated_by, version)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1, $2, $3, $4, $5::uuid, $6, $7::date, $8::date, $9::uuid,
                 'PLANNED', 'CONFIDENTIAL', $10::uuid, $10::uuid, 1)
         returning id`,
        [input.engagementCode, input.engagementType, input.authorityKind, input.authorityName, input.decisionDocumentId, input.title, input.periodFrom, input.periodTo, input.coordinatorId, actor],
      );
      return row as { id: string };
    });
    for (const target of targets) {
      await tx.query(
        `insert into machvon.audit_scope_item (tenant_id, id, engagement_id, scope_kind, organization_unit_id, project_id, contract_id, added_by)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, $2,
                 case when $2 = 'UNIT' then $3::uuid end, case when $2 = 'PROJECT' then $3::uuid end, case when $2 = 'CONTRACT' then $3::uuid end, $4::uuid)`,
        [created.id, target.kind, target.id, actor],
      );
    }
    return { id: created.id, version: 1 };
  }

  /** The engagements in the scope of the caller, ordered by code; the cursor is the code and the id of the last line. */
  async list(
    tx: TenantTx,
    scope: ScopeBuilder,
    request: { limit: number; after: { code: string; id: string } | undefined; status?: string | undefined; type?: string | undefined; projectId?: string | undefined },
  ): Promise<EngagementLine[]> {
    const predicate = scope(7);
    const rows = await tx.query<LineSql>(
      `select ${LINE_COLUMNS} from ${FROM}
        where ($1::text is null or (e.engagement_code, e.id) > ($1::text, $2::uuid))
          and ($4::text is null or e.status = $4::text) and ($5::text is null or e.engagement_type = $5::text)
          and ($6::uuid is null or exists (select 1 from machvon.audit_scope_item pi
                                           left join machvon.contract pc on pc.tenant_id = pi.tenant_id and pc.id = pi.contract_id
                                          where pi.tenant_id = e.tenant_id and pi.engagement_id = e.id and coalesce(pi.project_id, pc.project_id) = $6::uuid))
          and ${predicate.sql}
        order by e.engagement_code, e.id limit $3`,
      [request.after?.code ?? null, request.after?.id ?? null, request.limit, request.status ?? null, request.type ?? null, request.projectId ?? null, ...predicate.params],
    );
    return rows.map(toLine);
  }

  /** One engagement in the scope of the caller with its decision and scope items; undefined when it does not exist or lies outside the scope. */
  async find(tx: TenantTx, id: string, scope: ScopeBuilder): Promise<EngagementDetail | undefined> {
    const predicate = scope(2);
    const [row] = await tx.query<DetailSql>(`select ${DETAIL_COLUMNS} from ${DETAIL_FROM} where e.id = $1::uuid and ${predicate.sql}`, [id, ...predicate.params]);
    if (row === undefined) return undefined;
    const items = await tx.query<{ scope_kind: ScopeKind; target_id: string; code: string; name: string }>(
      `select i.scope_kind, coalesce(i.organization_unit_id, i.project_id, i.contract_id) as target_id,
              coalesce(u.code, p.code, c.code) as code, coalesce(u.name, p.name, c.title, c.code) as name
         from machvon.audit_scope_item i
         left join machvon.organization_unit u on u.tenant_id = i.tenant_id and u.id = i.organization_unit_id
         left join machvon.project p on p.tenant_id = i.tenant_id and p.id = i.project_id
         left join machvon.contract c on c.tenant_id = i.tenant_id and c.id = i.contract_id
        where i.engagement_id = $1::uuid order by i.scope_kind, coalesce(u.code, p.code, c.code)`,
      [id],
    );
    return {
      ...toLine(row),
      decision: { documentId: row.decision_document_id, title: row.decision_title ?? '', symbol: row.decision_symbol, issuedOn: row.decision_issued_on, effectStatus: row.decision_effect_status ?? '' },
      startedOn: row.started_on,
      fieldworkEndedOn: row.fieldwork_ended_on,
      closedOn: row.closed_on,
      cancelReason: row.cancel_reason,
      classification: row.classification,
      scope: items.map((item) => ({ kind: item.scope_kind, id: item.target_id, code: item.code, name: item.name })),
      createdAt: row.created_at,
      createdBy: row.created_by,
    };
  }

  /**
   * Locks an engagement for a command in the scope of the caller (404 outside it). The version must be the one the screen showed (409). A caller who sees it but may not act on
   * it is told by the second scope: `acts` (403 SCOPE_DENIED), checked after the lock so that the answer does not depend on timing.
   */
  async lock(tx: TenantTx, id: string, seen: ScopeBuilder, acts: ScopeBuilder, expectedVersion: number): Promise<EngagementRow> {
    const visible = seen(2);
    const [located] = await tx.query<{ id: string }>(`select e.id from machvon.audit_engagement e where e.id = $1::uuid and ${visible.sql}`, [id, ...visible.params]);
    if (located === undefined) throw NOT_FOUND();
    const [row] = await tx.query<LockSql>(`${LOCK_SQL} for update of e`, [id]);
    if (row === undefined) throw NOT_FOUND();
    const own = acts(2);
    const [allowed] = await tx.query<{ id: string }>(`select e.id from machvon.audit_engagement e where e.id = $1::uuid and ${own.sql}`, [id, ...own.params]);
    if (allowed === undefined) throw new DomainError('SCOPE_DENIED', 403);
    if (Number(row.version) !== expectedVersion) throw versionConflict(Number(row.version));
    return {
      id: row.id,
      engagementCode: row.engagement_code,
      engagementType: row.engagement_type,
      title: row.title,
      status: row.status,
      decisionDocumentId: row.decision_document_id,
      startedOn: row.started_on,
      legalHoldId: row.legal_hold_id,
      version: Number(row.version),
    };
  }

  /** The units, projects and contracts of the engagement, as the scope of the hold that covers them. */
  async holdScope(tx: TenantTx, engagementId: string): Promise<HoldScope> {
    const items = await tx.query<{ scope_kind: ScopeKind; target_id: string }>(
      'select scope_kind, coalesce(organization_unit_id, project_id, contract_id) as target_id from machvon.audit_scope_item where engagement_id = $1::uuid order by scope_kind, target_id',
      [engagementId],
    );
    const kinds = new Set(items.map((item) => item.scope_kind));
    const [only] = [...kinds];
    // A hold lists ids that are told apart by what they are: one kind gives the kind of the hold, a mixed scope is a list of resources.
    return { kind: kinds.size === 1 && only !== undefined ? only : 'RESOURCE', ids: items.map((item) => item.target_id) };
  }

  /**
   * START: PLANNED to ONGOING on the day given (not in the future, and the decision still in force); with `placeLegalHold` the hold covering the scope is placed in the same
   * transaction (BR-AUD-10) and its id kept. Returns the new version and the hold.
   */
  async start(tx: TenantTx, row: EngagementRow, input: { startedOn: string; placeLegalHold: boolean; today: string }, actor: string): Promise<{ version: number; legalHoldId: string | null }> {
    const status = nextEngagementStatus(row.status, 'start');
    if (input.startedOn > input.today) throw new DomainError('VALIDATION_FAILED', 422, 'started_on');
    const [document] = await tx.query<{ effect_status: string }>('select effect_status from machvon.document where id = $1::uuid', [row.decisionDocumentId]);
    if (document?.effect_status !== 'EFFECTIVE') throw new DomainError('DECISION_DOCUMENT_NOT_EFFECTIVE', 422);
    let holdId: string | null = null;
    if (input.placeLegalHold) {
      const scope = await this.holdScope(tx, row.id);
      const placed = await this.holds.place(
        tx,
        { holdKind: holdKindOf(row.engagementType), scope, authorityReference: row.engagementCode, reason: `Engagement ${row.engagementCode}: ${row.title}`.slice(0, 500) },
        actor,
      );
      holdId = placed.id;
    }
    const [updated] = await tx.query<{ version: string }>(
      `update machvon.audit_engagement set status = $2, started_on = $3::date, legal_hold_id = $4::uuid, updated_at = now(), updated_by = $5::uuid, version = version + 1
        where id = $1::uuid returning version::text as version`,
      [row.id, status, input.startedOn, holdId, actor],
    );
    return { version: Number((updated as { version: string }).version), legalHoldId: holdId };
  }

  /** END OF FIELDWORK: ONGOING to AWAITING_CONCLUSION on a day between the start and today. */
  async endFieldwork(tx: TenantTx, row: EngagementRow, input: { onDate: string; today: string }, actor: string): Promise<{ version: number }> {
    const status = nextEngagementStatus(row.status, 'endFieldwork');
    if (input.onDate > input.today || (row.startedOn !== null && input.onDate < row.startedOn)) throw new DomainError('VALIDATION_FAILED', 422, 'on_date');
    const [updated] = await tx.query<{ version: string }>(
      `update machvon.audit_engagement set status = $2, fieldwork_ended_on = $3::date, updated_at = now(), updated_by = $4::uuid, version = version + 1
        where id = $1::uuid returning version::text as version`,
      [row.id, status, input.onDate, actor],
    );
    return { version: Number((updated as { version: string }).version) };
  }

  /**
   * CANCEL: before any conclusion, with a reason. The hold of the engagement is released in the same transaction (BR-AUD-10) by the system, as it was placed for the engagement
   * and not for a person to answer for; a hold that someone released already is left as it is.
   */
  async cancel(tx: TenantTx, row: EngagementRow, input: { reason: string; releasedBy: string }, actor: string): Promise<{ version: number; holdReleased: boolean }> {
    const [conclusion] = await tx.query<{ id: string }>('select id from machvon.audit_conclusion where engagement_id = $1::uuid limit 1', [row.id]);
    if (conclusion !== undefined) throw new DomainError('CONCLUSION_EXISTS', 409);
    const status = nextEngagementStatus(row.status, 'cancel');
    const reason = input.reason.trim();
    if (reason.length < 10) throw new DomainError('VALIDATION_FAILED', 422, 'reason');
    const holdReleased = row.legalHoldId !== null && (await this.releaseHold(tx, row.legalHoldId, input.releasedBy, 'The engagement was cancelled.'));
    const [updated] = await tx.query<{ version: string }>(
      `update machvon.audit_engagement set status = $2, cancel_reason = $3, updated_at = now(), updated_by = $4::uuid, version = version + 1
        where id = $1::uuid returning version::text as version`,
      [row.id, status, reason, actor],
    );
    return { version: Number((updated as { version: string }).version), holdReleased };
  }

  /**
   * CLOSE: FOLLOW_UP to CLOSED on a day from the start to today, when no recommendation is open and every conclusion that stands has a report DOC issued (the facts are read by the caller
   * after the engagement is locked, which is what a reversal of a recovery waits for before it reopens a recommendation). The hold of the engagement is released in the same transaction by the
   * system (BR-AUD-10); a hold that someone released already is left as it is.
   */
  async close(
    tx: TenantTx,
    row: EngagementRow,
    input: { onDate: string; today: string; releasedBy: string; facts: { openRecommendations: number; conclusionsWithoutReport: number } },
    actor: string,
  ): Promise<{ version: number; holdReleased: boolean }> {
    const status = nextEngagementStatus(row.status, 'close');
    if (input.onDate > input.today || (row.startedOn !== null && input.onDate < row.startedOn)) throw new DomainError('VALIDATION_FAILED', 422, 'on_date');
    assertEngagementClosable(input.facts);
    const holdReleased = row.legalHoldId !== null && (await this.releaseHold(tx, row.legalHoldId, input.releasedBy, 'The engagement was closed.'));
    const [updated] = await tx.query<{ version: string }>(
      `update machvon.audit_engagement set status = $2, closed_on = $3::date, updated_at = now(), updated_by = $4::uuid, version = version + 1
        where id = $1::uuid returning version::text as version`,
      [row.id, status, input.onDate, actor],
    );
    return { version: Number((updated as { version: string }).version), holdReleased };
  }

  /** Releases the hold of an engagement that is over; false when it was released already. */
  async releaseHold(tx: TenantTx, holdId: string, releasedBy: string, reason: string): Promise<boolean> {
    const hold = await this.holds.find(tx, holdId);
    if (hold === undefined || hold.status !== 'Active') return false;
    // The person who placed a hold may not release it (BR-ADM-01, and the database refuses it): the engagement releases it as the system, whoever placed it.
    await this.holds.release(tx, hold, releasedBy, reason);
    return true;
  }
}
