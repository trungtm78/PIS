import type { Client } from 'pg';
import type { ForeignAttemptSpec } from '../api';
import { CONTRACT_FIXTURES, MEMBERSHIP_FIXTURES, PROJECT_FIXTURES } from '../../suite';
import { RATING_FIXTURES } from './rating.fixtures';
import type { RatingProposalFixture } from './rating.fixtures';
import type { SeedContext } from './support';

const FOREIGN = 'TNT-B';
const FOREIGN_FIXTURE = RATING_FIXTURES[FOREIGN];

/**
 * The foreign-id cases of the proposals of a rating of the contractor (CA-3): a TNT-A user names a proposal, or a contract, of TNT-B. The reports of the registers are asked for the project of the other tenant: what
 * they give back has to be a page without a row of it. The bodies are valid, so that the request reaches the lookup.
 */
export const RATING_SPECS: readonly ForeignAttemptSpec[] = [
  { operation: 'getContractRatingProposal', method: 'GET', id: FOREIGN_FIXTURE.read.id },
  { operation: 'proposeContractRating', method: 'POST', id: CONTRACT_FIXTURES[FOREIGN].id, body: { period_label: 'ISOLATION-FOREIGN-2026' } },
  { operation: 'notifyContractRating', method: 'POST', id: FOREIGN_FIXTURE.notify.id, versioned: true, body: { note: 'Isolation foreign notification attempt' } },
  { operation: 'recordContractRatingResponse', method: 'POST', id: FOREIGN_FIXTURE.respond.id, versioned: true, body: { response_kind: 'ACCEPT', received_on: '2026-01-02' } },
  { operation: 'adoptContractRating', method: 'POST', id: FOREIGN_FIXTURE.adopt.id, versioned: true, body: { note: 'Isolation foreign adoption attempt' } },
  { operation: 'withdrawContractRating', method: 'POST', id: FOREIGN_FIXTURE.withdraw.id, versioned: true, body: { reason: 'Isolation foreign withdrawal attempt' } },
  // The registers are read in the scope of the caller: asked for the project of the other tenant they give a page without a row.
  ...['quality-defects', 'obstacles', 'claims-limitation', 'audit-findings', 'performance-rating', 'contract-health'].map((code): ForeignAttemptSpec => ({ operation: 'getContractReport', method: 'GET', id: code, query: `project=${PROJECT_FIXTURES[FOREIGN].id}`, expectedStatuses: [200, 404] })),
];

/** Every operation of the controllers of the ratings: the test role of the suite holds the permission of each. */
export const RATING_OPERATIONS: readonly string[] = [
  'proposeContractRating',
  'notifyContractRating',
  'recordContractRatingResponse',
  'adoptContractRating',
  'withdrawContractRating',
  'getContractRatingProposal',
  'listContractRatingProposals',
];

/** The tables the seed fills and that no read of these operations changes. */
export const RATING_SNAPSHOT_TABLES: readonly string[] = ['contract_rating_proposal'];

/**
 * A proposal in the state its fixture says: made by the other member (so the suite principal is a second person and may notify and adopt); a notified one was told by the suite principal, an answered one was answered by
 * the other member. The figures are empty (no criterion with data): a proposal keeps the reasons, and the checks of the table hold for it.
 */
const INSERT_PROPOSAL = `insert into machvon.contract_rating_proposal
  (tenant_id, id, contract_id, contractor_id, evaluation_kind, period_label, as_of_date, rule_version, rule_source, reasons, readings, covered, inputs_sha256, state, proposed_by, proposed_note,
   notified_by, notified_at, response_due_at, responded_by, responded_at, response_kind, response_received_on, created_by, updated_by)
  select $1::uuid, $2::uuid, c.id, c.contractor_id, 'PERIODIC', $3::text, current_date, 0, 'DEFAULT', '{}'::jsonb, '{}'::jsonb, 0, $4::text, $5::text, $6::uuid, $7::text,
         $8::uuid, case when $8::uuid is null then null else now() end, case when $8::uuid is null then null else now() + interval '20 days' end,
         $9::uuid, case when $9::uuid is null then null else now() end, case when $9::uuid is null then null else 'ACCEPT' end, case when $9::uuid is null then null else current_date end,
         $6::uuid, $6::uuid
    from machvon.contract c where c.id = $10::uuid and not exists (select 1 from machvon.contract_rating_proposal where id = $2::uuid)`;

export async function seedRating(client: Client, context: SeedContext): Promise<void> {
  const fixture = RATING_FIXTURES[context.tenant];
  const contract = CONTRACT_FIXTURES[context.tenant];
  const maker = MEMBERSHIP_FIXTURES[context.tenant].id;
  const put = async (one: RatingProposalFixture): Promise<void> => {
    const notifiedBy = one.state === 'PROPOSED' ? null : context.membershipId;
    const respondedBy = one.state === 'RESPONDED' ? maker : null;
    await client.query(INSERT_PROPOSAL, [context.tenantId, one.id, one.periodLabel, one.digest, one.state, maker, one.note, notifiedBy, respondedBy, contract.id]);
  };
  for (const one of [fixture.read, fixture.notify, fixture.respond, fixture.adopt, fixture.withdraw]) await put(one);
}
