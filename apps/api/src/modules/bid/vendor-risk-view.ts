import type { VendorFigure, VendorRatingLine, VendorRiskAssessmentRow, VendorPublicationInfo } from '@machvon/db';
import type { Caller, Names } from './vendor-view';

const nameOf = (names: Names, id: string | null): string | null => (id === null ? null : (names.get(id) ?? null));

/** A snapshot of the risk grade as the screen reads it: the points of every factor, who assessed and decided, and whether the caller may decide it now (the right, and a person other than the assessor when the grade needs a dual check). */
export const riskDto = (row: VendorRiskAssessmentRow, names: Names, caller: Caller): Record<string, unknown> => ({
  id: row.id,
  contractor_id: row.contractorId,
  contractor_name: row.contractorName,
  score: row.score,
  tier: row.tier,
  score_tier: row.scoreTier,
  floored: row.floored,
  factors: row.factors.map((one) => ({ factor: one.factor, points: one.points, max: one.max, reading: one.reading })),
  reasons: row.reasons,
  inputs: row.inputs as unknown as Record<string, unknown>,
  rule_version: row.ruleVersion,
  rule_unverified: row.ruleUnverified,
  review_months: row.reviewMonths,
  next_review_on: row.nextReviewOn,
  dual_check: row.dualCheck,
  as_of: row.asOf,
  state: row.state,
  assessed_by: row.assessedBy,
  assessed_by_name: nameOf(names, row.assessedBy),
  assessed_at: row.assessedAt,
  decided_by: row.decidedBy,
  decided_by_name: nameOf(names, row.decidedBy),
  decided_at: row.decidedAt,
  decision_reason: row.decisionReason,
  superseded_by_id: row.supersededById,
  version: row.version,
  can_decide: row.state === 'PROPOSED' && caller.holds('vnd.risk.decide') && (!row.dualCheck || row.assessedBy !== caller.membershipId),
});

export const figureDto = (figure: VendorFigure): Record<string, unknown> => ({ code: figure.code, numerator: figure.numerator, denominator: figure.denominator, as_of: figure.asOf });

/** A rating with the clocks of its publication and of the review of the answer; `can_post` is true for a person who holds the right and did not adopt the rating. */
export const performanceLineDto = (line: VendorRatingLine, caller: Caller): Record<string, unknown> => ({
  proposal_id: line.proposalId,
  contract_id: line.contractId,
  contract_code: line.contractCode,
  contractor_id: line.contractorId,
  contractor_name: line.contractorName,
  evaluation_kind: line.evaluationKind,
  period_label: line.periodLabel,
  state: line.state,
  rating: line.rating,
  score: line.score,
  construction: line.construction,
  adopted_on: line.adoptedOn,
  ended_on: line.endedOn,
  evaluation_id: line.evaluationId,
  response_kind: line.responseKind,
  response_received_on: line.responseReceivedOn,
  publication_due_on: line.publicationDueOn,
  publication_clock: line.publicationClock,
  publication: line.publication === null ? null : publicationDto(line.publication),
  updates: line.updates.map(publicationDto),
  response_review: line.responseReview,
  obligation: line.obligation,
  can_post: line.state === 'ADOPTED' && caller.holds('vnd.performance.publish') && line.adoptedBy !== caller.membershipId,
});

const publicationDto = (one: VendorPublicationInfo): Record<string, unknown> => ({ id: one.id, kind: one.kind, receipt: one.receipt, posted_on: one.postedOn, posted_by: one.postedBy, clock: one.clock });
