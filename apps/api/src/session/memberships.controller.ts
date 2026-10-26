import { Controller, Get, Inject, Param, ParseUUIDPipe, Query, createParamDecorator } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { MemberStore, RoleStore, TenantDatabase, scopePredicate } from '@machvon/db';
import type { DirectoryDetail, TenantTx } from '@machvon/db';
import { DomainError, effectivePermissions, holdsPermission, maxRank } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { OperationId } from '../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../pagination';
import { ACCESS_REQUEST_KEY } from '../policy.guard';
import { CurrentTenant } from '../tenant-context.decorator';

/** A row as the query returns it: the unit path is only there to decide, per row, whether personal data may show. */
interface MembershipRecord extends Omit<MembershipRow, 'version'> {
  unit_path: string;
  /** Read in the same statement as the status, so the two belong to one state of the membership. */
  version: string;
}

interface MembershipRow {
  id: string;
  /** The version the lifecycle commands expect in If-Match. */
  version: number;
  user_account_id: string;
  display_name: string;
  email: string;
  phone: string | null;
  status: string;
  organization_id: string;
  membership_type: string;
  valid_from: string;
  valid_until: string | null;
}

/** A membership as the directory lists it: the row plus what ADM-02 and ADM-17 show beside it (roles in force, invitation, contractor and contracts). */
interface MembershipView extends MembershipRow {
  role_codes: string[];
  invitation_status: string | null;
  contractor_id: string | null;
  contractor_name: string | null;
  contracts: Array<{ id: string; code: string }>;
  /** Whether the lifecycle commands (suspend, reactivate, end) are open to the caller on this member: their unit is reached and the caller outranks the member (BR-IAM-05). Absent when the request carries no access. */
  can_manage?: boolean;
}

const MEMBERSHIP_TYPES: readonly string[] = ['STAFF', 'GUEST_CONTRACTOR', 'SERVICE_ACCOUNT'];
const members = new MemberStore();
const roles = new RoleStore();

// The catalogue has no iam.member.read_pii (IAM section 6 names it): personal data is shown to those who manage members.
const PII_PERMISSION = 'iam.member.manage';
const READ_PERMISSION = PERMISSIONS.get_resources_membership;
/** The permission the lifecycle commands (suspend, reactivate, end) need. */
const MANAGE_PERMISSION = PERMISSIONS.endMembership;

// The view masks email and phone unless the transaction says the caller may read them. Row-level security limits it to
// the tenant of the transaction; the scope predicate limits it to the units the caller's grants reach.
const COLUMNS = `d.membership_id as id, d.user_account_id, d.display_name, d.email, d.phone, d.status, d.organization_id,
  d.membership_type, d.valid_from::text as valid_from, d.valid_until::text as valid_until, ou.path as unit_path, m.version::text as version`;
// The version is read with the row of the directory in one statement: the status shown and the version that If-Match checks
// must come from the same state of the membership (a later read of the version could see another administrator's change).
const FROM = `machvon.tenant_user_directory d join machvon.organization_unit ou on ou.tenant_id = d.tenant_id and ou.id = d.organization_id
  join machvon.membership m on m.tenant_id = d.tenant_id and m.id = d.membership_id`;

const OptionalAccess = createParamDecorator((_data: unknown, context: ExecutionContext): EffectiveAccess | undefined =>
  context.switchToHttp().getRequest<{ [ACCESS_REQUEST_KEY]?: EffectiveAccess }>()[ACCESS_REQUEST_KEY],
);

function scopeClause(access: EffectiveAccess | undefined, firstParam: number): { sql: string; params: unknown[] } {
  if (access === undefined) return { sql: 'true', params: [] };
  return scopePredicate(access, READ_PERMISSION, new Date(), { unitPath: 'ou.path', unitId: 'ou.id' }, firstParam);
}

function mayReadPersonalData(access: EffectiveAccess | undefined): boolean {
  return access !== undefined && holdsPermission(effectivePermissions(access, new Date()), PII_PERMISSION);
}

/** Whether the permission to see personal data reaches the unit of this member (a grant on one unit gives nothing elsewhere). */
function mayReadPersonalDataOf(access: EffectiveAccess, record: MembershipRecord, now: Date): boolean {
  return holdsPermission(effectivePermissions(access, now, { ownerUnitPath: record.unit_path, ownerUnitId: record.organization_id }), PII_PERMISSION);
}

/**
 * The rows come back masked; for the members whose unit the caller may read personal data of, the clear values are
 * read in the same transaction and put in their place. The unit path never leaves the controller.
 */
async function withPersonalData(tx: TenantTx, access: EffectiveAccess | undefined, records: MembershipRecord[]): Promise<MembershipRow[]> {
  const now = new Date();
  const visible = access !== undefined && mayReadPersonalData(access) ? records.filter((record) => mayReadPersonalDataOf(access, record, now)).map((record) => record.id) : [];
  const clear = new Map<string, { email: string; phone: string | null }>();
  if (visible.length > 0) {
    await tx.query("select set_config('app.can_read_pii', 'true', true)", []);
    const rows = await tx.query<{ id: string; email: string; phone: string | null }>(`select d.membership_id as id, d.email, d.phone from machvon.tenant_user_directory d where d.membership_id = any($1::uuid[])`, [visible]);
    for (const row of rows) clear.set(row.id, { email: row.email, phone: row.phone });
  }
  return records.map((record) => ({
    id: record.id,
    version: Number(record.version),
    user_account_id: record.user_account_id,
    display_name: record.display_name,
    email: clear.get(record.id)?.email ?? record.email,
    phone: clear.has(record.id) ? (clear.get(record.id)?.phone ?? null) : record.phone,
    status: record.status,
    organization_id: record.organization_id,
    membership_type: record.membership_type,
    valid_from: record.valid_from,
    valid_until: record.valid_until,
  }));
}

/**
 * Whether the caller may act on each member, by the rule the lifecycle commands judge (BR-IAM-05): the permission to manage members reaches the member's unit and
 * the caller's rank there is above the highest role the member holds. The screen hides the actions that would be refused; the commands still decide.
 */
async function manageable(tx: TenantTx, access: EffectiveAccess | undefined, records: readonly MembershipRecord[]): Promise<Map<string, boolean>> {
  if (access === undefined) return new Map();
  const now = new Date();
  const ranks = await roles.highestRanksOf(tx, records.map((record) => record.id));
  return new Map(
    records.map((record) => {
      const unit = { ownerUnitPath: record.unit_path, ownerUnitId: record.organization_id };
      const reached = holdsPermission(effectivePermissions(access, now, unit), MANAGE_PERMISSION);
      const scope = { kind: 'UNIT_ONLY' as const, refIds: [record.organization_id], paths: [record.unit_path] };
      return [record.id, reached && maxRank(access, now, scope) > (ranks.get(record.id) ?? 0)];
    }),
  );
}

/** The roles, invitation, contractor and contracts of the rows; the contracts are those of owner units the caller's grants reach. */
async function withDetails(tx: TenantTx, access: EffectiveAccess | undefined, rows: MembershipRow[], canManage: ReadonlyMap<string, boolean>): Promise<MembershipView[]> {
  const reach =
    access === undefined ? { sql: 'true', params: [] } : scopePredicate(access, READ_PERMISSION, new Date(), { unitPath: 'cu.path', unitId: 'cu.id' }, 2);
  const details = await members.directoryDetails(tx, rows.map((row) => row.id), reach);
  const none: DirectoryDetail = { version: 0, roleCodes: [], invitationStatus: null, contractorId: null, contractorName: null, contracts: [] };
  return rows.map((row) => {
    const detail = details.get(row.id) ?? none;
    return {
      ...row,
      role_codes: detail.roleCodes,
      invitation_status: detail.invitationStatus,
      contractor_id: detail.contractorId,
      contractor_name: detail.contractorName,
      contracts: detail.contracts,
      ...(canManage.has(row.id) ? { can_manage: canManage.get(row.id) === true } : {}),
    };
  });
}

function membershipTypeOf(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !MEMBERSHIP_TYPES.includes(value)) throw new DomainError('VALIDATION_FAILED', 422, 'membership_type');
  return value;
}

/**
 * Membership reads (get_resources_membership and _id): the tenant directory with email and phone masked for callers
 * who do not manage members, limited to the units the caller's grants reach; another tenant's members never show.
 */
@Controller('resources/membership')
export class MembershipsController {
  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get()
  @OperationId('get_resources_membership')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @OptionalAccess() access?: EffectiveAccess,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
    @Query('membership_type') membershipType?: unknown,
  ): Promise<{ items: MembershipView[]; next_cursor: string | null }> {
    const request = parsePageRequest(limit, cursor);
    const type = membershipTypeOf(membershipType);
    const scope = scopeClause(access, 5);
    const rows = await this.database.withTenant(tenant, async (tx) => {
      await tx.query("select set_config('app.can_read_pii', 'false', true)", []);
      const records = await tx.query<MembershipRecord>(
        `select ${COLUMNS} from ${FROM}
         where ($1::text is null or (d.display_name, d.membership_id) > ($1::text, $2::uuid)) and ($4::text is null or d.membership_type = $4::text) and ${scope.sql}
         order by d.display_name, d.membership_id limit $3`,
        [request.after?.code ?? null, request.after?.id ?? null, request.limit + 1, type, ...scope.params],
      );
      return withDetails(tx, access, await withPersonalData(tx, access, records), await manageable(tx, access, records));
    });
    const items = rows.slice(0, request.limit);
    const last = items[items.length - 1];
    const hasMore = rows.length > request.limit && last !== undefined;
    return { items, next_cursor: hasMore ? encodeCursor({ code: last.display_name, id: last.id }) : null };
  }

  @Get(':id')
  @OperationId('get_resources_membership_id')
  async get(@CurrentTenant() tenant: TenantContext, @Param('id', ParseUUIDPipe) id: string, @OptionalAccess() access?: EffectiveAccess): Promise<MembershipView> {
    const scope = scopeClause(access, 2);
    const rows = await this.database.withTenant(tenant, async (tx) => {
      await tx.query("select set_config('app.can_read_pii', 'false', true)", []);
      const records = await tx.query<MembershipRecord>(`select ${COLUMNS} from ${FROM} where d.membership_id = $1 and ${scope.sql}`, [id, ...scope.params]);
      return withDetails(tx, access, await withPersonalData(tx, access, records), await manageable(tx, access, records));
    });
    const row = rows[0];
    // A member of another tenant, or outside the caller's scope, is indistinguishable from a missing one.
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return row;
  }
}
