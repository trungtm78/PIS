import { compareDecimal } from './decimal.ts';

/**
 * The handover of cleared land to a construction contract (ST-LND-009, LND 3.4, BR-LND-06): what a section is called once an area has been handed over, which contracts may
 * receive it, and the share of the project that has been handed over.
 */
export type SectionHandoverStatus = 'NOT_READY' | 'PARTIAL' | 'HANDED_OVER';

/** The groups of contract (`contract.advance_category`) that build on the land: only these receive a site. The others (consulting, equipment, land clearance) do not. */
export const HANDOVER_CATEGORIES: readonly string[] = ['CONSTRUCTION', 'EPC'];

export const receivesSite = (advanceCategory: string): boolean => HANDOVER_CATEGORIES.includes(advanceCategory);

/** The status of a section from what has been handed over: nothing is NOT_READY, all of it is HANDED_OVER, anything between is PARTIAL (both areas as decimal text). */
export function sectionStatusFor(handedAreaM2: string, requiredAreaM2: string): SectionHandoverStatus {
  if (compareDecimal(handedAreaM2, '0') === 0) return 'NOT_READY';
  return compareDecimal(handedAreaM2, requiredAreaM2) === 0 ? 'HANDED_OVER' : 'PARTIAL';
}

/** The statuses of a parcel from which it can be handed over with its section: the compensation is paid, or it was handed over already. */
export const HANDOVER_READY_PARCEL_STATUSES: readonly string[] = ['PAID', 'HANDED_OVER'];

/**
 * The share of the required area that has been handed over, as a percentage with two decimals, rounded half up and computed on whole hundredths so that no floating-point
 * figure is involved (BR-LND-06: sum handed / sum required x 100; 0 when nothing is required).
 */
export function handedRatio(handedAreaM2: string, requiredAreaM2: string): string {
  const handed = hundredths(handedAreaM2);
  const required = hundredths(requiredAreaM2);
  if (required === 0n) return '0.00';
  const scaled = (handed * 10_000n * 2n + required) / (required * 2n);
  const whole = scaled / 100n;
  const fraction = (scaled % 100n).toString().padStart(2, '0');
  return `${whole}.${fraction}`;
}

function hundredths(value: string): bigint {
  const [whole = '0', fraction = ''] = value.split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0').slice(0, 2));
}
