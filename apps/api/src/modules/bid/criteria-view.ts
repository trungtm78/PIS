import type { CriteriaLine } from '@machvon/db';

/** The criteria of a version as the screens read them: the list inside the stored document, in the members of the contract. */
const criteriaOf = (document: unknown): unknown[] => {
  const list = (document as { criteria?: unknown } | null)?.criteria;
  return Array.isArray(list) ? list : [];
};

/**
 * A version of criteria as the lists show it: an explicit allowlist, so a column added to the table reaches no screen until it is named here.
 * The people behind the version (maker, approver) are not in it: who approved is in the audit trail, not on a screen of the criteria.
 */
export function criteriaView(line: CriteriaLine): Record<string, unknown> {
  return {
    id: line.id,
    package: {
      id: line.package.id,
      code: line.package.code,
      title: line.package.title,
      status: line.package.status,
      project: { id: line.package.project.id, code: line.package.project.code, name: line.package.project.name, status: line.package.project.status },
    },
    revision: line.revision,
    status: line.status,
    criteria: criteriaOf(line.criteria),
    weights_sum: line.weightsSum,
    legal_basis: line.legalBasis,
    approved_at: line.approvedAt,
    version: line.version,
  };
}
