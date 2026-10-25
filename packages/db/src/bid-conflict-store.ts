import { randomUUID } from 'node:crypto';
import { CONFLICT_DECISIONS, DomainError, MAX_RELATION_TEXT, MIN_CONFLICT_REASON, assertFourEyes, declarationStanding, versionConflict } from '@machvon/kernel';
import type { ConflictDecision, ConflictStanding } from '@machvon/kernel';
import { PACKAGE_STATUSES_WITHOUT_MILESTONES } from './bid-milestone-store.ts';
import { SCOPE_FROM } from './prj-project-store.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

export interface NewDeclaration {
  packageId: string;
  hasConflict: boolean;
  relationText?: string | undefined;
  contractorId?: string | undefined;
}

export interface DeclaredConflict {
  id: string;
  packageId: string;
  packageCode: string;
  projectId: string;
  hasConflict: boolean;
  contractorId: string | null;
  version: number;
}

export interface DecidedConflict {
  id: string;
  packageId: string;
  packageCode: string;
  projectId: string;
  memberId: string;
  contractorId: string | null;
  decision: ConflictDecision;
  previousDecision: ConflictDecision | null;
  version: number;
  /** The evaluation reports the member was taken out of, the sign-off of a report that was fully signed having gone back to a draft. */
  reportsReopened: number;
}

export interface DeclarationLine {
  id: string;
  packageId: string;
  member: { membershipId: string; displayName: string };
  hasConflict: boolean;
  relationText: string | null;
  contractor: { id: string; legalName: string } | null;
  declaredAt: string;
  decision: ConflictDecision | null;
  decisionReason: string | null;
  decidedBy: { membershipId: string; displayName: string } | null;
  decidedAt: string | null;
  standing: Exclude<ConflictStanding, 'UNDECLARED'>;
  version: number;
}

interface PackageSql {
  id: string;
  code: string;
  status: string;
  project_id: string;
}

interface DeclarationSql {
  id: string;
  package_id: string;
  user_id: string;
  has_conflict: boolean;
  relation_text: string | null;
  contractor_id: string | null;
  contractor_name: string | null;
  declared_at: string;
  decision: ConflictDecision | null;
  decision_reason: string | null;
  decided_by: string | null;
  decided_at: string | null;
  member_name: string | null;
  decider_name: string | null;
  version: string;
}

const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;
const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

const SELECT = `select d.id, d.package_id, d.user_id, d.has_conflict, d.relation_text, d.contractor_id, c.legal_name as contractor_name,
  to_char(d.declared_at at time zone 'UTC', ${ISO}) as declared_at, d.decision, d.decision_reason, d.decided_by, to_char(d.decided_at at time zone 'UTC', ${ISO}) as decided_at,
  m.display_name as member_name, dm.display_name as decider_name, d.version::text as version
  from machvon.bid_conflict_declaration d
  left join machvon.contractor c on c.tenant_id = d.tenant_id and c.id = d.contractor_id
  left join machvon.tenant_user_directory m on m.tenant_id = d.tenant_id and m.membership_id = d.user_id
  left join machvon.tenant_user_directory dm on dm.tenant_id = d.tenant_id and dm.membership_id = d.decided_by`;

const toLine = (row: DeclarationSql): DeclarationLine => ({
  id: row.id,
  packageId: row.package_id,
  member: { membershipId: row.user_id, displayName: row.member_name ?? '' },
  hasConflict: row.has_conflict,
  relationText: row.relation_text,
  contractor: row.contractor_id === null ? null : { id: row.contractor_id, legalName: row.contractor_name ?? '' },
  declaredAt: row.declared_at,
  decision: row.decision,
  decisionReason: row.decision_reason,
  decidedBy: row.decided_by === null ? null : { membershipId: row.decided_by, displayName: row.decider_name ?? '' },
  decidedAt: row.decided_at,
  standing: declarationStanding({ hasConflict: row.has_conflict, decision: row.decision, contractorId: row.contractor_id }),
  version: Number(row.version),
});

/**
 * The declaration of conflict of interest (ST-BID-004, BID 3 F3, BR-BID-03): a member of the evaluation team declares, once per package, whether a relation stands between
 * them and a bidder before they see a bid; a conflict is decided by someone else, and a decision that shuts the member out also takes them out of the sign-off of the
 * evaluation reports of the package. The package is locked first by both commands.
 */
export class BidConflictStore {
  /**
   * Refusals in order: the shape (422), the package (404 outside the scope of `bid.evaluate`, 409 PACKAGE_STATE_INVALID), the contractor (422), a declaration already made by
   * this member (422 ALREADY_DECLARED).
   */
  async declare(tx: TenantTx, input: NewDeclaration, member: string, scope: ScopeBuilder): Promise<DeclaredConflict> {
    const relation = input.relationText === undefined ? '' : input.relationText.normalize('NFC').trim();
    if (relation.length > MAX_RELATION_TEXT) throw invalid('relation_text');
    if (input.hasConflict && relation === '') throw invalid('relation_text');
    if (!input.hasConflict && (relation !== '' || input.contractorId !== undefined)) throw invalid(relation !== '' ? 'relation_text' : 'contractor_id');
    const pack = await this.lockPackage(tx, input.packageId, scope);
    if (PACKAGE_STATUSES_WITHOUT_MILESTONES.includes(pack.status)) throw new DomainError('PACKAGE_STATE_INVALID', 409, 'package_id', { extensions: { package_status: pack.status } });
    if (input.contractorId !== undefined) {
      const contractor = await tx.query('select 1 from machvon.contractor where id = $1::uuid', [input.contractorId]);
      if (contractor.length === 0) throw invalid('contractor_id');
    }
    const earlier = await tx.query('select 1 from machvon.bid_conflict_declaration where package_id = $1::uuid and user_id = $2::uuid', [pack.id, member]);
    if (earlier.length > 0) throw new DomainError('ALREADY_DECLARED', 422, 'package_id');
    const id = randomUUID();
    await tx.query(
      `insert into machvon.bid_conflict_declaration (tenant_id, id, package_id, user_id, has_conflict, relation_text, contractor_id, created_by, updated_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, $4, $5, $6::uuid, $3::uuid, $3::uuid)`,
      [id, pack.id, member, input.hasConflict, input.hasConflict ? relation : null, input.contractorId ?? null],
    );
    return { id, packageId: pack.id, packageCode: pack.code, projectId: pack.project_id, hasConflict: input.hasConflict, contractorId: input.contractorId ?? null, version: 1 };
  }

  /**
   * ALLOWED, RECUSED or BLOCKED, by someone other than the member (403 SELF_APPROVAL_DENIED), under the version the decider saw (409 VERSION_CONFLICT), with the reasons in
   * words (422). A member who declared no conflict has nothing to be decided (422 NO_CONFLICT_DECLARED). A decision can be taken again; the audit rows keep each one.
   */
  async decide(tx: TenantTx, id: string, expectedVersion: number, decision: string, reason: string, actor: string, scope: ScopeBuilder): Promise<DecidedConflict> {
    const peek = (await tx.query<{ package_id: string }>('select package_id from machvon.bid_conflict_declaration where id = $1::uuid', [id]))[0];
    if (peek === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const pack = await this.lockPackage(tx, peek.package_id, scope);
    const rows = await tx.query<{ id: string; user_id: string; has_conflict: boolean; contractor_id: string | null; decision: ConflictDecision | null; version: string }>(
      'select id, user_id, has_conflict, contractor_id, decision, version::text as version from machvon.bid_conflict_declaration where id = $1::uuid for update',
      [id],
    );
    const row = rows[0];
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (Number(row.version) !== expectedVersion) throw versionConflict(Number(row.version));
    assertFourEyes(row.user_id, actor);
    if (!row.has_conflict) throw new DomainError('NO_CONFLICT_DECLARED', 422, 'decision');
    if (!(CONFLICT_DECISIONS as readonly string[]).includes(decision)) throw invalid('decision');
    const words = reason.normalize('NFC').trim();
    if (words.length < MIN_CONFLICT_REASON || words.length > MAX_RELATION_TEXT) throw invalid('decision_reason');
    const version = Number(row.version) + 1;
    await tx.query(
      `update machvon.bid_conflict_declaration
          set decision = $2, decided_by = $3::uuid, decided_at = now(), decision_reason = $4, updated_at = now(), updated_by = $3::uuid, version = $5::bigint
        where id = $1::uuid`,
      [id, decision, actor, words, version],
    );
    const reportsReopened = decision === 'ALLOWED' ? 0 : await this.removeFromSignOff(tx, pack.id, row.user_id);
    return {
      id,
      packageId: pack.id,
      packageCode: pack.code,
      projectId: pack.project_id,
      memberId: row.user_id,
      contractorId: row.contractor_id,
      decision: decision as ConflictDecision,
      previousDecision: row.decision,
      version,
      reportsReopened,
    };
  }

  /** The declarations of a package in the scope of the caller: every one for whoever decides, the caller's own for a member. */
  async list(tx: TenantTx, packageId: string, viewer: { membershipId: string; mayDecide: boolean }, scope: ScopeBuilder): Promise<DeclarationLine[]> {
    const predicate = scope(3);
    const rows = await tx.query<DeclarationSql>(
      `${SELECT}
        where d.package_id = $1::uuid and ($2::boolean or d.user_id = $${3 + predicate.params.length}::uuid)
          and exists (select 1 from ${SCOPE_FROM} join machvon.procurement_package k on k.tenant_id = p.tenant_id and k.project_id = p.id where k.id = d.package_id and ${predicate.sql})
        order by d.declared_at, d.id`,
      [packageId, viewer.mayDecide, ...predicate.params, viewer.membershipId],
    );
    return rows.map(toLine);
  }

  /** Whether the package is one of the projects of the scope: the question behind "may this caller decide the declarations of the package". */
  async reaches(tx: TenantTx, packageId: string, scope: ScopeBuilder): Promise<boolean> {
    const predicate = scope(2);
    const rows = await tx.query(
      `select 1 from ${SCOPE_FROM} join machvon.procurement_package k on k.tenant_id = p.tenant_id and k.project_id = p.id where k.id = $1::uuid and ${predicate.sql} limit 1`,
      [packageId, ...predicate.params],
    );
    return rows.length > 0;
  }

  /**
   * The declaration that stands between a member and a contractor (BR-CTR-13): a conflict they declared with the contractor, on whichever package, or one against a whole package
   * (none named, or blocked from it), that nobody allowed. Undefined when nothing stands between them. A contract of a package of the contractor asks this of the people who review and sign it.
   */
  async blockingDeclaration(tx: TenantTx, member: string, contractorId: string, packageId: string): Promise<{ id: string; packageId: string; contractorId: string | null } | undefined> {
    const rows = await tx.query<{ id: string; package_id: string; contractor_id: string | null }>(
      `select id, package_id, contractor_id from machvon.bid_conflict_declaration
        where user_id = $1::uuid and has_conflict and decision is distinct from 'ALLOWED'
          and (contractor_id = $2::uuid or (package_id = $3::uuid and (contractor_id is null or decision = 'BLOCKED')))
        order by declared_at, id limit 1`,
      [member, contractorId, packageId],
    );
    const row = rows[0];
    return row === undefined ? undefined : { id: row.id, packageId: row.package_id, contractorId: row.contractor_id };
  }

  /** The declaration of one member of a package, as the reads of the proposals need it. */
  async declarationOf(tx: TenantTx, packageId: string, member: string): Promise<{ hasConflict: boolean; decision: ConflictDecision | null; contractorId: string | null } | undefined> {
    const rows = await tx.query<{ has_conflict: boolean; decision: ConflictDecision | null; contractor_id: string | null }>(
      'select has_conflict, decision, contractor_id from machvon.bid_conflict_declaration where package_id = $1::uuid and user_id = $2::uuid',
      [packageId, member],
    );
    const row = rows[0];
    return row === undefined ? undefined : { hasConflict: row.has_conflict, decision: row.decision, contractorId: row.contractor_id };
  }

  /**
   * Takes the member out of the sign-off of the reports of the package that are not issued: a report that was fully signed goes back to a draft, because it has lost a
   * signature. A signature is a membership id or an object that names the membership.
   */
  private async removeFromSignOff(tx: TenantTx, packageId: string, member: string): Promise<number> {
    const rows = await tx.query<{ id: string }>(
      `update machvon.evaluation_report r
          set signed_off_by = coalesce((select jsonb_agg(e) from jsonb_array_elements(r.signed_off_by) e
                                         where (case jsonb_typeof(e) when 'string' then e #>> '{}' else e ->> 'membership_id' end) is distinct from $2), '[]'::jsonb),
              status = case when r.status = 'SIGNED_OFF' then 'DRAFT' else r.status end,
              updated_at = now(), version = r.version + 1
        where r.package_id = $1::uuid and r.status in ('DRAFT', 'SIGNED_OFF')
          and exists (select 1 from jsonb_array_elements(r.signed_off_by) e
                       where (case jsonb_typeof(e) when 'string' then e #>> '{}' else e ->> 'membership_id' end) = $2)
        returning r.id`,
      [packageId, member],
    );
    return rows.length;
  }

  private async lockPackage(tx: TenantTx, packageId: string, scope: ScopeBuilder): Promise<PackageSql> {
    const predicate = scope(2);
    const rows = await tx.query<PackageSql>(
      `select k.id, k.code, k.status, k.project_id from ${SCOPE_FROM} join machvon.procurement_package k on k.tenant_id = p.tenant_id and k.project_id = p.id
        where k.id = $1::uuid and ${predicate.sql} for update of p, k`,
      [packageId, ...predicate.params],
    );
    if (rows[0] === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return rows[0];
  }
}
