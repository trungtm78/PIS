import { DomainError } from '@machvon/kernel';

const TAX_IDENTIFIER = /^(\d{10})(?:-?(\d{3}))?$/;
const MASK = '****';

/**
 * The tax id of a contractor in the one form it is stored and compared in: ten digits, or ten digits, a hyphen and three digits for a
 * branch. Spaces around and inside are dropped and a branch written without its hyphen gets it. Anything else is TAX_ID_INVALID.
 * The check digit is not tested: the rule is not confirmed and the example of the acceptance test does not satisfy the usual one.
 */
export function normaliseTaxIdentifier(raw: string): string {
  const match = TAX_IDENTIFIER.exec(raw.replace(/\s+/g, ''));
  if (match === null) throw new DomainError('TAX_ID_INVALID', 409, 'tax_identifier');
  return match[2] === undefined ? (match[1] as string) : `${match[1]}-${match[2]}`;
}

/** The tax id with the four middle digits of its ten covered; a caller without the full right to read contractors sees this form only. */
export function maskTaxIdentifier(taxIdentifier: string): string {
  return `${taxIdentifier.slice(0, 3)}${MASK}${taxIdentifier.slice(7)}`;
}
