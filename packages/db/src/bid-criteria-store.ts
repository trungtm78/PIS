import { randomUUID } from 'node:crypto';
import { DomainError, assertFourEyes, versionConflict } from '@machvon/kernel';
import { criteriaDocument, legalBasisOf, readCriteria } from './bid-criteria-input.ts';
import type { NewCriteriaInput } from './bid-criteria-input.ts';
import { SCOPE_FROM } from './prj-project-store.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

export const CRITERIA_STATUSES = ['DRAFT', 'APPROVED', 'SUPERSEDED'] as const;
export type CriteriaStatus = (typeof CRITERIA_STATUSES)[number];

/** Criteria are made for a package once its plan is approved (it is PLANNED then) or for a package awarded outside a plan; a package in a plan still in work, or one the plan dropped, has nothing to evaluate yet. */
export const PACKAGE_STATUSES_WITHOUT_CRITERIA: readonly string[] = ['DRAFT', 'IN_REVIEW', 'CANCELLED'];

export interface BidCreatedCriteria {
  id: string;
  packageId: string;
  revision: number;
  version: 1;
  status: 'DRAFT';
  weightsSum: number | null;
  criteriaCount: number;
  /** The approved version this one will replace when it is approved. */
  supersedesId: string | null;
  /** The draft that this revision took the place of. */
  replacedDraftId: string | null;
}

export interface BidApprovedCriteria {
  id: string;
  packageId: string;
  revision: number;
  version: number;
  status: 'APPROVED';
  weightsSum: number | null;
  criteriaCount: number;
  supersededId: string | null;
}

interface PackageLock {
  id: string;
  status: string;
}

interface CriteriaLockSql {
  id: string;
  package_id: string;
  revision: number;
  status: CriteriaStatus;
  version: string;
  criteria_json: unknown;
  weights_sum: number | null;
  created_by: string;
}

const stateInvalid = (extensions: Record<string, unknown>): DomainError => new DomainError('CRITERIA_STATE_INVALID', 409, 'status', { extensions });
const packageStateInvalid = (status: string): DomainError => new DomainError('PACKAGE_STATE_INVALID', 409, 'package_id', { extensions: { package_status: status } });

/**
 * The evaluation criteria of a package (ST-BID-003, BID 3 F4): a planner drafts a version (criteria with weights, thresholds and the evidence they
 * ask for, under a legal basis), an authority other than the maker approves it, and approval locks it. A version is never edited: another set of
 * criteria is the next revision, which replaces the draft in work and, once approved, the version in force. The package row is locked first by
 * every command, then the versions, so two commands on one package never wait for each other in a cycle.
 */
export class BidCriteriaStore {
  /**
   * Drafts the next revision of the criteria of a package. Refusals in order: the shape, the prohibited criteria and the weights of the criteria
   * (422), the package (404 outside the scope of the caller, 409 PACKAGE_STATE_INVALID). A draft in work is replaced by the new one.
   */
  async create(tx: TenantTx, input: NewCriteriaInput, actor: string, scope: ScopeBuilder): Promise<BidCreatedCriteria> {
    const legalBasis = legalBasisOf(input.legalBasis);
    const checked = readCriteria(input.criteriaJson);
    const pack = await this.lockPackage(tx, input.packageId, scope);
    if (PACKAGE_STATUSES_WITHOUT_CRITERIA.includes(pack.status)) throw packageStateInvalid(pack.status);

    const earlier = await tx.query<{ id: string; revision: number; status: CriteriaStatus }>(
      'select id, revision, status from machvon.criteria_version where package_id = $1::uuid order by revision desc for update',
      [pack.id],
    );
    const draft = earlier.find((row) => row.status === 'DRAFT');
    if (draft !== undefined) {
      await tx.query("update machvon.criteria_version set status = 'SUPERSEDED', version = version + 1 where id = $1::uuid", [draft.id]);
    }
    const approved = earlier.find((row) => row.status === 'APPROVED');
    const revision = (earlier[0]?.revision ?? 0) + 1;
    const id = randomUUID();
    await tx.query(
      `insert into machvon.criteria_version (tenant_id, id, package_id, revision, criteria_json, legal_basis, weights_sum, status, created_by, version)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3, $4::jsonb, $5, $6, 'DRAFT', $7::uuid, 1)`,
      [id, pack.id, revision, JSON.stringify(criteriaDocument(checked.criteria)), legalBasis, checked.weightsSum, actor],
    );
    return {
      id,
      packageId: pack.id,
      revision,
      version: 1,
      status: 'DRAFT',
      weightsSum: checked.weightsSum,
      criteriaCount: checked.criteria.length,
      supersedesId: approved?.id ?? null,
      replacedDraftId: draft?.id ?? null,
    };
  }

  /**
   * DRAFT to APPROVED, by someone other than the maker (403 SELF_APPROVAL_DENIED). Refusals in order: the version (404 outside the scope, 409
   * VERSION_CONFLICT), the maker, the state (409 CRITERIA_LOCKED_BY_RUN for a version an analysis run already used, CRITERIA_STATE_INVALID for
   * any other that is not a draft), the package, and the criteria once more (a prohibited criterion added to the list since the draft was made
   * is refused now). The version in force is superseded in the same transaction.
   */
  async approve(tx: TenantTx, criteriaId: string, expectedVersion: number, actor: string, scope: ScopeBuilder): Promise<BidApprovedCriteria> {
    const peek = (await tx.query<{ package_id: string }>('select package_id from machvon.criteria_version where id = $1::uuid', [criteriaId]))[0];
    if (peek === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const pack = await this.lockPackage(tx, peek.package_id, scope);
    const rows = await tx.query<CriteriaLockSql>(
      'select id, package_id, revision, status, version::text as version, criteria_json, weights_sum, created_by from machvon.criteria_version where id = $1::uuid for update',
      [criteriaId],
    );
    const row = rows[0];
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (Number(row.version) !== expectedVersion) throw versionConflict(Number(row.version));
    assertFourEyes(row.created_by, actor);
    if (row.status !== 'DRAFT') {
      const used = await tx.query<{ id: string }>('select id from machvon.analysis_run where criteria_version_id = $1::uuid limit 1', [row.id]);
      if (used.length > 0) throw new DomainError('CRITERIA_LOCKED_BY_RUN', 409, 'status', { extensions: { criteria_status: row.status } });
      throw stateInvalid({ criteria_status: row.status });
    }
    if (PACKAGE_STATUSES_WITHOUT_CRITERIA.includes(pack.status)) throw packageStateInvalid(pack.status);
    const checked = readCriteria(row.criteria_json);
    const previous = (
      await tx.query<{ id: string }>("select id from machvon.criteria_version where package_id = $1::uuid and status = 'APPROVED' and id <> $2::uuid for update", [pack.id, row.id])
    )[0];
    if (previous !== undefined) {
      await tx.query("update machvon.criteria_version set status = 'SUPERSEDED', version = version + 1 where id = $1::uuid", [previous.id]);
    }
    const version = Number(row.version) + 1;
    await tx.query("update machvon.criteria_version set status = 'APPROVED', approved_by = $2::uuid, effective_at = now(), version = version + 1 where id = $1::uuid", [row.id, actor]);
    return {
      id: row.id,
      packageId: pack.id,
      revision: row.revision,
      version,
      status: 'APPROVED',
      weightsSum: checked.weightsSum,
      criteriaCount: checked.criteria.length,
      supersededId: previous?.id ?? null,
    };
  }

  /** Locks the project of the package (in the scope of the caller), then the package; a package outside the scope does not exist for the caller. */
  private async lockPackage(tx: TenantTx, packageId: string, scope: ScopeBuilder): Promise<PackageLock> {
    const predicate = scope(2);
    const rows = await tx.query<PackageLock>(
      `select k.id, k.status from ${SCOPE_FROM} join machvon.procurement_package k on k.tenant_id = p.tenant_id and k.project_id = p.id
        where k.id = $1::uuid and ${predicate.sql} for update of p, k`,
      [packageId, ...predicate.params],
    );
    if (rows[0] === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return rows[0];
  }
}
