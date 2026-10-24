import type { AppropriationLine } from './model';
import type { PlanSummary } from './plan-model';

/** What a decision document backs: capital assigned to the province (an appropriation) or a capital plan revision. */
export type DecisionBasis = { kind: 'APPROPRIATION'; line: AppropriationLine } | { kind: 'PLAN'; plan: PlanSummary };

/** One row of CAP-05: a decision document and the one thing it backs, with the value that thing holds. */
export interface DecisionRow {
  key: string;
  documentId: string;
  symbol: string | null;
  issuedOn: string | null;
  /** The authority that issued the decision, known for the capital it assigns; a plan revision does not carry it. */
  authority: string | null;
  valueVnd: string;
  basis: DecisionBasis;
}

/**
 * The decisions that give capital out (CAP-05): the decision behind every appropriation of the register and the decision a capital plan
 * revision was published on, newest first. A revision that was replaced stays in the list, marked, because its decision still grounds the
 * reports that were made under it.
 */
export function decisionRows(appropriations: readonly AppropriationLine[], plans: readonly PlanSummary[]): DecisionRow[] {
  const rows: DecisionRow[] = [
    ...appropriations.map(
      (line): DecisionRow => ({
        key: `appropriation:${line.id}`,
        documentId: line.decisionDocumentId,
        symbol: line.decisionSymbol,
        issuedOn: line.decisionIssuedOn,
        authority: line.issuingAuthority,
        valueVnd: line.amountVnd,
        basis: { kind: 'APPROPRIATION', line },
      }),
    ),
    ...plans.flatMap((plan): DecisionRow[] =>
      plan.decisionId === null
        ? []
        : [{ key: `plan:${plan.id}`, documentId: plan.decisionId, symbol: plan.decisionSymbol, issuedOn: plan.decisionIssuedOn, authority: null, valueVnd: plan.totals.allocatedVnd, basis: { kind: 'PLAN', plan } }],
    ),
  ];
  return rows.sort((a, b) => (a.issuedOn ?? '') < (b.issuedOn ?? '') ? 1 : (a.issuedOn ?? '') > (b.issuedOn ?? '') ? -1 : a.key < b.key ? -1 : 1);
}
