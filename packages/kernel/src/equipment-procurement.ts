import { compareDecimal, convertDecimal, subtractDecimal } from './decimal.ts';
import type { EgpConnectorHealth } from './egp.ts';

/**
 * The view of the equipment procurement of a project (CN.02, ENT-4e): for each line of the plan that is bought as equipment, where it stands from the plan to
 * the last payment. It is a read model over what BID, CTR and PAY already hold (eng-review R21: one read path), never a second copy of their figures.
 * This file is pure: it derives the stage, the shares and the variances from facts, masks what the caller may not see, and says how to get the data in.
 */
export const EQUIPMENT_STAGES = ['PLANNED', 'PACKAGED', 'SELECTED', 'NO_AWARD', 'CONTRACTED', 'DISBURSING', 'DISBURSED', 'CANCELLED'] as const;
export type EquipmentStage = (typeof EQUIPMENT_STAGES)[number];

export interface EquipmentFacts {
  /** The line of the register: ACTIVE while it is bought, CANCELLED when the plan dropped it. */
  itemStatus: 'ACTIVE' | 'CANCELLED';
  packageId: string | null;
  /** Latest result of the choice of contractor for the package: only an APPROVED result counts. */
  result: { outcome: 'AWARDED' | 'NO_ACCEPTABLE_BID' | 'CANCELLED'; status: string } | null;
  contractId: string | null;
  /** Value of the revision of the contract in force, whole dong. */
  contractValueVnd: string | null;
  /** Sum of the payments that were paid, whole dong. */
  paidVnd: string;
}

/**
 * The stage of a line. A cancelled line is CANCELLED whatever else it has; a package without an approved result is PACKAGED; an approved result with no
 * acceptable bid or cancelled is NO_AWARD (the package must be tendered again); an approved award without a contract is SELECTED; a contract with
 * nothing paid is CONTRACTED; some paid is DISBURSING; paid at least the contract value is DISBURSED.
 */
export function equipmentStage(facts: EquipmentFacts): EquipmentStage {
  if (facts.itemStatus === 'CANCELLED') return 'CANCELLED';
  if (facts.packageId === null) return 'PLANNED';
  const approved = facts.result !== null && facts.result.status === 'APPROVED';
  if (facts.contractId === null || facts.contractValueVnd === null) {
    if (!approved) return 'PACKAGED';
    return facts.result?.outcome === 'AWARDED' ? 'SELECTED' : 'NO_AWARD';
  }
  if (compareDecimal(facts.paidVnd, '0') === 0) return 'CONTRACTED';
  return compareDecimal(facts.paidVnd, facts.contractValueVnd) >= 0 ? 'DISBURSED' : 'DISBURSING';
}

/** Share of the contract value that was paid, in percent with one decimal (formula: paid x 100 / contract value, half up); null without a contract value. */
export function disbursementPercent(contractValueVnd: string | null, paidVnd: string): string | null {
  if (contractValueVnd === null || compareDecimal(contractValueVnd, '0') <= 0) return null;
  return convertDecimal(paidVnd, '100', contractValueVnd, 1, 'HALF_UP');
}

/** Contract value minus planned value, whole dong: negative is a saving, positive an overrun; null until a contract exists. */
export function planVariance(plannedValueVnd: string, contractValueVnd: string | null): string | null {
  return contractValueVnd === null ? null : subtractDecimal(contractValueVnd, plannedValueVnd);
}

export interface EquipmentFigures {
  contractValueVnd: string | null;
  paidVnd: string | null;
  disbursementPercent: string | null;
  planVarianceVnd: string | null;
}

export type MaskedFigure = 'CONTRACT' | 'PAYMENT';

/**
 * What the caller may see. The line itself is read with the right to read procurement; the value of the contract needs the right to read contracts and the
 * payments need the right to read payments, each in the scope of the project. A figure the caller may not see is `null` and named in `masked`, so the screen
 * says "no access" and not "zero".
 */
export function maskEquipmentFigures(figures: EquipmentFigures, may: { contract: boolean; payment: boolean }): { figures: EquipmentFigures; masked: MaskedFigure[] } {
  const masked: MaskedFigure[] = [];
  if (!may.contract) masked.push('CONTRACT');
  if (!may.payment) masked.push('PAYMENT');
  return {
    masked,
    figures: {
      contractValueVnd: may.contract ? figures.contractValueVnd : null,
      planVarianceVnd: may.contract ? figures.planVarianceVnd : null,
      paidVnd: may.payment ? figures.paidVnd : null,
      disbursementPercent: may.contract && may.payment ? figures.disbursementPercent : null,
    },
  };
}

export type EquipmentDataState = 'NEVER_IMPORTED' | 'FRESH' | 'AGING' | 'STALE';

export interface EquipmentDataGuide {
  state: EquipmentDataState;
  /** Hours since the last applied file; null when none was applied. */
  ageHours: number | null;
  layoutVersion: string;
  /** PENDING_EXTERNAL while the layout is a working assumption: the data can be used for UAT and cannot be accepted (eng-review R18). */
  acceptance: string;
  /** The steps a person follows to get the data in, in order (the screen words them); once the data is fresh only the last step, linking packages to lines, remains. */
  steps: EquipmentGuideStep[];
}

export const EQUIPMENT_GUIDE_STEPS = ['DOWNLOAD', 'UPLOAD', 'DRY_RUN', 'APPLY', 'LINK'] as const;
export type EquipmentGuideStep = (typeof EQUIPMENT_GUIDE_STEPS)[number];

/**
 * "How to get data": the state of the e-GP file import that feeds the packages (the platform opens no connection to the network, a person downloads the
 * files and hands them over). A never-imported or stale import is shown as such, never as "no data", with the steps to follow.
 */
export function equipmentDataGuide(health: Pick<EgpConnectorHealth, 'status' | 'ageHours' | 'layoutVersion' | 'acceptance'>): EquipmentDataGuide {
  const state: EquipmentDataState = health.status;
  return {
    state,
    ageHours: health.ageHours,
    layoutVersion: health.layoutVersion,
    acceptance: health.acceptance,
    steps: state === 'FRESH' ? ['LINK'] : [...EQUIPMENT_GUIDE_STEPS],
  };
}
