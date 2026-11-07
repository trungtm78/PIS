import { DomainError, assertDisbursementAllowed, disbursementVerdict } from '@machvon/kernel';
import type { B1PolicyReader, DisbursementVerdict } from '@machvon/kernel';
import { DEFAULT_B1_READER, b1PolicyOf } from './b1-policy-reader.ts';
import { SCOPE_FROM } from './prj-project-store.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

/**
 * The precondition of a disbursement (G1-2; NĐ 85/2025 Điều 53): a payment is built, revised and sent only for a project that is on the list of the investment projects (its stage is not one of the stages the policy
 * `DISBURSEMENT_PRECONDITION` closes) and that holds an approved amount in the capital plan on the system (the sum of the balances of its lines is above nothing). The number on the system wins over paper. A refusal is
 * 422 with the cause and the way to fix it (`DISBURSEMENT_PROJECT_NOT_LISTED`, `DISBURSEMENT_NO_APPROVED_PLAN`); an open request to appraise the project again is only a warning. The read (`check`) gives the same
 * verdict without refusing, for the screen that tells a person why a payment will not go before the person fills a request.
 */

export interface DisbursementCheckView extends DisbursementVerdict {
  projectId: string;
  projectCode: string;
  policyVersion: string;
  asOf: string;
}

export class PayDisbursementCheck {
  private readonly policy: B1PolicyReader<TenantTx>;

  constructor(policy: B1PolicyReader<TenantTx> = DEFAULT_B1_READER) {
    this.policy = policy;
  }

  /** Throws the refusal, or gives the warnings of a payment that may go. Called first in `PayPaymentStore.build` and again when a request is sent. */
  async assertAllowed(tx: TenantTx, projectId: string, today: string): Promise<Array<'REAPPRAISAL_OPEN'>> {
    const facts = await this.factsOf(tx, projectId);
    const policy = await b1PolicyOf(this.policy, tx, 'DISBURSEMENT_PRECONDITION', today);
    return assertDisbursementAllowed(facts, policy.params);
  }

  /** The verdict for a project in the scope of the caller, naming the cause and the fix; a project out of sight is not found. */
  async check(tx: TenantTx, scope: ScopeBuilder, projectId: string, today: string): Promise<DisbursementCheckView> {
    const predicate = scope(2);
    const [seen] = await tx.query<{ id: string }>(`select p.id from ${SCOPE_FROM} where p.id = $1::uuid and ${predicate.sql}`, [projectId, ...predicate.params]);
    if (seen === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const facts = await this.factsOf(tx, projectId);
    const policy = await b1PolicyOf(this.policy, tx, 'DISBURSEMENT_PRECONDITION', today);
    return { ...disbursementVerdict(facts, policy.params), projectId, projectCode: facts.projectCode, policyVersion: policy.version, asOf: today };
  }

  private async factsOf(tx: TenantTx, projectId: string): Promise<{ projectId: string; projectCode: string; projectStatus: string; allocatedVnd: string; reappraisalOpen: boolean }> {
    const [row] = await tx.query<{ code: string; status: string; allocated: string; reappraisal: boolean }>(
      `select p.code, p.status,
              coalesce((select sum(b.allocated_vnd) from machvon.allocation_line al join machvon.allocation_balance b on b.tenant_id = al.tenant_id and b.allocation_line_id = al.id where al.tenant_id = p.tenant_id and al.project_id = p.id), 0)::text as allocated,
              exists (select 1 from machvon.project_reappraisal_request r where r.tenant_id = p.tenant_id and r.project_id = p.id and r.status = 'OPEN') as reappraisal
         from machvon.project p where p.id = $1::uuid`,
      [projectId],
    );
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return { projectId, projectCode: row.code, projectStatus: row.status, allocatedVnd: row.allocated, reappraisalOpen: row.reappraisal };
  }
}
