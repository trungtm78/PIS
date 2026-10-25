import { randomUUID } from 'node:crypto';
import { CONSTRUCTION_GRADES, DomainError, WARRANTY_STATUSES, assertWarrantyClosure, assertWarrantyPeriod, vietnamDateOf, warrantyEndsOn } from '@machvon/kernel';
import type { ConstructionGrade, WarrantyStatus } from '@machvon/kernel';
import { AstWarrantyRules } from './ast-warranty-rules.ts';
import { SCOPE_FROM as CONTRACT_SCOPE_FROM, calendarDate, textOf, wholeAmount } from './ctr-contract-store.ts';
import type { HandoverPlace, HandoverScopes } from './ast-handover-store.ts';
import { assertTimestampCursor, timestampKey } from './keyset.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TEXT = 2000;
const MAX_PAGE = 200;
const MAX_PERIOD_MONTHS = 600;
const UNIQUE_VIOLATION = '23505';

const invalid = (field: string, reason?: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field, reason === undefined ? undefined : { extensions: { reason } });
const idOf = (value: string, field: string): string => {
  if (!UUID.test(value)) throw invalid(field);
  return value.toLowerCase();
};
const optionalId = (value: string | undefined, field: string): string | null => (value === undefined ? null : idOf(value, field));

export interface CreateInput {
  contractId: string;
  handoverId: string;
  assetId?: string | undefined;
  scopeDescription: string;
  startsOn: string;
  periodMonths: number;
  warrantyGuaranteeId?: string | undefined;
  retentionAmountVnd?: string | undefined;
  constructionGrade?: string | undefined;
}

export interface CloseInput {
  note?: string | undefined;
}

export interface WarrantyFilter {
  contractId?: string | undefined;
  handoverId?: string | undefined;
  status?: string | undefined;
  /** The day the status is judged on (an active obligation whose last day has come is expired). */
  today: string;
  limit: number;
  after?: { code: string; id: string } | undefined;
}

/** What a command did to an obligation: the facts the audit row and the event carry. */
export interface WarrantyResult {
  id: string;
  contractId: string;
  contractCode: string;
  handoverId: string;
  projectId: string;
  assetId: string | null;
  startsOn: string;
  endsOn: string;
  periodMonths: number;
  constructionGrade: ConstructionGrade | null;
  minimumMonths: number | null;
  ruleVersionId: string | null;
  warrantyGuaranteeId: string | null;
  retentionAmountVnd: string;
  fromStatus: WarrantyStatus | null;
  status: WarrantyStatus;
  version: number;
  /** The claims that were still open when the obligation was closed: none, or the closure was refused. */
  openClaims: number;
}

export interface WarrantyLine {
  id: string;
  contract: { id: string; code: string };
  handover: { id: string; handoverNo: string | null; status: string };
  projectId: string;
  asset: { id: string; assetCode: string; name: string | null } | null;
  scopeDescription: string;
  startsOn: string;
  endsOn: string;
  periodMonths: number;
  constructionGrade: ConstructionGrade | null;
  minimumMonths: number | null;
  /** The version of the rule the term was judged by, and whether that rule still waits for the confirmation of its source. */
  rule: { versionId: string; awaitingConfirmation: boolean; cxn: string | null } | null;
  guarantee: { id: string; guaranteeNo: string | null; issuer: string; amountVnd: string; expiresOn: string } | null;
  retentionAmountVnd: string;
  status: WarrantyStatus;
  closedAt: string | null;
  closeNote: string | null;
  openClaims: number;
  totalClaims: number;
  createdAt: string;
  version: number;
  reach: HandoverPlace;
}

interface LineSql {
  id: string;
  contract_id: string;
  contract_code: string;
  handover_id: string;
  handover_no: string | null;
  handover_status: string;
  project_id: string;
  asset_id: string | null;
  asset_code: string | null;
  asset_name: string | null;
  scope_description: string;
  starts_on: string;
  ends_on: string;
  period_months: number;
  construction_grade: ConstructionGrade | null;
  minimum_months: number | null;
  rule_version_id: string | null;
  rule_awaiting: string | null;
  rule_cxn: string | null;
  guarantee_id: string | null;
  guarantee_no: string | null;
  guarantee_issuer: string | null;
  guarantee_amount_vnd: string | null;
  guarantee_expires_on: string | null;
  retention_amount_vnd: string;
  status: WarrantyStatus;
  closed_at: string | null;
  close_note: string | null;
  open_claims: string;
  total_claims: string;
  created_at: string;
  version: string;
  owner_unit_id: string;
  owner_unit_path: string;
  investor_unit_id: string | null;
  investor_unit_path: string | null;
  recipient_unit_id: string;
  recipient_unit_path: string;
}

const HANDOVER_FROM = `${CONTRACT_SCOPE_FROM}
  join machvon.handover h on h.tenant_id = c.tenant_id and h.contract_id = c.id
  join machvon.organization_unit ru on ru.tenant_id = h.tenant_id and ru.id = h.recipient_unit_id`;

const FROM = `${HANDOVER_FROM}
  join machvon.warranty_obligation w on w.tenant_id = h.tenant_id and w.handover_id = h.id
  left join machvon.asset_record a on a.tenant_id = w.tenant_id and a.id = w.asset_id
  left join machvon.guarantee g on g.tenant_id = w.tenant_id and g.id = w.warranty_guarantee_id
  left join machvon.master_record_version rv on rv.id = w.rule_version_id`;

/** The status as it stands on the day: an active obligation whose last day has come is expired, whether or not the job has marked it yet. */
const STATUS_ON = (today: string) => `case when w.status = 'ACTIVE' and w.ends_on <= ${today} then 'EXPIRED' else w.status end`;

const SELECT = `select w.id, c.id as contract_id, c.code as contract_code, h.id as handover_id, h.handover_no, h.status as handover_status, c.project_id, w.asset_id, a.asset_code, a.name as asset_name,
       w.scope_description, w.starts_on::text as starts_on, w.ends_on::text as ends_on, w.period_months, w.construction_grade, w.minimum_months, w.rule_version_id,
       rv.attributes ->> 'awaiting_confirmation' as rule_awaiting, rv.attributes ->> 'cxn' as rule_cxn, g.id as guarantee_id, g.guarantee_no, g.issuer as guarantee_issuer,
       g.amount_vnd::text as guarantee_amount_vnd, (g.expires_at at time zone 'Asia/Ho_Chi_Minh')::date::text as guarantee_expires_on, w.retention_amount_vnd::text as retention_amount_vnd,
       w.status, ${timestampKey('w.closed_at')} as closed_at, w.close_note,
       (select count(*) from machvon.warranty_claim k where k.tenant_id = w.tenant_id and k.obligation_id = w.id and k.status not in ('VERIFIED', 'CLOSED'))::text as open_claims,
       (select count(*) from machvon.warranty_claim k where k.tenant_id = w.tenant_id and k.obligation_id = w.id)::text as total_claims,
       ${timestampKey('w.created_at')} as created_at, w.version::text as version, ou.id as owner_unit_id, ou.path as owner_unit_path, iu.id as investor_unit_id, iu.path as investor_unit_path,
       h.recipient_unit_id, ru.path as recipient_unit_path
  from ${FROM}`;

const toLine = (row: LineSql): WarrantyLine => ({
  id: row.id,
  contract: { id: row.contract_id, code: row.contract_code },
  handover: { id: row.handover_id, handoverNo: row.handover_no, status: row.handover_status },
  projectId: row.project_id,
  asset: row.asset_id === null ? null : { id: row.asset_id, assetCode: row.asset_code ?? '', name: row.asset_name },
  scopeDescription: row.scope_description,
  startsOn: row.starts_on,
  endsOn: row.ends_on,
  periodMonths: row.period_months,
  constructionGrade: row.construction_grade,
  minimumMonths: row.minimum_months,
  rule: row.rule_version_id === null ? null : { versionId: row.rule_version_id, awaitingConfirmation: row.rule_awaiting === 'true', cxn: row.rule_cxn },
  guarantee:
    row.guarantee_id === null
      ? null
      : { id: row.guarantee_id, guaranteeNo: row.guarantee_no, issuer: row.guarantee_issuer ?? '', amountVnd: row.guarantee_amount_vnd ?? '0', expiresOn: row.guarantee_expires_on ?? '' },
  retentionAmountVnd: row.retention_amount_vnd,
  status: row.status,
  closedAt: row.closed_at,
  closeNote: row.close_note,
  openClaims: Number(row.open_claims),
  totalClaims: Number(row.total_claims),
  createdAt: row.created_at,
  version: Number(row.version),
  reach: {
    contractId: row.contract_id,
    projectId: row.project_id,
    ownerUnit: { id: row.owner_unit_id, path: row.owner_unit_path },
    investorUnit: row.investor_unit_id === null || row.investor_unit_path === null ? null : { id: row.investor_unit_id, path: row.investor_unit_path },
    recipientUnit: { id: row.recipient_unit_id, path: row.recipient_unit_path },
  },
});

interface Held {
  id: string;
  contract_id: string;
  contract_code: string;
  handover_id: string;
  project_id: string;
  asset_id: string | null;
  starts_on: string;
  ends_on: string;
  period_months: number;
  construction_grade: ConstructionGrade | null;
  minimum_months: number | null;
  rule_version_id: string | null;
  warranty_guarantee_id: string | null;
  retention_amount_vnd: string;
  status: WarrantyStatus;
  version: string;
}

/**
 * The warranty a work carries after its handover (ST-AST-003, AST 3.3, BR-AST-03, BR-AST-05, UAT-AC390, UAT-AC392). An obligation is created for an accepted handover with a term that is not below the
 * minimum the rule data states for the grade of the work (422 `WARRANTY_PERIOD_BELOW_MINIMUM`), covered by a warranty guarantee of the contract or by an amount held back (422
 * `GUARANTEE_REQUIRED`); it ends the term after it starts. It is closed once it has run out and no claim is open (422 `WARRANTY_NOT_EXPIRED`, 422 `OPEN_WARRANTY_CLAIMS`), and its closure is what
 * lets the retention and the warranty guarantee be released.
 */
export class AstWarrantyStore {
  private readonly rules: AstWarrantyRules;

  constructor(rules: AstWarrantyRules = new AstWarrantyRules()) {
    this.rules = rules;
  }

  async create(tx: TenantTx, input: CreateInput, actor: string, scopes: HandoverScopes, now: Date): Promise<WarrantyResult> {
    const contractId = idOf(input.contractId, 'contract_id');
    const handoverId = idOf(input.handoverId, 'handover_id');
    const assetId = optionalId(input.assetId, 'asset_id');
    const guaranteeId = optionalId(input.warrantyGuaranteeId, 'warranty_guarantee_id');
    const description = textOf(input.scopeDescription, 'scope_description', MAX_TEXT);
    const startsOn = calendarDate(input.startsOn, 'starts_on');
    const months = input.periodMonths;
    if (!Number.isInteger(months) || months < 1 || months > MAX_PERIOD_MONTHS) throw invalid('period_months');
    const retention = input.retentionAmountVnd === undefined ? '0' : wholeAmount(input.retentionAmountVnd, 'retention_amount_vnd');
    const grade = input.constructionGrade === undefined ? null : (CONSTRUCTION_GRADES.find((candidate) => candidate === input.constructionGrade) ?? this.badField('construction_grade'));

    const handover = await this.handover(tx, handoverId, scopes);
    if (handover.contract_id !== contractId) throw invalid('contract_id', 'NOT_THE_CONTRACT_OF_THE_HANDOVER');
    if (handover.status !== 'ACCEPTED') throw new DomainError('HANDOVER_NOT_ACCEPTED', 422, 'handover_id', { extensions: { status: handover.status } });
    if (assetId !== null) {
      const assets = await tx.query<{ handover_id: string; status: string }>('select handover_id, status from machvon.asset_record where id = $1::uuid', [assetId]);
      if (assets[0] === undefined) throw invalid('asset_id', 'NOT_FOUND');
      if (assets[0].handover_id !== handoverId) throw invalid('asset_id', 'NOT_AN_ASSET_OF_THE_HANDOVER');
      if (assets[0].status === 'DISPOSED') throw invalid('asset_id', 'ASSET_DISPOSED');
    }
    if (guaranteeId !== null) {
      const guarantees = await tx.query<{ contract_id: string; kind: string; status: string }>('select contract_id, kind, status from machvon.guarantee where id = $1::uuid', [guaranteeId]);
      const guarantee = guarantees[0];
      if (guarantee === undefined) throw invalid('warranty_guarantee_id', 'NOT_FOUND');
      if (guarantee.contract_id !== contractId) throw invalid('warranty_guarantee_id', 'NOT_A_GUARANTEE_OF_THE_CONTRACT');
      if (guarantee.kind !== 'WARRANTY') throw invalid('warranty_guarantee_id', 'NOT_A_WARRANTY_GUARANTEE');
      if (guarantee.status !== 'ACTIVE') throw invalid('warranty_guarantee_id', 'GUARANTEE_NOT_ACTIVE');
    }

    const rule = await this.rules.resolve(tx, grade, vietnamDateOf(now));
    assertWarrantyPeriod(months, rule.minimumMonths);
    if (guaranteeId === null && retention === '0') throw new DomainError('GUARANTEE_REQUIRED', 422, 'warranty_guarantee_id');

    const id = randomUUID();
    const endsOn = warrantyEndsOn(startsOn, months);
    try {
      await tx.query(
        `insert into machvon.warranty_obligation
           (tenant_id, id, project_id, contract_id, handover_id, asset_id, scope_description, starts_on, ends_on, period_months, warranty_guarantee_id, retention_amount_vnd, rule_version_id,
            construction_grade, minimum_months, status, created_by, updated_by, version)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7::date, $8::date, $9, $10::uuid, $11::numeric, $12::uuid,
                 $13, $14, 'ACTIVE', $15::uuid, $15::uuid, 1)`,
        [id, handover.project_id, contractId, handoverId, assetId, description, startsOn, endsOn, months, guaranteeId, retention, rule.reading.versionId, grade, rule.minimumMonths, actor],
      );
    } catch (error) {
      if ((error as { code?: string }).code === UNIQUE_VIOLATION) throw new DomainError('WARRANTY_STATE_INVALID', 409, 'asset_id', { extensions: { reason: 'OBLIGATION_EXISTS' } });
      throw error;
    }
    return {
      id,
      contractId,
      contractCode: handover.contract_code,
      handoverId,
      projectId: handover.project_id,
      assetId,
      startsOn,
      endsOn,
      periodMonths: months,
      constructionGrade: grade,
      minimumMonths: rule.minimumMonths,
      ruleVersionId: rule.reading.versionId,
      warrantyGuaranteeId: guaranteeId,
      retentionAmountVnd: retention,
      fromStatus: null,
      status: 'ACTIVE',
      version: 1,
      openClaims: 0,
    };
  }

  /** Closes an obligation that has run out and has no claim open; the row is locked first, so that a claim filed at the same time is either seen here or refused by the database. */
  async close(tx: TenantTx, id: string, input: CloseInput, actor: string, scopes: HandoverScopes, now: Date): Promise<WarrantyResult> {
    const note = input.note === undefined ? null : textOf(input.note, 'note', MAX_TEXT);
    const held = await this.lock(tx, id, scopes);
    const claims = await tx.query<{ claim_no: string }>("select claim_no from machvon.warranty_claim where obligation_id = $1::uuid and status not in ('VERIFIED', 'CLOSED') order by claim_no", [
      held.id,
    ]);
    assertWarrantyClosure({ status: held.status, endsOn: held.ends_on, today: vietnamDateOf(now), openClaims: claims.map((claim) => claim.claim_no) });
    await tx.query(
      `update machvon.warranty_obligation
          set status = 'CLOSED', closed_by = $2::uuid, closed_at = $3::timestamptz, close_note = $4, updated_at = now(), updated_by = $2::uuid, version = version + 1
        where id = $1::uuid`,
      [held.id, actor, now.toISOString(), note],
    );
    return {
      id: held.id,
      contractId: held.contract_id,
      contractCode: held.contract_code,
      handoverId: held.handover_id,
      projectId: held.project_id,
      assetId: held.asset_id,
      startsOn: held.starts_on,
      endsOn: held.ends_on,
      periodMonths: held.period_months,
      constructionGrade: held.construction_grade,
      minimumMonths: held.minimum_months,
      ruleVersionId: held.rule_version_id,
      warrantyGuaranteeId: held.warranty_guarantee_id,
      retentionAmountVnd: held.retention_amount_vnd,
      fromStatus: held.status,
      status: 'CLOSED',
      version: Number(held.version) + 1,
      openClaims: 0,
    };
  }

  // ---- reads --------------------------------------------------------------------------------------------------------------

  /** The obligations in the scope of the caller, the newest first; the cursor is the creation time and the id. */
  async list(tx: TenantTx, scope: ScopeBuilder, filter: WarrantyFilter): Promise<WarrantyLine[]> {
    const contract = filter.contractId === undefined ? null : idOf(filter.contractId, 'contract_id');
    const handover = filter.handoverId === undefined ? null : idOf(filter.handoverId, 'handover_id');
    const status = filter.status === undefined ? null : (WARRANTY_STATUSES.find((candidate) => candidate === filter.status) ?? this.badField('status'));
    if (!Number.isInteger(filter.limit) || filter.limit < 1 || filter.limit > MAX_PAGE + 1) throw invalid('limit');
    assertTimestampCursor(filter.after?.code);
    const today = calendarDate(filter.today, 'today');
    const predicate = scope(7);
    const rows = await tx.query<LineSql>(
      `${SELECT} where ${predicate.sql} and ($1::uuid is null or c.id = $1::uuid) and ($2::uuid is null or h.id = $2::uuid) and ($3::text is null or ${STATUS_ON('$4::date')} = $3)
          and ($5::text is null or (${timestampKey('w.created_at')}, w.id) < ($5::text, $6::uuid))
        order by w.created_at desc, w.id desc limit ${filter.limit}`,
      [contract, handover, status, today, filter.after?.code ?? null, filter.after?.id ?? null, ...predicate.params],
    );
    return rows.map(toLine);
  }

  // ---- internals ----------------------------------------------------------------------------------------------------------

  private badField(field: string): never {
    throw invalid(field);
  }

  /** The handover a command works on, inside the scope of the command; one the caller can read and not change is a refusal, one it cannot see does not exist. */
  private async handover(tx: TenantTx, id: string, scopes: HandoverScopes): Promise<{ contract_id: string; contract_code: string; project_id: string; status: string }> {
    const predicate = scopes.update(2);
    const rows = await tx.query<{ contract_id: string; contract_code: string; project_id: string; status: string }>(
      `select c.id as contract_id, c.code as contract_code, c.project_id, h.status from ${HANDOVER_FROM} where h.id = $1::uuid and ${predicate.sql}`,
      [id, ...predicate.params],
    );
    if (rows[0] !== undefined) return rows[0];
    const readable = scopes.read(2);
    const seen = await tx.query(`select h.id from ${HANDOVER_FROM} where h.id = $1::uuid and ${readable.sql}`, [id, ...readable.params]);
    throw seen[0] === undefined ? new DomainError('RESOURCE_NOT_FOUND', 404) : new DomainError('SCOPE_DENIED', 403);
  }

  /** The obligation locked for update inside the scope of the command. */
  private async lock(tx: TenantTx, id: string, scopes: HandoverScopes): Promise<Held> {
    const predicate = scopes.update(2);
    const columns = `w.id, c.id as contract_id, c.code as contract_code, h.id as handover_id, c.project_id, w.asset_id, w.starts_on::text as starts_on, w.ends_on::text as ends_on, w.period_months,
              w.construction_grade, w.minimum_months, w.rule_version_id, w.warranty_guarantee_id, w.retention_amount_vnd::text as retention_amount_vnd, w.status, w.version::text as version`;
    const rows = await tx.query<Held>(
      `select ${columns} from ${HANDOVER_FROM} join machvon.warranty_obligation w on w.tenant_id = h.tenant_id and w.handover_id = h.id where w.id = $1::uuid and ${predicate.sql} for update of w`,
      [id, ...predicate.params],
    );
    const row = rows[0];
    if (row !== undefined) return row;
    const readable = scopes.read(2);
    const seen = await tx.query(
      `select w.id from ${HANDOVER_FROM} join machvon.warranty_obligation w on w.tenant_id = h.tenant_id and w.handover_id = h.id where w.id = $1::uuid and ${readable.sql}`,
      [id, ...readable.params],
    );
    throw seen[0] === undefined ? new DomainError('RESOURCE_NOT_FOUND', 404) : new DomainError('SCOPE_DENIED', 403);
  }
}
