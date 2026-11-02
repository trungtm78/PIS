import { createHash } from 'node:crypto';
import { BidAnalysisStore } from '../../src/bid-analysis-store';
import type { RunContext } from '../../src/bid-analysis-store';
import type { ProposalViewer } from '../../src/bid-proposal-reads';
import type { TenantTx } from '../../src/tenant-database';
import { TENANT_A, contextFor, memberId } from './authz-fixtures';
import type { AuthzHarness } from './authz-fixtures';
import { seedAiRequest } from './bid-analysis-fixtures';
import { seedOcrPage } from './bid-ocr-fixtures';
import { hoursFromNow, seedContractor, seedProposal } from './bid-proposal-fixtures';
import type { SeededPackage } from './bid-proposal-fixtures';

export type FindingSaid = ReadonlyArray<readonly [code: string, status: 'SUPPORTED' | 'CONTRADICTED' | 'MISSING' | 'NEEDS_REVIEW']>;

/** What the model said of three criteria: C1 (met or not) and C2 supported, C3 missing. */
export const DEFAULT_SAID: FindingSaid = [
  ['C1', 'SUPPORTED'],
  ['C2', 'SUPPORTED'],
  ['C3', 'MISSING'],
];

export interface AnalysedProposal {
  proposalId: string;
  contractorId: string;
  versionId: string;
  runId: string;
  /** The finding of each criterion, by its code. */
  findings: Map<string, string>;
}

export interface AnalysisWorld {
  seeded: SeededPackage;
  profileId: string;
  /** Who asks for the runs: a member of the evaluation team who declared that no conflict stands. */
  evaluator: ProposalViewer;
  member: number;
}

/**
 * A released proposal of a contractor and the run that analysed it on the criteria given, ended as the pipeline ends a run: one finding per criterion, a verified citation under each claim. `CANCELLED` cancels
 * the run afterwards, so that the experts have nothing to decide on it.
 */
export async function seedAnalysedProposal(
  harness: AuthzHarness,
  world: AnalysisWorld,
  name: string,
  criteriaVersionId: string,
  said: FindingSaid = DEFAULT_SAID,
  ended: 'AWAITING_REVIEW' | 'CANCELLED' = 'AWAITING_REVIEW',
): Promise<AnalysedProposal> {
  const store = new BidAnalysisStore();
  const as = <T>(work: (tx: TenantTx) => Promise<T>): Promise<T> => harness.tenants.withTenant(contextFor(TENANT_A, memberId(world.member)), work);
  const contractorId = await seedContractor(harness, { name });
  const proposal = await seedProposal(harness, world.seeded, contractorId, { releasedAt: hoursFromNow(-1), price: '4000' });
  await harness.owner(TENANT_A, [['update machvon.document_version set page_count = 2 where id = $1::uuid', [proposal.versionId]]]);
  await seedOcrPage(harness, proposal.versionId, { pageIndex: 0, status: 'AUTO_ACCEPTED', confidence: '0.9900' });
  await seedOcrPage(harness, proposal.versionId, { pageIndex: 1, tables: [{ rows: [{ label: 'Work', amount: '4000' }], total: '4000' }] });
  const admission = await as((tx) => store.admit(tx, { proposalId: proposal.id, criteriaVersionId, profileVersionId: world.profileId }, world.evaluator));
  if (admission.kind !== 'NEW') throw new Error('expected a new run');
  const context: RunContext = admission.context;
  const requestId = await seedAiRequest(harness);
  const runId = await as(async (tx) => {
    const id = await store.begin(tx, context, memberId(world.member));
    await store.saveFindings(
      tx,
      id,
      said.map(([criterionCode, status]) => ({
        criterionCode,
        status,
        text: `${name} on ${criterionCode}.`,
        missingSource: false,
        evidence: status === 'MISSING' ? [] : [{ kind: 'DOCUMENT' as const, documentVersionId: proposal.versionId, pageIndex: 0, quoteSha256: createHash('sha256').update(criterionCode).digest('hex'), quoteExcerpt: criterionCode, verifiedPresent: true }],
      })),
      'HEURISTIC',
    );
    await store.finish(tx, id, { status: 'AWAITING_REVIEW', failureCode: null, failedStep: null }, { aiRequestId: requestId, routeClass: 'DOMESTIC_HOSTED', budgetReservationId: null });
    return id;
  });
  if (ended === 'CANCELLED') await as((tx) => store.cancel(tx, runId, 2, 'Wrong criteria were chosen', world.evaluator));
  const found = await harness.owner<{ id: string; criterion_id: string }>(TENANT_A, [['select id, criterion_id from machvon.analysis_finding where run_id = $1::uuid', [runId]]]);
  return { proposalId: proposal.id, contractorId, versionId: proposal.versionId, runId, findings: new Map(found.map((row) => [row.criterion_id, row.id])) };
}
